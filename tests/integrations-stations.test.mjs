import assert from "node:assert/strict";
import test from "node:test";
import { ManageError } from "../scripts/integrations/auth-manage.mjs";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { createIntegrationService, fromManage } from "../scripts/integrations/service.mjs";
import { TokenError } from "../scripts/idp.mjs";
import { AppError } from "../scripts/store.mjs";
import { fakeManage } from "./helpers/fake-manage.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const OWNER = "ab" + "0".repeat(25) + "1";
const MEMBER = "ab" + "0".repeat(25) + "2";
const STRANGER = "ab" + "0".repeat(25) + "3";
const REPORT_KEY = { kty: "EC", crv: "P-256", x: "test-x", y: "test-y" };

async function setup(t, { wrap = (repository) => repository } = {}) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const manage = fakeManage();
  const clock = { now: Date.now() };
  const served = { status: 200, body: "" };
  const fetched = [];
  const stationFetch = { async get(url) { fetched.push(url); return { ...served }; } };
  const exchange = { refuse: null, calls: [] };
  const exchangeFn = async (idToken, origin) => {
    exchange.calls.push([idToken, origin]);
    if (exchange.refuse) throw new TokenError(exchange.refuse, "invalid_grant");
    return { accessToken: "read-token-for-" + origin, expiresIn: 300 };
  };
  let counter = 0;
  const notified = [];
  const logs = [];
  const service = createIntegrationService({
    repository: wrap(repository), db, manage, stationFetch, exchange: exchangeFn,
    now: () => clock.now, challengeValue: () => "proof-value-" + (++counter), notify: (stationId) => notified.push(stationId),
    log: (line) => logs.push(line)
  });
  // Register a Station for an account the way the browser does: a challenge, then the served value.
  async function register(accountId = OWNER, origin = "https://one.example") {
    const challenge = await service.createChallenge(accountId, origin);
    served.status = 200;
    served.body = challenge.value;
    return service.registerStation(accountId, { challengeId: challenge.challengeId, reportKey: REPORT_KEY });
  }
  const events = async (kind) => (await db.pool.query("SELECT * FROM integration_events" + (kind ? " WHERE kind = $1" : "") + " ORDER BY id", kind ? [kind] : [])).rows;
  return { db, repository, manage, clock, served, fetched, exchange, service, register, events, notified, logs };
}

const refused = (status, code, message) => (error) => {
  assert.ok(error instanceof AppError, "an AppError, not " + error);
  assert.equal(error.status, status);
  if (code !== undefined) assert.equal(error.details?.code, code);
  if (message !== undefined) assert.equal(error.message, message);
  return true;
};

async function seedIntegration(repository, id, stationId, ownerAccount, state) {
  await repository.insertIntegration({ id, ownerAccount, stationId, kind: "custom_app", name: "App " + id, scopes: ["agent.view"], quotaPerSecond: 200, expiresAt: new Date(Date.now() + 86400000) });
  if (state !== "awaiting_approval") await repository.updateIntegration(id, { state });
}

test("fromManage maps Auth's answers to Portal errors and rethrows anything else", () => {
  const cases = [
    [400, "jwk", 400, "jwk", "Auth refused this request."],
    [403, "forbidden", 403, "forbidden", "Only the Station owner can do this."],
    [404, "not_found", 404, "not_found", "This Station or integration was not found."],
    [409, "origin_taken", 409, "origin_taken", "This Station is already registered."],
    [409, "revoked", 409, "revoked", "This integration has been revoked."],
    [409, "duplicate_key", 409, "duplicate_key", "This key is already registered."],
    [409, "built_in", 409, "built_in", "The built-in Station is always there: it can't be removed, shared or left."],
    [409, "not_supported", 409, "not_supported", "Integrations aren't available on the built-in Station yet."],
    [503, "unavailable", 503, "unavailable", "Auth is unavailable. Try again shortly."],
    [500, "server_error", 503, "unavailable", "Auth is unavailable. Try again shortly."]
  ];
  for (const [status, code, mapped, mappedCode, message] of cases) {
    const error = fromManage(new ManageError(status, code));
    assert.ok(error instanceof AppError);
    assert.deepEqual([error.status, error.details, error.message], [mapped, { code: mappedCode }, message]);
  }
  const other = new Error("boom");
  assert.throws(() => fromManage(other), (error) => error === other);
});

