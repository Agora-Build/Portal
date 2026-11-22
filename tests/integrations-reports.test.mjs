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

// D29 Phase B: a Station's two revocation reports, idempotent by their reportId (the setting on: delegatedHostWork).
const REPORT_ID = (n) => "rep:" + n.toString(16).padStart(64, "0");
const RECORD_ID = (n) => "0f8a1b2c-3d4e-4f50-8a6b-" + n.toString(16).padStart(12, "0");
const appliedReport = (integrationId, n, host = "laptop") => ({ integrationId, state: "revocation_applied", reportId: REPORT_ID(n), host, recordId: RECORD_ID(n) });
const finalReport = (integrationId, n, outcome = "all_applied", pendingHosts = []) => ({ integrationId, state: "revoked", reportId: REPORT_ID(n), outcome, pendingHosts });
const ANSWER_KEYS = ["approvedAt", "createdAt", "expiresAt", "id", "kind", "lastError", "name", "pausedFrom", "quotaPerSecond", "r9Svc", "scopes", "state", "stationId", "stationOrigin"];
const NOT_REVOKED = "This integration isn't revoked.";
const FINAL_ALREADY = "This integration's revocation already has its final report.";
const REUSED = "This reportId was already used for another report.";

async function revoking(s, accountId = OWNER, stationId = s.station.id) {
  const id = await s.approved(accountId, stationId);
  await s.service.revoke(accountId, id, { interruptRunning: false });
  return id;
}
const ownView = async (s, id, accountId = OWNER) => (await s.service.integrations(accountId)).integrations.find((entry) => entry.id === id);
const savedReports = async (s) => (await s.db.pool.query("SELECT station_id, report_id, integration_id FROM station_reports ORDER BY report_id")).rows;
const recordedHosts = async (s, id) => (await s.db.pool.query("SELECT host, record_id, report_id FROM revocation_hosts WHERE integration_id = $1 ORDER BY host", [id])).rows;

test("with the setting on, revocation_applied records a host once, pushes nothing and answers as any report does", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await revoking(s);
  await s.service._pushesIdle();
  s.pushFetch.posts.length = 0;
  const events = (await s.db.pool.query("SELECT count(*)::int AS n FROM integration_events")).rows[0].n;

  const first = await s.service.report(client, appliedReport(id, 1));
  assert.deepEqual([first.state, Object.keys(first).sort()], ["revoking", ANSWER_KEYS], "the view the Station sees: no role, pausedBy, revokedAt, interruptRunning, stationRemoved or revocation");
  assert.deepEqual((await ownView(s, id)).revocation, { appliedHosts: 1, outcome: null, unconfirmedHosts: null });
  await s.service._pushesIdle();
  assert.deepEqual(s.pushFetch.posts, [], "the reporting Station is not told");
  assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM integration_events")).rows[0].n, events, "no event");
  assert.equal((await s.repository.integration(id)).state, "revoking", "no row change");

  // The same id with the same body: the recorded answer, nothing new.
  assert.deepEqual(await s.service.report(client, appliedReport(id, 1)), first);
  assert.deepEqual([(await recordedHosts(s, id)).length, (await savedReports(s)).length], [1, 1]);
  // The same id with another host: refused, and the first report stands.
  await assert.rejects(s.service.report(client, appliedReport(id, 1, "desktop")), (error) => refused(409, "report_id_reused")(error) && error.message === REUSED);
  assert.deepEqual((await recordedHosts(s, id)).map((row) => row.host), ["laptop"]);
  assert.deepEqual(await s.service.report(client, appliedReport(id, 1)), first, "still answers the first");
  // A second host counts; the same host under another id does not, but is recorded under its own id.
  await s.service.report(client, appliedReport(id, 2, "desktop"));
  assert.equal((await ownView(s, id)).revocation.appliedHosts, 2);
  const again = await s.service.report(client, appliedReport(id, 3, "laptop"));
  assert.equal(again.state, "revoking");
  assert.equal((await ownView(s, id)).revocation.appliedHosts, 2, "counted once");
  assert.deepEqual(await recordedHosts(s, id), [
    { host: "desktop", record_id: RECORD_ID(2), report_id: REPORT_ID(2) },
    { host: "laptop", record_id: RECORD_ID(1), report_id: REPORT_ID(1) }
  ], "the first report for a host keeps its record and report ids");
  assert.deepEqual((await savedReports(s)).map((row) => row.report_id), [REPORT_ID(1), REPORT_ID(2), REPORT_ID(3)], "the repeat is kept under its own id");
  assert.deepEqual(await s.service.report(client, appliedReport(id, 3)), again);
  await s.service._pushesIdle();
  assert.deepEqual(s.pushFetch.posts, []);
});

