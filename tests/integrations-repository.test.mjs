import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const later = (ms) => new Date(NOW + ms);

async function setup(t) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return {}; }
  return { db, repo: createRepository(db) };
}

async function station(repo, id, owner = "ab1", extra = {}) {
  await repo.insertStation({ id, origin: "https://" + id + ".example", ownerAccount: owner, reportClientId: "s-" + id, verifiedAt: NOW, ...extra });
}

const sample = (id, extra = {}) => ({ id, ownerAccount: "ab1", stationId: "st1", kind: "custom_app", name: "App " + id, scopes: ["a", "b"], quotaPerSecond: 200, expiresAt: later(86400000), ...extra });

test("challenges are single-use, owned and expiring", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  const id = randomUUID();
  await repo.createChallenge({ id, accountId: "ab1", origin: "https://a.example", value: "v1", expiresAt: later(60000) });
  assert.equal(await repo.takeChallenge(id, "ab2", NOW), null);
  assert.deepEqual(await repo.takeChallenge(id, "ab1", NOW), { origin: "https://a.example", value: "v1" });
  assert.equal(await repo.takeChallenge(id, "ab1", NOW), null);
  const old = randomUUID();
  await repo.createChallenge({ id: old, accountId: "ab1", origin: "https://a.example", value: "v2", expiresAt: later(1000) });
  assert.equal(await repo.takeChallenge(old, "ab1", later(2000)), null);
});

test("challengesSince counts an account's challenges created since a time, used or not", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  const since = new Date(Date.now() - 3600000);
  assert.equal(await repo.challengesSince("ab1", since), 0);
  const used = randomUUID();
  await repo.createChallenge({ id: used, accountId: "ab1", origin: "https://a.example", value: "v1", expiresAt: new Date(Date.now() + 600000) });
  await repo.takeChallenge(used, "ab1", Date.now());
  await repo.createChallenge({ id: randomUUID(), accountId: "ab1", origin: "https://b.example", value: "v2", expiresAt: new Date(Date.now() + 600000) });
  await repo.createChallenge({ id: randomUUID(), accountId: "ab2", origin: "https://a.example", value: "v3", expiresAt: new Date(Date.now() + 600000) });
  await repo.createChallenge({ id: randomUUID(), accountId: "ab1", origin: "https://c.example", value: "v4", expiresAt: new Date(Date.now() + 600000), createdAt: new Date(Date.now() - 2 * 3600000) });
  assert.equal(await repo.challengesSince("ab1", since), 2);
  assert.equal(await repo.challengesSince("ab1", new Date(Date.now() - 3 * 3600000)), 3);
  assert.equal(await repo.challengesSince("ab2", since), 1);
});

test("stations: insert is idempotent, lookups, roles and removal", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  assert.equal(await repo.insertStation({ id: "st1", origin: "https://st1.example", ownerAccount: "ab1", reportClientId: "s-st1", verifiedAt: NOW }), true);
  assert.equal(await repo.insertStation({ id: "st1", origin: "https://st1.example", ownerAccount: "ab9", reportClientId: "s-st1", verifiedAt: NOW }), false);
  const found = await repo.station("st1");
  assert.equal(found.ownerAccount, "ab1");
  assert.equal(found.reportClientId, "s-st1");
  assert.equal(found.status, "active");
  assert.equal(found.verifiedAt, new Date(NOW).toISOString());
  assert.equal((await repo.stationByReportClient("s-st1")).id, "st1");
  assert.equal(await repo.station("nope"), null);
  await station(repo, "st2", "ab2");
  await station(repo, "st3", "ab3");
  await repo.addMember("st2", "ab1", "ab2", NOW);
  await repo.addMember("st3", "ab1", "ab3", NOW);
  await repo.removeMember("st3", "ab1", "ab3", later(1000));
  await station(repo, "st4", "ab4");
  await repo.addMember("st4", "ab1", "ab4", NOW);
  await repo.markStationRemoved("st4", later(2000));
  const mine = await repo.stationsFor("ab1");
  assert.deepEqual(mine.map((s) => [s.id, s.role]), [["st1", "owner"], ["st2", "member"]]);
  assert.equal(await repo.stationByReportClient("s-st4"), null);
  assert.equal((await repo.station("st4")).removedAt, later(2000).toISOString());
});

test("members: add is a no-op when current, re-adding after removal keeps history", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  assert.equal(await repo.addMember("st1", "ab2", "ab1", NOW), true);
  assert.equal(await repo.addMember("st1", "ab2", "ab1", later(1000)), false);
  assert.deepEqual((await repo.currentMembers("st1")).map((m) => m.accountId), ["ab2"]);
  assert.equal(await repo.removeMember("st1", "ab2", "ab1", later(2000)), true);
  assert.equal(await repo.removeMember("st1", "ab2", "ab1", later(2500)), false);
  assert.deepEqual(await repo.currentMembers("st1"), []);
  await repo.addMember("st1", "ab2", "ab1", later(3000));
  assert.equal((await repo.currentMembers("st1")).length, 1);
  const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM station_members WHERE station_id = 'st1'");
  assert.equal(rows[0].n, 2);
});