test("full registration: challenge, proof, Auth, then Portal's row and event", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const challenge = await s.service.createChallenge(OWNER, "https://One.example/");
  assert.equal(challenge.origin, "https://one.example");
  assert.equal(challenge.url, "https://one.example/.well-known/agora-build-station");
  assert.equal(challenge.value, "proof-value-1");
  assert.match(challenge.challengeId, /^[0-9a-f-]{36}$/);
  assert.equal(challenge.expiresAt, new Date(s.clock.now + 600000).toISOString());
  s.served.body = challenge.value + "\n";
  const view = await s.service.registerStation(OWNER, { challengeId: challenge.challengeId, reportKey: REPORT_KEY });
  assert.deepEqual(s.fetched, [challenge.url]);
  assert.equal(view.id, "st1");
  assert.equal(view.origin, "https://one.example");
  assert.equal(view.role, "owner");
  assert.equal(view.ownerAccount, OWNER);
  assert.equal(view.status, "active");
  assert.equal(view.reportClientId, "s-st1");
  assert.ok(view.createdAt);
  const row = await s.repository.station("st1");
  assert.equal(row.reportClientId, "s-st1");
  const [event] = await s.events("station_registered");
  assert.deepEqual([event.station_id, event.actor, event.account_id], ["st1", OWNER, OWNER]);
  const listed = await s.service.stations(OWNER);
  assert.equal(listed.stale, false);
  assert.deepEqual(listed.stations.map((station) => station.id), ["st1"]);
  await assert.rejects(s.service.createChallenge(OWNER, "http://one.example"), (error) => error.status === 400);
});

test("a reused, expired, malformed or other account's challenge is refused before any fetch", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const expired = refused(400, "challenge", "This check has expired or was already used. Start again.");
  const used = await s.service.createChallenge(OWNER, "https://one.example");
  s.served.body = used.value;
  await s.service.registerStation(OWNER, { challengeId: used.challengeId, reportKey: REPORT_KEY });
  await assert.rejects(s.service.registerStation(OWNER, { challengeId: used.challengeId, reportKey: REPORT_KEY }), expired);
  const theirs = await s.service.createChallenge(STRANGER, "https://two.example");
  await assert.rejects(s.service.registerStation(OWNER, { challengeId: theirs.challengeId, reportKey: REPORT_KEY }), expired);
  const late = await s.service.createChallenge(OWNER, "https://three.example");
  s.clock.now += 600001;
  await assert.rejects(s.service.registerStation(OWNER, { challengeId: late.challengeId, reportKey: REPORT_KEY }), expired);
  for (const challengeId of ["not-a-uuid", "", undefined, 42]) await assert.rejects(s.service.registerStation(OWNER, { challengeId, reportKey: REPORT_KEY }), expired);
  assert.equal(s.fetched.length, 1);
  assert.equal(s.manage.calls.filter((name) => name === "registerStation").length, 1);
});

test("a report key that is not a small plain object is refused without using the challenge", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const challenge = await s.service.createChallenge(OWNER, "https://one.example");
  for (const reportKey of [undefined, null, "key", [REPORT_KEY], { big: "x".repeat(4100) }]) {
    await assert.rejects(s.service.registerStation(OWNER, { challengeId: challenge.challengeId, reportKey }), refused(400, "report_key"));
  }
  s.served.body = challenge.value;
  assert.equal((await s.service.registerStation(OWNER, { challengeId: challenge.challengeId, reportKey: REPORT_KEY })).id, "st1");
});

test("a proof mismatch is 422 with the reason, and Auth is not called", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const challenge = await s.service.createChallenge(OWNER, "https://one.example");
  s.served.body = "something else";
  await assert.rejects(s.service.registerStation(OWNER, { challengeId: challenge.challengeId, reportKey: REPORT_KEY }), (error) => {
    refused(422, "proof", "The Station did not serve the check value at https://one.example/.well-known/agora-build-station.")(error);
    assert.equal(error.details.reason, "mismatch");
    return true;
  });
  const second = await s.service.createChallenge(OWNER, "https://one.example");
  s.served.status = 404;
  await assert.rejects(s.service.registerStation(OWNER, { challengeId: second.challengeId, reportKey: REPORT_KEY }), (error) => error.details?.reason === "status_404");
  assert.deepEqual(s.manage.calls, []);
  assert.equal(await s.repository.station("st1"), null);
});

test("Auth's origin_taken is 409 and Portal records nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await assert.rejects(s.register(STRANGER, "https://one.example"), refused(409, "origin_taken", "This Station is already registered."));
  assert.equal((await s.events("station_registered")).length, 1);
  assert.deepEqual((await s.service.stations(STRANGER)).stations, []);
});

