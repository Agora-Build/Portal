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
const THIRD = "ab" + "0".repeat(25) + "3";
const ADMIN = "ab" + "0".repeat(25) + "4";
const R9 = "a".repeat(64);
const ADMIN_PAUSED = "Agora.Build paused this integration. Only Agora.Build can resume it.";
const publicJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });

// `delegatedHostWork` turns the setting on in the service (D29), and Auth's side with it unless `authDelegated` says
// otherwise (the fake then writes the account entries a delegated Auth does). `wrap` wraps the repository the service
// uses; the one the tests read is the plain one.
async function setup(t, { delegatedHostWork = false, authDelegated = delegatedHostWork, wrap = (repository) => repository } = {}) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const clock = { now: Date.now() };
  const manage = fakeManage({ now: () => clock.now, delegated: authDelegated });
  const built = manage.seedBuiltIn({ integrations: true, admins: [ADMIN] });
  const notified = [];
  const logs = [];
  let asked = 0;
  const service = createIntegrationService({
    repository: wrap(repository), db, manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, exchange: async () => ({}),
    now: () => clock.now, log: (line) => logs.push(line), notify: (stationId) => notified.push(stationId), authChanged: () => { asked += 1; }, delegatedHostWork
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
  // The account-level events of a Station (no integration), oldest first.
  const accountEvents = async (stationId) => (await db.pool.query("SELECT id, kind, state, actor, reason, account_id, details FROM integration_events WHERE station_id = $1 AND integration_id IS NULL AND kind IN ('account_disabled', 'account_enabled') ORDER BY id", [stationId])).rows;
  return { db, repository, manage, clock, service, built, create, ready, follow, events, accountEvents, stationFeed, notified, logs, authAsked: () => asked };
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

// Auth accepted the owner's resume, then an admin paused the integration and the feed applied that pause before the
// Portal wrote the resume: the admin's pause is Auth's newest change, so the Portal keeps it.
test("an admin's pause the feed applies after Auth accepted the owner's resume stays: the owner gets 409 admin_paused and Auth's feed is read", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  await s.service.pause(OWNER, id);
  assert.deepEqual(await s.follow(), ["skipped"], "the owner's pause, already recorded");
  const change = s.manage.changeIntegration;
  s.manage.changeIntegration = async (...args) => {
    const answer = await change(...args);
    s.manage.changeIntegration = change;
    s.clock.now += 1000;
    s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
    assert.deepEqual(await s.follow(), ["skipped", "applied"], "the owner's resume is the Portal's own; the admin's pause applies");
    return answer;
  };
  await assert.rejects(s.service.resume(OWNER, id), (error) => error instanceof AppError && error.status === 409 && error.details.code === "admin_paused" && error.message === ADMIN_PAUSED);
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.resumeState, row.pausedBy], ["paused", "ready", "admin"]);
  assert.equal(s.manage.integrationRecords.find((entry) => entry.clientId === id).status, "paused", "as Auth has it");
  const feed = await s.stationFeed();
  const last = feed.changes.filter((entry) => entry.integrationId === id).at(-1);
  assert.deepEqual([last.kind, last.state, last.reason, stateOf(feed, id)], ["integration_paused", "paused", "agora_build", "paused"]);
  assert.equal((await s.events(id)).filter((event) => event.kind === "integration_resumed").length, 0, "no resume recorded over the admin's pause");
  assert.equal(s.authAsked(), 1, "a read of Auth's feed follows");
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
  // The Station sees Agora.Build's pause, not that the owner's account was disabled (least disclosure).
  const latestFor = (answer, id) => answer.changes.filter((change) => change.integrationId === id).at(-1);
  const masked = (change) => [change.kind, change.state, change.reason];
  assert.deepEqual([masked(latestFor(feed, live)), masked(latestFor(feed, paused))], [["integration_paused", "paused", "agora_build"], ["integration_paused", "paused", "agora_build"]]);
  // Auth still has the integration active: a listing for the owner (through an access token issued before the account
  // was disabled) must not bring it back for the Station.
  await s.service.integrations(OWNER);
  assert.equal(stateOf(await s.stationFeed(), live), "paused");
  s.manage.setOwnerDisabled(OWNER, false, { actor: ADMIN, reason: "Appeal accepted" });
  await s.follow();
  const back = await s.stationFeed();
  assert.deepEqual([stateOf(back, live), stateOf(back, paused)], ["ready", "paused"], "each is back as it was");
  assert.deepEqual([masked(latestFor(back, live)), masked(latestFor(back, paused))], [["integration_resumed", "ready", "agora_build"], ["integration_resumed", "paused", "agora_build"]], "as Agora.Build's lift");
  assert.equal(back.changes.some((change) => change.kind.includes("owner")), false, "no kind names the owner's account");
  assert.equal((await s.repository.integration(live)).ownerDisabledAt, null);
  assert.deepEqual((await s.events(live)).slice(-2).map((entry) => entry.kind), ["integration_owner_disabled", "integration_owner_enabled"], "the Portal's own record keeps what it was");
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
test("Auth accepting the owner's own call clears a stale owner-disabled flag; a listing or a call Auth refuses does not", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const live = await s.ready();
  const other = await s.ready();
  s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  await s.follow();
  await assert.rejects(s.service.settings(OWNER, live, { quotaPerSecond: 50 }), (error) => error instanceof AppError && error.status === 400 && error.details.code === "invalid_request");
  assert.ok((await s.repository.integration(live)).ownerDisabledAt, "Auth refuses a disabled owner's call, which proves nothing");
  // Enabled again with no entry the Portal reads, as an enable made in Auth's database would be.
  s.manage.setOwnerDisabled(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  s.manage.feed.splice(-2);
  await s.service.integrations(OWNER);
  assert.ok((await s.repository.integration(live)).ownerDisabledAt, "nor does a listing: Auth lists a disabled account's integrations too");
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
  const lift = feed.changes.filter((change) => change.integrationId === other).at(-1);
  assert.deepEqual([lift.kind, lift.state, lift.reason], ["integration_resumed", "ready", "agora_build"], "the Station sees Agora.Build's lift");
  const [latest] = (await s.service.history(OWNER, other)).events;
  assert.deepEqual([latest.kind, latest.actor, latest.reason], ["integration_owner_enabled", "system", "reconciled"]);
});

test("a disable the feed brings in after Auth accepted the owner's call is newer than the call, and stays", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const live = await s.ready();
  const change = s.manage.changeIntegration;
  let during = async () => {};
  s.manage.changeIntegration = async (...args) => {
    const answer = await change(...args);
    await during();
    return answer;
  };
  const flag = async () => (await s.repository.integration(live)).ownerDisabledAt;
  // Enabled again with no entry the Portal reads, so the Portal keeps a stale flag.
  const missedEnable = () => {
    s.clock.now += 1000;
    s.manage.setOwnerDisabled(OWNER, false, { actor: ADMIN, reason: "Appeal" });
    s.manage.feed.splice(-1);
  };
  s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  await s.follow();
  missedEnable();
  const stale = await flag();
  // Disabled anew after Auth accepted the call, and read before the Portal clears the stale flag.
  during = async () => {
    s.clock.now += 1000;
    s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abuse again" });
    await s.follow();
  };
  await s.service.settings(OWNER, live, { quotaPerSecond: 60 });
  assert.equal(await flag(), s.manage.feed.at(-1).at, "the flag holds the new disable's time");
  assert.notEqual(await flag(), stale);
  assert.equal(stateOf(await s.stationFeed(), live), "paused");
  assert.equal((await s.events(live)).filter((event) => event.kind === "integration_owner_enabled").length, 0);
  // Enabled and disabled again while the call runs: the newer disable stays too.
  missedEnable();
  during = async () => {
    s.clock.now += 1000;
    s.manage.setOwnerDisabled(OWNER, false, { actor: ADMIN, reason: "Appeal" });
    s.clock.now += 1000;
    s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abuse once more" });
    await s.follow();
  };
  await s.service.settings(OWNER, live, { quotaPerSecond: 70 });
  assert.equal(await flag(), s.manage.feed.at(-1).at);
  assert.equal(stateOf(await s.stationFeed(), live), "paused");
});

