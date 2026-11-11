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
const DAY = 86400000;
const R9 = "a".repeat(64);

const publicJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });

// `delegatedHostWork` turns the setting on in the service (D29), and Auth's side with it unless `authDelegated` says
// otherwise (an Auth with its setting off refuses interruptRunning).
async function setup(t, { wrap = (repository) => repository, delegatedHostWork = false, authDelegated = delegatedHostWork } = {}) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const clock = { now: Date.now() };
  const manage = fakeManage({ now: () => clock.now, delegated: authDelegated });
  const served = { status: 200, body: "" };
  const stationFetch = { async get() { return { ...served }; } };
  const notified = [];
  const logs = [];
  let counter = 0;
  let asked = 0;
  const service = createIntegrationService({
    repository: wrap(repository), db, manage, stationFetch, exchange: async () => ({}), now: () => clock.now, log: (line) => logs.push(line),
    challengeValue: () => "proof-value-" + (++counter), notify: (stationId) => notified.push(stationId), authChanged: () => { asked += 1; }, delegatedHostWork
  });
  async function register(accountId = OWNER, origin = "https://one.example") {
    const challenge = await service.createChallenge(accountId, origin);
    served.body = challenge.value;
    return service.registerStation(accountId, { challengeId: challenge.challengeId, reportKey: publicJwk() });
  }
  const station = await register();
  const create = (accountId = OWNER, fields = {}) => service.createIntegration(accountId, { stationId: station.id, name: "My app", scopes: [], publicJwk: publicJwk(), ...fields });
  const events = async (kind) => (await db.pool.query("SELECT * FROM integration_events WHERE integration_id IS NOT NULL" + (kind ? " AND kind = $1" : "") + " ORDER BY id", kind ? [kind] : [])).rows;
  const authCalls = (name) => manage.calls.filter((call) => call === name).length;
  const record = (id) => manage.integrationRecords.find((entry) => entry.clientId === id);
  return { db, repository, manage, clock, service, station, register, create, events, authCalls, record, notified, logs, authAsked: () => asked };
}

const refused = (status, code) => (error) => {
  assert.ok(error instanceof AppError, "an AppError, not " + error);
  assert.equal(error.status, status);
  if (code !== undefined) assert.equal(error.details?.code, code);
  return true;
};

test("createIntegration adds agent.view, uses the defaults and records the creation after Auth", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const view = await s.create(OWNER, { name: "  My app  ", scopes: ["agent.prompt"] });
  const auth = s.record(view.id);
  assert.deepEqual(auth.scopes, ["agent.view", "agent.prompt"]);
  assert.equal(auth.quotaPerSecond, 200);
  assert.equal(auth.expiresAt, new Date(s.clock.now + 30 * DAY).toISOString());
  assert.deepEqual(view, {
    id: auth.clientId, kind: "custom_app", name: "My app", stationId: s.station.id, stationOrigin: "https://one.example",
    scopes: ["agent.view", "agent.prompt"], state: "awaiting_approval", pausedFrom: null, pausedBy: null, r9Svc: null, quotaPerSecond: 200,
    expiresAt: auth.expiresAt, approvedAt: null, lastError: null, createdAt: view.createdAt, role: "owner"
  });
  const [event] = await s.events("integration_created");
  assert.deepEqual([event.account_id, event.actor, event.state, event.details], [OWNER, OWNER, "awaiting_approval", { scopes: ["agent.view", "agent.prompt"], name: "My app" }]);
  assert.deepEqual(s.notified, [s.station.id]);
  const custom = await s.create(OWNER, { scopes: ["agent.view", "agent.terminal"], quotaPerSecond: 50, expiresInDays: 90 });
  assert.deepEqual([custom.scopes, custom.quotaPerSecond, custom.expiresAt], [["agent.view", "agent.terminal"], 50, new Date(s.clock.now + 90 * DAY).toISOString()]);
});

test("createIntegration takes agent.launch and agent.message, alone or together", async (t) => {
  const s = await setup(t);
  if (!s) return;
  for (const scopes of [["agent.launch"], ["agent.message"], ["agent.prompt", "agent.launch", "agent.message"]]) {
    const made = await s.create(OWNER, { scopes });
    assert.deepEqual(s.record(made.id).scopes, ["agent.view", ...scopes], JSON.stringify(scopes));
    assert.deepEqual(made.scopes, ["agent.view", ...scopes], JSON.stringify(scopes));
  }
  for (const scopes of [["agent.launch", "agent.launch"], ["agent.notify"]]) await assert.rejects(s.create(OWNER, { scopes }), refused(400, "scopes"), JSON.stringify(scopes));
});

test("createIntegration takes agent.notify only with agent.message and agent.prompt", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const made = await s.create(OWNER, { scopes: ["agent.prompt", "agent.message", "agent.notify"] });
  assert.deepEqual(s.record(made.id).scopes, ["agent.view", "agent.prompt", "agent.message", "agent.notify"]);
  for (const scopes of [["agent.notify"], ["agent.message", "agent.notify"], ["agent.prompt", "agent.notify"]]) {
    await assert.rejects(s.create(OWNER, { scopes }), (error) => refused(400, "scopes")(error) && error.message === "agent.notify needs agent.message and agent.prompt.", JSON.stringify(scopes));
  }
});

test("createIntegration refuses bad input before Auth, and maps Auth's refusals", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { d, ...publicPart } = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  await assert.rejects(s.create(OWNER, { publicJwk: { ...publicPart, d } }), (error) => refused(400, "private_key")(error) && error.message === "Send only the public key.");
  await assert.rejects(s.create(OWNER, { publicJwk: { kty: "oct", k: "secret" } }), refused(400, "private_key"));
  await assert.rejects(s.create(OWNER, { publicJwk: "not a key" }), refused(400, "jwk"));
  for (const name of ["", "   ", "x".repeat(81), "line\nbreak", 7, "evil\u202Eppa", "a\u2066b", "a\u200Fb", "\u{1F600}".repeat(41)]) await assert.rejects(s.create(OWNER, { name }), refused(400, "name"), JSON.stringify(name));
  for (const scopes of [["agent.view", "agent.view"], ["station.read"], "agent.view", [1]]) await assert.rejects(s.create(OWNER, { scopes }), refused(400, "scopes"), JSON.stringify(scopes));
  for (const expiresInDays of [0, 91, 1.5, "30"]) await assert.rejects(s.create(OWNER, { expiresInDays }), refused(400, "expiry"));
  for (const quotaPerSecond of [0, 10001, 2.5]) await assert.rejects(s.create(OWNER, { quotaPerSecond }), refused(400, "quota"));
  await assert.rejects(s.create(OWNER, { stationId: "st-unknown" }), refused(404, "not_found"));
  await assert.rejects(s.create(STRANGER), refused(404, "not_found"), "a Station the account cannot use");
  assert.equal(s.authCalls("createIntegration"), 0);
  s.manage.failNext.createIntegration = { status: 400, code: "scopes" };
  await assert.rejects(s.create(OWNER), refused(400, "scopes"));
  assert.equal((await s.events()).length, 0);
  assert.deepEqual(s.notified, []);
});

test("approve records the R9 fingerprint and moves to provisioning; only the owner, from awaiting_approval", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  s.notified.length = 0;
  await assert.rejects(s.service.approve(MEMBER, id, { r9Svc: "A".repeat(64) }), refused(400, "r9_svc"));
  await assert.rejects(s.service.approve(OWNER, id, { r9Svc: R9 }), refused(404, "not_found"), "the Station owner is not the integration owner");
  await assert.rejects(s.service.approve(STRANGER, id, { r9Svc: R9 }), refused(404, "not_found"));
  await assert.rejects(s.service.approve(MEMBER, "i-missing", { r9Svc: R9 }), refused(404, "not_found"));
  assert.equal(s.authCalls("changeIntegration"), 0);
  s.clock.now += 1000;
  const view = await s.service.approve(MEMBER, id, { r9Svc: R9 });
  assert.deepEqual([view.state, view.r9Svc, view.approvedAt], ["provisioning", R9, new Date(s.clock.now).toISOString()]);
  assert.equal(s.record(id).r9Svc, R9);
  assert.equal((await s.repository.integration(id)).approvedBy, MEMBER);
  const [event] = await s.events("integration_approved");
  assert.deepEqual([event.actor, event.state], [MEMBER, "provisioning"]);
  assert.deepEqual(s.notified, [s.station.id]);
  await assert.rejects(s.service.approve(MEMBER, id, { r9Svc: R9 }), refused(409, "invalid_state"));
  assert.equal(s.authCalls("changeIntegration"), 1, "an illegal approval never reaches Auth");
});

