import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { ProofError } from "../scripts/integrations/proof.mjs";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { createIntegrationService } from "../scripts/integrations/service.mjs";
import { AppError } from "../scripts/store.mjs";
import { fakeManage } from "./helpers/fake-manage.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const OWNER = "ab" + "0".repeat(25) + "1";
const MEMBER = "ab" + "0".repeat(25) + "2";
const OTHER = "ab" + "0".repeat(25) + "3";
const R9 = "a".repeat(64);
const DAY = 86400000;

const publicJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });

// A push transport that records each post; `hold()` makes the next post wait until its release is called.
function fakePush() {
  const push = {
    posts: [],
    answer: async () => ({ status: 202 }),
    held: null,
    hold() {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      push.held = gate;
      return () => release();
    },
    async post(url, body) {
      push.posts.push({ url, body });
      if (push.held) {
        const gate = push.held;
        push.held = null;
        await gate;
      }
      return push.answer();
    }
  };
  return push;
}

async function setup(t, { delegatedHostWork = false } = {}) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const clock = { now: Date.now() };
  const manage = fakeManage({ now: () => clock.now, delegated: delegatedHostWork });
  const served = { status: 200, body: "" };
  const stationFetch = { async get() { return { ...served }; } };
  const pushFetch = fakePush();
  const logged = [];
  let counter = 0;
  const service = createIntegrationService({
    repository, db, manage, stationFetch, pushFetch, exchange: async () => ({}), now: () => clock.now, log: (line) => logged.push(line),
    challengeValue: () => "proof-value-" + (++counter), delegatedHostWork
  });
  async function register(accountId = OWNER, origin = "https://one.example") {
    const challenge = await service.createChallenge(accountId, origin);
    served.body = challenge.value;
    return service.registerStation(accountId, { challengeId: challenge.challengeId, reportKey: publicJwk() });
  }
  const station = await register();
  const create = async (accountId = OWNER, stationId = station.id) => {
    const view = await service.createIntegration(accountId, { stationId, name: "My app", scopes: [], publicJwk: publicJwk() });
    return view.id;
  };
  const approved = async (accountId = OWNER, stationId = station.id) => {
    const id = await create(accountId, stationId);
    await service.approve(accountId, id, { r9Svc: R9 });
    return id;
  };
  const reports = async (id) => (await db.pool.query("SELECT * FROM integration_events WHERE integration_id = $1 AND kind = 'integration_reported' ORDER BY id", [id])).rows;
  return { db, repository, manage, clock, service, station, register, create, approved, reports, pushFetch, logged };
}

const refused = (status, code) => (error) => {
  assert.ok(error instanceof AppError, "an AppError, not " + error);
  assert.equal(error.status, status);
  if (code !== undefined) assert.equal(error.details?.code, code);
  return true;
};

test("report refuses an unknown or removed Station's client and integrations of other Stations", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.approved();
  await assert.rejects(s.service.report("s-unknown", { integrationId: id, state: "ready" }), (error) => refused(403, "station")(error) && error.message === "This Station is not registered.");
  const other = await s.register(OTHER, "https://two.example");
  const theirs = await s.approved(OTHER, other.id);
  await assert.rejects(s.service.report(s.station.reportClientId, { integrationId: theirs, state: "ready" }), refused(404, "not_found"));
  await assert.rejects(s.service.report(s.station.reportClientId, { integrationId: "i-missing", state: "ready" }), refused(404, "not_found"));
  await assert.rejects(s.service.report(s.station.reportClientId, { integrationId: 7, state: "ready" }), refused(404, "not_found"));
  assert.equal((await s.repository.integration(theirs)).state, "provisioning");
  await s.service.removeStation(OTHER, other.id);
  await assert.rejects(s.service.report(other.reportClientId, { integrationId: theirs, state: "revoked" }), refused(403, "station"));
});

