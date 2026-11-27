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
// on the same database and Auth (`open({ delegatedHostWork: false })`, one with the setting turned off). `wrap` gives each
// service its own view of the repository, to fail a method of it (the raw one stays `repository`).
async function setup(t, { delegatedHostWork = true, authDelegated = delegatedHostWork, wrap = (repository) => repository } = {}) {
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
    repository: wrap(repository), db, manage, stationFetch: { async get() { return { ...served }; } }, exchange: async () => ({}), now: () => clock.now,
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

// A database failure as the driver raises it: a code, and a message that is never logged.
const databaseError = (code) => Object.assign(new Error("secret detail of the failure"), { code });
// A repository whose `method` fails once when `armed.on` is set (the flag clears as it fails).
const failingOnce = (method, armed, code = "57P01") => (repository) => ({
  ...repository,
  async [method](...args) {
    if (armed.on) { armed.on = false; throw databaseError(code); }
    return repository[method](...args);
  }
});

test("a removal already begun is never cut short with the setting off: the owner's repeat asks Auth nothing, and the last report still completes it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.integration();
  const answer = await s.service.removeStation(OWNER, s.station.id);
  const off = s.open({ delegatedHostWork: false });
  s.notified.length = 0;
  assert.deepEqual(await off.removeStation(OWNER, s.station.id), answer);
  assert.deepEqual([s.asked("beginStationRemoval"), s.asked("removeStation"), s.asked("completeStationRemoval")], [1, 0, 0], "Auth's DELETE would revoke the report client mid-removal");
  assert.deepEqual([s.authStation().status, s.authStation().reportClientRevoked], ["removing", undefined]);
  assert.deepEqual([(await s.repository.station(s.station.id)).status, (await s.row(id)).state, s.notified], ["removing", "revoking", []]);
  // The Station's report in the form it sends with the setting off is the last one: the removal completes.
  assert.equal((await off.report(s.station.reportClientId, { integrationId: id, state: "revoked" })).state, "revoked");
  assert.equal((await s.repository.station(s.station.id)).status, "removed");
  assert.deepEqual([s.asked("completeStationRemoval"), s.authStation().status, await s.flag(id)], [1, "removed", ["revoked", false]]);
  assert.ok(s.logs.includes("Station removal completed: every integration revoked."));
});

test("a repeat removal retries a completion that failed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  s.manage.failNext.completeStationRemoval = { status: 503, code: "unavailable" };
  await s.final(id);
  assert.equal((await s.repository.station(s.station.id)).status, "removing");
  assert.deepEqual(await s.service.removeStation(OWNER, s.station.id), { removed: true }, "completed by the repeat");
  assert.deepEqual([(await s.repository.station(s.station.id)).status, s.asked("completeStationRemoval"), s.asked("beginStationRemoval")], ["removed", 2, 1]);
});

test("a final report that commits after a concurrent begin's look at the Station still completes the removal", async (t) => {
  const armed = { run: null };
  const s = await setup(t, {
    wrap: (repository) => ({
      ...repository,
      async stationByReportClient(...args) {
        const found = await repository.stationByReportClient(...args);
        // The removal begins right after this report read the Station, which was still active.
        if (armed.run) { const run = armed.run; armed.run = null; await run(); }
        return found;
      }
    })
  });
  if (!s) return;
  const id = await s.integration();
  armed.run = () => s.service.removeStation(OWNER, s.station.id);
  assert.equal((await s.final(id)).state, "revoked");
  assert.equal((await s.repository.station(s.station.id)).status, "removed", "completed by the report, not left for the hourly check");
  assert.equal(s.asked("completeStationRemoval"), 1);
});

