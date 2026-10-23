// Connecting Agora Console from a signed-in account (spec §3.4), against stand-in auth.agora.build and Agora OAuth.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createAppServer } from "../scripts/serve.mjs";
import { createStore } from "../scripts/store.mjs";
import { createConnections, connectionsConfig } from "../scripts/connections.mjs";
import { modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { createSignaling, signalingConfig } from "../scripts/spaces/signaling.mjs";
import { createIdp } from "../scripts/idp.mjs";
import { createFakeIdp } from "./helpers/fake-idp.mjs";
import { createFakeAgora } from "./helpers/fake-agora.mjs";

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
  const connections = createConnections(store, connectionsConfig(agora.env({ SITE_URL: site, ...agoraEnv })), { request: agora.request });
  const logs = [];
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
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
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
  assert.deepEqual(status.agora, { ready: true, connect: true, connected: true, name: "Agora Builder" });
  const projects = await (await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie })).json();
  assert.deepEqual(projects.projects, [{ projectId: "project-1", name: "Private project", appId: "agora-app-id", status: "active" }]);
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

test("connect is unavailable, not broken, without the AGORA_OAUTH_* settings, and logs the setting name only", async (t) => {
  const app = await start(t, { agoraEnv: { AGORA_OAUTH_CLIENT_ID: "", AGORA_OAUTH_CLIENT_SECRET: "" } });
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
  assert.match(logged, /Agora Console connect is unavailable: set AGORA_OAUTH_CLIENT_ID, AGORA_OAUTH_CLIENT_SECRET\./);
  assert.ok(!logged.includes(app.agora.clientSecret));
});

test("the connect settings name what is missing", () => {
  const key = randomBytes(32).toString("base64");
  const full = { AGORA_CONSOLE_ENCRYPTION_KEY: key, AGORA_OAUTH_CLIENT_ID: "portal-agora", AGORA_OAUTH_CLIENT_SECRET: "test-only", SITE_URL: siteUrl };
  assert.deepEqual(connectionsConfig(full).connect, { ready: true, missing: [], redirectUri: siteUrl + "/connect/agora/callback" });
  assert.deepEqual(connectionsConfig({}).connect.missing, ["AGORA_CONSOLE_ENCRYPTION_KEY", "AGORA_OAUTH_CLIENT_ID", "AGORA_OAUTH_CLIENT_SECRET", "SITE_URL"]);
  assert.deepEqual(connectionsConfig({ ...full, AGORA_OAUTH_BASE_URL: "http://sso.example" }).connect.missing, ["AGORA_OAUTH_BASE_URL"]);
  assert.deepEqual(connectionsConfig({ ...full, SITE_URL: "http://portal.example" }).connect.missing, ["SITE_URL"], "plain http only on localhost");
  assert.equal(connectionsConfig({ ...full, SITE_URL: "http://portal.localhost:3080" }).connect.redirectUri, "http://portal.localhost:3080/connect/agora/callback", "*.localhost is loopback, as for sign-in");
  assert.deepEqual(connectionsConfig({ ...full, SITE_URL: "http://localhost.example" }).connect.missing, ["SITE_URL"]);
  assert.equal(connectionsConfig({ ...full, AGORA_OAUTH_USERINFO_URL: "http://sso.example/userinfo" }).connect.ready, true, "the optional userinfo URL is ignored when invalid");
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
  assert.equal((await (await call(app.base, "/api/connections", { cookie: session.cookie })).json()).agora.connected, false);
  assert.equal((await call(app.base, "/api/connections/agora/projects", { cookie: session.cookie })).status, 403);
});

test("an expiring connection is refreshed with the AGORA_OAUTH_* settings and keeps its name", async (t) => {
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
  const projects = await call(app.base, "/api/connections/agora/projects", { bearer: await token("agora:projects") });
  assert.equal(projects.status, 200);
  assert.equal((await projects.json()).projects[0].appId, "agora-app-id");
  const without = await call(app.base, "/api/connections/agora/projects", { bearer: await token("credits") });
  assert.equal(without.status, 403);
  assert.match(without.headers.get("www-authenticate"), /^Bearer error="insufficient_scope", scope="agora:projects"/);
  const certificate = await call(app.base, "/api/connections/agora/certificate", { bearer: await token("agora:certificates"), method: "POST", data: { projectId: "project-1" } });
  assert.equal(certificate.status, 200);
  assert.equal((await certificate.json()).certificate, "private-test-certificate");
  const projectsOnly = await call(app.base, "/api/connections/agora/certificate", { bearer: await token("agora:projects"), method: "POST", data: { projectId: "project-1" } });
  assert.equal(projectsOnly.status, 403);
  assert.match(projectsOnly.headers.get("www-authenticate"), /scope="agora:certificates"/);
  const stranger = await call(app.base, "/api/connections/agora/projects", { bearer: await app.fake.issueAccessToken({ scope: "agora:projects" }) });
  assert.equal(stranger.status, 403, "another account's token sees no connection");
});