test("report validates its body", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.approved();
  const client = s.station.reportClientId;
  await assert.rejects(s.service.report(client, { integrationId: id, state: "ready", extra: 1 }), refused(400));
  await assert.rejects(s.service.report(client, null), refused(400));
  for (const state of ["provisioning", "paused", "awaiting_approval", "", undefined, 3]) {
    await assert.rejects(s.service.report(client, { integrationId: id, state }), refused(400, "state"), JSON.stringify(state));
  }
  for (const reason of [undefined, "", "x".repeat(201), "line\nbreak", "bell\u0007", "del\u007f", 5]) {
    await assert.rejects(s.service.report(client, { integrationId: id, state: "error", reason }), refused(400, "reason"), JSON.stringify(reason));
  }
  await assert.rejects(s.service.report(client, { integrationId: id, state: "ready", reason: "tab\there" }), refused(400, "reason"));
  assert.equal((await s.reports(id)).length, 0);
});

test("provisioning becomes waiting_for_host then ready; repeats are no-ops; Portal never jumps approval", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const client = s.station.reportClientId;
  const pending = await s.create();
  await assert.rejects(s.service.report(client, { integrationId: pending, state: "ready" }), refused(409, "invalid_state"));
  await assert.rejects(s.service.report(client, { integrationId: pending, state: "waiting_for_host" }), refused(409, "invalid_state"));
  const id = await s.approved();
  const waiting = await s.service.report(client, { integrationId: id, state: "waiting_for_host", reason: "host offline" });
  assert.equal(waiting.state, "waiting_for_host");
  assert.equal(Object.hasOwn(waiting, "role"), false);
  assert.deepEqual([waiting.id, waiting.stationId, waiting.stationOrigin], [id, s.station.id, "https://one.example"]);
  const ready = await s.service.report(client, { integrationId: id, state: "ready" });
  assert.equal(ready.state, "ready");
  const again = await s.service.report(client, { integrationId: id, state: "ready" });
  assert.equal(again.state, "ready");
  const events = await s.reports(id);
  assert.deepEqual(events.map((event) => [event.actor, event.account_id, event.state, event.reason]), [
    ["station", OWNER, "waiting_for_host", "host offline"],
    ["station", OWNER, "ready", null]
  ]);
});

test("a report while paused updates pausedFrom and resuming lands there", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await s.approved();
  await s.service.pause(OWNER, id);
  const view = await s.service.report(client, { integrationId: id, state: "ready" });
  assert.deepEqual([view.state, view.pausedFrom], ["paused", "ready"]);
  await s.service.report(client, { integrationId: id, state: "ready" });
  assert.equal((await s.reports(id)).length, 1, "repeating the paused-from state is a no-op");
  await assert.rejects(s.service.report(client, { integrationId: id, state: "revoked" }), refused(409, "invalid_state"));
  assert.equal((await s.service.resume(OWNER, id)).state, "ready");
});

test("error sets lastError without a state change; the next transition clears it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await s.approved();
  const failed = await s.service.report(client, { integrationId: id, state: "error", reason: "R9 host unreachable" });
  assert.deepEqual([failed.state, failed.lastError], ["provisioning", "R9 host unreachable"]);
  await s.service.report(client, { integrationId: id, state: "error", reason: "R9 host unreachable" });
  assert.equal((await s.reports(id)).length, 1, "the same error again is a no-op");
  const ready = await s.service.report(client, { integrationId: id, state: "ready" });
  assert.deepEqual([ready.state, ready.lastError], ["ready", null]);
  const [event] = await s.reports(id);
  assert.deepEqual([event.state, event.reason], ["provisioning", "R9 host unreachable"]);
});

