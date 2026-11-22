// Auth's change feed applied by the service (applyAuthChange, spec §3.3.4 "Owner decisions after the Auth review"),
// against the test database and the in-memory Auth, whose adminChange, systemRevoke and setOwnerDisabled stand in for
// the admin site's calls and Auth's own changes (Auth D26 Tasks 13 and 14).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
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
// The account-level changes of a built-in Station's feed (D29).
const ACCOUNT_LEVEL = ["account_disabled", "account_enabled", "accounts_baseline", "accounts_incomplete"];

// `delegatedHostWork` turns the setting on in the service (D29), and Auth's side with it unless `authDelegated` says
// otherwise (the fake then writes the account entries a delegated Auth does). `wrap` wraps the repository the service
// uses; the one the tests read is the plain one. `seeded: false` leaves Auth without a built-in Station (`built` is null).
// A Portal with the setting on starts out rebuilding its view of the accounts, and goes live once a read of Auth's whole
// feed has caught up. Unless `fresh`, setup does that over the feed as it is (empty), for the tests that apply entries
// one at a time; a `fresh` Portal is left as a first start leaves it.
async function setup(t, { delegatedHostWork = false, authDelegated = delegatedHostWork, wrap = (repository) => repository, seeded = true, fresh = false } = {}) {
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
  // The read pass a reader hands the service with each change and at its end (D29): the epoch of Auth's feed now. A
  // Portal with the setting off needs none.
  const epochNow = async () => Number((await db.pool.query("SELECT accounts_epoch FROM auth_change_feed")).rows[0].accounts_epoch);
  const pass = async () => (delegatedHostWork ? { epoch: await epochNow() } : undefined);
  // One entry, or the end of a read, in the current pass.
  const apply = async (entry, on = service) => on.applyAuthChange(entry, await pass());
  const caughtUp = async (on = service) => on.accountsCaughtUp(await pass());
  // Applies every entry of Auth's feed after the last one applied, as the reader does; returns what each did.
  let seen;
  const follow = async () => {
    const { changes, nextCursor } = await manage.integrationChanges({ after: seen });
    seen = nextCursor ?? undefined;
    const results = [];
    for (const change of changes) results.push(await apply(change));
    return results;
  };
  const events = async (id) => (await db.pool.query("SELECT kind, state, actor, reason, details FROM integration_events WHERE integration_id = $1 ORDER BY id", [id])).rows;
  const stationFeed = () => service.changes(built.reportClientId, "0");
  // The account-level events of a Station (no integration), oldest first.
  const accountEvents = async (stationId) => (await db.pool.query("SELECT id, kind, state, actor, reason, account_id, details FROM integration_events WHERE station_id = $1 AND integration_id IS NULL AND kind IN ('account_disabled', 'account_enabled') ORDER BY id", [stationId])).rows;
  // Every account-level event of a Station, the baseline and the incomplete signal too, oldest first.
  const levelEvents = async (stationId) => (await db.pool.query("SELECT id, kind, state, actor, reason, account_id, details FROM integration_events WHERE station_id = $1 AND integration_id IS NULL AND kind IN ('account_disabled', 'account_enabled', 'accounts_baseline', 'accounts_incomplete') ORDER BY id", [stationId])).rows;
  // What a Station's feed says about the accounts after its cursor `after`: [kind, account] in order.
  const told = async (station, after = 0) => (await service.changes(station.reportClientId, String(after))).changes.filter((change) => ACCOUNT_LEVEL.includes(change.kind)).map((change) => [change.kind, change.account]);
  const cursorOf = async (station) => (await service.changes(station.reportClientId, "0")).cursor;
  // What the account-level entries wrote: the applied entries, availability rows and baseline mark, and the number of
  // account-level events on all Stations.
  const written = async () => {
    const count = async (sql) => (await db.pool.query(sql)).rows[0].n;
    return {
      entries: await count("SELECT count(*)::int AS n FROM auth_account_entries"), availability: await count("SELECT count(*)::int AS n FROM account_availability"),
      baseline: await count("SELECT count(*)::int AS n FROM account_baseline"),
      events: await count("SELECT count(*)::int AS n FROM integration_events WHERE integration_id IS NULL AND kind IN ('account_disabled', 'account_enabled', 'accounts_baseline', 'accounts_incomplete')")
    };
  };
  // What a rebuild has applied so far: its entries and availability rows.
  const rebuilt = async () => {
    const count = async (sql) => (await db.pool.query(sql)).rows[0].n;
    return { entries: await count("SELECT count(*)::int AS n FROM auth_account_entries_rebuild"), availability: await count("SELECT count(*)::int AS n FROM account_availability_rebuild") };
  };
  // The Portal's place in following Auth's accounts: its mode, epoch, the baseline its rebuild saw, and whether the
  // Stations are owed the news that the view is not complete.
  const sync = async () => {
    const { rows: [row] } = await db.pool.query("SELECT accounts_mode, accounts_epoch, rebuild_baseline_cursor, accounts_incomplete_owed FROM auth_change_feed");
    return { mode: row.accounts_mode, epoch: Number(row.accounts_epoch), rebuildBaseline: row.rebuild_baseline_cursor, owed: row.accounts_incomplete_owed };
  };
  // The mode and the complete mark, read together (one statement, so one snapshot).
  const view = async () => {
    const { rows: [row] } = await db.pool.query("SELECT accounts_mode AS mode, EXISTS (SELECT 1 FROM account_baseline WHERE complete) AS complete FROM auth_change_feed");
    return { mode: row.mode, complete: row.complete };
  };
  const savedCursor = async () => (await db.pool.query("SELECT cursor FROM auth_change_feed")).rows[0].cursor;
  // The baseline row: what Auth's baseline entry recorded, and whether the view is complete, or null.
  const baselineRow = async () => {
    const { rows } = await db.pool.query("SELECT auth_cursor, auth_at, complete FROM account_baseline");
    return rows[0] ? { cursor: rows[0].auth_cursor, at: rows[0].auth_at.toISOString(), complete: rows[0].complete } : null;
  };
  // A service over the same database, Auth and clock with the setting off (a Portal run without it, or an older one).
  const offService = (offLogs = []) => createIntegrationService({
    repository, db, manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, exchange: async () => ({}),
    now: () => clock.now, log: (line) => offLogs.push(line), notify: (stationId) => notified.push(stationId), authChanged: () => {}
  });
  // Another Portal replica over the same database, Auth and clock, with the setting as given (this one's by default): its
  // service, the Stations it pushed and its log.
  const replica = ({ on = delegatedHostWork } = {}) => {
    const own = { notified: [], logs: [] };
    own.service = createIntegrationService({
      repository, db, manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, exchange: async () => ({}),
      now: () => clock.now, log: (line) => own.logs.push(line), notify: (stationId) => own.notified.push(stationId), authChanged: () => {}, delegatedHostWork: on
    });
    return own;
  };
  // A gate a reader waits at: `reached` resolves when it gets there, open() lets it through, and fail(error) makes it
  // throw. Every gate is opened when the test ends, so a reader held at one can stop.
  const gates = [];
  const gate = () => {
    let open;
    let fail;
    let arrive;
    const passing = new Promise((resolve, reject) => { open = resolve; fail = reject; });
    const reached = new Promise((resolve) => { arrive = resolve; });
    const made = { reached, open, fail, wait: () => { arrive(); return passing; } };
    gates.push(made);
    return made;
  };
  // A reader of Auth's feed for a service (this one's by default), wired as the stack wires it, logging to `log`.
  // `hold(change)` may return a promise the reader waits for before it applies the change; `each(change, result)` runs
  // after it was applied.
  const reader = ({ service: on = service, log = logs, pageSize = 100, pagesPerPull = 10, hold, each } = {}) => {
    const feed = createAuthChanges({
      repository, manage, log: (line) => log.push(line), settings: { pollMs: 3600000, minGapMs: 5, pageSize, pagesPerPull },
      apply: async (change, readPass) => {
        await hold?.(change);
        const result = await on.applyAuthChange(change, readPass);
        await each?.(change, result);
        return result;
      },
      startingOver: () => on.accountsStartingOver(), caughtUp: (readPass) => on.accountsCaughtUp(readPass), foreignCursor: () => on.accountsForeignCursor()
    });
    t.after(() => {
      for (const held of gates) held.open();
      return feed.stop();
    });
    return feed;
  };
  // Reads Auth's feed with such a reader, from the saved cursor until it has caught up or a read stopped.
  const readAll = async (options = {}) => {
    const feed = reader(options);
    feed.start();
    await feed.idle();
    await feed.stop();
  };
  if (delegatedHostWork && !fresh) {
    await service.accountsStartingOver();
    await caughtUp();
  }
  return {
    db, repository, manage, clock, service, built, create, ready, follow, pass, apply, caughtUp, events, accountEvents, levelEvents, told, cursorOf,
    written, rebuilt, sync, view, savedCursor, baselineRow, offService, replica, gate, reader, readAll, stationFeed, notified, logs, authAsked: () => asked
  };
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
  assert.equal(await s.apply(account), "applied");
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
  assert.equal(await s.apply(entry), "applied");
  s.notified.length = 0;
  assert.equal(await s.apply(entry), "skipped");
  assert.equal(await s.apply({ ...entry }), "skipped");
  assert.equal((await s.accountEvents(s.built.id)).length, 1);
  assert.deepEqual(s.notified, []);
  // The same cursor at another time is another change (Auth's database was restored and handed it out again).
  assert.equal(await s.apply({ ...entry, at: new Date(Date.parse(entry.at) + 1000).toISOString() }), "applied");
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
  for (const entry of bad) assert.equal(await s.apply(entry), "skipped", JSON.stringify(entry));
  assert.ok(s.logs.includes("Auth change skipped: not a change entry."));
  assert.equal((await s.accountEvents(s.built.id)).length, 0);
  assert.equal((await s.events(id)).filter((event) => event.kind === "integration_paused").length, 0);
  // A person's own change is the Portal's own; Auth writes these two kinds for its admin or system only.
  assert.equal(await s.apply({ ...account, admin: false, actorAccountId: OTHER }), "skipped");
  assert.equal((await s.accountEvents(s.built.id)).length, 0);
  // Those skipped account-level entries left the Portal waiting; a reset (the reader starts over and reads to the end of the
  // feed, here with nothing on it) brings it live again.
  assert.equal((await s.sync()).mode, "waiting");
  await s.service.accountsStartingOver();
  await s.caughtUp();
  assert.equal(await s.apply({ ...account, admin: false, actorAccountId: null }), "applied", "Auth's own, with no actor");
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
  for (const entry of bad) assert.equal(await s.apply(entry), "skipped", JSON.stringify(entry));
  assert.deepEqual(await s.written(), before);
  assert.equal(await s.baselineRow(), null);
  // The skipped entries above left the Portal waiting; a reset brings it live again.
  assert.equal((await s.sync()).mode, "waiting");
  await s.service.accountsStartingOver();
  await s.caughtUp();
  assert.equal(await s.apply(baseline), "applied");
  assert.deepEqual(await s.baselineRow(), { cursor: baseline.cursor, at: baseline.at, complete: true }, "applied live, in order, it completes the view");
  assert.equal(await s.repository.baselineApplied(), true);
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
  for (const entry of s.manage.feed.slice(2, 4)) assert.equal(await s.apply(entry), "skipped");
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
  assert.equal(await s.apply(entry), "applied");
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
  assert.equal(await s.apply(entry), "skipped");
  assert.equal(await s.apply({ ...entry }), "skipped");
  assert.deepEqual(await s.written(), after);
  assert.deepEqual(s.notified, []);
  // The next entry is applied; then the Portal's cursor is reset and Auth's whole feed is read again: nothing changes.
  assert.deepEqual(await s.follow(), ["skipped", "applied"]);
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER], "an enable of an account that was never disabled lists nothing");
  const settled = await s.written();
  assert.deepEqual(settled, { entries: 2, availability: 2, baseline: 0, events: 4 });
  s.notified.length = 0;
  const { changes } = await s.manage.integrationChanges();
  for (const change of changes) assert.equal(await s.apply(change), "skipped");
  assert.deepEqual(await s.written(), settled);
  assert.deepEqual(s.notified, []);
});