// A listing is Auth's state when it was fetched: a pause the feed applied after that is newer, and stays.
test("a listing fetched before an admin's pause the feed applied first leaves it paused; a later listing follows Auth", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.integrationRecords.find((entry) => entry.clientId === id).quotaPerSecond = 9;
  const list = s.manage.integrations;
  s.manage.integrations = async (account) => {
    const listed = await list(account);
    s.manage.integrations = list;
    s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
    await s.follow();
    return listed;
  };
  await s.service.integrations(OWNER);
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.pausedBy, row.quotaPerSecond], ["paused", "admin", 9], "its settings are still followed");
  assert.equal(stateOf(await s.stationFeed(), id), "paused");
  assert.equal((await s.events(id)).filter((event) => event.kind === "integration_resumed").length, 0);
  // A listing fetched later follows Auth as usual, here an admin's lift the feed has not brought yet.
  s.manage.adminChange(id, { status: "active", actor: ADMIN, reason: "Cleared" });
  await s.service.integrations(OWNER);
  assert.deepEqual([(await s.repository.integration(id)).state, stateOf(await s.stationFeed(), id)], ["ready", "ready"]);
  const event = (await s.events(id)).at(-1);
  assert.deepEqual([event.kind, event.actor, event.reason], ["integration_resumed", "system", "reconciled"]);
});

