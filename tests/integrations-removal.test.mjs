// Two-phase Station removal (D29; Atem designs/delegated-host-work.md I.8): with both settings on, removing a custom Station
// begins a removal during which the Station still reads its feed and reports, and which completes once every integration
// on it is revoked or 26 hours have passed; a Station gone without the two phases flags its integrations pending host
// revocation, for the owner's native revoke.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { createIntegrationService } from "../scripts/integrations/service.mjs";
import { AppError } from "../scripts/store.mjs";
import { fakeManage } from "./helpers/fake-manage.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const OWNER = "ab" + "0".repeat(25) + "1";
const MEMBER = "ab" + "0".repeat(25) + "2";
const STRANGER = "ab" + "0".repeat(25) + "3";
const R9 = "a".repeat(64);
const HOUR = 3600000;
const RECORD = "0b9f5b1e-6c1d-4c38-9a59-2f0d0f6e7a10";

const publicJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
const iso = (ms) => new Date(ms).toISOString();

// The Portal with the setting on over a fake Auth with its own on (`authDelegated` false: an Auth without the two-phase
// routes), on a clock the tests move, with a custom Station of OWNER's shared with MEMBER. `open()` starts another replica
// on the same database and Auth (`open({ delegatedHostWork: false })`, one with the setting turned off).
async function setup(t, { delegatedHostWork = true, authDelegated = delegatedHostWork } = {}) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const clock = { now: Date.now() };
  const manage = fakeManage({ now: () => clock.now, delegated: authDelegated });
  const served = { status: 200, body: "" };
  const notified = [];
  const logs = [];
  let counter = 0;
  const open = ({ delegatedHostWork: setting = delegatedHostWork } = {}) => createIntegrationService({
    repository, db, manage, stationFetch: { async get() { return { ...served }; } }, exchange: async () => ({}), now: () => clock.now,
    log: (line) => logs.push(line), challengeValue: () => "proof-value-" + (++counter), notify: (stationId) => notified.push(stationId), delegatedHostWork: setting
  });
  const service = open();
  async function register(accountId = OWNER, origin = "https://one.example") {
    const challenge = await service.createChallenge(accountId, origin);
    served.body = challenge.value;
    return service.registerStation(accountId, { challengeId: challenge.challengeId, reportKey: publicJwk() });
  }
  const station = await register();
  await service.share(OWNER, station.id, MEMBER);
  // An integration of `accountId` on the Station, approved (so it has an R9 service) unless `approved` is false.
  async function integration(accountId = OWNER, { approved = true, stationId = station.id } = {}) {
    const { id } = await service.createIntegration(accountId, { stationId, name: "App", scopes: [], publicJwk: publicJwk() });
    if (approved) await service.approve(accountId, id, { r9Svc: R9 });
    return id;
  }
  // The Station's final revocation report for an integration (Phase B).
  const final = (id, { reportId = "final-" + id, outcome = "all_applied", pendingHosts = [] } = {}) =>
    service.report(station.reportClientId, { integrationId: id, state: "revoked", reportId, outcome, pendingHosts });
  const row = (id) => repository.integration(id);
  const flag = async (id) => { const found = await row(id); return [found.state, found.pendingHostRevocation]; };
  const events = async (kind) => (await db.pool.query("SELECT * FROM integration_events WHERE kind = $1 ORDER BY id", [kind])).rows;
  const authStation = (id = station.id) => manage.records.find((entry) => entry.id === id);
  const asked = (name) => manage.calls.filter((call) => call === name).length;
  return { db, repository, manage, clock, service, open, station, register, integration, final, row, flag, events, authStation, asked, notified, logs };
}

const refused = (status, code) => (error) => {
  assert.ok(error instanceof AppError, "an AppError, not " + error);
  assert.equal(error.status, status);
  if (code !== undefined) assert.equal(error.details?.code, code);
  return true;
};