// Live, every entry is applied in Auth's order as it comes, so a baseline applied while the view is not complete makes
// it complete from that point: the baseline is recorded and each active built-in Station gets one accounts_baseline
// change, in the same transaction.
test("with the setting on and live, a baseline applied while the view is not complete completes it and reaches each built-in Station as one accounts_baseline change, never a custom Station; a later baseline changes nothing for them", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const second = await secondBuiltIn(s);
  const custom = await s.manage.registerStation({ origin: "https://custom.example", owner: OWNER, reportKey: publicJwk(), actor: OWNER });
  await s.service.stations(OWNER);
  const customStation = await s.repository.station(custom.id);
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const [account, baseline] = s.manage.feed;
  assert.deepEqual(baseline, { cursor: baseline.cursor, at: baseline.at, kind: "accounts_baseline", clientId: null, stationId: null, owner: null, status: null, pausedBy: null, actorAccountId: null, reason: null, admin: false });

  assert.equal((await s.sync()).mode, "live");
  assert.equal(await s.apply(account), "applied");
  assert.equal(await s.baselineRow(), null, "an account entry is not the baseline");
  assert.equal(await s.repository.baselineApplied(), false, "live, but no baseline yet: not complete");
  const cursors = {};
  for (const station of [s.built, second]) cursors[station.id] = await s.cursorOf(station);
  s.notified.length = 0;
  assert.equal(await s.apply(baseline), "applied");
  assert.deepEqual(await s.baselineRow(), { cursor: baseline.cursor, at: baseline.at, complete: true }, "applied in order, it completes the view");
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
    assert.deepEqual(await s.told(station), [["account_disabled", OWNER], ["accounts_baseline", null]], station.id);
    assert.deepEqual((await s.service.changes(station.reportClientId, "0")).disabledAccounts, [OWNER], station.id);
  }
  // One transaction: the applied mark, the baseline and both Stations' changes.
  const { rows: writers } = await s.db.pool.query(
    "SELECT xmin::text AS writer FROM account_baseline UNION ALL SELECT xmin::text FROM integration_events WHERE kind = 'accounts_baseline' UNION ALL SELECT xmin::text FROM auth_account_entries WHERE kind = 'accounts_baseline'");
  assert.equal(writers.length, 4);
  assert.equal(new Set(writers.map((writer) => writer.writer)).size, 1, "one transaction");
  assert.deepEqual(await s.levelEvents(custom.id), [], "a custom Station never gets an account-level change");
  assert.equal((await s.service.changes(customStation.reportClientId, "0")).changes.some((entry) => entry.kind.startsWith("account")), false);

  // Read again, or at the end of a read, nothing more is written or pushed.
  const after = await s.written();
  assert.deepEqual(after, { entries: 2, availability: 1, baseline: 1, events: 4 });
  s.notified.length = 0;
  assert.equal(await s.apply(baseline), "skipped");
  assert.equal(await s.caughtUp(), false);
  assert.deepEqual(await s.written(), after);
  assert.deepEqual(s.notified, []);
  // A later baseline (Auth turned its setting on again) updates the record and leaves the view complete: the Stations
  // already have it, and hear nothing more.
  s.clock.now += 1000;
  s.manage.baselineChange();
  const later = s.manage.feed.at(-1);
  assert.equal(await s.apply(later), "applied");
  assert.deepEqual(await s.baselineRow(), { cursor: later.cursor, at: later.at, complete: true });
  assert.deepEqual((await s.levelEvents(s.built.id)).map((event) => event.kind), ["account_disabled", "accounts_baseline"]);
  assert.deepEqual(s.notified, []);
});