test("a listing fetched before an admin took over the owner's pause leaves it the admin's", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  await s.service.pause(OWNER, id);
  const list = s.manage.integrations;
  s.manage.integrations = async (account) => {
    const listed = await list(account);
    s.manage.integrations = list;
    s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
    await s.follow();
    return listed;
  };
  await s.service.integrations(OWNER);
  assert.equal((await s.repository.integration(id)).pausedBy, "admin");
  await assert.rejects(s.service.resume(OWNER, id), (error) => error instanceof AppError && error.details.code === "admin_paused");
});

test("an entry whose time is not written as Auth writes it is skipped", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [entry] = (await s.manage.integrationChanges()).changes;
  for (const at of [entry.at.slice(0, 19) + "Z", entry.at.slice(0, -1) + "+00:00", new Date(entry.at).toUTCString(), "2026-02-30T00:00:00.000Z"]) {
    assert.equal(await s.service.applyAuthChange({ ...entry, at }), "skipped", at);
  }
  assert.ok(s.logs.includes("Auth change skipped: not a change entry."));
  assert.equal((await s.repository.integration(id)).state, "ready");
  assert.equal(await s.service.applyAuthChange(entry), "applied");
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

// D29 (the setting on: delegatedHostWork): Auth's revoked entry says whether the revocation interrupts running tasks.
test("with the setting on, an admin's revocation with interruptRunning revokes the row with the choice and Auth's time, and the Station's feed says so", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await s.ready();
  const plain = await s.ready();
  const declined = await s.ready();
  s.clock.now += 5000;
  s.manage.adminChange(id, { status: "revoked", actor: ADMIN, reason: "Confirmed abuse", interruptRunning: true });
  s.manage.adminChange(plain, { status: "revoked", actor: ADMIN, reason: "Confirmed abuse" });
  s.manage.adminChange(declined, { status: "revoked", actor: ADMIN, reason: "Confirmed abuse", interruptRunning: false });
  // A delegated Auth records false when the choice is left out; an entry that doesn't say at all is one written while
  // Auth's setting was off, so take its key out.
  assert.equal(s.manage.feed[1].interruptRunning, false);
  delete s.manage.feed[1].interruptRunning;
  const [entry] = s.manage.feed;
  assert.equal(entry.interruptRunning, true);
  assert.equal(s.manage.integrationRecords.find((record) => record.clientId === id).interruptRunning, true, "Auth's record agrees with its entry");
  assert.deepEqual(await s.follow(), ["applied", "applied", "applied"]);
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.interruptRunning, row.revokedAt], ["revoking", true, entry.at], "dated as Auth dated it");
  assert.deepEqual((await s.events(id)).at(-1).details, { authCursor: entry.cursor, authAt: entry.at, admin: true, interruptRunning: true });
  // An entry that doesn't say, or says false, means don't interrupt.
  for (const other of [plain, declined]) {
    assert.equal((await s.repository.integration(other)).interruptRunning, false);
    assert.equal((await s.events(other)).at(-1).details.interruptRunning, false);
  }
  const feed = await s.stationFeed();
  const revoked = feed.changes.filter((change) => change.kind === "integration_revoked");
  assert.deepEqual(revoked.map((change) => [change.integrationId, change.reason, change.interruptRunning]), [[id, "agora_build", true], [plain, "agora_build", false], [declined, "agora_build", false]]);
  assert.equal(revoked[0].integration.interruptRunning, true);
  assert.equal(feed.integrations.find((entry) => entry.id === id).interruptRunning, true);
});