test("integrations: insert, read, list and update", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await repo.insertIntegration(sample("i-1"));
  await repo.insertIntegration(sample("i-1", { name: "changed" }));
  await repo.insertIntegration(sample("i-2", { ownerAccount: "ab2" }));
  const one = await repo.integration("i-1");
  assert.equal(one.state, "awaiting_approval");
  assert.equal(one.name, "App i-1");
  assert.deepEqual(one.scopes, ["a", "b"]);
  assert.equal(one.expiresAt, later(86400000).toISOString());
  assert.equal(one.r9Svc, null);
  assert.deepEqual((await repo.integrationsFor("ab1")).map((i) => i.id), ["i-1"]);
  assert.deepEqual((await repo.integrationsOnStation("st1")).map((i) => i.id), ["i-1", "i-2"]);
  const svc = "a".repeat(64);
  await db.transaction(async (client) => {
    assert.equal((await repo.integrationForUpdate("i-1", client)).id, "i-1");
    await repo.updateIntegration("i-1", { state: "provisioning", r9Svc: svc, approvedBy: "ab1", approvedAt: NOW, quotaPerSecond: 5, expiresAt: later(1000), resumeState: "ready", lastError: "x" }, client);
  });
  const updated = await repo.integration("i-1");
  assert.equal(updated.state, "provisioning");
  assert.equal(updated.r9Svc, svc);
  assert.equal(updated.approvedBy, "ab1");
  assert.equal(updated.approvedAt, new Date(NOW).toISOString());
  assert.equal(updated.quotaPerSecond, 5);
  assert.equal(updated.resumeState, "ready");
  assert.equal(updated.lastError, "x");
  assert.ok(Date.parse(updated.updatedAt) >= Date.parse(one.updatedAt));
  await assert.rejects(repo.updateIntegration("i-1", { ownerAccount: "x" }), TypeError);
  await assert.rejects(repo.integrationForUpdate("i-1"), TypeError);
});

test("events: append needs a transaction; reads honour station, cursor, limit and order", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await station(repo, "st2", "ab2");
  await assert.rejects(repo.appendEvent({ stationId: "st1", accountId: "ab1", actor: "ab1", kind: "created" }), TypeError);
  assert.equal(await repo.latestCursor("st1"), 0);
  const ids = [];
  for (const [stationId, kind, integrationId] of [["st1", "created", "i-1"], ["st2", "created", null], ["st1", "approved", "i-1"], ["st1", "ready", "i-1"]]) {
    ids.push((await db.transaction((client) => repo.appendEvent({ stationId, integrationId, accountId: "ab1", actor: "system", kind, state: kind, reason: "r", details: { n: 1 } }, client))).id);
  }
  assert.ok(ids.every((id, index) => typeof id === "number" && (index === 0 || id > ids[index - 1])));
  const feed = await repo.changesSince("st1", 0);
  assert.deepEqual(feed.map((e) => e.kind), ["created", "approved", "ready"]);
  assert.deepEqual(feed[0].details, { n: 1 });
  assert.equal(feed[0].integrationId, "i-1");
  assert.equal(feed[0].reason, "r");
  assert.deepEqual((await repo.changesSince("st1", feed[0].id)).map((e) => e.kind), ["approved", "ready"]);
  assert.equal((await repo.changesSince("st1", 0, 2)).length, 2);
  assert.deepEqual((await repo.eventsFor("i-1")).map((e) => e.kind), ["ready", "approved", "created"]);
  assert.equal((await repo.eventsFor("i-1", 1)).length, 1);
  assert.equal(await repo.latestCursor("st1"), ids[3]);
  await assert.rejects(repo.changesSince("st1", -1), TypeError);
  await assert.rejects(repo.changesSince("st1", "1"), TypeError);
});

test("feed ordering: ids follow commit order and a cursor never skips", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  let releaseA;
  const holdA = new Promise((resolve) => { releaseA = resolve; });
  let aAppended;
  const appended = new Promise((resolve) => { aAppended = resolve; });
  const a = db.transaction(async (client) => {
    const result = await repo.appendEvent({ stationId: "st1", accountId: "ab1", actor: "system", kind: "first_started" }, client);
    aAppended(result);
    await holdA;
    return result;
  });
  await appended;
  let bDone = false;
  const b = db.transaction((client) => repo.appendEvent({ stationId: "st1", accountId: "ab1", actor: "system", kind: "second_started" }, client)).then((r) => { bDone = true; return r; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(bDone, false, "B waits on the advisory lock while A is open");
  releaseA();
  const resultA = await a;
  const cursor = resultA.id;
  const resultB = await b;
  assert.ok(resultB.id > resultA.id);
  const all = await repo.changesSince("st1", 0);
  assert.deepEqual(all.map((e) => e.kind), ["first_started", "second_started"]);
  assert.deepEqual((await repo.changesSince("st1", cursor)).map((e) => e.id), [resultB.id]);
});
