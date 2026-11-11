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
  assert.deepEqual(results.flat(), ["001_integrations.sql", "002_built_in_stations.sql", "003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql"]);
  assert.deepEqual(await first.migrate(), []);
  const { rows } = await first.pool.query("SELECT version FROM portal_migrations");
  assert.deepEqual(rows.map((row) => row.version), ["001_integrations.sql", "002_built_in_stations.sql", "003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql"]);
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
  assert.deepEqual(await db.migrate(), ["002_built_in_stations.sql", "003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql"]);
  assert.deepEqual(await snapshot(), before);
  const { rows: [row] } = await db.pool.query("SELECT owner_account, status, built_in, access, integrations_enabled, name FROM stations WHERE id = 'st1'");
  assert.deepEqual(row, { owner_account: "ab1", status: "active", built_in: false, access: "members", integrations_enabled: true, name: null });
});

// accountChangeApplied (inside the global event lock) and disabledAccounts read a built-in Station's account-level events
// by Station and account; without this index they scan every event of the Station.
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
  assert.deepEqual(await db.migrate(), ["003_auth_changes.sql", "004_delegated_host_work.sql", "005_station_reports.sql"]);
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
