import assert from "node:assert/strict";
import test from "node:test";
import { emptySchema, testDatabase } from "./helpers/test-db.mjs";

test("migrate applies each migration once, even when two instances race", async (t) => {
  const open = await emptySchema(t);
  if (!open) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const first = open();
  const second = open();
  const results = await Promise.all([first.migrate(), second.migrate()]);
  assert.deepEqual(results.flat(), ["001_integrations.sql"]);
  assert.deepEqual(await first.migrate(), []);
  const { rows } = await first.pool.query("SELECT version FROM portal_migrations");
  assert.deepEqual(rows.map((row) => row.version), ["001_integrations.sql"]);
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