test("with the setting on, an admin's revocation entry for a row the owner already revoked still sets the choice, and only ever to true", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await s.ready();
  await s.service.revoke(OWNER, id, { interruptRunning: false });
  const own = s.manage.feed.at(-1);
  assert.deepEqual([own.kind, own.admin, own.interruptRunning], ["revoked", false, false]);
  const before = await s.repository.integration(id);
  const admins = (interruptRunning, n) => ({ ...own, cursor: "admin" + n, at: new Date(Date.parse(own.at) + n * 1000).toISOString(), actorAccountId: ADMIN, reason: "Confirmed abuse", admin: true, interruptRunning });
  assert.equal(await s.service.applyAuthChange(admins(true, 1)), "applied");
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.interruptRunning, row.revokedAt], ["revoking", true, before.revokedAt], "the revocation's date stays");
  assert.equal(await s.service.applyAuthChange(admins(false, 2)), "applied", "recorded");
  assert.equal((await s.repository.integration(id)).interruptRunning, true, "never back to false");
});

test("with the setting on, an admin's interrupt after the owner's own revocation sets the row's flag, is written once as Agora.Build's, and reaches the Station", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await s.ready();
  const untouched = await s.ready();
  await s.service.revoke(OWNER, id, { interruptRunning: false });
  await s.service.revoke(OWNER, untouched, { interruptRunning: false });
  s.clock.now += 3600000;
  s.manage.interruptChange(id, { actor: ADMIN, reason: "Still running" });
  s.manage.interruptChange(id, { actor: ADMIN, reason: "Again" });
  const entry = s.manage.feed.at(-1);
  assert.deepEqual([entry.kind, entry.status, entry.interruptRunning, entry.admin], ["interrupt_requested", "revoked", true, true]);
  assert.equal(s.manage.feed.filter((change) => change.kind === "interrupt_requested").length, 1, "Auth writes an entry only for a real change");
  s.notified.length = 0;
  assert.deepEqual(await s.follow(), ["skipped", "skipped", "applied"], "the owner's two revocations are the Portal's own");
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.interruptRunning], ["revoking", true]);
  assert.equal((await s.repository.integration(untouched)).interruptRunning, false);
  const interrupts = (await s.events(id)).filter((event) => event.kind === "integration_interrupt_requested");
  assert.equal(interrupts.length, 1);
  assert.deepEqual([interrupts[0].state, interrupts[0].actor, interrupts[0].reason], ["revoking", ADMIN, "Still running"]);
  assert.deepEqual(interrupts[0].details, { authCursor: entry.cursor, authAt: entry.at, admin: true, interruptRunning: true });
  assert.deepEqual(s.notified, [s.built.id], "the Station is pushed");
  // The owner's history names Agora.Build, not the admin or the reason.
  const [latest] = (await s.service.history(OWNER, id)).events;
  assert.deepEqual([latest.kind, latest.state, latest.reason, latest.actor], ["integration_interrupt_requested", "revoking", null, "agora_build"]);
  // The Station's feed has it as Agora.Build's change, with the integration carrying the flag.
  const change = (await s.stationFeed()).changes.at(-1);
  assert.deepEqual([change.integrationId, change.kind, change.state, change.reason, change.interruptRunning, change.integration.interruptRunning], [id, "integration_interrupt_requested", "revoking", "agora_build", true, true]);
  // The same entry again changes nothing.
  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange(entry), "skipped");
  assert.equal((await s.events(id)).filter((event) => event.kind === "integration_interrupt_requested").length, 1);
  assert.deepEqual(s.notified, []);
});

