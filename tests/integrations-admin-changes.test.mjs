// Auth's change feed applied by the service (applyAuthChange, spec §3.3.4 "Owner decisions after the Auth review"),
// against the test database and the in-memory Auth, whose adminChange, systemRevoke and setOwnerDisabled stand in for
// the admin site's calls and Auth's own changes (Auth D26 Tasks 13 and 14).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { createIntegrationService } from "../scripts/integrations/service.mjs";
import { AppError } from "../scripts/store.mjs";
import { fakeManage } from "./helpers/fake-manage.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const OWNER = "ab" + "0".repeat(25) + "1";
const OTHER = "ab" + "0".repeat(25) + "2";
const ADMIN = "ab" + "0".repeat(25) + "4";
const R9 = "a".repeat(64);
const publicJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });

async function setup(t) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const clock = { now: Date.now() };
  const manage = fakeManage({ now: () => clock.now });
  const built = manage.seedBuiltIn({ integrations: true, admins: [ADMIN] });
  const notified = [];
  const logs = [];
  const service = createIntegrationService({
    repository, db, manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, exchange: async () => ({}),
    now: () => clock.now, log: (line) => logs.push(line), notify: (stationId) => notified.push(stationId)
  });
  await service.syncBuiltIn();
  const create = async (accountId = OWNER) => (await service.createIntegration(accountId, { stationId: built.id, name: "Hosted", scopes: [], publicJwk: publicJwk() })).id;
  const ready = async (accountId = OWNER) => {
    const id = await create(accountId);
    await service.approve(accountId, id, { r9Svc: R9 });
    await repository.updateIntegration(id, { state: "ready" });
    return id;
  };
  // Applies every entry of Auth's feed after the last one applied, as the reader does; returns what each did.
  let seen;
  const follow = async () => {
    const { changes, nextCursor } = await manage.integrationChanges({ after: seen });
    seen = nextCursor ?? undefined;
    const results = [];
    for (const change of changes) results.push(await service.applyAuthChange(change));
    return results;
  };
  const events = async (id) => (await db.pool.query("SELECT kind, state, actor, reason, details FROM integration_events WHERE integration_id = $1 ORDER BY id", [id])).rows;
  const stationFeed = () => service.changes(built.reportClientId, "0");
  return { db, repository, manage, clock, service, built, create, ready, follow, events, stationFeed, notified, logs };
}

test("an admin's pause in Auth's feed pauses the Portal's row, records the admin and the reason, and pushes the Station", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.notified.length = 0;
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam in #general" });
  assert.deepEqual(await s.follow(), ["applied"]);
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.resumeState, row.pausedBy], ["paused", "ready", "admin"]);
  const event = (await s.events(id)).at(-1);
  assert.deepEqual([event.kind, event.state, event.actor, event.reason], ["integration_paused", "paused", ADMIN, "Spam in #general"]);
  const entry = s.manage.feed.at(-1);
  assert.deepEqual(event.details, { authCursor: entry.cursor, authAt: entry.at, admin: true, pausedBy: "admin" });
  assert.deepEqual(s.notified, [s.built.id], "the Station is pushed");
  // The Station's feed has it, with the integration paused, and says only that Agora.Build did it.
  const change = (await s.stationFeed()).changes.at(-1);
  assert.deepEqual([change.integrationId, change.kind, change.state, change.reason, change.integration.state], [id, "integration_paused", "paused", "agora_build", "paused"]);
  // The owner sees Paused by Agora.Build; the history names Agora.Build, not the admin or the reason.
  const view = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([view.state, view.pausedBy], ["paused", "admin"]);
  const [latest] = (await s.service.history(OWNER, id)).events;
  assert.deepEqual([latest.kind, latest.state, latest.reason, latest.actor], ["integration_paused", "paused", null, "agora_build"]);
});

test("each entry is applied once, however often the feed is read again", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [entry] = (await s.manage.integrationChanges()).changes.filter((change) => change.clientId === id && change.admin);
  assert.equal(await s.service.applyAuthChange(entry), "applied");
  const count = (await s.events(id)).length;
  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange(entry), "skipped");
  assert.equal(await s.service.applyAuthChange({ ...entry }), "skipped");
  assert.equal((await s.events(id)).length, count);
  assert.deepEqual(s.notified, []);
  // The same cursor at another time is another change (Auth's database was restored and handed it out again).
  assert.equal(await s.service.applyAuthChange({ ...entry, at: new Date(Date.parse(entry.at) + 1000).toISOString() }), "applied");
});

