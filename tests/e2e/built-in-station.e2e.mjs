// End-to-end check of the built-in Station (spec §3.3.2, D24): the real Portal, the real auth.agora.build with a
// built-in Station in its clients file, and that Station's stub, over real HTTP(S). Run with `npm run test:e2e` on
// Node 22, with TEST_DATABASE_URL (Auth) and PORTAL_TEST_DATABASE_URL (the Portal) set. Not part of npm test.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeJwt, exportJWK, generateKeyPair } from "jose";
import { API, authRepo, bearer, eventually, integrationsSkipReason, loadAuth, person, portalSignIn, skipReason, startStack } from "./harness.mjs";

const skip = (await skipReason()) ?? (await integrationsSkipReason());
if (skip) console.log("# Skipping the built-in Station end-to-end suite: " + skip + ".");

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
    stack = await startStack(lib, { integrations: true, builtIn: { admin: person(7301, "Cy") } });
    built = stack.builtIn;
  });
  after(async () => { await stack?.close(); });

  // P-D1: the Portal syncs the built-in Station when its integration stack is ready, as the first PLATFORM_ADMINS
  // account, so the Station's report token works before anyone has signed in to the Portal.
  test("1. before anyone signs in to the Portal, the built-in Station's report token reads its feed", async () => {
    assert.equal((await stack.store.snapshot()).accounts.length, 0, "nobody has signed in to the Portal yet");
    const issued = await built.reportToken();
    assert.equal(issued.status, 200);
    const first = await feed(0, issued.body.access_token);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.integrations, []);
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

  test("8. Agora.Build admins pause and revoke others' integrations on it; nobody else sees them", async () => {
    const cy = await portalSignIn(stack, person(7301, "Cy"));
    assert.equal((await meOf(cy.browser)).account.id, built.adminId);
    const seen = (await (await cy.browser.api("/api/integrations")).json()).integrations;
    assert.ok(seen.some((entry) => entry.id === state.boFirst.id && entry.role === "station_admin"));
    assert.ok(seen.every((entry) => entry.role === "station_admin"));
    const bosView = (await (await state.bo.browser.api("/api/integrations")).json()).integrations;
    assert.ok(bosView.length > 0 && bosView.every((entry) => entry.role === "owner"), "Bo sees only his own");
    const nudgesBefore = built.nudges.length;
    const paused = await json(await cy.browser.api("/api/integrations/" + state.boFirst.id + "/pause", { method: "POST", json: {} }));
    assert.deepEqual([paused.status, paused.body.state, paused.body.role], [200, "paused", "station_admin"]);
    assert.equal((await manage("GET", "/integrations?account=" + state.boId)).body.integrations.find((entry) => entry.clientId === state.boFirst.id).status, "paused", "paused at Auth");
    assert.deepEqual(await auditAtAuth(state.boFirst.id, "integration_paused"), [[state.boId, built.adminId]], "Auth recorded the admin as the actor on Bo's integration");
    assert.equal((await cy.browser.api("/api/integrations/" + state.boFirst.id + "/resume", { method: "POST", json: {} })).status, 403, "only the owner resumes");
    const refused = await manage("PATCH", "/integrations/" + state.adaFirst.id, { status: "paused", actor: state.boId });
    assert.deepEqual([refused.status, refused.body.error], [403, "forbidden"], "Auth refuses a non-admin pausing another's integration");
    const refusedRevoke = await manage("PATCH", "/integrations/" + state.adaFirst.id, { status: "revoked", actor: state.boId });
    assert.deepEqual([refusedRevoke.status, refusedRevoke.body.error], [403, "forbidden"], "and revoking it");
    const revoked = await json(await cy.browser.api("/api/integrations/" + state.adaFirst.id + "/revoke", { method: "POST", json: {} }));
    assert.deepEqual([revoked.status, revoked.body.state], [200, "revoked"]);
    assert.equal((await manage("GET", "/integrations?account=" + state.adaId)).body.integrations.find((entry) => entry.clientId === state.adaFirst.id).status, "revoked", "revoked at Auth");
    assert.deepEqual(await auditAtAuth(state.adaFirst.id, "integration_revoked"), [[state.adaId, built.adminId]], "Auth recorded the admin as the actor on Ada's integration");
    assert.equal((await state.bo.browser.api("/api/integrations/" + state.adaFirst.id + "/pause", { method: "POST", json: {} })).status, 404, "an ordinary account can't find another's integration");
    assert.ok(await eventually(() => built.nudges.length > nudgesBefore), "the changes were pushed to the Station");
    for (const value of Object.values(stack.secrets)) assert.ok(!stack.logs.join("\n").includes(value), "no secret in the Portal log");
  });
});
