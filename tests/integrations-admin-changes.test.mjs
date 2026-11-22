// Auth's change feed applied by the service (applyAuthChange, spec §3.3.4 "Owner decisions after the Auth review"),
// against the test database and the in-memory Auth, whose adminChange, systemRevoke and setOwnerDisabled stand in for
// the admin site's calls and Auth's own changes (Auth D26 Tasks 13 and 14).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createAuthChanges } from "../scripts/integrations/auth-changes.mjs";
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
// uses; the one the tests read is the plain one. `seeded: false` leaves Auth without a built-in Station (`built` is null).
async function setup(t, { delegatedHostWork = false, authDelegated = delegatedHostWork, wrap = (repository) => repository, seeded = true } = {}) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const clock = { now: Date.now() };
  const manage = fakeManage({ now: () => clock.now, delegated: authDelegated });
  const built = seeded ? manage.seedBuiltIn({ integrations: true, admins: [ADMIN] }) : null;
  const notified = [];
  const logs = [];
  let asked = 0;
  const service = createIntegrationService({
    repository: wrap(repository), db, manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, exchange: async () => ({}),
    now: () => clock.now, log: (line) => logs.push(line), notify: (stationId) => notified.push(stationId), authChanged: () => { asked += 1; }, delegatedHostWork
  });
  if (seeded) await service.syncBuiltIn();
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
  // Every account-level event of a Station, the baseline too, oldest first.
  const levelEvents = async (stationId) => (await db.pool.query("SELECT id, kind, state, actor, reason, account_id, details FROM integration_events WHERE station_id = $1 AND integration_id IS NULL AND kind IN ('account_disabled', 'account_enabled', 'accounts_baseline') ORDER BY id", [stationId])).rows;
  // What the account-level entries wrote: the applied entries, availability rows and baseline mark, and the number of
  // account-level events on all Stations.
  const written = async () => {
    const count = async (sql) => (await db.pool.query(sql)).rows[0].n;
    return {
      entries: await count("SELECT count(*)::int AS n FROM auth_account_entries"), availability: await count("SELECT count(*)::int AS n FROM account_availability"),
      baseline: await count("SELECT count(*)::int AS n FROM account_baseline"),
      events: await count("SELECT count(*)::int AS n FROM integration_events WHERE integration_id IS NULL AND kind IN ('account_disabled', 'account_enabled', 'accounts_baseline')")
    };
  };
  // The baseline row: what Auth's baseline entry recorded, and whether the Portal has caught up since, or null.
  const baselineRow = async () => {
    const { rows } = await db.pool.query("SELECT auth_cursor, auth_at, complete FROM account_baseline");
    return rows[0] ? { cursor: rows[0].auth_cursor, at: rows[0].auth_at.toISOString(), complete: rows[0].complete } : null;
  };
  // A service over the same database, Auth and clock with the setting off (a Portal run without it, or an older one).
  const offService = (offLogs = []) => createIntegrationService({
    repository, db, manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, exchange: async () => ({}),
    now: () => clock.now, log: (line) => offLogs.push(line), notify: (stationId) => notified.push(stationId), authChanged: () => {}
  });
  // Reads Auth's feed with the real reader, as the stack wires it (the hooks are the service's), from the saved cursor
  // until it has caught up. `seenComplete` collects the mark after each change applied.
  const readAll = async ({ pageSize = 100, pagesPerPull = 10, seenComplete } = {}) => {
    const reader = createAuthChanges({
      repository, manage, log: (line) => logs.push(line), settings: { pollMs: 3600000, minGapMs: 5, pageSize, pagesPerPull },
      apply: async (change) => {
        const result = await service.applyAuthChange(change);
        if (seenComplete) seenComplete.push(await repository.baselineApplied());
        return result;
      },
      startingOver: () => service.accountsStartingOver(), caughtUp: () => service.accountsCaughtUp()
    });
    reader.start();
    await reader.idle();
    await reader.stop();
  };
  return { db, repository, manage, clock, service, built, create, ready, follow, events, accountEvents, levelEvents, written, baselineRow, offService, readAll, stationFeed, notified, logs, authAsked: () => asked };
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
  // Those skipped account-level entries left the accounts waiting for a replay; the reader's start-over (a reset) ends that.
  await s.service.accountsStartingOver();
  assert.equal(await s.service.applyAuthChange({ ...account, admin: false, actorAccountId: null }), "applied", "Auth's own, with no actor");
  assert.deepEqual((await s.accountEvents(s.built.id)).map((event) => [event.actor, event.details.admin]), [["system", false]]);
});

