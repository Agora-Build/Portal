// End-to-end check of Stations and integrations: the real Portal, the real auth.agora.build and a Station stub, over
// real HTTP(S). The stub verifies Auth's tokens with Auth's own reference verifier (scripts/verify-station-token.mjs),
// exactly as a Station would. Run with `npm run test:e2e` on Node 22, with TEST_DATABASE_URL (Auth) and
// PORTAL_TEST_DATABASE_URL (the Portal) set. Not part of npm test.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { API, authRepo, bearer, eventually, integrationsSkipReason, interactionUid, loadAuth, person, portalSignIn, skipReason, startStack, STATION_HOST, stationTls } from "./harness.mjs";

const skip = (await skipReason()) ?? (await integrationsSkipReason());
if (skip) console.log("# Skipping the Stations and integrations end-to-end suite: " + skip + ".");

const ACCOUNT_ID = /^ab[0-9A-HJKMNP-TV-Z]{26}$/;
const SCOPES = ["agent.view", "agent.prompt"];
let lib;
let reference;
let stack;
let station;
const tokensSeen = new Set();
// Shared across the flows, in order.
const state = {};

const json = async (response) => ({ status: response.status, body: await response.json() });
const meOf = async (browser) => (await browser.api("/api/me")).json();
const remember = (body) => {
  for (const name of ["access_token", "id_token", "refresh_token", "accessToken"]) if (body?.[name]) tokensSeen.add(body[name]);
  return body;
};

// Nothing the Portal logged carries a secret or a token (global constraints: reasons only).
function assertNothingSecretLogged() {
  const text = stack.logs.join("\n");
  for (const value of [...Object.values(stack.secrets), ...tokensSeen].filter(Boolean)) assert.ok(!text.includes(value), "the Portal log contains a secret or token");
}

// Auth's management API, as the Portal calls it (HTTP Basic with the Portal client).
const manage = (path) => fetch(stack.issuer + "/manage/v1" + path, {
  headers: { Authorization: "Basic " + Buffer.from("portal:" + encodeURIComponent(stack.secrets.PORTAL_CLIENT_SECRET)).toString("base64"), Accept: "application/json" }
}).then(json);

// A client-credentials token with private_key_jwt (docs/integrating.md: the client assertion), as a Station report
// client or an integration asks for one.
async function clientCredentials({ clientId, privateKey, resource, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setIssuer(clientId).setSubject(clientId)
    .setAudience(stack.issuer + "/token").setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + 60).sign(privateKey);
  const response = await fetch(stack.issuer + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", resource, scope, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion }).toString()
  });
  return { status: response.status, body: remember(await response.json()) };
}

// The native "astation" app: device authorization approved by the person in their browser, then one token poll.
async function astationTokens(browser, user) {
  const astation = await lib.relyingParty(stack.idp, "astation");
  const device = await lib.oidc.initiateDeviceAuthorization(astation, { scope: "openid integrations:read integrations:approve", resource: API });
  const entry = await browser.request("/device");
  const confirm = await browser.request("/device", { form: { xsrf: lib.xsrfOf(entry.text), user_code: device.user_code } });
  assert.match(confirm.text, /Approve Astation\?/);
  let page = await browser.follow("/device", { form: { xsrf: lib.xsrfOf(confirm.text), user_code: device.user_code, confirm: "yes" } });
  if (/Continue with GitHub/.test(page.text)) {
    const start = await browser.request("/interaction/" + interactionUid(page.url) + "/upstream/github", { form: {} });
    page = await browser.follow(stack.idp.fake.approve(start.location, user));
  }
  assert.match(page.text, /signed in to Astation on your device/);
  const response = await fetch(stack.issuer + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: "astation" }).toString() });
  assert.equal(response.status, 200, "the first poll after approval gets the tokens");
  return remember(await response.json());
}

