// End-to-end check of the built-in Station (spec §3.3.2, D24): the real Portal, the real auth.agora.build with a
// built-in Station in its clients file, and that Station's stub, over real HTTP(S). Run with `npm run test:e2e` on
// Node 22, with TEST_DATABASE_URL (Auth) and PORTAL_TEST_DATABASE_URL (the Portal) set. Not part of npm test.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeJwt, exportJWK, generateKeyPair } from "jose";
import { API, authHasAdminPauseLock, authHasChangeFeed, authRepo, bearer, eventually, integrationsSkipReason, loadAuth, person, portalSignIn, skipReason, startStack } from "./harness.mjs";

const skip = (await skipReason()) ?? (await integrationsSkipReason());
if (skip) console.log("# Skipping the built-in Station end-to-end suite: " + skip + ".");
// The D26 flows need Auth's change feed and admin pause lock (Auth feat/admin-mfa Tasks 13 and 14).
const d26Skip = !authHasChangeFeed ? "the Auth checkout has no change feed (Auth D26 Task 13)" : !authHasAdminPauseLock ? "the Auth checkout has no admin pause lock (Auth D26 Task 14)" : false;
const ADMIN_PAUSED = "Agora.Build paused this integration. Only Agora.Build can resume it.";
// Disabling and enabling an owner needs only the change feed (Auth D26 Task 13): Auth records owner_disabled and
// owner_enabled for each of the account's integrations and nudges the Portal.
const ownerSkip = !authHasChangeFeed ? "the Auth checkout has no change feed (Auth D26 Task 13)" : false;
// The admin's reasons in tests 9 and 10, which stay in the Portal's integration_events only.
const REASONS = ["Spam in #general", "Cleared after review", "Confirmed abuse"];

const SCOPES = ["agent.view", "agent.prompt"];
const REPORT_CLIENT = /^s-[0-9a-hjkmnp-tv-z]{26}$/;
const PLAN_MESSAGE = (n) => "Your plan allows " + n + " integrations on the built-in Station. Revoke one, upgrade, or use your own Station.";
let lib;
let reference;
let stack;
let built;
const state = {};

const json = async (response) => ({ status: response.status, body: await response.json() });
const meOf = async (browser) => (await browser.api("/api/me")).json();
// Auth's management API, as the Portal calls it (HTTP Basic with the Portal client).
const manage = (method, path, body) => fetch(stack.issuer + "/manage/v1" + path, {
  method,
  headers: { Authorization: "Basic " + Buffer.from("portal:" + encodeURIComponent(stack.secrets.PORTAL_CLIENT_SECRET)).toString("base64"), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {})
}).then(async (response) => ({ status: response.status, body: response.status === 204 ? null : await response.json() }));
const publicJwk = async () => exportJWK((await generateKeyPair("ES256")).publicKey);
const create = async (browser, name = "Hosted app") => json(await browser.api("/api/integrations", { method: "POST", json: { stationId: built.id, name, scopes: SCOPES, publicJwk: await publicJwk() } }));
const feed = async (cursor, token) => json(await bearer(stack, "/api/v1/stations/changes?cursor=" + cursor, token));
// Who Auth recorded for an integration's status change (its integration_audit rows), as [account, actor] pairs.
const auditAtAuth = async (clientId, event) => (await stack.auth.db.query("SELECT account_id, actor_account_id FROM integration_audit WHERE client_id = $1 AND event = $2 ORDER BY id", [clientId, event])).rows.map((row) => [row.account_id, row.actor_account_id]);
// The same change as the operator's `platform-admin.mjs assign-role` (assignedPlan, null for Basic), in process.
const setPlan = (accountId, change) => stack.store.transaction((data) => { Object.assign(data.accounts.find((account) => account.id === accountId), change); });

