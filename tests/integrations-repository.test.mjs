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

test("built-in Stations: no owner, listed for every account first with role built_in, and following Auth", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  await station(repo, "st1", "ab1");
  assert.equal(await repo.insertStation({ id: "stb", origin: "https://station.agora.test", reportClientId: "s-stb", verifiedAt: NOW, builtIn: true, integrationsEnabled: false, name: "Agora Station" }), true);
  const built = await repo.station("stb");
  assert.deepEqual([built.builtIn, built.ownerAccount, built.access, built.integrationsEnabled, built.name], [true, null, "any_account", false, "Agora Station"]);
  const custom = await repo.station("st1");
  assert.deepEqual([custom.builtIn, custom.access, custom.integrationsEnabled, custom.name], [false, "members", true, null]);
  assert.deepEqual((await repo.stationsFor("ab1")).map((s) => [s.id, s.role]), [["stb", "built_in"], ["st1", "owner"]]);
  assert.deepEqual((await repo.stationsFor("ab9")).map((s) => [s.id, s.role]), [["stb", "built_in"]]);
  assert.deepEqual((await repo.builtInStations()).map((s) => s.id), ["stb"]);
  assert.equal(await repo.updateBuiltInStation("stb", { name: "Agora Station", integrationsEnabled: false }), false, "nothing to change");
  assert.equal(await repo.updateBuiltInStation("stb", { name: "Agora Station", integrationsEnabled: true }), true);
  assert.equal((await repo.station("stb")).integrationsEnabled, true);
  assert.equal(await repo.updateBuiltInStation("st1", { name: "Renamed", integrationsEnabled: false }), false, "custom Stations are not touched");
  await assert.rejects(repo.insertStation({ id: "stx", origin: "https://x.example", reportClientId: "s-stx", verifiedAt: NOW }), { code: "23514" }, "a custom Station needs an owner");
  await assert.rejects(repo.insertStation({ id: "sty", origin: "https://y.example", ownerAccount: "ab1", reportClientId: "s-sty", verifiedAt: NOW, builtIn: true, name: "Y" }), { code: "23514" }, "a built-in Station has no owner");
  await assert.rejects(repo.insertStation({ id: "stz", origin: "https://z.example", reportClientId: "s-stz", verifiedAt: NOW, builtIn: true, name: "z".repeat(61) }), { code: "23514" }, "names are 1 to 60 characters, as at Auth");
  await repo.markStationRemoved("stb", later(1000));
  assert.deepEqual(await repo.stationsFor("ab9"), []);
  assert.deepEqual(await repo.builtInStations(), []);
});

test("countLiveIntegrations counts one account's integrations on one Station that are neither revoked nor expired", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  await station(repo, "st1", "ab1");
  await station(repo, "st2", "ab1");
  await repo.insertIntegration(sample("i-1"));
  await repo.insertIntegration(sample("i-2"));
  await repo.updateIntegration("i-2", { state: "paused" });
  await repo.insertIntegration(sample("i-3"));
  await repo.updateIntegration("i-3", { state: "revoking" });
  await repo.insertIntegration(sample("i-4"));
  await repo.updateIntegration("i-4", { state: "revoked" });
  await repo.insertIntegration(sample("i-5", { expiresAt: later(1000) }));
  await repo.insertIntegration(sample("i-6", { ownerAccount: "ab2" }));
  await repo.insertIntegration(sample("i-7", { stationId: "st2" }));
  assert.equal(await repo.countLiveIntegrations("st1", "ab1", NOW), 4, "awaiting, paused, revoking and the short one");
  assert.equal(await repo.countLiveIntegrations("st1", "ab1", later(2000)), 3, "i-5 has expired");
  assert.equal(await repo.countLiveIntegrations("st1", "ab2", NOW), 1);
  // D29 Phase B: with the option a revoking integration no longer counts, since Auth has revoked it already.
  assert.equal(await repo.countLiveIntegrations("st1", "ab1", NOW, undefined, { revokingHoldsPlace: false }), 3, "awaiting, paused and the short one");
  assert.equal(await repo.countLiveIntegrations("st1", "ab1", NOW, undefined, { revokingHoldsPlace: true }), 4, "the default");
});

test("integrations carry who paused them and when Auth said their owner was disabled", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await repo.insertIntegration(sample("i-1"));
  const fresh = await repo.integration("i-1");
  assert.deepEqual([fresh.pausedBy, fresh.ownerDisabledAt], [null, null]);
  await db.transaction((client) => repo.updateIntegration("i-1", { state: "paused", resumeState: "ready", pausedBy: "admin", ownerDisabledAt: NOW }, client));
  const paused = await repo.integration("i-1");
  assert.deepEqual([paused.state, paused.pausedBy, paused.ownerDisabledAt], ["paused", "admin", new Date(NOW).toISOString()]);
  await repo.updateIntegration("i-1", { pausedBy: null, ownerDisabledAt: null });
  const cleared = await repo.integration("i-1");
  assert.deepEqual([cleared.pausedBy, cleared.ownerDisabledAt], [null, null]);
  await assert.rejects(repo.updateIntegration("i-1", { pausedBy: "someone" }), { code: "23514" });
});

test("the owner-disabled time is set only on purpose: undefined is refused, null clears, a Date, a number or an ISO string sets", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await repo.insertIntegration(sample("i-1"));
  await assert.rejects(repo.updateIntegration("i-1", { ownerDisabledAt: undefined }), TypeError);
  await assert.rejects(repo.updateIntegration("i-1", { state: "paused", ownerDisabledAt: undefined }), TypeError);
  const untouched = await repo.integration("i-1");
  assert.deepEqual([untouched.state, untouched.ownerDisabledAt], ["awaiting_approval", null], "a refused update changes nothing");
  const at = "2026-10-31T10:00:00.000Z";
  await repo.updateIntegration("i-1", { ownerDisabledAt: new Date(at) });
  assert.equal((await repo.integration("i-1")).ownerDisabledAt, at, "a Date");
  await repo.updateIntegration("i-1", { ownerDisabledAt: null });
  assert.equal((await repo.integration("i-1")).ownerDisabledAt, null, "null clears");
  await repo.updateIntegration("i-1", { ownerDisabledAt: at });
  assert.equal((await repo.integration("i-1")).ownerDisabledAt, at, "an ISO string");
  await repo.updateIntegration("i-1", { ownerDisabledAt: NOW });
  assert.equal((await repo.integration("i-1")).ownerDisabledAt, new Date(NOW).toISOString(), "a number");
});

test("Auth's change feed cursor starts empty and is saved as given; an applied change is found by its cursor and time", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const cursor = async () => (await repo.authChangePlace()).cursor;
  assert.deepEqual(await repo.authChangePlace(), { cursor: null, epoch: 0 });
  await repo.saveAuthChangeCursor("YzEy");
  assert.equal(await cursor(), "YzEy");
  for (const bad of ["", "has space", "x".repeat(65), 12, undefined, {}]) await assert.rejects(repo.saveAuthChangeCursor(bad), TypeError, JSON.stringify(bad));
  assert.equal(await cursor(), "YzEy");
  await repo.saveAuthChangeCursor(null);
  assert.equal(await cursor(), null, "null resets the cursor to re-read Auth's feed from the start");
  await repo.saveAuthChangeCursor("YzEy");
  await db.pool.query("DELETE FROM auth_change_feed");
  assert.deepEqual(await repo.authChangePlace(), { cursor: null, epoch: 0 }, "a missing row reads as no cursor");
  await repo.saveAuthChangeCursor("YzEz");
  assert.equal(await cursor(), "YzEz", "saving heals a missing row");
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM auth_change_feed")).rows[0].n, 1);
  assert.equal((await repo.accountSync()).mode, "waiting", "and the row it makes knows nothing of the accounts the Portal followed");
  await repo.saveAuthChangeCursor("YzEy");
  await station(repo, "st1");
  const at = "2026-10-31T10:00:00.000Z";
  assert.equal(await repo.authChangeApplied("i-1", "YzEy", at), false);
  await db.transaction((client) => repo.appendEvent({ stationId: "st1", integrationId: "i-1", accountId: "ab1", actor: "system", kind: "integration_paused", details: { authCursor: "YzEy", authAt: at } }, client));
  assert.equal(await repo.authChangeApplied("i-1", "YzEy", at), true);
  assert.equal(await repo.authChangeApplied("i-1", "YzEy", "2026-10-31T11:00:00.000Z"), false, "the same cursor at another time is another change (Auth's database was restored)");
  assert.equal(await repo.authChangeApplied("i-2", "YzEy", at), false);
});