test("Auth's begin succeeds and the Portal's begin transaction fails: the owner's retry begins the removal once on both sides", async (t) => {
  const armed = { on: true };
  const s = await setup(t, { wrap: failingOnce("markStationRemoving", armed) });
  if (!s) return;
  const id = await s.integration();
  await assert.rejects(s.service.removeStation(OWNER, s.station.id), (error) => error.code === "57P01");
  assert.deepEqual([(await s.repository.station(s.station.id)).status, (await s.row(id)).state, s.authStation().status], ["active", "provisioning", "removing"], "Auth has begun it, the Portal has not");
  const startedAt = s.authStation().removalStartedAt;
  s.clock.now += 1000;
  const answer = await s.service.removeStation(OWNER, s.station.id);
  assert.equal(answer.removing, true);
  assert.deepEqual([(await s.repository.station(s.station.id)).status, (await s.row(id)).state, s.asked("beginStationRemoval")], ["removing", "revoking", 2], "Auth's begin is idempotent");
  assert.deepEqual([s.authStation().removalStartedAt, s.manage.feed.filter((entry) => entry.kind === "revoked").length], [startedAt, 1], "Auth revoked it once");
  assert.deepEqual([(await s.events("station_removing")).length, (await s.events("integration_revoked")).length], [1, 1], "the Portal began it once");
});

test("the Portal's completion transaction fails: the report is still answered and logged, and a later retry completes the removal", async (t) => {
  const armed = { on: false };
  const s = await setup(t, { wrap: failingOnce("markStationRemoved", armed, "40001") });
  if (!s) return;
  const id = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  armed.on = true;
  assert.equal((await s.final(id)).state, "revoked", "the report is answered");
  assert.ok(s.logs.includes("Station removal not completed: 40001."));
  assert.equal(s.logs.some((line) => line.includes("secret detail")), false, "only the code is logged");
  assert.deepEqual([(await s.repository.station(s.station.id)).status, await s.events("station_removed"), s.authStation().status], ["removing", [], "removed"], "Auth completed, the Portal has not");
  assert.equal((await s.final(id)).state, "revoked", "the Station's retry of the same final");
  assert.deepEqual([(await s.repository.station(s.station.id)).status, (await s.events("station_removed")).length, s.asked("completeStationRemoval")], ["removed", 1, 2]);
});

test("the one-step removal retried after its Portal half failed converges: Auth's 404 means it is removed already", async (t) => {
  const armed = { on: true };
  const s = await setup(t, { authDelegated: false, wrap: failingOnce("markStationRemoved", armed) });
  if (!s) return;
  const id = await s.integration();
  await assert.rejects(s.service.removeStation(OWNER, s.station.id), (error) => error.code === "57P01");
  assert.deepEqual([(await s.repository.station(s.station.id)).status, s.authStation().status, await s.flag(id)], ["active", "removed", ["provisioning", false]]);
  s.notified.length = 0;
  assert.deepEqual(await s.service.removeStation(OWNER, s.station.id), { removed: true });
  assert.deepEqual([(await s.repository.station(s.station.id)).status, await s.flag(id), s.asked("removeStation")], ["removed", ["revoked", true], 2]);
  assert.deepEqual([(await s.events("station_removed")).length, s.notified], [1, [s.station.id]]);
});

test("a Station removed by another path while the one-step removal ran gets no second event, log line or push", async (t) => {
  const armed = { on: true };
  const s = await setup(t, {
    authDelegated: false,
    wrap: (repository) => ({
      ...repository,
      async markStationRemoved(id, at, client) {
        // The other path removes it first, outside this call's transaction.
        if (armed.on) { armed.on = false; await repository.markStationRemoved(id, at); }
        return repository.markStationRemoved(id, at, client);
      }
    })
  });
  if (!s) return;
  await s.integration();
  s.notified.length = 0;
  assert.deepEqual(await s.service.removeStation(OWNER, s.station.id), { removed: true });
  assert.deepEqual([await s.events("station_removed"), s.notified, s.logs.some((line) => line.startsWith("Station removed in one step"))], [[], [], false]);
});