test("with the setting on, an accounts baseline is accepted only naming no integration and no account", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await s.ready();
  s.manage.baselineChange();
  const [baseline] = s.manage.feed;
  const bad = [
    { ...baseline, clientId: id }, { ...baseline, clientId: undefined }, { ...baseline, clientId: "" }, { ...baseline, owner: OWNER }, { ...baseline, owner: undefined },
    { ...baseline, cursor: undefined }, { ...baseline, at: "not a time" }, { ...baseline, kind: "account_baseline" }
  ];
  const before = await s.written();
  for (const entry of bad) assert.equal(await s.service.applyAuthChange(entry), "skipped", JSON.stringify(entry));
  assert.deepEqual(await s.written(), before);
  assert.equal(await s.baselineRow(), null);
  await s.service.accountsStartingOver(); // the skipped entries above left the accounts waiting for a replay
  assert.equal(await s.service.applyAuthChange(baseline), "applied");
  assert.deepEqual(await s.baselineRow(), { cursor: baseline.cursor, at: baseline.at, complete: false }, "recorded, and complete only once the Portal has caught up");
  assert.equal(await s.repository.baselineApplied(), false);
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

// An account-level entry of Auth's feed is one transaction (D29): its applied mark, the account's availability and one
// event on each active built-in Station are written together, and each Station is pushed once that has committed.
test("with the setting on, an account entry updates availability and appends one event to each built-in Station in one transaction, pushing each; read again, or from the start, it writes nothing more", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const second = s.manage.seedBuiltIn({ id: "stbuiltin2", origin: "https://station2.agora.test", name: "Second", integrations: true, admins: [ADMIN], reportClientId: "s-" + "0".repeat(24) + "b2" });
  assert.equal(await s.service.syncBuiltIn(), true);
  const custom = await s.manage.registerStation({ origin: "https://custom.example", owner: OWNER, reportKey: publicJwk(), actor: OWNER });
  await s.service.stations(OWNER);
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(THIRD, false, { actor: ADMIN, reason: "Cleared" });
  const [entry] = s.manage.feed;

  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange(entry), "applied");
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER]);
  const { rows: [row] } = await s.db.pool.query("SELECT account_id, disabled, auth_cursor, auth_at FROM account_availability");
  assert.deepEqual([row.account_id, row.disabled, row.auth_cursor, row.auth_at.toISOString()], [OWNER, true, entry.cursor, entry.at]);
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort(), "each built-in Station is pushed, the custom Station not");
  for (const station of [s.built, second]) {
    const [event, ...more] = await s.accountEvents(station.id);
    assert.equal(more.length, 0, station.id);
    assert.deepEqual([event.kind, event.state, event.actor, event.reason, event.account_id, event.details], ["account_disabled", null, ADMIN, "Abuse", OWNER, { authCursor: entry.cursor, authAt: entry.at, admin: true }], station.id);
  }
  assert.deepEqual(await s.levelEvents(custom.id), []);
  // One transaction: the applied mark, the availability row and both Stations' events were written by the same one.
  const { rows: writers } = await s.db.pool.query(
    "SELECT xmin::text AS writer FROM auth_account_entries UNION ALL SELECT xmin::text FROM account_availability UNION ALL SELECT xmin::text FROM integration_events WHERE kind = 'account_disabled'");
  assert.equal(writers.length, 4);
  assert.equal(new Set(writers.map((writer) => writer.writer)).size, 1, "one transaction");

  // Read again, it writes and pushes nothing more.
  const after = await s.written();
  assert.deepEqual(after, { entries: 1, availability: 1, baseline: 0, events: 2 });
  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange(entry), "skipped");
  assert.equal(await s.service.applyAuthChange({ ...entry }), "skipped");
  assert.deepEqual(await s.written(), after);
  assert.deepEqual(s.notified, []);
  // The next entry is applied; then the Portal's cursor is reset and Auth's whole feed is read again: nothing changes.
  assert.deepEqual(await s.follow(), ["skipped", "applied"]);
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER], "an enable of an account that was never disabled lists nothing");
  const settled = await s.written();
  assert.deepEqual(settled, { entries: 2, availability: 2, baseline: 0, events: 4 });
  s.notified.length = 0;
  const { changes } = await s.manage.integrationChanges();
  for (const change of changes) assert.equal(await s.service.applyAuthChange(change), "skipped");
  assert.deepEqual(await s.written(), settled);
  assert.deepEqual(s.notified, []);
});