test("an integration's newest pause, resume or revocation counts at Auth's time, or when the Portal saw it", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await repo.insertIntegration(sample("i-1"));
  await repo.insertIntegration(sample("i-2"));
  assert.deepEqual(await repo.latestStatus("i-1"), { at: null, id: null });
  assert.equal(await repo.latestEventId(), 0);
  const append = async (kind, details, integrationId = "i-1") => (await db.transaction((client) => repo.appendEvent({ stationId: "st1", integrationId, accountId: "ab1", actor: "system", kind, details }, client))).id;
  await append("integration_paused", { authCursor: "YzE", authAt: "2020-01-01T10:00:00.000Z" });
  assert.equal((await repo.latestStatus("i-1")).at, "2020-01-01T10:00:00.000Z", "an entry of Auth's feed at Auth's time, not when it was recorded");
  const resumed = await append("integration_resumed", { seenAt: "2020-01-01T09:00:00.000Z" });
  assert.deepEqual(await repo.latestStatus("i-1"), { at: "2020-01-01T10:00:00.000Z", id: resumed }, "the newest time, and the newest event's ID");
  const reconciled = await append("integration_reconciled", { seenAt: "2020-01-01T12:00:00.000Z" });
  const other = await append("integration_paused", { seenAt: "2020-01-01T13:00:00.000Z" }, "i-2");
  assert.deepEqual(await repo.latestStatus("i-1"), { at: "2020-01-01T10:00:00.000Z", id: resumed }, "only this integration's status changes");
  assert.equal(await repo.latestEventId(), other);
  assert.ok(other > reconciled);
  await append("integration_revoked", { seenAt: "2020-01-01T11:00:00.000Z" });
  assert.equal((await repo.latestStatus("i-1")).at, "2020-01-01T11:00:00.000Z");
  await append("integration_paused", { authCursor: "YzI", authAt: "not a time" });
  assert.ok(Date.parse((await repo.latestStatus("i-1")).at) > Date.parse("2020-01-02T00:00:00.000Z"), "without a usable time, when it was recorded");
});

test("an account's owner-disabled integrations that are not revoked are listed with the time of the disable", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  for (const [id, ownerAccount] of [["i-1", "ab1"], ["i-2", "ab1"], ["i-3", "ab2"]]) await repo.insertIntegration(sample(id, { ownerAccount }));
  assert.deepEqual(await repo.ownerDisabledIntegrations("ab1"), []);
  await repo.updateIntegration("i-1", { state: "revoked", ownerDisabledAt: NOW });
  await repo.updateIntegration("i-2", { ownerDisabledAt: NOW });
  await repo.updateIntegration("i-3", { ownerDisabledAt: NOW });
  assert.deepEqual(await repo.ownerDisabledIntegrations("ab1"), [{ id: "i-2", ownerDisabledAt: new Date(NOW).toISOString() }], "not another account's, nor a revoked one");
});

test("integrations carry when they were revoked and whether that revocation asked to interrupt running tasks", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await repo.insertIntegration(sample("i-1"));
  const fresh = await repo.integration("i-1");
  assert.deepEqual([fresh.revokedAt, fresh.interruptRunning], [null, false], "unset: no revocation time, no interrupt choice");
  const at = "2026-11-10T10:00:00.000Z";
  await db.transaction((client) => repo.updateIntegration("i-1", { state: "revoking", revokedAt: at, interruptRunning: true }, client));
  const revoking = await repo.integration("i-1");
  assert.deepEqual([revoking.revokedAt, revoking.interruptRunning], [at, true], "an ISO string");
  assert.deepEqual((await repo.integrationsFor("ab1")).map((row) => [row.revokedAt, row.interruptRunning]), [[at, true]]);
  await repo.updateIntegration("i-1", { revokedAt: new Date(at) });
  assert.equal((await repo.integration("i-1")).revokedAt, at, "a Date");
  await repo.updateIntegration("i-1", { revokedAt: NOW });
  assert.equal((await repo.integration("i-1")).revokedAt, new Date(NOW).toISOString(), "a number");
  await repo.updateIntegration("i-1", { revokedAt: null, interruptRunning: false });
  const cleared = await repo.integration("i-1");
  assert.deepEqual([cleared.revokedAt, cleared.interruptRunning], [null, false], "null clears the time");
  await assert.rejects(repo.updateIntegration("i-1", { revokedAt: undefined }), TypeError);
  await assert.rejects(repo.updateIntegration("i-1", { state: "revoked", revokedAt: undefined }), TypeError);
  assert.equal((await repo.integration("i-1")).state, "revoking", "a refused update changes nothing");
});

test("the Station's feed reads each event with the account it was recorded for", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await db.transaction((client) => repo.appendEvent({ stationId: "st1", integrationId: "i-1", accountId: "ab7", actor: "system", kind: "created" }, client));
  assert.deepEqual((await repo.changesSince("st1", 0)).map((event) => event.accountId), ["ab7"]);
});

test("integrations carry a revocation's final outcome and the hosts that didn't confirm it", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await repo.insertIntegration(sample("i-1"));
  const fresh = await repo.integration("i-1");
  assert.deepEqual([fresh.revocationOutcome, fresh.revocationPendingHosts], [null, null], "unset: no final outcome, no list");
  await db.transaction((client) => repo.updateIntegration("i-1", { state: "revoked", revocationOutcome: "deadline_passed", revocationPendingHosts: ["laptop", "desk top"] }, client));
  const revoked = await repo.integration("i-1");
  assert.deepEqual([revoked.revocationOutcome, revoked.revocationPendingHosts], ["deadline_passed", ["laptop", "desk top"]], "the list is written as JSON and read as an array");
  assert.deepEqual((await repo.integrationsFor("ab1")).map((row) => [row.revocationOutcome, row.revocationPendingHosts]), [["deadline_passed", ["laptop", "desk top"]]]);
  assert.deepEqual((await repo.integrationsOnStation("st1")).map((row) => row.revocationOutcome), ["deadline_passed"]);
  await db.transaction(async (client) => assert.deepEqual((await repo.integrationForUpdate("i-1", client)).revocationPendingHosts, ["laptop", "desk top"]));
  await repo.updateIntegration("i-1", { revocationOutcome: "all_applied", revocationPendingHosts: [] });
  const done = await repo.integration("i-1");
  assert.deepEqual([done.revocationOutcome, done.revocationPendingHosts], ["all_applied", []], "an empty list is an array, not null");
  await repo.updateIntegration("i-1", { revocationOutcome: null, revocationPendingHosts: null });
  const cleared = await repo.integration("i-1");
  assert.deepEqual([cleared.revocationOutcome, cleared.revocationPendingHosts], [null, null], "null clears both (a JSON null is not stored)");
  const { rows } = await db.pool.query("SELECT revocation_pending_hosts IS NULL AS sql_null FROM integrations WHERE id = 'i-1'");
  assert.equal(rows[0].sql_null, true);
  await assert.rejects(repo.updateIntegration("i-1", { revocationOutcome: "done" }), { code: "23514" }, "only the two outcomes");
});

test("updateIntegration refuses an undefined final outcome or pending list: a silent null would clear a recorded one", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await repo.insertIntegration(sample("i-1"));
  await repo.updateIntegration("i-1", { state: "revoked", revocationOutcome: "deadline_passed", revocationPendingHosts: ["laptop"] });
  await assert.rejects(repo.updateIntegration("i-1", { revocationOutcome: undefined }), TypeError);
  await assert.rejects(repo.updateIntegration("i-1", { revocationPendingHosts: undefined }), TypeError);
  await assert.rejects(repo.updateIntegration("i-1", { state: "revoking", revocationOutcome: undefined }), TypeError);
  const kept = await repo.integration("i-1");
  assert.deepEqual([kept.state, kept.revocationOutcome, kept.revocationPendingHosts], ["revoked", "deadline_passed", ["laptop"]], "a refused update changes nothing");
  await repo.updateIntegration("i-1", { revocationOutcome: null, revocationPendingHosts: null });
  assert.deepEqual([(await repo.integration("i-1")).revocationOutcome, (await repo.integration("i-1")).revocationPendingHosts], [null, null], "null still clears them, on purpose");
});

