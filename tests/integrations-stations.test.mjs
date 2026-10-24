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
  const service = createIntegrationService({
    repository: wrap(repository), db, manage, stationFetch, exchange: exchangeFn,
    now: () => clock.now, challengeValue: () => "proof-value-" + (++counter)
  });
  // Register a Station for an account the way the browser does: a challenge, then the served value.
  async function register(accountId = OWNER, origin = "https://one.example") {
    const challenge = await service.createChallenge(accountId, origin);
    served.status = 200;
    served.body = challenge.value;
    return service.registerStation(accountId, { challengeId: challenge.challengeId, reportKey: REPORT_KEY });
  }
  const events = async (kind) => (await db.pool.query("SELECT * FROM integration_events" + (kind ? " WHERE kind = $1" : "") + " ORDER BY id", kind ? [kind] : [])).rows;
  return { db, repository, manage, clock, served, fetched, exchange, service, register, events };
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
  const listed = await s.service.stations(OWNER);
  assert.equal(listed.stale, false);
  assert.deepEqual(listed.stations.map((station) => [station.id, station.role]), [["st1", "owner"]]);
  const row = await s.repository.station("st1");
  assert.equal(row.verifiedAt, s.manage.records[0].createdAt);
  const [event] = await s.events("station_reconciled");
  assert.deepEqual([event.station_id, event.actor, event.account_id], ["st1", "system", OWNER]);
  await s.service.stations(OWNER);
  assert.equal((await s.events("station_reconciled")).length, 1, "reconciling twice adds nothing");
});

test("a Station Auth no longer lists is removed in Portal with its integrations revoked", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.register(OWNER, "https://one.example");
  await seedIntegration(s.repository, "i-ready", "st1", OWNER, "ready");
  s.manage.records[0].status = "removed";
  const listed = await s.service.stations(OWNER);
  assert.deepEqual(listed.stations, []);
  assert.equal((await s.repository.station("st1")).status, "removed");
  assert.equal((await s.repository.integration("i-ready")).state, "revoked");
  const [event] = await s.events("station_removed");
  assert.deepEqual([event.actor, event.reason], ["system", "reconciled"]);
  const [revoked] = await s.events("integration_revoked");
  assert.deepEqual([revoked.integration_id, revoked.state, revoked.reason], ["i-ready", "revoked", "reconciled"]);
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
  await assert.rejects(s.service.members(STRANGER, "st1"), refused(403, "forbidden", "Only the Station owner can do this."));
  await assert.rejects(s.service.share(STRANGER, "st1", STRANGER), refused(403, "forbidden"));
  await assert.rejects(s.service.share(MEMBER, "st1", STRANGER), refused(403, "forbidden"));
  await assert.rejects(s.service.unshare(STRANGER, "st1", MEMBER), refused(403, "forbidden"));
  assert.deepEqual((await s.repository.currentMembers("st1")).map((member) => member.accountId), [MEMBER], "Portal changed nothing");
  assert.equal((await s.events("member_removed")).length, 0);
  for (const bad of ["not-an-account", OWNER]) {
    await assert.rejects(s.service.share(OWNER, "st1", bad), (error) => error.status === 400);
  }
  await assert.rejects(s.service.share(OWNER, "missing", MEMBER), refused(404));
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
  await s.service.unshare(OWNER, "st1", MEMBER);
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
  await assert.rejects(s.service.removeStation(MEMBER, "st1"), refused(403, "forbidden"));
  assert.equal((await s.repository.station("st1")).status, "active");
  await s.service.removeStation(OWNER, "st1");
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
  await assert.rejects(s.service.removeStation(OWNER, "st1"), refused(404, "not_found"));
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
  assert.deepEqual(listed.stations.map((station) => [station.id, station.role]), [["st1", "member"]]);
  const [added] = await s.events("member_added");
  assert.deepEqual([added.actor, added.account_id, added.reason], ["system", MEMBER, "reconciled"]);
  await s.service.stations(MEMBER);
  assert.equal((await s.events("member_added")).length, 1);
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
  s.manage.down = true;
  assert.deepEqual((await s.service.stations(MEMBER)).stations.map((station) => station.id), ["st1", "st2"], "nothing changes while Auth is down");
  assert.equal((await s.events("member_removed")).length, 0);
  s.manage.down = false;
  const listed = await s.service.stations(MEMBER);
  assert.deepEqual(listed.stations.map((station) => station.id), ["st2"]);
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
  assert.equal((await s.repository.station("st1")).status, "active", "the owner's Station stays");
});