test("with the setting on, an accounts baseline is recorded when applied, and once the Portal has caught up it is complete and reaches each built-in Station as one accounts_baseline change, never a custom Station", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const second = s.manage.seedBuiltIn({ id: "stbuiltin2", origin: "https://station2.agora.test", name: "Second", integrations: true, admins: [ADMIN], reportClientId: "s-" + "0".repeat(24) + "b2" });
  assert.equal(await s.service.syncBuiltIn(), true);
  const custom = await s.manage.registerStation({ origin: "https://custom.example", owner: OWNER, reportKey: publicJwk(), actor: OWNER });
  await s.service.stations(OWNER);
  const customStation = await s.repository.station(custom.id);
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const [account, baseline] = s.manage.feed;
  assert.deepEqual(baseline, { cursor: baseline.cursor, at: baseline.at, kind: "accounts_baseline", clientId: null, stationId: null, owner: null, status: null, pausedBy: null, actorAccountId: null, reason: null, admin: false });

  assert.equal(await s.baselineRow(), null);
  assert.equal(await s.service.applyAuthChange(account), "applied");
  assert.equal(await s.baselineRow(), null, "an account entry is not the baseline");
  const cursors = {};
  for (const station of [s.built, second]) cursors[station.id] = (await s.service.changes(station.reportClientId, "0")).cursor;
  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange(baseline), "applied");
  assert.deepEqual(await s.baselineRow(), { cursor: baseline.cursor, at: baseline.at, complete: false }, "recorded, not yet complete");
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(await s.written(), { entries: 2, availability: 1, baseline: 1, events: 2 }, "the baseline entry itself writes no event");
  assert.deepEqual(s.notified, [], "and pushes no Station");

  // The Portal has caught up with the feed: the view is complete, and each built-in Station is told once.
  assert.equal(await s.service.accountsCaughtUp(), true);
  assert.deepEqual(await s.baselineRow(), { cursor: baseline.cursor, at: baseline.at, complete: true });
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort(), "each built-in Station is pushed");
  for (const station of [s.built, second]) {
    const feed = await s.service.changes(station.reportClientId, String(cursors[station.id]));
    assert.equal(feed.changes.length, 1, station.id);
    const [change] = feed.changes;
    assert.deepEqual(change, { id: feed.cursor, at: change.at, integrationId: null, kind: "accounts_baseline", state: null, reason: "agora_build", account: null }, station.id);
    assert.deepEqual(Object.keys(change).sort(), ["account", "at", "id", "integrationId", "kind", "reason", "state"]);
    const event = (await s.levelEvents(station.id)).at(-1);
    assert.deepEqual([event.kind, event.state, event.actor, event.reason, event.account_id, event.details], ["accounts_baseline", null, "system", null, null, { authCursor: baseline.cursor, authAt: baseline.at, admin: false }], station.id);
    // A cursor-0 read lists the disabled accounts and carries the baseline after the account's own change.
    const whole = await s.service.changes(station.reportClientId, "0");
    assert.deepEqual(whole.changes.filter((entry) => entry.kind.startsWith("account")).map((entry) => [entry.kind, entry.account]), [["account_disabled", OWNER], ["accounts_baseline", null]], station.id);
    assert.deepEqual(whole.disabledAccounts, [OWNER], station.id);
  }
  assert.deepEqual(await s.levelEvents(custom.id), [], "a custom Station never gets an account-level change");
  const customFeed = await s.service.changes(customStation.reportClientId, "0");
  assert.equal(customFeed.changes.some((entry) => entry.kind.startsWith("account")), false);

  // Caught up again, nothing more is written or pushed.
  const after = await s.written();
  assert.deepEqual(after, { entries: 2, availability: 1, baseline: 1, events: 4 });
  s.notified.length = 0;
  assert.equal(await s.service.accountsCaughtUp(), false);
  assert.equal(await s.service.applyAuthChange(baseline), "skipped");
  assert.deepEqual(await s.written(), after);
  assert.deepEqual(s.notified, []);
  // A later baseline (Auth turned its setting on again) updates the record and leaves the view complete: the Stations
  // already have it, and hear nothing more.
  s.clock.now += 1000;
  s.manage.baselineChange();
  const later = s.manage.feed.at(-1);
  assert.equal(await s.service.applyAuthChange(later), "applied");
  assert.deepEqual(await s.baselineRow(), { cursor: later.cursor, at: later.at, complete: true });
  assert.equal(await s.service.accountsCaughtUp(), false);
  assert.deepEqual((await s.levelEvents(s.built.id)).map((event) => event.kind), ["account_disabled", "accounts_baseline"]);
  assert.deepEqual(s.notified, []);
});