test("revocation_applied needs a revoking or revoked integration of this Station and a refused report records nothing", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const live = await s.approved();
  await assert.rejects(s.service.report(client, appliedReport(live, 1)), (error) => refused(409, "invalid_state")(error) && error.message === NOT_REVOKED);
  const waiting = await s.create();
  await assert.rejects(s.service.report(client, appliedReport(waiting, 2)), refused(409, "invalid_state"));
  await s.service.pause(OWNER, live);
  await assert.rejects(s.service.report(client, appliedReport(live, 3)), refused(409, "invalid_state"));
  const other = await s.register(OTHER, "https://two.example");
  const theirs = await revoking(s, OTHER, other.id);
  await assert.rejects(s.service.report(client, appliedReport(theirs, 4)), refused(404, "not_found"));
  await assert.rejects(s.service.report(client, appliedReport("i-missing", 5)), refused(404, "not_found"));
  await assert.rejects(s.service.report(client, appliedReport(7, 6)), refused(404, "not_found"));
  assert.deepEqual(await savedReports(s), [], "no id was recorded");
  assert.deepEqual(await recordedHosts(s, theirs), []);
  // The ids were never used: the same ids are accepted once the integrations are revoked.
  await s.service.revoke(OWNER, waiting, { interruptRunning: false });
  assert.equal((await s.service.report(client, appliedReport(waiting, 2))).state, "revoked", "an integration never approved is revoked at once");
  const revoked = await revoking(s);
  await s.service.report(client, { integrationId: revoked, state: "revoked" });
  assert.equal((await s.service.report(client, appliedReport(revoked, 7))).state, "revoked", "on a revoked integration too");
  assert.deepEqual((await savedReports(s)).map((row) => row.report_id), [REPORT_ID(2), REPORT_ID(7)]);
  // Another Station's ids are its own.
  await s.service.report(other.reportClientId, appliedReport(theirs, 2));
  assert.deepEqual((await savedReports(s)).map((row) => [row.station_id, row.report_id]), [[s.station.id, REPORT_ID(2)], [other.id, REPORT_ID(2)], [s.station.id, REPORT_ID(7)]]);
  await assert.rejects(s.service.report(client, appliedReport(theirs, 8)), refused(404, "not_found"), "an integration of another Station is still not found");
  await assert.rejects(s.service.report(client, appliedReport(theirs, 2)), refused(409, "report_id_reused"), "this Station's id 2 is its own report, whatever another Station did with 2");
});

test("with the setting on, the new reports are validated in order: shape, state, reportId, then the kind's fields", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await revoking(s);
  const send = (body) => s.service.report(client, body);
  const applied = appliedReport(id, 1);
  const final = finalReport(id, 2);
  const REPORT_ID_MESSAGE = "Send the reportId as 1 to 128 characters of letters, digits, '.', '_', ':' or '-'.";
  const HOST_MESSAGE = "Name the host by its id: 1 to 128 characters of letters, digits, '.', '_', ':' or '-'.";
  const RECORD_MESSAGE = "Send the recordId as the record's lowercase UUID.";
  const OUTCOME_MESSAGE = "Send all_applied with no pendingHosts, or deadline_passed with the hosts that didn't confirm.";
  const bad = async (body, code, message, label) => {
    await assert.rejects(send(body), (error) => refused(400, code)(error) && (message === undefined || error.message === message), label ?? JSON.stringify(body));
  };
  // Shape: any other combination of fields is 400 report.
  for (const body of [
    { ...applied, reason: "done" }, { ...final, reason: "done" }, { ...applied, extra: 1 }, { ...applied, outcome: "all_applied" }, { ...final, host: "laptop" },
    { integrationId: id, state: "revoked", outcome: "all_applied", pendingHosts: [] }, { integrationId: id, state: "ready", host: "laptop" }, { integrationId: id, state: "ready", reportId: REPORT_ID(3) },
    { integrationId: id, state: "error", reason: "x", reportId: REPORT_ID(3) }, { ...applied, host: undefined, outcome: "all_applied" }, null, [], "revoked"
  ]) await bad(body, "report", undefined, JSON.stringify(body));
  // The shape comes before the reportId: a body that doesn't fit the state it names is 400 report, whatever its reportId.
  for (const body of [
    { integrationId: id, state: "ready", reportId: "bad id" }, { integrationId: id, state: "error", reportId: "bad id" },
    { integrationId: id, state: "revoked", reportId: "bad id", host: "laptop" }, { integrationId: id, state: "revocation_applied", reportId: "bad id", outcome: "all_applied" },
    { integrationId: id, state: "waiting_for_host", reportId: "bad id" }, { integrationId: id, state: "revoked", reportId: "bad id", recordId: RECORD_ID(1), outcome: "all_applied", pendingHosts: [] },
    { integrationId: id, state: "revocation_applied", reportId: "bad id", host: "bad host", recordId: RECORD_ID(1), pendingHosts: [] },
    { integrationId: id, state: "revocation_applied", reportId: "bad id", host: "laptop", reason: "done" }
  ]) await bad(body, "report", undefined, "shape before reportId: " + JSON.stringify(body));
  await bad({ ...applied, state: "paused" }, "state");
  await bad({ ...applied, state: undefined }, "state");
  await bad({ integrationId: id, state: "revocation_applied" }, "report_id", REPORT_ID_MESSAGE, "the state is known: its reportId is missing");
  // reportId.
  for (const reportId of ["", "x".repeat(129), "has space", "bad/id", "café", "line\nbreak", "trailing\n", 5, null, {}, ["a"]]) {
    await bad({ ...applied, reportId }, "report_id", REPORT_ID_MESSAGE, "applied " + JSON.stringify(reportId));
    await bad({ ...final, reportId }, "report_id", REPORT_ID_MESSAGE, "final " + JSON.stringify(reportId));
  }
  // host, recordId.
  for (const host of [undefined, "", "x".repeat(129), "has space", "a/b", "café", "a\nb", 5, null, ["laptop"]]) await bad({ ...applied, host }, "host", HOST_MESSAGE, "host " + JSON.stringify(host));
  const v4 = RECORD_ID(1);
  for (const recordId of [undefined, "", v4.toUpperCase(), v4.replace("-4f50-", "-1f50-"), v4.replace("-8a6b-", "-0a6b-"), v4.slice(1), v4 + "0", "not-a-uuid", 5, null]) await bad({ ...applied, recordId }, "record_id", RECORD_MESSAGE, "recordId " + JSON.stringify(recordId));
  // outcome, pendingHosts.
  const hosts = (n) => Array.from({ length: n }, (_, index) => "host-" + index);
  for (const [outcome, pendingHosts] of [
    ["all_applied", ["laptop"]], ["deadline_passed", []], ["deadline_passed", hosts(101)], ["deadline_passed", ["a", "a"]], ["other", []], [undefined, []], ["all_applied", undefined], ["all_applied", null], ["all_applied", "none"], ["deadline_passed", "laptop"], [5, []], ["all_applied", {}]
  ]) await bad({ ...final, outcome, pendingHosts }, "outcome", OUTCOME_MESSAGE, JSON.stringify([outcome, pendingHosts]));
  for (const entry of ["", "x".repeat(129), "has space", 5, null, "a\nb"]) await bad({ ...final, outcome: "deadline_passed", pendingHosts: ["laptop", entry] }, "host", HOST_MESSAGE, "pendingHosts " + JSON.stringify(entry));
  assert.deepEqual(await savedReports(s), []);
  assert.deepEqual(await recordedHosts(s, id), []);
  // The limits themselves are accepted: 100 hosts of 128 characters.
  const full = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, "0") + "h".repeat(125));
  assert.equal((await send(finalReport(id, 9, "deadline_passed", full))).state, "revoked");
  assert.deepEqual(await s.service.report(client, appliedReport(id, 10, "x".repeat(128))), await s.service.report(client, appliedReport(id, 10, "x".repeat(128))));
  assert.equal((await send(appliedReport(id, 11, "A._:-9"))).state, "revoked", "the grammar's own characters");
  assert.equal((await send({ ...appliedReport(id, 12, "h12"), reportId: "r".repeat(128) })).state, "revoked", "a reportId of 128 characters");
});