test("pause and resume round trip restores the prior state", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  await s.service.approve(OWNER, id, { r9Svc: R9 });
  await s.repository.updateIntegration(id, { state: "ready" });
  s.notified.length = 0;
  const paused = await s.service.pause(OWNER, id);
  assert.deepEqual([paused.state, paused.pausedFrom, s.record(id).status], ["paused", "ready", "paused"]);
  await assert.rejects(s.service.pause(OWNER, id), refused(409, "invalid_state"));
  const resumed = await s.service.resume(OWNER, id);
  assert.deepEqual([resumed.state, resumed.pausedFrom, s.record(id).status], ["ready", null, "active"]);
  await assert.rejects(s.service.resume(OWNER, id), refused(409, "invalid_state"));
  assert.equal(s.authCalls("changeIntegration"), 3);
  assert.deepEqual((await s.events()).slice(-2).map((event) => [event.kind, event.state, event.reason]), [["integration_paused", "paused", "owner"], ["integration_resumed", "ready", "owner"]]);
  assert.deepEqual(s.notified, [s.station.id, s.station.id]);
});

test("resume of a paused row without a recorded prior state goes back to approval or provisioning", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const waiting = await s.create();
  const approved = await s.create();
  await s.service.approve(OWNER, approved.id, { r9Svc: R9 });
  for (const { id } of [waiting, approved]) {
    await s.service.pause(OWNER, id);
    await s.repository.updateIntegration(id, { resumeState: null });
  }
  assert.equal((await s.service.resume(OWNER, waiting.id)).state, "awaiting_approval");
  assert.equal((await s.service.resume(OWNER, approved.id)).state, "provisioning");
});

test("revoke: awaiting_approval becomes revoked, ready becomes revoking, and a second revoke changes nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const waiting = await s.create();
  const live = await s.create();
  await s.repository.updateIntegration(live.id, { state: "ready" });
  assert.equal((await s.service.revoke(OWNER, waiting.id)).state, "revoked");
  assert.equal((await s.service.revoke(OWNER, live.id)).state, "revoking");
  assert.equal(s.record(live.id).status, "revoked");
  const calls = s.authCalls("changeIntegration");
  const notified = s.notified.length;
  assert.equal((await s.service.revoke(OWNER, live.id)).state, "revoking");
  assert.equal((await s.service.revoke(OWNER, waiting.id)).state, "revoked");
  assert.equal(s.authCalls("changeIntegration"), calls);
  assert.equal(s.notified.length, notified);
  assert.deepEqual((await s.events("integration_revoked")).map((event) => [event.state, event.reason]), [["revoked", "owner"], ["revoking", "owner"]]);
  await assert.rejects(s.service.pause(OWNER, live.id), refused(409, "invalid_state"));
  await assert.rejects(s.service.settings(OWNER, live.id, { quotaPerSecond: 5 }), refused(409, "revoked"));
  await assert.rejects(s.service.rotateKey(OWNER, live.id, { publicJwk: publicJwk() }), refused(409, "revoked"));
  await assert.rejects(s.service.renew(OWNER, live.id, { expiresInDays: 30 }), refused(409, "invalid_state"));
  assert.equal(s.authCalls("changeIntegration") + s.authCalls("addKey"), calls);
});

test("the Station owner may pause and revoke a member's integration; a stranger cannot find it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  await s.service.approve(MEMBER, id, { r9Svc: R9 });
  const calls = s.manage.calls.length;
  const events = (await s.events()).length;
  for (const call of [
    () => s.service.pause(STRANGER, id), () => s.service.revoke(STRANGER, id), () => s.service.resume(STRANGER, id),
    () => s.service.renew(STRANGER, id, { expiresInDays: 10 }), () => s.service.settings(STRANGER, id, { quotaPerSecond: 5 }),
    () => s.service.rotateKey(STRANGER, id, { publicJwk: publicJwk() }), () => s.service.approve(STRANGER, id, { r9Svc: R9 }),
    () => s.service.history(STRANGER, id)
  ]) {
    await assert.rejects(call(), (error) => refused(404, "not_found")(error) && error.message === "This Station or integration was not found.");
  }
  await s.service.pause(MEMBER, id);
  await assert.rejects(s.service.pause(STRANGER, id), refused(404, "not_found"), "not a 409 that would reveal the state");
  await s.service.resume(MEMBER, id);
  assert.equal(s.manage.calls.length, calls + 2, "a stranger's request never reaches Auth");
  assert.equal((await s.events()).length, events + 2);
  assert.equal((await s.repository.integration(id)).state, "provisioning");
  assert.equal(s.record(id).status, "active");
  const paused = await s.service.pause(OWNER, id);
  assert.deepEqual([paused.state, paused.role], ["paused", "station_owner"]);
  await assert.rejects(s.service.resume(OWNER, id), refused(403, "forbidden"), "only the integration owner resumes");
  for (const call of [() => s.service.renew(OWNER, id, { expiresInDays: 10 }), () => s.service.settings(OWNER, id, { quotaPerSecond: 5 }), () => s.service.rotateKey(OWNER, id, { publicJwk: publicJwk() })]) {
    await assert.rejects(call(), refused(403, "forbidden"));
  }
  assert.equal((await s.service.revoke(OWNER, id)).state, "revoking");
  assert.deepEqual((await s.events()).slice(-2).map((event) => [event.kind, event.actor, event.account_id, event.reason]), [
    ["integration_paused", OWNER, MEMBER, "station_owner"], ["integration_revoked", OWNER, MEMBER, "station_owner"]
  ]);
});

test("a refusal by Auth itself is mapped and leaves Portal unchanged", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  s.manage.failNext.changeIntegration = { status: 403, code: "forbidden" };
  await assert.rejects(s.service.pause(OWNER, id), refused(403, "forbidden"));
  assert.equal(s.authCalls("changeIntegration"), 1);
  assert.equal((await s.repository.integration(id)).state, "awaiting_approval");
  assert.equal((await s.events("integration_paused")).length, 0);
});

test("renew takes 1 to 90 days, and renewing an expired integration makes it current again", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  for (const expiresInDays of [0, 91, 2.5]) await assert.rejects(s.service.renew(OWNER, id, { expiresInDays }), refused(400, "expiry"));
  assert.equal(s.authCalls("changeIntegration"), 0);
  s.clock.now += 31 * DAY;
  const [listed] = (await s.service.integrations(OWNER)).integrations;
  assert.equal(listed.state, "expired");
  await assert.rejects(s.service.approve(OWNER, id, { r9Svc: R9 }), refused(409, "expired"));
  s.notified.length = 0;
  const renewed = await s.service.renew(OWNER, id, { expiresInDays: 10 });
  assert.deepEqual([renewed.state, renewed.expiresAt], ["awaiting_approval", new Date(s.clock.now + 10 * DAY).toISOString()]);
  assert.equal(s.record(id).expiresAt, renewed.expiresAt);
  const [event] = await s.events("integration_renewed");
  assert.deepEqual([event.state, event.details], ["awaiting_approval", { expiresAt: renewed.expiresAt }]);
  assert.deepEqual(s.notified, [s.station.id]);
});

test("settings changes the quota within 1 to 10000", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  for (const quotaPerSecond of [0, 10001, 1.5, "5"]) await assert.rejects(s.service.settings(OWNER, id, { quotaPerSecond }), refused(400, "quota"));
  s.notified.length = 0;
  assert.equal((await s.service.settings(OWNER, id, { quotaPerSecond: 10000 })).quotaPerSecond, 10000);
  assert.equal(s.record(id).quotaPerSecond, 10000);
  const [event] = await s.events("integration_settings_changed");
  assert.deepEqual(event.details, { quotaPerSecond: 10000 });
  assert.deepEqual(s.notified, [s.station.id]);
});

test("rotateKey adds the key at Auth and returns its kid", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  const { d, ...publicPart } = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  await assert.rejects(s.service.rotateKey(OWNER, id, { publicJwk: { ...publicPart, d } }), refused(400, "private_key"));
  assert.equal(s.authCalls("addKey"), 0);
  s.notified.length = 0;
  const key = publicJwk();
  const answer = await s.service.rotateKey(OWNER, id, { publicJwk: key });
  assert.deepEqual(answer, { kid: "kid-2", overlapEndsAt: new Date(s.clock.now + 600000).toISOString() });
  const [event] = await s.events("integration_key_added");
  assert.deepEqual([event.state, event.details], ["awaiting_approval", answer]);
  assert.deepEqual(s.notified, [s.station.id]);
  await assert.rejects(s.service.rotateKey(OWNER, id, { publicJwk: key }), refused(409, "duplicate_key"));
});