// Auth's own answer to the Portal's token exchange (RFC 8693) for `browser`'s person: an ID token for the Portal client
// from a fresh authorization (the IdP session is live, so no sign-in page), exchanged for a station.read token.
async function exchangeAtAuth(browser) {
  const rp = await lib.relyingParty(stack.idp, "portal", stack.secrets.PORTAL_CLIENT_SECRET);
  const redirectUri = stack.site + "/auth/callback";
  const started = await lib.startAuthorization(rp, { redirectUri, scope: "openid" });
  const page = await browser.follow(started.url);
  assert.ok(page.location?.startsWith(redirectUri + "?"), "the IdP answers with a code at once");
  const tokens = remember(await lib.finishAuthorization(rp, page.location, started));
  const response = await fetch(stack.issuer + "/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from("portal:" + encodeURIComponent(stack.secrets.PORTAL_CLIENT_SECRET)).toString("base64"), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: tokens.id_token, subject_token_type: "urn:ietf:params:oauth:token-type:id_token", resource: station.origin, scope: "station.read" }).toString()
  });
  return { status: response.status, body: remember(await response.json()) };
}

// The Station stub: https://station.test:<port> on 127.0.0.1 with the test certificate. It serves the proof value it is
// given, records change nudges, holds its own ES256 report key and checks tokens with Auth's reference verifier.
async function startStation() {
  const reportKeys = await generateKeyPair("ES256");
  const nudges = [];
  let proof = null;
  const server = createServer(stationTls(), (request, response) => {
    if (request.method === "GET" && request.url === "/.well-known/agora-build-station" && proof !== null) {
      response.writeHead(200, { "Content-Type": "text/plain" }).end(proof);
      return;
    }
    if (request.method === "POST" && request.url === "/agora-build/v1/changes") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        nudges.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(202).end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = "https://" + STATION_HOST + ":" + server.address().port;
  const verifier = reference.createStationVerifier({ issuer: stack.issuer, origin });
  const stub = {
    origin, nudges, reportClientId: null,
    reportJwk: await exportJWK(reportKeys.publicKey),
    serve(value) { proof = value; },
    // Its station.report token for the Portal (or, to test Auth, for another resource).
    reportToken: ({ resource = API, scope = "station.report" } = {}) => clientCredentials({ clientId: stub.reportClientId, privateKey: reportKeys.privateKey, resource, scope }),
    verify: (token, options) => verifier.verify(token, options),
    // The verifier's verdict as { status, error } for a refused token.
    async refusal(token, options) {
      try { await verifier.verify(token, options); } catch (error) {
        if (error instanceof reference.StationTokenError) return { status: error.status, error: error.error };
        throw error;
      }
      return null;
    },
    close: () => new Promise((done) => { server.close(done); server.closeAllConnections(); })
  };
  return stub;
}

// An ES256 integration key pair; the Portal and Auth only see the public JWK.
async function integrationKey() {
  const keys = await generateKeyPair("ES256");
  return { privateKey: keys.privateKey, publicJwk: await exportJWK(keys.publicKey) };
}
const integrationToken = (scope = SCOPES.join(" ")) => clientCredentials({ clientId: state.integration.id, privateKey: state.integrationKeys.privateKey, resource: station.origin, scope });
// The R9 service fingerprint of a P-256 key (station-tokens.md A8): SHA-256 of the 65-byte uncompressed point.
function r9Fingerprint() {
  const { x, y } = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return reference.r9ServiceFingerprint("p256", Buffer.concat([Buffer.from([4]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]));
}
const feed = async (cursor, token) => json(await bearer(stack, "/api/v1/stations/changes?cursor=" + cursor, token));
const report = async (token, body) => json(await bearer(stack, "/api/v1/stations/reports", token, { method: "POST", json: body }));
const integrationIn = async (browser) => (await (await browser.api("/api/integrations")).json()).integrations.find((entry) => entry.id === state.integration.id);

describe("Stations and integrations against the real auth.agora.build", { skip: skip || false }, () => {
  before(async () => {
    lib = await loadAuth();
    reference = await import(pathToFileURL(resolve(authRepo, "scripts/verify-station-token.mjs")).href);
    stack = await startStack(lib, { integrations: true });
    station = await startStation();
  });
  after(async () => {
    await station?.close();
    await stack?.close();
  });

  test("1. a person proves control of a Station and registers it; Portal and Auth both list it", async () => {
    state.owner = await portalSignIn(stack, person(7101, "Ada"));
    const me = await meOf(state.owner.browser);
    assert.match(me.account.id, ACCOUNT_ID);
    assert.equal(me.integrationsAvailable, true);
    state.ownerId = me.account.id;
    const challenge = async () => {
      const issued = await json(await state.owner.browser.api("/api/stations/challenges", { method: "POST", json: { origin: station.origin } }));
      assert.equal(issued.status, 201);
      assert.equal(issued.body.url, station.origin + "/.well-known/agora-build-station");
      return issued.body;
    };
    const register = (issued) => state.owner.browser.api("/api/stations", { method: "POST", json: { challengeId: issued.challengeId, reportKey: station.reportJwk } }).then(json);

    station.serve("not-the-value");
    const wrong = await register(await challenge());
    assert.deepEqual([wrong.status, wrong.body.code, wrong.body.reason], [422, "proof", "mismatch"], "the Portal fetched the stub over TLS and compared its answer");

    const issued = await challenge();
    station.serve(issued.value + "\n");
    const registered = await register(issued);
    assert.equal(registered.status, 201);
    assert.equal(registered.body.origin, station.origin);
    assert.equal(registered.body.role, "owner");
    assert.match(registered.body.reportClientId, /^s-[0-9a-hjkmnp-tv-z]{26}$/);
    state.station = registered.body;
    station.reportClientId = registered.body.reportClientId;
    assert.equal((await register(issued)).status, 400, "a check value is single-use");

    const listed = await (await state.owner.browser.api("/api/stations")).json();
    assert.equal(listed.stale, false, "the list came from Auth");
    assert.deepEqual(listed.stations.map((entry) => [entry.id, entry.origin, entry.role]), [[state.station.id, station.origin, "owner"]]);
    const inAuth = await manage("/stations?account=" + state.ownerId);
    assert.equal(inAuth.status, 200);
    assert.deepEqual(inAuth.body.stations.map(({ id, origin, owner, status, reportClientId }) => ({ id, origin, owner, status, reportClientId })), [{ id: state.station.id, origin: station.origin, owner: state.ownerId, status: "active", reportClientId: station.reportClientId }]);
    assertNothingSecretLogged();
  });

  test("2. the Station's own station.report token reads its change feed; other tokens are refused", async () => {
    const issued = await station.reportToken();
    assert.equal(issued.status, 200, "Auth issues the report token: " + issued.body.error);
    const claims = decodeJwt(issued.body.access_token);
    assert.deepEqual([claims.aud, claims.client_id, claims.scope], [API, station.reportClientId, "station.report"]);
    state.reportToken = issued.body.access_token;

    const snapshot = await feed(0, state.reportToken);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(snapshot.body.integrations, [], "no integrations yet");
    assert.ok(snapshot.body.changes.some((change) => change.kind === "station_registered"));
    assert.equal(snapshot.body.cursor, snapshot.body.changes.at(-1).id);

    // Auth only gives a report client tokens for the Portal (station-tokens.md: never for a Station).
    const forStation = await station.reportToken({ resource: station.origin });
    assert.ok(forStation.status >= 400 && !forStation.body.access_token, "Auth refuses a report token for the Station itself");
    state.reportForStation = { status: forStation.status, error: forStation.body.error };
    const otherScope = await station.reportToken({ scope: "credits" });
    assert.ok(otherScope.status >= 400 && !otherScope.body.access_token, "Auth gives a report client no other scope");

    // A signed-in person's token for the Portal API: right audience, wrong scope and client.
    state.astation = await astationTokens(state.owner.browser, person(7101, "Ada"));
    const personFeed = await bearer(stack, "/api/v1/stations/changes?cursor=0", state.astation.access_token);
    assert.equal(personFeed.status, 403);
    assert.match(personFeed.headers.get("www-authenticate"), /insufficient_scope", scope="station\.report"/);
    // The other direction: a Portal-audience token is never accepted by a Station (A5, aud is not the Station).
    for (const [token, scope] of [[state.reportToken, "station.read"], [state.reportToken, "station.report"], [state.astation.access_token, "station.read"], [state.astation.access_token, "integrations:read"]]) {
      assert.deepEqual(await station.refusal(token, { scope }), { status: 401, error: "invalid_token" }, "the Station refuses a Portal token");
    }
    assertNothingSecretLogged();
  });

  test("3. a new integration awaits approval, and Auth refuses it a token until then", async () => {
    state.integrationKeys = await integrationKey();
    const before = station.nudges.length;
    const created = await json(await state.owner.browser.api("/api/integrations", { method: "POST", json: { stationId: state.station.id, name: "E2E app", scopes: SCOPES, publicJwk: state.integrationKeys.publicJwk } }));
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^i-[0-9a-hjkmnp-tv-z]{26}$/);
    assert.equal(created.body.state, "awaiting_approval");
    assert.deepEqual(created.body.scopes, SCOPES);
    state.integration = created.body;
    assert.ok(await eventually(() => station.nudges.length > before), "the Station is nudged about the new integration");
    // Before approval the Station can bind the integration to its owner only through its authenticated feed.
    const snapshot = await feed(0, state.reportToken);
    assert.equal(snapshot.body.integrations.find((entry) => entry.id === state.integration.id)?.ownerAccount, state.ownerId, "the feed names the integration's owner");

    // Auth issues no integration token before a native manager approves it (its R9 service fingerprint recorded).
    const refused = await integrationToken();
    assert.deepEqual([refused.status, refused.body.error, refused.body.access_token], [400, "unauthorized_client", undefined], "Auth refuses an integration token before approval");
    assertNothingSecretLogged();
  });

  test("4. a native integrations:approve token approves with an R9 service key; the next integration token carries it", async () => {
    const listed = await json(await bearer(stack, "/api/v1/integrations", state.astation.access_token));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.integrations.find((entry) => entry.id === state.integration.id)?.state, "awaiting_approval");

    state.r9Svc = r9Fingerprint();
    const approved = await json(await bearer(stack, "/api/v1/integrations/" + state.integration.id + "/approval", state.astation.access_token, { method: "POST", json: { r9Svc: state.r9Svc } }));
    assert.equal(approved.status, 200);
    assert.deepEqual([approved.body.state, approved.body.r9Svc], ["provisioning", state.r9Svc]);
    const inAuth = await manage("/integrations?account=" + state.ownerId);
    assert.equal(inAuth.body.integrations.find((entry) => entry.clientId === state.integration.id)?.r9Svc, state.r9Svc, "Auth stored the fingerprint");

    const issued = await integrationToken();
    assert.equal(issued.status, 200);
    const token = issued.body.access_token;
    assert.equal(decodeJwt(token).r9_svc, state.r9Svc);
    assert.deepEqual(await station.verify(token, { scope: "agent.prompt", r9Svc: state.r9Svc }), { sub: state.ownerId, clientId: state.integration.id, scopes: SCOPES });
    assert.deepEqual(await station.refusal(token, { scope: "agent.prompt", r9Svc: r9Fingerprint() }), { status: 401, error: "invalid_token" }, "another R9 key fails");
    assert.deepEqual(await station.refusal(token, { scope: "agent.terminal", r9Svc: state.r9Svc }), { status: 403, error: "insufficient_scope" }, "a scope that was not granted");
    assert.deepEqual(decodeJwt(token).sub, state.ownerId);
    const atPortal = await bearer(stack, "/api/v1/integrations", token);
    assert.equal(atPortal.status, 401, "a Station token is not a Portal token (wrong audience)");
    assert.match(atPortal.headers.get("www-authenticate"), /invalid_token/);
    assert.equal((await feed(0, token)).status, 401);

    const noScope = await json(await bearer(stack, "/api/v1/integrations/" + state.integration.id + "/approval", state.reportToken, { method: "POST", json: { r9Svc: state.r9Svc } }));
    assert.equal(noScope.status, 403, "a report token cannot approve");
    assertNothingSecretLogged();
  });

  test("5. the Station reports ready and the Portal shows it; a report about an unknown integration is 404", async () => {
    assert.equal((await integrationIn(state.owner.browser)).state, "provisioning", "the Portal never sets Ready itself");
    const waiting = await report(state.reportToken, { integrationId: state.integration.id, state: "waiting_for_host" });
    assert.deepEqual([waiting.status, waiting.body.state], [200, "waiting_for_host"]);
    const ready = await report(state.reportToken, { integrationId: state.integration.id, state: "ready" });
    assert.deepEqual([ready.status, ready.body.state], [200, "ready"]);
    assert.equal((await integrationIn(state.owner.browser)).state, "ready");
    const unknown = await report(state.reportToken, { integrationId: "i-" + "0".repeat(26), state: "ready" });
    assert.equal(unknown.status, 404);
    assert.equal((await report(state.astation.access_token, { integrationId: state.integration.id, state: "ready" })).status, 403, "only a Station report token reports");
    assertNothingSecretLogged();
  });

  test("6. pausing and revoking in the browser nudge the Station, show in its feed and stop Auth's tokens", async (t) => {
    let cursor = (await feed(0, state.reportToken)).body.cursor;
    // One browser action: the Station is nudged with a newer cursor and finds the change in its feed.
    async function act(action, expected) {
      const before = station.nudges.length;
      const answer = await json(await state.owner.browser.api("/api/integrations/" + state.integration.id + "/" + action, { method: "POST", json: {} }));
      assert.deepEqual([answer.status, answer.body.state], [200, expected], action);
      assert.ok(await eventually(() => station.nudges.slice(before).some((nudge) => nudge.cursor > cursor)), "the Station is nudged after " + action);
      const changes = await feed(cursor, state.reportToken);
      assert.equal(changes.status, 200);
      const change = changes.body.changes.find((entry) => entry.integrationId === state.integration.id);
      cursor = changes.body.cursor;
      return change;
    }

    const paused = await act("pause", "paused");
    assert.deepEqual([paused.kind, paused.integration.state], ["integration_paused", "paused"]);
    const refusedPaused = await integrationToken();
    assert.ok(refusedPaused.status >= 400 && !refusedPaused.body.access_token, "Auth refuses a paused integration");
    state.pausedAnswer = { status: refusedPaused.status, error: refusedPaused.body.error };

    const resumed = await act("resume", "ready");
    assert.equal(resumed.kind, "integration_resumed");
    assert.equal((await integrationToken()).status, 200, "a resumed integration gets tokens again");

    const revoked = await act("revoke", "revoking");
    assert.deepEqual([revoked.kind, revoked.integration.state], ["integration_revoked", "revoking"]);
    const refusedRevoked = await integrationToken();
    assert.ok(refusedRevoked.status >= 400 && !refusedRevoked.body.access_token, "Auth refuses a revoked integration");
    state.revokedAnswer = { status: refusedRevoked.status, error: refusedRevoked.body.error };
    const done = await report(state.reportToken, { integrationId: state.integration.id, state: "revoked" });
    assert.deepEqual([done.status, done.body.state], [200, "revoked"], "the Station confirms it has stopped");
    assert.equal((await integrationIn(state.owner.browser)).state, "revoked");
    const inAuth = await manage("/integrations?account=" + state.ownerId);
    assert.equal(inAuth.body.integrations.find((entry) => entry.clientId === state.integration.id)?.status, "revoked");
    t.diagnostic("Auth's answers to a stopped integration: paused " + JSON.stringify(state.pausedAnswer) + ", revoked " + JSON.stringify(state.revokedAnswer) + "; a report token for the Station " + JSON.stringify(state.reportForStation) + ".");
    assertNothingSecretLogged();
  });

  test("7. the browser's read token for the Station is a station.read token the Station accepts; others get 404", async () => {
    const read = await json(await state.owner.browser.api("/api/stations/" + state.station.id + "/read-token", { method: "POST", json: {} }));
    assert.equal(read.status, 200);
    remember(read.body);
    assert.equal(read.body.origin, station.origin);
    assert.ok(read.body.expiresIn > 0 && read.body.expiresIn <= 300);
    assert.deepEqual(await station.verify(read.body.accessToken, { scope: "station.read" }), { sub: state.ownerId, clientId: "portal", scopes: ["station.read"] });
    assert.deepEqual(await station.refusal(read.body.accessToken, { scope: "astation.remote" }), { status: 403, error: "insufficient_scope" });

    state.second = await portalSignIn(stack, person(7102, "Bo"));
    state.secondId = (await meOf(state.second.browser)).account.id;
    const stranger = await state.second.browser.api("/api/stations/" + state.station.id + "/read-token", { method: "POST", json: {} });
    assert.equal(stranger.status, 404, "an account that is neither owner nor member learns nothing");
    assert.deepEqual((await (await state.second.browser.api("/api/stations")).json()).stations, []);
    assertNothingSecretLogged();
  });

  test("8. sharing lets a second person read the Station; unsharing stops it, at the Portal and at Auth", async (t) => {
    const before = station.nudges.length;
    const shared = await json(await state.owner.browser.api("/api/stations/" + state.station.id + "/members/" + state.secondId, { method: "PUT" }));
    assert.deepEqual([shared.status, shared.body], [200, { shared: true }]);
    assert.ok(await eventually(() => station.nudges.length > before), "the Station is nudged about the new member");
    const members = await manage("/stations/" + state.station.id + "/members?actor=" + state.ownerId);
    assert.deepEqual(members.body.members.map((entry) => entry.account), [state.secondId], "Auth has the member");
    const asMember = (await (await state.second.browser.api("/api/stations")).json()).stations;
    assert.deepEqual(asMember.map((entry) => [entry.id, entry.role, entry.reportClientId]), [[state.station.id, "member", undefined]]);

    const read = await json(await state.second.browser.api("/api/stations/" + state.station.id + "/read-token", { method: "POST", json: {} }));
    assert.equal(read.status, 200);
    remember(read.body);
    assert.deepEqual(await station.verify(read.body.accessToken, { scope: "station.read" }), { sub: state.secondId, clientId: "portal", scopes: ["station.read"] });
    const direct = await exchangeAtAuth(state.second.browser);
    assert.equal(direct.status, 200, "Auth exchanges a member's ID token: " + direct.body.error);
    assert.equal((await station.verify(direct.body.access_token, { scope: "station.read" })).sub, state.secondId);

    const unshared = await json(await state.owner.browser.api("/api/stations/" + state.station.id + "/members/" + state.secondId, { method: "DELETE" }));
    assert.deepEqual([unshared.status, unshared.body], [200, { unshared: true }]);
    assert.deepEqual((await manage("/stations/" + state.station.id + "/members?actor=" + state.ownerId)).body.members, []);
    assert.equal((await state.second.browser.api("/api/stations/" + state.station.id + "/read-token", { method: "POST", json: {} })).status, 404);
    assert.deepEqual((await (await state.second.browser.api("/api/stations")).json()).stations, []);
    // Auth itself no longer issues the former member a station.read token (the Portal's 404 comes before asking it).
    const refused = await exchangeAtAuth(state.second.browser);
    assert.ok(refused.status >= 400 && !refused.body.access_token, "Auth refuses the exchange for a former member");
    t.diagnostic("Auth's answer to an exchange for a former member: " + JSON.stringify({ status: refused.status, error: refused.body.error }) + ".");
    assertNothingSecretLogged();
  });
});