test("the Portal's own changes in the feed are skipped; Auth's own are followed, with the system as actor", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  await s.service.pause(OWNER, id);
  await s.service.resume(OWNER, id);
  const count = (await s.events(id)).length;
  assert.deepEqual(await s.follow(), ["skipped", "skipped"], "the owner's pause and resume, already recorded");
  assert.equal((await s.events(id)).length, count);
  s.manage.systemRevoke(id, "configuration");
  assert.deepEqual(await s.follow(), ["applied"]);
  assert.equal((await s.repository.integration(id)).state, "revoking", "until the Station confirms");
  const event = (await s.events(id)).at(-1);
  assert.deepEqual([event.kind, event.actor, event.reason, event.details.admin], ["integration_revoked", "system", "configuration", false]);
  assert.equal((await s.stationFeed()).changes.at(-1).reason, "configuration", "Auth's own reason is a code, shown as it is");
});

test("an admin's pause of an owner's pause makes it the admin's; only the admin's lift resumes it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  await s.service.pause(OWNER, id);
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Abuse reports" });
  assert.deepEqual(await s.follow(), ["skipped", "applied"]);
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.resumeState, row.pausedBy], ["paused", "ready", "admin"]);
  assert.deepEqual((await s.events(id)).slice(-2).map((event) => [event.kind, event.actor, event.details.pausedBy ?? null]), [["integration_paused", OWNER, null], ["integration_paused", ADMIN, "admin"]]);
  await assert.rejects(s.service.resume(OWNER, id), (error) => error instanceof AppError && error.status === 409 && error.details.code === "admin_paused");
  s.manage.adminChange(id, { status: "active", actor: ADMIN, reason: "Cleared after review" });
  assert.deepEqual(await s.follow(), ["applied"]);
  const lifted = await s.repository.integration(id);
  assert.deepEqual([lifted.state, lifted.resumeState, lifted.pausedBy], ["ready", null, null]);
  assert.equal((await s.stationFeed()).changes.at(-1).integration.state, "ready");
});

test("an admin's revocation in the feed revokes the Portal's row: revoking until the Station confirms, or at once before approval", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const live = await s.ready();
  const waiting = await s.create();
  for (const id of [live, waiting]) s.manage.adminChange(id, { status: "revoked", actor: ADMIN, reason: "Confirmed abuse" });
  assert.deepEqual(await s.follow(), ["applied", "applied"]);
  assert.equal((await s.repository.integration(live)).state, "revoking");
  assert.equal((await s.repository.integration(waiting)).state, "revoked");
  const states = Object.fromEntries((await s.stationFeed()).integrations.map((entry) => [entry.id, entry.state]));
  assert.deepEqual([states[live], states[waiting]], ["revoking", "revoked"]);
});

test("disabling an owner's account pauses its integrations for the Station until it is enabled; each keeps its own state, and the owner's listing never undoes it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const live = await s.ready();
  const paused = await s.ready();
  await s.service.pause(OWNER, paused);
  const others = await s.ready(OTHER);
  s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abusive integrations" });
  assert.equal((await s.follow()).filter((result) => result === "applied").length, 2, "one entry per integration the account owns");
  for (const id of [live, paused]) assert.ok((await s.repository.integration(id)).ownerDisabledAt);
  assert.equal((await s.repository.integration(others)).ownerDisabledAt, null);
  const feed = await s.stationFeed();
  const stateOf = (answer, id) => answer.integrations.find((entry) => entry.id === id).state;
  assert.deepEqual([stateOf(feed, live), stateOf(feed, paused), stateOf(feed, others)], ["paused", "paused", "ready"]);
  const event = (await s.events(live)).at(-1);
  assert.deepEqual([event.kind, event.state, event.actor, event.reason], ["integration_owner_disabled", "paused", ADMIN, "Abusive integrations"]);
  assert.equal(feed.changes.find((change) => change.integrationId === live && change.kind === "integration_owner_disabled").reason, "agora_build");
  // Auth still has the integration active: a listing for the owner (through an access token issued before the account
  // was disabled) must not bring it back for the Station.
  await s.service.integrations(OWNER);
  assert.equal(stateOf(await s.stationFeed(), live), "paused");
  s.manage.setOwnerDisabled(OWNER, false, { actor: ADMIN, reason: "Appeal accepted" });
  await s.follow();
  const back = await s.stationFeed();
  assert.deepEqual([stateOf(back, live), stateOf(back, paused)], ["ready", "paused"], "each is back as it was");
  assert.equal((await s.repository.integration(live)).ownerDisabledAt, null);
  assert.equal((await s.events(live)).at(-1).kind, "integration_owner_enabled");
});

