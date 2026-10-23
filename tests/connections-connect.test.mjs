// Connecting Agora Console from a signed-in account (spec §3.4), against stand-in auth.agora.build and Agora SSO.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createAppServer } from "../scripts/serve.mjs";
import { createStore } from "../scripts/store.mjs";
import { createConnections, connectionsConfig, mapName, mapProjects } from "../scripts/connections.mjs";
import { modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { createSignaling, signalingConfig } from "../scripts/spaces/signaling.mjs";
import { createIdp } from "../scripts/idp.mjs";
import { createFakeIdp } from "./helpers/fake-idp.mjs";
import { createFakeAgora, listShapes } from "./helpers/fake-agora.mjs";
import { describeShape, probeShapes } from "../scripts/agora-shapes.mjs";
import { decodeToken, verifyTokenSignature } from "../scripts/atem-core.mjs";

const root = new URL("../", import.meta.url).pathname;
const issuer = "https://auth.example";
const clientSecret = "portal-connect-test-secret-".padEnd(48, "x");
const siteUrl = "http://localhost:3080";
const env = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACES_SIGNALING_SECRET: "s".repeat(32) };
const models = { config: modelConfig({}), chat: async () => "", speak: async () => Buffer.from(""), research: async () => ({ items: [] }), search: async (people) => people };
let temporary;
before(async () => { temporary = await mkdtemp(resolve(tmpdir(), "connect-agora-")); });
after(() => rm(temporary, { recursive: true, force: true }));

const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });
async function start(t, { agoraEnv = {}, site = siteUrl, agoraOptions } = {}) {
  const fake = await createFakeIdp({ issuer, clientId: "portal", clientSecret });
  const agora = createFakeAgora(agoraOptions);
  const idp = createIdp({ issuer, clientId: "portal", clientSecret, siteUrl: site, request: fake.request });
  const store = createStore(resolve(root, "data/people.json"), resolve(temporary, randomBytes(8).toString("hex") + ".json"), { log: () => {} });
  const logs = [];
  const connections = createConnections(store, connectionsConfig(agora.env({ SITE_URL: site, ...agoraEnv })), { request: agora.request, log: (line) => logs.push(line) });
  const instance = createAppServer(root, {
    monitor: false, store, idp, siteUrl: site, billingClients: null, log: (line) => logs.push(line), connections,
    models, calls: createAgoraCalls(agoraConfig(env)), signaling: createSignaling(signalingConfig(env)), channelSecret: env.SPACES_SIGNALING_SECRET
  });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  t.after(() => close(instance));
  return { fake, agora, store, logs, base: "http://127.0.0.1:" + instance.address().port };
}
const call = (base, path, { cookie, bearer, method = "GET", data, headers = {} } = {}) => fetch(base + path, {
  method, redirect: "manual",
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: "Bearer " + bearer } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
  ...(data !== undefined ? { body: JSON.stringify(data) } : {})
});
const cookieNamed = (response, name) => response.headers.getSetCookie().find((line) => line.startsWith(name + "="));
const pair = (line) => line.split(";")[0];
const join = (...parts) => parts.filter(Boolean).join("; ");

async function signIn(app, prefix = "") {
  const sub = app.fake.accountId();
  const login = await call(app.base, "/auth/login?returnTo=%2Faccount%2F");
  const callback = new URL(app.fake.authorize(login.headers.get("location"), { sub }));
  const back = await call(app.base, callback.pathname + callback.search, { cookie: pair(cookieNamed(login, prefix + "portal_auth")) });
  return { sub, cookie: pair(cookieNamed(back, prefix + "house_session")) };
}
// GET /connect/agora, Agora's consent page, then the callback, as a browser would.
async function connect(app, session, { error, callbackCookie } = {}) {
  const begun = await call(app.base, "/connect/agora", { cookie: session.cookie });
  assert.equal(begun.status, 303);
  const transaction = cookieNamed(begun, "portal_connect");
  assert.ok(transaction, "the connect start sets its own transaction cookie");
  const callback = new URL(app.agora.authorize(begun.headers.get("location"), { error }));
  const back = await call(app.base, callback.pathname + callback.search, { cookie: join(pair(transaction), callbackCookie ?? session.cookie) });
  return { begun, transaction, back, callback, location: back.headers.get("location"), code: callback.searchParams.get("code") };
}
const account = async (app, sub) => (await app.store.snapshot()).accounts.find((entry) => entry.id === sub);
const assertCleared = (response, label) => assert.match(cookieNamed(response, "portal_connect") || "", /^portal_connect=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/, label);