// Several Portal replicas read Auth's feed: each takes the event lock first, so one entry (or one flip to complete) is
// applied by the first and found done by the others.
test("with the setting on, the same account entry applied by two readers at once is applied once, with one event per built-in Station; so is the flip to complete", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const second = s.manage.seedBuiltIn({ id: "stbuiltin2", origin: "https://station2.agora.test", name: "Second", integrations: true, admins: [ADMIN], reportClientId: "s-" + "0".repeat(24) + "b2" });
  assert.equal(await s.service.syncBuiltIn(), true);
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const [entry, baseline] = s.manage.feed;
  s.notified.length = 0;
  assert.deepEqual((await Promise.all([s.service.applyAuthChange(entry), s.service.applyAuthChange({ ...entry })])).sort(), ["applied", "skipped"]);
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort(), "each Station is pushed once");
  for (const station of [s.built, second]) assert.equal((await s.accountEvents(station.id)).length, 1, station.id);
  assert.deepEqual(await s.written(), { entries: 1, availability: 1, baseline: 0, events: 2 });
  assert.deepEqual((await Promise.all([s.service.applyAuthChange(baseline), s.service.applyAuthChange({ ...baseline })])).sort(), ["applied", "skipped"]);
  s.notified.length = 0;
  assert.deepEqual((await Promise.all([s.service.accountsCaughtUp(), s.service.accountsCaughtUp(), s.service.accountsCaughtUp()])).sort(), [false, false, true], "only the first flips it");
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort());
  for (const station of [s.built, second]) assert.deepEqual((await s.levelEvents(station.id)).map((event) => event.kind), ["account_disabled", "accounts_baseline"], station.id);
});

test("with the setting on and no built-in Station, availability and the baseline are still recorded and complete once caught up, and a built-in Station created afterwards starts with every disabled account", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, seeded: false });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(OTHER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(OTHER, false, { actor: ADMIN, reason: "Appeal" });
  s.manage.baselineChange();
  assert.deepEqual(await s.follow(), ["applied", "applied", "applied", "applied", "applied"]);
  assert.ok(s.logs.includes("Auth account change skipped: no built-in Station."));
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD]);
  assert.equal((await s.baselineRow()).complete, false);
  assert.equal(await s.service.accountsCaughtUp(), true);
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.written(), { entries: 5, availability: 3, baseline: 1, events: 0 });
  assert.deepEqual(s.notified, []);
  assert.deepEqual(await s.follow(), [], "nothing new to read");

  const built = s.manage.seedBuiltIn({ integrations: true, admins: [ADMIN] });
  assert.equal(await s.service.syncBuiltIn(), true);
  const feed = await s.service.changes(built.reportClientId, "0");
  assert.deepEqual(feed.disabledAccounts, [OWNER, THIRD], "the table, not the Station's events, has them");
  assert.deepEqual(feed.changes.filter((change) => change.kind.startsWith("account")), []);
});

test("with the setting on, account entries apply in Auth's feed order whatever Auth's clocks say: disabled then enabled ends enabled, read once or again from the start", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.clock.now += 1000;
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  assert.deepEqual(await s.follow(), ["applied", "applied"]);
  assert.deepEqual(await s.repository.disabledAccountList(), []);
  assert.deepEqual((await s.stationFeed()).disabledAccounts, []);
  assert.deepEqual((await s.accountEvents(s.built.id)).map((event) => event.kind), ["account_disabled", "account_enabled"]);
  const settled = await s.written();
  const { changes } = await s.manage.integrationChanges();
  for (const change of changes) assert.equal(await s.service.applyAuthChange(change), "skipped");
  assert.deepEqual(await s.repository.disabledAccountList(), [], "re-reading from the start ends the same");
  assert.deepEqual(await s.written(), settled);

  // Two Auth nodes whose clocks disagree: the disable is stamped later than the enable that follows it in the feed. The
  // feed's order says, not the time: the account ends enabled, and the disable never wins for being stamped later.
  s.clock.now += 20000;
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  s.clock.now -= 10000;
  s.manage.accountChange(THIRD, false, { actor: ADMIN, reason: "Appeal" });
  const [disabled, enabled] = s.manage.feed.slice(-2);
  assert.ok(Date.parse(enabled.at) < Date.parse(disabled.at));
  assert.deepEqual(await s.follow(), ["applied", "applied"]);
  assert.deepEqual(await s.repository.disabledAccountList(), []);
  assert.deepEqual((await s.levelEvents(s.built.id)).filter((event) => event.account_id === THIRD).map((event) => event.kind), ["account_disabled", "account_enabled"]);
  // And the other way round: the enable stamped earlier is followed by a disable stamped earlier still.
  s.clock.now -= 5000;
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse again" });
  assert.deepEqual(await s.follow(), ["applied"]);
  assert.deepEqual(await s.repository.disabledAccountList(), [THIRD], "the later entry in the feed says");
});