test("a Station's report is kept by its id with the body and the answer, per Station", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await station(repo, "st2", "ab2");
  assert.equal(await repo.stationReport("st1", "r-1"), null);
  const body = { integrationId: "i-1", state: "revocation_applied", reportId: "r-1", host: "laptop", recordId: "0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b" };
  const answer = { id: "i-1", state: "revoking", name: "App" };
  await db.transaction((client) => repo.saveStationReport({ stationId: "st1", reportId: "r-1", integrationId: "i-1", body, answer }, client));
  assert.deepEqual(await repo.stationReport("st1", "r-1"), { integrationId: "i-1", body, answer }, "round-trips as objects");
  await db.transaction(async (client) => assert.deepEqual(await repo.stationReport("st1", "r-1", client), { integrationId: "i-1", body, answer }, "inside a transaction"));
  assert.equal(await repo.stationReport("st1", "r-2"), null);
  assert.equal(await repo.stationReport("st2", "r-1"), null, "another Station's report id is another report");
  const other = { ...body, host: "desktop" };
  await db.transaction((client) => repo.saveStationReport({ stationId: "st2", reportId: "r-1", integrationId: "i-2", body: other, answer: { id: "i-2" } }, client));
  assert.deepEqual(await repo.stationReport("st2", "r-1"), { integrationId: "i-2", body: other, answer: { id: "i-2" } }, "the same id on another Station is allowed");
  assert.deepEqual((await repo.stationReport("st1", "r-1")).body, body, "and leaves the first alone");
  await assert.rejects(db.transaction((client) => repo.saveStationReport({ stationId: "st1", reportId: "r-1", integrationId: "i-1", body: other, answer: {} }, client)), { code: "23505" }, "an id is saved once per Station");
  assert.deepEqual((await repo.stationReport("st1", "r-1")).body, body, "the first report stands");
  await assert.rejects(db.transaction((client) => repo.saveStationReport({ stationId: "st1", reportId: "bad id", integrationId: "i-1", body, answer }, client)), { code: "23514" });
});

test("a Station's report that names no integration (a binding report) is kept and read back with integrationId null", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const body = { state: "binding_attempt", reportId: "r-9", account: "ab1" };
  await db.transaction((client) => repo.saveStationReport({ stationId: "st1", reportId: "r-9", integrationId: null, body, answer: { recorded: true } }, client));
  assert.deepEqual(await repo.stationReport("st1", "r-9"), { integrationId: null, body, answer: { recorded: true } });
  await assert.rejects(db.transaction((client) => repo.saveStationReport({ stationId: "st1", reportId: "r-9", integrationId: null, body, answer: {} }, client)), { code: "23505" }, "still once per Station");
});

test("a revocation's hosts are recorded once each, per integration, and read back as a set of names", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const record = (integrationId, host, reportId = "r-" + host) => db.transaction((client) => repo.recordRevocationHost({ integrationId, host, recordId: "0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b", reportId }, client));
  assert.deepEqual(await repo.revocationHosts("i-1"), new Set(), "none yet: an empty Set");
  assert.equal(await record("i-1", "laptop"), true);
  assert.equal(await record("i-1", "laptop", "r-again"), false, "already recorded, even under another report id");
  assert.equal(await record("i-1", "desktop"), true);
  assert.equal(await record("i-2", "laptop"), true, "another integration's");
  const hosts = await repo.revocationHosts("i-1");
  assert.ok(hosts instanceof Set);
  assert.deepEqual([...hosts].sort(), ["desktop", "laptop"]);
  assert.deepEqual([...await repo.revocationHosts("i-2")], ["laptop"]);
  await db.transaction(async (client) => assert.deepEqual([...await repo.revocationHosts("i-1", client)].sort(), ["desktop", "laptop"], "inside a transaction"));
  const { rows } = await db.pool.query("SELECT record_id, report_id FROM revocation_hosts WHERE integration_id = 'i-1' AND host = 'laptop'");
  assert.deepEqual(rows, [{ record_id: "0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b", report_id: "r-laptop" }], "the first report's ids stand");
  assert.equal(await record("i-1", "Laptop"), true, "host names are compared as sent");
});

test("an event may name no account: an account-level entry such as accounts_baseline is read back with accountId null", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  const append = (accountId) => db.transaction((client) => repo.appendEvent({ stationId: "st1", accountId, actor: "system", kind: accountId === null ? "accounts_baseline" : "account_disabled", details: { authCursor: "YzEy" } }, client));
  await append("ab1");
  await append(null);
  const feed = await repo.changesSince("st1", 0);
  assert.deepEqual(feed.map((event) => [event.kind, event.accountId]), [["account_disabled", "ab1"], ["accounts_baseline", null]]);
  assert.deepEqual(feed[1].details, { authCursor: "YzEy" });
  // Leaving the account out is a mistake, not "no account": the column used to refuse it, and null is now said on purpose.
  await assert.rejects(db.transaction((client) => repo.appendEvent({ stationId: "st1", actor: "system", kind: "account_disabled" }, client)), TypeError);
  assert.equal((await repo.changesSince("st1", 0)).length, 2, "nothing was written");
});

test("an entry of Auth's account feed is applied once, by its cursor and time", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const at = "2026-11-10T10:00:00.000Z";
  const entry = { cursor: "YzEy", at, account: "ab1", kind: "account_disabled" };
  assert.equal(await repo.applyAccountEntry(entry), true);
  assert.equal(await repo.applyAccountEntry(entry), false, "read again: skipped");
  assert.equal(await repo.applyAccountEntry({ ...entry, account: "ab2", kind: "account_enabled" }), false, "the key is the cursor and time, whatever else is claimed");
  assert.equal(await repo.applyAccountEntry({ ...entry, at: "2026-11-10T11:00:00.000Z" }), true, "the same cursor at another time (Auth restored from a backup) is another entry");
  assert.equal(await repo.applyAccountEntry({ ...entry, cursor: "YzEz", account: null, kind: "accounts_baseline" }), true, "a baseline names no account");
  const { rows } = await db.pool.query("SELECT auth_cursor, auth_at, account_id, kind FROM auth_account_entries ORDER BY auth_cursor, auth_at");
  assert.deepEqual(rows.map((row) => [row.auth_cursor, row.auth_at.toISOString(), row.account_id, row.kind]), [
    ["YzEy", at, "ab1", "account_disabled"],
    ["YzEy", "2026-11-10T11:00:00.000Z", "ab1", "account_disabled"],
    ["YzEz", at, null, "accounts_baseline"]
  ], "the first entry stands");
  await db.transaction(async (client) => {
    assert.equal(await repo.applyAccountEntry({ ...entry, cursor: "YzE0" }, client), true, "inside a transaction");
    assert.equal(await repo.applyAccountEntry({ ...entry, cursor: "YzE0" }, client), false);
  });
  // A time or cursor that is left out or malformed must not apply as "now" or as nothing: the key would not be Auth's.
  await assert.rejects(repo.applyAccountEntry({ ...entry, at: undefined }), TypeError);
  await assert.rejects(repo.applyAccountEntry({ ...entry, at: "not a time" }), TypeError);
  await assert.rejects(repo.applyAccountEntry({ ...entry, cursor: "has space" }), TypeError);
  await assert.rejects(repo.applyAccountEntry({ ...entry, cursor: undefined }), TypeError);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM auth_account_entries")).rows[0].n, 4);
});

test("an account's availability is the latest applied entry's; the disabled ones are listed in order", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  assert.deepEqual(await repo.disabledAccountList(), []);
  await repo.setAvailability("ab3", true, "YzE1", "2026-11-10T10:00:00.000Z");
  await repo.setAvailability("ab1", true, "YzE2", "2026-11-10T10:01:00.000Z");
  await repo.setAvailability("ab2", false, "YzE3", "2026-11-10T10:02:00.000Z");
  assert.deepEqual(await repo.disabledAccountList(), ["ab1", "ab3"], "ordered, enabled accounts left out");
  await repo.setAvailability("ab1", false, "YzE8", "2026-11-10T10:03:00.000Z");
  await repo.setAvailability("ab2", true, "YzE9", "2026-11-10T10:04:00.000Z");
  assert.deepEqual(await repo.disabledAccountList(), ["ab2", "ab3"], "an upsert: the latest entry for an account says");
  const { rows } = await db.pool.query("SELECT account_id, disabled, auth_cursor, auth_at FROM account_availability ORDER BY account_id");
  assert.deepEqual(rows.map((row) => [row.account_id, row.disabled, row.auth_cursor, row.auth_at.toISOString()]), [
    ["ab1", false, "YzE8", "2026-11-10T10:03:00.000Z"],
    ["ab2", true, "YzE9", "2026-11-10T10:04:00.000Z"],
    ["ab3", true, "YzE1", "2026-11-10T10:00:00.000Z"]
  ], "one row per account, with the entry that set it");
  await db.transaction(async (client) => {
    await repo.setAvailability("ab4", true, "YzFh", "2026-11-10T10:05:00.000Z", client);
    assert.deepEqual(await repo.disabledAccountList(client), ["ab2", "ab3", "ab4"], "inside a transaction");
  });
  await assert.rejects(db.transaction(async (client) => {
    await repo.setAvailability("ab5", true, "YzFi", "2026-11-10T10:06:00.000Z", client);
    throw new Error("stop");
  }), /stop/);
  assert.deepEqual(await repo.disabledAccountList(), ["ab2", "ab3", "ab4"], "rolled back with the transaction");
  await assert.rejects(repo.setAvailability("ab6", "yes", "YzFj", "2026-11-10T10:07:00.000Z"), TypeError, "disabled is a boolean");
  await assert.rejects(repo.setAvailability("ab6", true, "YzFj", undefined), TypeError);
  await assert.rejects(repo.setAvailability("ab6", true, "bad cursor", "2026-11-10T10:07:00.000Z"), TypeError);
});