test("revoked is accepted from revoking; an error about a revoked integration is refused", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await s.approved();
  await assert.rejects(s.service.report(client, { integrationId: id, state: "revoked" }), refused(409, "invalid_state"));
  await s.service.revoke(OWNER, id);
  const revoked = await s.service.report(client, { integrationId: id, state: "revoked" });
  assert.equal(revoked.state, "revoked");
  await s.service.report(client, { integrationId: id, state: "revoked" });
  assert.equal((await s.reports(id)).length, 1);
  await assert.rejects(s.service.report(client, { integrationId: id, state: "error", reason: "late" }), refused(409, "invalid_state"));
  await assert.rejects(s.service.report(client, { integrationId: id, state: "ready" }), refused(409, "invalid_state"));
});

test("the feed lists only this Station's changes with current snapshots, and a fresh start gets every integration", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const client = s.station.reportClientId;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const mine = await s.approved();
  const theirs = await s.create(MEMBER);
  await s.service.report(client, { integrationId: mine, state: "ready" });
  const other = await s.register(OTHER, "https://two.example");
  await s.approved(OTHER, other.id);
  await s.service.unshare(OWNER, s.station.id, MEMBER);

  const feed = await s.service.changes(client, 0);
  assert.deepEqual(feed.changes.map((change) => [change.kind, change.integrationId]), [
    ["station_registered", null], ["member_added", null], ["integration_created", mine], ["integration_approved", mine],
    ["integration_created", theirs], ["integration_reported", mine], ["integration_revoked", theirs], ["member_removed", null]
  ]);
  assert.equal(feed.cursor, feed.changes.at(-1).id);
  const approvedChange = feed.changes[3];
  assert.deepEqual(Object.keys(approvedChange).sort(), ["at", "id", "integration", "integrationId", "kind", "reason", "state"]);
  assert.equal(approvedChange.state, "provisioning");
  const row = await s.repository.integration(mine);
  assert.deepEqual(approvedChange.integration, { ownerAccount: OWNER, state: "ready", scopes: ["agent.view"], r9Svc: R9, expiresAt: row.expiresAt, quotaPerSecond: 200 });
  assert.equal(Object.hasOwn(feed.changes[0], "integration"), false);
  assert.deepEqual(feed.integrations, [
    { id: mine, ownerAccount: OWNER, state: "ready", scopes: ["agent.view"], r9Svc: R9, expiresAt: row.expiresAt, quotaPerSecond: 200 },
    { id: theirs, ownerAccount: MEMBER, state: "revoked", scopes: ["agent.view"], r9Svc: null, expiresAt: (await s.repository.integration(theirs)).expiresAt, quotaPerSecond: 200 }
  ]);

  const later = await s.service.changes(client, String(feed.cursor));
  assert.deepEqual([later.changes, later.cursor, Object.hasOwn(later, "integrations")], [[], feed.cursor, false]);
  const middle = await s.service.changes(client, feed.changes[4].id);
  assert.deepEqual(middle.changes.map((change) => change.kind), ["integration_reported", "integration_revoked", "member_removed"]);

  s.clock.now += 31 * DAY;
  const expired = await s.service.changes(client, 0);
  assert.equal(expired.integrations[0].state, "expired");
  assert.equal(expired.changes[3].integration.state, "expired");
  await assert.rejects(s.service.changes("s-unknown", 0), refused(403, "station"));
});

test("the feed pages by 500 and refuses a bad cursor", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const client = s.station.reportClientId;
  await s.db.transaction(async (db) => {
    for (let index = 0; index < 501; index += 1) await s.repository.appendEvent({ stationId: s.station.id, accountId: OWNER, actor: "system", kind: "filler" }, db);
  });
  const first = await s.service.changes(client, 0);
  assert.equal(first.changes.length, 500);
  assert.equal(first.cursor, first.changes.at(-1).id);
  const second = await s.service.changes(client, first.cursor);
  assert.equal(second.changes.length, 2);
  assert.equal(second.cursor, await s.repository.latestCursor(s.station.id));
  for (const cursor of [-1, 1.5, "abc", "-1", "1e3", "1".repeat(16), "", null, undefined, Number.MAX_SAFE_INTEGER + 1, " 1"]) {
    await assert.rejects(s.service.changes(client, cursor), refused(400, "cursor"), JSON.stringify(cursor));
  }
});