test("integrations lists the account's own and those on Stations it owns, and follows Auth", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const revoked = await s.create();
  const paused = await s.create();
  const resumed = await s.create();
  const theirs = await s.create(MEMBER);
  await s.service.approve(OWNER, resumed.id, { r9Svc: R9 });
  await s.service.pause(OWNER, resumed.id);
  s.record(revoked.id).status = "revoked";
  s.record(paused.id).status = "paused";
  Object.assign(s.record(resumed.id), { status: "active", quotaPerSecond: 7, r9Svc: "b".repeat(64), expiresAt: new Date(s.clock.now + 5 * DAY).toISOString() });
  const missing = { ...s.record(paused.id), clientId: "i-" + "9".repeat(26), name: "Made elsewhere", status: "active", keys: [] };
  s.manage.integrationRecords.push(missing);
  s.notified.length = 0;
  const { integrations, stale } = await s.service.integrations(OWNER);
  assert.equal(stale, false);
  const byId = Object.fromEntries(integrations.map((view) => [view.id, view]));
  assert.deepEqual(Object.keys(byId).sort(), [revoked.id, paused.id, resumed.id, theirs.id, missing.clientId].sort());
  assert.equal(byId[revoked.id].state, "revoked");
  assert.deepEqual([byId[paused.id].state, byId[paused.id].pausedFrom], ["paused", "awaiting_approval"]);
  assert.deepEqual([byId[resumed.id].state, byId[resumed.id].quotaPerSecond, byId[resumed.id].r9Svc, byId[resumed.id].expiresAt],
    ["provisioning", 7, "b".repeat(64), new Date(s.clock.now + 5 * DAY).toISOString()]);
  assert.deepEqual([byId[missing.clientId].state, byId[missing.clientId].name, byId[missing.clientId].role], ["awaiting_approval", "Made elsewhere", "owner"]);
  assert.equal(byId[theirs.id].role, "station_owner");
  assert.deepEqual((await s.events()).filter((event) => event.actor === "system").map((event) => [event.integration_id, event.kind, event.state, event.reason]), [
    [revoked.id, "integration_revoked", "revoked", "reconciled"],
    [paused.id, "integration_paused", "paused", "reconciled"],
    [resumed.id, "integration_resumed", "provisioning", "reconciled"],
    [missing.clientId, "integration_reconciled", "awaiting_approval", null]
  ]);
  assert.ok(s.notified.length > 0 && s.notified.every((stationId) => stationId === s.station.id));
  const count = (await s.events()).length;
  s.notified.length = 0;
  await s.service.integrations(OWNER);
  assert.equal((await s.events()).length, count, "a second listing changes nothing");
  assert.deepEqual(s.notified, []);
  // The member's own listing is reconciled from their Auth list only.
  const member = await s.service.integrations(MEMBER);
  assert.deepEqual(member.integrations.map((view) => [view.id, view.role]), [[theirs.id, "owner"]]);
});

test("a settings-only change found at Auth is recorded as integration_reconciled, so the Station's feed shows it", async (t) => {
  let locks = 0;
  const s = await setup(t, { wrap: (repository) => ({ ...repository, integrationForUpdate: (...args) => { locks += 1; return repository.integrationForUpdate(...args); } }) });
  if (!s) return;
  const { id } = await s.create();
  // Auth took a renew and a quota change whose Portal half never committed.
  const expiresAt = new Date(s.clock.now + 60 * DAY).toISOString();
  Object.assign(s.record(id), { quotaPerSecond: 9, expiresAt });
  s.notified.length = 0;
  locks = 0;
  const [view] = (await s.service.integrations(OWNER)).integrations;
  assert.deepEqual([view.quotaPerSecond, view.expiresAt, view.state], [9, expiresAt, "awaiting_approval"]);
  const [event] = await s.events("integration_reconciled");
  assert.deepEqual([event.actor, event.state, event.reason, event.details], ["system", "awaiting_approval", "reconciled", { changed: ["expiresAt", "quotaPerSecond"], expiresAt, quotaPerSecond: 9 }]);
  assert.deepEqual(s.notified, [s.station.id]);
  const feed = await s.service.changes(s.station.reportClientId, 0);
  const change = feed.changes.find((entry) => entry.kind === "integration_reconciled");
  assert.deepEqual([change.integrationId, change.integration.quotaPerSecond, change.integration.expiresAt], [id, 9, expiresAt]);
  assert.equal(locks, 1);
  s.notified.length = 0;
  locks = 0;
  await s.service.integrations(OWNER);
  assert.equal((await s.events("integration_reconciled")).length, 1, "nothing more to record");
  assert.deepEqual(s.notified, []);
  assert.equal(locks, 0, "an unchanged listing takes no row lock");
});

test("an integration Auth lists without an expiry is reconciled with Portal's default, and that is logged", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  s.manage.integrationRecords.push({ ...s.record(id), clientId: "i-" + "8".repeat(26), expiresAt: null, keys: [] });
  const views = (await s.service.integrations(OWNER)).integrations;
  assert.equal(views.find((view) => view.id === "i-" + "8".repeat(26)).expiresAt, new Date(s.clock.now + 30 * DAY).toISOString());
  assert.ok(s.logs.includes("Integration reconciled without an expiry at Auth: Portal shows its 30-day default."));
});

test("integrations serves Portal's rows as stale when Auth is down", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  s.record(id).status = "revoked";
  s.manage.down = true;
  const { integrations, stale } = await s.service.integrations(OWNER);
  assert.equal(stale, true);
  assert.deepEqual(integrations.map((view) => [view.id, view.state]), [[id, "awaiting_approval"]]);
});

test("history lists events newest first, showing the reader as you", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  await s.service.approve(MEMBER, id, { r9Svc: R9 });
  await s.service.pause(OWNER, id);
  const mine = await s.service.history(MEMBER, id);
  assert.deepEqual(mine.events.map((event) => [event.kind, event.state, event.reason, event.actor]), [
    ["integration_paused", "paused", "station_owner", OWNER],
    ["integration_approved", "provisioning", null, "you"],
    ["integration_created", "awaiting_approval", null, "you"]
  ]);
  assert.deepEqual(Object.keys(mine.events[0]).sort(), ["actor", "at", "kind", "reason", "state"]);
  assert.deepEqual((await s.service.history(OWNER, id)).events.map((event) => event.actor), ["you", MEMBER, MEMBER]);
  await assert.rejects(s.service.history(STRANGER, id), refused(404, "not_found"));
});

const ADMIN = "ab" + "0".repeat(25) + "4";
const PLAN_MESSAGE = (n) => "Your plan allows " + n + " integrations on the built-in Station. Revoke one, upgrade, or use your own Station.";
async function builtIn(s, settings = {}) {
  const built = s.manage.seedBuiltIn({ integrations: true, admins: [ADMIN], ...settings });
  await s.service.stations(OWNER);
  return built;
}
const onBuiltIn = (s, built, accountId = OWNER, plan, fields = {}) => s.service.createIntegration(accountId, { stationId: built.id, name: "Hosted app", scopes: [], publicJwk: publicJwk(), ...fields }, plan ? { plan } : undefined);

test("while the built-in Station's integrations are off, creating one there is 409 not_supported, before Auth", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s, { integrations: false });
  const calls = s.authCalls("createIntegration");
  await assert.rejects(onBuiltIn(s, built), refused(409, "not_supported"));
  assert.equal(s.authCalls("createIntegration"), calls, "Auth is not asked");
  // Turned off at Auth after the Portal last listed it: Auth's own refusal reads the same.
  built.integrations = true;
  await s.service.stations(OWNER);
  built.integrations = false;
  await assert.rejects(onBuiltIn(s, built), (error) => refused(409, "not_supported")(error) && error.message === "Integrations aren't available on the built-in Station yet.");
  assert.equal(s.authCalls("createIntegration"), calls + 1);
});

test("with integrations on, any account creates one on the built-in Station, owned by it and seen only by it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  const theirs = await onBuiltIn(s, built, STRANGER);
  assert.deepEqual([theirs.stationId, theirs.stationOrigin, theirs.role, theirs.state], [built.id, "https://station.agora.test", "owner", "awaiting_approval"]);
  assert.equal(s.record(theirs.id).owner, STRANGER);
  assert.equal((await s.service.integrations(OWNER)).integrations.some((entry) => entry.id === theirs.id), false);
  await assert.rejects(s.service.pause(OWNER, theirs.id), refused(404, "not_found"));
  await s.service.approve(STRANGER, theirs.id, { r9Svc: R9 });
  assert.equal((await s.service.pause(STRANGER, theirs.id)).state, "paused");
  assert.equal((await s.service.resume(STRANGER, theirs.id)).state, "provisioning");
});

test("plan limits on the built-in Station: Basic 4, Premium 10, Principal and Fellow none; revoked and expired ones don't count", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  const ids = [];
  const short = (await onBuiltIn(s, built, OWNER, "basic", { expiresInDays: 1 })).id;
  for (let i = 0; i < 3; i += 1) ids.push((await onBuiltIn(s, built, OWNER, "basic")).id);
  const calls = s.authCalls("createIntegration");
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), (error) => refused(403, "plan_limit")(error) && error.message === PLAN_MESSAGE(4) && error.details.limit === 4);
  await assert.rejects(onBuiltIn(s, built, OWNER), refused(403, "plan_limit"), "no plan given counts as Basic");
  assert.equal(s.authCalls("createIntegration"), calls, "refused before Auth");
  for (let i = 0; i < 5; i += 1) await s.create(OWNER); // custom Stations are never capped
  await s.service.pause(OWNER, ids[0]);
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), refused(403, "plan_limit"), "a paused one still counts");
  await s.service.revoke(OWNER, ids[1]);
  ids.push((await onBuiltIn(s, built, OWNER, "basic")).id); // a revoked one frees a place
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), refused(403, "plan_limit"));
  s.clock.now += 2 * DAY;
  ids.push((await onBuiltIn(s, built, OWNER, "basic")).id); // so does an expired one
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), refused(403, "plan_limit"));
  for (let i = 0; i < 6; i += 1) ids.push((await onBuiltIn(s, built, OWNER, "premium")).id);
  await assert.rejects(onBuiltIn(s, built, OWNER, "premium"), (error) => refused(403, "plan_limit")(error) && error.message === PLAN_MESSAGE(10));
  for (const plan of ["principal", "fellow"]) ids.push((await onBuiltIn(s, built, OWNER, plan)).id);
  // After a downgrade the existing ones keep working; new ones are refused until the account is under the limit.
  const live = (await s.service.integrations(OWNER)).integrations.filter((entry) => entry.stationId === built.id && !["revoked", "expired"].includes(entry.state));
  assert.equal(live.length, 12);
  assert.ok(live.every((entry) => s.record(entry.id).status === (entry.state === "paused" ? "paused" : "active")));
  assert.equal((await s.repository.integration(short)).state, "awaiting_approval", "expired is shown, not stored");
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), refused(403, "plan_limit"));
  assert.equal((await onBuiltIn(s, built, MEMBER, "basic")).role, "owner", "each account counts its own");
});