// Order comes from Auth's feed, which the reader applies in order, not from Auth's clocks (two Auth nodes may disagree):
// the entry applied last says, whatever time it carries.
test("an account's availability is the entry applied last, whatever Auth's time on it", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const row = async (account) => (await db.pool.query("SELECT disabled, auth_cursor, auth_at FROM account_availability WHERE account_id = $1", [account])).rows[0];
  await repo.setAvailability("ab1", true, "YzE6", "2026-11-10T10:05:00.000Z");
  await repo.setAvailability("ab1", false, "YzE7", "2026-11-10T10:00:00.000Z");
  const kept = await row("ab1");
  assert.deepEqual([kept.disabled, kept.auth_cursor, kept.auth_at.toISOString()], [false, "YzE7", "2026-11-10T10:00:00.000Z"], "stamped earlier, applied later: it says");
  assert.deepEqual(await repo.disabledAccountList(), []);
  await repo.setAvailability("ab1", true, "YzE8", "2026-11-10T10:05:00.000Z");
  assert.deepEqual(await repo.disabledAccountList(), ["ab1"]);
  await repo.setAvailability("ab1", false, "YzE9", "2026-11-10T10:05:00.000Z");
  assert.deepEqual(await repo.disabledAccountList(), []);
});

test("the accounts baseline is recorded when applied and marked complete; marking it incomplete keeps it recorded and says whether it was complete", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const row = async () => (await db.pool.query("SELECT id, auth_cursor, auth_at, complete FROM account_baseline")).rows.map((entry) => [entry.id, entry.auth_cursor, entry.auth_at.toISOString(), entry.complete]);
  assert.equal(await repo.baselineApplied(), false, "no mark before the first baseline");
  assert.equal(await repo.markBaselineComplete(), null, "nothing recorded: nothing to complete");
  assert.equal(await repo.markBaselineIncomplete(), false);
  assert.deepEqual(await row(), []);
  await repo.setBaseline("YzEy", "2026-11-10T10:00:00.000Z");
  assert.deepEqual(await row(), [[true, "YzEy", "2026-11-10T10:00:00.000Z", false]], "recorded, not complete");
  assert.equal(await repo.baselineApplied(), false, "the mark is the complete one");
  assert.deepEqual(await repo.markBaselineComplete(), { cursor: "YzEy", at: "2026-11-10T10:00:00.000Z" }, "the first completes it, and says which baseline");
  assert.equal(await repo.baselineApplied(), true);
  assert.equal(await repo.markBaselineComplete(), null, "the second finds it complete");
  await repo.setBaseline("YzEz", "2026-11-11T10:00:00.000Z");
  assert.deepEqual(await row(), [[true, "YzEz", "2026-11-11T10:00:00.000Z", true]], "one row, the newest baseline; a baseline leaves complete as it is");
  assert.equal(await repo.markBaselineIncomplete(), true, "it was complete");
  assert.equal(await repo.baselineApplied(), false);
  assert.deepEqual(await row(), [[true, "YzEz", "2026-11-11T10:00:00.000Z", false]], "the baseline stays recorded");
  assert.equal(await repo.markBaselineIncomplete(), false, "it wasn't any more");
  await db.transaction(async (client) => {
    assert.deepEqual(await repo.markBaselineComplete(client), { cursor: "YzEz", at: "2026-11-11T10:00:00.000Z" });
    assert.equal(await repo.baselineApplied(client), true, "inside a transaction");
    await repo.setBaseline("YzE1", "2026-11-13T10:00:00.000Z", client);
    assert.equal(await repo.markBaselineIncomplete(client), true);
    assert.equal(await repo.baselineApplied(client), false);
  });
  assert.deepEqual(await row(), [[true, "YzE1", "2026-11-13T10:00:00.000Z", false]]);
  await assert.rejects(repo.setBaseline("YzE6", undefined), TypeError);
  await assert.rejects(repo.setBaseline("bad cursor", "2026-11-13T10:00:00.000Z"), TypeError);
});

// The Portal's following of Auth's accounts sits on the feed's one row (D29): its mode, the epoch every start-over raises,
// the baseline the current rebuild applied, and whether the built-in Stations are owed the news that it is incomplete.
test("the accounts' sync state starts rebuilding in epoch 0; a start-over raises the epoch, empties the cursor and the rebuild, and the mode and the owed news are set as given", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const fresh = { mode: "rebuilding", epoch: 0, incompleteOwed: false, rebuildBaseline: null };
  assert.deepEqual(await repo.accountSync(), fresh);
  await repo.saveAuthChangeCursor("YzEy");
  await repo.applyRebuildEntry({ cursor: "YzEy", at: "2026-11-10T10:00:00.000Z", account: "ab1", kind: "account_disabled" });
  await repo.setRebuildAvailability("ab1", true, "YzEy", "2026-11-10T10:00:00.000Z");
  await repo.setRebuildBaseline("YzEz", "2026-11-10T10:01:00.000Z");
  assert.deepEqual(await repo.accountSync(), { ...fresh, rebuildBaseline: { cursor: "YzEz", at: "2026-11-10T10:01:00.000Z" } });
  const counts = async () => (await db.pool.query("SELECT (SELECT count(*)::int FROM auth_account_entries_rebuild) AS entries, (SELECT count(*)::int FROM account_availability_rebuild) AS availability")).rows[0];
  assert.deepEqual(await counts(), { entries: 1, availability: 1 });
  await assert.rejects(repo.startAccountsOver(), TypeError, "a start-over is one transaction");
  assert.equal(await db.transaction((client) => repo.startAccountsOver(client)), 1);
  assert.deepEqual(await repo.accountSync(), { ...fresh, epoch: 1 });
  assert.deepEqual(await repo.authChangePlace(), { cursor: null, epoch: 1 }, "the cursor is emptied with the epoch");
  assert.deepEqual(await counts(), { entries: 0, availability: 0 }, "and the rebuild");
  for (const mode of ["live", "waiting"]) {
    await repo.setAccountsMode(mode);
    assert.equal((await repo.accountSync()).mode, mode);
  }
  for (const bad of ["rebuilding", "off", undefined]) await assert.rejects(repo.setAccountsMode(bad), TypeError, String(bad));
  await repo.setAccountsIncompleteOwed(true);
  assert.equal((await repo.accountSync()).incompleteOwed, true);
  await assert.rejects(repo.setAccountsIncompleteOwed("yes"), TypeError);
  assert.equal(await db.transaction((client) => repo.startAccountsOver(client)), 2);
  assert.deepEqual(await repo.accountSync(), { mode: "rebuilding", epoch: 2, incompleteOwed: true, rebuildBaseline: null }, "the owed news is the service's to send");
  // Rolled back with its transaction.
  await assert.rejects(db.transaction(async (client) => {
    await repo.startAccountsOver(client);
    throw new Error("stop");
  }), /stop/);
  assert.equal((await repo.accountSync()).epoch, 2);
  // A missing row reads as waiting, and a start-over makes it again.
  await db.pool.query("DELETE FROM auth_change_feed");
  assert.deepEqual(await repo.accountSync(), { mode: "waiting", epoch: 0, incompleteOwed: false, rebuildBaseline: null });
  assert.equal(await db.transaction((client) => repo.startAccountsOver(client)), 1);
  assert.deepEqual(await repo.accountSync(), { ...fresh, epoch: 1 });
});

test("a read pass's cursor is saved only in the epoch it began in", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  assert.equal(await repo.moveAuthChangeCursor("YzEy", 0), true);
  assert.deepEqual(await repo.authChangePlace(), { cursor: "YzEy", epoch: 0 });
  await db.transaction((client) => repo.startAccountsOver(client));
  assert.equal(await repo.moveAuthChangeCursor("YzEz", 0), false, "a pass that began before the start-over");
  assert.deepEqual(await repo.authChangePlace(), { cursor: null, epoch: 1 });
  assert.equal(await repo.moveAuthChangeCursor("YzEz", 1), true);
  assert.deepEqual(await repo.authChangePlace(), { cursor: "YzEz", epoch: 1 });
  for (const bad of [null, "", "has space"]) await assert.rejects(repo.moveAuthChangeCursor(bad, 1), TypeError, String(bad));
  for (const bad of [undefined, -1, 1.5, "1"]) await assert.rejects(repo.moveAuthChangeCursor("YzE0", bad), TypeError, String(bad));
  // A save that waits for a start-over in flight (the row's lock) is decided on the epoch the start-over commits.
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    assert.equal(await repo.startAccountsOver(client), 2);
    const saving = repo.moveAuthChangeCursor("YzE0", 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.query("COMMIT");
    assert.equal(await saving, false);
  } finally {
    client.release();
  }
  assert.deepEqual(await repo.authChangePlace(), { cursor: null, epoch: 2 });
  await db.pool.query("DELETE FROM auth_change_feed");
  assert.equal(await repo.moveAuthChangeCursor("YzE2", 5), true, "a missing row is made");
  assert.deepEqual([await repo.authChangePlace(), (await repo.accountSync()).mode], [{ cursor: "YzE2", epoch: 5 }, "waiting"]);
});