test("a cursor ahead of this Station's history (a restored Portal database) is 409 cursor_ahead; cursor 0 recovers", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await s.approved();
  const latest = await s.repository.latestCursor(s.station.id);
  assert.ok(latest > 0);
  await assert.rejects(s.service.changes(client, latest + 1), refused(409, "cursor_ahead"));
  await assert.rejects(s.service.changes(client, String(latest + 1000)), refused(409, "cursor_ahead"));
  // The latest cursor itself is fine, and so is a cursor with gaps left by other Stations' events.
  assert.deepEqual((await s.service.changes(client, latest)).changes, []);
  const other = await s.register(OTHER, "https://two.example");
  await s.approved(OTHER, other.id);
  assert.ok((await s.repository.latestCursor(other.id)) > latest, "event ids are global");
  assert.deepEqual((await s.service.changes(client, latest)).changes, []);
  await assert.rejects(s.service.changes(client, await s.repository.latestCursor(other.id)), refused(409, "cursor_ahead"), "another Station's cursor is ahead of this Station's history");
  // Starting again from 0 gives the current snapshot, owners included.
  const fresh = await s.service.changes(client, 0);
  assert.deepEqual(fresh.integrations.map((entry) => [entry.id, entry.ownerAccount]), [[id, OWNER]]);
  assert.equal(fresh.cursor, latest);
});

test("notify posts the latest cursor to the Station and coalesces rapid calls", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service._pushesIdle();
  s.pushFetch.posts.length = 0;
  const release = s.pushFetch.hold();
  s.service.notify(s.station.id);
  s.service.notify(s.station.id);
  s.service.notify(s.station.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.pushFetch.posts.length, 1, "one push in flight");
  const id = await s.create();
  release();
  await s.service._pushesIdle();
  const latest = await s.repository.latestCursor(s.station.id);
  assert.equal(s.pushFetch.posts.length, 2);
  assert.deepEqual(s.pushFetch.posts.at(-1), { url: "https://one.example/agora-build/v1/changes", body: { cursor: latest } });
  s.pushFetch.posts.length = 0;
  const hold = s.pushFetch.hold();
  s.service.notify(s.station.id);
  s.service.notify(s.station.id);
  s.service.notify(s.station.id);
  hold();
  await s.service._pushesIdle();
  assert.equal(s.pushFetch.posts.length, 2, "three rapid calls make at most two posts");
  await s.service.approve(OWNER, id, { r9Svc: R9 });
  await s.service._pushesIdle();
  assert.deepEqual(s.pushFetch.posts.at(-1).body, { cursor: await s.repository.latestCursor(s.station.id) });
  assert.deepEqual(s.logged.filter((line) => line.startsWith("Station change push")), []);
});

test("a failing push is logged by reason and never throws", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.create();
  await s.service._pushesIdle();
  s.logged.length = 0;
  s.pushFetch.answer = async () => { throw new ProofError("blocked_address"); };
  assert.equal((await s.service.approve(OWNER, id, { r9Svc: R9 })).state, "provisioning");
  await s.service._pushesIdle();
  s.pushFetch.answer = async () => ({ status: 500 });
  s.service.notify(s.station.id);
  await s.service._pushesIdle();
  s.pushFetch.answer = async () => { throw new Error("boom"); };
  assert.equal(s.service.notify(s.station.id), undefined);
  await s.service._pushesIdle();
  s.service.notify("st-unknown");
  await s.service._pushesIdle();
  assert.deepEqual(s.logged, [
    "Station change push failed: blocked_address.",
    "Station change push failed: status_500.",
    "Station change push failed: error."
  ]);
});