test("removing a Station begins its two-phase removal: Auth first, then the Station is removing, its integrations revoked without interrupt, its feed carrying them, and it is pushed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const ready = await s.integration();
  await s.service.report(s.station.reportClientId, { integrationId: ready, state: "ready" });
  const waiting = await s.integration(OWNER, { approved: false });
  const theirs = await s.integration(MEMBER);
  s.notified.length = 0;
  await assert.rejects(s.service.removeStation(MEMBER, s.station.id), refused(403, "forbidden"));
  assert.equal(s.asked("beginStationRemoval"), 0, "a member is refused before Auth");
  const answer = await s.service.removeStation(OWNER, s.station.id);
  assert.deepEqual(answer, { removed: false, removing: true, completeBy: iso(s.clock.now + 26 * HOUR) });
  assert.deepEqual([s.asked("beginStationRemoval"), s.asked("removeStation"), s.asked("completeStationRemoval")], [1, 0, 0], "Auth began it; not today's one-step removal");
  assert.deepEqual([s.authStation().status, s.authStation().reportClientRevoked], ["removing", undefined], "Auth keeps its report client");
  const here = await s.repository.station(s.station.id);
  assert.deepEqual([here.status, here.removalStartedAt, here.removedAt], ["removing", iso(s.clock.now), null]);
  assert.deepEqual([(await s.row(ready)).state, (await s.row(waiting)).state, (await s.row(theirs)).state], ["revoking", "revoked", "revoking"], "one never approved is revoked at once");
  const revoked = await s.events("integration_revoked");
  assert.deepEqual(revoked.map((event) => [event.integration_id, event.actor, event.reason, event.details]), [
    [ready, OWNER, "station_removed", { interruptRunning: false }], [waiting, OWNER, "station_removed", { interruptRunning: false }], [theirs, OWNER, "station_removed", { interruptRunning: false }]
  ], "indirect revocations: no interrupt");
  const [begun] = await s.events("station_removing");
  assert.deepEqual([begun.actor, begun.account_id, begun.integration_id, begun.details], [OWNER, OWNER, null, { revoking: [ready, theirs] }], "the integrations the Station has yet to pass on");
  assert.deepEqual(s.notified, [s.station.id], "pushed, so it reads the revocations");
  // Its feed and checkpoint work, and carry the revocations; the Portal's own record of the begin is no change.
  const feed = await s.service.changes(s.station.reportClientId, "0");
  assert.deepEqual(feed.changes.filter((change) => change.kind === "integration_revoked").map((change) => [change.integrationId, change.reason, change.interruptRunning]),
    [[ready, "station_removed", false], [waiting, "station_removed", false], [theirs, "station_removed", false]]);
  assert.equal(feed.changes.some((change) => change.kind === "station_removing"), false, "no new kind: the Station learns of its removal from the revocations");
  assert.equal(feed.cursor, await s.repository.latestCursor(s.station.id), "the cursor moves past the Portal's own record");
  const checkpoint = await s.service.changes(s.station.reportClientId, "0", { checkpoint: true });
  assert.deepEqual(checkpoint.checkpoint.integrations.map((entry) => [entry.id, entry.state]), [[ready, "revoking"], [waiting, "revoked"], [theirs, "revoking"]]);
  // Removing it again answers the same and asks Auth nothing.
  assert.deepEqual(await s.service.removeStation(OWNER, s.station.id), answer);
  assert.deepEqual([s.asked("beginStationRemoval"), (await s.events("station_removing")).length], [1, 1]);
});