test("a signed-in account connects Agora Console; the tokens are stored sealed and the account is unchanged", async (t) => {
  const app = await start(t);
  const session = await signIn(app);
  const accountsBefore = (await app.store.snapshot()).accounts.length;
  const begun = await call(app.base, "/connect/agora", { cookie: session.cookie });
  assert.equal(begun.status, 303);
  const location = new URL(begun.headers.get("location"));
  assert.equal(location.origin + location.pathname, app.agora.base + "/api/v0/oauth/authorize");
  assert.equal(location.searchParams.get("redirect_uri"), siteUrl + "/connect/agora/callback");
  assert.equal(location.searchParams.get("scope"), "basic_info,console");
  assert.ok(!location.searchParams.has("code_challenge") && !location.searchParams.has("code_challenge_method"), "no PKCE: Agora refuses it for confidential clients");
  assert.equal(location.searchParams.get("client_id"), app.agora.clientId);
  assert.ok(!location.searchParams.has("client_secret"));
  const cookie = cookieNamed(begun, "portal_connect");
  assert.match(cookie, /^portal_connect=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
  assert.equal(cookieNamed(begun, "portal_auth"), undefined, "a sign-in transaction is left alone");
  const [saved] = (await app.store.snapshot()).authTransactions;
  assert.equal(saved.kind, "agora-connect");
  assert.equal(saved.accountId, session.sub);
  assert.ok(!JSON.stringify(saved).includes(pair(cookie).slice("portal_connect=".length)), "the transaction ID is stored hashed");

  const callback = new URL(app.agora.authorize(begun.headers.get("location")));
  const back = await call(app.base, callback.pathname + callback.search, { cookie: join(pair(cookie), session.cookie) });
  assert.equal(back.status, 303);
  assert.equal(back.headers.get("location"), "/account/?connected=agora");
  assertCleared(back, "success");
  assert.equal(cookieNamed(back, "house_session"), undefined, "connecting is not signing in");

  const snapshot = await app.store.snapshot();
  assert.equal(snapshot.accounts.length, accountsBefore, "Agora's identity creates no account");
  assert.equal(snapshot.authTransactions.length, 0, "the transaction is consumed");
  const sealed = (await account(app, session.sub)).connections.agora;
  assert.deepEqual(Object.keys(sealed).sort(), ["ciphertext", "iv", "tag"]);
  const text = JSON.stringify(snapshot);
  for (const secret of app.agora.issued) assert.ok(!text.includes(secret), "no Agora token in the store");
  assert.ok(!text.includes("Agora Builder"), "the Agora account name is sealed with the tokens");
  const status = await (await call(app.base, "/api/connections", { cookie: session.cookie })).json();
  assert.deepEqual(status.agora, { ready: true, connect: true, connected: true, name: "Agora Builder", reconnect: false });
  assert.ok(app.agora.calls.includes("GET /api/v0/customer/company/basic-info"), "the name comes from the company basic info");
  const projects = await (await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie })).json();
  assert.deepEqual(projects.projects, [{ projectId: "vendor-1", name: "Private project", appId: "agora-app-id", status: "1", createdAt: "2023-11-14T22:13:20.000Z" }]);
  assert.equal(app.agora.counts.bffProjects, 1, "projects come from the BFF's GET /api/cli/v1/projects");
  assert.ok(!app.agora.calls.some((line) => /\/api\/v0\/(customer\/)?project/.test(line)), "sso2's project paths are not used");
  const logged = app.logs.join("\n");
  assert.ok(!logged.includes(callback.searchParams.get("code")) && !logged.includes("agora-access-") && !logged.includes("agora-refresh-"), "no code or token in the log");
});

test("over https the connect cookie is __Host- prefixed and Secure", async (t) => {
  const app = await start(t, { site: "https://portal.example" });
  const session = await signIn(app, "__Host-");
  const response = await call(app.base, "/connect/agora", { cookie: session.cookie });
  assert.equal(response.status, 303);
  assert.match(cookieNamed(response, "__Host-portal_connect"), /^__Host-portal_connect=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600; Secure$/);
  assert.equal(new URL(response.headers.get("location")).searchParams.get("redirect_uri"), "https://portal.example/connect/agora/callback");
});