test("a final revoked report moves a revoking integration to revoked with its outcome, once", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await revoking(s);
  await s.service._pushesIdle();
  s.pushFetch.posts.length = 0;
  const done = await s.service.report(client, finalReport(id, 1));
  assert.deepEqual([done.state, Object.keys(done).sort()], ["revoked", ANSWER_KEYS]);
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.revocationOutcome, row.revocationPendingHosts], ["revoked", "all_applied", []]);
  assert.deepEqual((await ownView(s, id)).revocation, { appliedHosts: 0, outcome: "all_applied", unconfirmedHosts: null });
  assert.deepEqual((await s.reports(id)).map((event) => [event.actor, event.account_id, event.state, event.reason, event.details]), [["station", OWNER, "revoked", null, { outcome: "all_applied", unconfirmedHosts: 0 }]]);
  await s.service._pushesIdle();
  assert.deepEqual(s.pushFetch.posts, [], "the reporting Station is not told");
  // The same final again answers the recorded answer; a second final under another id is refused; neither changes anything.
  assert.deepEqual(await s.service.report(client, finalReport(id, 1)), done);
  await assert.rejects(s.service.report(client, finalReport(id, 2)), (error) => refused(409, "invalid_state")(error) && error.message === FINAL_ALREADY);
  await assert.rejects(s.service.report(client, finalReport(id, 3, "deadline_passed", ["laptop"])), refused(409, "invalid_state"));
  await assert.rejects(s.service.report(client, finalReport(id, 1, "deadline_passed", ["laptop"])), refused(409, "report_id_reused"));
  await assert.rejects(s.service.report(client, { ...finalReport(id, 1), integrationId: "i-other" }), refused(409, "report_id_reused"), "even with another integration");
  assert.deepEqual((await savedReports(s)).map((saved) => saved.report_id), [REPORT_ID(1)], "refused reports recorded nothing");
  assert.equal((await s.reports(id)).length, 1);
  assert.equal((await s.repository.integration(id)).revocationOutcome, "all_applied");
  // A late per-host report is welcome on a revoked integration.
  assert.equal((await s.service.report(client, appliedReport(id, 4))).state, "revoked");
  assert.equal((await ownView(s, id)).revocation.appliedHosts, 1);
});

test("a final with deadline_passed names the hosts that didn't confirm; a late per-host report lowers the count", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await revoking(s);
  await s.service.report(client, appliedReport(id, 1, "phone"));
  const done = await s.service.report(client, finalReport(id, 2, "deadline_passed", ["laptop", "desktop", "tablet"]));
  assert.equal(done.state, "revoked");
  const row = await s.repository.integration(id);
  assert.deepEqual([row.revocationOutcome, row.revocationPendingHosts], ["deadline_passed", ["laptop", "desktop", "tablet"]]);
  assert.deepEqual((await s.reports(id)).map((event) => event.details), [{ outcome: "deadline_passed", unconfirmedHosts: 3 }]);
  assert.deepEqual((await ownView(s, id)).revocation, { appliedHosts: 1, outcome: "deadline_passed", unconfirmedHosts: 3 });
  assert.equal((await s.service.report(client, appliedReport(id, 3, "laptop"))).state, "revoked", "late, and the integration stays revoked");
  assert.deepEqual((await ownView(s, id)).revocation, { appliedHosts: 2, outcome: "deadline_passed", unconfirmedHosts: 2 });
  await s.service.report(client, appliedReport(id, 4, "laptop"));
  await s.service.report(client, appliedReport(id, 5, "elsewhere"));
  assert.deepEqual((await ownView(s, id)).revocation, { appliedHosts: 3, outcome: "deadline_passed", unconfirmedHosts: 2 }, "a repeat and a host that was not pending change nothing");
  await s.service.report(client, appliedReport(id, 6, "desktop"));
  await s.service.report(client, appliedReport(id, 7, "tablet"));
  assert.deepEqual((await ownView(s, id)).revocation, { appliedHosts: 5, outcome: "deadline_passed", unconfirmedHosts: 0 });
  assert.equal((await s.repository.integration(id)).state, "revoked");
  assert.equal((await s.reports(id)).length, 1, "only the final is an event");
  // Neither the page's data nor the Station's feed ever names a host.
  const everything = JSON.stringify([await s.service.integrations(OWNER), await s.service.changes(client, 0), await s.service.history(OWNER, id)]);
  for (const host of ["laptop", "desktop", "tablet", "phone", "elsewhere"]) assert.equal(everything.includes(host), false, host);
  const feed = (await s.service.changes(client, 0)).changes.filter((change) => change.kind === "integration_reported");
  assert.deepEqual(feed.map((change) => [change.state, change.reason]), [["revoked", null]]);
});