// D29 Phase B: Auth has already revoked a `revoking` integration and issues it no token, but it can stay `revoking` for
// 24 hours or more, until its Station sends the final report. With the setting on it no longer holds a plan place;
// with it off it does, as it always has.
for (const delegated of [true, false]) {
  test("plan limits: a revoking integration " + (delegated ? "frees its place at once with the setting on" : "still holds its place with the setting off"), async (t) => {
    const s = await setup(t, { delegatedHostWork: delegated });
    if (!s) return;
    const built = await builtIn(s);
    const refusedAtLimit = (label) => assert.rejects(onBuiltIn(s, built, OWNER, "basic"), refused(403, "plan_limit"), label);
    const revoke = async (id) => {
      await s.repository.updateIntegration(id, { state: "ready" });
      return s.service.revoke(OWNER, id, delegated ? { interruptRunning: false } : undefined);
    };
    // Creation: four live ones fill Basic.
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push((await onBuiltIn(s, built, OWNER, "basic")).id);
    await refusedAtLimit("at the limit");
    assert.equal((await revoke(ids[0])).state, "revoking", "the Station has not confirmed");
    if (delegated) {
      ids.push((await onBuiltIn(s, built, OWNER, "basic")).id);
      await refusedAtLimit("four live ones again");
    } else {
      await refusedAtLimit("a revoking one counts");
    }
    // The final report moves it to revoked, which frees the place either way.
    await s.repository.updateIntegration(ids[0], { state: "revoked" });
    if (!delegated) ids.push((await onBuiltIn(s, built, OWNER, "basic")).id);
    await refusedAtLimit("a revoked one never counts");
    // Renewal: an expired one renewing counts as a creation, so a revoking one frees its place there too.
    const separate = MEMBER;
    const old = (await onBuiltIn(s, built, separate, "basic", { expiresInDays: 1 })).id;
    s.clock.now += 2 * DAY;
    const fresh = [];
    for (let i = 0; i < 4; i += 1) fresh.push((await onBuiltIn(s, built, separate, "basic")).id);
    await s.repository.updateIntegration(fresh[0], { state: "ready" });
    assert.equal((await s.service.revoke(separate, fresh[0], delegated ? { interruptRunning: false } : undefined)).state, "revoking");
    if (delegated) {
      assert.equal((await s.service.renew(separate, old, { expiresInDays: 30 }, { plan: "basic" })).state, "awaiting_approval", "the revoking one's place goes to the renewal");
    } else {
      await assert.rejects(s.service.renew(separate, old, { expiresInDays: 30 }, { plan: "basic" }), refused(403, "plan_limit"), "a revoking one counts");
    }
  });
}

test("two creations racing on the built-in Station can't both pass the plan limit", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  for (let i = 0; i < 3; i += 1) await onBuiltIn(s, built, OWNER, "basic");
  const results = await Promise.allSettled([onBuiltIn(s, built, OWNER, "basic"), onBuiltIn(s, built, OWNER, "basic")]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((result) => result.status === "rejected").reason.details.code, "plan_limit");
});


test("renewing an expired integration on the built-in Station counts as adding one; renewing a live one is always allowed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  const old = [];
  for (let i = 0; i < 4; i += 1) old.push((await onBuiltIn(s, built, OWNER, "basic", { expiresInDays: 1 })).id);
  s.clock.now += 2 * DAY;
  const fresh = [];
  for (let i = 0; i < 4; i += 1) fresh.push((await onBuiltIn(s, built, OWNER, "basic")).id);
  const calls = s.authCalls("changeIntegration");
  await assert.rejects(s.service.renew(OWNER, old[0], { expiresInDays: 30 }, { plan: "basic" }),
    (error) => refused(403, "plan_limit")(error) && error.message === PLAN_MESSAGE(4) && error.details.limit === 4);
  await assert.rejects(s.service.renew(OWNER, old[0], { expiresInDays: 30 }), refused(403, "plan_limit"), "no plan given counts as Basic");
  assert.equal(s.authCalls("changeIntegration"), calls, "refused before Auth");
  assert.equal((await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === old[0]).state, "expired");
  const live = await s.service.renew(OWNER, fresh[0], { expiresInDays: 60 }, { plan: "basic" });
  assert.equal(live.expiresAt, new Date(s.clock.now + 60 * DAY).toISOString(), "a live one renews at the limit");
  await s.service.revoke(OWNER, fresh[1]);
  const renewed = await s.service.renew(OWNER, old[0], { expiresInDays: 30 }, { plan: "basic" });
  assert.deepEqual([renewed.state, renewed.expiresAt], ["awaiting_approval", new Date(s.clock.now + 30 * DAY).toISOString()], "under the limit an expired one renews");
  await assert.rejects(s.service.renew(OWNER, old[1], { expiresInDays: 30 }, { plan: "basic" }), refused(403, "plan_limit"));
  assert.equal((await s.service.renew(OWNER, old[1], { expiresInDays: 30 }, { plan: "premium" })).state, "awaiting_approval");
  for (const plan of ["principal", "fellow"]) await s.service.renew(OWNER, old[plan === "principal" ? 2 : 3], { expiresInDays: 30 }, { plan });
});

test("renewing an expired integration races creation for the last place under the plan limit", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  const old = (await onBuiltIn(s, built, OWNER, "basic", { expiresInDays: 1 })).id;
  s.clock.now += 2 * DAY;
  for (let i = 0; i < 3; i += 1) await onBuiltIn(s, built, OWNER, "basic");
  // The creation passes its count first and is slow at Auth; the renewal must wait for it, not count beside it.
  const create = s.manage.createIntegration;
  s.manage.createIntegration = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 50)); return create.apply(s.manage, args); };
  const creating = onBuiltIn(s, built, OWNER, "basic");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const results = await Promise.allSettled([creating, s.service.renew(OWNER, old, { expiresInDays: 30 }, { plan: "basic" })]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((result) => result.status === "rejected").reason.details.code, "plan_limit");
});


test("a renewal judged live just before expiry and a creation just after it can't both pass the plan limit", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  const soon = await onBuiltIn(s, built, OWNER, "basic", { expiresInDays: 1 });
  for (let i = 0; i < 3; i += 1) await onBuiltIn(s, built, OWNER, "basic");
  const expiry = new Date(soon.expiresAt).getTime();
  // Auth holds the renewal until released, while the clock passes the expiry.
  const change = s.manage.changeIntegration;
  let reached;
  let release;
  const atAuth = new Promise((resolve) => { reached = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  s.manage.changeIntegration = async (...args) => { reached(); await held; return change.apply(s.manage, args); };
  s.clock.now = expiry - 1;
  const renewing = s.service.renew(OWNER, soon.id, { expiresInDays: 30 }, { plan: "basic" });
  await atAuth;
  s.clock.now = expiry + 1;
  const creating = onBuiltIn(s, built, OWNER, "basic");
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const results = await Promise.allSettled([renewing, creating]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"], "the creation waits for the renewal and then counts it");
  assert.equal(results[1].reason.details.code, "plan_limit");
});
test("renewing an expired integration on a custom Station is never capped", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push((await s.create(OWNER, { expiresInDays: 1 })).id);
  s.clock.now += 2 * DAY;
  for (let i = 0; i < 5; i += 1) await s.create(OWNER);
  for (const id of ids) assert.equal((await s.service.renew(OWNER, id, { expiresInDays: 30 }, { plan: "basic" })).state, "awaiting_approval");
});
test("an Agora.Build admin is just another account in the Portal: their own integrations only, no rights on others' on the built-in Station", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  const theirs = await onBuiltIn(s, built, OWNER);
  const own = await onBuiltIn(s, built, ADMIN);
  assert.deepEqual((await s.service.integrations(ADMIN)).integrations.map((entry) => [entry.id, entry.role]), [[own.id, "owner"]]);
  const calls = s.manage.calls.length;
  for (const call of [() => s.service.pause(ADMIN, theirs.id), () => s.service.revoke(ADMIN, theirs.id), () => s.service.resume(ADMIN, theirs.id), () => s.service.history(ADMIN, theirs.id)]) {
    await assert.rejects(call(), refused(404, "not_found"));
  }
  assert.equal(s.manage.calls.length, calls, "Auth is not asked");
  // Auth refuses the Portal acting for an admin on someone else's integration (Auth D26 R12).
  await assert.rejects(s.manage.changeIntegration(theirs.id, { status: "paused" }, ADMIN), (error) => error.status === 403 && error.code === "forbidden");
  assert.equal(s.record(theirs.id).status, "active");
});