test("a report is not pushed back to its Station; sharing and removal are, a removed Station once", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.approved();
  await s.service._pushesIdle();
  s.pushFetch.posts.length = 0;
  await s.service.report(s.station.reportClientId, { integrationId: id, state: "ready" });
  await s.service.report(s.station.reportClientId, { integrationId: id, state: "error", reason: "R9 host unreachable" });
  await s.service._pushesIdle();
  assert.deepEqual(s.pushFetch.posts, []);
  await s.service.share(OWNER, s.station.id, MEMBER);
  await s.service._pushesIdle();
  await s.service.unshare(OWNER, s.station.id, MEMBER);
  await s.service._pushesIdle();
  await s.service.removeStation(OWNER, s.station.id);
  await s.service._pushesIdle();
  const url = "https://one.example/agora-build/v1/changes";
  assert.equal(s.pushFetch.posts.length, 3);
  assert.ok(s.pushFetch.posts.every((post) => post.url === url));
  assert.deepEqual(s.pushFetch.posts.at(-1).body, { cursor: await s.repository.latestCursor(s.station.id) });
  assert.equal((await s.repository.integration(id)).state, "revoking");
});

// D29: the Station's feed says whether a revocation interrupts running tasks (the setting on: delegatedHostWork).
test("with the setting on, a revoked change and a stopped integration's feed entries carry interruptRunning; others do not", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const interrupted = await s.approved();
  const kept = await s.approved();
  const live = await s.approved();
  const removed = await s.create(MEMBER);
  const before = await s.create();
  await s.service.revoke(OWNER, interrupted, { interruptRunning: true });
  await s.service.revoke(OWNER, kept, { interruptRunning: false });
  await s.service.unshare(OWNER, s.station.id, MEMBER);
  // A revocation recorded before the setting has no choice recorded, which means "don't interrupt".
  await s.db.transaction((db) => s.repository.appendEvent({ stationId: s.station.id, integrationId: before, accountId: OWNER, actor: OWNER, kind: "integration_revoked", state: "revoked", reason: "owner" }, db));
  await s.repository.updateIntegration(before, { state: "revoked", revokedAt: s.clock.now });

  const feed = await s.service.changes(client, 0);
  const revoked = feed.changes.filter((change) => change.kind === "integration_revoked");
  assert.deepEqual(revoked.map((change) => [change.integrationId, change.interruptRunning]), [[interrupted, true], [kept, false], [removed, false], [before, false]]);
  assert.deepEqual(revoked.map((change) => change.integration.interruptRunning), [true, false, false, false], "each carries the integration's own");
  const snapshot = Object.fromEntries(feed.integrations.map((entry) => [entry.id, entry]));
  assert.deepEqual([interrupted, kept, removed, before].map((id) => snapshot[id].interruptRunning), [true, false, false, false]);
  assert.equal(Object.hasOwn(snapshot[live], "interruptRunning"), false, "a live integration has none");
  for (const change of feed.changes.filter((entry) => entry.kind !== "integration_revoked")) {
    assert.equal(Object.hasOwn(change, "interruptRunning"), false, change.kind);
    if (change.integration && change.integration.state !== "revoking" && change.integration.state !== "revoked") assert.equal(Object.hasOwn(change.integration, "interruptRunning"), false, change.kind);
  }
  // Only the owner's choice is in the row: the first revocation's, not a later one's.
  assert.equal((await s.repository.integration(interrupted)).interruptRunning, true);
});

test("with the setting off, the Station's feed has no interruptRunning anywhere", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.approved();
  await s.service.revoke(OWNER, id);
  const feed = await s.service.changes(s.station.reportClientId, 0);
  const revoked = feed.changes.find((change) => change.kind === "integration_revoked");
  assert.deepEqual(Object.keys(revoked).sort(), ["at", "id", "integration", "integrationId", "kind", "reason", "state"]);
  assert.deepEqual(Object.keys(revoked.integration).sort(), ["expiresAt", "ownerAccount", "quotaPerSecond", "r9Svc", "scopes", "state"]);
  assert.deepEqual(Object.keys(feed.integrations[0]).sort(), ["expiresAt", "id", "ownerAccount", "quotaPerSecond", "r9Svc", "scopes", "state"]);
});