test("a final after a legacy revoked records the outcome with no second event", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await revoking(s);
  await s.service.report(client, { integrationId: id, state: "revoked" });
  assert.deepEqual((await ownView(s, id)).revocation, { appliedHosts: 0, outcome: null, unconfirmedHosts: null }, "stopped, with no final yet");
  assert.equal((await s.reports(id)).length, 1);
  const before = await s.repository.integration(id);
  const done = await s.service.report(client, finalReport(id, 1, "deadline_passed", ["laptop"]));
  assert.deepEqual([done.state, Object.keys(done).sort()], ["revoked", ANSWER_KEYS]);
  const after = await s.repository.integration(id);
  assert.deepEqual([after.state, after.revocationOutcome, after.revocationPendingHosts], ["revoked", "deadline_passed", ["laptop"]]);
  assert.deepEqual({ ...after, updatedAt: null, revocationOutcome: null, revocationPendingHosts: null }, { ...before, updatedAt: null }, "only the two fields changed");
  assert.equal((await s.reports(id)).length, 1, "no second event");
  assert.deepEqual(await s.service.report(client, finalReport(id, 1, "deadline_passed", ["laptop"])), done);
  await assert.rejects(s.service.report(client, finalReport(id, 2)), refused(409, "invalid_state"));
  // Today's legacy revoked on a revoked integration is still the no-op it was.
  assert.equal((await s.service.report(client, { integrationId: id, state: "revoked" })).state, "revoked");
  assert.equal((await s.reports(id)).length, 1);
});

test("a final is refused on an integration that is not being revoked, and records nothing", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const live = await s.approved();
  await assert.rejects(s.service.report(client, finalReport(live, 1)), refused(409, "invalid_state"));
  await s.service.pause(OWNER, live);
  await assert.rejects(s.service.report(client, finalReport(live, 2)), refused(409, "invalid_state"));
  const waiting = await s.create();
  await assert.rejects(s.service.report(client, finalReport(waiting, 3)), refused(409, "invalid_state"));
  s.clock.now += 91 * DAY;
  await assert.rejects(s.service.report(client, finalReport(live, 4)), refused(409, "invalid_state"));
  const other = await s.register(OTHER, "https://two.example");
  const theirs = await revoking(s, OTHER, other.id);
  await assert.rejects(s.service.report(client, finalReport(theirs, 5)), refused(404, "not_found"));
  assert.deepEqual(await savedReports(s), []);
  assert.deepEqual((await s.db.pool.query("SELECT id FROM integrations WHERE revocation_outcome IS NOT NULL")).rows, []);
  assert.equal((await s.repository.integration(theirs)).state, "revoking");
  assert.equal((await s.reports(live)).length, 0);
});

test("a retry racing itself is recorded once and both calls get the same answer", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await revoking(s);
  const [first, repeat] = await Promise.all([s.service.report(client, appliedReport(id, 1)), s.service.report(client, appliedReport(id, 1))]);
  assert.deepEqual(first, repeat);
  assert.deepEqual([(await savedReports(s)).length, (await recordedHosts(s, id)).length], [1, 1]);
  const finals = await Promise.all([s.service.report(client, finalReport(id, 2)), s.service.report(client, finalReport(id, 2))]);
  assert.deepEqual(finals[0], finals[1]);
  assert.equal((await s.reports(id)).length, 1, "one event");
  const rival = await Promise.allSettled([s.service.report(client, appliedReport(id, 3, "desktop")), s.service.report(client, appliedReport(id, 3, "tablet"))]);
  assert.deepEqual(rival.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"], "the same id with two bodies: one stands");
  assert.equal(rival.find((outcome) => outcome.status === "rejected").reason.details.code, "report_id_reused");
  const second = await revoking(s);
  const finalists = await Promise.allSettled([s.service.report(client, finalReport(second, 4)), s.service.report(client, finalReport(second, 5))]);
  assert.deepEqual(finalists.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"], "two finals under two ids: one stands");
  assert.equal(finalists.find((outcome) => outcome.status === "rejected").reason.details.code, "invalid_state");
});

test("the integration views count a stopped integration's revocation, for its owner and its Station's owner", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const live = await s.approved();
  const mine = await revoking(s);
  const theirs = await revoking(s, MEMBER);
  await s.service.report(client, appliedReport(theirs, 1, "phone"));
  await s.service.report(client, appliedReport(theirs, 2, "laptop"));
  await s.service.report(client, finalReport(theirs, 3, "deadline_passed", ["tablet", "laptop"]));
  const owned = (await s.service.integrations(OWNER)).integrations;
  const find = (list, id) => list.find((entry) => entry.id === id);
  assert.equal(Object.hasOwn(find(owned, live), "revocation"), false, "a live integration has none");
  assert.deepEqual(find(owned, mine).revocation, { appliedHosts: 0, outcome: null, unconfirmedHosts: null });
  assert.deepEqual(find(owned, theirs).revocation, { appliedHosts: 2, outcome: "deadline_passed", unconfirmedHosts: 1 }, "the Station owner's view of a member's integration");
  assert.deepEqual(find((await s.service.integrations(MEMBER)).integrations, theirs).revocation, { appliedHosts: 2, outcome: "deadline_passed", unconfirmedHosts: 1 });
  assert.deepEqual(Object.keys(find(owned, theirs).revocation), ["appliedHosts", "outcome", "unconfirmedHosts"]);
  // The answers to the owner's own calls carry it too.
  assert.deepEqual((await s.service.revoke(OWNER, mine, { interruptRunning: false })).revocation, { appliedHosts: 0, outcome: null, unconfirmedHosts: null });
  assert.equal(Object.hasOwn(await s.service.pause(OWNER, live), "revocation"), false);
});