test("26 hours after the removal began the hourly check completes it: the integrations still revoking are revoked, those with an R9 service flagged, and the Station pushed once more", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const done = await s.integration();
  const silent = await s.integration(MEMBER);
  const paused = await s.integration(OWNER, { approved: false });
  await s.service.pause(OWNER, paused);
  await s.service.removeStation(OWNER, s.station.id);
  assert.equal((await s.row(paused)).state, "revoking", "paused before approval: revoking, with no R9 service");
  await s.final(done);
  s.clock.now += 26 * HOUR - 1;
  assert.equal(await s.service.completeRemovals(), 0, "not yet: 26 hours less a millisecond");
  assert.equal((await s.repository.station(s.station.id)).status, "removing");
  s.clock.now += 1;
  s.notified.length = 0;
  assert.equal(await s.service.completeRemovals(), 1);
  const removed = await s.repository.station(s.station.id);
  assert.deepEqual([removed.status, removed.removedAt], ["removed", iso(s.clock.now)]);
  assert.deepEqual([s.authStation().status, s.authStation().reportClientRevoked], ["removed", true]);
  assert.deepEqual([await s.flag(done), await s.flag(silent), await s.flag(paused)], [["revoked", false], ["revoked", true], ["revoked", false]],
    "the one with its final: nothing pending; the silent one: pending; the one never approved has no R9 service, so no host holds it");
  const [completed] = await s.events("station_removed");
  assert.deepEqual([completed.actor, completed.reason, completed.details], ["system", "removal_completed", { completedBy: "deadline", pendingHostRevocation: 1 }]);
  const ended = (await s.events("integration_revoked")).filter((event) => event.details.finalReport === false);
  assert.deepEqual(ended.map((event) => [event.integration_id, event.actor, event.reason, event.state]), [[silent, "system", "station_removed", "revoked"], [paused, "system", "station_removed", "revoked"]]);
  assert.deepEqual(s.notified, [s.station.id]);
  assert.ok(s.logs.includes("Station removal completed after 26 hours: 1 integration pending host revocation."));
  assert.equal(await s.service.completeRemovals(), 0, "nothing more to do");
});

test("two replicas completing the same removal at once complete it once: one station_removed, each integration revoked and flagged once, one more push", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  s.clock.now += 26 * HOUR;
  const replica = s.open();
  s.notified.length = 0;
  // The event lock is held meanwhile, so both have found the Station removing and had Auth's answer before either commits.
  const holder = await s.db.pool.connect();
  let counts;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'))");
    const running = Promise.all([s.service.completeRemovals(), replica.completeRemovals()]);
    const until = Date.now() + 5000;
    while (s.asked("completeStationRemoval") < 2) {
      if (Date.now() > until) throw new Error("both replicas should have asked Auth");
      await new Promise((done) => setTimeout(done, 5));
    }
    await holder.query("COMMIT");
    counts = await running;
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
  assert.deepEqual(counts.sort(), [0, 1], "one of them completed it");
  assert.equal((await s.events("station_removed")).length, 1);
  assert.deepEqual(await s.flag(id), ["revoked", true]);
  assert.equal((await s.events("integration_revoked")).filter((event) => event.details.finalReport === false).length, 1);
  assert.deepEqual(s.notified, [s.station.id], "pushed once more, once");
  assert.equal(s.asked("completeStationRemoval"), 2, "each asked Auth, which answers 204 again for a removed Station");
});

test("the hourly check leaves a Station removing while Auth refuses to complete it, and completes it once Auth accepts", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  s.clock.now += 27 * HOUR;
  s.manage.failNext.completeStationRemoval = { status: 503, code: "unavailable" };
  assert.equal(await s.service.completeRemovals(), 0);
  assert.equal((await s.repository.station(s.station.id)).status, "removing");
  assert.ok(s.logs.includes("Station removal not completed: Auth unavailable."));
  assert.equal(await s.service.completeRemovals(), 1);
  assert.equal((await s.repository.station(s.station.id)).status, "removed");
});

test("an Auth whose setting was turned off while a Station was removing (404) completes it with its one-step DELETE, named as the owner", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  s.clock.now += 26 * HOUR;
  s.manage.failNext.completeStationRemoval = { status: 404, code: "not_found" };
  assert.equal(await s.service.completeRemovals(), 1);
  assert.deepEqual([s.asked("completeStationRemoval"), s.asked("removeStation"), s.authStation().status], [1, 1, "removed"]);
  assert.deepEqual([(await s.repository.station(s.station.id)).status, ...await s.flag(id)], ["removed", "revoked", true]);
});