test("entries that are not changes, and changes to integrations the Portal does not know, are skipped and logged", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [entry] = (await s.manage.integrationChanges()).changes;
  for (const bad of [null, "x", { ...entry, kind: "deleted" }, { ...entry, cursor: "not a cursor" }, { ...entry, clientId: 7 }, { ...entry, at: undefined }]) {
    assert.equal(await s.service.applyAuthChange(bad), "skipped", JSON.stringify(bad));
  }
  assert.ok(s.logs.includes("Auth change skipped: not a change entry."));
  assert.equal(await s.service.applyAuthChange({ ...entry, clientId: "i-" + "9".repeat(26) }), "skipped");
  assert.ok(s.logs.includes("Auth change skipped: the integration is unknown to Portal."));
  assert.equal((await s.repository.integration(id)).state, "ready");
});

test("a change the owner's listing already followed is still recorded once, with the admin as actor", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  await s.service.integrations(OWNER); // follows Auth's status first, as the system
  assert.deepEqual(await s.follow(), ["applied"]);
  assert.deepEqual((await s.events(id)).slice(-2).map((event) => [event.kind, event.actor, event.reason]), [["integration_paused", "system", "reconciled"], ["integration_paused", ADMIN, "Spam"]]);
});

// Ruling R-A: the feed can be read after the Portal already followed a newer change (the owner's listing, the owner's
// own call). The older entry is still recorded, but a resume never undoes a newer pause; later entries still apply.
test("a resume read after the owner's listing followed it and the owner paused again is recorded, and the integration stays paused", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  assert.deepEqual(await s.follow(), ["applied"]);
  s.clock.now += 1000;
  s.manage.adminChange(id, { status: "active", actor: ADMIN, reason: "Cleared" });
  s.clock.now += 1000;
  await s.service.integrations(OWNER);
  assert.equal((await s.repository.integration(id)).state, "ready", "the owner's listing follows the lift first");
  s.clock.now += 1000;
  await s.service.pause(OWNER, id);
  s.notified.length = 0;
  assert.deepEqual(await s.follow(), ["applied", "skipped"], "the lift is recorded; the owner's pause is the Portal's own");
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.resumeState, row.pausedBy], ["paused", "ready", "owner"]);
  assert.equal(s.manage.integrationRecords.find((entry) => entry.clientId === id).status, "paused", "as Auth has it");
  const event = (await s.events(id)).at(-1);
  assert.deepEqual([event.kind, event.state, event.actor, event.reason, event.details.superseded], ["integration_resumed", "paused", ADMIN, "Cleared", true]);
  assert.ok(s.logs.includes("Auth change recorded without its state change: the Portal has a newer one."));
  assert.equal((await s.stationFeed()).changes.at(-1).integration.state, "paused", "the Station still has it paused");
  assert.deepEqual(s.notified, [s.built.id]);
  s.clock.now += 1000;
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Again" });
  s.clock.now += 1000;
  s.manage.adminChange(id, { status: "active", actor: ADMIN, reason: "Cleared again" });
  assert.deepEqual(await s.follow(), ["applied", "applied"]);
  const lifted = await s.repository.integration(id);
  assert.deepEqual([lifted.state, lifted.pausedBy], ["ready", null], "a lift newer than the owner's pause applies");
  assert.equal(s.manage.integrationRecords.find((entry) => entry.clientId === id).status, "active");
});