// A rebuild applies Auth's feed to tables of its own; at its end the Portal compares them with the live table and adopts
// them (service.accountsCaughtUp).
test("a rebuild's entries and availability are kept apart from the live ones; its differences from the live table are listed, and adopting it replaces the live tables and empties it", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const at = (minute) => "2026-11-10T10:0" + minute + ":00.000Z";
  // Live: ab1 disabled, ab2 disabled, ab3 enabled, ab5 enabled.
  for (const [account, disabled, cursor, minute] of [["ab1", true, "YzE1", 1], ["ab2", true, "YzE2", 2], ["ab3", false, "YzE3", 3], ["ab5", false, "YzE5", 5]]) {
    assert.equal(await repo.applyAccountEntry({ cursor, at: at(minute), account, kind: disabled ? "account_disabled" : "account_enabled" }), true);
    await repo.setAvailability(account, disabled, cursor, at(minute));
  }
  // The rebuild: ab1 disabled, ab2 enabled, ab3 disabled, ab4 disabled, ab6 enabled (and no ab5).
  assert.deepEqual(await repo.availabilityDifferences(), [
    { account: "ab1", disabled: false, cursor: null, at: null }, { account: "ab2", disabled: false, cursor: null, at: null }
  ], "an empty rebuild: every disabled account differs");
  for (const [account, disabled, cursor, minute] of [["ab1", true, "YzE1", 1], ["ab2", false, "YzE6", 6], ["ab3", true, "YzE7", 7], ["ab4", true, "YzE8", 8], ["ab6", false, "YzE9", 9]]) {
    assert.equal(await repo.applyRebuildEntry({ cursor, at: at(minute), account, kind: disabled ? "account_disabled" : "account_enabled" }), true);
    await repo.setRebuildAvailability(account, disabled, cursor, at(minute));
  }
  assert.equal(await repo.applyRebuildEntry({ cursor: "YzE1", at: at(1), account: "ab1", kind: "account_disabled" }), false, "the rebuild's own log dedupes");
  assert.equal(await repo.applyRebuildEntry({ cursor: "YzFh", at: at(9), account: null, kind: "accounts_baseline" }), true);
  await repo.setRebuildBaseline("YzFh", at(9));
  assert.deepEqual(await repo.disabledAccountList(), ["ab1", "ab2"], "the live table is untouched");
  assert.deepEqual(await repo.availabilityDifferences(), [
    { account: "ab2", disabled: false, cursor: "YzE6", at: at(6) },
    { account: "ab3", disabled: true, cursor: "YzE7", at: at(7) },
    { account: "ab4", disabled: true, cursor: "YzE8", at: at(8) }
  ], "the same state is no difference, and an account with no row is enabled on either side");
  await assert.rejects(repo.adoptRebuild(), TypeError, "adopting is one transaction");
  await db.transaction((client) => repo.adoptRebuild(client));
  assert.deepEqual(await repo.disabledAccountList(), ["ab1", "ab3", "ab4"]);
  const live = (await db.pool.query("SELECT account_id, disabled, auth_cursor FROM account_availability ORDER BY account_id")).rows.map((row) => [row.account_id, row.disabled, row.auth_cursor]);
  assert.deepEqual(live, [["ab1", true, "YzE1"], ["ab2", false, "YzE6"], ["ab3", true, "YzE7"], ["ab4", true, "YzE8"], ["ab6", false, "YzE9"]], "the rebuild's rows, ab5's gone");
  const entries = (await db.pool.query("SELECT auth_cursor, kind FROM auth_account_entries ORDER BY auth_cursor")).rows.map((row) => [row.auth_cursor, row.kind]);
  assert.deepEqual(entries, [["YzE1", "account_disabled"], ["YzE6", "account_enabled"], ["YzE7", "account_disabled"], ["YzE8", "account_disabled"], ["YzE9", "account_enabled"], ["YzFh", "accounts_baseline"]], "the live log is the rebuild's");
  assert.equal(await repo.applyAccountEntry({ cursor: "YzE6", at: at(6), account: "ab2", kind: "account_enabled" }), false, "so the live mode dedupes what the rebuild applied");
  assert.equal(await repo.applyAccountEntry({ cursor: "YzE2", at: at(2), account: "ab2", kind: "account_disabled" }), true, "and nothing else");
  const left = (await db.pool.query("SELECT (SELECT count(*)::int FROM auth_account_entries_rebuild) AS entries, (SELECT count(*)::int FROM account_availability_rebuild) AS availability")).rows[0];
  assert.deepEqual(left, { entries: 0, availability: 0 });
  assert.equal((await repo.accountSync()).rebuildBaseline, null, "the baseline it saw is cleared too");
  assert.deepEqual(await repo.availabilityDifferences(), [{ account: "ab1", disabled: false, cursor: null, at: null }, { account: "ab3", disabled: false, cursor: null, at: null }, { account: "ab4", disabled: false, cursor: null, at: null }]);
  await assert.rejects(repo.setRebuildAvailability("ab1", "yes", "YzFi", at(9)), TypeError, "disabled is a boolean");
  await assert.rejects(repo.setRebuildAvailability("ab1", true, "bad cursor", at(9)), TypeError);
  await assert.rejects(repo.applyRebuildEntry({ cursor: "YzFi", at: undefined, kind: "account_disabled" }), TypeError);
  await assert.rejects(repo.setRebuildBaseline("YzFi", "not a time"), TypeError);
});

const bindingFields = (extra = {}) => ({ stationId: "st1", r9AccountId: "r9-1", genesisHash: "a".repeat(64), accountId: "ab1", bindingId: "b-1", version: 1, bindingState: "bound", reportId: "rep-1", ...extra });

test("a built-in Station's binding is kept per R9 account and genesis: the first is saved, a later one replaces it", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  assert.equal(await repo.binding("st1", "r9-1", "a".repeat(64)), null);
  await db.transaction((client) => repo.saveBinding(bindingFields(), client));
  const first = await repo.binding("st1", "r9-1", "a".repeat(64));
  assert.deepEqual({ ...first, updatedAt: typeof first.updatedAt }, { ...bindingFields(), updatedAt: "string" });
  assert.equal(typeof first.version, "number", "bigint comes back as a number, not the driver's string");
  await db.transaction((client) => repo.saveBinding(bindingFields({ accountId: "ab2", bindingId: "b-2", version: 2, bindingState: "released", reportId: "rep-2" }), client));
  const second = await repo.binding("st1", "r9-1", "a".repeat(64));
  assert.deepEqual([second.accountId, second.bindingId, second.version, second.bindingState, second.reportId], ["ab2", "b-2", 2, "released", "rep-2"], "an upsert: one row per key");
  assert.ok(Date.parse(second.updatedAt) >= Date.parse(first.updatedAt));
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM station_bindings")).rows[0].n, 1);
  assert.equal(await repo.binding("st1", "r9-2", "a".repeat(64)), null, "another R9 account");
  assert.equal(await repo.binding("st1", "r9-1", "b".repeat(64)), null, "another genesis");
  assert.equal(await repo.binding("st2", "r9-1", "a".repeat(64)), null, "another Station");
  await db.transaction(async (client) => assert.equal((await repo.binding("st1", "r9-1", "a".repeat(64), client)).bindingId, "b-2", "inside a transaction"));
  for (const version of [0, -1, 1.5, 2 ** 53, "3", undefined]) await assert.rejects(db.transaction((client) => repo.saveBinding(bindingFields({ version }), client)), TypeError, "version " + String(version));
  await assert.rejects(db.transaction((client) => repo.saveBinding(bindingFields({ bindingState: "revoked" }), client)), { code: "23514" });
  assert.equal((await repo.binding("st1", "r9-1", "a".repeat(64))).version, 2, "refused writes change nothing");
  const big = 2 ** 53 - 1;
  await db.transaction((client) => repo.saveBinding(bindingFields({ r9AccountId: "r9-big", version: big }), client));
  assert.equal((await repo.binding("st1", "r9-big", "a".repeat(64))).version, big, "the largest safe version is read back exactly");
});