const ADMIN_PAUSED = "Agora.Build paused this integration. Only Agora.Build can resume it.";
const OWNER_DISABLED = "Agora.Build disabled this integration's owner account. It resumes when the account is enabled again.";

test("a pause records who paused it, as Auth answers; resuming or revoking clears it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  await s.service.approve(MEMBER, id, { r9Svc: R9 });
  assert.equal((await s.service.pause(MEMBER, id)).pausedBy, "owner");
  assert.deepEqual([s.record(id).pausedBy, (await s.repository.integration(id)).pausedBy], ["owner", "owner"]);
  assert.equal((await s.service.resume(MEMBER, id)).pausedBy, null);
  assert.equal((await s.repository.integration(id)).pausedBy, null);
  assert.equal((await s.service.pause(OWNER, id)).pausedBy, "station", "the custom Station's owner");
  assert.equal((await s.service.revoke(OWNER, id)).pausedBy, null);
  assert.equal((await s.repository.integration(id)).pausedBy, null);
});

test("an admin's pause locks: Resume is 409 admin_paused without asking Auth, and Auth's own 409 reads the same; both ask for Auth's feed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  await s.service.approve(OWNER, id, { r9Svc: R9 });
  await s.repository.updateIntegration(id, { state: "ready" });
  // An admin paused it at Auth; the owner's listing follows it.
  Object.assign(s.record(id), { status: "paused", pausedBy: "admin" });
  const view = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([view.state, view.pausedFrom, view.pausedBy], ["paused", "ready", "admin"]);
  const calls = s.authCalls("changeIntegration");
  await assert.rejects(s.service.resume(OWNER, id), (error) => refused(409, "admin_paused")(error) && error.message === ADMIN_PAUSED);
  assert.equal(s.authCalls("changeIntegration"), calls, "Auth is not asked");
  assert.equal(s.authAsked(), 1, "a read of Auth's feed is asked for, so a lift the Portal missed heals");
  // The Portal has not heard yet: Auth refuses with its own 409, which reads the same and asks for a read of its feed.
  await s.repository.updateIntegration(id, { pausedBy: "owner" });
  await assert.rejects(s.service.resume(OWNER, id), (error) => refused(409, "admin_paused")(error) && error.message === ADMIN_PAUSED);
  assert.equal(s.authCalls("changeIntegration"), calls + 1);
  assert.equal(s.authAsked(), 2);
  assert.equal((await s.repository.integration(id)).state, "paused", "nothing changed in the Portal");
  // The quota stays the owner's, and revoking is never locked.
  assert.equal((await s.service.settings(OWNER, id, { quotaPerSecond: 9 })).quotaPerSecond, 9);
  assert.equal((await s.service.revoke(OWNER, id)).state, "revoking");
});

test("pausing an integration Auth already holds in an admin's pause keeps it the admin's", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  // Paused by an admin at Auth; the Portal has not heard and still shows it awaiting approval.
  Object.assign(s.record(id), { status: "paused", pausedBy: "admin" });
  const paused = await s.service.pause(OWNER, id);
  assert.deepEqual([paused.state, paused.pausedBy, s.record(id).pausedBy], ["paused", "admin", "admin"]);
  await assert.rejects(s.service.resume(OWNER, id), refused(409, "admin_paused"));
});

test("an owner's listing follows who paused an integration at Auth, recorded like other settings", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  await s.service.pause(OWNER, id);
  s.record(id).pausedBy = "admin"; // an admin turned the owner's pause into theirs
  const view = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([view.state, view.pausedBy], ["paused", "admin"]);
  const [event] = await s.events("integration_reconciled");
  assert.deepEqual([event.integration_id, event.actor, event.state, event.details], [id, "system", "paused", { changed: ["pausedBy"], pausedBy: "admin" }]);
  await s.service.integrations(OWNER);
  assert.equal((await s.events("integration_reconciled")).length, 1, "nothing more to record");
});

// Least disclosure: Agora.Build disabling or enabling an integration's owner account is the owner's business. Its
// custom Station's owner and the Station see Agora.Build's pause and lift; the owner and integration_events keep it.
test("a custom Station's owner and its feed see an owner's account disabled and enabled as Agora.Build's pause and lift", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  let seen;
  const follow = async () => {
    const { changes, nextCursor } = await s.manage.integrationChanges({ after: seen });
    seen = nextCursor ?? undefined;
    for (const change of changes) await s.service.applyAuthChange(change);
  };
  s.manage.setOwnerDisabled(MEMBER, true, { actor: ADMIN, reason: "Abuse" });
  await follow();
  s.clock.now += 1000;
  s.manage.setOwnerDisabled(MEMBER, false, { actor: ADMIN, reason: "Appeal" });
  await follow();
  const shown = async (accountId) => (await s.service.history(accountId, id)).events.slice(0, 2).map((event) => [event.kind, event.state, event.actor, event.reason]);
  assert.deepEqual(await shown(OWNER), [["integration_resumed", "awaiting_approval", "agora_build", null], ["integration_paused", "paused", "agora_build", null]], "the Station's owner sees Agora.Build's pause and lift");
  assert.deepEqual(await shown(MEMBER), [["integration_owner_enabled", "awaiting_approval", "agora_build", null], ["integration_owner_disabled", "paused", "agora_build", null]], "the integration's owner sees what it was");
  const feed = (await s.service.changes(s.station.reportClientId, "0")).changes.filter((change) => change.integrationId === id);
  assert.deepEqual(feed.slice(-2).map((change) => [change.kind, change.state, change.reason]), [["integration_paused", "paused", "agora_build"], ["integration_resumed", "awaiting_approval", "agora_build"]]);
  assert.equal(JSON.stringify(feed).includes("Abuse") || JSON.stringify(feed).includes(ADMIN), false);
  assert.deepEqual((await s.events()).filter((event) => event.integration_id === id).slice(-2).map((event) => [event.kind, event.actor, event.reason]), [["integration_owner_disabled", ADMIN, "Abuse"], ["integration_owner_enabled", ADMIN, "Appeal"]], "integration_events keeps what it was");
});

test("while Agora.Build has its owner's account disabled, an integration shows as paused by Agora.Build and cannot be resumed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  await s.repository.updateIntegration(id, { state: "ready", ownerDisabledAt: s.clock.now });
  const seen = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([seen.state, seen.pausedBy, seen.role], ["paused", "admin", "station_owner"]);
  assert.equal((await s.repository.integration(id)).state, "ready", "the row keeps its own state");
  // Resume is refused before Auth is asked (it would otherwise be refused as a resume of an integration that is not paused).
  const calls = s.authCalls("changeIntegration");
  await assert.rejects(s.service.resume(MEMBER, id), (error) => refused(409, "owner_disabled")(error) && error.message === OWNER_DISABLED);
  assert.equal(s.authCalls("changeIntegration"), calls, "Auth is not asked");
  assert.equal(s.authAsked(), 0);
  // Before the admin-pause check: the owner's own disabled account is the cause named, even on an admin-paused row.
  await s.repository.updateIntegration(id, { state: "paused", resumeState: "ready", pausedBy: "admin" });
  await assert.rejects(s.service.resume(MEMBER, id), refused(409, "owner_disabled"));
  // Once the account is enabled again the admin pause on its own is what remains.
  await s.repository.updateIntegration(id, { ownerDisabledAt: null });
  await assert.rejects(s.service.resume(MEMBER, id), refused(409, "admin_paused"));
  assert.equal(s.authCalls("changeIntegration"), calls, "Auth is still not asked");
});

test("to its Station and the Station's owner, an integration whose owner is disabled reads like an admin's pause", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id: disabled } = await s.create(MEMBER);
  const { id: paused } = await s.create(MEMBER);
  await s.repository.updateIntegration(disabled, { state: "ready", ownerDisabledAt: s.clock.now });
  await s.repository.updateIntegration(paused, { state: "paused", resumeState: "ready", pausedBy: "admin" });
  const listed = (await s.service.integrations(OWNER)).integrations;
  const view = (id) => { const { id: _, name, createdAt, ...rest } = listed.find((entry) => entry.id === id); return rest; };
  assert.deepEqual(view(disabled), view(paused), "the Station owner's listing cannot tell them apart");
  assert.equal(view(disabled).pausedFrom, "ready");
  // A pause is refused alike, before Auth is asked.
  const calls = s.authCalls("changeIntegration");
  const refusal = async (id) => s.service.pause(OWNER, id).then(() => null, (error) => [error.status, error.details?.code, error.message]);
  assert.deepEqual(await refusal(disabled), await refusal(paused));
  assert.equal(s.authCalls("changeIntegration"), calls, "Auth is not asked");
  // An invalid report is refused alike, naming the state the Station is shown.
  const reported = async (id) => s.service.report(s.station.reportClientId, { integrationId: id, state: "revoked" }).then(() => null, (error) => [error.status, error.details?.code, error.message]);
  assert.deepEqual(await reported(disabled), await reported(paused));
  assert.deepEqual(await reported(disabled), [409, "invalid_state", "This integration is paused and cannot take that action."]);
  assert.equal((await s.repository.integration(disabled)).state, "ready", "the row keeps its own state");
});