test("with the setting on, entries skipped while the setting was off are read again in Auth's order after a reset, and the accounts are complete again, each built-in Station hearing one new accounts_baseline", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const second = s.manage.seedBuiltIn({ id: "stbuiltin2", origin: "https://station2.agora.test", name: "Second", integrations: true, admins: [ADMIN], reportClientId: "s-" + "0".repeat(24) + "b2" });
  assert.equal(await s.service.syncBuiltIn(), true);
  const off = s.offService();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll();
  assert.equal(await s.repository.baselineApplied(), true, "caught up with a baseline: complete");
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD]);
  for (const station of [s.built, second]) assert.deepEqual((await s.levelEvents(station.id)).map((event) => event.kind), ["account_disabled", "account_disabled", "accounts_baseline"], station.id);

  // The setting is off for a while, and Auth enables OWNER: this Portal skips the entry, so it no longer knows the accounts.
  s.clock.now += 1000;
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  assert.equal(await off.applyAuthChange(s.manage.feed.at(-1)), "skipped");
  assert.equal(await s.repository.baselineApplied(), false, "unknown again");
  assert.equal(await s.baselineRow(), null);
  assert.equal((await s.written()).entries, 0, "and what it had applied is forgotten");
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD], "availability is stale until the feed is read again");
  // With the setting on again, Auth writes its corrections and a new baseline. The Portal's cursor is reset once.
  s.clock.now += 1000;
  s.manage.baselineChange();
  const before = {};
  for (const station of [s.built, second]) before[station.id] = (await s.service.changes(station.reportClientId, "0")).cursor;
  await s.repository.saveAuthChangeCursor(null);
  s.notified.length = 0;
  await s.readAll();
  assert.equal(await s.repository.baselineApplied(), true, "complete again");
  assert.deepEqual(await s.repository.disabledAccountList(), [THIRD], "every entry applied again in Auth's order: OWNER ends enabled");
  assert.deepEqual([...new Set(s.notified)].sort(), [s.built.id, second.id].sort());
  for (const station of [s.built, second]) {
    const { changes } = await s.service.changes(station.reportClientId, String(before[station.id]));
    assert.deepEqual(changes.map((change) => [change.kind, change.account]), [["account_disabled", OWNER], ["account_disabled", THIRD], ["account_enabled", OWNER], ["accounts_baseline", null]], station.id);
  }
  assert.deepEqual((await s.baselineRow()).complete, true);

  // Entries skipped while off and then all read again, older and newer, end as Auth's feed says.
  s.clock.now += 1000;
  s.manage.accountChange(OTHER, true, { actor: ADMIN, reason: "Abuse" });
  s.clock.now += 1000;
  s.manage.accountChange(OTHER, false, { actor: ADMIN, reason: "Appeal" });
  for (const entry of s.manage.feed.slice(-2)) assert.equal(await off.applyAuthChange(entry), "skipped");
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  assert.deepEqual(await s.repository.disabledAccountList(), [THIRD], "OTHER was disabled, then enabled");
  assert.equal(await s.repository.baselineApplied(), true);
});

test("with the setting on, starting over makes the accounts unknown until the Portal has caught up: a first start or a reset clears complete, a replay stays incomplete, and the end of the feed completes it", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  const baselines = async () => (await s.levelEvents(s.built.id)).filter((event) => event.kind === "accounts_baseline").length;

  // A first start, two changes a page and one page a read: the mark is false after every change, and true once the feed
  // has been read to its end.
  const first = [];
  await s.readAll({ pageSize: 2, pagesPerPull: 1, seenComplete: first });
  assert.deepEqual(first, [false, false, false, false]);
  assert.equal(await s.repository.baselineApplied(), true);
  assert.equal(await baselines(), 1);

  // A reset: Auth's cursor is forgotten and the feed read again. Every entry is applied already, so each is skipped and
  // the baseline entry is not applied again; the mark is false while the replay lasts, and true at its end, when the
  // Stations hear the baseline once more.
  await s.repository.saveAuthChangeCursor(null);
  const replay = [];
  await s.readAll({ pageSize: 2, pagesPerPull: 1, seenComplete: replay });
  assert.deepEqual(replay, [false, false, false, false], "unknown while it replays");
  assert.equal(await s.repository.baselineApplied(), true);
  assert.equal(await baselines(), 2);
  assert.deepEqual(await s.repository.disabledAccountList(), [THIRD]);

  // By hand, as the reader calls the service: start over, apply only the first page, then the rest.
  const { changes } = await s.manage.integrationChanges();
  await s.service.accountsStartingOver();
  assert.equal(await s.repository.baselineApplied(), false);
  for (const change of changes.slice(0, 2)) await s.service.applyAuthChange(change);
  assert.equal(await s.repository.baselineApplied(), false, "mid-replay: the first page applied");
  assert.equal((await s.baselineRow()).complete, false, "the baseline is still recorded");
  for (const change of changes.slice(2)) await s.service.applyAuthChange(change);
  assert.equal(await s.repository.baselineApplied(), false, "every entry applied, but not yet caught up");
  assert.equal(await s.service.accountsCaughtUp(), true);
  assert.equal(await s.repository.baselineApplied(), true);
  assert.equal(await baselines(), 3);
});