test("a Station's bindings are listed by R9 account, then genesis, for that Station only", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const save = (extra) => db.transaction((client) => repo.saveBinding(bindingFields(extra), client));
  assert.deepEqual(await repo.bindingsOn("st1"), []);
  await save({ r9AccountId: "r9-b", genesisHash: "c".repeat(64), bindingId: "b-3" });
  await save({ r9AccountId: "r9-a", genesisHash: "d".repeat(64), bindingId: "b-4" });
  await save({ r9AccountId: "r9-b", genesisHash: "a".repeat(64), bindingId: "b-5" });
  await save({ r9AccountId: "r9-a", genesisHash: "b".repeat(64), bindingId: "b-6", bindingState: "unbound", version: 7 });
  await save({ stationId: "st2", r9AccountId: "r9-0", bindingId: "b-7" });
  const list = await repo.bindingsOn("st1");
  assert.deepEqual(list.map((row) => [row.r9AccountId, row.genesisHash[0], row.bindingId]), [["r9-a", "b", "b-6"], ["r9-a", "d", "b-4"], ["r9-b", "a", "b-5"], ["r9-b", "c", "b-3"]]);
  assert.deepEqual([list[0].stationId, list[0].accountId, list[0].version, list[0].bindingState], ["st1", "ab1", 7, "unbound"], "an unbound binding is still listed");
  assert.deepEqual((await repo.bindingsOn("st2")).map((row) => row.bindingId), ["b-7"]);
  await db.transaction(async (client) => assert.equal((await repo.bindingsOn("st1", client)).length, 4, "inside a transaction"));
});

test("a refused binding attempt is kept once per Station and report id, and listed for the account it protects since a time, newest first", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const attempt = (extra) => ({ stationId: "st1", reportId: "rep-1", accountId: "ab1", r9AccountId: "r9-1", genesisHash: "a".repeat(64), reason: "bound_elsewhere", attemptedAt: later(-3 * 86400000).toISOString(), ...extra });
  const save = (extra) => db.transaction((client) => repo.saveBindingAttempt(attempt(extra), client));
  assert.deepEqual(await repo.bindingAttemptsFor("ab1", later(-30 * 86400000)), []);
  await save();
  await save({ reportId: "rep-2", reason: "owner_disabled", attemptedAt: later(-1 * 86400000).toISOString(), r9AccountId: "r9-2" });
  await save({ reportId: "rep-3", attemptedAt: later(-40 * 86400000).toISOString() });
  await save({ reportId: "rep-4", accountId: "ab2", attemptedAt: later(-1000).toISOString() });
  await save({ stationId: "st2", reportId: "rep-1", attemptedAt: later(-2 * 86400000).toISOString() });
  const since = later(-30 * 86400000);
  const mine = await repo.bindingAttemptsFor("ab1", since);
  assert.deepEqual(mine.map((row) => [row.stationId, row.reportId, row.reason, row.r9AccountId]), [["st1", "rep-2", "owner_disabled", "r9-2"], ["st2", "rep-1", "bound_elsewhere", "r9-1"], ["st1", "rep-1", "bound_elsewhere", "r9-1"]], "this account's, newer than the cut-off, newest first");
  assert.deepEqual(Object.keys(mine[0]).sort(), ["accountId", "attemptedAt", "genesisHash", "r9AccountId", "reason", "recordedAt", "reportId", "stationId"]);
  assert.deepEqual([mine[2].accountId, mine[2].genesisHash, mine[2].attemptedAt], ["ab1", "a".repeat(64), later(-3 * 86400000).toISOString()]);
  assert.ok(!mine.some((row) => row.accountId !== "ab1"), "never another account's");
  assert.deepEqual((await repo.bindingAttemptsFor("ab2", since)).map((row) => row.reportId), ["rep-4"]);
  assert.deepEqual((await repo.bindingAttemptsFor("ab1", later(-3 * 86400000))).map((row) => row.reportId), ["rep-2", "rep-1", "rep-1"], "the cut-off time itself counts");
  assert.equal((await repo.bindingAttemptsFor("ab1", later(-40 * 86400000))).length, 4, "an earlier cut-off reaches further back");
  assert.deepEqual(await repo.bindingAttemptsFor("ab9", since), []);
  await db.transaction(async (client) => assert.equal((await repo.bindingAttemptsFor("ab1", since, client)).length, 3, "inside a transaction"));
  // A limit keeps the newest that many, in the same order; none is the whole list.
  assert.deepEqual((await repo.bindingAttemptsFor("ab1", since, undefined, { limit: 2 })).map((row) => [row.stationId, row.reportId]), [["st1", "rep-2"], ["st2", "rep-1"]], "the 2 newest");
  assert.equal((await repo.bindingAttemptsFor("ab1", since, undefined, { limit: 10 })).length, 3);
  assert.equal((await repo.bindingAttemptsFor("ab1", since, undefined, {})).length, 3);
  await db.transaction(async (client) => assert.equal((await repo.bindingAttemptsFor("ab1", since, client, { limit: 1 })).length, 1, "inside a transaction"));
  for (const limit of [0, -1, 1.5, "2", null, NaN]) await assert.rejects(repo.bindingAttemptsFor("ab1", since, undefined, { limit }), TypeError, String(limit));
  // The report id is kept once per Station: the caller looked it up first, so a second save is a mistake, not a replacement.
  await assert.rejects(save({ accountId: "ab2" }), { code: "23505" });
  await assert.rejects(save({ reportId: "rep-9", reason: "other" }), { code: "23514" });
  assert.equal((await repo.bindingAttemptsFor("ab1", since)).length, 3);
});

// The Station directory (directoryFor): what an account may use now, and what it lost within the retention window.
const DAY = 86400000;
const CUTOFF = new Date(NOW - 30 * DAY);
const daysAgo = (days) => new Date(NOW - days * DAY);

// A Station with an explicit creation time (the order is by it), as a custom one owned by `owner` or, with builtIn, the built-in one.
async function dated(repo, db, id, createdDaysAgo, { owner = "ab2", builtIn = false } = {}) {
  await repo.insertStation(builtIn
    ? { id, origin: "https://" + id + ".example", ownerAccount: null, reportClientId: "s-" + id, verifiedAt: NOW, builtIn: true, name: "Built-in " + id }
    : { id, origin: "https://" + id + ".example", ownerAccount: owner, reportClientId: "s-" + id, verifiedAt: NOW });
  await db.pool.query("UPDATE stations SET created_at = $2 WHERE id = $1", [id, daysAgo(createdDaysAgo)]);
}

const shape = (rows) => rows.map((row) => [row.id, row.role, row.status, row.membership]);

test("directoryFor lists the built-in Stations first, then what the account owns and belongs to, by creation time and id", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await dated(repo, db, "st-own", 90, { owner: "ab1" });
  await dated(repo, db, "st-mem", 80);
  await dated(repo, db, "st-b2", 50, { builtIn: true });
  await dated(repo, db, "st-b1", 100, { builtIn: true });
  await dated(repo, db, "st-other", 70, { owner: "ab3" });
  await dated(repo, db, "st-theirs", 60, { owner: "ab2" });
  await repo.addMember("st-mem", "ab1", "ab2", daysAgo(75));
  await repo.addMember("st-theirs", "ab3", "ab2", daysAgo(55));
  const rows = await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 });
  assert.deepEqual(shape(rows), [["st-b1", "built_in", "active", null], ["st-b2", "built_in", "active", null], ["st-own", "owner", "active", null], ["st-mem", "member", "active", "current"]],
    "built-in first even though the owned Station is older than one, then by creation; another account's Stations, and a Station it has no part in, are not listed");
  const [builtIn, owned, member] = [rows[0], rows[2], rows[3]];
  assert.deepEqual([builtIn.builtIn, builtIn.access, builtIn.name, builtIn.removedAt, builtIn.membershipEndedAt, builtIn.integrationsEnabled, builtIn.createdAt], [true, "any_account", "Built-in st-b1", null, null, true, daysAgo(100).toISOString()]);
  assert.deepEqual([owned.builtIn, owned.access, owned.name, owned.origin, owned.removedAt, owned.membership, owned.membershipEndedAt], [false, "members", null, "https://st-own.example", null, null, null]);
  assert.deepEqual([member.role, member.membership, member.membershipEndedAt, member.removedAt], ["member", "current", null, null]);
  // Each row is a whole Station row too, so the service can answer with the directory's fields.
  assert.deepEqual(Object.keys(member).sort(), ["access", "builtIn", "createdAt", "id", "integrationsEnabled", "membership", "membershipEndedAt", "name", "origin", "ownerAccount", "removedAt", "reportClientId", "role", "status", "verifiedAt"]);
  // The account that owns and belongs to nothing gets the built-in Stations alone.
  assert.deepEqual(shape(await repo.directoryFor("ab9", { lostSince: CUTOFF, limit: 100 })), [["st-b1", "built_in", "active", null], ["st-b2", "built_in", "active", null]]);
  assert.deepEqual(shape(await repo.directoryFor("ab3", { lostSince: CUTOFF, limit: 100 })), [["st-b1", "built_in", "active", null], ["st-b2", "built_in", "active", null], ["st-other", "owner", "active", null], ["st-theirs", "member", "active", "current"]]);
  // The same Stations as the browser list when nothing was lost.
  assert.deepEqual((await repo.stationsFor("ab1")).map((row) => [row.id, row.role]), shape(rows).map(([id, role]) => [id, role]));
});