test("a removal Auth began that the Portal missed is followed by the next listing: removing, its integrations revoked, as the system; never with the setting off", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.integration();
  // Auth began it, but the owner's request failed before the Portal wrote anything.
  await s.manage.beginStationRemoval(s.station.id, OWNER);
  s.notified.length = 0;
  await s.service.stations(OWNER);
  const here = await s.repository.station(s.station.id);
  assert.deepEqual([here.status, here.removalStartedAt], ["removing", iso(s.clock.now)]);
  assert.equal((await s.row(id)).state, "revoking");
  const [begun] = await s.events("station_removing");
  assert.deepEqual([begun.actor, begun.details], ["system", { revoking: [id] }]);
  assert.deepEqual(s.notified, [s.station.id]);
  assert.ok(s.logs.includes("Station removal begun in Portal: Auth has it removing."));
  await s.service.stations(MEMBER);
  assert.equal((await s.events("station_removing")).length, 1, "once");

  const off = await setup(t, { delegatedHostWork: false, authDelegated: true });
  await off.manage.beginStationRemoval(off.station.id, OWNER);
  await off.service.stations(OWNER);
  assert.equal((await off.repository.station(off.station.id)).status, "active", "with the setting off the Portal leaves it as today");
});

test("a Station Auth no longer lists, or whose origin another Station took, is gone without the two phases: everything revoked at once, only integrations with an R9 service flagged", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const approved = await s.integration();
  const waiting = await s.integration(OWNER, { approved: false });
  const revoking = await s.integration();
  await s.service.revoke(OWNER, revoking, { interruptRunning: false });
  const finished = await s.integration();
  await s.service.revoke(OWNER, finished, { interruptRunning: false });
  await s.final(finished);
  s.authStation().status = "removed";
  await s.service.stations(OWNER);
  assert.equal((await s.repository.station(s.station.id)).status, "removed");
  assert.deepEqual([await s.flag(approved), await s.flag(waiting), await s.flag(revoking), await s.flag(finished)], [["revoked", true], ["revoked", false], ["revoked", true], ["revoked", false]],
    "a live one and one still revoking are flagged; one never approved, or revoked with its final, is not");
  assert.deepEqual((await s.events("station_removed")).map((event) => [event.actor, event.reason]), [["system", "reconciled"]]);
  // Another account's Station registered at the origin of one Auth has removed behind the Portal's back retires it.
  const second = await s.register(OWNER, "https://two.example");
  const there = await s.integration(OWNER, { stationId: second.id });
  const unapproved = await s.integration(OWNER, { stationId: second.id, approved: false });
  s.authStation(second.id).status = "removed";
  const successor = await s.register(STRANGER, "https://two.example");
  assert.deepEqual([(await s.repository.station(second.id)).status, (await s.repository.station(successor.id)).status], ["removed", "active"]);
  assert.deepEqual([await s.flag(there), await s.flag(unapproved)], [["revoked", true], ["revoked", false]]);
  assert.ok(s.logs.includes("Station removed in Portal: its origin belongs to another Station at Auth."));
});

test("with the setting off, a Station Auth no longer lists is removed as today: one revoking stays revoking, nothing is flagged", async (t) => {
  const s = await setup(t, { delegatedHostWork: false, authDelegated: false });
  if (!s) return;
  const approved = await s.integration();
  const revoking = await s.integration();
  await s.service.revoke(OWNER, revoking);
  s.authStation().status = "removed";
  await s.service.stations(OWNER);
  assert.deepEqual([await s.flag(approved), await s.flag(revoking)], [["revoked", false], ["revoking", false]]);
  assert.equal(await s.service.completeRemovals(), 0, "nothing to complete");
});

test("with the Portal's setting turned off meanwhile, the removals it began still complete: after a legacy final report, and at the hourly check", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const reported = await s.integration();
  const second = await s.register(OWNER, "https://two.example");
  const silent = await s.integration(OWNER, { stationId: second.id });
  await s.service.removeStation(OWNER, s.station.id);
  await s.service.removeStation(OWNER, second.id);
  const off = s.open({ delegatedHostWork: false });
  // With the setting off a report with a reportId is 400; the legacy revoked report ends the revocation, and the removal.
  assert.equal((await off.report(s.station.reportClientId, { integrationId: reported, state: "revoked" })).state, "revoked");
  assert.equal((await s.repository.station(s.station.id)).status, "removed");
  assert.deepEqual(await s.flag(reported), ["revoked", false]);
  s.clock.now += 26 * HOUR;
  assert.equal(await off.completeRemovals(), 1);
  assert.equal((await s.repository.station(second.id)).status, "removed");
  assert.deepEqual(await s.flag(silent), ["revoked", true], "flagged in the Portal's record; shown once the setting is on again");
  assert.equal(Object.hasOwn((await off.integrations(OWNER)).integrations.find((entry) => entry.id === silent), "pendingHostRevocation"), false, "with the setting off no view shows it");
});