// Several Portal replicas read Auth's feed: each takes the event lock first, so one entry (one flip to complete, one
// adoption of a rebuild) is done by the first and found done by the others.
test("with the setting on, the same account entry applied by two readers at once is applied once, with one event per built-in Station; so is a baseline's flip to complete, and the end of a rebuild", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const second = await secondBuiltIn(s);
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const [entry, baseline] = s.manage.feed;
  const pass = await s.pass();
  s.notified.length = 0;
  assert.deepEqual((await Promise.all([s.service.applyAuthChange(entry, pass), s.service.applyAuthChange({ ...entry }, pass)])).sort(), ["applied", "skipped"]);
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort(), "each Station is pushed once");
  for (const station of [s.built, second]) assert.equal((await s.accountEvents(station.id)).length, 1, station.id);
  assert.deepEqual(await s.written(), { entries: 1, availability: 1, baseline: 0, events: 2 });
  assert.deepEqual((await Promise.all([s.service.applyAuthChange(baseline, pass), s.service.applyAuthChange({ ...baseline }, pass)])).sort(), ["applied", "skipped"]);
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station), [["account_disabled", OWNER], ["accounts_baseline", null]], station.id);

  // A reset, the feed applied to the rebuild, and three replicas at the end of their reads at once: one adopts it.
  await s.service.accountsStartingOver();
  const rebuilding = await s.pass();
  for (const change of [entry, baseline]) assert.equal(await s.service.applyAuthChange(change, rebuilding), "applied");
  s.notified.length = 0;
  assert.deepEqual((await Promise.all([s.service.accountsCaughtUp(rebuilding), s.service.accountsCaughtUp(rebuilding), s.service.accountsCaughtUp(rebuilding)])).sort(), [false, false, true], "only the first adopts it");
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort());
  for (const station of [s.built, second]) {
    assert.deepEqual(await s.told(station), [["account_disabled", OWNER], ["accounts_baseline", null], ["accounts_incomplete", null], ["accounts_baseline", null]], station.id);
  }
  assert.equal(await s.repository.baselineApplied(), true);
});

test("with the setting on and no built-in Station, availability and the baseline are still recorded and the view completes, and a built-in Station created afterwards starts with every disabled account", async (t) => {
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
  assert.equal(await s.repository.baselineApplied(), true, "live, the baseline completes the view");
  assert.deepEqual(await s.written(), { entries: 5, availability: 3, baseline: 1, events: 0 });
  assert.deepEqual(s.notified, []);
  assert.deepEqual(await s.follow(), [], "nothing new to read");
  // A rebuild with no built-in Station tells nobody either.
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD]);
  assert.deepEqual(await s.written(), { entries: 5, availability: 3, baseline: 1, events: 0 });

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
  for (const change of changes) assert.equal(await s.apply(change), "skipped");
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
  // A rebuild from the whole feed ends the same.
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  assert.deepEqual(await s.repository.disabledAccountList(), [THIRD]);
});

const WAITING = "Account availability waits for Auth's change feed to be read again from the start: reset the Portal's Auth cursor (docs/platform.md, \"Resetting The Portal's Auth Cursor\").";
const STALE_PASS = "Auth change pass superseded by a reset: read again.";
const CURSOR_AHEAD = "Auth change feed cursor is ahead of Auth (restored from a backup?): reading the feed again from the start.";
const READ_AGAIN = "Auth change feed read again.";

// P1. Once the Portal has skipped an account-level entry, what it applies afterwards could not be trusted to be all of
// Auth's feed, so it waits: it applies and records no account-level entry, and the Stations hear once that its view is
// not complete. A reset rebuilds the view from Auth's whole feed, and the Stations then hear only what differs from what
// they were told, then the baseline.
test("P1: after an entry skipped with the setting off, a Portal with it on and no reset waits, and the Stations are told once that the view is not complete; after a reset they hear only the differences and the baseline", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const second = await secondBuiltIn(s);
  const off = s.replica({ on: false });
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll();
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD]);
  const start = {};
  for (const station of [s.built, second]) {
    assert.deepEqual(await s.told(station), [["account_disabled", OWNER], ["account_disabled", THIRD], ["accounts_baseline", null]], station.id);
    start[station.id] = await s.cursorOf(station);
  }

  // The setting is off for a while, and Auth enables THIRD: this Portal skips the entry.
  s.manage.accountChange(THIRD, false, { actor: ADMIN, reason: "Appeal" });
  await s.readAll({ service: off.service, log: off.logs });
  assert.equal(await s.repository.baselineApplied(), false, "the view is no longer complete");
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [], "with the setting off the Stations are told nothing: " + station.id);

  // The setting is on again, with no reset. Auth disables OTHER, enables OWNER and writes a new baseline, and an admin
  // pauses an integration.
  s.clock.now += 1000;
  s.manage.accountChange(OTHER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  s.manage.baselineChange();
  const before = await s.written();
  s.notified.length = 0;
  await s.readAll();
  assert.equal((await s.repository.integration(id)).state, "paused", "an integration's entry applies as usual");
  assert.equal(s.logs.filter((line) => line === WAITING).length, 1, "said once in the read");
  assert.equal(await s.repository.baselineApplied(), false, "still not complete");
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD], "nothing was applied while it waited");
  assert.equal((await s.written()).entries, before.entries, "nor recorded");
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [["accounts_incomplete", null]], "told once, at the end of the read: " + station.id);
  assert.ok(s.notified.includes(s.built.id) && s.notified.includes(second.id));
  // Another read, with nothing new: no more news.
  await s.readAll();
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [["accounts_incomplete", null]], station.id);

  // A reset: the Portal rebuilds from Auth's whole feed. The Stations hear only what differs, then the baseline.
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  assert.equal(await s.repository.baselineApplied(), true, "complete again");
  assert.deepEqual(await s.repository.disabledAccountList(), [OTHER]);
  for (const station of [s.built, second]) {
    assert.deepEqual(await s.told(station, start[station.id]), [
      ["accounts_incomplete", null], ["account_enabled", OWNER], ["account_disabled", OTHER], ["account_enabled", THIRD], ["accounts_baseline", null]
    ], station.id);
  }
});

// P2. A rebuild never replays Auth's history to the Stations or to the live table: it is applied to tables of its own,
// and only its end state, compared with the live table, reaches them.
test("P2: a reset after a skip rebuilds without replaying history: no Station hears a superseded state, and the table never says an account is enabled while Auth says it is disabled", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const off = s.replica({ on: false });
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.clock.now += 1000;
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  s.clock.now += 1000;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse again" });
  s.manage.baselineChange();
  await s.readAll();
  assert.deepEqual(await s.told(s.built), [["account_disabled", OWNER], ["accounts_baseline", null]], "a first start tells the end state, not the history");
  const start = await s.cursorOf(s.built);
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  await s.readAll({ service: off.service, log: off.logs });

  await s.repository.saveAuthChangeCursor(null);
  const listed = [];
  await s.readAll({ pageSize: 2, pagesPerPull: 1, each: async () => listed.push((await s.repository.disabledAccountList()).includes(OWNER)) });
  assert.equal(listed.length, 5);
  assert.ok(listed.every(Boolean), "OWNER is disabled in the table throughout the rebuild");
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null], ["account_disabled", THIRD], ["accounts_baseline", null]]);
  assert.equal((await s.told(s.built)).some(([kind]) => kind === "account_enabled"), false, "no Station ever heard OWNER enabled");
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD]);
  assert.equal(await s.repository.baselineApplied(), true);
});