test("with the setting on, caught up with no baseline recorded stays unknown: no complete mark and no accounts_baseline change", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  await s.readAll();
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD]);
  assert.equal(await s.baselineRow(), null);
  assert.equal(await s.repository.baselineApplied(), false);
  assert.equal(await s.service.accountsCaughtUp(), false);
  assert.deepEqual((await s.levelEvents(s.built.id)).map((event) => event.kind), ["account_disabled", "account_disabled"]);
  assert.equal(await s.service.accountsStartingOver(), undefined, "and starting over with nothing recorded is fine");
});

test("with the setting on, an account-level entry that is skipped (malformed, or a person's own) clears the mark and forgets the applied entries; other entries do not", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [account, baseline, paused] = s.manage.feed;
  const complete = async () => {
    await s.service.applyAuthChange(account);
    await s.service.applyAuthChange(baseline);
    await s.service.accountsCaughtUp();
    assert.equal(await s.repository.baselineApplied(), true);
    assert.equal((await s.written()).entries, 2);
  };
  await complete();
  // An entry of another kind that is skipped leaves the mark and the entries alone.
  assert.equal(await s.service.applyAuthChange({ ...paused, clientId: null }), "skipped");
  assert.equal(await s.service.applyAuthChange(paused), "applied");
  assert.equal(await s.repository.baselineApplied(), true);
  assert.equal((await s.written()).entries, 2);
  const skippedAccountLevel = [{ ...account, owner: null }, { ...account, clientId: id }, { ...baseline, owner: OWNER }, { ...account, admin: false, actorAccountId: OTHER }];
  for (const skipped of skippedAccountLevel) {
    assert.equal(await s.service.applyAuthChange(skipped), "skipped", JSON.stringify(skipped));
    assert.equal(await s.repository.baselineApplied(), false, "unknown: " + JSON.stringify(skipped));
    const written = await s.written();
    assert.deepEqual([written.entries, written.baseline, written.availability], [0, 0, 1], "forgotten, availability as it was: " + JSON.stringify(skipped));
    assert.deepEqual(await s.repository.disabledAccountList(), [OWNER]);
    assert.equal(await s.repository.accountsNeedReplay(), true, "and waiting for the feed to be read again from the start");
    // Read again from the start (the reader's start-over), the entries apply again, and the Portal completes once it has caught up.
    await s.service.accountsStartingOver();
    assert.equal(await s.repository.accountsNeedReplay(), false);
    await complete();
  }
});

const WAITING = "Account availability waits for Auth's change feed to be read again from the start (empty the Portal's Auth cursor).";

// Applied account entries are always a prefix of Auth's feed: once the Portal has skipped one, a later account-level entry
// is skipped too (not recorded) until the feed is read again from the start, so a replay never meets an entry that was
// applied out of order.
test("with the setting on, once an account entry was skipped, later account-level entries are skipped and not recorded until a reset; integration entries still apply; the reset replays everything in order", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const off = s.offService();
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.clock.now += 1000;
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const [disabled, enabled, paused, third, baseline] = s.manage.feed;
  const waiting = () => s.logs.filter((line) => line === WAITING).length;

  // The first entry is skipped while the setting is off; the setting is then on again, with no reset.
  assert.equal(await s.repository.accountsNeedReplay(), false);
  assert.equal(await off.applyAuthChange(disabled), "skipped");
  assert.equal(await s.repository.accountsNeedReplay(), true);
  assert.equal(await s.service.applyAuthChange(enabled), "skipped", "the next one is skipped too, though it could be applied");
  assert.deepEqual(await s.written(), { entries: 0, availability: 0, baseline: 0, events: 0 }, "and not recorded");
  assert.equal(waiting(), 1);
  assert.equal(await s.service.applyAuthChange(paused), "applied", "integration entries apply as usual");
  assert.equal((await s.repository.integration(id)).state, "paused");
  assert.equal(await s.service.applyAuthChange(third), "skipped");
  assert.equal(await s.service.applyAuthChange(baseline), "skipped", "a baseline too");
  assert.equal(waiting(), 1, "the line is logged once while the reader's pass lasts");
  assert.equal(await s.baselineRow(), null);
  assert.equal(await s.service.accountsCaughtUp(), false, "and the end of a pass completes nothing");
  assert.equal(await s.repository.baselineApplied(), false);
  assert.equal(await s.service.applyAuthChange(third), "skipped");
  assert.equal(waiting(), 2, "the next pass says it again");
  assert.deepEqual(await s.written(), { entries: 0, availability: 0, baseline: 0, events: 0 });
  assert.deepEqual(s.notified.filter((stationId) => stationId !== s.built.id), []);

  // A reset: the feed is read again from the start, and every account entry is applied in Auth's order.
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  assert.equal(await s.repository.accountsNeedReplay(), false);
  assert.deepEqual(await s.repository.disabledAccountList(), [THIRD], "OWNER was disabled, then enabled");
  assert.deepEqual((await s.levelEvents(s.built.id)).map((event) => [event.kind, event.account_id]), [["account_disabled", OWNER], ["account_enabled", OWNER], ["account_disabled", THIRD], ["accounts_baseline", null]]);
  assert.equal(await s.repository.baselineApplied(), true);
});