test("with the setting off, the new reports are unknown fields and a revoked view has no revocation", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await s.approved();
  await s.service.revoke(OWNER, id);
  for (const body of [appliedReport(id, 1), finalReport(id, 2), { integrationId: id, state: "revoked", reportId: REPORT_ID(3) }, { integrationId: id, state: "revoked", outcome: "all_applied", pendingHosts: [] }, { integrationId: id, state: "revoked", host: "laptop" }]) {
    await assert.rejects(s.service.report(client, body), (error) => refused(400, "report")(error) && error.message === "Send a report as { integrationId, state, reason }.", JSON.stringify(body));
  }
  await assert.rejects(s.service.report(client, { integrationId: id, state: "revocation_applied" }), refused(400, "state"));
  assert.deepEqual(await savedReports(s), []);
  assert.equal((await s.repository.integration(id)).state, "revoking");
  // Today's report, unchanged.
  const revoked = await s.service.report(client, { integrationId: id, state: "revoked" });
  assert.equal(revoked.state, "revoked");
  assert.equal(Object.hasOwn(revoked, "revocation"), false);
  assert.equal(Object.hasOwn(await ownView(s, id), "revocation"), false);
  assert.equal((await s.repository.integration(id)).revocationOutcome, null);
});

test("with the setting on, today's reports behave as before, and a legacy report is not kept by id", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await s.approved();
  assert.equal((await s.service.report(client, { integrationId: id, state: "ready" })).state, "ready");
  assert.equal((await s.service.report(client, { integrationId: id, state: "error", reason: "R9 host unreachable" })).lastError, "R9 host unreachable");
  await assert.rejects(s.service.report(client, { integrationId: id, state: "ready", extra: 1 }), refused(400, "report"));
  await assert.rejects(s.service.report(client, { integrationId: id, state: "error" }), refused(400, "reason"));
  await assert.rejects(s.service.report(client, { integrationId: id, state: "ready", reason: "bell\u0007" }), refused(400, "reason"));
  await assert.rejects(s.service.report(client, { integrationId: id, state: "provisioning" }), refused(400, "state"));
  await s.service.revoke(OWNER, id, { interruptRunning: false });
  assert.equal((await s.service.report(client, { integrationId: id, state: "error", reason: "late" })).state, "revoking", "an error about a revoking integration is as it was");
  assert.equal((await s.service.report(client, { integrationId: id, state: "revoked" })).state, "revoked");
  await assert.rejects(s.service.report(client, { integrationId: id, state: "error", reason: "later" }), refused(409, "invalid_state"));
  assert.deepEqual(await savedReports(s), []);
});

// The exact-cursor checkpoint (D29), GET /api/v1/stations/changes?checkpoint=1: the Station's newest event id, every
// integration on it in any state and, for the built-in Station, the account availability and the bindings, read in one
// repeatable read transaction. service.changes(client, cursor, { checkpoint: true }) is what the route calls with the
// setting on.
const CHECKPOINT = { checkpoint: true };
const ADMIN = "ab" + "0".repeat(25) + "4";
const DISABLED = "ab" + "0".repeat(25) + "5";
const DISABLED_TOO = "ab" + "0".repeat(25) + "6";
const GENESIS = "b".repeat(64);
const ISO = (ms) => new Date(ms).toISOString();

// The built-in Station as Auth seeds it, followed by the Portal; returns Auth's record (id, reportClientId).
async function builtIn(s) {
  const seeded = s.manage.seedBuiltIn({ integrations: true, admins: [ADMIN] });
  await s.service.syncBuiltIn();
  return seeded;
}

// What the reader of Auth's feed does with the entries Auth has: starts over (a first start), applies each in the pass's
// epoch, and says it reached the end. Returns the pass, for entries applied live afterwards.
async function readAuthFeed(s) {
  await s.service.accountsStartingOver();
  const pass = { epoch: Number((await s.db.pool.query("SELECT accounts_epoch FROM auth_change_feed")).rows[0].accounts_epoch) };
  for (const entry of s.manage.feed) assert.equal(await s.service.applyAuthChange(entry, pass), "applied");
  await s.service.accountsCaughtUp(pass);
  return pass;
}

const newestEvent = async (s, stationId) => Number((await s.db.pool.query("SELECT max(id) AS id FROM integration_events WHERE station_id = $1", [stationId])).rows[0].id);