// P3. Every start-over raises the epoch, and a read pass applies account-level entries only in the epoch it began in. One
// that was in flight when another replica started over is fenced, so it can never apply a newer entry ahead of the
// rebuild's older ones.
test("P3: a start-over while another replica's read is in flight, past an entry skipped with the setting off, fences that read: it stops with the superseded line, and the rebuild ends as Auth's feed says", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const a = s.replica();
  const b = s.replica();
  const off = s.replica({ on: false });
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll({ service: b.service, log: b.logs });
  assert.equal(await s.repository.baselineApplied(), true);
  const start = await s.cursorOf(s.built);
  // A replica with the setting off skips Auth's enable of OWNER.
  s.clock.now += 1000;
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  await s.readAll({ service: off.service, log: off.logs });
  // Replica A reads on, past the skip, and is held just before it applies Auth's next entry, a disable.
  s.clock.now += 1000;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse again" });
  const [first, , , disable] = s.manage.feed;
  const held = s.gate();
  const readerA = s.reader({ service: a.service, log: a.logs, hold: (change) => (change.cursor === disable.cursor ? held.wait() : undefined) });
  readerA.start();
  await held.reached;
  // Meanwhile the Portal's cursor is emptied and replica B starts the feed over; it is held at the first entry.
  await s.repository.saveAuthChangeCursor(null);
  const replaying = s.gate();
  const readerB = s.reader({ service: b.service, log: b.logs, hold: (change) => (change.cursor === first.cursor ? replaying.wait() : undefined) });
  readerB.start();
  await replaying.reached;
  // A goes on. Its read began before the start-over, so the disable is refused and the read stops, its cursor unsaved.
  held.open();
  await readerA.idle();
  assert.deepEqual(a.logs, [STALE_PASS]);
  assert.equal(await s.savedCursor(), null);
  assert.deepEqual(await s.rebuilt(), { entries: 0, availability: 0 }, "nothing reached the rebuild");
  // B rebuilds from the start, in Auth's order.
  replaying.open();
  await readerB.idle();
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER], "Auth's last word: disabled");
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null], ["accounts_baseline", null]], "OWNER was disabled and still is: nothing differs");
  // A's next read is in the new epoch, from B's cursor: nothing is left to do.
  readerA.request();
  await readerA.idle();
  assert.deepEqual(a.logs, [STALE_PASS], "a superseded pass is no failure, so nothing says reads work again");
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null], ["accounts_baseline", null]]);
});

// The fence covers a read's cursor too: a pass that began before a start-over saves no cursor, so a rebuild that is cut
// short starts over again rather than going on from the stale pass's place, past entries the rebuild never applied.
test("P3: a read pass that began before a start-over saves no cursor, though its page held an integration's entry only; a rebuild cut short then starts over, and ends as Auth's feed says", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const a = s.replica();
  const b = s.replica();
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [first, paused] = s.manage.feed;
  // A's read starts the feed over and applies the disable to the rebuild, then is held at the pause.
  const held = s.gate();
  const readerA = s.reader({ service: a.service, log: a.logs, hold: (change) => (change.cursor === paused.cursor ? held.wait() : undefined) });
  readerA.start();
  await held.reached;
  assert.deepEqual(await s.rebuilt(), { entries: 1, availability: 1 });
  // B starts the feed over too, and its read fails at the first entry (its database connection dropped, say).
  const failing = s.gate();
  const readerB = s.reader({ service: b.service, log: b.logs, hold: (change) => (change.cursor === first.cursor ? failing.wait() : undefined) });
  readerB.start();
  await failing.reached;
  assert.deepEqual(await s.rebuilt(), { entries: 0, availability: 0 }, "B's start-over emptied the rebuild");
  failing.fail(Object.assign(new Error("connection lost"), { code: "ECONNRESET" }));
  await readerB.idle();
  assert.deepEqual(b.logs, ["Auth change not applied: ECONNRESET."]);
  // A goes on: the pause applies (an integration's entry is not fenced), but the page's cursor is not saved.
  held.open();
  await readerA.idle();
  assert.deepEqual(a.logs, [STALE_PASS]);
  assert.equal((await s.repository.integration(id)).state, "paused");
  assert.equal(await s.savedCursor(), null, "no cursor saved");
  // Auth writes a baseline. The next read starts the feed over, and the rebuild has OWNER disabled.
  s.manage.baselineChange();
  readerA.request();
  await readerA.idle();
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER]);
  assert.deepEqual(await s.told(s.built), [["account_disabled", OWNER], ["accounts_baseline", null]]);
});

// P4. After Auth is restored from a backup, entries the restore lost must lose their effect at the Portal too: the
// Portal's cursor is ahead of Auth's feed, so it rebuilds from the feed as it now is, and the difference reaches the
// Stations.
test("P4: Auth restored from a backup that lost an enable: the cursor is ahead, the Portal rebuilds, and the difference disables the account again; the view is complete with it disabled", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const second = await secondBuiltIn(s);
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll();
  s.clock.now += 1000;
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  await s.readAll();
  assert.deepEqual(await s.repository.disabledAccountList(), []);
  const lost = s.manage.feed.at(-1);
  const start = {};
  for (const station of [s.built, second]) {
    assert.deepEqual(await s.told(station), [["account_disabled", OWNER], ["accounts_baseline", null], ["account_enabled", OWNER]], station.id);
    start[station.id] = await s.cursorOf(station);
  }
  // Auth is restored from a backup taken before the enable.
  s.manage.restore(2);
  s.clock.now += 1000;
  s.notified.length = 0;
  await s.readAll();
  assert.ok(s.logs.includes(CURSOR_AHEAD));
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER], "as Auth's feed now says");
  assert.equal(await s.repository.baselineApplied(), true);
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [["accounts_incomplete", null], ["account_disabled", OWNER], ["accounts_baseline", null]], station.id);
  assert.deepEqual([...new Set(s.notified)].sort(), [s.built.id, second.id].sort());
  // Auth goes on and hands out the lost entry's cursor again, at another time: another entry, applied live.
  s.clock.now += 1000;
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  assert.equal(s.manage.feed.at(-1).cursor, lost.cursor);
  await s.readAll();
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD]);
  for (const station of [s.built, second]) assert.deepEqual((await s.told(station, start[station.id])).at(-1), ["account_disabled", THIRD], station.id);
});

