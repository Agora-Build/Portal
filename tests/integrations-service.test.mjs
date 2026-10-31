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

async function setup(t, { wrap = (repository) => repository, admins = [] } = {}) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const clock = { now: Date.now() };
  const manage = fakeManage({ now: () => clock.now });
  const served = { status: 200, body: "" };
  const stationFetch = { async get() { return { ...served }; } };
  const notified = [];
  const logs = [];
  let counter = 0;
  const service = createIntegrationService({
    repository: wrap(repository), db, manage, stationFetch, exchange: async () => ({}), now: () => clock.now, log: (line) => logs.push(line),
    challengeValue: () => "proof-value-" + (++counter), notify: (stationId) => notified.push(stationId), admins
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
  return { db, repository, manage, clock, service, station, register, create, events, authCalls, record, notified, logs };
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
    scopes: ["agent.view", "agent.prompt"], state: "awaiting_approval", pausedFrom: null, r9Svc: null, quotaPerSecond: 200,
    expiresAt: auth.expiresAt, approvedAt: null, lastError: null, createdAt: view.createdAt, role: "owner"
  });
  const [event] = await s.events("integration_created");
  assert.deepEqual([event.account_id, event.actor, event.state, event.details], [OWNER, OWNER, "awaiting_approval", { scopes: ["agent.view", "agent.prompt"], name: "My app" }]);
  assert.deepEqual(s.notified, [s.station.id]);
  const custom = await s.create(OWNER, { scopes: ["agent.view", "agent.terminal"], quotaPerSecond: 50, expiresInDays: 90 });
  assert.deepEqual([custom.scopes, custom.quotaPerSecond, custom.expiresAt], [["agent.view", "agent.terminal"], 50, new Date(s.clock.now + 90 * DAY).toISOString()]);
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

test("two creations racing on the built-in Station can't both pass the plan limit", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  for (let i = 0; i < 3; i += 1) await onBuiltIn(s, built, OWNER, "basic");
  const results = await Promise.allSettled([onBuiltIn(s, built, OWNER, "basic"), onBuiltIn(s, built, OWNER, "basic")]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((result) => result.status === "rejected").reason.details.code, "plan_limit");
});

test("Agora.Build admins see others' integrations on the built-in Station and may pause or revoke them, nothing else", async (t) => {
  const s = await setup(t, { admins: [ADMIN] });
  if (!s) return;
  const built = await builtIn(s);
  const theirs = await onBuiltIn(s, built, OWNER);
  const other = await onBuiltIn(s, built, MEMBER);
  const custom = await s.create(OWNER);
  assert.deepEqual((await s.service.integrations(ADMIN)).integrations.map((entry) => [entry.id, entry.role]), [[theirs.id, "station_admin"], [other.id, "station_admin"]]);
  assert.deepEqual((await s.service.integrations(STRANGER)).integrations, [], "nobody else sees them");
  await assert.rejects(s.service.pause(ADMIN, custom.id), refused(404, "not_found"), "no rights on custom Stations");
  await assert.rejects(s.service.pause(STRANGER, theirs.id), refused(404, "not_found"));
  await s.service.approve(OWNER, theirs.id, { r9Svc: R9 });
  const paused = await s.service.pause(ADMIN, theirs.id);
  assert.deepEqual([paused.state, paused.role], ["paused", "station_admin"]);
  assert.equal(s.record(theirs.id).status, "paused", "Auth accepted the admin's pause");
  for (const call of [() => s.service.resume(ADMIN, theirs.id), () => s.service.renew(ADMIN, theirs.id, { expiresInDays: 10 }), () => s.service.settings(ADMIN, theirs.id, { quotaPerSecond: 5 }), () => s.service.rotateKey(ADMIN, theirs.id, { publicJwk: publicJwk() })]) {
    await assert.rejects(call(), refused(403, "forbidden"));
  }
  await assert.rejects(s.service.approve(ADMIN, other.id, { r9Svc: R9 }), refused(404, "not_found"), "never approves");
  assert.equal((await s.service.revoke(ADMIN, other.id)).state, "revoked");
  assert.deepEqual((await s.events()).filter((event) => event.actor === ADMIN).map((event) => [event.kind, event.account_id, event.reason]), [
    ["integration_paused", OWNER, "station_admin"], ["integration_revoked", MEMBER, "station_admin"]
  ]);
  assert.ok((await s.service.history(ADMIN, theirs.id)).events.length > 0);
});