// D29: the later "interrupt running tasks" is a change in the Station's feed, pushed like the others.
test("with the setting on, an interrupt is pushed and is a feed change with interruptRunning: true, its integration carrying it too", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const mine = await s.approved();
  const theirs = await s.approved(MEMBER);
  await s.service.revoke(OWNER, mine, { interruptRunning: false });
  await s.service.revoke(MEMBER, theirs, { interruptRunning: false });
  await s.service._pushesIdle();
  s.pushFetch.posts.length = 0;
  s.clock.now += 3600000;
  await s.service.interrupt(OWNER, mine);
  await s.service.interrupt(OWNER, theirs);
  await s.service.interrupt(OWNER, theirs);
  await s.service._pushesIdle();
  assert.ok(s.pushFetch.posts.length >= 1, "the Station is told");
  assert.ok(s.pushFetch.posts.every((post) => post.url === "https://one.example/agora-build/v1/changes"));
  assert.deepEqual(s.pushFetch.posts.at(-1).body, { cursor: await s.repository.latestCursor(s.station.id) });

  const feed = await s.service.changes(client, 0);
  const interrupts = feed.changes.filter((change) => change.kind === "integration_interrupt_requested");
  assert.deepEqual(interrupts.map((change) => [change.integrationId, change.state, change.reason, change.interruptRunning]), [[mine, "revoking", "owner", true], [theirs, "revoking", "station_owner", true]], "one each: the repeat wrote none");
  for (const change of interrupts) {
    assert.deepEqual(Object.keys(change).sort(), ["at", "id", "integration", "integrationId", "interruptRunning", "kind", "reason", "state"]);
    assert.deepEqual([change.integration.state, change.integration.interruptRunning], ["revoking", true]);
  }
  assert.deepEqual(feed.integrations.filter((entry) => [mine, theirs].includes(entry.id)).map((entry) => entry.interruptRunning), [true, true]);
  // The revocations' own changes still say what was chosen then; the integration they carry is as it is now.
  const revoked = feed.changes.filter((change) => change.kind === "integration_revoked");
  assert.deepEqual(revoked.map((change) => [change.interruptRunning, change.integration.interruptRunning]), [[false, true], [false, true]]);
  // Read from after the revocations, the cursor carries the interrupts alone.
  const later = await s.service.changes(client, String(revoked.at(-1).id));
  assert.deepEqual(later.changes.map((change) => change.kind), ["integration_interrupt_requested", "integration_interrupt_requested"]);
});

test("with the setting on, a Station's report answer stays as it is today: no revokedAt or interruptRunning", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await s.approved();
  await s.service.report(client, { integrationId: id, state: "ready" });
  await s.service.revoke(OWNER, id, { interruptRunning: true });
  const keys = ["approvedAt", "createdAt", "expiresAt", "id", "kind", "lastError", "name", "pausedFrom", "quotaPerSecond", "r9Svc", "scopes", "state", "stationId", "stationOrigin"];
  const errored = await s.service.report(client, { integrationId: id, state: "error", reason: "R9 host unreachable" });
  assert.deepEqual([errored.state, Object.keys(errored).sort()], ["revoking", keys], "an error on a revoking integration");
  const revoked = await s.service.report(client, { integrationId: id, state: "revoked" });
  assert.deepEqual([revoked.state, Object.keys(revoked).sort()], ["revoked", keys], "its revoked report");
  // The owner's own view of the same row has them, which is where the page reads them.
  const own = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([own.interruptRunning, typeof own.revokedAt], [true, "string"]);
});