test("a guest, a visitor without a session and a bearer token can't start a connect", async (t) => {
  const app = await start(t);
  const joined = await call(app.base, "/api/profile", { method: "POST", data: { name: "Guest builder", bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent.", lookingFor: "Audio engineers", skills: ["Rust"], location: "Remote", contact: "https://example.com/builder", monitor: false } });
  assert.equal(joined.status, 201);
  const guest = pair(cookieNamed(joined, "house_session"));
  for (const [label, cookie] of [["guest", guest], ["no session", undefined]]) {
    const response = await call(app.base, "/connect/agora", { cookie });
    assert.equal(response.status, 303, label);
    assert.equal(response.headers.get("location"), "/auth/login?returnTo=%2Faccount%2F", label);
    assert.equal(cookieNamed(response, "portal_connect"), undefined, label);
  }
  const bearer = await app.fake.issueAccessToken({ scope: "agora:projects agora:certificates" });
  const withToken = await call(app.base, "/connect/agora", { bearer });
  assert.equal(withToken.status, 403);
  assert.equal(cookieNamed(withToken, "portal_connect"), undefined);
  assert.equal((await app.store.snapshot()).authTransactions.length, 0, "no transaction stored");
  // A guest can't complete one either, even holding a transaction cookie.
  const session = await signIn(app);
  const started = await call(app.base, "/connect/agora", { cookie: session.cookie });
  const callback = new URL(app.agora.authorize(started.headers.get("location")));
  const back = await call(app.base, callback.pathname + callback.search, { cookie: join(pair(cookieNamed(started, "portal_connect")), guest) });
  assert.equal(back.headers.get("location"), "/account/?connected=failed");
  assertCleared(back, "guest callback");
  assert.equal(app.agora.counts.code, 0, "the code is never redeemed");
});

test("a callback for another account's transaction fails and saves nothing", async (t) => {
  const app = await start(t);
  const owner = await signIn(app), other = await signIn(app);
  const result = await connect(app, owner, { callbackCookie: other.cookie });
  assert.equal(result.back.status, 303);
  assert.equal(result.location, "/account/?connected=failed");
  assertCleared(result.back, "other account");
  assert.equal(app.agora.counts.code, 0, "the code is never redeemed for the wrong account");
  assert.equal((await account(app, owner.sub)).connections?.agora, undefined);
  assert.equal((await account(app, other.sub)).connections?.agora, undefined);
  assert.equal((await app.store.snapshot()).authTransactions.length, 0, "the transaction is consumed anyway");
  assert.match(app.logs.join("\n"), /Agora connect failed: account\./);
});

test("every failed callback redirects with ?connected=failed and clears the cookie", async (t) => {
  const app = await start(t);
  const session = await signIn(app);
  const check = (response, label) => {
    assert.equal(response.status, 303, label);
    assert.equal(response.headers.get("location"), "/account/?connected=failed", label);
    assertCleared(response, label);
  };
  // No transaction cookie, or an unknown one.
  check(await call(app.base, "/connect/agora/callback?code=x&state=y", { cookie: session.cookie }), "no cookie");
  check(await call(app.base, "/connect/agora/callback?code=x&state=y", { cookie: join("portal_connect=unknown-transaction", session.cookie) }), "unknown cookie");
  // Agora returned an error.
  check((await connect(app, session, { error: "access_denied" })).back, "agora error");
  // A wrong or repeated state.
  const started = await call(app.base, "/connect/agora", { cookie: session.cookie });
  const forged = new URL(app.agora.authorize(started.headers.get("location")));
  forged.searchParams.set("state", "forged-state");
  check(await call(app.base, forged.pathname + forged.search, { cookie: join(pair(cookieNamed(started, "portal_connect")), session.cookie) }), "state");
  // A replayed callback finds its transaction consumed.
  const first = await connect(app, session);
  assert.equal(first.location, "/account/?connected=agora");
  check(await call(app.base, first.callback.pathname + first.callback.search, { cookie: join(pair(first.transaction), session.cookie) }), "replay");
  // A sign-in transaction is not a connect transaction.
  const login = await call(app.base, "/auth/login?returnTo=%2Faccount%2F");
  const loginId = pair(cookieNamed(login, "portal_auth")).slice("portal_auth=".length);
  check(await call(app.base, "/connect/agora/callback?code=x&state=" + new URL(login.headers.get("location")).searchParams.get("state"), { cookie: join("portal_connect=" + loginId, session.cookie) }), "sign-in transaction");
  // Agora refuses the code, or can't be reached.
  const refused = await call(app.base, "/connect/agora", { cookie: session.cookie });
  const refusedBack = new URL(app.agora.authorize(refused.headers.get("location")));
  refusedBack.searchParams.set("code", "not-a-code");
  check(await call(app.base, refusedBack.pathname + refusedBack.search, { cookie: join(pair(cookieNamed(refused, "portal_connect")), session.cookie) }), "invalid code");
  const down = await call(app.base, "/connect/agora", { cookie: session.cookie });
  const downBack = new URL(app.agora.authorize(down.headers.get("location")));
  app.agora.state.down = true;
  check(await call(app.base, downBack.pathname + downBack.search, { cookie: join(pair(cookieNamed(down, "portal_connect")), session.cookie) }), "agora down");
  app.agora.state.down = false;
  const logged = app.logs.join("\n");
  assert.match(logged, /Agora connect failed: (transaction|state|agora_error|token)\./);
  assert.ok(!logged.includes("agora-code-") && !logged.includes("agora-access-") && !logged.includes("agora-refresh-"), "no code or token in the log");
});

test("connect is rate-limited per account", async (t) => {
  const app = await start(t);
  const session = await signIn(app), other = await signIn(app);
  for (let index = 0; index < 10; index++) assert.equal((await call(app.base, "/connect/agora", { cookie: session.cookie })).status, 303);
  assert.equal((await call(app.base, "/connect/agora", { cookie: session.cookie })).status, 429);
  assert.equal((await call(app.base, "/connect/agora", { cookie: other.cookie })).status, 303, "another account is not limited");
});

test("connect is unavailable, not broken, without the AGORA_SSO_* settings, and logs the setting name only", async (t) => {
  const app = await start(t, { agoraEnv: { AGORA_SSO_CLIENT_ID: "", AGORA_SSO_CLIENT_SECRET: "" } });
  const session = await signIn(app);
  const response = await call(app.base, "/connect/agora", { cookie: session.cookie });
  assert.deepEqual([response.status, response.headers.get("location")], [303, "/account/?connected=unavailable"]);
  assert.equal(cookieNamed(response, "portal_connect"), undefined);
  const status = await (await call(app.base, "/api/connections", { cookie: session.cookie })).json();
  assert.equal(status.agora.connect, false);
  assert.equal(status.agora.connected, false);
  const callback = await call(app.base, "/connect/agora/callback?code=x&state=y", { cookie: join("portal_connect=abc", session.cookie) });
  assert.equal(callback.headers.get("location"), "/account/?connected=failed");
  assertCleared(callback, "unavailable callback");
  const logged = app.logs.join("\n");
  assert.match(logged, /Agora Console connect is unavailable: set AGORA_SSO_CLIENT_ID, AGORA_SSO_CLIENT_SECRET\./);
  assert.ok(!logged.includes(app.agora.clientSecret));
});

test("the connect settings name what is missing", () => {
  const key = randomBytes(32).toString("base64");
  const full = { AGORA_CONSOLE_ENCRYPTION_KEY: key, AGORA_SSO_CLIENT_ID: "portal-agora", AGORA_SSO_CLIENT_SECRET: "test-only", SITE_URL: siteUrl };
  assert.deepEqual(connectionsConfig(full).connect, { ready: true, missing: [], redirectUri: siteUrl + "/connect/agora/callback" });
  assert.deepEqual(connectionsConfig(full).sso, { baseUrl: "https://sso2.agora.io", clientId: "portal-agora", secret: "test-only", scope: "basic_info,console" }, "defaults: sso2.agora.io and basic_info,console");
  assert.equal(connectionsConfig({ ...full, AGORA_SSO_SCOPE: "basic_info" }).sso.scope, "basic_info");
  // Present but empty (as in an env file with `AGORA_SSO_BASE_URL=`) means the default, not missing.
  const empty = connectionsConfig({ ...full, AGORA_SSO_BASE_URL: "", AGORA_SSO_SCOPE: "" });
  assert.deepEqual([empty.connect.ready, empty.sso.baseUrl, empty.sso.scope], [true, "https://sso2.agora.io", "basic_info,console"]);
  const blank = connectionsConfig({ ...full, AGORA_SSO_BASE_URL: "  ", AGORA_SSO_SCOPE: " " });
  assert.deepEqual([blank.connect.ready, blank.sso.baseUrl, blank.sso.scope], [true, "https://sso2.agora.io", "basic_info,console"]);
  assert.deepEqual(connectionsConfig({}).connect.missing, ["AGORA_SSO_CLIENT_ID", "AGORA_SSO_CLIENT_SECRET", "AGORA_CONSOLE_ENCRYPTION_KEY", "SITE_URL"]);
  assert.deepEqual(connectionsConfig({ ...full, AGORA_SSO_BASE_URL: "http://sso.example" }).connect.missing, ["AGORA_SSO_BASE_URL"]);
  assert.deepEqual(connectionsConfig({ ...full, AGORA_CONSOLE_ENCRYPTION_KEY: randomBytes(16).toString("base64") }).connect.missing, ["AGORA_CONSOLE_ENCRYPTION_KEY"], "the key must be 32 bytes");
  // The old names are gone, not aliases.
  const old = { AGORA_CONSOLE_ENCRYPTION_KEY: key, AGORA_OAUTH_CLIENT_ID: "portal-agora", AGORA_OAUTH_CLIENT_SECRET: "test-only", AGORA_OAUTH_BASE_URL: "https://sso.example", CONNECTION_ENCRYPTION_KEY: key, SITE_URL: siteUrl };
  assert.deepEqual(connectionsConfig(old).connect.missing, ["AGORA_SSO_CLIENT_ID", "AGORA_SSO_CLIENT_SECRET"]);
  assert.equal(connectionsConfig(old).sso.baseUrl, "https://sso2.agora.io");
  assert.equal(connectionsConfig({ CONNECTION_ENCRYPTION_KEY: key }).key.length, 0);
  assert.deepEqual(connectionsConfig({ ...full, SITE_URL: "http://portal.example" }).connect.missing, ["SITE_URL"], "plain http only on localhost");
  assert.equal(connectionsConfig({ ...full, SITE_URL: "http://portal.localhost:3080" }).connect.redirectUri, "http://portal.localhost:3080/connect/agora/callback", "*.localhost is loopback, as for sign-in");
  assert.deepEqual(connectionsConfig({ ...full, SITE_URL: "http://localhost.example" }).connect.missing, ["SITE_URL"]);
});

test("disconnect removes the connection, from the same origin only", async (t) => {
  const app = await start(t);
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  const crossSite = await call(app.base, "/api/connections/agora", { cookie: session.cookie, method: "DELETE", headers: { Origin: "https://evil.example" } });
  assert.equal(crossSite.status, 403);
  assert.ok((await account(app, session.sub)).connections.agora, "still connected");
  const removed = await call(app.base, "/api/connections/agora", { cookie: session.cookie, method: "DELETE", headers: { Origin: new URL(app.base).origin } });
  assert.equal(removed.status, 200);
  assert.equal(app.agora.counts.revoke, 1, "disconnecting calls DELETE /api/v0/customer/user-auth");
  assert.ok(app.agora.calls.includes("DELETE /api/v0/customer/user-auth"));
  assert.equal((await (await call(app.base, "/api/connections", { cookie: session.cookie })).json()).agora.connected, false);
  assert.equal((await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie })).status, 403);
});

test("disconnect still removes the connection when Agora can't remove the authorization", async (t) => {
  const app = await start(t);
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  app.agora.state.down = true;
  const removed = await call(app.base, "/api/connections/agora", { cookie: session.cookie, method: "DELETE", headers: { Origin: new URL(app.base).origin } });
  assert.equal(removed.status, 200);
  assert.equal((await account(app, session.sub)).connections.agora, undefined);
  assert.match(app.logs.join("\n"), /Agora authorization removal failed; the connection is removed anyway\./);
});

test("an expiring connection is refreshed with the AGORA_SSO_* settings and keeps its name", async (t) => {
  const app = await start(t, { agoraOptions: { expiresIn: 30 } });
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  const before = JSON.stringify((await account(app, session.sub)).connections.agora);
  app.agora.state.expiresIn = 7200;
  const response = await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie });
  assert.equal(response.status, 200);
  assert.equal(app.agora.counts.refresh, 1);
  assert.notEqual(JSON.stringify((await account(app, session.sub)).connections.agora), before, "the renewed tokens are sealed again");
  assert.equal((await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie })).status, 200);
  assert.equal(app.agora.counts.refresh, 1, "a fresh token is not renewed again");
  assert.equal((await (await call(app.base, "/api/connections", { cookie: session.cookie })).json()).agora.name, "Agora Builder");
});