test("with the setting on, an account's disabling is one event per built-in Station and none on a custom Station, ahead of its integrations' owner_disabled events", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const second = s.manage.seedBuiltIn({ id: "stbuiltin2", origin: "https://station2.agora.test", name: "Second", integrations: true, admins: [ADMIN], reportClientId: "s-" + "0".repeat(24) + "b2" });
  assert.equal(await s.service.syncBuiltIn(), true);
  const custom = await s.manage.registerStation({ origin: "https://custom.example", owner: OWNER, reportKey: publicJwk(), actor: OWNER });
  await s.service.stations(OWNER); // brings the custom Station in
  const customStation = await s.repository.station(custom.id);
  assert.equal(customStation.builtIn, false);
  const liveA = await s.ready();
  const liveB = await s.ready();
  await s.ready(OTHER);

  s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abusive integrations" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Owns no integration" });
  assert.deepEqual(s.manage.feed.map((entry) => [entry.kind, entry.clientId === null]), [["account_disabled", true], ["owner_disabled", false], ["owner_disabled", false], ["account_disabled", true]], "Auth writes the account's entry first");
  const [account] = s.manage.feed;
  assert.deepEqual([account.stationId, account.status, account.owner, account.actorAccountId, account.reason, account.admin, Object.hasOwn(account, "interruptRunning")], [null, null, OWNER, ADMIN, "Abusive integrations", true, false]);
  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange(account), "applied");
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort(), "each built-in Station is pushed, the custom Station not");
  assert.deepEqual(await s.follow(), ["skipped", "applied", "applied", "applied"], "the first entry was applied once already");

  // One event on each built-in Station for each account, naming the account, the admin and their reason.
  for (const station of [s.built, second]) {
    const written = await s.accountEvents(station.id);
    assert.deepEqual(written.map((event) => [event.kind, event.state, event.actor, event.reason, event.account_id]), [
      ["account_disabled", null, ADMIN, "Abusive integrations", OWNER], ["account_disabled", null, ADMIN, "Owns no integration", THIRD]
    ], station.id);
    assert.deepEqual(written[0].details, { authCursor: account.cursor, authAt: account.at, admin: true });
  }
  assert.deepEqual(await s.accountEvents(custom.id), [], "a custom Station's operator isn't told");

  // The Station's feed: the account's change comes ahead of its integrations' pauses, as Agora.Build's, and a
  // cursor-0 read lists every account disabled now.
  const feed = await s.stationFeed();
  const kinds = feed.changes.filter((change) => ["account_disabled", "integration_paused"].includes(change.kind));
  assert.deepEqual(kinds.map((change) => [change.kind, change.integrationId, change.account ?? null]), [["account_disabled", null, OWNER], ["integration_paused", liveA, null], ["integration_paused", liveB, null], ["account_disabled", null, THIRD]]);
  const change = kinds[0];
  assert.deepEqual(Object.keys(change).sort(), ["account", "at", "id", "integrationId", "kind", "reason", "state"]);
  assert.deepEqual([change.integrationId, change.kind, change.state, change.reason, change.account], [null, "account_disabled", null, "agora_build", OWNER]);
  assert.deepEqual(feed.disabledAccounts, [OWNER, THIRD]);
  assert.deepEqual((await s.service.changes(second.reportClientId, 0)).disabledAccounts, [OWNER, THIRD], "every built-in Station has it");
  assert.equal(Object.hasOwn(await s.service.changes(s.built.reportClientId, String(feed.cursor)), "disabledAccounts"), false, "only the snapshot of cursor 0 does");
  const customFeed = await s.service.changes(customStation.reportClientId, 0);
  assert.equal(Object.hasOwn(customFeed, "disabledAccounts"), false);
  assert.equal(customFeed.changes.some((entry) => entry.kind.startsWith("account_")), false);

  // Enabling clears the account from the snapshot and is a change of its own.
  s.manage.setOwnerDisabled(OWNER, false, { actor: ADMIN, reason: "Appeal accepted" });
  assert.deepEqual(await s.follow(), ["applied", "applied", "applied"]);
  const back = await s.stationFeed();
  assert.deepEqual(back.disabledAccounts, [THIRD]);
  const enabled = back.changes.filter((entry) => entry.kind === "account_enabled");
  assert.deepEqual(enabled.map((entry) => [entry.integrationId, entry.state, entry.reason, entry.account]), [[null, null, "agora_build", OWNER]]);
  assert.deepEqual((await s.accountEvents(s.built.id)).slice(-1).map((event) => [event.kind, event.reason]), [["account_enabled", "Appeal accepted"]]);
  s.manage.accountChange(THIRD, false, { actor: ADMIN, reason: "Cleared" });
  await s.follow();
  assert.deepEqual((await s.stationFeed()).disabledAccounts, []);
  assert.deepEqual((await s.service.changes(second.reportClientId, 0)).disabledAccounts, []);
});