// P6. Two Portal replicas start fresh at once over a long feed. Each starts the feed over; a read in an earlier epoch is
// fenced, and between them the rebuild is applied once each entry, in Auth's order.
test("P6: two fresh replicas over a long feed rebuild it between them in Auth's order, are never complete mid-rebuild, and tell the Stations only the end state", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const accounts = Array.from({ length: 6 }, (_, n) => "ab" + "1".repeat(25) + n);
  const expected = new Map();
  for (let n = 0; n < 80; n += 1) {
    if (n === 37) s.manage.baselineChange();
    const account = accounts[(n * 7) % accounts.length];
    const disabled = (n * 5) % 3 !== 0;
    s.manage.accountChange(account, disabled, { actor: ADMIN, reason: "Load" });
    expected.set(account, disabled);
  }
  const disabled = [...expected].filter(([, value]) => value).map(([account]) => account).sort();
  const a = s.replica();
  const b = s.replica();
  const seen = [];
  const each = async () => seen.push(await s.view());
  const readers = [a, b].map((replica) => s.reader({ service: replica.service, log: replica.logs, pageSize: 7, pagesPerPull: 2, each }));
  for (const feed of readers) feed.start();
  await Promise.all(readers.map((feed) => feed.idle()));
  // A read that was fenced goes on at its next poll, in the new epoch.
  for (const feed of readers) feed.request();
  await Promise.all(readers.map((feed) => feed.idle()));
  assert.deepEqual(await s.told(s.built), [...disabled.map((account) => ["account_disabled", account]), ["accounts_baseline", null]], "the end state only");
  assert.deepEqual(await s.repository.disabledAccountList(), disabled);
  assert.equal(await s.repository.baselineApplied(), true);
  assert.ok(seen.length >= 81, String(seen.length));
  assert.ok(seen.some((entry) => entry.mode === "rebuilding"));
  assert.deepEqual(seen.filter((entry) => entry.mode === "rebuilding" && entry.complete), [], "never complete mid-rebuild");
  assert.deepEqual([...a.logs, ...b.logs].filter((line) => line !== STALE_PASS), ["Account availability rebuilt: " + disabled.length + " accounts changed; complete."], "one adopted the rebuild");

  // A reset, and two replicas sharing one epoch: B begins while A's rebuild is under way, at the cursor A saved, and they
  // apply the rest between them, each entry once.
  const start = await s.cursorOf(s.built);
  await s.repository.saveAuthChangeCursor(null);
  const shared = [];
  let halfway;
  const underWay = new Promise((resolve) => { halfway = resolve; });
  const first = s.reader({ service: a.service, log: a.logs, pageSize: 7, pagesPerPull: 2, each: async (change, result) => {
    shared.push(["a", result, await s.view()]);
    if (shared.length === 10) halfway();
  } });
  const then = s.reader({ service: b.service, log: b.logs, pageSize: 7, pagesPerPull: 2, each: async (change, result) => shared.push(["b", result, await s.view()]) });
  a.logs.length = 0;
  b.logs.length = 0;
  first.start();
  await underWay;
  then.start();
  await Promise.all([first.idle(), then.idle()]);
  assert.deepEqual([...a.logs, ...b.logs], ["Account availability incomplete: rebuilding.", "Account availability rebuilt: 0 accounts changed; complete."], "one epoch: neither is fenced");
  assert.ok(shared.some(([who]) => who === "b"), "B applied some");
  assert.equal(shared.filter(([, result]) => result === "applied").length, 81, "each entry applied once between them");
  assert.deepEqual(shared.filter(([, , view]) => view.mode === "rebuilding" && view.complete), []);
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null], ["accounts_baseline", null]], "nothing differs");
  assert.deepEqual(await s.repository.disabledAccountList(), disabled);
  assert.equal(await s.repository.baselineApplied(), true);
});

const OLDER_IMAGE = "Auth change feed cursor was moved by an older Portal image: account availability rebuilds.";
// The cursor save of a Portal image from before migration 006, exactly as it was: Auth's cursor alone.
const olderSave = (s, cursor) => s.db.pool.query("INSERT INTO auth_change_feed (id, cursor) VALUES (true, $1) ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()", [cursor]);

// I1. An image from before migration 006 skips Auth's account-level entries unrecorded and saves its cursor without the
// copy this image writes with it (accounts_cursor). The reader takes a cursor that differs from its copy for such a write:
// with the setting on it starts over, and with it off the Portal waits, as an entry skipped with the setting off makes it.
test("I1: a cursor an older Portal image moved makes the next read start over with the setting on, with one fixed line; with it off the Portal moves to waiting, owing the Stations the news, and logs nothing new", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const second = await secondBuiltIn(s);
  const id = await s.ready();
  const later = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll();
  assert.deepEqual(await s.view(), { mode: "live", complete: true });
  const start = {};
  for (const station of [s.built, second]) start[station.id] = await s.cursorOf(station);

  // An older image reads on past an admin's pause (an integration's entry: nothing account-level is skipped) and saves.
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  await olderSave(s, s.manage.feed.at(-1).cursor);
  const { epoch } = await s.sync();
  s.logs.length = 0;
  await s.readAll();
  assert.equal(s.logs.filter((line) => line === OLDER_IMAGE).length, 1, "said once");
  assert.equal((await s.sync()).epoch, epoch + 1, "it started over");
  assert.deepEqual(await s.view(), { mode: "live", complete: true }, "and rebuilt from Auth's first entry");
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER]);
  assert.equal((await s.repository.integration(id)).state, "paused", "the entry the older image moved past is applied too");
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [["accounts_incomplete", null], ["accounts_baseline", null]], station.id);
  s.logs.length = 0;
  await s.readAll();
  assert.deepEqual(s.logs.filter((line) => line === OLDER_IMAGE), [], "the cursor this image saved is its own");

  // With the setting off the same save moves the Portal to waiting and owes the Stations the news, as a skipped
  // account-level entry does; nothing new is logged, and the read goes on from the cursor.
  const off = s.replica({ on: false });
  for (const station of [s.built, second]) start[station.id] = await s.cursorOf(station);
  s.manage.adminChange(later, { status: "paused", actor: ADMIN, reason: "Spam" });
  await olderSave(s, s.manage.feed.at(-1).cursor);
  const before = await s.sync();
  await s.readAll({ service: off.service, log: off.logs });
  assert.deepEqual(off.logs, [], "nothing new is logged");
  assert.deepEqual(await s.sync(), { ...before, mode: "waiting", owed: true });
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(await s.repository.authChangePlace(), { cursor: s.manage.feed.at(-1).cursor, epoch: before.epoch, foreign: false }, "the cursor is taken as it is");
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [], "with the setting off the Stations are told nothing: " + station.id);
  // With it on again, the Portal waits and the Stations hear once that the view is not complete; a reset rebuilds it.
  await s.readAll();
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [["accounts_incomplete", null]], station.id);
  assert.equal((await s.sync()).mode, "waiting");
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  assert.deepEqual(await s.view(), { mode: "live", complete: true });
  assert.equal((await s.repository.integration(later)).state, "paused", "the rebuild reads what the older image moved past");
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [["accounts_incomplete", null], ["accounts_baseline", null]], station.id);
});

// The reviewer's probe: the Portal is live and complete, an admin disables X, and an older image reads the entry, skips
// it unrecorded and saves its cursor past it. Until this image reads, nothing can tell; once it reads, it must never say
// complete with X missing, and it ends complete with X disabled.
test("I1 probe: live and complete, an admin disables X, an older image's cursor save moves past it; this image's next read rebuilds, is never complete with X missing, and ends with X disabled", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll();
  assert.deepEqual(await s.view(), { mode: "live", complete: true });
  const start = await s.cursorOf(s.built);
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  await olderSave(s, s.manage.feed.at(-1).cursor);
  const seen = [];
  const look = async () => seen.push({ ...(await s.view()), missing: !(await s.repository.disabledAccountList()).includes(THIRD) });
  await s.readAll({ pageSize: 1, hold: look, each: look });
  await look();
  assert.ok(seen.length >= 6, String(seen.length));
  assert.deepEqual(seen.filter((entry) => entry.complete && entry.missing), [], "never complete with X missing");
  assert.deepEqual(seen.at(-1), { mode: "live", complete: true, missing: false });
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD]);
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null], ["account_disabled", THIRD], ["accounts_baseline", null]]);
  assert.ok(s.logs.includes(OLDER_IMAGE));
});

// A mixed rolling deploy: this image's rebuild is part way through Auth's feed when an older image, which read on from
// a cursor of its own, saves one further on. Going on from there would skip the entries between, and adopt a rebuild
// that never applied them; the guard starts over instead.
test("I1: a rebuild an older image's cursor save would cut short starts over rather than skip the entries between", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const accounts = Array.from({ length: 8 }, (_, n) => "ab" + "2".repeat(25) + n);
  for (const account of accounts) s.manage.accountChange(account, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  // This image's first read applies two entries to the rebuild and saves its cursor in its epoch.
  const epoch = await s.service.accountsStartingOver();
  for (const entry of s.manage.feed.slice(0, 2)) assert.equal(await s.service.applyAuthChange(entry, { epoch }), "applied");
  assert.equal(await s.repository.moveAuthChangeCursor(s.manage.feed[1].cursor, epoch), true);
  assert.deepEqual(await s.rebuilt(), { entries: 2, availability: 2 });
  // The older image saves the cursor of the sixth entry.
  await olderSave(s, s.manage.feed[5].cursor);
  await s.readAll();
  assert.equal(s.logs.filter((line) => line === OLDER_IMAGE).length, 1);
  assert.deepEqual(await s.view(), { mode: "live", complete: true });
  assert.deepEqual(await s.repository.disabledAccountList(), [...accounts].sort(), "every account, the ones between included");
});