test("a removal completes 26 hours after it began without the Station reporting, also when the owner's account is disabled meanwhile", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  // Auth refuses the owner as actor now, and issues the Station's report client no token: it can report nothing.
  s.manage.setOwnerDisabled(OWNER, true);
  s.clock.now += 26 * HOUR;
  assert.equal(await s.service.completeRemovals(), 1, "completed as the system");
  assert.deepEqual([(await s.repository.station(s.station.id)).status, s.authStation().status, ...await s.flag(id)], ["removed", "removed", "revoked", true]);
});

test("an integration still live on a removing Station (one Auth created at the instant of the begin) holds the removal to the 26 hours, and the completion revokes it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const revoking = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  // The owner's listing brings in an integration Auth created as the removal began: it is live in the Portal.
  await s.repository.insertIntegration({ id: "i-late", ownerAccount: OWNER, stationId: s.station.id, kind: "custom_app", name: "Late", scopes: ["agent.view"], quotaPerSecond: 200, expiresAt: s.clock.now + 30 * 24 * HOUR });
  await s.repository.updateIntegration("i-late", { state: "provisioning", r9Svc: R9 });
  await s.final(revoking);
  assert.equal((await s.repository.station(s.station.id)).status, "removing", "the live one is not revoked yet");
  s.clock.now += 26 * HOUR;
  assert.equal(await s.service.completeRemovals(), 1);
  assert.deepEqual([(await s.repository.station(s.station.id)).status, ...await s.flag("i-late"), ...await s.flag(revoking)], ["removed", "revoked", true, "revoked", false]);
});

test("a removing Station Auth no longer lists (it completed the removal, the Portal's half failed) is completed by the owner's next listing: flagged where a host may hold it, one station_removed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const silent = await s.integration();
  const never = await s.integration(OWNER, { approved: false });
  const done = await s.integration(MEMBER);
  await s.service.removeStation(OWNER, s.station.id);
  await s.final(done);
  s.authStation().status = "removed";
  s.notified.length = 0;
  await s.service.stations(OWNER);
  const removed = await s.repository.station(s.station.id);
  assert.deepEqual([removed.status, removed.removedAt], ["removed", iso(s.clock.now)]);
  assert.deepEqual([await s.flag(silent), await s.flag(never), await s.flag(done)], [["revoked", true], ["revoked", false], ["revoked", false]], "the one still revoking is flagged, the one with its final is not");
  assert.deepEqual((await s.events("station_removed")).map((event) => [event.actor, event.reason, event.details]), [["system", "removal_completed", { completedBy: "auth_removed", pendingHostRevocation: 1 }]], "the removal completed, not a Station reconciled away");
  assert.equal(s.asked("completeStationRemoval"), 0, "Auth has it removed: nothing to ask");
  assert.deepEqual(s.notified, [s.station.id]);
  assert.ok(s.logs.includes("Station removal completed: Auth has it removed; 1 integration pending host revocation."));
  await s.service.stations(OWNER);
  assert.deepEqual([(await s.events("station_removed")).length, await s.service.completeRemovals()], [1, 0], "once");
});

test("a removing Station Auth no longer lists is completed with the setting off too, and the hourly check finds nothing left", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const silent = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  s.authStation().status = "removed";
  const off = s.open({ delegatedHostWork: false });
  await off.stations(OWNER);
  assert.equal((await s.repository.station(s.station.id)).status, "removed");
  assert.deepEqual(await s.flag(silent), ["revoked", true], "flagged in the Portal's record, shown once the setting is on again");
  assert.deepEqual((await s.events("station_removed")).map((event) => event.reason), ["removal_completed"]);
  assert.equal(await off.completeRemovals(), 0);
});