// D29: a revocation states whether to interrupt the tasks running on the owner's hosts (the setting on: delegatedHostWork).
const INTERRUPT_RUNNING = "Say whether to interrupt running tasks: send interruptRunning as true or false.";
const iso = (ms) => new Date(ms).toISOString();

test("with the setting on, a revoke sends interruptRunning to Auth only when it is true, and keeps the choice, and revokedAt, on the row, the event and the view", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  for (const interruptRunning of [true, false]) {
    const { id } = await s.create();
    await s.repository.updateIntegration(id, { state: "ready" });
    s.clock.now += 1000;
    const view = await s.service.revoke(OWNER, id, { interruptRunning });
    // An unticked revoke sends exactly the body it sent before the setting: a delegated Auth records it as false.
    const sent = s.manage.sent.at(-1);
    assert.equal(sent.id, id);
    assert.deepEqual(sent.fields, { status: "revoked", ...(interruptRunning ? { interruptRunning: true } : {}), actor: OWNER }, "what Auth was sent");
    assert.equal(s.record(id).interruptRunning, interruptRunning, "Auth recorded the choice");
    assert.equal(s.manage.feed.at(-1).interruptRunning, interruptRunning, "and wrote it in its feed");
    const row = await s.repository.integration(id);
    assert.deepEqual([row.state, row.interruptRunning, row.revokedAt], ["revoking", interruptRunning, iso(s.clock.now)]);
    assert.deepEqual([view.state, view.interruptRunning, view.revokedAt], ["revoking", interruptRunning, iso(s.clock.now)]);
    const event = (await s.events("integration_revoked")).at(-1);
    assert.deepEqual([event.integration_id, event.actor, event.reason, event.details], [id, OWNER, "owner", { seenAt: iso(s.clock.now), interruptRunning }]);
  }
  // Before approval nothing runs, but the choice is still recorded: the integration is revoked at once.
  const { id: waiting } = await s.create();
  const view = await s.service.revoke(OWNER, waiting, { interruptRunning: true });
  assert.deepEqual([view.state, view.interruptRunning, view.revokedAt], ["revoked", true, iso(s.clock.now)]);
  // Only a stopped integration's view has them.
  const { id: live } = await s.create();
  const listed = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === live);
  assert.equal(Object.hasOwn(listed, "revokedAt") || Object.hasOwn(listed, "interruptRunning"), false);
  assert.deepEqual((await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === waiting).interruptRunning, true);
});

test("with the setting on, a revoke without a boolean interruptRunning is 400, before Auth and before any 404", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const { id } = await s.create();
  const calls = s.manage.calls.length;
  for (const options of [undefined, {}, { interruptRunning: undefined }, { interruptRunning: "true" }, { interruptRunning: "false" }, { interruptRunning: 1 }, { interruptRunning: 0 }, { interruptRunning: null }, { interruptRunning: [] }]) {
    const label = JSON.stringify(options);
    await assert.rejects(s.service.revoke(OWNER, id, options), (error) => refused(400, "interrupt_running")(error) && error.message === INTERRUPT_RUNNING, label);
    await assert.rejects(s.service.revoke(STRANGER, id, options), refused(400, "interrupt_running"), "the same for a stranger: " + label);
    await assert.rejects(s.service.revoke(OWNER, "i-unknown", options), refused(400, "interrupt_running"), "the same for an unknown ID: " + label);
    await assert.rejects(s.service.revokeNative(OWNER, id, { ...options, clientId: "astation" }), refused(400, "interrupt_running"), "and for the native route: " + label);
  }
  assert.equal(s.manage.calls.length, calls, "Auth was not asked");
  assert.equal((await s.repository.integration(id)).state, "awaiting_approval");
  assert.equal((await s.events("integration_revoked")).length, 0);
  // A pause never takes it.
  assert.equal((await s.service.pause(OWNER, id)).state, "paused");
  assert.equal(s.record(id).interruptRunning, undefined);
});

test("with the setting on, a repeated revoke changes nothing: Auth is not asked and the first choice stays", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const { id } = await s.create();
  await s.repository.updateIntegration(id, { state: "ready" });
  await s.service.revoke(OWNER, id, { interruptRunning: false });
  const first = await s.repository.integration(id);
  const calls = s.manage.calls.length;
  const events = (await s.events()).length;
  const notified = s.notified.length;
  s.clock.now += DAY / 2;
  const again = await s.service.revoke(OWNER, id, { interruptRunning: true });
  assert.deepEqual([again.state, again.interruptRunning, again.revokedAt], ["revoking", false, first.revokedAt]);
  assert.deepEqual(await s.repository.integration(id), first, "the row is as it was");
  assert.equal(s.record(id).interruptRunning, false);
  assert.deepEqual([s.manage.calls.length, (await s.events()).length, s.notified.length], [calls, events, notified]);
});

// The rollout order is Auth's setting first (docs/platform.md); if it is broken, Auth is the one that refuses a ticked
// revoke as an unknown field, and an unticked one, which sends nothing about it, still works.
test("with the Portal's setting on and Auth's off, an unticked revoke succeeds and a ticked one is Auth's 400 with nothing written on the Portal", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, authDelegated: false });
  if (!s) return;
  const unticked = (await s.create()).id;
  const ticked = (await s.create()).id;
  const native = (await s.create()).id;
  for (const id of [unticked, ticked, native]) await s.repository.updateIntegration(id, { state: "ready" });
  s.notified.length = 0;
  const view = await s.service.revoke(OWNER, unticked, { interruptRunning: false });
  assert.deepEqual([view.state, view.interruptRunning], ["revoking", false], "the Portal still records its own choice");
  assert.deepEqual(s.manage.sent.at(-1).fields, { status: "revoked", actor: OWNER }, "and Auth gets today's body");
  assert.equal(s.record(unticked).status, "revoked");
  assert.deepEqual([(await s.events("integration_revoked")).at(-1).details.interruptRunning, s.notified.length], [false, 1]);
  assert.equal((await s.service.revokeNative(OWNER, native, { interruptRunning: false, clientId: "astation" })).state, "revoking", "and so does the native route");

  // A ticked one: Auth refuses the unknown field before it changes anything, and the Portal writes nothing.
  const before = await s.repository.integration(ticked);
  const events = (await s.events()).length;
  s.notified.length = 0;
  for (const revoke of [() => s.service.revoke(OWNER, ticked, { interruptRunning: true }), () => s.service.revokeNative(OWNER, ticked, { interruptRunning: true, clientId: "astation" })]) {
    await assert.rejects(revoke(), refused(400, "invalid_request"));
  }
  assert.deepEqual(s.manage.sent.slice(-2).map((call) => call.fields.interruptRunning), [true, true], "it was sent, and refused");
  assert.equal(s.record(ticked).status, "active", "Auth changed nothing");
  assert.deepEqual(await s.repository.integration(ticked), before, "the row is as it was");
  assert.deepEqual([(await s.events()).length, s.notified.length], [events, 0], "no event, no push");
});

test("with the setting on, the Station owner's revoke of a member's integration carries the choice", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  await s.service.approve(MEMBER, id, { r9Svc: R9 });
  const view = await s.service.revoke(OWNER, id, { interruptRunning: true });
  assert.deepEqual([view.role, view.state, view.interruptRunning, view.revokedAt], ["station_owner", "revoking", true, iso(s.clock.now)]);
  assert.equal(s.record(id).interruptRunning, true);
  const event = (await s.events("integration_revoked")).at(-1);
  assert.deepEqual([event.actor, event.account_id, event.reason, event.details], [OWNER, MEMBER, "station_owner", { seenAt: iso(s.clock.now), interruptRunning: true }]);
  assert.deepEqual((await s.repository.integration(id)).interruptRunning, true);
});

test("with the setting on, indirect revocations never interrupt: member removal, Station removal and Auth's absence", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const ready = (await s.create(MEMBER)).id;
  const waiting = (await s.create(MEMBER)).id;
  await s.repository.updateIntegration(ready, { state: "ready" });
  s.clock.now += 1000;
  await s.service.unshare(OWNER, s.station.id, MEMBER);
  const own = (await s.create(OWNER)).id;
  s.clock.now += 1000;
  await s.service.removeStation(OWNER, s.station.id);
  const second = await s.register(OWNER, "https://two.example");
  const gone = (await s.service.createIntegration(OWNER, { stationId: second.id, name: "Gone", scopes: [], publicJwk: publicJwk() })).id;
  s.clock.now += 1000;
  s.manage.records.find((entry) => entry.id === second.id).status = "removed";
  await s.service.stations(OWNER);
  const revoked = await s.events("integration_revoked");
  assert.deepEqual(revoked.map((event) => [event.integration_id, event.reason, event.actor, event.details]), [
    [ready, "member_removed", OWNER, { interruptRunning: false }],
    [waiting, "member_removed", OWNER, { interruptRunning: false }],
    [own, "station_removed", OWNER, { interruptRunning: false }],
    [gone, "reconciled", "system", { interruptRunning: false }]
  ]);
  const at = (id) => s.repository.integration(id).then((row) => [row.state, row.interruptRunning, row.revokedAt]);
  assert.deepEqual(await at(ready), ["revoking", false, iso(s.clock.now - 2000)]);
  assert.deepEqual(await at(waiting), ["revoked", false, iso(s.clock.now - 2000)]);
  assert.deepEqual(await at(own), ["revoked", false, iso(s.clock.now - 1000)]);
  assert.deepEqual(await at(gone), ["revoked", false, iso(s.clock.now)]);
});