test("with the setting on, a baseline that arrives live after a skipped disable completes nothing until a reset, and then the disable is in place", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const off = s.offService();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const [disabled, baseline] = s.manage.feed;
  assert.equal(await off.applyAuthChange(disabled), "skipped");
  assert.equal(await s.service.applyAuthChange(baseline), "skipped");
  assert.equal(await s.baselineRow(), null, "not recorded");
  // The reader has read to the end of the feed, from a cursor it kept: caught up, but the accounts are still unknown.
  await s.repository.saveAuthChangeCursor(baseline.cursor);
  await s.readAll();
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(await s.repository.disabledAccountList(), [], "the skipped disable is not applied, so OWNER is not listed: the answer is 'not complete'");
  assert.deepEqual((await s.levelEvents(s.built.id)).map((event) => event.kind), []);
  // After a reset the feed is replayed: complete, with OWNER disabled.
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER]);
  assert.deepEqual((await s.levelEvents(s.built.id)).map((event) => event.kind), ["account_disabled", "accounts_baseline"]);
});

test("with the setting on, caught up does nothing while the accounts wait for a replay, even with a baseline recorded, and starting over ends the wait and makes the baseline incomplete", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const [account, baseline] = s.manage.feed;
  await s.service.applyAuthChange(account);
  await s.service.applyAuthChange(baseline);
  await s.repository.setAccountsNeedReplay();
  s.notified.length = 0;
  assert.equal(await s.service.accountsCaughtUp(), false);
  assert.deepEqual(await s.baselineRow(), { cursor: baseline.cursor, at: baseline.at, complete: false });
  assert.deepEqual((await s.levelEvents(s.built.id)).map((event) => event.kind), ["account_disabled"]);
  assert.deepEqual(s.notified, []);
  await s.repository.clearAccountsNeedReplay();
  assert.equal(await s.service.accountsCaughtUp(), true);
  // Starting over: the wait is over and the accounts are unknown until the next caught up.
  await s.repository.setAccountsNeedReplay();
  await s.service.accountsStartingOver();
  assert.equal(await s.repository.accountsNeedReplay(), false);
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(await s.baselineRow(), { cursor: baseline.cursor, at: baseline.at, complete: false });
});

test("with the setting off, an account entry or a baseline clears the accounts baseline mark and forgets the applied entries, and is skipped; integration entries apply as before; the hooks do nothing", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const offLogs = [];
  const off = s.offService(offLogs);
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  s.manage.baselineChange();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  s.manage.baselineChange();
  s.manage.baselineChange();
  const [disabled, baselineOne, enabled, baselineTwo, paused, baselineThree, baselineFour] = s.manage.feed;
  const complete = async (...entries) => {
    for (const entry of entries) assert.equal(await s.service.applyAuthChange(entry), "applied");
    assert.equal(await s.service.accountsCaughtUp(), true);
  };
  await complete(disabled, baselineOne);
  assert.equal(await s.repository.baselineApplied(), true);
  const before = await s.written();
  assert.deepEqual(before, { entries: 2, availability: 1, baseline: 1, events: 2 });

  // An account entry the Portal skips clears the mark and forgets the entries, waits for a replay, and writes nothing else.
  s.notified.length = 0;
  assert.equal(await off.applyAuthChange(enabled), "skipped");
  assert.equal(await s.repository.baselineApplied(), false, "unknown again");
  assert.equal(await s.repository.accountsNeedReplay(), true);
  assert.deepEqual(await s.written(), { entries: 0, availability: 1, baseline: 0, events: 2 });
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER], "availability is left as it was");
  assert.deepEqual(s.notified, []);
  // A baseline entry the Portal skips does the same. (Each replay starts with the reader's start-over, which ends the wait.)
  await s.service.accountsStartingOver();
  await complete(baselineTwo);
  assert.deepEqual(await s.written(), { entries: 1, availability: 1, baseline: 1, events: 3 });
  assert.equal(await off.applyAuthChange(baselineThree), "skipped");
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(await s.written(), { entries: 0, availability: 1, baseline: 0, events: 3 });
  // An integration's entry is followed as today and leaves the mark and the entries alone.
  await s.service.accountsStartingOver();
  await complete(baselineFour);
  assert.equal(await off.applyAuthChange(paused), "applied");
  assert.equal((await s.repository.integration(id)).state, "paused");
  assert.equal(await s.repository.baselineApplied(), true, "an integration's entry does not clear it");
  assert.equal((await s.written()).entries, 1);
  // The hooks of a Portal with the setting off do nothing.
  assert.equal(await off.accountsCaughtUp(), false);
  assert.equal(await off.accountsStartingOver(), undefined);
  assert.equal(await s.repository.baselineApplied(), true, "starting over, with the setting off, leaves the mark");
  await s.repository.setAccountsNeedReplay();
  await off.accountsStartingOver();
  assert.equal(await s.repository.accountsNeedReplay(), true, "and the wait: only a Portal with the setting on replays");
  await s.repository.clearAccountsNeedReplay();
  // Clearing a mark that isn't there is fine, and so is an account entry of the wrong shape: it is an account entry all the same.
  assert.equal(await off.applyAuthChange({ kind: "account_enabled" }), "skipped");
  assert.equal(await s.repository.baselineApplied(), false);
  assert.equal(await off.applyAuthChange(enabled), "skipped");
  assert.equal(await off.applyAuthChange(null), "skipped");
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(offLogs, Array(5).fill("Auth change skipped: not a change entry."), "nothing new is logged");
});

