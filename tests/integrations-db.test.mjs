import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { emptySchema, testDatabase } from "./helpers/test-db.mjs";

test("migrate applies each migration once, even when two instances race", async (t) => {
  const open = await emptySchema(t);
  if (!open) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const first = open();
  const second = open();
  const results = await Promise.all([first.migrate(), second.migrate()]);
  assert.deepEqual(results.flat(), ["001_integrations.sql", "002_built_in_stations.sql", "003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql", "006_availability_bindings.sql"]);
  assert.deepEqual(await first.migrate(), []);
  const { rows } = await first.pool.query("SELECT version FROM portal_migrations");
  assert.deepEqual(rows.map((row) => row.version), ["001_integrations.sql", "002_built_in_stations.sql", "003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql", "006_availability_bindings.sql"]);
});

test("migration 002 leaves an existing database's custom Stations, integrations and events as they were", async (t) => {
  const open = await emptySchema(t);
  if (!open) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const db = open();
  // A database that has only run 001, with a custom Station, a member, two integrations and their events.
  await db.transaction(async (client) => {
    await client.query("CREATE TABLE portal_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await client.query(await readFile(new URL("../migrations/001_integrations.sql", import.meta.url), "utf8"));
    await client.query("INSERT INTO portal_migrations (version) VALUES ('001_integrations.sql')");
  });
  await db.pool.query("INSERT INTO stations (id, origin, owner_account, report_client_id, status, verified_at) VALUES ('st1', 'https://a.example', 'ab1', 's-st1', 'active', '2026-10-01T00:00:00Z')");
  await db.pool.query("INSERT INTO station_members (station_id, account_id, added_by, added_at) VALUES ('st1', 'ab2', 'ab1', '2026-10-02T00:00:00Z')");
  const integration = "INSERT INTO integrations (id, owner_account, station_id, kind, name, scopes, state, quota_per_second, expires_at) VALUES ($1, 'ab1', 'st1', 'custom_app', 'App', '{a}', $2, 200, '2027-01-01T00:00:00Z')";
  await db.pool.query(integration, ["i-1", "revoked"]);
  await db.pool.query(integration, ["i-2", "revoked"]);
  await db.pool.query("INSERT INTO integration_events (at, station_id, integration_id, account_id, actor, kind) VALUES ('2026-10-03T00:00:00Z', 'st1', 'i-1', 'ab1', 'ab1', 'integration_revoked')");
  const snapshot = async () => ({
    stations: (await db.pool.query("SELECT id, origin, owner_account, report_client_id, status, created_at, verified_at, removed_at FROM stations")).rows,
    integrations: (await db.pool.query("SELECT id, owner_account, station_id, kind, name, scopes, state, resume_state, r9_svc, quota_per_second, expires_at, approved_by, approved_at, last_error, created_at, updated_at FROM integrations ORDER BY id")).rows,
    members: (await db.pool.query("SELECT * FROM station_members")).rows,
    events: (await db.pool.query("SELECT * FROM integration_events ORDER BY id")).rows
  });
  const before = await snapshot();
  assert.deepEqual(await db.migrate(), ["002_built_in_stations.sql", "003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql", "006_availability_bindings.sql"]);
  assert.deepEqual(await snapshot(), before);
  const { rows: [row] } = await db.pool.query("SELECT owner_account, status, built_in, access, integrations_enabled, name FROM stations WHERE id = 'st1'");
  assert.deepEqual(row, { owner_account: "ab1", status: "active", built_in: false, access: "members", integrations_enabled: true, name: null });
});

// Migration 004's index of a Station's account-level events by Station and account. Phase A's accountChangeApplied and
// disabledAccounts read them by it; the availability tables (006) replaced those reads, and the index stays.
test("migration 004 indexes the account-level events by Station and account, on the table and on its partitions, beside 001's account index", async (t) => {
  const db = await testDatabase(t);
  if (!db) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const { rows } = await db.pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'integration_events' ORDER BY indexname");
  const named = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
  assert.match(named.integration_events_station_account_idx, /\(station_id, account_id, id\) WHERE \(integration_id IS NULL\)$/);
  assert.match(named.integration_events_account_idx, /\(account_id, at\)$/, "001's index is still there, with its own columns");
  const { rows: partitions } = await db.pool.query(
    "SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class parent ON parent.oid = i.inhparent WHERE parent.relname = 'integration_events_station_account_idx' AND parent.relnamespace = current_schema()::regnamespace");
  assert.equal(partitions[0].n, 1, "the default partition has it too; so will each partition made later");
  await db.ensureEventPartitions({ now: new Date("2031-01-01T00:00:00Z") });
  const { rows: after } = await db.pool.query(
    "SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class parent ON parent.oid = i.inhparent WHERE parent.relname = 'integration_events_station_account_idx' AND parent.relnamespace = current_schema()::regnamespace");
  assert.equal(after[0].n, 3, "a new month's partitions get it as they are made");
});

test("ensureEventPartitions creates this and next month once and adopts rows from the default partition", async (t) => {
  const db = await testDatabase(t);
  if (!db) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  assert.deepEqual(await db.ensureEventPartitions({ now: new Date("2026-10-24T00:00:00Z") }), ["integration_events_y2026m10", "integration_events_y2026m11"]);
  assert.deepEqual(await db.ensureEventPartitions({ now: new Date("2026-10-24T00:00:00Z") }), []);
  const insert = "INSERT INTO integration_events (at, station_id, account_id, actor, kind) VALUES ('2026-12-05T00:00:00Z', 's-1', 'ab1', 'system', 'test_event') RETURNING id";
  const { rows: [{ id }] } = await db.pool.query(insert);
  const where = async () => (await db.pool.query("SELECT tableoid::regclass::text AS part FROM integration_events WHERE id = $1", [id])).rows.map((row) => row.part.split(".").pop());
  assert.deepEqual(await where(), ["integration_events_default"]);
  assert.deepEqual(await db.ensureEventPartitions({ now: new Date("2026-12-01T00:00:00Z") }), ["integration_events_y2026m12", "integration_events_y2027m01"]);
  assert.deepEqual(await where(), ["integration_events_y2026m12"]);
});

test("ensureEventPartitions waits for event appends to finish before moving rows", async (t) => {
  const db = await testDatabase(t);
  if (!db) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const appender = await db.pool.connect();
  try {
    await appender.query("BEGIN");
    await appender.query("SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'))");
    let settled = false;
    const making = db.ensureEventPartitions({ now: new Date("2031-03-10T00:00:00Z"), months: 1 }).finally(() => { settled = true; });
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(settled, false, "the partition waits for the append in flight");
    await appender.query("COMMIT");
    assert.deepEqual(await making, ["integration_events_y2031m03"]);
  } finally {
    await appender.query("ROLLBACK").catch(() => {});
    appender.release();
  }
});

test("transaction rolls back when the work throws", async (t) => {
  const db = await testDatabase(t);
  if (!db) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  await assert.rejects(db.transaction(async (client) => {
    await client.query("INSERT INTO station_challenges (id, account_id, origin, value, expires_at) VALUES (gen_random_uuid(), 'ab1', 'https://a.example', 'v', now())");
    throw new Error("stop");
  }), /stop/);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM station_challenges")).rows[0].n, 0);
});

test("integration check constraints refuse unknown states and malformed keys", async (t) => {
  const db = await testDatabase(t);
  if (!db) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  await db.pool.query("INSERT INTO stations (id, origin, owner_account, report_client_id, status, verified_at) VALUES ('s1', 'https://a.example', 'ab1', 's-report', 'active', now())");
  const insert = (state, svc) => db.pool.query(
    "INSERT INTO integrations (id, owner_account, station_id, kind, name, scopes, state, r9_svc, quota_per_second, expires_at) VALUES ('i-1', 'ab1', 's1', 'custom_app', 'App', '{}', $1, $2, 200, now())", [state, svc]);
  await assert.rejects(insert("expired", null), { code: "23514" });
  await assert.rejects(insert("ready", "a".repeat(63)), { code: "23514" });
  await insert("ready", "a".repeat(64));
});

test("migration 003 adds who paused and when the owner was disabled, keeps every row, and starts Auth's feed cursor empty", async (t) => {
  const open = await emptySchema(t);
  if (!open) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const db = open();
  // A database that has run 001 and 002, with a Station, a paused integration and its event.
  await db.transaction(async (client) => {
    await client.query("CREATE TABLE portal_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of ["001_integrations.sql", "002_built_in_stations.sql"]) {
      await client.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
      await client.query("INSERT INTO portal_migrations (version) VALUES ($1)", [file]);
    }
  });
  await db.pool.query("INSERT INTO stations (id, origin, owner_account, report_client_id, status, verified_at) VALUES ('st1', 'https://a.example', 'ab1', 's-st1', 'active', '2026-10-01T00:00:00Z')");
  await db.pool.query("INSERT INTO integrations (id, owner_account, station_id, kind, name, scopes, state, resume_state, quota_per_second, expires_at) VALUES ('i-1', 'ab1', 'st1', 'custom_app', 'App', '{agent.view}', 'paused', 'ready', 200, '2027-01-01T00:00:00Z')");
  await db.pool.query("INSERT INTO integration_events (at, station_id, integration_id, account_id, actor, kind, state) VALUES ('2026-10-03T00:00:00Z', 'st1', 'i-1', 'ab1', 'ab1', 'integration_paused', 'paused')");
  const integrations = (await db.pool.query("SELECT * FROM integrations")).rows;
  const events = (await db.pool.query("SELECT * FROM integration_events")).rows;
  assert.deepEqual(await db.migrate(), ["003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql", "006_availability_bindings.sql"]);
  const after = (await db.pool.query("SELECT * FROM integrations")).rows;
  assert.deepEqual(after.map(({ paused_by, owner_disabled_at, revoked_at, interrupt_running, revocation_outcome, revocation_pending_hosts, ...rest }) => rest), integrations);
  assert.deepEqual(after.map((row) => [row.paused_by, row.owner_disabled_at]), [[null, null]], "a pause from before 003 names nobody");
  assert.deepEqual(after.map((row) => [row.revoked_at, row.interrupt_running]), [[null, false]], "004 leaves no revocation time and no interrupt choice on an existing integration");
  assert.deepEqual(after.map((row) => [row.revocation_outcome, row.revocation_pending_hosts]), [[null, null]], "005 leaves no final revocation outcome on an existing integration");
  assert.deepEqual((await db.pool.query("SELECT * FROM integration_events")).rows, events);
  assert.deepEqual((await db.pool.query("SELECT id, cursor FROM auth_change_feed")).rows, [{ id: true, cursor: null }]);
  await assert.rejects(db.pool.query("UPDATE integrations SET paused_by = 'someone'"), { code: "23514" });
  await assert.rejects(db.pool.query("UPDATE auth_change_feed SET cursor = 'not a cursor'"), { code: "23514" });
  await assert.rejects(db.pool.query("INSERT INTO auth_change_feed (id) VALUES (false)"), { code: "23514" });
  await assert.rejects(db.pool.query("INSERT INTO auth_change_feed (id) VALUES (true)"), { code: "23505" });
});

test("migration 005 adds the Station's report ids, a revocation's hosts and its final outcome, which are checked and unique", async (t) => {
  const db = await testDatabase(t);
  if (!db) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const report = (stationId, reportId) => db.pool.query("INSERT INTO station_reports (station_id, report_id, integration_id, body, answer) VALUES ($1, $2, 'i-1', '{}', '{}')", [stationId, reportId]);
  await report("st1", "r-1");
  await assert.rejects(report("st1", "r-1"), { code: "23505" }, "a report id is unique per Station");
  await report("st2", "r-1");
  for (const bad of ["", "a b", "a/b", "é", "x".repeat(129)]) await assert.rejects(report("st1", bad), { code: "23514" }, JSON.stringify(bad));
  await report("st1", "A.z_0:9-" + "x".repeat(120));
  const host = (integrationId, name) => db.pool.query("INSERT INTO revocation_hosts (integration_id, host, record_id, report_id) VALUES ($1, $2, 'rec', 'r-1')", [integrationId, name]);
  await host("i-1", "laptop");
  await assert.rejects(host("i-1", "laptop"), { code: "23505" }, "a host counts once per integration");
  await host("i-1", "desktop");
  await host("i-2", "laptop");
  await db.pool.query("INSERT INTO stations (id, origin, owner_account, report_client_id, status, verified_at) VALUES ('st1', 'https://a.example', 'ab1', 's-st1', 'active', '2026-10-01T00:00:00Z')");
  await db.pool.query("INSERT INTO integrations (id, owner_account, station_id, kind, name, scopes, state, quota_per_second, expires_at) VALUES ('i-1', 'ab1', 'st1', 'custom_app', 'App', '{a}', 'revoked', 200, '2027-01-01T00:00:00Z')");
  const outcome = (value) => db.pool.query("UPDATE integrations SET revocation_outcome = $1, revocation_pending_hosts = $2 WHERE id = 'i-1'", [value, JSON.stringify(["laptop"])]);
  await outcome("deadline_passed");
  await outcome("all_applied");
  await assert.rejects(outcome("done"), { code: "23514" });
  const { rows: [row] } = await db.pool.query("SELECT revocation_outcome, revocation_pending_hosts FROM integrations WHERE id = 'i-1'");
  assert.deepEqual(row, { revocation_outcome: "all_applied", revocation_pending_hosts: ["laptop"] });
});

// An event of the feed that names no account (accounts_baseline) needs integration_events.account_id nullable. The table
// is partitioned: dropping the constraint on the parent has to reach every partition, those that exist when 006 runs
// and those made after it.
const nullability = async (db) => (await db.pool.query(
  "SELECT c.relname, a.attnotnull FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'account_id' WHERE c.oid = 'integration_events'::regclass OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'integration_events'::regclass) ORDER BY c.relname")).rows;

test("migration 006 makes an event's account optional on the table and on every partition, old or new, and keeps every event", async (t) => {
  const open = await emptySchema(t);
  if (!open) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const db = open();
  // A database that has run 001 to 005, with a month's partition made before 006 and an event in each partition.
  await db.transaction(async (client) => {
    await client.query("CREATE TABLE portal_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of ["001_integrations.sql", "002_built_in_stations.sql", "003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql"]) {
      await client.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
      await client.query("INSERT INTO portal_migrations (version) VALUES ($1)", [file]);
    }
  });
  assert.deepEqual(await db.ensureEventPartitions({ now: new Date("2026-11-22T00:00:00Z") }), ["integration_events_y2026m11", "integration_events_y2026m12"]);
  const insert = (at, accountId) => db.pool.query("INSERT INTO integration_events (at, station_id, account_id, actor, kind) VALUES ($1, 'st1', $2, 'system', 'test_event')", [at, accountId]);
  await insert("2026-11-05T00:00:00Z", "ab1");
  await insert("2027-06-05T00:00:00Z", "ab1");
  await assert.rejects(insert("2026-11-06T00:00:00Z", null), { code: "23502" }, "before 006 an event must name an account");
  assert.deepEqual((await nullability(db)).map((row) => row.attnotnull), [true, true, true, true]);
  const events = (await db.pool.query("SELECT * FROM integration_events ORDER BY id")).rows;
  assert.equal(events.length, 2);

  assert.deepEqual(await db.migrate(), ["006_availability_bindings.sql"]);
  assert.deepEqual(await nullability(db), [
    { relname: "integration_events", attnotnull: false },
    { relname: "integration_events_default", attnotnull: false },
    { relname: "integration_events_y2026m11", attnotnull: false },
    { relname: "integration_events_y2026m12", attnotnull: false }
  ]);
  assert.deepEqual((await db.pool.query("SELECT * FROM integration_events ORDER BY id")).rows, events, "every event is as it was");
  // One into each kind of partition: a month that existed, the default one, and a month made after the migration.
  await insert("2026-11-07T00:00:00Z", null);
  await insert("2027-06-06T00:00:00Z", null);
  assert.deepEqual(await db.ensureEventPartitions({ now: new Date("2031-01-01T00:00:00Z") }), ["integration_events_y2031m01", "integration_events_y2031m02"]);
  await insert("2031-01-05T00:00:00Z", null);
  const where = await db.pool.query("SELECT tableoid::regclass::text AS part, account_id FROM integration_events WHERE account_id IS NULL ORDER BY at");
  assert.deepEqual(where.rows.map((row) => row.part.split(".").pop()), ["integration_events_y2026m11", "integration_events_default", "integration_events_y2031m01"]);
  assert.ok((await nullability(db)).every((row) => row.attnotnull === false), "a partition made after 006 is nullable too");
});

test("migration 006 adds the availability, applied-entry, baseline and binding tables, with the keys and checks the Portal relies on", async (t) => {
  const db = await testDatabase(t);
  if (!db) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const tables = (await db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY table_name",
    [["account_availability", "account_baseline", "auth_account_entries", "binding_attempts", "station_bindings"]])).rows.map((row) => row.table_name);
  assert.deepEqual(tables, ["account_availability", "account_baseline", "auth_account_entries", "binding_attempts", "station_bindings"]);
  const q = (text, values) => db.pool.query(text, values);

  // An entry of Auth's feed is applied once: its cursor and time are the key, and a cursor at another time (a restored
  // Auth) is another entry. A baseline entry names no account.
  const entry = (cursor, at, account, kind = "account_disabled") => q("INSERT INTO auth_account_entries (auth_cursor, auth_at, account_id, kind) VALUES ($1, $2, $3, $4)", [cursor, at, account, kind]);
  await entry("YzEy", "2026-11-10T10:00:00Z", "ab1");
  await assert.rejects(entry("YzEy", "2026-11-10T10:00:00Z", "ab2"), { code: "23505" });
  await entry("YzEy", "2026-11-10T11:00:00Z", "ab1");
  await entry("YzEz", "2026-11-10T10:00:00Z", null, "accounts_baseline");
  await assert.rejects(q("INSERT INTO auth_account_entries (auth_cursor, auth_at, kind) VALUES ('c', now(), NULL)"), { code: "23502" });

  // The wait for a replay of the account entries sits on the feed's one row, off by default.
  assert.deepEqual((await q("SELECT accounts_need_replay FROM auth_change_feed")).rows, [{ accounts_need_replay: false }]);
  await assert.rejects(q("UPDATE auth_change_feed SET accounts_need_replay = NULL"), { code: "23502" });

  const availability = (account, disabled = true) => q("INSERT INTO account_availability (account_id, disabled, auth_cursor, auth_at) VALUES ($1, $2, 'YzEy', now())", [account, disabled]);
  await availability("ab1");
  await assert.rejects(availability("ab1", false), { code: "23505" }, "one row per account");
  await assert.rejects(q("INSERT INTO account_availability (account_id, disabled, auth_cursor, auth_at) VALUES ('ab2', NULL, 'YzEy', now())"), { code: "23502" });

  // The mark is one row, incomplete until the Portal has caught up with the feed.
  await q("INSERT INTO account_baseline (auth_cursor, auth_at) VALUES ('YzEz', now())");
  assert.equal((await q("SELECT complete FROM account_baseline")).rows[0].complete, false, "complete is false by default");
  await assert.rejects(q("UPDATE account_baseline SET complete = NULL"), { code: "23502" });
  await assert.rejects(q("INSERT INTO account_baseline (auth_cursor, auth_at) VALUES ('YzE0', now())"), { code: "23505" });
  await assert.rejects(q("INSERT INTO account_baseline (id, auth_cursor, auth_at) VALUES (false, 'YzE0', now())"), { code: "23514" });

  const hash = "a".repeat(64);
  const binding = (values = {}) => {
    const row = { station: "st1", r9: "r9-1", hash, account: "ab1", id: "b-1", version: 1, state: "bound", report: "rep-1", ...values };
    return q("INSERT INTO station_bindings (station_id, r9_account_id, genesis_hash, account_id, binding_id, version, binding_state, report_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [row.station, row.r9, row.hash, row.account, row.id, row.version, row.state, row.report]);
  };
  await binding();
  await assert.rejects(binding({ version: 2 }), { code: "23505" }, "one binding per Station, R9 account and genesis");
  await binding({ hash: "b".repeat(64) });
  await binding({ r9: "r9-2" });
  await binding({ station: "st2" });
  await assert.rejects(binding({ r9: "r9-3", version: 0 }), { code: "23514" }, "versions are positive");
  await assert.rejects(binding({ r9: "r9-3", state: "revoked" }), { code: "23514" });
  for (const state of ["unbound", "released"]) await binding({ r9: "r9-" + state, state });

  const attempt = (values = {}) => {
    const row = { station: "st1", report: "rep-1", account: "ab1", r9: "r9-1", hash, reason: "bound_elsewhere", at: "2026-11-20T10:00:00Z", ...values };
    return q("INSERT INTO binding_attempts (station_id, report_id, account_id, r9_account_id, genesis_hash, reason, attempted_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [row.station, row.report, row.account, row.r9, row.hash, row.reason, row.at]);
  };
  await attempt();
  await assert.rejects(attempt({ account: "ab2" }), { code: "23505" }, "a report id is recorded once per Station");
  await attempt({ station: "st2" });
  await attempt({ report: "rep-2", reason: "owner_disabled" });
  await assert.rejects(attempt({ report: "rep-3", reason: "other" }), { code: "23514" });
  const { rows: [{ indexdef }] } = await q("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'binding_attempts_account_idx'");
  assert.match(indexdef, /\(account_id, attempted_at\)$/);

  // directoryFor reads an account's ended memberships too, which 001's partial index (current members only) can't serve.
  const named = Object.fromEntries((await q("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'station_members'")).rows.map((row) => [row.indexname, row.indexdef]));
  assert.match(named.station_members_account_all_idx, /\(account_id\)$/, "every membership of an account, ended ones included");
  assert.match(named.station_members_account_idx, /WHERE \(removed_at IS NULL\)$/, "001's index for current members is still there");
});

// A binding report names no integration (Portal #41), but is kept by its report id like the revocation reports are.
test("migration 006 lets a Station's report name no integration, and the report id is still unique per Station", async (t) => {
  const db = await testDatabase(t);
  if (!db) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const report = (stationId, reportId, integrationId) => db.pool.query("INSERT INTO station_reports (station_id, report_id, integration_id, body, answer) VALUES ($1, $2, $3, '{}', '{}')", [stationId, reportId, integrationId]);
  await report("st1", "r-1", null);
  await report("st1", "r-2", "i-1");
  await assert.rejects(report("st1", "r-1", null), { code: "23505" }, "a report id is unique per Station, with or without an integration");
  await report("st2", "r-1", null);
  const { rows } = await db.pool.query("SELECT report_id, integration_id FROM station_reports WHERE station_id = 'st1' ORDER BY report_id");
  assert.deepEqual(rows, [{ report_id: "r-1", integration_id: null }, { report_id: "r-2", integration_id: "i-1" }]);
  await assert.rejects(report("st1", "bad id", null), { code: "23514" }, "the report id is still checked");
});

test("migration 006 keeps the reports a database had, each with its integration", async (t) => {
  const open = await emptySchema(t);
  if (!open) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const db = open();
  await db.transaction(async (client) => {
    await client.query("CREATE TABLE portal_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of ["001_integrations.sql", "002_built_in_stations.sql", "003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql"]) {
      await client.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
      await client.query("INSERT INTO portal_migrations (version) VALUES ($1)", [file]);
    }
  });
  await db.pool.query("INSERT INTO station_reports (station_id, report_id, integration_id, body, answer) VALUES ('st1', 'r-1', 'i-1', '{\"a\":1}', '{\"b\":2}')");
  const before = (await db.pool.query("SELECT * FROM station_reports")).rows;
  assert.deepEqual(await db.migrate(), ["006_availability_bindings.sql"]);
  assert.deepEqual((await db.pool.query("SELECT * FROM station_reports")).rows, before);
  await db.pool.query("INSERT INTO station_reports (station_id, report_id, body, answer) VALUES ('st1', 'r-2', '{}', '{}')");
  assert.deepEqual((await db.pool.query("SELECT report_id, integration_id FROM station_reports ORDER BY report_id")).rows, [{ report_id: "r-1", integration_id: "i-1" }, { report_id: "r-2", integration_id: null }], "after 006 a report may name no integration");
});

// 006 alters integration_events (a table lock) and then indexes station_members. An appender holds the event lock first,
// then writes its own rows, so a migration that took table locks before the event lock could wait for a row the appender
// holds while the appender waits for the table the migration has locked: a cycle. The migration takes the event lock
// first, as ensureEventPartitions does, and so waits for the whole append.
test("migration 006 waits for the event lock before it locks any table, so it can't deadlock with an appender", async (t) => {
  const open = await emptySchema(t);
  if (!open) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const db = open();
  await db.transaction(async (client) => {
    await client.query("CREATE TABLE portal_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of ["001_integrations.sql", "002_built_in_stations.sql", "003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql"]) {
      await client.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
      await client.query("INSERT INTO portal_migrations (version) VALUES ($1)", [file]);
    }
  });
  const appender = await db.pool.connect();
  try {
    // An append in flight: the event lock, then a member row of its own (a lock the migration's index wants).
    await appender.query("BEGIN");
    await appender.query("SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'))");
    await appender.query("INSERT INTO stations (id, origin, owner_account, report_client_id, status, verified_at) VALUES ('st1', 'https://a.example', 'ab1', 's-st1', 'active', now())");
    await appender.query("INSERT INTO station_members (station_id, account_id, added_by) VALUES ('st1', 'ab2', 'ab1')");
    let settled = false;
    const migrating = db.migrate().finally(() => { settled = true; });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(settled, false, "the migration waits for the append in flight");
    // The append goes on to write its event. With the migration already holding integration_events this would deadlock.
    await appender.query("INSERT INTO integration_events (station_id, account_id, actor, kind) VALUES ('st1', 'ab2', 'ab1', 'member_added')");
    await appender.query("COMMIT");
    assert.deepEqual(await migrating, ["006_availability_bindings.sql"]);
    assert.deepEqual((await db.pool.query("SELECT account_id FROM station_members")).rows, [{ account_id: "ab2" }], "the appender's rows are there");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM integration_events")).rows[0].n, 1);
  } finally {
    await appender.query("ROLLBACK").catch(() => {});
    appender.release();
  }
});