test("an admin's pause read after the owner revoked the integration is recorded, and the integration stays revoked", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  await s.service.revoke(OWNER, id);
  assert.deepEqual(await s.follow(), ["applied", "skipped"]);
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.pausedBy], ["revoking", null]);
  const event = (await s.events(id)).at(-1);
  assert.deepEqual([event.kind, event.state, event.actor, event.reason], ["integration_paused", "revoking", ADMIN, "Spam"]);
  assert.equal((await s.stationFeed()).changes.at(-1).integration.state, "revoking");
});

// Ruling R-D: Auth refuses a call that names a disabled account as actor, so a call it accepts proves the account is
// enabled, and an owner-disabled flag whose owner_enabled the Portal never read is cleared.
test("Auth accepting the owner's own call clears a stale owner-disabled flag; a listing or a refused call does not", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const live = await s.ready();
  const other = await s.ready();
  s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  await s.follow();
  // Enabled again with no entry the Portal reads, as an enable made in Auth's database would be.
  s.manage.setOwnerDisabled(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  s.manage.feed.splice(-2);
  await s.service.integrations(OWNER);
  assert.ok((await s.repository.integration(live)).ownerDisabledAt, "Auth lists a disabled account's integrations too");
  s.manage.failNext.changeIntegration = { status: 400, code: "invalid_request" };
  await assert.rejects(s.service.settings(OWNER, live, { quotaPerSecond: 50 }), (error) => error instanceof AppError && error.status === 400);
  assert.ok((await s.repository.integration(live)).ownerDisabledAt, "a call Auth refuses proves nothing");
  s.notified.length = 0;
  assert.equal((await s.service.settings(OWNER, live, { quotaPerSecond: 50 })).quotaPerSecond, 50);
  const feed = await s.stationFeed();
  for (const id of [live, other]) {
    assert.equal((await s.repository.integration(id)).ownerDisabledAt, null);
    const event = (await s.events(id)).filter((entry) => entry.kind === "integration_owner_enabled").at(-1);
    assert.deepEqual([event.state, event.actor, event.reason], ["ready", "system", "reconciled"]);
    assert.equal(feed.integrations.find((entry) => entry.id === id).state, "ready");
  }
  assert.ok(s.notified.includes(s.built.id));
  assert.ok(s.logs.includes("Owner-disabled flag cleared: Auth accepted a call by the owner."));
  const [latest] = (await s.service.history(OWNER, other)).events;
  assert.deepEqual([latest.kind, latest.actor, latest.reason], ["integration_owner_enabled", "system", "reconciled"]);
});

test("a disable the feed brings in while the owner's call runs is newer than the call, and stays", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const live = await s.ready();
  const change = s.manage.changeIntegration;
  let during = () => {};
  s.manage.changeIntegration = async (...args) => {
    const answer = await change(...args);
    await during();
    return answer;
  };
  // Not disabled when the call began, disabled before it ended.
  during = async () => {
    s.clock.now += 1000;
    s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abuse" });
    await s.follow();
  };
  await s.service.settings(OWNER, live, { quotaPerSecond: 60 });
  const first = (await s.repository.integration(live)).ownerDisabledAt;
  assert.ok(first);
  // Disabled when the call began, then enabled and disabled again before it ended.
  during = async () => {
    s.clock.now += 1000;
    s.manage.setOwnerDisabled(OWNER, false, { actor: ADMIN, reason: "Appeal" });
    s.clock.now += 1000;
    s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abuse again" });
    await s.follow();
  };
  await s.service.settings(OWNER, live, { quotaPerSecond: 70 });
  const second = (await s.repository.integration(live)).ownerDisabledAt;
  assert.ok(second && second !== first, "the newer disable stays");
  assert.equal(stateOf(await s.stationFeed(), live), "paused");
  s.manage.changeIntegration = change;
});

// The Station's report answer says what its feed says: who paused an integration stays with the Portal and its owner.
test("the Station's report answer does not say who paused an integration", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  await s.follow();
  const answer = await s.service.report(s.built.reportClientId, { integrationId: id, state: "ready" });
  assert.deepEqual([answer.id, answer.state, answer.pausedFrom], [id, "paused", "ready"]);
  assert.equal(Object.hasOwn(answer, "pausedBy"), false);
  assert.equal(Object.hasOwn(answer, "role"), false);
});

function stateOf(answer, id) {
  return answer.integrations.find((entry) => entry.id === id).state;
}