// The account entry is one transaction for all active built-in Stations: a failure while appending to the second one
// rolls back the applied mark, the availability and the first Station's event, pushes nothing, and the reader's next
// read applies the entry once. The same holds for the flip to complete and the baseline change it appends. (This
// replaces Phase B's per-Station writes, where the first Station kept its event and its push.)
test("with the setting on, a failure while appending to the second built-in Station rolls everything back: no tables, no push, and the retry applies once", async (t) => {
  const control = { failStation: null, failKind: null, appended: [] };
  const s = await setup(t, {
    delegatedHostWork: true,
    wrap: (repository) => ({
      ...repository,
      appendEvent: async (event, client) => {
        if (event.stationId === control.failStation && event.kind === control.failKind) throw new Error("write failed");
        const appended = await repository.appendEvent(event, client);
        control.appended.push(event.stationId + " " + event.kind);
        return appended;
      }
    })
  });
  if (!s) return;
  const second = s.manage.seedBuiltIn({ id: "stbuiltin2", origin: "https://station2.agora.test", name: "Second", integrations: true, admins: [ADMIN], reportClientId: "s-" + "0".repeat(24) + "b2" });
  assert.equal(await s.service.syncBuiltIn(), true);
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const [entry, baseline] = s.manage.feed;
  const nothing = await s.written();
  assert.deepEqual(nothing, { entries: 0, availability: 0, baseline: 0, events: 0 });

  // An account entry.
  Object.assign(control, { failStation: second.id, failKind: "account_disabled", appended: [] });
  s.notified.length = 0;
  await assert.rejects(s.service.applyAuthChange(entry), /write failed/);
  assert.deepEqual(control.appended, [s.built.id + " account_disabled"], "the first Station's event was written, in the transaction that was rolled back");
  assert.deepEqual(await s.written(), nothing, "no partial tables");
  assert.deepEqual(await s.repository.disabledAccountList(), []);
  assert.deepEqual(s.notified, [], "no push");
  Object.assign(control, { failStation: null, appended: [] });
  assert.equal(await s.service.applyAuthChange(entry), "applied", "read again, it applies");
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort());
  assert.deepEqual(await s.written(), { entries: 1, availability: 1, baseline: 0, events: 2 });
  assert.deepEqual([(await s.accountEvents(s.built.id)).length, (await s.accountEvents(second.id)).length], [1, 1]);
  assert.equal(await s.service.applyAuthChange(entry), "skipped", "once");

  // The flip to complete: the baseline is recorded, and then the change to each Station.
  assert.equal(await s.service.applyAuthChange(baseline), "applied");
  const settled = await s.written();
  Object.assign(control, { failStation: second.id, failKind: "accounts_baseline", appended: [] });
  s.notified.length = 0;
  await assert.rejects(s.service.accountsCaughtUp(), /write failed/);
  assert.deepEqual(control.appended, [s.built.id + " accounts_baseline"]);
  assert.deepEqual(await s.written(), settled, "the first Station's event is not kept");
  assert.deepEqual(await s.baselineRow(), { cursor: baseline.cursor, at: baseline.at, complete: false }, "and the view is still not complete");
  assert.deepEqual(s.notified, []);
  Object.assign(control, { failStation: null });
  assert.equal(await s.service.accountsCaughtUp(), true, "the next read completes it");
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.written(), { entries: 2, availability: 1, baseline: 1, events: 4 });
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort());
  assert.equal(await s.service.accountsCaughtUp(), false);
});

function stateOf(answer, id) {
  return answer.integrations.find((entry) => entry.id === id).state;
}