test("a Portal write failing after Auth's success is reconciled by the next listing", async (t) => {
  let failOnce = true;
  const s = await setup(t, {
    wrap: (repository) => ({
      ...repository,
      async insertStation(...args) {
        if (failOnce) { failOnce = false; throw new Error("insert failed"); }
        return repository.insertStation(...args);
      }
    })
  });
  if (!s) return;
  await assert.rejects(s.register(OWNER, "https://one.example"), /insert failed/);
  assert.equal(await s.repository.station("st1"), null);
  assert.deepEqual(await s.events(), [], "the event rolled back with the failed insert");
  assert.deepEqual(s.notified, []);
  const listed = await s.service.stations(OWNER);
  assert.deepEqual(s.notified, ["st1"], "the reconciled Station is pushed to");
  assert.equal(listed.stale, false);
  assert.deepEqual(listed.stations.map((station) => [station.id, station.role]), [["st1", "owner"]]);
  const row = await s.repository.station("st1");
  assert.equal(row.verifiedAt, s.manage.records[0].createdAt);
  const [event] = await s.events("station_reconciled");
  assert.deepEqual([event.station_id, event.actor, event.account_id], ["st1", "system", OWNER]);
  await s.service.stations(OWNER);
  assert.equal((await s.events("station_reconciled")).length, 1, "reconciling twice adds nothing");
  assert.deepEqual(s.notified, ["st1"]);
});

test("a Station Auth no longer lists is removed in Portal with its integrations revoked", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await seedIntegration(s.repository, "i-ready", "st1", OWNER, "ready");
  s.manage.records[0].status = "removed";
  assert.deepEqual(s.notified, [], "registering does not push");
  const listed = await s.service.stations(OWNER);
  assert.deepEqual(listed.stations, []);
  assert.deepEqual(s.notified, ["st1"]);
  assert.equal((await s.repository.station("st1")).status, "removed");
  assert.equal((await s.repository.integration("i-ready")).state, "revoked");
  const [event] = await s.events("station_removed");
  assert.deepEqual([event.actor, event.reason], ["system", "reconciled"]);
  const [revoked] = await s.events("integration_revoked");
  assert.deepEqual([revoked.integration_id, revoked.state, revoked.reason], ["i-ready", "revoked", "reconciled"]);
});

test("a stale active Station at an origin Auth has given to another Station is retired, not a 500", async (t) => {
  const s = await setup(t);
  if (!s) return;
  // Auth removed st1 and registered st2 at the same origin, but Portal's half of the removal never happened.
  await s.register(OWNER, "https://one.example");
  await seedIntegration(s.repository, "i-ready", "st1", OWNER, "ready");
  s.manage.records[0].status = "removed";
  await s.manage.registerStation({ origin: "https://one.example", owner: OWNER, reportKey: REPORT_KEY, actor: OWNER });
  const listed = await s.service.stations(OWNER);
  assert.deepEqual(listed.stations.map((station) => [station.id, station.origin]), [["st2", "https://one.example"]]);
  assert.equal((await s.repository.station("st1")).status, "removed");
  assert.equal((await s.repository.integration("i-ready")).state, "revoked");
  assert.deepEqual((await s.events("station_removed")).map((event) => [event.station_id, event.reason]), [["st1", "reconciled"]]);
  assert.deepEqual(s.notified.sort(), ["st1", "st2"]);
});

test("another account's stale Station at the origin is retired when it is registered or listed again", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(STRANGER, "https://one.example");
  await seedIntegration(s.repository, "i-theirs", "st1", STRANGER, "ready");
  s.manage.records[0].status = "removed";
  const view = await s.register(OWNER, "https://one.example");
  assert.equal(view.id, "st2");
  assert.equal((await s.repository.station("st1")).status, "removed");
  assert.equal((await s.repository.integration("i-theirs")).state, "revoked");
  const [removed] = await s.events("station_removed");
  assert.deepEqual([removed.station_id, removed.actor, removed.account_id, removed.reason], ["st1", "system", STRANGER, "reconciled"]);
  assert.deepEqual(s.notified, ["st1"], "the retired Station is told");
  // The same through a listing: Auth gives the origin to st3 while Portal still has st2 active there.
  s.manage.records[1].status = "removed";
  await s.manage.registerStation({ origin: "https://one.example", owner: MEMBER, reportKey: REPORT_KEY, actor: MEMBER });
  assert.deepEqual((await s.service.stations(MEMBER)).stations.map((station) => station.id), ["st3"]);
  assert.equal((await s.repository.station("st2")).status, "removed");
});