test("the last final report completes the removal: Auth's complete-removal, the Station removed with nothing pending, and one more push", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const one = await s.integration();
  const two = await s.integration(MEMBER);
  await s.service.removeStation(OWNER, s.station.id);
  s.notified.length = 0;
  // A removing Station reports as an active one does: a host applied the revocation, then the final.
  const applied = await s.service.report(s.station.reportClientId, { integrationId: one, state: "revocation_applied", reportId: "applied-1", host: "laptop", recordId: RECORD });
  assert.equal(applied.state, "revoking");
  assert.equal((await s.final(one)).state, "revoked");
  assert.equal((await s.repository.station(s.station.id)).status, "removing", "one integration is still revoking");
  assert.equal(s.asked("completeStationRemoval"), 0);
  s.clock.now += 1000;
  assert.equal((await s.final(two, { outcome: "deadline_passed", pendingHosts: ["desk"] })).state, "revoked");
  const removed = await s.repository.station(s.station.id);
  assert.deepEqual([removed.status, removed.removedAt], ["removed", iso(s.clock.now)]);
  assert.deepEqual([s.asked("completeStationRemoval"), s.authStation().status, s.authStation().reportClientRevoked], [1, "removed", true]);
  assert.deepEqual([await s.flag(one), await s.flag(two)], [["revoked", false], ["revoked", false]], "each had its final: nothing pending");
  const [done] = await s.events("station_removed");
  assert.deepEqual([done.actor, done.account_id, done.reason, done.details], ["system", OWNER, "removal_completed", { completedBy: "all_revoked", pendingHostRevocation: 0 }]);
  assert.deepEqual(s.notified, [s.station.id], "pushed once more: its token is refused from now on");
  assert.ok(s.logs.includes("Station removal completed: every integration revoked."));
  await assert.rejects(s.service.changes(s.station.reportClientId, "0"), refused(403, "station"));
  await assert.rejects(s.final(one, { reportId: "final-again" }), refused(403, "station"));
});

test("a Station with nothing left to pass on is removed at once: begun and completed in the same call", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const waiting = await s.integration(OWNER, { approved: false });
  s.notified.length = 0;
  assert.deepEqual(await s.service.removeStation(OWNER, s.station.id), { removed: true });
  assert.deepEqual([s.asked("beginStationRemoval"), s.asked("completeStationRemoval"), s.asked("removeStation")], [1, 1, 0]);
  const removed = await s.repository.station(s.station.id);
  assert.deepEqual([removed.status, removed.removalStartedAt, removed.removedAt], ["removed", iso(s.clock.now), iso(s.clock.now)]);
  assert.deepEqual(await s.flag(waiting), ["revoked", false]);
  assert.deepEqual((await s.events("station_removing")).map((event) => event.details), [{ revoking: [] }]);
  assert.deepEqual((await s.events("station_removed")).map((event) => event.details), [{ completedBy: "all_revoked", pendingHostRevocation: 0 }]);
  assert.deepEqual(s.notified, [s.station.id, s.station.id], "pushed at the begin and once more at the end");
  assert.deepEqual((await s.service.stations(OWNER)).stations, []);
});

test("a completion Auth refuses leaves the Station removing and the report answered; the Station's retry of its final completes it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  s.manage.failNext.completeStationRemoval = { status: 503, code: "unavailable" };
  assert.equal((await s.final(id)).state, "revoked", "the report is answered");
  assert.equal((await s.repository.station(s.station.id)).status, "removing");
  assert.ok(s.logs.includes("Station removal not completed: Auth unavailable."));
  assert.deepEqual(await s.events("station_removed"), []);
  // The Station sends the same final again (a lost answer, say): the same answer, and the removal completes.
  assert.equal((await s.final(id)).state, "revoked");
  assert.equal((await s.repository.station(s.station.id)).status, "removed");
  assert.equal(s.asked("completeStationRemoval"), 2);
});

test("while a Station is removing its revoked integrations can still be interrupted; once it is removed, 409 station_removed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const first = await s.integration();
  const second = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  const interrupted = await s.service.interrupt(OWNER, first);
  assert.deepEqual([interrupted.state, interrupted.interruptRunning, Object.hasOwn(interrupted, "stationRemoved")], ["revoking", true, false]);
  const feed = await s.service.changes(s.station.reportClientId, "0");
  assert.deepEqual(feed.changes.filter((change) => change.kind === "integration_interrupt_requested").map((change) => [change.integrationId, change.interruptRunning]), [[first, true]], "the removing Station reads it");
  await s.final(first);
  await s.final(second);
  assert.equal((await s.repository.station(s.station.id)).status, "removed");
  await assert.rejects(s.service.interrupt(OWNER, second), refused(409, "station_removed"));
  assert.equal((await s.service.interrupt(OWNER, first)).interruptRunning, true, "one already interrupted still answers 200");
});