// The reset platform.md documents empties the copy with the cursor, so it is not taken for an older image's write.
test("I1: the documented reset of the Portal's Auth cursor is not taken for an older image's write", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll();
  const section = readFileSync(new URL("../docs/platform.md", import.meta.url), "utf8").split("#### Resetting The Portal's Auth Cursor")[1];
  const [, statement] = /```sql\n([^`]+)```/.exec(section);
  const { epoch } = await s.sync();
  await s.db.pool.query(statement);
  s.logs.length = 0;
  await s.readAll();
  assert.deepEqual(s.logs.filter((line) => line === OLDER_IMAGE), []);
  assert.equal((await s.sync()).epoch, epoch + 2, "the reset's epoch, then the start-over's");
  assert.deepEqual(await s.view(), { mode: "live", complete: true });
});

// I3. While the Portal waits, a read that skips an account-level entry logs the WAITING line, as before; a read that skips
// none (nothing new in Auth's feed) logs it at its end at most once an hour, so a Portal that waits says so however quiet
// Auth's feed is.
test("I3: waiting, with the cursor at the end of Auth's feed, a read logs the WAITING line once, then not again within the hour, and again after it; a read that skips an entry says it every time", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll();
  const off = s.replica({ on: false });
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  await s.readAll({ service: off.service, log: off.logs });
  assert.equal((await s.sync()).mode, "waiting");
  assert.equal(off.logs.includes(WAITING), false, "with the setting off nothing new is logged");
  const end = await s.savedCursor();
  const said = () => s.logs.filter((line) => line === WAITING).length;
  s.logs.length = 0;
  await s.readAll();
  assert.equal(said(), 1, "the end of a read that skipped nothing says it");
  assert.equal(await s.savedCursor(), end, "there was nothing to read");
  s.clock.now += 59 * 60000;
  await s.readAll();
  await s.readAll();
  assert.equal(said(), 1, "not again within the hour");
  s.clock.now += 60000;
  await s.readAll();
  assert.equal(said(), 2, "and again an hour later");
  // A read that skips an entry says it, every time, and its end says nothing more.
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  await s.readAll();
  s.manage.accountChange(THIRD, false, { actor: ADMIN, reason: "Appeal" });
  await s.readAll();
  assert.equal(said(), 4);
  // Another replica is another process, with its own hour.
  const other = s.replica();
  await s.readAll({ service: other.service, log: other.logs });
  assert.equal(other.logs.filter((line) => line === WAITING).length, 1);
  // A read whose pass is stale says nothing.
  assert.equal(await other.service.accountsCaughtUp({ epoch: (await s.sync()).epoch + 1 }), false);
  s.clock.now += 2 * 3600000;
  assert.equal(await other.service.accountsCaughtUp({ epoch: (await s.sync()).epoch - 1 }), false);
  assert.equal(other.logs.filter((line) => line === WAITING).length, 1);
});

// The Portal says how its view of the accounts changes in counts only, never naming an account.
test("with the setting on, account availability logs counts only: a rebuild adopted (and whether it completed the view), a live baseline that completes it, and each time it stops being complete", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const lines = () => {
    const said = s.logs.filter((line) => line.startsWith("Account availability "));
    s.logs.length = 0;
    return said;
  };
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  await s.readAll();
  assert.deepEqual(lines(), ["Account availability rebuilt: 2 accounts changed."], "no baseline: not complete");
  s.manage.baselineChange();
  await s.readAll();
  assert.deepEqual(lines(), ["Account availability complete."]);
  s.manage.baselineChange();
  await s.readAll();
  assert.deepEqual(lines(), [], "already complete");
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  assert.deepEqual(lines(), ["Account availability incomplete: rebuilding.", "Account availability rebuilt: 0 accounts changed; complete."]);
  s.manage.rawChange({ kind: "account_disabled", clientId: null, stationId: null, owner: "not an account", status: null, pausedBy: null, actorAccountId: null, reason: null, admin: true });
  await s.readAll();
  assert.deepEqual(lines(), ["Account availability incomplete: waiting.", WAITING]);
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  assert.deepEqual(lines(), [WAITING], "already incomplete: the Stations know, and the rebuild waits again");
});

// A start-over (a first start, a reset, or a cursor ahead of Auth's) raises the epoch and rebuilds the view into tables of
// its own. The view is incomplete at once, and the Stations are told so if they were told it was complete; the live table
// and the Stations are otherwise left alone until the rebuild has caught up with the end of the feed. Then its differences
// from the live table, and the baseline it saw, are all the Stations hear.
test("with the setting on, a start-over makes the view incomplete at once and rebuilds it apart: the live table and the Stations are untouched until the end of the feed, which adopts the rebuild and tells only what differs", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  assert.deepEqual(await s.sync(), { mode: "rebuilding", epoch: 0, rebuildBaseline: null, owed: false }, "a fresh Portal starts by rebuilding");
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  // A first start, two changes a page and one page a read: the live table stays empty and the view incomplete throughout.
  const first = [];
  await s.readAll({ pageSize: 2, pagesPerPull: 1, each: async () => first.push([await s.repository.baselineApplied(), await s.repository.disabledAccountList()]) });
  assert.deepEqual(first, Array(4).fill([false, []]));
  assert.deepEqual(await s.sync(), { mode: "live", epoch: 1, rebuildBaseline: null, owed: false });
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.repository.disabledAccountList(), [THIRD]);
  assert.deepEqual(await s.told(s.built), [["account_disabled", THIRD], ["accounts_baseline", null]], "OWNER was disabled and enabled again: nothing to tell");
  assert.deepEqual(await s.rebuilt(), { entries: 0, availability: 0 }, "the rebuild is emptied once adopted");
  assert.equal((await s.written()).entries, 4, "and its entries are the live ones");

  // A reset: incomplete at once, and the Stations are told; the replay leaves the live table as it was, and at the end
  // nothing differs.
  const start = await s.cursorOf(s.built);
  await s.repository.saveAuthChangeCursor(null);
  const replay = [];
  await s.readAll({ pageSize: 2, pagesPerPull: 1, each: async () => replay.push([await s.repository.baselineApplied(), await s.repository.disabledAccountList()]) });
  assert.deepEqual(replay, Array(4).fill([false, [THIRD]]));
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null], ["accounts_baseline", null]]);
  assert.equal((await s.sync()).epoch, 2);

  // By hand, as the reader calls the service.
  const { changes } = await s.manage.integrationChanges();
  const stale = await s.pass();
  s.notified.length = 0;
  assert.equal(await s.service.accountsStartingOver(), 3, "it says the new epoch");
  assert.deepEqual(await s.sync(), { mode: "rebuilding", epoch: 3, rebuildBaseline: null, owed: false });
  assert.equal(await s.savedCursor(), null, "and empties the cursor with it");
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(s.notified, [s.built.id], "the Station is told at once");
  const pass = await s.pass();
  for (const change of changes.slice(0, 3)) assert.equal(await s.service.applyAuthChange(change, pass), "applied");
  assert.deepEqual(await s.rebuilt(), { entries: 3, availability: 2 });
  assert.equal((await s.sync()).rebuildBaseline, changes[2].cursor, "the rebuild saw a baseline");
  assert.deepEqual(await s.repository.disabledAccountList(), [THIRD], "the live table is untouched");
  assert.equal(await s.service.accountsCaughtUp(stale), false, "the end of a read from an earlier epoch does nothing");
  assert.equal((await s.sync()).mode, "rebuilding");
  assert.equal(await s.service.applyAuthChange(changes[3], pass), "applied");
  assert.equal(await s.service.accountsCaughtUp(pass), true);
  assert.deepEqual(await s.sync(), { mode: "live", epoch: 3, rebuildBaseline: null, owed: false });
  assert.deepEqual(await s.repository.disabledAccountList(), [THIRD]);
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null], ["accounts_baseline", null], ["accounts_incomplete", null], ["accounts_baseline", null]]);
  assert.equal(await s.service.accountsCaughtUp(pass), false, "live, the end of a read has nothing to do");
});

test("with the setting on, a rebuild that saw no baseline goes live but stays incomplete: the Stations hear the differences and no accounts_baseline, until a baseline is applied live", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  await s.readAll();
  assert.equal((await s.sync()).mode, "live");
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER, THIRD]);
  assert.equal(await s.baselineRow(), null);
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(await s.told(s.built), [["account_disabled", OWNER], ["account_disabled", THIRD]]);
  assert.equal(await s.caughtUp(), false);
  s.manage.baselineChange();
  await s.readAll();
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.told(s.built), [["account_disabled", OWNER], ["account_disabled", THIRD], ["accounts_baseline", null]]);
});

// A malformed account-level entry can't be applied, and what the Portal applied after it could not be trusted to be all
// of Auth's feed: the Portal waits. Nothing is forgotten, and a rebuild that meets the same entry waits again, so the view
// stays incomplete (fail closed) until Auth's feed is fixed.
test("with the setting on, a malformed account-level entry moves the Portal to waiting: the Stations are told once that the view is not complete, later account-level entries are skipped unrecorded, and a rebuild that meets it again waits again", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll();
  const start = await s.cursorOf(s.built);
  const before = await s.written();
  const { epoch } = await s.sync();
  s.manage.rawChange({ kind: "account_disabled", clientId: null, stationId: null, owner: "not an account", status: null, pausedBy: null, actorAccountId: null, reason: null, admin: true });
  s.manage.accountChange(THIRD, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  s.manage.baselineChange();
  s.notified.length = 0;
  await s.readAll();
  assert.deepEqual(await s.sync(), { mode: "waiting", epoch, rebuildBaseline: null, owed: false });
  assert.equal(await s.repository.baselineApplied(), false);
  assert.ok(s.logs.includes("Auth change skipped: not a change entry."));
  assert.equal(s.logs.filter((line) => line === WAITING).length, 1, "once in the read");
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null]], "told at once, and once");
  assert.ok(s.notified.includes(s.built.id));
  assert.deepEqual(await s.written(), { ...before, events: before.events + 1 }, "the entries after it are not recorded: only the news was written");
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER], "availability is left as it was");
  assert.equal((await s.repository.integration(id)).state, "paused", "an integration's entry applies as usual");
  // The next read says it again; its end tells the Stations nothing more.
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  await s.readAll();
  assert.equal(s.logs.filter((line) => line === WAITING).length, 2);
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null]]);

  // A reset: the rebuild meets the entry again and waits again. The live table and the Stations are left as they were,
  // and the view stays incomplete.
  await s.repository.saveAuthChangeCursor(null);
  await s.readAll();
  const after = await s.sync();
  assert.deepEqual([after.mode, after.epoch], ["waiting", epoch + 1]);
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER]);
  assert.deepEqual(await s.told(s.built, start), [["accounts_incomplete", null]], "nothing more: the Stations already know");
  assert.deepEqual(await s.rebuilt(), { entries: 2, availability: 1 }, "the rebuild stopped at it, and is never adopted");
});

test("with the setting on, every account-level entry the Portal can't apply moves it to waiting, a person's own included, and nothing is recorded or forgotten; a skipped entry of another kind does not", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [account, baseline, paused] = s.manage.feed;
  assert.equal(await s.apply({ ...paused, clientId: null }), "skipped");
  assert.equal(await s.apply({ ...account, kind: "account_deleted" }), "skipped");
  assert.equal((await s.sync()).mode, "live", "not account-level: the Portal stays live");
  assert.equal(await s.apply(account), "applied");
  const applied = await s.written();
  const unusable = [
    { ...account, owner: null }, { ...account, clientId: id }, { ...account, cursor: "not a cursor!" }, { ...baseline, owner: OWNER }, { ...baseline, at: "yesterday" },
    { ...account, admin: false, actorAccountId: OTHER }
  ];
  for (const entry of unusable) {
    assert.equal(await s.apply(entry), "skipped", JSON.stringify(entry));
    assert.equal((await s.sync()).mode, "waiting", JSON.stringify(entry));
    assert.deepEqual(await s.written(), applied, "nothing is recorded, and nothing forgotten: " + JSON.stringify(entry));
    // A reset brings it live again, with nothing to tell.
    await s.service.accountsStartingOver();
    assert.equal(await s.apply(account), "applied");
    assert.equal(await s.caughtUp(), true);
    assert.equal((await s.sync()).mode, "live");
    assert.deepEqual(await s.written(), applied, JSON.stringify(entry));
  }
});

// With the setting off the Portal follows no account-level entry (as before D29). Skipping one, it moves to waiting and
// clears the view's complete mark, the one internal exception to "off is today's behaviour"; nothing else is touched, and
// no Station is told, since nothing reaches a Station about accounts with the setting off. The first time a Portal runs
// with the setting on again, the end of a read tells each built-in Station once that the view is not complete.
test("with the setting off, an account-level entry is skipped and moves the Portal to waiting, clearing the mark and touching nothing else; the hooks do nothing; the Stations are told the view is not complete only once the setting is on", async (t) => {
  const s = await setup(t, { delegatedHostWork: true, fresh: true });
  if (!s) return;
  const second = await secondBuiltIn(s);
  const offLogs = [];
  const off = s.offService(offLogs);
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  await s.readAll();
  assert.equal(await s.repository.baselineApplied(), true);
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  s.manage.baselineChange();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [, , enabled, baseline, paused] = s.manage.feed;
  const place = await s.sync();
  const before = { written: await s.written(), rebuilt: await s.rebuilt(), disabled: await s.repository.disabledAccountList(), baseline: await s.baselineRow() };
  const start = {};
  for (const station of [s.built, second]) start[station.id] = await s.cursorOf(station);
  s.notified.length = 0;

  assert.equal(await off.applyAuthChange(enabled), "skipped", "a Portal with the setting off needs no read pass");
  assert.deepEqual(await s.sync(), { ...place, mode: "waiting", owed: true });
  assert.equal(await s.repository.baselineApplied(), false, "the mark is cleared");
  assert.deepEqual(await s.baselineRow(), { ...before.baseline, complete: false }, "the baseline stays recorded");
  assert.deepEqual([await s.written(), await s.rebuilt(), await s.repository.disabledAccountList()], [before.written, before.rebuilt, before.disabled], "nothing else is touched");
  assert.deepEqual(s.notified, []);
  assert.equal(await off.applyAuthChange(baseline), "skipped");
  assert.equal(await off.applyAuthChange({ kind: "account_enabled" }), "skipped", "an account-level entry of any shape");
  assert.equal(await off.applyAuthChange(null), "skipped");
  assert.equal(await off.applyAuthChange(paused), "applied", "an integration's entry is followed as today");
  assert.equal((await s.repository.integration(id)).state, "paused");
  // The hooks of a Portal with the setting off do nothing.
  assert.equal(await off.accountsStartingOver(), undefined);
  assert.equal(await off.accountsCaughtUp({ epoch: place.epoch }), false);
  assert.deepEqual(await s.sync(), { ...place, mode: "waiting", owed: true });
  assert.deepEqual(await s.written(), before.written);
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [], station.id);
  assert.deepEqual(s.notified.filter((stationId) => stationId === second.id), [], "the pause pushed the built-in Station it is on, and nothing else was pushed");
  assert.deepEqual(offLogs, Array(4).fill("Auth change skipped: not a change entry."), "nothing new is logged");

  // With the setting on again (no reset), the end of a read tells each built-in Station once.
  s.notified.length = 0;
  assert.equal(await s.caughtUp(), true);
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [["accounts_incomplete", null]], station.id);
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort());
  assert.deepEqual(await s.sync(), { ...place, mode: "waiting", owed: false });
  assert.equal(await s.caughtUp(), false, "once");
  for (const station of [s.built, second]) assert.deepEqual(await s.told(station, start[station.id]), [["accounts_incomplete", null]], station.id);
  // A skip with the setting off while the view isn't complete owes the Stations nothing: they already know.
  assert.equal(await off.applyAuthChange(enabled), "skipped");
  assert.equal((await s.sync()).owed, false);
});

// The epoch fences everything account-level a read pass does: an entry, a malformed one included, is refused with
// stale_pass under the event lock before it does anything, and the end of a stale read does nothing. An integration's
// entry is not fenced: it keeps its own dedupe. With the setting on, an account-level entry or the end of a read with no
// pass is a mistake.
test("with the setting on, a read pass from an earlier epoch is fenced: its account-level entries are refused with stale_pass before they do anything and its end does nothing, while an integration's entry still applies; account-level work needs a pass", async (t) => {
  const s = await setup(t, { delegatedHostWork: true });
  if (!s) return;
  const id = await s.ready();
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [account, paused] = s.manage.feed;
  const stale = await s.pass();
  await s.service.accountsStartingOver();
  const state = async () => ({ written: await s.written(), rebuilt: await s.rebuilt(), sync: await s.sync() });
  const before = await state();
  await assert.rejects(s.service.applyAuthChange(account, stale), (error) => error.code === "stale_pass");
  await assert.rejects(s.service.applyAuthChange({ ...account, owner: null }, stale), (error) => error.code === "stale_pass", "a malformed one too: a stale read never makes the Portal wait");
  assert.equal(await s.service.accountsCaughtUp(stale), false);
  assert.deepEqual(await state(), before);
  assert.equal(await s.service.applyAuthChange(paused, stale), "applied", "an integration's entry");
  for (const missing of [undefined, {}, { epoch: "1" }, { epoch: 1.5 }]) await assert.rejects(s.service.applyAuthChange(account, missing), TypeError, JSON.stringify(missing));
  await assert.rejects(s.service.accountsCaughtUp(), TypeError);
  assert.deepEqual(await state(), before);
  assert.equal(await s.apply(account), "applied", "in the current epoch");
  assert.deepEqual(await s.rebuilt(), { entries: 1, availability: 1 });
});

// Each account-level transaction is one for all active built-in Stations: a failure while appending to the second one
// rolls back everything it wrote, the first Station's change included, pushes nothing, and the next read does it once.
// That holds for an entry applied live, for a baseline that completes the view, for a start-over's accounts_incomplete and
// for the end of a rebuild. (This replaces Phase B's per-Station writes, where the first Station kept its event and its
// push.)
test("with the setting on, a failure while appending to the second built-in Station rolls everything back: an entry, a completing baseline, a start-over and the end of a rebuild; no push, and the retry does it once", async (t) => {
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
  const second = await secondBuiltIn(s);
  s.manage.accountChange(OWNER, true, { actor: ADMIN, reason: "Abuse" });
  s.manage.baselineChange();
  const [entry, baseline] = s.manage.feed;
  const nothing = await s.written();
  assert.deepEqual(nothing, { entries: 0, availability: 0, baseline: 0, events: 0 });

  // An account entry.
  Object.assign(control, { failStation: second.id, failKind: "account_disabled", appended: [] });
  s.notified.length = 0;
  await assert.rejects(s.apply(entry), /write failed/);
  assert.deepEqual(control.appended, [s.built.id + " account_disabled"], "the first Station's event was written, in the transaction that was rolled back");
  assert.deepEqual(await s.written(), nothing, "no partial tables");
  assert.deepEqual(await s.repository.disabledAccountList(), []);
  assert.deepEqual(s.notified, [], "no push");
  Object.assign(control, { failStation: null, appended: [] });
  assert.equal(await s.apply(entry), "applied", "read again, it applies");
  assert.deepEqual([...s.notified].sort(), [s.built.id, second.id].sort());
  assert.deepEqual(await s.written(), { entries: 1, availability: 1, baseline: 0, events: 2 });
  assert.equal(await s.apply(entry), "skipped", "once");

  // A baseline that completes the view.
  let settled = await s.written();
  Object.assign(control, { failStation: second.id, failKind: "accounts_baseline", appended: [] });
  s.notified.length = 0;
  await assert.rejects(s.apply(baseline), /write failed/);
  assert.deepEqual(control.appended, [s.built.id + " accounts_baseline"]);
  assert.deepEqual(await s.written(), settled, "nor the baseline");
  assert.equal(await s.repository.baselineApplied(), false);
  assert.deepEqual(s.notified, []);
  Object.assign(control, { failStation: null });
  assert.equal(await s.apply(baseline), "applied");
  assert.equal(await s.repository.baselineApplied(), true);
  assert.deepEqual(await s.written(), { entries: 2, availability: 1, baseline: 1, events: 4 });

  // A start-over, which tells the Stations the view is not complete.
  settled = await s.written();
  const place = await s.sync();
  Object.assign(control, { failStation: second.id, failKind: "accounts_incomplete", appended: [] });
  s.notified.length = 0;
  await assert.rejects(s.service.accountsStartingOver(), /write failed/);
  assert.deepEqual(control.appended, [s.built.id + " accounts_incomplete"]);
  assert.deepEqual([await s.sync(), await s.written(), await s.repository.baselineApplied()], [place, settled, true], "still live and complete, in the same epoch");
  assert.deepEqual(s.notified, []);
  Object.assign(control, { failStation: null });
  assert.equal(await s.service.accountsStartingOver(), place.epoch + 1);
  assert.equal(await s.repository.baselineApplied(), false);

  // The end of a rebuild in which Auth has enabled OWNER: the difference, and the baseline.
  s.manage.accountChange(OWNER, false, { actor: ADMIN, reason: "Appeal" });
  for (const change of s.manage.feed) assert.equal(await s.apply(change), "applied");
  settled = await s.written();
  const rebuilding = await s.sync();
  Object.assign(control, { failStation: second.id, failKind: "account_enabled", appended: [] });
  s.notified.length = 0;
  await assert.rejects(s.caughtUp(), /write failed/);
  assert.deepEqual(control.appended, [s.built.id + " account_enabled"]);
  assert.deepEqual([await s.sync(), await s.written(), await s.rebuilt()], [rebuilding, settled, { entries: 3, availability: 1 }], "still rebuilding; the live table and the rebuild as they were");
  assert.deepEqual(await s.repository.disabledAccountList(), [OWNER]);
  assert.deepEqual(s.notified, []);
  Object.assign(control, { failStation: null });
  assert.equal(await s.caughtUp(), true, "the next read adopts it");
  assert.deepEqual(await s.repository.disabledAccountList(), []);
  assert.equal(await s.repository.baselineApplied(), true);
  for (const station of [s.built, second]) assert.deepEqual((await s.told(station)).slice(-3), [["accounts_incomplete", null], ["account_enabled", OWNER], ["accounts_baseline", null]], station.id);
  assert.equal(await s.caughtUp(), false);
});

// A second built-in Station, as Auth lists it.
async function secondBuiltIn(s) {
  const second = s.manage.seedBuiltIn({ id: "stbuiltin2", origin: "https://station2.agora.test", name: "Second", integrations: true, admins: [ADMIN], reportClientId: "s-" + "0".repeat(24) + "b2" });
  assert.equal(await s.service.syncBuiltIn(), true);
  return second;
}

function stateOf(answer, id) {
  return answer.integrations.find((entry) => entry.id === id).state;
}