test("a Station Auth lists that Portal has as removed is logged, not silently skipped", async (t) => {
  const logs = [];
  const s = await setup(t);
  if (!s) return;
  const service = createIntegrationService({ repository: s.repository, db: s.db, manage: s.manage, stationFetch: { get: async () => ({}) }, exchange: async () => ({}), log: (line) => logs.push(line), notify: () => {} });
  await s.register(OWNER, "https://one.example");
  await s.db.pool.query("UPDATE stations SET status = 'removed', removed_at = now() WHERE id = 'st1'");
  assert.deepEqual((await service.stations(OWNER)).stations, []);
  assert.ok(logs.includes("Station listed by Auth is removed in Portal: not restored."));
});

test("with Auth down the listing answers Portal's rows marked stale", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  s.manage.down = true;
  const listed = await s.service.stations(OWNER);
  assert.equal(listed.stale, true);
  assert.deepEqual(listed.stations.map((station) => station.id), ["st1"]);
  await assert.rejects(s.service.share(OWNER, "st1", MEMBER), refused(503, "unavailable"));
});

test("sharing: the owner shares, members see the Station without its report client, and a stranger is refused", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await s.service.share(OWNER, "st1", MEMBER);
  await s.service.share(OWNER, "st1", MEMBER);
  assert.equal((await s.events("member_added")).length, 1, "sharing again with a current member records nothing");
  assert.deepEqual(s.notified, ["st1"], "only the recorded share is pushed");
  const [added] = await s.events("member_added");
  assert.deepEqual([added.station_id, added.actor, added.account_id], ["st1", OWNER, MEMBER]);
  assert.deepEqual((await s.repository.currentMembers("st1")).map((member) => member.accountId), [MEMBER]);
  const theirs = await s.service.stations(MEMBER);
  assert.deepEqual(theirs.stations.map((station) => [station.id, station.role, station.ownerAccount]), [["st1", "member", OWNER]]);
  assert.equal(theirs.stations[0].reportClientId, undefined);
  const members = await s.service.members(MEMBER, "st1");
  assert.equal(members.owner, OWNER);
  assert.deepEqual(members.members.map((member) => member.account), [MEMBER]);
  assert.ok(members.members[0].addedAt);
  const calls = s.manage.calls.length;
  const hidden = refused(404, "not_found", "This Station or integration was not found.");
  await assert.rejects(s.service.members(STRANGER, "st1"), hidden);
  await assert.rejects(s.service.share(STRANGER, "st1", STRANGER), hidden);
  await assert.rejects(s.service.unshare(STRANGER, "st1", MEMBER), hidden);
  await assert.rejects(s.service.removeStation(STRANGER, "st1"), hidden);
  const ownerOnly = refused(403, "forbidden", "Only the Station owner can do this.");
  await assert.rejects(s.service.share(MEMBER, "st1", STRANGER), ownerOnly);
  await assert.rejects(s.service.unshare(MEMBER, "st1", OWNER), ownerOnly);
  assert.equal(s.manage.calls.length, calls, "neither a stranger nor a member's owner-only change reaches Auth");
  assert.deepEqual((await s.repository.currentMembers("st1")).map((member) => member.accountId), [MEMBER], "Portal changed nothing");
  assert.equal((await s.events("member_removed")).length, 0);
  for (const bad of ["not-an-account", OWNER]) {
    await assert.rejects(s.service.share(OWNER, "st1", bad), (error) => error.status === 400);
  }
  await assert.rejects(s.service.share(OWNER, "missing", MEMBER), refused(404));
  await assert.rejects(s.service.members(OWNER, "missing"), refused(404));
  assert.equal(s.manage.calls.length, calls, "unknown Stations are not asked about at Auth");
  assert.deepEqual(s.notified, ["st1"], "refused changes push nothing");
});