test("with the setting on, an account entry is applied once however often it is read, and again at another time", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  const [entry] = s.manage.feed;
  assert.equal(await s.service.applyAuthChange(entry), "applied");
  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange(entry), "skipped");
  assert.equal(await s.service.applyAuthChange({ ...entry }), "skipped");
  assert.equal((await s.accountEvents(s.built.id)).length, 1);
  assert.deepEqual(s.notified, []);
  // The same cursor at another time is another change (Auth's database was restored and handed it out again).
  assert.equal(await s.service.applyAuthChange({ ...entry, at: new Date(Date.parse(entry.at) + 1000).toISOString() }), "applied");
  assert.equal((await s.accountEvents(s.built.id)).length, 2);
  assert.deepEqual((await s.stationFeed()).disabledAccounts, [OWNER], "once, however many times it was disabled");
});

test("with the setting on, entries of the wrong shape for their kind are skipped and logged, and an account entry is Auth's admin's or system's only", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [account, paused] = s.manage.feed;
  const bad = [
    { ...account, clientId: id }, { ...account, clientId: undefined }, { ...account, owner: "not an account" }, { ...account, owner: undefined }, { ...account, owner: null },
    { ...paused, clientId: null }, { ...paused, clientId: undefined }, { ...account, kind: "account_deleted" }
  ];
  for (const entry of bad) assert.equal(await s.service.applyAuthChange(entry), "skipped", JSON.stringify(entry));
  assert.ok(s.logs.includes("Auth change skipped: not a change entry."));
  assert.equal((await s.accountEvents(s.built.id)).length, 0);
  assert.equal((await s.events(id)).filter((event) => event.kind === "integration_paused").length, 0);
  // A person's own change is the Portal's own; Auth writes these two kinds for its admin or system only.
  assert.equal(await s.service.applyAuthChange({ ...account, admin: false, actorAccountId: OTHER }), "skipped");
  assert.equal((await s.accountEvents(s.built.id)).length, 0);
  assert.equal(await s.service.applyAuthChange({ ...account, admin: false, actorAccountId: null }), "applied", "Auth's own, with no actor");
  assert.deepEqual((await s.accountEvents(s.built.id)).map((event) => [event.actor, event.details.admin]), [["system", false]]);
});