test("projects and certificates are read with a bearer token carrying agora:projects or agora:certificates", async (t) => {
  const app = await start(t);
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  const token = (scope) => app.fake.issueAccessToken({ sub: session.sub, scope });
  const projects = await call(app.base, "/api/v1/connections/agora/projects", { bearer: await token("agora:projects") });
  assert.equal(projects.status, 200);
  assert.equal((await projects.json()).projects[0].appId, "agora-app-id");
  const without = await call(app.base, "/api/v1/connections/agora/projects", { bearer: await token("credits") });
  assert.equal(without.status, 403);
  assert.match(without.headers.get("www-authenticate"), /^Bearer error="insufficient_scope", scope="agora:projects"/);
  const certificate = await call(app.base, "/api/v1/connections/agora/certificate", { bearer: await token("agora:certificates"), method: "POST", data: { projectId: "vendor-1" } });
  assert.equal(certificate.status, 200);
  assert.equal((await certificate.json()).certificate, "private-test-certificate");
  const projectsOnly = await call(app.base, "/api/v1/connections/agora/certificate", { bearer: await token("agora:projects"), method: "POST", data: { projectId: "vendor-1" } });
  assert.equal(projectsOnly.status, 403);
  assert.match(projectsOnly.headers.get("www-authenticate"), /scope="agora:certificates"/);
  const stranger = await call(app.base, "/api/v1/connections/agora/projects", { bearer: await app.fake.issueAccessToken({ scope: "agora:projects" }) });
  assert.equal(stranger.status, 403, "another account's token sees no connection");
});