test("unsharing by the owner or the member themself revokes that member's integrations on the Station", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await s.register(OWNER, "https://two.example");
  await s.service.share(OWNER, "st1", MEMBER);
  await s.service.share(OWNER, "st2", MEMBER);
  await seedIntegration(s.repository, "i-ready", "st1", MEMBER, "ready");
  await seedIntegration(s.repository, "i-waiting", "st1", MEMBER, "awaiting_approval");
  await seedIntegration(s.repository, "i-owner", "st1", OWNER, "ready");
  await seedIntegration(s.repository, "i-other", "st2", MEMBER, "ready");
  s.notified.length = 0;
  await s.service.unshare(OWNER, "st1", MEMBER);
  assert.deepEqual(s.notified, ["st1"]);
  assert.equal((await s.repository.integration("i-ready")).state, "revoking");
  assert.equal((await s.repository.integration("i-waiting")).state, "revoked");
  assert.equal((await s.repository.integration("i-owner")).state, "ready");
  assert.equal((await s.repository.integration("i-other")).state, "ready");
  const revoked = await s.events("integration_revoked");
  assert.deepEqual(revoked.map((event) => [event.integration_id, event.state, event.reason, event.actor, event.account_id]), [
    ["i-ready", "revoking", "member_removed", OWNER, MEMBER],
    ["i-waiting", "revoked", "member_removed", OWNER, MEMBER]
  ]);
  const [removed] = await s.events("member_removed");
  assert.deepEqual([removed.station_id, removed.actor, removed.account_id], ["st1", OWNER, MEMBER]);
  assert.deepEqual((await s.repository.currentMembers("st1")), []);
  assert.deepEqual((await s.service.stations(MEMBER)).stations.map((station) => station.id), ["st2"]);
  await s.service.unshare(MEMBER, "st2", MEMBER);
  assert.deepEqual(s.notified, ["st1", "st2"]);
  assert.equal((await s.repository.integration("i-other")).state, "revoking");
  const [, self] = await s.events("member_removed");
  assert.deepEqual([self.station_id, self.actor, self.account_id], ["st2", MEMBER, MEMBER]);
  assert.deepEqual((await s.service.stations(MEMBER)).stations, []);
});

test("removing a Station revokes all its integrations; only the owner may", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await s.service.share(OWNER, "st1", MEMBER);
  await seedIntegration(s.repository, "i-ready", "st1", MEMBER, "ready");
  await seedIntegration(s.repository, "i-waiting", "st1", OWNER, "awaiting_approval");
  await seedIntegration(s.repository, "i-done", "st1", OWNER, "revoked");
  s.notified.length = 0;
  const calls = s.manage.calls.length;
  await assert.rejects(s.service.removeStation(MEMBER, "st1"), refused(403, "forbidden"));
  assert.equal(s.manage.calls.length, calls, "a member's removal is refused before Auth");
  assert.equal((await s.repository.station("st1")).status, "active");
  assert.deepEqual(s.notified, []);
  await s.service.removeStation(OWNER, "st1");
  assert.deepEqual(s.notified, ["st1"], "the removed Station is pushed to once");
  assert.equal((await s.repository.station("st1")).status, "removed");
  assert.equal((await s.repository.integration("i-ready")).state, "revoking");
  assert.equal((await s.repository.integration("i-waiting")).state, "revoked");
  const revoked = await s.events("integration_revoked");
  assert.deepEqual(revoked.map((event) => [event.integration_id, event.state, event.reason, event.account_id]), [
    ["i-ready", "revoking", "station_removed", MEMBER],
    ["i-waiting", "revoked", "station_removed", OWNER]
  ]);
  const [removed] = await s.events("station_removed");
  assert.deepEqual([removed.station_id, removed.actor, removed.account_id, removed.reason], ["st1", OWNER, OWNER, null]);
  assert.deepEqual((await s.service.stations(OWNER)).stations, []);
  const removedCalls = s.manage.calls.length;
  await assert.rejects(s.service.removeStation(OWNER, "st1"), refused(404, "not_found"));
  assert.equal(s.manage.calls.length, removedCalls, "a removed Station is not asked about at Auth");
  assert.deepEqual(s.notified, ["st1"]);
});

test("unsharing someone Portal does not count a member still asks Auth but records nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await s.service.share(OWNER, "st1", MEMBER);
  await s.service.unshare(OWNER, "st1", MEMBER);
  s.notified.length = 0;
  await s.service.unshare(OWNER, "st1", MEMBER);
  assert.equal(s.manage.calls.filter((name) => name === "removeMember").length, 2);
  assert.equal((await s.events("member_removed")).length, 1, "a repeated unshare adds no event");
  assert.deepEqual(s.notified, [], "and pushes nothing");
});

test("a change waits for the event lock before locking any integration row, so it cannot deadlock with another", async (t) => {
  let reached;
  const waiting = new Promise((done) => { reached = done; });
  const s = await setup(t, { wrap: (repository) => ({ ...repository, async lockEvents(client) { reached(); return repository.lockEvents(client); } }) });
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await seedIntegration(s.repository, "i-one", "st1", OWNER, "ready");
  await seedIntegration(s.repository, "i-two", "st1", OWNER, "ready");
  const holder = await s.db.pool.connect();
  const other = await s.db.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'))");
    const removal = s.service.removeStation(OWNER, "st1");
    await Promise.race([waiting, new Promise((done) => setTimeout(done, 300))]);
    await new Promise((done) => setTimeout(done, 100));
    await other.query("BEGIN");
    // Before the fix, the removal held i-one's row lock while it waited for the event lock.
    const { rows } = await other.query("SELECT id FROM integrations WHERE station_id = 'st1' ORDER BY id FOR UPDATE NOWAIT");
    assert.deepEqual(rows.map((row) => row.id), ["i-one", "i-two"]);
    await other.query("ROLLBACK");
    await holder.query("COMMIT");
    await removal;
  } finally {
    await other.query("ROLLBACK").catch(() => {});
    await holder.query("ROLLBACK").catch(() => {});
    other.release();
    holder.release();
  }
  assert.equal((await s.repository.integration("i-one")).state, "revoking");
});