test("revokeNative: the owner's own integrations only, recorded with the app as the client", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  await s.service.approve(MEMBER, id, { r9Svc: R9 });
  const calls = s.manage.calls.length;
  const events = (await s.events()).length;
  const options = { interruptRunning: true, clientId: "astation" };
  // Not the Station owner either: the native routes are the owner's alone, as approval is.
  for (const [accountId, target] of [[OWNER, id], [STRANGER, id], [MEMBER, "i-unknown"]]) {
    await assert.rejects(s.service.revokeNative(accountId, target, options), (error) => refused(404, "not_found")(error) && error.message === "This Station or integration was not found.", accountId + " " + target);
  }
  assert.deepEqual([s.manage.calls.length, (await s.events()).length, (await s.repository.integration(id)).state], [calls, events, "provisioning"]);
  const view = await s.service.revokeNative(MEMBER, id, options);
  assert.deepEqual([view.role, view.state, view.interruptRunning, view.revokedAt], ["owner", "revoking", true, iso(s.clock.now)]);
  assert.equal(s.record(id).interruptRunning, true);
  const event = (await s.events("integration_revoked")).at(-1);
  assert.deepEqual([event.actor, event.account_id, event.reason, event.details], [MEMBER, MEMBER, "owner", { seenAt: iso(s.clock.now), interruptRunning: true, clientId: "astation" }]);
  // A repeat is the same silent no-op.
  const repeated = await s.service.revokeNative(MEMBER, id, { interruptRunning: false, clientId: "other" });
  assert.deepEqual([repeated.interruptRunning, (await s.events()).length], [true, events + 1]);
});

test("with the setting off, revoke takes no options and changes nothing visible; revokeNative finds nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  await s.repository.updateIntegration(id, { state: "ready" });
  s.clock.now += 1000;
  const view = await s.service.revoke(OWNER, id);
  assert.equal(view.state, "revoking");
  assert.equal(Object.hasOwn(view, "revokedAt") || Object.hasOwn(view, "interruptRunning"), false, "the view is today's");
  assert.equal(s.record(id).interruptRunning, undefined, "Auth gets only the status");
  assert.equal("interruptRunning" in s.manage.feed.at(-1), false);
  assert.deepEqual((await s.events("integration_revoked")).at(-1).details, { seenAt: iso(s.clock.now) }, "the details are exactly seenAt");
  const row = await s.repository.integration(id);
  assert.deepEqual([row.revokedAt, row.interruptRunning], [iso(s.clock.now), false], "revokedAt is kept even so");
  // A choice that is given is ignored.
  const other = await s.create();
  await s.repository.updateIntegration(other.id, { state: "ready" });
  await s.service.revoke(OWNER, other.id, { interruptRunning: true });
  assert.equal(s.record(other.id).interruptRunning, undefined);
  assert.deepEqual([(await s.repository.integration(other.id)).interruptRunning, (await s.events("integration_revoked")).at(-1).details], [false, { seenAt: iso(s.clock.now) }]);
  // Indirect revocations write no choice.
  await s.service.share(OWNER, s.station.id, MEMBER);
  const theirs = await s.create(MEMBER);
  await s.service.unshare(OWNER, s.station.id, MEMBER);
  assert.deepEqual([(await s.events("integration_revoked")).at(-1).details, (await s.repository.integration(theirs.id)).revokedAt], [{}, iso(s.clock.now)]);
  await assert.rejects(s.service.revokeNative(OWNER, id, { interruptRunning: true, clientId: "astation" }), refused(404, "not_found"));
});

test("revokedAt is set whenever a revocation moves a live integration to revoking or revoked, from Auth's feed or its listing too, and never again", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const stopped = await s.create();
  const viaFeed = await s.create();
  const viaListing = await s.create();
  for (const { id } of [stopped, viaFeed, viaListing]) await s.repository.updateIntegration(id, { state: "ready" });
  await s.service.revoke(OWNER, stopped.id);
  const first = (await s.repository.integration(stopped.id)).revokedAt;
  assert.equal(first, iso(s.clock.now));
  // Auth's own revocation, read later: the time is Auth's.
  s.manage.systemRevoke(viaFeed.id, "configuration");
  const entry = (await s.manage.integrationChanges({})).changes.find((change) => change.clientId === viaFeed.id);
  s.clock.now += 5000;
  assert.equal(await s.service.applyAuthChange(entry), "applied");
  const followed = await s.repository.integration(viaFeed.id);
  assert.deepEqual([followed.state, followed.revokedAt], ["revoking", entry.at]);
  assert.notEqual(entry.at, iso(s.clock.now));
  // An entry about a stopped integration is only recorded.
  s.clock.now += 5000;
  assert.equal(await s.service.applyAuthChange({ ...entry, clientId: stopped.id, cursor: "later", at: iso(s.clock.now) }), "applied");
  assert.equal((await s.repository.integration(stopped.id)).revokedAt, first);
  // A listing that shows a revocation the Portal has not seen: it saw it just now.
  s.record(viaListing.id).status = "revoked";
  s.clock.now += 5000;
  await s.service.integrations(OWNER);
  const listed = await s.repository.integration(viaListing.id);
  assert.deepEqual([listed.state, listed.revokedAt], ["revoking", iso(s.clock.now)]);
  s.clock.now += 5000;
  await s.service.integrations(OWNER);
  assert.equal((await s.repository.integration(viaListing.id)).revokedAt, listed.revokedAt, "a later listing leaves it");
});

// D29: within 24 hours of a revocation the owner, or the custom Station's owner, may add the interrupt they did not
// ask for at first. It is the Portal's own record: Auth is not asked, the Station is told.
const INTERRUPT_STATE = "Only a revoked integration's running tasks can be interrupted.";
const INTERRUPT_LATE = "Running tasks can be interrupted only within 24 hours of the revocation.";

// A ready integration of `owner`'s, revoked by them without the interrupt.
async function revokedWithout(s, owner = OWNER) {
  const { id } = await s.create(owner);
  await s.repository.updateIntegration(id, { state: "ready" });
  await s.service.revoke(owner, id, { interruptRunning: false });
  return id;
}

test("interrupt on a revoked integration within 24 hours records it, tells the Station and asks Auth nothing; a repeat changes nothing", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await revokedWithout(s);
  const revokedAt = (await s.repository.integration(id)).revokedAt;
  s.clock.now += 3600000;
  const calls = s.manage.calls.length;
  const feedLength = s.manage.feed.length;
  const events = (await s.events()).length;
  const notified = s.notified.length;
  const view = await s.service.interrupt(OWNER, id);
  assert.deepEqual([view.role, view.state, view.interruptRunning, view.revokedAt], ["owner", "revoking", true, revokedAt], "the revocation's own date stays");
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.interruptRunning, row.revokedAt], ["revoking", true, revokedAt]);
  const written = await s.events("integration_interrupt_requested");
  assert.equal(written.length, 1);
  assert.deepEqual([written[0].integration_id, written[0].actor, written[0].account_id, written[0].reason, written[0].state, written[0].details], [id, OWNER, OWNER, "owner", "revoking", { interruptRunning: true }]);
  assert.equal((await s.events()).length, events + 1);
  assert.equal(s.notified.length, notified + 1, "the Station is notified");
  assert.equal(s.notified.at(-1), s.station.id);
  assert.deepEqual([s.manage.calls.length, s.manage.feed.length], [calls, feedLength], "Auth is not asked and wrote nothing");
  assert.equal(s.record(id).interruptRunning, false, "Auth keeps the revocation's own choice");
  // A second call, even after the 24 hours, is the same answer and changes nothing.
  s.clock.now += 2 * DAY;
  const again = await s.service.interrupt(OWNER, id);
  assert.deepEqual([again.interruptRunning, again.revokedAt], [true, revokedAt]);
  assert.deepEqual(await s.repository.integration(id), row, "the row is as it was");
  assert.deepEqual([(await s.events()).length, s.notified.length, s.manage.calls.length], [events + 1, notified + 1, calls]);
});

test("interrupt is allowed up to exactly 24 hours after the revocation, and also on a revoked one", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const revoking = await revokedWithout(s);
  const { id: revoked } = await s.create();
  await s.service.revoke(OWNER, revoked, { interruptRunning: false });
  assert.equal((await s.repository.integration(revoked)).state, "revoked", "revoked before approval");
  s.clock.now += DAY;
  for (const id of [revoking, revoked]) {
    const view = await s.service.interrupt(OWNER, id);
    assert.equal(view.interruptRunning, true, id);
  }
  assert.equal((await s.events("integration_interrupt_requested")).length, 2);
});