test("a 401 from Agora renews the token once and retries", async (t) => {
  const app = await start(t);
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  app.agora.expireAccessTokens();
  const response = await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).projects[0].projectId, "vendor-1");
  assert.equal(app.agora.counts.refresh, 1);
  assert.equal(app.agora.counts.bffProjects, 2, "the refused call is retried once");
  const refresh = app.agora.calls.indexOf("POST /api/v0/oauth/token", 1);
  assert.ok(refresh > 0);
  // The renewed token is the stored one now, so the next call needs no renewal.
  assert.equal((await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie })).status, 200);
  assert.equal(app.agora.counts.refresh, 1);
  const certificate = await call(app.base, "/api/connections/agora/certificate", { cookie: session.cookie, method: "POST", data: { projectId: "vendor-1" }, headers: { Origin: new URL(app.base).origin } });
  assert.deepEqual(await certificate.json(), { projectId: "vendor-1", appId: "agora-app-id", certificate: "private-test-certificate" });
  assert.equal(app.agora.counts.bffProjects, 4, "the certificate comes from the BFF project list");
});

test("a refused renewal marks the connection as needing a reconnect", async (t) => {
  const app = await start(t);
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  app.agora.expireAccessTokens();
  app.agora.state.refuseRefresh = true;
  const response = await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Reconnect Agora Console to renew its access.", reconnect: true });
  const status = (await (await call(app.base, "/api/connections", { cookie: session.cookie })).json()).agora;
  assert.deepEqual([status.connected, status.reconnect, status.name], [true, true, "Agora Builder"]);
  // The log says why, by status and Agora's error fields, never with a token or the client secret.
  const logged = app.logs.join("\n");
  assert.match(logged, /Agora code exchange answered keys: access_token, refresh_token, expires_in, token_type; token_type bearer; scope none; expires_in \d+; access token \d+ characters\./);
  assert.match(logged, /Agora refused GET \/api\/cli\/v1\/projects: 401; WWW-Authenticate none; code UNAUTHORIZED, message Invalid access token\./);
  assert.match(logged, /Agora token renewal refused: 400; WWW-Authenticate none; error invalid_grant\./);
  for (const secret of [...app.agora.issued, app.agora.clientSecret]) assert.ok(!logged.includes(secret), "no token or client secret in the log");
  // No further calls to Agora until the account reconnects.
  const before = app.agora.calls.length;
  assert.equal((await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie })).status, 401);
  assert.equal(app.agora.calls.length, before);
  app.agora.state.refuseRefresh = false;
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  assert.equal((await (await call(app.base, "/api/connections", { cookie: session.cookie })).json()).agora.reconnect, false);
  assert.equal((await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie })).status, 200);
});