test("the checkpoint's cursor is the Station's newest event, it lists every integration in any state with revokedAt on the stopped ones, and resuming at the cursor delivers only later changes", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const live = await s.approved();
  await s.service.report(client, { integrationId: live, state: "ready" });
  const pending = await s.create();
  const revoking = await s.approved();
  await s.service.revoke(OWNER, revoking, { interruptRunning: true });
  const revoked = await s.approved();
  await s.service.revoke(OWNER, revoked, { interruptRunning: false });
  await s.service.report(client, { integrationId: revoked, state: "revoked" });
  const never = await s.create(OWNER);
  await s.service.revoke(OWNER, never, { interruptRunning: false });
  // Another Station's events come later: event ids are global, and the cursor is this Station's.
  const other = await s.register(OTHER, "https://two.example");
  await s.approved(OTHER, other.id);
  assert.ok((await newestEvent(s, other.id)) > (await newestEvent(s, s.station.id)));

  const checkpoint = await s.service.changes(client, "0", CHECKPOINT);
  assert.deepEqual(Object.keys(checkpoint), ["changes", "cursor", "checkpoint"]);
  assert.deepEqual(checkpoint.changes, []);
  assert.equal(checkpoint.cursor, await newestEvent(s, s.station.id));
  assert.equal(checkpoint.cursor, await s.repository.latestCursor(s.station.id));
  assert.deepEqual(Object.keys(checkpoint.checkpoint), ["at", "integrations"], "a custom Station's has no accounts and no bindings");
  assert.equal(checkpoint.checkpoint.at, ISO(s.clock.now));

  const row = async (id) => s.repository.integration(id);
  const open = async (id, state) => ({ id, ownerAccount: OWNER, state, scopes: ["agent.view"], r9Svc: (await row(id)).r9Svc, expiresAt: (await row(id)).expiresAt, quotaPerSecond: 200 });
  const stopped = async (id, state, interruptRunning) => ({ ...await open(id, state), interruptRunning, revokedAt: (await row(id)).revokedAt });
  assert.deepEqual(checkpoint.checkpoint.integrations, [
    await open(live, "ready"), await open(pending, "awaiting_approval"), await stopped(revoking, "revoking", true), await stopped(revoked, "revoked", false), await stopped(never, "revoked", false)
  ]);
  for (const id of [revoking, revoked, never]) assert.match((await row(id)).revokedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(Object.hasOwn(checkpoint.checkpoint.integrations[0], "revokedAt"), false, "a live one has none");
  assert.equal(Object.hasOwn(checkpoint.checkpoint.integrations[0], "interruptRunning"), false);

  // The feed from cursor 0 ends at the same cursor, with the same integrations (its own snapshot shape, without revokedAt).
  const feed = await s.service.changes(client, "0");
  assert.equal(feed.cursor, checkpoint.cursor);
  assert.deepEqual(feed.integrations.map((entry) => entry.id), checkpoint.checkpoint.integrations.map((entry) => entry.id));

  // Resuming at the cursor delivers nothing now, and then only what came after.
  const resumed = await s.service.changes(client, checkpoint.cursor);
  assert.deepEqual([resumed.changes, resumed.cursor, Object.hasOwn(resumed, "checkpoint")], [[], checkpoint.cursor, false]);
  await s.service.report(client, { integrationId: live, state: "error", reason: "R9 host unreachable" });
  const later = await s.service.changes(client, checkpoint.cursor);
  assert.deepEqual(later.changes.map((change) => [change.kind, change.integrationId]), [["integration_reported", live]]);
  assert.ok(later.changes[0].id > checkpoint.cursor);
  assert.equal(later.cursor, later.changes[0].id);
  assert.equal((await s.service.changes(client, "0", CHECKPOINT)).cursor, later.cursor, "a new checkpoint is at the new cursor");

  // The cursor check doesn't apply to a checkpoint (it is at the Station's newest event itself); a malformed one is still refused.
  assert.equal((await s.service.changes(client, String(later.cursor + 1000), CHECKPOINT)).cursor, later.cursor);
  await assert.rejects(s.service.changes(client, "abc", CHECKPOINT), refused(400, "cursor"));
  await assert.rejects(s.service.changes("s-unknown", "0", CHECKPOINT), refused(403, "station"));
  // A checkpoint is of this Station only.
  assert.deepEqual((await s.service.changes(other.reportClientId, "0", CHECKPOINT)).checkpoint.integrations.map((entry) => entry.ownerAccount), [OTHER]);
});

test("a Station with nothing yet, and a checkpoint that is not asked for, answer as they should", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const empty = await s.register(OTHER, "https://two.example");
  const first = await s.service.changes(empty.reportClientId, "0", CHECKPOINT);
  assert.deepEqual(first, { changes: [], cursor: await s.repository.latestCursor(empty.id), checkpoint: { at: ISO(s.clock.now), integrations: [] } });
  assert.ok(first.cursor > 0, "its registration is its first event");
  // Not asked for (or asked for as false): the feed as it was, with the setting on.
  const id = await s.approved();
  for (const options of [undefined, {}, { checkpoint: false }]) {
    const feed = await s.service.changes(s.station.reportClientId, "0", options);
    assert.equal(Object.hasOwn(feed, "checkpoint"), false);
    assert.deepEqual(feed.integrations.map((entry) => entry.id), [id]);
  }
});

test("the built-in Station's checkpoint has the accounts and the bindings: complete follows the baseline, disabled follows availability", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const built = await builtIn(s);
  const client = built.reportClientId;
  const checkpoint = async () => (await s.service.changes(client, "0", CHECKPOINT));
  const id = await s.service.createIntegration(OWNER, { stationId: built.id, name: "Hosted", scopes: [], publicJwk: publicJwk() });

  // A fresh Portal is rebuilding: nothing is known, so it isn't complete, and nobody is disabled.
  let answer = await checkpoint();
  assert.deepEqual(Object.keys(answer.checkpoint), ["at", "integrations", "accounts", "bindings"]);
  assert.deepEqual([answer.checkpoint.accounts, answer.checkpoint.bindings], [{ complete: false, disabled: [] }, []]);
  assert.deepEqual(answer.checkpoint.integrations.map((entry) => [entry.id, entry.ownerAccount, entry.state]), [[id.id, OWNER, "awaiting_approval"]]);
  assert.equal(answer.cursor, await newestEvent(s, built.id));

  // Auth has disabled an account and not yet written its baseline: the rebuild is adopted, but the view isn't complete.
  s.manage.accountChange(DISABLED, true, { actor: ADMIN, reason: "Abuse" });
  const pass = await readAuthFeed(s);
  answer = await checkpoint();
  assert.deepEqual(answer.checkpoint.accounts, { complete: false, disabled: [DISABLED] });
  assert.equal(answer.cursor, await newestEvent(s, built.id));
  assert.equal(answer.cursor, (await s.service.changes(client, "0")).cursor);

  // The baseline, applied live in order, completes it, and the Station's cursor is its change.
  s.manage.baselineChange();
  assert.equal(await s.service.applyAuthChange(s.manage.feed.at(-1), pass), "applied");
  answer = await checkpoint();
  assert.deepEqual(answer.checkpoint.accounts, { complete: true, disabled: [DISABLED] });
  assert.equal(answer.cursor, await newestEvent(s, built.id));
  assert.equal((await s.service.changes(client, String(answer.cursor - 1))).changes[0].kind, "accounts_baseline");

  // Disabled follows availability, in account order, an enabled account leaving the list.
  s.manage.accountChange(DISABLED_TOO, true, { actor: ADMIN, reason: "Abuse" });
  assert.equal(await s.service.applyAuthChange(s.manage.feed.at(-1), pass), "applied");
  assert.deepEqual((await checkpoint()).checkpoint.accounts, { complete: true, disabled: [DISABLED, DISABLED_TOO] });
  s.manage.accountChange(DISABLED, false, { actor: ADMIN, reason: "Mistake" });
  assert.equal(await s.service.applyAuthChange(s.manage.feed.at(-1), pass), "applied");
  answer = await checkpoint();
  assert.deepEqual(answer.checkpoint.accounts, { complete: true, disabled: [DISABLED_TOO] });
  assert.equal(answer.cursor, await newestEvent(s, built.id));
  // The custom Station sees none of it, whatever the Portal knows of the accounts.
  const custom = await s.service.changes(s.station.reportClientId, "0", CHECKPOINT);
  assert.deepEqual(Object.keys(custom.checkpoint), ["at", "integrations"]);
});