test("an Auth without the two-phase removal (404) gets today's one-step removal: every integration revoked at once, those with an R9 service pending host revocation", async (t) => {
  const s = await setup(t, { authDelegated: false });
  if (!s) return;
  const approved = await s.integration();
  const waiting = await s.integration(OWNER, { approved: false });
  const earlier = await s.integration();
  await s.service.revoke(OWNER, earlier, { interruptRunning: false });
  const done = await s.integration(OWNER, { approved: false });
  await s.service.revoke(OWNER, done, { interruptRunning: false });
  s.notified.length = 0;
  assert.deepEqual(await s.service.removeStation(OWNER, s.station.id), { removed: true });
  assert.deepEqual([s.asked("beginStationRemoval"), s.asked("removeStation")], [1, 1], "asked to begin, then removed in one step");
  const here = await s.repository.station(s.station.id);
  assert.deepEqual([here.status, here.removalStartedAt], ["removed", null]);
  assert.deepEqual([await s.flag(approved), await s.flag(waiting), await s.flag(earlier), await s.flag(done)], [["revoked", true], ["revoked", false], ["revoked", true], ["revoked", false]],
    "revoked at once; flagged where a host may hold it, the one already revoking too");
  const revoked = (await s.events("integration_revoked")).filter((event) => event.reason === "station_removed");
  assert.deepEqual(revoked.map((event) => [event.integration_id, event.state, event.details]), [
    [approved, "revoked", { interruptRunning: false }], [waiting, "revoked", { interruptRunning: false }], [earlier, "revoked", { interruptRunning: false, finalReport: false }]
  ]);
  const [removed] = await s.events("station_removed");
  assert.deepEqual([removed.actor, removed.details], [OWNER, { oneStep: true, pendingHostRevocation: 2 }]);
  assert.deepEqual(await s.events("station_removing"), []);
  assert.deepEqual(s.notified, [s.station.id]);
  assert.ok(s.logs.includes("Station removed in one step: Auth has no two-phase removal; 2 integrations pending host revocation."));
});

test("an Auth that refuses the begin otherwise leaves everything as it was", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.integration();
  const before = (await s.events("integration_revoked")).length;
  s.manage.failNext.beginStationRemoval = { status: 503, code: "unavailable" };
  await assert.rejects(s.service.removeStation(OWNER, s.station.id), refused(503, "unavailable"));
  assert.deepEqual([(await s.repository.station(s.station.id)).status, (await s.row(id)).state, (await s.events("integration_revoked")).length, s.asked("removeStation")], ["active", "provisioning", before, 0]);
});

test("with the setting off, removing a Station is today's one step: Auth's DELETE, its integrations revoking, nothing flagged", async (t) => {
  const s = await setup(t, { delegatedHostWork: false, authDelegated: true });
  if (!s) return;
  const id = await s.integration();
  assert.deepEqual(await s.service.removeStation(OWNER, s.station.id), { removed: true });
  assert.deepEqual([s.asked("beginStationRemoval"), s.asked("removeStation")], [0, 1]);
  assert.equal((await s.repository.station(s.station.id)).status, "removed");
  assert.deepEqual(await s.flag(id), ["revoking", false]);
  assert.deepEqual(await s.events("station_removing"), []);
});

test("reading the Station lists while its removal runs never takes the removing Station for gone: Auth lists it with its status", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  s.notified.length = 0;
  for (const account of [OWNER, MEMBER]) {
    const listed = (await s.service.stations(account)).stations;
    assert.deepEqual(listed.map((entry) => [entry.id, entry.status]), [[s.station.id, "removing"]]);
  }
  assert.deepEqual([(await s.repository.station(s.station.id)).status, (await s.row(id)).state, await s.events("station_removed"), s.notified], ["removing", "revoking", [], []]);
  assert.equal(s.logs.some((line) => line.startsWith("Station removed in Portal")), false);
});