test("the Station's owner may interrupt a member's revoked integration, recorded as the Station owner's", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const id = await revokedWithout(s, MEMBER);
  s.clock.now += 1000;
  const view = await s.service.interrupt(OWNER, id);
  assert.deepEqual([view.role, view.state, view.interruptRunning], ["station_owner", "revoking", true]);
  const [event] = await s.events("integration_interrupt_requested");
  assert.deepEqual([event.actor, event.account_id, event.reason, event.details], [OWNER, MEMBER, "station_owner", { interruptRunning: true }]);
  // The member, who owns it, sees the same as done.
  assert.equal((await s.service.interrupt(MEMBER, id)).interruptRunning, true);
  assert.equal((await s.events("integration_interrupt_requested")).length, 1);
});

test("interrupt refusals: a stranger and an unknown ID 404; a live integration 409 invalid_state; too late or undated 409 too_late; nothing changes", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const stopped = await revokedWithout(s);
  const { id: live } = await s.create();
  const { id: paused } = await s.create();
  await s.service.pause(OWNER, paused);
  // A stopped row that was never dated.
  const { id: undated } = await s.create();
  await s.repository.updateIntegration(undated, { state: "revoked" });
  assert.equal((await s.repository.integration(undated)).revokedAt, null);
  await s.service.share(OWNER, s.station.id, MEMBER);
  const calls = s.manage.calls.length;
  const events = (await s.events()).length;
  const notified = s.notified.length;
  const message = (text, status, code) => (error) => refused(status, code)(error) && error.message === text;
  await assert.rejects(s.service.interrupt(STRANGER, stopped), message("This Station or integration was not found.", 404, "not_found"));
  await assert.rejects(s.service.interrupt(MEMBER, stopped), refused(404, "not_found"), "a member who does not own it, and does not own the Station");
  await assert.rejects(s.service.interrupt(STRANGER, live), refused(404, "not_found"), "a stranger is told nothing about its state");
  await assert.rejects(s.service.interrupt(OWNER, "i-unknown"), refused(404, "not_found"));
  await assert.rejects(s.service.interrupt(OWNER, undefined), refused(404, "not_found"));
  for (const id of [live, paused]) await assert.rejects(s.service.interrupt(OWNER, id), message(INTERRUPT_STATE, 409, "invalid_state"), id);
  // 24 hours and 1 ms after the revocation.
  const { revokedAt } = await s.repository.integration(stopped);
  s.clock.now = Date.parse(revokedAt) + DAY + 1;
  await assert.rejects(s.service.interrupt(OWNER, stopped), message(INTERRUPT_LATE, 409, "too_late"));
  await assert.rejects(s.service.interrupt(OWNER, undated), message(INTERRUPT_LATE, 409, "too_late"));
  const row = await s.repository.integration(stopped);
  assert.deepEqual([row.interruptRunning, s.manage.calls.length, (await s.events()).length, s.notified.length], [false, calls, events, notified]);
  assert.equal((await s.events("integration_interrupt_requested")).length, 0);
});

test("a revocation that already interrupts makes a later interrupt a no-op, even after 24 hours or when undated", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const { id } = await s.create();
  await s.repository.updateIntegration(id, { state: "ready" });
  await s.service.revoke(OWNER, id, { interruptRunning: true });
  const { id: undated } = await s.create();
  await s.repository.updateIntegration(undated, { state: "revoked", interruptRunning: true });
  s.clock.now += 5 * DAY;
  const events = (await s.events()).length;
  const notified = s.notified.length;
  const calls = s.manage.calls.length;
  for (const target of [id, undated]) assert.equal((await s.service.interrupt(OWNER, target)).interruptRunning, true, target);
  assert.deepEqual([(await s.events()).length, s.notified.length, s.manage.calls.length], [events, notified, calls]);
  assert.equal((await s.events("integration_interrupt_requested")).length, 0);
});

test("the history shows the interrupt, as you to the one who asked and by name to the other", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const id = await revokedWithout(s, MEMBER);
  s.clock.now += 1000;
  await s.service.interrupt(OWNER, id);
  const first = (events) => events[0] && [events[0].kind, events[0].state, events[0].reason, events[0].actor];
  assert.deepEqual(first((await s.service.history(OWNER, id)).events), ["integration_interrupt_requested", "revoking", "station_owner", "you"]);
  assert.deepEqual(first((await s.service.history(MEMBER, id)).events), ["integration_interrupt_requested", "revoking", "station_owner", OWNER]);
  assert.equal((await s.service.history(OWNER, id)).events[1].kind, "integration_revoked", "newest first");
});

// A removed Station never reads its feed again, so an interrupt recorded for its integrations would reach no host: it is
// refused, and the views of its stopped integrations say why so the page can hide the button.
const INTERRUPT_REMOVED = "This integration's Station has been removed, so its running tasks can't be interrupted here.";

test("a removed Station's integrations can't be interrupted (409 station_removed, nothing written), and their views say stationRemoved", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const mine = await revokedWithout(s);
  const theirs = await revokedWithout(s, MEMBER);
  const { id: live } = await s.create();
  // Interrupted before the removal: asking again, even after it, is the same harmless answer as anywhere else.
  const done = await revokedWithout(s);
  s.clock.now += 1000;
  await s.service.interrupt(OWNER, done);
  // Another Station, still there, with a revoked integration of the same owner.
  const other = await s.register(OWNER, "https://two.example");
  const { id: elsewhere } = await s.service.createIntegration(OWNER, { stationId: other.id, name: "Elsewhere", scopes: [], publicJwk: publicJwk() });
  await s.service.revoke(OWNER, elsewhere, { interruptRunning: false });
  const flag = async (accountId, id) => (await s.service.integrations(accountId)).integrations.find((entry) => entry.id === id);
  assert.equal(Object.hasOwn(await flag(OWNER, mine), "stationRemoved"), false, "before the removal");

  // Removing a Station revokes the rest, with no interrupt (an indirect revocation).
  await s.service.removeStation(OWNER, s.station.id);
  assert.equal((await s.repository.integration(live)).state, "revoked", "revoked at once: it was never approved");
  const calls = s.manage.calls.length;
  const events = (await s.events()).length;
  const notified = s.notified.length;
  const message = (error) => refused(409, "station_removed")(error) && error.message === INTERRUPT_REMOVED;
  for (const [accountId, id] of [[OWNER, mine], [MEMBER, theirs], [OWNER, live], [OWNER, theirs]]) await assert.rejects(s.service.interrupt(accountId, id), message, id);
  await assert.rejects(s.service.interrupt(STRANGER, mine), refused(404, "not_found"), "a stranger is still told nothing");
  assert.deepEqual([(await s.repository.integration(mine)).interruptRunning, (await s.repository.integration(live)).interruptRunning], [false, false]);
  assert.deepEqual([(await s.events()).length, s.notified.length, s.manage.calls.length], [events, notified, calls], "nothing was written, pushed or asked of Auth");
  assert.equal((await s.events("integration_interrupt_requested")).length, 1, "only the one before the removal");

  // One that was already interrupted answers 200 and changes nothing, after the removal too: only a request that would
  // change something is refused.
  const events2 = (await s.events()).length;
  const again = await s.service.interrupt(OWNER, done);
  assert.deepEqual([again.interruptRunning, again.stationRemoved], [true, true]);
  assert.deepEqual([(await s.events()).length, s.notified.length, s.manage.calls.length], [events2, notified, calls], "a repeat writes and pushes nothing");

  // The views of stopped integrations on a removed Station carry the flag; others, and the Station that is there, don't.
  const views = [await flag(OWNER, mine), await flag(MEMBER, theirs), await flag(OWNER, live)];
  assert.deepEqual(views.map((view) => [view.state, view.stationRemoved]), [["revoking", true], ["revoking", true], ["revoked", true]]);
  assert.equal(Object.hasOwn(await flag(OWNER, elsewhere), "stationRemoved"), false, "a Station that is still there");
  assert.equal(await s.service.interrupt(OWNER, elsewhere).then((view) => view.interruptRunning), true, "and its integration can still be interrupted");
  // A view from any call: a repeated revoke of one of them answers with its view.
  assert.equal((await s.service.revoke(OWNER, mine, { interruptRunning: false })).stationRemoved, true);
});

test("with the setting off, a removed Station's integrations carry no stationRemoved and interrupt finds nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  await s.repository.updateIntegration(id, { state: "ready" });
  await s.service.removeStation(OWNER, s.station.id);
  const view = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([view.state, Object.hasOwn(view, "stationRemoved")], ["revoking", false]);
  await assert.rejects(s.service.interrupt(OWNER, id), refused(404, "not_found"));
});

test("with the setting off, interrupt finds nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  await s.repository.updateIntegration(id, { state: "ready" });
  await s.service.revoke(OWNER, id);
  const events = (await s.events()).length;
  await assert.rejects(s.service.interrupt(OWNER, id), refused(404, "not_found"));
  assert.deepEqual([(await s.repository.integration(id)).interruptRunning, (await s.events()).length], [false, events]);
});