test("projects come from the BFF with the connection's bearer token, at AGORA_BFF_URL", async (t) => {
  const app = await start(t, { agoraOptions: { bff: "https://cli.agora.example" } });
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  app.agora.state.items.push({ projectId: "vendor-2", name: "No certificate", appId: "second-app-id", signKey: null, status: "0", createdAt: "2024-01-02T03:04:05Z" });
  const response = await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie });
  assert.equal(response.status, 200);
  const { projects } = await response.json();
  assert.deepEqual(projects.map((project) => [project.projectId, project.name, project.appId]), [["vendor-1", "Private project", "agora-app-id"], ["vendor-2", "No certificate", "second-app-id"]]);
  assert.ok(projects.every((project) => !("certificate" in project)), "the list never carries certificates");
  const reveal = (projectId) => call(app.base, "/api/connections/agora/certificate", { cookie: session.cookie, method: "POST", data: { projectId }, headers: { Origin: new URL(app.base).origin } });
  assert.deepEqual(await (await reveal("vendor-2")).json(), { projectId: "vendor-2", appId: "second-app-id", certificate: null });
  assert.equal((await reveal("vendor-3")).status, 404);
  assert.deepEqual(app.agora.calls.filter((line) => line.startsWith("BFF ")), Array(3).fill("BFF GET /api/cli/v1/projects"));
});
test("the BFF URL defaults to agora-cli.agora.io and must be https", () => {
  const base = { AGORA_CONSOLE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), AGORA_SSO_CLIENT_ID: "id", AGORA_SSO_CLIENT_SECRET: "secret", SITE_URL: siteUrl };
  assert.equal(connectionsConfig(base).bffUrl, "https://agora-cli.agora.io");
  assert.equal(connectionsConfig({ ...base, AGORA_BFF_URL: " " }).bffUrl, "https://agora-cli.agora.io");
  assert.equal(connectionsConfig({ ...base, AGORA_BFF_URL: "https://bff.example/" }).bffUrl, "https://bff.example");
  const insecure = connectionsConfig({ ...base, AGORA_BFF_URL: "http://bff.example" });
  assert.equal(insecure.ready, false);
  assert.deepEqual(insecure.connect.missing, ["AGORA_BFF_URL"]);
});

test("an unrecognised project list is logged by status and key names only", async (t) => {
  const app = await start(t);
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  app.agora.state.listShape = (items) => ({ code: 0, data: { page: { rows: items } } });
  const response = await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie });
  assert.equal(response.status, 503);
  const logged = app.logs.join("\n");
  assert.match(logged, /Agora project list not recognised: GET \/api\/cli\/v1\/projects answered 200 with keys: code, data; data keys: page\./);
  for (const value of ["agora-app-id", "private-test-certificate", "vendor-1", "agora-access-"]) assert.ok(!logged.includes(value), value);
});

test("the display name falls back to the authorised user when the company has none", async (t) => {
  const app = await start(t);
  app.agora.state.company = {};
  app.agora.state.user = { nickname: "Builder Nick" };
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  assert.equal((await (await call(app.base, "/api/connections", { cookie: session.cookie })).json()).agora.name, "Builder Nick");
  assert.ok(app.agora.calls.includes("GET /api/v0/customer/user-auth"));
});