test("directoryFor: the built-in Station has no members and an owner is not a member, even with a stray membership row", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await dated(repo, db, "st-b", 100, { builtIn: true });
  await dated(repo, db, "st-own", 90, { owner: "ab1" });
  await repo.addMember("st-b", "ab1", "ab9", daysAgo(50));
  await repo.addMember("st-own", "ab1", "ab9", daysAgo(50));
  await repo.removeMember("st-own", "ab1", "ab9", daysAgo(5));
  let rows = await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 });
  assert.deepEqual(shape(rows), [["st-b", "built_in", "active", null], ["st-own", "owner", "active", null]], "role built_in or owner; membership null, and no ended-membership row for a Station the account still owns");
  assert.deepEqual(rows.map((row) => row.membershipEndedAt), [null, null]);
  await repo.markStationRemoved("st-own", daysAgo(4));
  rows = await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 });
  assert.deepEqual(shape(rows), [["st-b", "built_in", "active", null], ["st-own", "owner", "removed", null]], "an owner's removed Station: role owner, never a member's ended membership");
  assert.equal(rows[1].removedAt, daysAgo(4).toISOString());
  assert.equal(rows[1].membershipEndedAt, null);
});

test("directoryFor says a lost Station was lost for 30 days: a removed one, an ended membership, both, and not after", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const member = async (id, createdDaysAgo, endedDaysAgo = null, who = "ab1") => {
    await dated(repo, db, id, createdDaysAgo);
    await repo.addMember(id, who, "ab2", daysAgo(createdDaysAgo - 1));
    if (endedDaysAgo !== null) await repo.removeMember(id, who, "ab2", daysAgo(endedDaysAgo));
  };
  await dated(repo, db, "st-owned-removed", 100, { owner: "ab1" });
  await repo.markStationRemoved("st-owned-removed", daysAgo(5));
  await dated(repo, db, "st-owned-removed-old", 99, { owner: "ab1" });
  await repo.markStationRemoved("st-owned-removed-old", daysAgo(31));
  await member("st-ended", 98, 10);
  await member("st-ended-old", 97, 31);
  await member("st-member-removed", 96);
  await repo.markStationRemoved("st-member-removed", daysAgo(3));
  await member("st-member-removed-old", 95);
  await repo.markStationRemoved("st-member-removed-old", daysAgo(40));
  await member("st-both", 94, 10);
  await repo.markStationRemoved("st-both", daysAgo(5));
  await member("st-both-old", 93, 40);
  await repo.markStationRemoved("st-both-old", daysAgo(35));
  await member("st-left-before-removal", 92, 40);
  await repo.markStationRemoved("st-left-before-removal", daysAgo(5));
  // Another account's losses are not this account's.
  await dated(repo, db, "st-other-removed", 91, { owner: "ab3" });
  await repo.markStationRemoved("st-other-removed", daysAgo(1));
  await member("st-other-ended", 90, 1, "ab3");
  const rows = await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 });
  assert.deepEqual(shape(rows), [
    ["st-owned-removed", "owner", "removed", null],
    ["st-ended", "member", "active", "ended"],
    ["st-member-removed", "member", "removed", "current"],
    ["st-both", "member", "removed", "ended"]
  ], "a removed Station it owned or belonged to, an ended membership on an active Station, and for both the removal; none lost more than 30 days ago, none of another account's");
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual([byId["st-owned-removed"].removedAt, byId["st-owned-removed"].membershipEndedAt], [daysAgo(5).toISOString(), null]);
  assert.deepEqual([byId["st-ended"].removedAt, byId["st-ended"].membershipEndedAt], [null, daysAgo(10).toISOString()]);
  assert.deepEqual([byId["st-member-removed"].removedAt, byId["st-member-removed"].membershipEndedAt], [daysAgo(3).toISOString(), null], "its membership never ended: the Station was removed under it");
  assert.deepEqual([byId["st-both"].removedAt, byId["st-both"].membership, byId["st-both"].membershipEndedAt], [daysAgo(5).toISOString(), "ended", daysAgo(10).toISOString()], "the removal is reported, with when the membership ended as well");
  // The window follows lostSince. A Station is lost when the account lost it: for a member who left before the Station
  // was removed, that is when they left.
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: daysAgo(32), limit: 100 })).map((row) => row.id),
    ["st-owned-removed", "st-owned-removed-old", "st-ended", "st-ended-old", "st-member-removed", "st-both"]);
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: daysAgo(60), limit: 100 })).map((row) => row.id),
    ["st-owned-removed", "st-owned-removed-old", "st-ended", "st-ended-old", "st-member-removed", "st-member-removed-old", "st-both", "st-both-old", "st-left-before-removal"]);
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: daysAgo(1), limit: 100 })).map((row) => row.id), [], "nothing was lost in the last day");
});

test("directoryFor lists a removed built-in Station for 30 days, as built_in with removedAt", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await dated(repo, db, "st-b-live", 100, { builtIn: true });
  await dated(repo, db, "st-b-removed", 90, { builtIn: true });
  await dated(repo, db, "st-b-gone", 80, { builtIn: true });
  await dated(repo, db, "st-own", 70, { owner: "ab1" });
  await repo.markStationRemoved("st-b-removed", daysAgo(5));
  await repo.markStationRemoved("st-b-gone", daysAgo(31));
  for (const account of ["ab1", "ab9"]) {
    const rows = await repo.directoryFor(account, { lostSince: CUTOFF, limit: 100 });
    assert.deepEqual(shape(rows).filter(([id]) => id.startsWith("st-b")), [["st-b-live", "built_in", "active", null], ["st-b-removed", "built_in", "removed", null]], "every account is told, within 30 days; not after, and never as a member");
    const removed = rows.find((row) => row.id === "st-b-removed");
    assert.deepEqual([removed.builtIn, removed.removedAt, removed.membership, removed.membershipEndedAt], [true, daysAgo(5).toISOString(), null, null]);
  }
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 })).map((row) => row.id), ["st-b-live", "st-b-removed", "st-own"], "built-in Stations first, removed or not");
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: daysAgo(32), limit: 100 })).map((row) => row.id), ["st-b-live", "st-b-removed", "st-b-gone", "st-own"], "the window follows lostSince");
  // A stray member row on a removed built-in Station changes nothing: it has no members.
  await repo.addMember("st-b-removed", "ab1", "ab9", daysAgo(50));
  assert.deepEqual(shape(await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 })).filter(([id]) => id === "st-b-removed"), [["st-b-removed", "built_in", "removed", null]]);
});

test("directoryFor reads a re-added member by its current membership, and by the latest end when it ended again", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  for (const id of ["st-again", "st-again-ended", "st-again-removed"]) {
    await dated(repo, db, id, id === "st-again" ? 90 : id === "st-again-ended" ? 80 : 70);
    await repo.addMember(id, "ab1", "ab2", daysAgo(60));
    await repo.removeMember(id, "ab1", "ab2", daysAgo(50));
    await repo.addMember(id, "ab1", "ab2", daysAgo(40));
  }
  // st-again: an ended row and a current one.
  // st-again-ended: ended again, 3 days ago, after an earlier end 50 days ago.
  await repo.removeMember("st-again-ended", "ab1", "ab2", daysAgo(3));
  // st-again-removed: current, then the Station removed.
  await repo.markStationRemoved("st-again-removed", daysAgo(2));
  const rows = await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 });
  assert.deepEqual(shape(rows), [["st-again", "member", "active", "current"], ["st-again-ended", "member", "active", "ended"], ["st-again-removed", "member", "removed", "current"]]);
  assert.deepEqual(rows.map((row) => row.membershipEndedAt), [null, daysAgo(3).toISOString(), null], "a current membership has no end; an ended one gives the latest, not the first");
  // The earlier end alone is more than 30 days ago: only the later one keeps it listed. Ended again 40 days ago, it is gone.
  await db.pool.query("UPDATE station_members SET removed_at = $2 WHERE station_id = $1 AND removed_at IS NOT NULL AND removed_at > $3", ["st-again-ended", daysAgo(40), daysAgo(10)]);
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 })).map((row) => row.id), ["st-again", "st-again-removed"]);
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: daysAgo(45), limit: 100 })).map((row) => [row.id, row.membershipEndedAt]).filter(([id]) => id === "st-again-ended"), [["st-again-ended", daysAgo(40).toISOString()]]);
});