test("readToken exchanges the session's ID token for a Station the account can use", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await s.service.share(OWNER, "st1", MEMBER);
  assert.deepEqual(await s.service.readToken(MEMBER, "member-id-token", "st1"), { accessToken: "read-token-for-https://one.example", expiresIn: 300, origin: "https://one.example" });
  assert.deepEqual(s.exchange.calls, [["member-id-token", "https://one.example"]]);
  await assert.rejects(s.service.readToken(STRANGER, "stranger-id-token", "st1"), refused(404, "not_found", "This Station or integration was not found."));
  await assert.rejects(s.service.readToken(OWNER, null, "st1"), refused(401, undefined, "Sign in again to read this Station's details."));
  s.exchange.refuse = 401;
  await assert.rejects(s.service.readToken(OWNER, "owner-id-token", "st1"), refused(403, "exchange", "Auth did not allow reading this Station."));
  s.exchange.refuse = 503;
  await assert.rejects(s.service.readToken(OWNER, "owner-id-token", "st1"), refused(503));
  assert.equal(s.exchange.calls.length, 3);
});

test("an account may start at most 10 Station checks an hour", async (t) => {
  const s = await setup(t);
  if (!s) return;
  for (let index = 0; index < 10; index++) await s.service.createChallenge(OWNER, "https://one.example");
  await assert.rejects(s.service.createChallenge(OWNER, "https://one.example"), refused(429, undefined, "Too many Station checks. Try again later."));
  await s.service.createChallenge(MEMBER, "https://one.example");
  s.clock.now += 3600001;
  await s.service.createChallenge(OWNER, "https://one.example");
});

test("a membership Auth has but Portal lacks is added by the member's next listing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  s.manage.records[0].members.push({ account: MEMBER, addedAt: new Date().toISOString() });
  const listed = await s.service.stations(MEMBER);
  assert.deepEqual(s.notified, ["st1"]);
  assert.deepEqual(listed.stations.map((station) => [station.id, station.role]), [["st1", "member"]]);
  const [added] = await s.events("member_added");
  assert.deepEqual([added.actor, added.account_id, added.reason], ["system", MEMBER, "reconciled"]);
  await s.service.stations(MEMBER);
  assert.equal((await s.events("member_added")).length, 1);
  assert.deepEqual(s.notified, ["st1"]);
});

test("a membership Auth has dropped is removed by the member's next listing, revoking their integrations there", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await s.register(OWNER, "https://two.example");
  await s.service.share(OWNER, "st1", MEMBER);
  await s.service.share(OWNER, "st2", MEMBER);
  await seedIntegration(s.repository, "i-ready", "st1", MEMBER, "ready");
  await seedIntegration(s.repository, "i-waiting", "st1", MEMBER, "awaiting_approval");
  await seedIntegration(s.repository, "i-owner", "st1", OWNER, "ready");
  await seedIntegration(s.repository, "i-other", "st2", MEMBER, "ready");
  s.manage.records[0].members = [];
  s.notified.length = 0;
  s.manage.down = true;
  assert.deepEqual((await s.service.stations(MEMBER)).stations.map((station) => station.id), ["st1", "st2"], "nothing changes while Auth is down");
  assert.equal((await s.events("member_removed")).length, 0);
  assert.deepEqual(s.notified, []);
  s.manage.down = false;
  const listed = await s.service.stations(MEMBER);
  assert.deepEqual(listed.stations.map((station) => station.id), ["st2"]);
  assert.deepEqual(s.notified, ["st1"]);
  assert.deepEqual(await s.repository.currentMembers("st1"), []);
  assert.equal((await s.repository.integration("i-ready")).state, "revoking");
  assert.equal((await s.repository.integration("i-waiting")).state, "revoked");
  assert.equal((await s.repository.integration("i-owner")).state, "ready");
  assert.equal((await s.repository.integration("i-other")).state, "ready");
  const revoked = await s.events("integration_revoked");
  assert.deepEqual(revoked.map((event) => [event.integration_id, event.state, event.reason, event.actor, event.account_id]), [
    ["i-ready", "revoking", "member_removed", "system", MEMBER],
    ["i-waiting", "revoked", "member_removed", "system", MEMBER]
  ]);
  const [removed] = await s.events("member_removed");
  assert.deepEqual([removed.station_id, removed.actor, removed.account_id, removed.reason], ["st1", "system", MEMBER, "reconciled"]);
  await assert.rejects(s.service.readToken(MEMBER, "member-id-token", "st1"), refused(404, "not_found"));
  await s.service.stations(MEMBER);
  assert.equal((await s.events("member_removed")).length, 1, "reconciling twice adds nothing");
  assert.deepEqual(s.notified, ["st1"]);
  assert.equal((await s.repository.station("st1")).status, "active", "the owner's Station stays");
});