test("the built-in Station's bindings are its own last reported ones, in the contract's shape and in R9 account order", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const built = await builtIn(s);
  const save = (stationId, fields) => s.db.transaction((client) => s.repository.saveBinding({
    stationId, r9AccountId: "r9-b", genesisHash: GENESIS, accountId: OWNER, bindingId: "bind-1", version: 1, bindingState: "bound", reportId: "rep-1", ...fields
  }, client));
  await save(built.id, {});
  await save(built.id, { r9AccountId: "r9-a", genesisHash: "c".repeat(64), accountId: MEMBER, bindingId: "bind-2", version: 3, bindingState: "released", reportId: "rep-2" });
  await save(built.id, { r9AccountId: "r9-a", genesisHash: "a".repeat(64), accountId: OTHER, bindingId: "bind-3", version: 2, bindingState: "unbound", reportId: "rep-3" });
  await save(built.id, { r9AccountId: "r9-B", genesisHash: GENESIS, bindingId: "bind-4", reportId: "rep-4" });
  await save(s.station.id, { r9AccountId: "r9-0", bindingId: "elsewhere", reportId: "rep-5" });
  await save(built.id, { version: 2, bindingId: "bind-5", reportId: "rep-6" });
  const { checkpoint } = await s.service.changes(built.reportClientId, "0", CHECKPOINT);
  // By R9 account in byte order (upper case before lower), then by genesis.
  assert.deepEqual(checkpoint.bindings, [
    { account: OWNER, accountId: "r9-B", genesisHash: GENESIS, bindingId: "bind-4", version: 1, bindingState: "bound" },
    { account: OTHER, accountId: "r9-a", genesisHash: "a".repeat(64), bindingId: "bind-3", version: 2, bindingState: "unbound" },
    { account: MEMBER, accountId: "r9-a", genesisHash: "c".repeat(64), bindingId: "bind-2", version: 3, bindingState: "released" },
    { account: OWNER, accountId: "r9-b", genesisHash: GENESIS, bindingId: "bind-5", version: 2, bindingState: "bound" }
  ]);
  for (const binding of checkpoint.bindings) assert.deepEqual(Object.keys(binding), ["account", "accountId", "genesisHash", "bindingId", "version", "bindingState"]);
  assert.equal(typeof checkpoint.bindings[0].version, "number");
});

test("during a rebuild the checkpoint says not complete and its disabled accounts are the live table, not the rebuild", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const built = await builtIn(s);
  const checkpoint = async () => s.service.changes(built.reportClientId, "0", CHECKPOINT);
  s.manage.accountChange(DISABLED, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await readAuthFeed(s);
  let answer = await checkpoint();
  assert.deepEqual(answer.checkpoint.accounts, { complete: true, disabled: [DISABLED] });

  // Auth enables that account and disables another; the Portal starts over (a reset) and rebuilds from the first entry.
  s.manage.accountChange(DISABLED, false, { actor: ADMIN, reason: "Mistake" });
  s.manage.accountChange(DISABLED_TOO, true, { actor: ADMIN, reason: "Abuse" });
  const epoch = await s.service.accountsStartingOver();
  const pass = { epoch };
  answer = await checkpoint();
  assert.deepEqual(answer.checkpoint.accounts, { complete: false, disabled: [DISABLED] }, "the live table, as it was");
  assert.equal((await s.service.changes(built.reportClientId, String(answer.cursor - 1))).changes[0].kind, "accounts_incomplete");
  assert.equal(answer.cursor, await newestEvent(s, built.id), "the signal is in the cursor");
  for (const entry of s.manage.feed) await s.service.applyAuthChange(entry, pass);
  answer = await checkpoint();
  assert.deepEqual(answer.checkpoint.accounts, { complete: false, disabled: [DISABLED] }, "the rebuild is not shown while it runs");

  // Caught up, the rebuild is the table: the differences are told, and the baseline it saw completes the view again.
  assert.equal(await s.service.accountsCaughtUp(pass), true);
  answer = await checkpoint();
  assert.deepEqual(answer.checkpoint.accounts, { complete: true, disabled: [DISABLED_TOO] });
  assert.equal(answer.cursor, await newestEvent(s, built.id));
});