describe("The built-in Station against the real auth.agora.build", { skip: skip || false }, () => {
  before(async () => {
    lib = await loadAuth();
    reference = await import(pathToFileURL(resolve(authRepo, "scripts/verify-station-token.mjs")).href);
    stack = await startStack(lib, { integrations: true, builtIn: { admin: person(7301, "Cy") }, authChanges: { pollMs: 3600000, minGapMs: 100 } });
    built = stack.builtIn;
  });
  after(async () => { await stack?.close(); });

  // P-D1: the Portal syncs the built-in Station when its integration stack is ready, from Auth's listing that names no
  // account (D26; no PLATFORM_ADMINS is set), so the Station's report token works before anyone has signed in to the Portal.
  test("1. before anyone signs in to the Portal, the built-in Station's report token reads its feed", async () => {
    assert.equal((await stack.store.snapshot()).accounts.length, 0, "nobody has signed in to the Portal yet");
    const issued = await built.reportToken();
    assert.equal(issued.status, 200);
    const first = await feed(0, issued.body.access_token);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.integrations, []);
    assert.ok(!stack.logs.some((line) => line.startsWith("Built-in Station sync")), "the sync ran without PLATFORM_ADMINS");
  });

  test("2. two accounts both list the built-in Station first, with no owner; Auth lists it the same way; both may read it", async () => {
    state.ada = await portalSignIn(stack, person(7311, "Ada"));
    state.adaId = (await meOf(state.ada.browser)).account.id;
    state.bo = await portalSignIn(stack, person(7312, "Bo"));
    state.boId = (await meOf(state.bo.browser)).account.id;
    for (const [browser, id] of [[state.ada.browser, state.adaId], [state.bo.browser, state.boId]]) {
      const { stations } = await (await browser.api("/api/stations")).json();
      assert.deepEqual(stations.map(({ id: stationId, origin, role, builtIn, ownerAccount, name, integrationsEnabled }) => ({ stationId, origin, role, builtIn, ownerAccount, name, integrationsEnabled })), [{ stationId: built.id, origin: built.origin, role: "built_in", builtIn: true, ownerAccount: null, name: "Agora Station", integrationsEnabled: false }]);
      assert.equal(stations[0].reportClientId, undefined);
      const inAuth = await manage("GET", "/stations?account=" + id);
      assert.deepEqual(inAuth.body.stations.map(({ id: stationId, builtIn, owner, access, integrations }) => ({ stationId, builtIn, owner, access, integrations })), [{ stationId: built.id, builtIn: true, owner: null, access: "any_account", integrations: false }]);
    }
    const read = await json(await state.bo.browser.api("/api/stations/" + built.id + "/read-token", { method: "POST", json: {} }));
    assert.equal(read.status, 200);
    const verifier = reference.createStationVerifier({ issuer: stack.issuer, origin: built.origin });
    assert.deepEqual(await verifier.verify(read.body.accessToken, { scope: "station.read" }), { sub: state.boId, clientId: "portal", scopes: ["station.read"] });
  });

  test("3. removing, sharing, leaving, listing members and registering it are refused, as Auth refuses them", async () => {
    for (const [method, path] of [["DELETE", "/api/stations/" + built.id], ["PUT", "/api/stations/" + built.id + "/members/" + state.boId], ["DELETE", "/api/stations/" + built.id + "/members/" + state.adaId], ["GET", "/api/stations/" + built.id + "/members"]]) {
      const answer = await json(await state.ada.browser.api(path, { method }));
      assert.deepEqual([answer.status, answer.body.code], [409, "built_in"], method + " " + path);
    }
    const challenge = await json(await state.ada.browser.api("/api/stations/challenges", { method: "POST", json: { origin: built.origin } }));
    assert.deepEqual([challenge.status, challenge.body.code], [409, "origin_taken"]);
    const removed = await manage("DELETE", "/stations/" + built.id + "?actor=" + built.adminId);
    assert.deepEqual([removed.status, removed.body.error], [409, "built_in"], "not even an admin removes it at Auth");
    assert.equal((await manage("GET", "/stations/" + built.id + "/members?actor=" + state.adaId)).body.error, "built_in");
    const register = await manage("POST", "/stations", { origin: built.origin, owner: state.adaId, reportKey: await publicJwk(), actor: state.adaId });
    assert.deepEqual([register.status, register.body.error], [409, "origin_taken"]);
  });

  test("4. its report token's sub is its own s- client; the Portal accepts it for the feed and makes no account for it", async () => {
    const issued = await built.reportToken();
    assert.equal(issued.status, 200);
    const claims = decodeJwt(issued.body.access_token);
    assert.deepEqual([claims.sub, claims.client_id, claims.aud, claims.scope], [built.reportClientId, built.reportClientId, API, "station.report"]);
    assert.match(claims.sub, REPORT_CLIENT);
    const first = await feed(0, issued.body.access_token);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.integrations, []);
    const elsewhere = await json(await bearer(stack, "/api/v1/me", issued.body.access_token));
    assert.equal(elsewhere.status, 403, "it reaches nothing but the report routes");
    assert.equal((await stack.store.snapshot()).accounts.some((account) => account.id === built.reportClientId), false);
  });

  test("5. creating an integration on it is refused while its integrations are off, and works once they are on", async () => {
    const off = await create(state.ada.browser);
    assert.deepEqual([off.status, off.body.code], [409, "not_supported"]);
    const atAuth = await manage("POST", "/integrations", { owner: state.adaId, stationId: built.id, name: "Direct", scopes: ["agent.view"], publicJwk: await publicJwk(), actor: state.adaId });
    assert.deepEqual([atAuth.status, atAuth.body.error], [409, "not_supported"], "Auth refuses it the same way");
    await stack.reconfigureAuth({ integrations: true });
    assert.equal((await (await state.ada.browser.api("/api/stations")).json()).stations[0].integrationsEnabled, true);
    const nudgesBefore = built.nudges.length;
    const ada = await create(state.ada.browser);
    assert.deepEqual([ada.status, ada.body.role, ada.body.state], [201, "owner", "awaiting_approval"]);
    state.adaFirst = ada.body;
    const bo = await create(state.bo.browser);
    assert.equal(bo.status, 201);
    state.boFirst = bo.body;
    const listed = await manage("GET", "/integrations?account=" + state.boId);
    assert.deepEqual(listed.body.integrations.map(({ clientId, owner, stationId }) => [clientId, owner, stationId]), [[state.boFirst.id, state.boId, built.id]]);
    assert.ok(await eventually(() => built.nudges.length > nudgesBefore), "a push hint reached the built-in Station's origin");
  });

  test("6. its feed lists every integration on it, each with its owner, and its reports are accepted", async () => {
    const token = (await built.reportToken()).body.access_token;
    const snapshot = await feed(0, token);
    assert.deepEqual(snapshot.body.integrations.map(({ id, ownerAccount }) => [id, ownerAccount]), [[state.adaFirst.id, state.adaId], [state.boFirst.id, state.boId]]);
    const reported = await json(await bearer(stack, "/api/v1/stations/reports", token, { method: "POST", json: { integrationId: state.adaFirst.id, state: "error", reason: "host offline" } }));
    assert.deepEqual([reported.status, reported.body.lastError], [200, "host offline"]);
    const unknown = await json(await bearer(stack, "/api/v1/stations/reports", token, { method: "POST", json: { integrationId: "i-" + "0".repeat(26), state: "error", reason: "x" } }));
    assert.equal(unknown.status, 404);
  });

  test("7. plan limits on it: Basic 4, Principal no cap, and a downgrade keeps the existing ones", async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await create(state.ada.browser)).status, 201);
    const limited = await create(state.ada.browser);
    assert.deepEqual([limited.status, limited.body.code, limited.body.error, limited.body.limit], [403, "plan_limit", PLAN_MESSAGE(4), 4]);
    await setPlan(state.adaId, { assignedPlan: "principal" });
    assert.equal((await create(state.ada.browser)).status, 201, "a Principal has no cap");
    await setPlan(state.adaId, { assignedPlan: null });
    const mine = (await (await state.ada.browser.api("/api/integrations")).json()).integrations.filter((entry) => entry.stationId === built.id);
    assert.equal(mine.length, 5, "all five are still there after the downgrade");
    const atAuth = (await manage("GET", "/integrations?account=" + state.adaId)).body.integrations.filter((entry) => entry.stationId === built.id);
    assert.ok(atAuth.every((entry) => entry.status === "active"), "and still active at Auth");
    assert.equal((await create(state.ada.browser)).status, 403, "new ones wait until the account is under the limit");
    for (const entry of mine.slice(1, 3)) assert.equal((await json(await state.ada.browser.api("/api/integrations/" + entry.id + "/revoke", { method: "POST", json: {} }))).status, 200);
    assert.equal((await create(state.ada.browser)).status, 201, "under the limit again");
  });

  test("8. an Agora.Build admin is just another account in the Portal: no views or actions on others' integrations", async () => {
    const cy = await portalSignIn(stack, person(7301, "Cy"));
    assert.equal((await meOf(cy.browser)).account.id, built.adminId);
    assert.deepEqual((await (await cy.browser.api("/api/integrations")).json()).integrations, [], "Cy owns none and sees nobody else's");
    for (const action of ["pause", "revoke"]) {
      const answer = await json(await cy.browser.api("/api/integrations/" + state.boFirst.id + "/" + action, { method: "POST", json: {} }));
      assert.equal(answer.status, 404, action);
    }
    const atAuth = await manage("PATCH", "/integrations/" + state.boFirst.id, { status: "paused", actor: built.adminId });
    assert.deepEqual([atAuth.status, atAuth.body.error], [403, "forbidden"], "Auth refuses the Portal acting for an admin across accounts");
    assert.equal((await manage("GET", "/integrations?account=" + state.boId)).body.integrations.find((entry) => entry.clientId === state.boFirst.id).status, "active");
    const refused = await manage("PATCH", "/integrations/" + state.adaFirst.id, { status: "paused", actor: state.boId });
    assert.deepEqual([refused.status, refused.body.error], [403, "forbidden"], "nor a non-admin pausing another's integration");
    for (const value of Object.values(stack.secrets)) assert.ok(!stack.logs.join("\n").includes(value), "no secret in the Portal log");
  });

  test("9. an admin's pause at Auth reaches the Portal's events and the Station's feed through Auth's nudge", { skip: d26Skip }, async () => {
    const id = state.boFirst.id;
    const token = (await built.reportToken()).body.access_token;
    const start = (await feed(0, token)).body.cursor;
    Object.assign(state, { feedStart: start, logStart: stack.logs.length });
    const pushes = built.nudges.length;
    const portalNudges = stack.portal.nudges;
    const paused = await stack.adminChange(id, { status: "paused", reason: "Spam in #general" });
    assert.deepEqual([paused.status, paused.pausedBy], ["paused", "admin"], "paused at Auth");
    // The Portal reads Auth's feed only on nudges here, and the Station's feed does not reconcile from Auth.
    const change = await eventually(async () => (await feed(start, token)).body.changes.find((entry) => entry.integrationId === id && entry.kind === "integration_paused"));
    assert.ok(change, "the Station's feed has the pause");
    assert.deepEqual([change.reason, change.integration.state], ["agora_build", "paused"]);
    assert.ok(stack.portal.nudges >= portalNudges + 1, "Auth's nudge reached the Portal");
    assert.ok(await eventually(() => built.nudges.length > pushes), "and the Station was pushed");
    const [recorded] = (await stack.portalQuery("SELECT actor, reason, details FROM integration_events WHERE integration_id = $1 AND kind = 'integration_paused' ORDER BY id DESC LIMIT 1", [id])).rows;
    assert.deepEqual([recorded.actor, recorded.reason, recorded.details.admin, recorded.details.pausedBy], [built.adminId, "Spam in #general", true, "admin"], "recorded with the admin as actor and the reason");
    assert.deepEqual(await auditAtAuth(id, "integration_paused"), [[state.boId, built.adminId]], "as Auth recorded it");
    const mine = (await (await state.bo.browser.api("/api/integrations")).json()).integrations.find((entry) => entry.id === id);
    assert.deepEqual([mine.state, mine.pausedBy], ["paused", "admin"]);
    const [latest] = (await (await state.bo.browser.api("/api/integrations/" + id + "/events")).json()).events;
    assert.deepEqual([latest.kind, latest.actor, latest.reason], ["integration_paused", "agora_build", null], "Bo sees Agora.Build, not the admin or the reason");
  });

  test("10. the owner cannot resume an admin's pause, in the Portal or at Auth; the admin's lift and revocation reach the Portal", { skip: d26Skip }, async () => {
    const id = state.boFirst.id;
    const resumed = await json(await state.bo.browser.api("/api/integrations/" + id + "/resume", { method: "POST", json: {} }));
    assert.deepEqual([resumed.status, resumed.body.code, resumed.body.error], [409, "admin_paused", ADMIN_PAUSED]);
    const atAuth = await manage("PATCH", "/integrations/" + id, { status: "active", actor: state.boId });
    assert.deepEqual([atAuth.status, atAuth.body.error], [409, "admin_paused"], "Auth holds the lock too");
    const token = (await built.reportToken()).body.access_token;
    const start = (await feed(0, token)).body.cursor;
    await stack.adminChange(id, { status: "active", reason: "Cleared after review" });
    const lift = await eventually(async () => (await feed(start, token)).body.changes.find((entry) => entry.integrationId === id && entry.kind === "integration_resumed"));
    assert.ok(lift, "the lift reaches the Station");
    assert.deepEqual([lift.reason, lift.state, lift.integration.state], ["agora_build", "awaiting_approval", "awaiting_approval"]);
    const back = (await (await state.bo.browser.api("/api/integrations")).json()).integrations.find((entry) => entry.id === id);
    assert.deepEqual([back.state, back.pausedBy], ["awaiting_approval", null]);
    await stack.adminChange(id, { status: "revoked", reason: "Confirmed abuse" });
    const revocation = await eventually(async () => (await feed(start, token)).body.changes.find((entry) => entry.integrationId === id && entry.kind === "integration_revoked"));
    assert.ok(revocation, "the revocation reaches the Station");
    assert.deepEqual([revocation.reason, revocation.state, revocation.integration.state], ["agora_build", "revoked", "revoked"], "never approved, so revoked at once");
    assert.equal((await stack.portalQuery("SELECT state FROM integrations WHERE id = $1", [id])).rows[0].state, "revoked");
    const rows = (await stack.portalQuery("SELECT kind, reason FROM integration_events WHERE integration_id = $1 AND actor = $2 ORDER BY id", [id, built.adminId])).rows;
    assert.deepEqual(rows.map((row) => [row.kind, row.reason]), [["integration_paused", "Spam in #general"], ["integration_resumed", "Cleared after review"], ["integration_revoked", "Confirmed abuse"]]);
  });

  test("11. the Station's feed, the owner's history and the Portal's log name neither the admin nor the reasons", { skip: d26Skip }, async () => {
    const token = (await built.reportToken()).body.access_token;
    const shown = [
      ["the Station's feed", JSON.stringify((await feed(0, token)).body) + JSON.stringify((await feed(state.feedStart, token)).body)],
      ["Bo's history", (await state.bo.browser.api("/api/integrations/" + state.boFirst.id + "/events")).text],
      ["the Portal's log", stack.logs.join("\n")]
    ];
    for (const [where, text] of shown) {
      assert.ok(!text.includes(built.adminId), where + " names the admin");
      for (const reason of REASONS) assert.ok(!text.includes(reason), where + " has the reason " + JSON.stringify(reason));
    }
  });

  test("12. an admin disabling an owner at Auth pauses its integrations at the Portal and the Station; enabling restores each", { skip: ownerSkip }, async () => {
    const fay = await portalSignIn(stack, person(7313, "Fay"));
    const fayId = (await meOf(fay.browser)).account.id;
    const live = await create(fay.browser, "Fay live");
    const held = await create(fay.browser, "Fay held");
    assert.deepEqual([live.status, held.status], [201, 201]);
    assert.equal((await json(await fay.browser.api("/api/integrations/" + held.body.id + "/pause", { method: "POST", json: {} }))).status, 200);
    const ids = [live.body.id, held.body.id];
    const token = (await built.reportToken()).body.access_token;
    const start = (await feed(0, token)).body.cursor;
    const portalNudges = stack.portal.nudges;
    await stack.adminAccount(fayId, { disabled: true, reason: "Account review" });
    const disabled = await eventually(async () => {
      const { changes } = (await feed(start, token)).body;
      const found = ids.map((id) => changes.find((entry) => entry.integrationId === id && entry.kind === "integration_owner_disabled"));
      return found.every(Boolean) && found;
    });
    assert.ok(disabled, "both reach the Station's feed, shown paused, as Agora.Build's");
    assert.deepEqual(disabled.map((entry) => [entry.reason, entry.state, entry.integration.state]), [["agora_build", "paused", "paused"], ["agora_build", "paused", "paused"]]);
    assert.ok(stack.portal.nudges >= portalNudges + 1, "Auth's nudge reached the Portal");
    // The Portal keeps each integration's own state under the flag, and records the admin and the reason.
    const flagged = (await stack.portalQuery("SELECT id, state, paused_by, owner_disabled_at IS NOT NULL AS disabled FROM integrations WHERE owner_account = $1 ORDER BY created_at, id", [fayId])).rows;
    assert.deepEqual(flagged.map((row) => [row.id, row.state, row.paused_by, row.disabled]), [[ids[0], "awaiting_approval", null, true], [ids[1], "paused", "owner", true]]);
    const recorded = (await stack.portalQuery("SELECT integration_id, actor, reason FROM integration_events WHERE kind = 'integration_owner_disabled' AND integration_id = ANY($1) ORDER BY integration_id", [ids])).rows;
    assert.deepEqual(recorded.map((row) => [row.actor, row.reason]), [[built.adminId, "Account review"], [built.adminId, "Account review"]]);
    // Disabling ended Fay's sessions (Auth's back-channel logout), so her resume is refused at the Portal, and at Auth.
    const resumed = await json(await fay.browser.api("/api/integrations/" + held.body.id + "/resume", { method: "POST", json: {} }));
    assert.equal(resumed.status, 401, "signed out");
    const atAuth = await manage("PATCH", "/integrations/" + held.body.id, { status: "active", actor: fayId });
    assert.deepEqual([atAuth.status, atAuth.body.error], [400, "invalid_request"], "Auth refuses a disabled actor");
    const middle = (await feed(start, token)).body.cursor;
    await stack.adminAccount(fayId, { disabled: false, reason: "Review done" });
    const enabled = await eventually(async () => {
      const { changes } = (await feed(middle, token)).body;
      const found = ids.map((id) => changes.find((entry) => entry.integrationId === id && entry.kind === "integration_owner_enabled"));
      return found.every(Boolean) && found;
    });
    assert.ok(enabled, "enabling reaches the Station's feed");
    assert.deepEqual(enabled.map((entry) => [entry.reason, entry.integration.state]), [["agora_build", "awaiting_approval"], ["agora_build", "paused"]], "each back as it was");
    assert.deepEqual((await stack.portalQuery("SELECT owner_disabled_at FROM integrations WHERE id = ANY($1)", [ids])).rows.map((row) => row.owner_disabled_at), [null, null]);
    const again = await portalSignIn(stack, person(7313, "Fay"));
    const mine = (await (await again.browser.api("/api/integrations")).json()).integrations.filter((entry) => ids.includes(entry.id));
    assert.deepEqual(mine.map((entry) => [entry.id, entry.state, entry.pausedBy]).sort(), [[ids[0], "awaiting_approval", null], [ids[1], "paused", "owner"]].sort(), "Fay sees each as it was");
    const history = (await again.browser.api("/api/integrations/" + held.body.id + "/events")).text;
    assert.deepEqual(JSON.parse(history).events.slice(0, 2).map((event) => [event.kind, event.actor, event.reason]), [["integration_owner_enabled", "agora_build", null], ["integration_owner_disabled", "agora_build", null]]);
    for (const text of [history, JSON.stringify((await feed(start, token)).body)]) assert.ok(!text.includes(built.adminId) && !text.includes("Account review") && !text.includes("Review done"), "neither the admin nor the reasons");
    const back = await json(await again.browser.api("/api/integrations/" + held.body.id + "/resume", { method: "POST", json: {} }));
    assert.deepEqual([back.status, back.body.state], [200, "awaiting_approval"], "her own pause is still hers to lift");
  });
});