const BUILT_IN = "https://station.agora.test";
const BUILT_IN_FIXED = "The built-in Station is always there: it can't be removed, shared or left.";

test("every account lists the built-in Station first, with no owner or report client, and a listing without it removes nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  const mine = await s.register(OWNER);
  const listed = await s.service.stations(OWNER);
  assert.deepEqual(listed.stations.map((station) => [station.id, station.role]), [[built.id, "built_in"], [mine.id, "owner"]]);
  assert.deepEqual(listed.stations[0], { id: built.id, origin: BUILT_IN, role: "built_in", ownerAccount: null, status: "active", createdAt: listed.stations[0].createdAt, builtIn: true, name: "Agora Station", integrationsEnabled: false });
  assert.deepEqual([listed.stations[1].builtIn, listed.stations[1].name, listed.stations[1].integrationsEnabled], [false, null, true]);
  assert.deepEqual((await s.service.stations(STRANGER)).stations.map((station) => [station.id, station.role]), [[built.id, "built_in"]]);
  const reconciled = (await s.events("station_reconciled")).filter((row) => row.station_id === built.id);
  assert.deepEqual(reconciled.map((row) => [row.account_id, row.actor]), [["system", "system"]], "recorded once, as system");
  assert.deepEqual(await s.repository.currentMembers(built.id), [], "nobody is made a member");
  // A listing that lacks it (a stale answer, a bug at Auth) never removes it or revokes its integrations.
  await seedIntegration(s.repository, "i-b1", built.id, STRANGER, "ready");
  s.manage.records.splice(s.manage.records.indexOf(built), 1);
  assert.deepEqual((await s.service.stations(OWNER)).stations.map((station) => station.id), [built.id, mine.id]);
  assert.equal((await s.repository.station(built.id)).status, "active");
  assert.equal((await s.repository.integration("i-b1")).state, "ready");
  assert.equal((await s.events("station_removed")).length, 0);
});


test("a built-in Station Auth lists as a custom one is left as it is (no owner, no members)", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  await s.service.stations(OWNER);
  Object.assign(built, { builtIn: false, access: "members", owner: OWNER, members: [{ account: MEMBER }] });
  await s.service.stations(MEMBER);
  assert.deepEqual(await s.repository.currentMembers(built.id), [], "nobody is made a member");
  const row = await s.repository.station(built.id);
  assert.deepEqual([row.builtIn, row.ownerAccount, row.status], [true, null, "active"]);
  assert.ok(s.logs.includes("Built-in Station listed by Auth as a custom Station: left as it is."));
});
test("the built-in Station follows Auth's integrations setting and name on every listing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  await s.service.stations(OWNER);
  built.integrations = true;
  built.name = "Agora Station (dev)";
  const [first] = (await s.service.stations(MEMBER)).stations;
  assert.deepEqual([first.integrationsEnabled, first.name], [true, "Agora Station (dev)"]);
});

test("removing, sharing, leaving or listing the members of the built-in Station is 409 built_in without asking Auth", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn({ admins: [OWNER] });
  await s.service.stations(OWNER);
  const calls = s.manage.calls.length;
  for (const [what, run] of [
    ["remove", () => s.service.removeStation(OWNER, built.id)],
    ["share", () => s.service.share(OWNER, built.id, MEMBER)],
    ["unshare", () => s.service.unshare(OWNER, built.id, MEMBER)],
    ["leave", () => s.service.unshare(MEMBER, built.id, MEMBER)],
    ["members", () => s.service.members(MEMBER, built.id)]
  ]) await assert.rejects(run(), refused(409, "built_in", BUILT_IN_FIXED), what);
  assert.equal(s.manage.calls.length, calls, "Auth is not asked");
  // Auth answers the same requests the same way.
  await assert.rejects(s.manage.removeStation(built.id, OWNER), (error) => error.status === 409 && error.code === "built_in");
  await assert.rejects(s.manage.members(built.id, OWNER), (error) => error.status === 409 && error.code === "built_in");
});