test("directoryFor dates a member's loss by the earlier of leaving and the Station's removal, at the boundary too", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  const before = (time) => new Date(time.getTime() - 1);
  const after = (time) => new Date(time.getTime() + 86400000);
  const member = async (id, createdDaysAgo, left, removed) => {
    await dated(repo, db, id, createdDaysAgo);
    await repo.addMember(id, "ab1", "ab2", daysAgo(createdDaysAgo - 1));
    await repo.removeMember(id, "ab1", "ab2", left);
    await repo.markStationRemoved(id, removed);
  };
  await member("st-left-at-cutoff-then-removed", 100, CUTOFF, after(CUTOFF));
  await member("st-removed-at-cutoff-then-left", 99, after(CUTOFF), CUTOFF);
  await member("st-left-before-cutoff-then-removed", 98, before(CUTOFF), after(CUTOFF));
  await member("st-removed-before-cutoff-then-left", 97, after(CUTOFF), before(CUTOFF));
  await member("st-left-and-removed-at-cutoff", 96, CUTOFF, CUTOFF);
  const rows = await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 });
  assert.deepEqual(shape(rows), [
    ["st-left-at-cutoff-then-removed", "member", "removed", "ended"],
    ["st-removed-at-cutoff-then-left", "member", "removed", "ended"],
    ["st-left-and-removed-at-cutoff", "member", "removed", "ended"]
  ], "lost at the cutoff counts, whichever of leaving and removal came first; lost a moment before does not, although the other came later");
  assert.deepEqual(rows.map((row) => [row.removedAt, row.membershipEndedAt]), [
    [after(CUTOFF).toISOString(), CUTOFF.toISOString()],
    [CUTOFF.toISOString(), after(CUTOFF).toISOString()],
    [CUTOFF.toISOString(), CUTOFF.toISOString()]
  ], "the removal is the status, and when the membership ended is still given");
});

test("directoryFor counts a loss at exactly lostSince, and not a moment earlier", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await dated(repo, db, "st-1", 50, { owner: "ab1" });
  await dated(repo, db, "st-2", 49, { owner: "ab1" });
  await dated(repo, db, "st-3", 48);
  await dated(repo, db, "st-4", 47);
  await repo.markStationRemoved("st-1", CUTOFF);
  await repo.markStationRemoved("st-2", new Date(CUTOFF.getTime() - 1));
  for (const id of ["st-3", "st-4"]) await repo.addMember(id, "ab1", "ab2", daysAgo(45));
  await repo.removeMember("st-3", "ab1", "ab2", CUTOFF);
  await repo.removeMember("st-4", "ab1", "ab2", new Date(CUTOFF.getTime() - 1));
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 })).map((row) => row.id), ["st-1", "st-3"]);
});

test("directoryFor pages by keyset: limit + 1 rows say whether there is more, and every page continues exactly after the last row seen", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await dated(repo, db, "st-b", 100, { builtIn: true });
  await dated(repo, db, "st-own", 90, { owner: "ab1" });
  await dated(repo, db, "st-mem", 80);
  await repo.addMember("st-mem", "ab1", "ab2", daysAgo(70));
  await dated(repo, db, "st-lost", 70, { owner: "ab1" });
  await repo.markStationRemoved("st-lost", daysAgo(2));
  await dated(repo, db, "st-ended", 60);
  await repo.addMember("st-ended", "ab1", "ab2", daysAgo(55));
  await repo.removeMember("st-ended", "ab1", "ab2", daysAgo(2));
  const expected = ["st-b", "st-own", "st-mem", "st-lost", "st-ended"];
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 })).map((row) => row.id), expected);
  assert.equal((await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 5 })).length, 5, "exactly a page and no more: no extra row");
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 2 })).map((row) => row.id), ["st-b", "st-own", "st-mem"], "limit + 1");
  const pages = [];
  let after;
  for (;;) {
    const rows = await repo.directoryFor("ab1", { lostSince: CUTOFF, after, limit: 1 });
    pages.push(rows.map((row) => row.id));
    if (rows.length < 2) break;
    after = { builtIn: rows[0].builtIn, createdAt: rows[0].createdAt, id: rows[0].id };
  }
  assert.deepEqual(pages, [["st-b", "st-own"], ["st-own", "st-mem"], ["st-mem", "st-lost"], ["st-lost", "st-ended"], ["st-ended"]], "every page's last row is the next page's first, and the last page has no extra");
  // After the built-in Station the rest follow, after any row of the rest only later ones do, and after the last none.
  const rest = async (row) => (await repo.directoryFor("ab1", { lostSince: CUTOFF, after: { builtIn: row.builtIn, createdAt: row.createdAt, id: row.id }, limit: 100 })).map((r) => r.id);
  const all = await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 });
  assert.deepEqual(await rest(all[0]), expected.slice(1));
  assert.deepEqual(await rest(all[2]), expected.slice(3));
  assert.deepEqual(await rest(all[4]), []);
  // A cursor may name a Station that is no longer listed: the order is by the key, not by the row.
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: CUTOFF, after: { builtIn: false, createdAt: daysAgo(85).toISOString(), id: "st-gone" }, limit: 100 })).map((r) => r.id), ["st-mem", "st-lost", "st-ended"]);
  assert.deepEqual((await repo.directoryFor("ab1", { lostSince: CUTOFF, after: { builtIn: true, createdAt: daysAgo(500).toISOString(), id: "st-gone" }, limit: 100 })).map((r) => r.id), expected, "after a built-in Station that sorts before st-b, st-b and everything else follow");
  await db.transaction(async (client) => assert.equal((await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 1 }, client)).length, 2, "inside a transaction"));
});

// The cursor carries a Station's createdAt as the directory shows it: to the millisecond. A creation time with
// microseconds (now() has them) must order and page by that same value, or a page repeats a row or skips one.
test("directoryFor orders and pages by createdAt as shown, to the millisecond, then id, whatever the microseconds", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  for (const [id, created] of [["st-a", "2026-09-01 00:00:00.123789+00"], ["st-b", "2026-09-01 00:00:00.123456+00"], ["st-c", "2026-09-01 00:00:00.124000+00"], ["st-d", "2026-09-01 00:00:00.122999+00"], ["st-e", "2026-09-01 00:00:00.123000+00"]]) {
    await repo.insertStation({ id, origin: "https://" + id + ".example", ownerAccount: "ab1", reportClientId: "s-" + id, verifiedAt: NOW });
    await db.pool.query("UPDATE stations SET created_at = $2 WHERE id = $1", [id, created]);
  }
  const all = await repo.directoryFor("ab1", { lostSince: CUTOFF, limit: 100 });
  assert.deepEqual(all.map((row) => [row.id, row.createdAt]), [
    ["st-d", "2026-09-01T00:00:00.122Z"],
    ["st-a", "2026-09-01T00:00:00.123Z"],
    ["st-b", "2026-09-01T00:00:00.123Z"],
    ["st-e", "2026-09-01T00:00:00.123Z"],
    ["st-c", "2026-09-01T00:00:00.124Z"]
  ], "the same millisecond is ordered by id, not by the microseconds that are not shown");
  const seen = [];
  let after;
  for (let guard = 0; guard < 10; guard += 1) {
    const rows = await repo.directoryFor("ab1", { lostSince: CUTOFF, after, limit: 1 });
    seen.push(rows[0].id);
    if (rows.length < 2) break;
    after = { builtIn: rows[0].builtIn, createdAt: rows[0].createdAt, id: rows[0].id };
  }
  assert.deepEqual(seen, ["st-d", "st-a", "st-b", "st-e", "st-c"], "paging one at a time visits each Station once");
});

test("directoryFor refuses what it cannot page by: a missing lostSince, a bad limit, a bad after", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  const good = { lostSince: CUTOFF, limit: 10 };
  await repo.directoryFor("ab1", good);
  await assert.rejects(repo.directoryFor("ab1", { limit: 10 }), TypeError, "no window would list nothing lost, or everything, by accident");
  await assert.rejects(repo.directoryFor("ab1", { ...good, lostSince: "yesterday" }), TypeError);
  for (const limit of [0, -1, 1.5, "10", NaN, undefined]) await assert.rejects(repo.directoryFor("ab1", { ...good, limit }), TypeError, String(limit));
  const after = { builtIn: false, createdAt: "2026-09-01T00:00:00.000Z", id: "st-1" };
  await repo.directoryFor("ab1", { ...good, after });
  await repo.directoryFor("ab1", { ...good, after: null });
  for (const bad of [{ ...after, builtIn: "false" }, { ...after, createdAt: "soon" }, { ...after, createdAt: undefined }, { ...after, id: 5 }, { ...after, id: undefined }, "st-1", []]) await assert.rejects(repo.directoryFor("ab1", { ...good, after: bad }), TypeError, JSON.stringify(bad));
});