test("the project mapper reads several plausible shapes", () => {
  const expected = { projectId: "vendor-1", name: "Private project", appId: "agora-app-id", status: "1", createdAt: "2023-11-14T22:13:20.000Z", certificate: "private-test-certificate" };
  const item = { vendorId: "vendor-1", projectName: "Private project", key: "agora-app-id", signKey: "private-test-certificate", status: 1, createdAt: 1700000000 };
  for (const [label, shape] of Object.entries(listShapes)) assert.deepEqual(mapProjects(shape([item])), { projects: [expected] }, label);
  assert.deepEqual(mapProjects({ projects: [{ id: 7, name: "Numbered", appId: "app-7", appCertificate: "cert-7", status: "active", created_at: "2024-01-02T03:04:05Z" }] }).projects[0],
    { projectId: "7", name: "Numbered", appId: "app-7", status: "active", createdAt: "2024-01-02T03:04:05.000Z", certificate: "cert-7" });
  assert.deepEqual(mapProjects({ data: { items: [{ vid: "v2", name: "Vid", vendorKey: "app-2" }, { name: "no id" }, "junk"] } }).projects,
    [{ projectId: "v2", name: "Vid", appId: "app-2", status: null, createdAt: null, certificate: null }], "items without an ID are skipped");
  assert.equal(mapProjects({ result: { list: [] } }).projects.length, 0);
  assert.equal(mapProjects({ code: 0, data: { total: 1 } }), null, "no array is not an empty list");
  assert.equal(mapProjects(null), null);
  assert.deepEqual(mapProjects({ items: [{ projectId: "p-1", vid: 1001, name: "BFF", appId: "app-1", signKey: "cert-1", status: "1", createdAt: "2024-01-02T03:04:05Z" }] }).projects[0],
    { projectId: "p-1", name: "BFF", appId: "app-1", status: "1", createdAt: "2024-01-02T03:04:05.000Z", certificate: "cert-1" }, "the BFF's projectId wins over its vid");
  assert.equal(mapName({ data: { companyName: "Agora Builder" } }), "Agora Builder");
  assert.equal(mapName({ company: { name: "Inc" } }), "Inc");
  assert.equal(mapName({ data: { userName: "builder\u0007" } }), "builder");
  assert.equal(mapName({ code: 0 }), "");
});

test("the shape probe prints key names and types only, never values", async () => {
  const lines = describeShape({ code: 0, data: { list: [{ vendorId: "vendor-1", key: "agora-app-id", signKey: null, tags: [], "0123456789abcdef0123": { x: 1 } }, { vendorId: "vendor-2", status: true }] } });
  assert.deepEqual(lines, ["(top level): object", "code: number", "data: object", "data.list: array", "data.list[]: object", "data.list[].vendorId: string", "data.list[].key: string", "data.list[].signKey: null", "data.list[].tags: array (empty)", "data.list[].<key>: object", "data.list[].<key>.x: number", "data.list[].status: boolean"]);

  const agora = createFakeAgora();
  const store = createStore(resolve(root, "data/people.json"), resolve(temporary, randomBytes(8).toString("hex") + ".json"), { log: () => {} });
  const userId = "ab" + "5".repeat(26);
  await store.signIn({ sub: userId, sid: "sid-probe", name: "Builder", idToken: "id-token" });
  const connections = createConnections(store, connectionsConfig(agora.env({ SITE_URL: siteUrl })), { request: agora.request, log: () => {} });
  // A connect, as the server runs it, stores a real token from the stand-in.
  const { url, transaction } = connections.beginConnect(userId);
  await connections.completeConnect(transaction, new URL(agora.authorize(url)).searchParams, userId);
  const output = [];
  await probeShapes(connections, userId, (line) => output.push(line));
  assert.ok(output.includes("GET BFF /api/cli/v1/projects: 200"), "the BFF project list is probed");
  assert.ok(output.includes("  items[].signKey: string"), "the key names are shown");
  const text = output.join("\n");
  for (const path of ["/api/v0/customer/user-auth", "/api/v0/customer/company/basic-info", "/api/v0/account/companies", "BFF /api/cli/v1/projects"]) assert.ok(output.some((line) => line.startsWith("GET " + path + ": ")), path);
  for (const value of ["vendor-1", "agora-app-id", "private-test-certificate", "Private project", "Agora Builder", "agora-user-1", "probe-token", "agora-access-", "2023-11-14", "1001", "42"]) assert.ok(!text.includes(value), "the probe never prints " + value);
});