test("the built-in Station's origin can't be checked or registered, and no proof is fetched", async (t) => {
  const s = await setup(t);
  if (!s) return;
  s.manage.seedBuiltIn();
  const early = await s.service.createChallenge(OWNER, BUILT_IN); // before the Portal knows the built-in Station
  await s.service.stations(OWNER);
  await assert.rejects(s.service.createChallenge(OWNER, BUILT_IN), refused(409, "origin_taken", "This is the built-in Station. Every account already has it."));
  await assert.rejects(s.service.createChallenge(OWNER, BUILT_IN + "/"), refused(409, "origin_taken"));
  await assert.rejects(s.service.registerStation(OWNER, { challengeId: early.challengeId, reportKey: REPORT_KEY }), refused(409, "origin_taken"));
  assert.deepEqual(s.fetched, []);
});

test("any account gets a read token for the built-in Station", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  await s.service.stations(OWNER);
  assert.deepEqual(await s.service.readToken(STRANGER, "id-token", built.id), { accessToken: "read-token-for-" + BUILT_IN, expiresIn: 300, origin: BUILT_IN });
});

test("a new built-in Station at the same origin retires the old one in Portal, with its integrations", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const old = s.manage.seedBuiltIn({ id: "stold" });
  await s.service.stations(OWNER);
  await seedIntegration(s.repository, "i-old", old.id, OWNER, "ready");
  old.status = "removed";
  s.manage.seedBuiltIn({ id: "stnew", reportClientId: "s-" + "0".repeat(24) + "bt" });
  assert.deepEqual((await s.service.stations(MEMBER)).stations.map((station) => station.id), ["stnew"]);
  assert.equal((await s.repository.station("stold")).status, "removed");
  assert.equal((await s.repository.integration("i-old")).state, "revoked");
  assert.deepEqual((await s.events("station_removed")).map((row) => [row.station_id, row.account_id, row.reason]), [["stold", "system", "reconciled"]]);
});

test("syncBuiltIn brings in the built-in Stations from Auth's listing that names no account, follows their settings and adds nothing else", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  await s.manage.registerStation({ origin: "https://custom.example", owner: OWNER, reportKey: REPORT_KEY, actor: OWNER });
  assert.equal(await s.service.syncBuiltIn(), true);
  assert.deepEqual(s.manage.calls.filter((name) => name !== "registerStation"), ["builtInStations"], "no account's listing is asked for");
  assert.deepEqual((await s.repository.builtInStations()).map((station) => [station.id, station.reportClientId, station.integrationsEnabled]), [[built.id, built.reportClientId, false]]);
  assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM stations WHERE NOT built_in")).rows[0].n, 0, "custom Stations are left to their accounts' listings");
  assert.equal((await s.repository.stationByReportClient(built.reportClientId)).id, built.id, "its report client is known without anyone signing in");
  built.integrations = true;
  assert.equal(await s.service.syncBuiltIn(), true);
  assert.equal((await s.repository.station(built.id)).integrationsEnabled, true);
  assert.equal((await s.events("station_reconciled")).length, 1, "inserted once");
});

test("syncBuiltIn with Auth down, or an Auth without the listing, changes nothing and is logged by reason", async (t) => {
  const s = await setup(t);
  if (!s) return;
  s.manage.seedBuiltIn();
  s.manage.down = true;
  assert.equal(await s.service.syncBuiltIn(), false);
  assert.ok(s.logs.includes("Built-in Station sync failed: unavailable."));
  s.manage.down = false;
  s.manage.failNext.builtInStations = { status: 404, code: "not_found" };
  assert.equal(await s.service.syncBuiltIn(), false);
  assert.ok(s.logs.includes("Built-in Station sync failed: not_found."));
  assert.deepEqual(await s.repository.builtInStations(), []);
});

test("a sync whose listing lacks a built-in Station removes nothing and revokes nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  await s.service.syncBuiltIn();
  await seedIntegration(s.repository, "i-kept", built.id, OWNER, "ready");
  s.manage.records.splice(s.manage.records.indexOf(built), 1);
  assert.equal(await s.service.syncBuiltIn(), true);
  assert.equal((await s.repository.station(built.id)).status, "active");
  assert.equal((await s.repository.integration("i-kept")).state, "ready");
  assert.ok(s.logs.includes("Built-in Station absent from Auth's listing: left as it is."));
});