test("the checkpoint is one snapshot: a writer inside its transaction shows in neither the cursor nor the rows, and its event comes after the cursor", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await s.approved();
  await s.service.report(client, { integrationId: id, state: "ready" });
  const before = await s.service.changes(client, "0", CHECKPOINT);
  assert.equal(before.checkpoint.integrations[0].state, "ready");

  // A second Portal replica whose repository holds the writer's transaction (and with it the event lock) once its event
  // and its row change are written, until released.
  let release;
  let arrived;
  const released = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { arrived = resolve; });
  t.after(() => release());
  const holding = {
    ...s.repository,
    async appendEvent(event, transaction) {
      const written = await s.repository.appendEvent(event, transaction);
      arrived();
      await released;
      return written;
    }
  };
  const writer = createIntegrationService({
    repository: holding, db: s.db, manage: s.manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, pushFetch: s.pushFetch,
    exchange: async () => ({}), now: () => s.clock.now, log: () => {}, delegatedHostWork: true
  });
  let settled = false;
  const writing = writer.revoke(OWNER, id, { interruptRunning: true });
  writing.then(() => { settled = true; }, () => { settled = true; });
  await Promise.race([reached, writing]);
  assert.equal(settled, false, "the writer is inside its transaction");
  assert.equal(await s.db.transaction(async (client) => (await client.query("SELECT pg_try_advisory_xact_lock(hashtext('portal_integration_events')) AS got")).rows[0].got), false, "and holds the event lock");

  // The checkpoint doesn't wait for the writer, and reflects neither its event nor its row change.
  let timer;
  const during = await Promise.race([s.service.changes(client, "0", CHECKPOINT), new Promise((resolve) => { timer = setTimeout(() => resolve("waited"), 5000); })]);
  clearTimeout(timer);
  assert.notEqual(during, "waited", "a checkpoint takes no lock");
  assert.equal(during.cursor, before.cursor);
  assert.deepEqual(during.checkpoint.integrations, before.checkpoint.integrations);
  assert.equal((await s.service.changes(client, String(before.cursor))).changes.length, 0, "the feed doesn't have the writer's event either");

  release();
  await writing;
  const after = await s.service.changes(client, "0", CHECKPOINT);
  assert.ok(after.cursor > during.cursor, "the writer's event is after the checkpoint's cursor");
  assert.equal(after.checkpoint.integrations[0].state, "revoking");
  assert.equal(after.checkpoint.integrations[0].interruptRunning, true);
  // Resuming at the earlier checkpoint's cursor delivers exactly that event, carrying the row change.
  const resumed = await s.service.changes(client, String(during.cursor));
  assert.deepEqual(resumed.changes.map((change) => [change.id, change.kind, change.integration.state]), [[after.cursor, "integration_revoked", "revoking"]]);
  await writer._pushesIdle();
});

test("commits made between the checkpoint's own reads show in none of them", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const built = await builtIn(s);
  const created = await s.service.createIntegration(OWNER, { stationId: built.id, name: "Hosted", scopes: [], publicJwk: publicJwk() });
  s.manage.accountChange(DISABLED, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const pass = await readAuthFeed(s);
  const before = await s.service.changes(built.reportClientId, "0", CHECKPOINT);
  assert.deepEqual([before.checkpoint.accounts, before.checkpoint.bindings, before.checkpoint.integrations.map((entry) => entry.state)], [{ complete: true, disabled: [DISABLED] }, [], ["awaiting_approval"]]);

  // After each of the checkpoint's reads, something it could have read commits: a revocation (row and event), another
  // account disabled, a binding.
  const afterRead = {
    latestCursor: () => s.db.transaction(async (client) => {
      await s.repository.lockEvents(client);
      await s.repository.updateIntegration(created.id, { state: "revoked", revokedAt: s.clock.now }, client);
      await s.repository.appendEvent({ stationId: built.id, integrationId: created.id, accountId: OWNER, actor: OWNER, kind: "integration_revoked", state: "revoked", reason: "owner" }, client);
    }),
    integrationsOnStation: async () => {
      s.manage.accountChange(DISABLED_TOO, true, { actor: ADMIN, reason: "Abuse" });
      assert.equal(await s.service.applyAuthChange(s.manage.feed.at(-1), pass), "applied");
    },
    disabledAccountList: () => s.db.transaction((client) => s.repository.saveBinding({ stationId: built.id, r9AccountId: "r9-a", genesisHash: GENESIS, accountId: OWNER, bindingId: "bind-1", version: 1, bindingState: "bound", reportId: "rep-1" }, client))
  };
  const ran = [];
  const reading = Object.fromEntries(Object.keys(s.repository).map((name) => [name, s.repository[name]]));
  for (const [name, hook] of Object.entries(afterRead)) {
    reading[name] = async (...args) => {
      const result = await s.repository[name](...args);
      if (!ran.includes(name)) { ran.push(name); await hook(); }
      return result;
    };
  }
  const reader = createIntegrationService({
    repository: reading, db: s.db, manage: s.manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, pushFetch: s.pushFetch,
    exchange: async () => ({}), now: () => s.clock.now, log: () => {}, delegatedHostWork: true
  });
  const answer = await reader.changes(built.reportClientId, "0", CHECKPOINT);
  assert.deepEqual(ran, ["latestCursor", "integrationsOnStation", "disabledAccountList"], "each of the writers ran between the reads");
  assert.deepEqual(answer, before, "the checkpoint is as it was when it began");
  // They all happened: the next checkpoint has them, at a later cursor, and the feed from the first has the revocation.
  const after = await s.service.changes(built.reportClientId, "0", CHECKPOINT);
  assert.ok(after.cursor > before.cursor);
  assert.deepEqual([after.checkpoint.accounts, after.checkpoint.bindings.length, after.checkpoint.integrations.map((entry) => entry.state)], [{ complete: true, disabled: [DISABLED, DISABLED_TOO] }, 1, ["revoked"]]);
  assert.ok((await s.service.changes(built.reportClientId, String(before.cursor))).changes.some((change) => change.kind === "integration_revoked"));
  await reader._pushesIdle();
});

test("with the setting off, asking for a checkpoint is ignored: the answer is today's cursor-0 answer", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const client = s.station.reportClientId;
  const id = await s.approved();
  await s.service.report(client, { integrationId: id, state: "ready" });
  const today = await s.service.changes(client, "0");
  assert.equal(Object.hasOwn(today, "checkpoint"), false);
  assert.deepEqual(await s.service.changes(client, "0", CHECKPOINT), today);
  assert.deepEqual(await s.service.changes(client, String(today.cursor), CHECKPOINT), await s.service.changes(client, String(today.cursor)));
  await assert.rejects(s.service.changes(client, String(today.cursor + 1), CHECKPOINT), refused(409, "cursor_ahead"), "the cursor check stays");
});