test("with the setting off, Auth's interrupt and account entries are skipped as not change entries and nothing is written; a revocation's choice is ignored", async (t) => {
  const s = await setup(t, { authDelegated: true });
  if (!s) return;
  const id = await s.ready();
  const chosen = await s.ready();
  const live = await s.ready();
  s.manage.adminChange(id, { status: "revoked", actor: ADMIN, reason: "Abuse", interruptRunning: false });
  s.manage.adminChange(chosen, { status: "revoked", actor: ADMIN, reason: "Abuse", interruptRunning: true });
  s.manage.interruptChange(id, { actor: ADMIN, reason: "Interrupt" });
  s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  assert.deepEqual(s.manage.feed.map((entry) => entry.kind), ["revoked", "revoked", "interrupt_requested", "account_disabled", "owner_disabled"]);
  // The skipped entries push no Station; the others push the built-in Station.
  s.notified.length = 0;
  for (const entry of s.manage.feed.slice(2, 4)) assert.equal(await s.service.applyAuthChange(entry), "skipped");
  assert.deepEqual(s.notified, []);
  assert.deepEqual(await s.follow(), ["applied", "applied", "skipped", "skipped", "applied"]);
  assert.deepEqual([...new Set(s.notified)], [s.built.id]);
  assert.ok(s.logs.includes("Auth change skipped: not a change entry."));
  const written = await s.db.pool.query("SELECT kind FROM integration_events WHERE kind IN ('integration_interrupt_requested', 'account_disabled', 'account_enabled')");
  assert.deepEqual(written.rows, []);
  for (const revoked of [id, chosen]) assert.equal((await s.repository.integration(revoked)).interruptRunning, false);
  const [entry] = s.manage.feed;
  assert.deepEqual((await s.events(id)).at(-1).details, { authCursor: entry.cursor, authAt: entry.at, admin: true }, "as before the setting");
  assert.ok((await s.repository.integration(live)).ownerDisabledAt, "the entries before and after it are followed as they were");
  assert.equal(Object.hasOwn(await s.stationFeed(), "disabledAccounts"), false);
});