describe("Admin changes reach the Portal by its poll when Auth's nudge is lost", { skip: skip || d26Skip || false }, () => {
  let lost;
  before(async () => {
    lib ??= await loadAuth();
    lost = await startStack(lib, { integrations: true, builtIn: { admin: person(7401, "Di") }, nudge: "lost", authChanges: { pollMs: 300, minGapMs: 50 } });
    await lost.reconfigureAuth({ integrations: true });
  });
  after(async () => { await lost?.close(); });

  test("an admin's pause at Auth reaches the Station's feed at the Portal's next poll", async () => {
    const { browser } = await portalSignIn(lost, person(7411, "Eve"));
    assert.equal((await browser.api("/api/stations")).status, 200);
    const created = await json(await browser.api("/api/integrations", { method: "POST", json: { stationId: lost.builtIn.id, name: "Polled", scopes: SCOPES, publicJwk: await publicJwk() } }));
    assert.equal(created.status, 201);
    const token = (await lost.builtIn.reportToken()).body.access_token;
    const read = async (cursor) => (await json(await bearer(lost, "/api/v1/stations/changes?cursor=" + cursor, token))).body;
    const start = (await read(0)).cursor;
    await lost.adminChange(created.body.id, { status: "paused", reason: "Spam" });
    const change = await eventually(async () => (await read(start)).changes.find((entry) => entry.integrationId === created.body.id && entry.kind === "integration_paused"), { timeout: 5000 });
    assert.ok(change, "the poll brought it, with the nudge lost");
    assert.deepEqual([change.reason, change.integration.state], ["agora_build", "paused"]);
    const [recorded] = (await lost.portalQuery("SELECT actor, reason FROM integration_events WHERE integration_id = $1 AND kind = 'integration_paused'", [created.body.id])).rows;
    assert.deepEqual([recorded.actor, recorded.reason], [lost.builtIn.adminId, "Spam"]);
    assert.equal(lost.portal.nudges, 0, "no nudge reached the Portal");
  });
});