test("a member's listing without a Station the Portal has removing never records member_removed: the owner's listing completes the removal", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const theirs = await s.integration(MEMBER);
  await s.service.removeStation(OWNER, s.station.id);
  s.authStation().status = "removed";
  s.notified.length = 0;
  // Auth would also leave it out of a member's listing if the member had left just before the removal began: the member's
  // listing cannot say which, so it changes nothing.
  await s.service.stations(MEMBER);
  assert.deepEqual(await s.events("member_removed"), [], "the Station is going, not the member");
  assert.deepEqual([(await s.repository.station(s.station.id)).status, await s.flag(theirs), s.notified], ["removing", ["revoking", false], []]);
  assert.equal((await s.repository.currentMembers(s.station.id)).some((member) => member.accountId === MEMBER), true);
  await s.service.stations(OWNER);
  assert.deepEqual([(await s.repository.station(s.station.id)).status, await s.flag(theirs)], ["removed", ["revoked", true]]);
  assert.deepEqual([(await s.events("member_removed")).length, (await s.events("station_removed")).length], [0, 1]);
});

test("a removing Station whose origin another Station took at Auth is retired as gone: its revoking integrations flagged, no second event for the removal", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const silent = await s.integration();
  await s.service.removeStation(OWNER, s.station.id);
  s.authStation().status = "removed";
  const successor = await s.register(STRANGER, "https://one.example");
  assert.deepEqual([(await s.repository.station(s.station.id)).status, (await s.repository.station(successor.id)).status], ["removed", "active"]);
  assert.deepEqual(await s.flag(silent), ["revoked", true]);
  assert.deepEqual((await s.events("station_removed")).map((event) => [event.actor, event.reason]), [["system", "reconciled"]]);
  await s.service.stations(OWNER);
  assert.equal((await s.events("station_removed")).length, 1, "the owner's listing finds it removed already");
});

test("two listings finding the same Station gone record it removed once", async (t) => {
  // Both listings read the account's Stations before either commits, so each finds the Station active and absent from Auth.
  const barrier = { on: false, reads: 0, release: null, open: null };
  barrier.open = new Promise((release) => { barrier.release = release; });
  const s = await setup(t, {
    wrap: (repository) => ({
      ...repository,
      async stationsFor(...args) {
        const found = await repository.stationsFor(...args);
        if (barrier.on && ++barrier.reads === 2) barrier.release();
        if (barrier.on) await barrier.open;
        return found;
      }
    })
  });
  if (!s) return;
  const id = await s.integration();
  s.authStation().status = "removed";
  s.notified.length = 0;
  barrier.on = true;
  await Promise.all([s.service.stations(OWNER), s.open().stations(OWNER)]);
  barrier.on = false;
  assert.deepEqual([(await s.events("station_removed")).length, await s.flag(id), s.notified], [1, ["revoked", true], [s.station.id]]);
});

test("the hourly check never throws: a database failure reading the removing Stations is logged by its code, and one Station's failed completion leaves the others to complete", async (t) => {
  const armed = { on: true };
  const s = await setup(t, { wrap: failingOnce("removingStations", armed) });
  if (!s) return;
  const first = await s.integration();
  const second = await s.register(OWNER, "https://two.example");
  const other = await s.integration(OWNER, { stationId: second.id });
  await s.service.removeStation(OWNER, s.station.id);
  await s.service.removeStation(OWNER, second.id);
  s.clock.now += 26 * HOUR;
  assert.equal(await s.service.completeRemovals(), 0);
  assert.ok(s.logs.includes("Station removals not checked: 57P01."));
  assert.equal(s.logs.some((line) => line.includes("secret detail")), false, "only the code is logged");
  assert.deepEqual([(await s.repository.station(s.station.id)).status, (await s.repository.station(second.id)).status], ["removing", "removing"]);
  // Auth refuses the first Station's completion: the second is still completed.
  s.manage.failNext.completeStationRemoval = { status: 503, code: "unavailable" };
  assert.equal(await s.service.completeRemovals(), 1);
  assert.deepEqual([(await s.repository.station(s.station.id)).status, (await s.repository.station(second.id)).status], ["removing", "removed"]);
  assert.equal(await s.service.completeRemovals(), 1, "the first is completed by the next check");
  assert.deepEqual([await s.flag(first), await s.flag(other)], [["revoked", true], ["revoked", true]]);
});