// The Station's feed reports what was recorded (as Auth's does), but it carries the new fields only while the setting is
// on: a service with it off, reading the events and rows recorded while it was on, serves the account changes (with their
// account) and the interrupt kind, but no interruptRunning anywhere and no disabledAccounts.
test("a service with the setting off serves what was recorded while it was on: account changes and the interrupt kind, without interruptRunning or disabledAccounts", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await s.ready();
  const revoked = await s.ready();
  await s.service.revoke(OWNER, id, { interruptRunning: false });
  s.manage.setOwnerDisabled(OTHER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.adminChange(revoked, { status: "revoked", actor: ADMIN, reason: "Confirmed abuse", interruptRunning: true });
  s.clock.now += 1000;
  s.manage.interruptChange(id, { actor: ADMIN, reason: "Still running" });
  await s.follow();
  const on = await s.stationFeed();
  assert.deepEqual(on.disabledAccounts, [OTHER], "while on, the snapshot lists it");
  assert.equal(on.changes.some((change) => change.kind === "integration_interrupt_requested" && change.interruptRunning === true && change.integration.interruptRunning === true), true, "and the interrupt carries the choice");

  // The same database and rows, read by a service with the setting off.
  const off = createIntegrationService({
    repository: s.repository, db: s.db, manage: s.manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, exchange: async () => ({}),
    now: () => s.clock.now, log: () => {}, notify: () => {}, authChanged: () => {}
  });
  const feed = await off.changes(s.built.reportClientId, "0");
  const account = feed.changes.find((change) => change.kind === "account_disabled");
  assert.deepEqual(account, { id: account.id, at: account.at, integrationId: null, kind: "account_disabled", state: null, reason: "agora_build", account: OTHER }, "an account change is served as recorded, with its account");
  assert.equal(Object.hasOwn(feed, "disabledAccounts"), false, "no snapshot of disabled accounts");
  const interrupt = feed.changes.find((change) => change.kind === "integration_interrupt_requested");
  assert.ok(interrupt, "the interrupt kind is served");
  assert.equal(interrupt.integrationId, id);
  assert.equal(Object.hasOwn(interrupt, "interruptRunning"), false, "without the choice");
  assert.equal(Object.hasOwn(interrupt.integration, "interruptRunning"), false, "on its integration either");
  for (const change of feed.changes.filter((entry) => entry.integration)) assert.equal(Object.hasOwn(change, "interruptRunning") || Object.hasOwn(change.integration, "interruptRunning"), false, change.kind);
  for (const entry of feed.integrations) assert.equal(Object.hasOwn(entry, "interruptRunning"), false, entry.id);
  assert.equal((await s.repository.integration(id)).interruptRunning, true, "the Portal still has the row's choice");
  assert.equal(Object.hasOwn(await off.changes(s.built.reportClientId, String(feed.cursor)), "disabledAccounts"), false);
});

// Each built-in Station is pushed as its own write commits: a later Station's failure (the reader reads the entry again)
// doesn't hold back the earlier ones, and the entry then completes without writing or pushing the first again.
test("with the setting on, an account entry pushes each built-in Station as its own write commits, and a later Station's failed write leaves the earlier one pushed", async (t) => {
  const control = { failStation: null, noBuiltIn: false };
  const s = await setup(t, {
    delegatedHostWork: true,
    wrap: (repository) => ({
      ...repository,
      appendEvent: async (event, client) => {
        if (event.stationId === control.failStation && event.kind === "account_disabled") throw new Error("write failed");
        return repository.appendEvent(event, client);
      },
      builtInStations: async (...args) => (control.noBuiltIn ? [] : repository.builtInStations(...args))
    })
  });
  if (!s) return;
  const second = s.manage.seedBuiltIn({ id: "stbuiltin2", origin: "https://station2.agora.test", name: "Second", integrations: true, admins: [ADMIN], reportClientId: "s-" + "0".repeat(24) + "b2" });
  assert.equal(await s.service.syncBuiltIn(), true);
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  const [entry] = s.manage.feed;

  control.failStation = second.id;
  s.notified.length = 0;
  await assert.rejects(s.service.applyAuthChange(entry), /write failed/);
  assert.deepEqual(s.notified, [s.built.id], "the first Station is pushed, as its write committed");
  assert.equal((await s.accountEvents(s.built.id)).length, 1);
  assert.equal((await s.accountEvents(second.id)).length, 0);

  control.failStation = null;
  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange(entry), "applied", "read again, it completes");
  assert.deepEqual(s.notified, [second.id], "only the Station that was missing");
  assert.deepEqual([(await s.accountEvents(s.built.id)).length, (await s.accountEvents(second.id)).length], [1, 1]);
  assert.equal(await s.service.applyAuthChange(entry), "skipped");

  // With no active built-in Station there is nothing to record, and the skip is logged.
  control.noBuiltIn = true;
  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange({ ...entry, cursor: "another" }), "skipped");
  assert.ok(s.logs.includes("Auth account change skipped: no built-in Station."));
  assert.deepEqual(s.notified, []);
});

function stateOf(answer, id) {
  return answer.integrations.find((entry) => entry.id === id).state;
}