test("an account signs RTC and RTM tokens for its project on agora.build; the certificate never leaves", async (t) => {
  const app = await start(t);
  const session = await signIn(app);
  assert.equal((await connect(app, session)).location, "/account/?connected=agora");
  const appId = "0123456789abcdef0123456789abcdef", certificate = "abcdef0123456789abcdef0123456789";
  app.agora.state.items.push({ projectId: "tokens-1", name: "Tokens", appId, signKey: certificate, status: "1", createdAt: "2024-01-02T03:04:05Z" }, { projectId: "no-cert", name: "Testing mode", appId, signKey: "", status: "1" });
  const origin = { Origin: new URL(app.base).origin };
  // The browser calls /api/...; apps with access tokens call the versioned /api/v1/....
  const sign = (data, options = { cookie: session.cookie, headers: origin }) => call(app.base, options.bearer ? "/api/v1/connections/agora/token" : "/api/connections/agora/token", { method: "POST", data, ...options });

  const rtc = await sign({ projectId: "tokens-1", type: "rtc", channel: "demo", account: "builder_42", rtm: { expire: 600 } });
  assert.equal(rtc.status, 200);
  const reply = await rtc.json();
  assert.deepEqual(Object.keys(reply).sort(), ["account", "appId", "channel", "expiresAt", "issuedAt", "privileges", "projectId", "role", "rtm", "token", "type"]);
  assert.deepEqual([reply.projectId, reply.appId, reply.type, reply.channel, reply.account, reply.role, reply.rtm.userId], ["tokens-1", appId, "rtc", "demo", "builder_42", "publisher", "builder_42"]);
  assert.equal(Date.parse(reply.expiresAt) - Date.parse(reply.issuedAt), 3600000);
  assert.equal(verifyTokenSignature(reply.token, certificate), true, "signed with the project's certificate");
  const decoded = decodeToken(reply.token);
  assert.deepEqual(decoded.services.map((service) => service.details), [{ kind: "rtc", channel: "demo", account: "builder_42" }, { kind: "rtm", user_id: "builder_42" }]);
  assert.ok(!JSON.stringify(reply).includes(certificate), "the reply has no certificate");

  const subscriber = await (await sign({ projectId: "tokens-1", type: "rtc", channel: "demo", uid: 0, role: "subscriber", tokenExpire: 600, privilegeExpire: 300 })).json();
  assert.deepEqual([subscriber.uid, Object.keys(subscriber.privileges)], [0, ["join"]]);
  assert.deepEqual(decodeToken(subscriber.token).services[0].privileges, { 1: 300 });
  const explicit = await (await sign({ projectId: "tokens-1", type: "rtc", channel: "demo", uid: 7, role: "explicit", privileges: { join: 600, audio: 300, video: 200, data: 100 } })).json();
  assert.deepEqual(decodeToken(explicit.token).services[0].privileges, { 1: 600, 2: 300, 3: 200, 4: 100 });
  const rtm = await (await sign({ projectId: "tokens-1", type: "rtm", userId: "alice", expire: 120 })).json();
  assert.deepEqual([rtm.type, rtm.userId, decodeToken(rtm.token).services[0].details], ["rtm", "alice", { kind: "rtm", user_id: "alice" }]);

  // Apps: a bearer token with agora:tokens; agora:certificates alone is not enough.
  const bearer = await sign({ projectId: "tokens-1", type: "rtm", userId: "app-user" }, { bearer: await app.fake.issueAccessToken({ sub: session.sub, scope: "agora:tokens" }) });
  assert.equal(bearer.status, 200);
  const wrongScope = await sign({ projectId: "tokens-1", type: "rtm", userId: "app-user" }, { bearer: await app.fake.issueAccessToken({ sub: session.sub, scope: "agora:projects agora:certificates" }) });
  assert.equal(wrongScope.status, 403);
  assert.match(wrongScope.headers.get("www-authenticate"), /scope="agora:tokens"/);
  assert.equal((await sign({ projectId: "tokens-1", type: "rtm", userId: "x" }, { cookie: session.cookie, headers: { Origin: "https://elsewhere.example" } })).status, 403, "a cookie POST from another site is refused");

  const refused = [
    [{ projectId: "no-cert", type: "rtc", channel: "demo" }, 409],
    [{ projectId: "missing", type: "rtc", channel: "demo" }, 404],
    [{ projectId: "tokens-1", type: "rtc", channel: "c".repeat(65) }, 422],
    [{ projectId: "tokens-1", type: "rtc", channel: "demo", uid: 1, account: "a" }, 422],
    [{ projectId: "tokens-1", type: "rtc", channel: "demo", uid: -1 }, 422],
    [{ projectId: "tokens-1", type: "rtc", channel: "demo", role: "owner" }, 422],
    [{ projectId: "tokens-1", type: "rtc", channel: "demo", tokenExpire: 86401 }, 422],
    [{ projectId: "tokens-1", type: "rtc", channel: "demo", uid: 5, rtm: true }, 422],
    [{ projectId: "tokens-1", type: "rtm" }, 422],
    [{ projectId: "tokens-1", type: "video" }, 422],
    [{ type: "rtm", userId: "u" }, 422]
  ];
  for (const [data, status] of refused) assert.equal((await sign(data)).status, status, JSON.stringify(data));
  const logged = app.logs.join("\n");
  assert.ok(!logged.includes(certificate) && !logged.includes(reply.token), "no certificate or token in the log");
});
