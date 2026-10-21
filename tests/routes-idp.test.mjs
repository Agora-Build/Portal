// Routes for signing in through auth.agora.build and the authorisation matrix (spec §3.1, §3.3), against the stand-in IdP.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createAppServer } from "../scripts/serve.mjs";
import { createStore } from "../scripts/store.mjs";
import { createLedger } from "../scripts/ledger.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { createSignaling, signalingConfig } from "../scripts/spaces/signaling.mjs";
import { createIdp } from "../scripts/idp.mjs";
import { createFakeIdp } from "./helpers/fake-idp.mjs";

const root = new URL("../", import.meta.url).pathname;
const issuer = "https://auth.example";
const clientSecret = "portal-route-test-secret-".padEnd(48, "x");
const siteUrl = "http://localhost:3080";
const env = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACES_SIGNALING_SECRET: "s".repeat(32) };
const profile = (name = "Route tester") => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });
const prices = { vox: { services: { evaluation: { credits: 3, maxUnits: 5 } } }, "billing-two": { services: { analysis: { credits: 1, maxUnits: 1 } } } };
const models = { config: modelConfig({ OPENAI_API_KEY: "test-only-route-key" }), chat: async () => "Mocked answer", speak: async () => Buffer.from("ID3-audio"), research: async () => ({ items: [] }), search: async (people) => people };
let temporary;
before(async () => { temporary = await mkdtemp(resolve(tmpdir(), "routes-idp-")); });
after(() => rm(temporary, { recursive: true, force: true }));

const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });
async function start(t, options = {}) {
  const fake = options.fake || await createFakeIdp({ issuer, clientId: "portal", clientSecret });
  const idp = "idp" in options ? options.idp : createIdp({ issuer, clientId: "portal", clientSecret, siteUrl: options.siteUrl || siteUrl, request: fake.request });
  const store = options.store || createStore(resolve(root, "data/people.json"), resolve(temporary, randomBytes(8).toString("hex") + ".json"), { log: () => {} });
  const logs = [];
  const instance = createAppServer(root, {
    monitor: false, store, idp, siteUrl: options.siteUrl || siteUrl, billingClients: "billingClients" in options ? options.billingClients : prices, log: (line) => logs.push(line),
    models: options.models || models, modelLimit: 1000, calls: createAgoraCalls(agoraConfig(env)), signaling: createSignaling(signalingConfig(env)), channelSecret: env.SPACES_SIGNALING_SECRET
  });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  t.after(() => close(instance));
  return { fake, idp, store, logs, base: "http://127.0.0.1:" + instance.address().port };
}
const call = (base, path, { cookie, bearer, method = "GET", data, headers = {} } = {}) => fetch(base + path, {
  method, redirect: "manual",
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: "Bearer " + bearer } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
  ...(data !== undefined ? { body: JSON.stringify(data) } : {})
});
const cookies = (response) => response.headers.getSetCookie();
const cookieNamed = (response, name) => cookies(response).find((line) => line.startsWith(name + "="));
const pair = (line) => line.split(";")[0];

// Runs /auth/login → the stand-in IdP's /authorize → /auth/callback, as a browser would.
async function browserSignIn(app, { claims = {}, cookie, returnTo = "/account.html" } = {}) {
  const login = await call(app.base, "/auth/login?returnTo=" + encodeURIComponent(returnTo), { cookie });
  assert.equal(login.status, 303);
  const transaction = cookieNamed(login, "portal_auth");
  assert.ok(transaction, "the login sets the transaction cookie");
  const callback = new URL(app.fake.authorize(login.headers.get("location"), claims));
  const back = await call(app.base, callback.pathname + callback.search, { cookie: [pair(transaction), cookie].filter(Boolean).join("; ") });
  const session = cookieNamed(back, "house_session");
  return { login, back, transaction, code: callback.searchParams.get("code"), location: back.headers.get("location"), cookie: session ? pair(session) : null };
}
async function guest(app, name = "Guest builder") {
  const response = await call(app.base, "/api/profile", { method: "POST", data: profile(name) });
  assert.equal(response.status, 201);
  return pair(cookieNamed(response, "house_session"));
}
const bearerToken = (app, claims = {}, opts = {}) => app.fake.issueAccessToken(claims, opts);
const assertInvalidToken = async (response) => {
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /^Bearer error="invalid_token"/);
};
const assertScope = async (response, scope) => {
  assert.equal(response.status, 403, "expected insufficient_scope for " + scope);
  assert.match(response.headers.get("www-authenticate"), /^Bearer error="insufficient_scope"/);
  if (scope) assert.match(response.headers.get("www-authenticate"), new RegExp('scope="' + scope + '"'));
};

test("login stores a transaction behind a short-lived cookie and sends the browser to the IdP", async (t) => {
  const app = await start(t);
  const login = await call(app.base, "/auth/login?returnTo=" + encodeURIComponent("/stoa/room/ai-agents?x=1"));
  assert.equal(login.status, 303);
  const location = new URL(login.headers.get("location"));
  assert.equal(location.origin + location.pathname, issuer + "/authorize");
  assert.equal(location.searchParams.get("redirect_uri"), siteUrl + "/auth/callback");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  const cookie = cookieNamed(login, "portal_auth");
  assert.match(cookie, /^portal_auth=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
  const [saved] = (await app.store.snapshot()).authTransactions;
  assert.equal(saved.returnTo, "/stoa/room/ai-agents?x=1");
  assert.ok(!JSON.stringify(saved).includes(pair(cookie).slice(12)), "the transaction ID is stored hashed");
});

test("over https the transaction cookie is __Host- prefixed and Secure", async (t) => {
  const app = await start(t, { siteUrl: "https://portal.example" });
  const login = await call(app.base, "/auth/login");
  assert.match(cookieNamed(login, "__Host-portal_auth"), /^__Host-portal_auth=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600; Secure$/);
});

test("returnTo must pass the same-site path allowlist; /oauth/authorize is no longer allowed", async (t) => {
  const app = await start(t);
  for (const [returnTo, expected] of [["https://evil.example/", "/"], ["//evil.example", "/"], ["/oauth/authorize?client_id=x", "/"], ["/scripts/serve.mjs", "/"], ["/radar.html?signin=success#top", "/radar.html#top"], ["/stoa/", "/stoa/"]]) {
    await call(app.base, "/auth/login?returnTo=" + encodeURIComponent(returnTo));
    const saved = (await app.store.snapshot()).authTransactions.at(-1);
    assert.equal(saved.returnTo, expected, returnTo);
  }
});

test("sign-in is unavailable, not broken, while the IdP is unconfigured or unreachable", async (t) => {
  const missing = await start(t, { idp: null });
  const login = await call(missing.base, "/auth/login?returnTo=%2Fexplore.html");
  assert.deepEqual([login.status, login.headers.get("location")], [303, "/explore.html?signin=unavailable"]);
  assert.equal((await call(missing.base, "/")).status, 200, "static pages still work");
  assert.equal((await call(missing.base, "/api/auth/config")).status, 200);
  assert.deepEqual(await (await call(missing.base, "/api/auth/config")).json(), { issuer: null, accountUrl: null });
  const visitor = await guest(missing);
  assert.equal((await (await call(missing.base, "/api/me", { cookie: visitor })).json()).profile.name, "Guest builder", "guests still work");
  const bearer = await call(missing.base, "/api/me", { bearer: "anything" });
  assert.equal(bearer.status, 503);
  const callback = await call(missing.base, "/auth/callback?code=x&state=y", { cookie: "portal_auth=abc" });
  assert.equal(callback.headers.get("location"), "/?signin=failed");

  const fake = await createFakeIdp({ issuer, clientId: "portal", clientSecret });
  fake.setDown(true);
  const down = await start(t, { fake });
  const unavailable = await call(down.base, "/auth/login");
  assert.deepEqual([unavailable.status, unavailable.headers.get("location")], [303, "/?signin=unavailable"]);
  assert.equal((await down.store.snapshot()).authTransactions.length, 0);
  assert.equal(cookieNamed(unavailable, "portal_auth"), undefined);
});

test("a broken IdP setting is logged by name once and the Portal still starts", async (t) => {
  const logs = [];
  const saved = { ...process.env };
  t.after(() => { for (const key of ["AUTH_ISSUER", "PORTAL_CLIENT_SECRET", "SITE_URL"]) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; } });
  process.env.AUTH_ISSUER = issuer; process.env.SITE_URL = siteUrl; process.env.PORTAL_CLIENT_SECRET = "too-short-secret-value";
  const instance = createAppServer(root, { monitor: false, storageFile: resolve(temporary, "broken.json"), log: (line) => logs.push(line), models: createModelClient(modelConfig({})) });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  t.after(() => close(instance));
  const base = "http://127.0.0.1:" + instance.address().port;
  assert.equal((await call(base, "/auth/login")).headers.get("location"), "/?signin=unavailable");
  await call(base, "/auth/login");
  const lines = logs.filter((line) => /PORTAL_CLIENT_SECRET/.test(line));
  assert.equal(lines.length, 1);
  assert.ok(!logs.join("\n").includes("too-short-secret-value"));
});

test("login is rate-limited per IP at 20 a minute, before any transaction is stored", async (t) => {
  const app = await start(t);
  for (let index = 0; index < 20; index++) assert.equal((await call(app.base, "/auth/login")).status, 303, "login " + index);
  const limited = await call(app.base, "/auth/login");
  assert.equal(limited.status, 429);
  assert.equal((await app.store.snapshot()).authTransactions.length, 20);
});

test("login → callback → /api/me signs the browser in with the IdP's name, picture and verified email", async (t) => {
  const app = await start(t);
  const sub = app.fake.accountId();
  const result = await browserSignIn(app, { claims: { sub, name: "Ada Builder", email: "Ada@Example.com", email_verified: true }, returnTo: "/account.html#credits" });
  assert.equal(result.back.status, 303);
  assert.equal(result.location, "/account.html?signin=success#credits");
  assert.match(cookieNamed(result.back, "house_session"), /HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  assert.match(cookieNamed(result.back, "portal_auth"), /^portal_auth=; .*Max-Age=0/);
  const me = await (await call(app.base, "/api/me", { cookie: result.cookie })).json();
  assert.deepEqual([me.account.id, me.account.name, me.account.avatar, me.account.email], [sub, "Ada Builder", "https://avatars.example/builder.png", "ada@example.com"]);
  assert.equal((await app.store.snapshot()).authTransactions.length, 0, "the transaction is consumed");
  const logged = app.logs.join("\n");
  assert.ok(!logged.includes(result.code) && !logged.includes(result.cookie.slice(14)), "no code or session token in the log");
});

test("an unverified email is not stored, and a sign-in without a picture keeps the avatar", async (t) => {
  const app = await start(t);
  const sub = app.fake.accountId();
  await browserSignIn(app, { claims: { sub, email: "unverified@example.com", email_verified: false } });
  const again = await browserSignIn(app, { claims: { sub, picture: undefined } });
  const me = await (await call(app.base, "/api/me", { cookie: again.cookie })).json();
  assert.equal(me.account.email, null);
  assert.equal(me.account.avatar, "https://avatars.example/builder.png");
});

test("callback failures redirect with ?signin=failed, create no session, clear the cookie and log only the reason", async (t) => {
  const app = await start(t);
  const check = async (response, label, returnTo = "/account.html") => {
    assert.equal(response.status, 303, label);
    assert.equal(response.headers.get("location"), returnTo + "?signin=failed", label);
    assert.equal(cookieNamed(response, "house_session"), undefined, label);
    assert.match(cookieNamed(response, "portal_auth") || "", /^portal_auth=; .*Max-Age=0/, label);
  };
  // No transaction cookie at all.
  const login = await call(app.base, "/auth/login?returnTo=%2Faccount.html");
  const callback = new URL(app.fake.authorize(login.headers.get("location")));
  await check(await call(app.base, callback.pathname + callback.search), "no cookie", "/");
  // The IdP returned an error.
  const errored = await call(app.base, "/auth/login?returnTo=%2Faccount.html");
  const state = new URL(errored.headers.get("location")).searchParams.get("state");
  await check(await call(app.base, "/auth/callback?error=access_denied&state=" + state, { cookie: pair(cookieNamed(errored, "portal_auth")) }), "idp error");
  // A replayed callback finds its transaction already consumed.
  const first = await browserSignIn(app);
  assert.equal(first.location, "/account.html?signin=success");
  const replay = new URL(app.fake.authorize(first.login.headers.get("location")));
  await check(await call(app.base, replay.pathname + replay.search, { cookie: pair(first.transaction) }), "replay", "/");
  // A wrong state with a live transaction.
  const other = await call(app.base, "/auth/login?returnTo=%2Faccount.html");
  const forged = new URL(app.fake.authorize(other.headers.get("location")));
  forged.searchParams.set("state", "forged-state");
  await check(await call(app.base, forged.pathname + forged.search, { cookie: pair(cookieNamed(other, "portal_auth")) }), "state");
  // A wrong nonce in the ID token.
  const wrongNonce = await browserSignIn(app, { claims: { nonce: "not-the-nonce" } });
  await check(wrongNonce.back, "nonce");
  const logged = app.logs.join("\n");
  assert.match(logged, /Sign-in failed: (state|idp_error|id_token)/);
  assert.ok(!/eyJ/.test(logged), "no token values in the log");
});

test("a browser's guest profile is adopted by its account at first sign-in", async (t) => {
  const app = await start(t);
  const visitor = await guest(app, "Guest first");
  const guestProfile = (await (await call(app.base, "/api/me", { cookie: visitor })).json()).profile;
  const signedIn = await browserSignIn(app, { cookie: visitor });
  const me = await (await call(app.base, "/api/me", { cookie: signedIn.cookie })).json();
  assert.equal(me.profile.id, guestProfile.id);
  assert.equal(me.account.id.startsWith("acct_"), true);
  assert.equal((await (await call(app.base, "/api/me", { cookie: visitor })).json()).profile, null, "the guest token stops working");
  // An account that already has a profile keeps it; another browser's guest profile stays a guest.
  const second = await guest(app, "Guest second");
  const again = await browserSignIn(app, { cookie: second, claims: { sub: me.account.id } });
  assert.equal((await (await call(app.base, "/api/me", { cookie: again.cookie })).json()).profile.id, guestProfile.id);
  assert.equal((await (await call(app.base, "/api/me", { cookie: second })).json()).profile, null, "the other guest token stops working too");
});

test("logout ends the Portal session and returns the IdP end-session URL; it keeps the same-origin check", async (t) => {
  const app = await start(t);
  const { cookie } = await browserSignIn(app);
  assert.equal((await call(app.base, "/api/auth/logout", { cookie, method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
  const out = await call(app.base, "/api/auth/logout", { cookie, method: "POST" });
  assert.equal(out.status, 200);
  const { endSessionUrl } = await out.json();
  const url = new URL(endSessionUrl);
  assert.equal(url.origin + url.pathname, issuer + "/logout");
  assert.equal(url.searchParams.get("post_logout_redirect_uri"), siteUrl + "/");
  assert.match(url.searchParams.get("id_token_hint"), /^eyJ/);
  assert.match(cookieNamed(out, "house_session"), /Max-Age=0/);
  assert.equal((await (await call(app.base, "/api/me", { cookie })).json()).account, null);
  const visitor = await guest(app);
  const guestOut = await (await call(app.base, "/api/auth/logout", { cookie: visitor, method: "POST" })).json();
  assert.equal(guestOut.endSessionUrl, null, "a guest has no IdP session to end");
});

test("back-channel logout ends a session by sid, or every session of a sub; it is exempt from the same-origin check", async (t) => {
  const app = await start(t);
  const sub = app.fake.accountId();
  const a = await browserSignIn(app, { claims: { sub, sid: "sid-a" } });
  const b = await browserSignIn(app, { claims: { sub, sid: "sid-b" } });
  const c = await browserSignIn(app, { claims: { sub, sid: "sid-c" } });
  const post = (body, headers = {}) => fetch(app.base + "/auth/backchannel-logout", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: issuer, "Sec-Fetch-Site": "cross-site", ...headers }, body });
  const bySid = await post(new URLSearchParams({ logout_token: await app.fake.issueLogoutToken({ sub, sid: "sid-a" }) }));
  assert.equal(bySid.status, 200);
  assert.equal(bySid.headers.get("cache-control"), "no-store");
  assert.equal((await (await call(app.base, "/api/me", { cookie: a.cookie })).json()).account, null);
  assert.equal((await (await call(app.base, "/api/me", { cookie: b.cookie })).json()).account.id, sub);
  const bySub = await post(new URLSearchParams({ logout_token: await app.fake.issueLogoutToken({ sub, sid: undefined }) }));
  assert.equal(bySub.status, 200);
  for (const session of [b, c]) assert.equal((await (await call(app.base, "/api/me", { cookie: session.cookie })).json()).account, null);
  const invalid = await post(new URLSearchParams({ logout_token: await app.fake.issueLogoutToken({ sub, nonce: "n" }) }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("cache-control"), "no-store");
  assert.equal((await post("logout_token=not-a-jwt")).status, 400);
  assert.equal((await post("{}", { "Content-Type": "application/json" })).status, 400);
  assert.equal((await fetch(app.base + "/auth/backchannel-logout")).status, 405);
});

test("the same-origin checks on cookie POSTs are unchanged", async (t) => {
  const app = await start(t);
  const { cookie } = await browserSignIn(app);
  assert.equal((await call(app.base, "/api/services/chat", { cookie, method: "POST", data: { message: "Hi there" }, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await call(app.base, "/api/services/chat", { cookie, method: "POST", data: { message: "Hi there" }, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await call(app.base, "/api/services/chat", { cookie, method: "POST", data: { message: "Hi there" }, headers: { Origin: app.base } })).status, 200);
});

test("the matrix for a browser account session", async (t) => {
  const app = await start(t);
  const { cookie } = await browserSignIn(app);
  const ok = async (path, options = {}) => { const response = await call(app.base, path, { cookie, ...options }); assert.ok(response.status < 400 || response.status === 503, path + " gave " + response.status); return response; };
  await ok("/api/me");
  await ok("/api/credits/balance");
  await ok("/api/credits/statement");
  assert.equal((await ok("/api/services/chat", { method: "POST", data: { message: "Hi there" } })).status, 200);
  assert.equal((await ok("/api/services/tts", { method: "POST", data: { text: "Hello" } })).status, 200);
  assert.equal((await ok("/api/billing/account")).status, 200);
  await ok("/api/billing/manage", { method: "POST", data: {} });
  assert.equal((await ok("/api/connections")).status, 200);
  await ok("/api/connections/agora/projects");
  await ok("/api/connections/agora/certificate", { method: "POST", data: { projectId: "p" } });
  assert.equal((await ok("/api/connections/agora", { method: "DELETE" })).status, 200);
  assert.equal((await call(app.base, "/api/platform/credits/reserve", { cookie, method: "POST", data: { service: "evaluation", credits: 1, idempotencyKey: "browser-reserve-0001" } })).status, 401, "browser sessions cannot reserve");
  const created = await ok("/api/spaces", { method: "POST", data: { title: "Account room" } });
  assert.equal(created.status, 201);
  assert.equal((await ok("/api/spaces/mine")).status, 200);
  assert.equal((await ok("/api/spaces/plaza/enter", { method: "POST", data: {} })).status, 200);
  assert.equal((await ok("/api/radar")).status, 200);
});

test("the matrix for a guest: Stoa and the radar, but no credits, services, billing, connections or owned spaces", async (t) => {
  const app = await start(t);
  const cookie = await guest(app);
  const refused = async (path, options = {}) => assert.equal((await call(app.base, path, { cookie, ...options })).status, 401, path);
  assert.equal((await call(app.base, "/api/me", { cookie })).status, 200);
  await refused("/api/credits/balance");
  await refused("/api/credits/statement");
  await refused("/api/services/chat", { method: "POST", data: { message: "Hi there" } });
  await refused("/api/services/tts", { method: "POST", data: { text: "Hello" } });
  await refused("/api/billing/account");
  await refused("/api/billing/checkout", { method: "POST", data: { productId: "builder-pack" } });
  await refused("/api/billing/manage", { method: "POST", data: {} });
  await refused("/api/connections");
  await refused("/api/connections/agora/projects");
  await refused("/api/connections/agora/certificate", { method: "POST", data: { projectId: "p" } });
  await refused("/api/connections/agora", { method: "DELETE" });
  await refused("/api/platform/credits/reserve", { method: "POST", data: {} });
  await refused("/api/spaces", { method: "POST", data: { title: "Guest room" } });
  assert.equal((await (await call(app.base, "/api/spaces/mine", { cookie })).json()).canCreate, false);
  assert.equal((await call(app.base, "/api/spaces/plaza/enter", { cookie, method: "POST", data: {} })).status, 200);
  assert.equal((await call(app.base, "/api/spaces/plaza/heartbeat", { cookie, method: "POST" })).status, 200);
  assert.equal((await call(app.base, "/api/radar", { cookie })).status, 200);
});

test("the matrix for bearer tokens: scopes per route, and routes that take only the browser session", async (t) => {
  const app = await start(t);
  const sub = app.fake.accountId();
  const token = (scope) => bearerToken(app, { sub, scope });
  const openid = await token("openid");
  const me = await call(app.base, "/api/me", { bearer: openid });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.account.id, sub);
  assert.ok(!("email" in body.account), "bearer callers never see the email");
  assert.ok((await app.store.snapshot()).accounts.some((account) => account.id === sub), "the first token creates the account");

  const credits = await token("credits");
  assert.equal((await call(app.base, "/api/credits/balance", { bearer: credits })).status, 200);
  assert.equal((await call(app.base, "/api/credits/statement", { bearer: credits })).status, 200);
  await assertScope(await call(app.base, "/api/credits/balance", { bearer: openid }), "credits");
  await assertScope(await call(app.base, "/api/credits/statement", { bearer: openid }), "credits");
  assert.equal((await call(app.base, "/api/services/chat", { bearer: credits, method: "POST", data: { message: "Hi there" } })).status, 200);
  assert.equal((await call(app.base, "/api/services/tts", { bearer: credits, method: "POST", data: { text: "Hello" } })).status, 200);
  await assertScope(await call(app.base, "/api/services/chat", { bearer: openid, method: "POST", data: { message: "Hi there" } }), "credits");
  await assertScope(await call(app.base, "/api/services/tts", { bearer: openid, method: "POST", data: { text: "Hello" } }), "credits");

  const projects = await token("agora:projects"), certificates = await token("agora:certificates");
  assert.equal((await call(app.base, "/api/connections", { bearer: projects })).status, 200);
  assert.notEqual((await call(app.base, "/api/connections/agora/projects", { bearer: projects })).status, 403);
  assert.equal((await call(app.base, "/api/connections/agora", { bearer: projects, method: "DELETE" })).status, 200);
  await assertScope(await call(app.base, "/api/connections", { bearer: credits }), "agora:projects");
  await assertScope(await call(app.base, "/api/connections/agora/projects", { bearer: credits }), "agora:projects");
  await assertScope(await call(app.base, "/api/connections/agora", { bearer: credits, method: "DELETE" }), "agora:projects");
  await assertScope(await call(app.base, "/api/connections/agora/certificate", { bearer: projects, method: "POST", data: { projectId: "p" } }), "agora:certificates");
  assert.notEqual((await call(app.base, "/api/connections/agora/certificate", { bearer: certificates, method: "POST", data: { projectId: "p" } })).status, 403);

  const all = await token("openid credits agora:projects agora:certificates");
  for (const [path, method, data] of [["/api/billing/account", "GET"], ["/api/billing/checkout", "POST", { productId: "builder-pack" }], ["/api/billing/manage", "POST", {}], ["/api/spaces", "POST", { title: "Token room" }], ["/api/spaces/mine", "GET"], ["/api/spaces/plaza/enter", "POST", {}], ["/api/spaces/plaza/heartbeat", "POST"], ["/api/signaling/token", "POST", {}], ["/api/radar", "GET"], ["/api/profile", "POST", profile()], ["/api/auth/logout", "POST", {}]]) {
    const response = await call(app.base, path, { bearer: all, method, data });
    assert.equal(response.status, 403, method + " " + path);
    assert.match((await response.json()).error, /browser/i, path);
  }
  // Public reads are unaffected by a valid token.
  assert.equal((await call(app.base, "/api/people", { bearer: all })).status, 200);
});

test("bearer tokens that are missing, invalid, expired or for another audience get 401 invalid_token; unreachable keys give 503", async (t) => {
  const app = await start(t);
  await assertInvalidToken(await call(app.base, "/api/me", { bearer: "not-a-jwt" }));
  await assertInvalidToken(await call(app.base, "/api/credits/balance", { bearer: await bearerToken(app, { exp: Math.floor(Date.now() / 1000) - 120 }) }));
  await assertInvalidToken(await call(app.base, "/api/credits/balance", { bearer: await bearerToken(app, { aud: "https://other.example" }) }));
  await assertInvalidToken(await call(app.base, "/api/credits/balance", { bearer: await bearerToken(app, {}, { typ: "JWT" }) }));
  await assertInvalidToken(await call(app.base, "/api/platform/credits/reserve", { method: "POST", data: {} }));
  // A bearer request never falls back to the browser cookie.
  const { cookie } = await browserSignIn(app);
  await assertInvalidToken(await call(app.base, "/api/me", { cookie, bearer: "not-a-jwt" }));
  assert.equal((await call(app.base, "/api/me", { bearer: await bearerToken(app) })).status, 200);
  // With the IdP unreachable its keys can't be fetched, so a token can't be checked: 503, not 401.
  const fake = await createFakeIdp({ issuer, clientId: "portal", clientSecret });
  fake.setDown(true);
  const down = await start(t, { fake });
  const unreachable = await call(down.base, "/api/credits/balance", { bearer: await fake.issueAccessToken() });
  assert.equal(unreachable.status, 503);
  assert.equal(unreachable.headers.get("www-authenticate"), null);
});

test("platform credits are priced on the server, per client and service, for clients in the billing file", async (t) => {
  const app = await start(t);
  const sub = app.fake.accountId(), other = app.fake.accountId();
  const vox = await bearerToken(app, { sub, client_id: "vox", scope: "credits" });
  await app.store.ensureAccount(sub);
  await createLedger(app.store).deposit(sub, 30, "Test grant", "grant-route-test");
  const reserve = (bearer, data) => call(app.base, "/api/platform/credits/reserve", { bearer, method: "POST", data });
  const balance = async () => (await (await call(app.base, "/api/credits/balance", { bearer: vox })).json()).credits;
  const held = await reserve(vox, { service: "evaluation", units: 2, idempotencyKey: "route-reserve-000001" });
  assert.equal(held.status, 200);
  const hold = await held.json();
  assert.equal(hold.status, "reserved");
  assert.equal(await balance(), 24, "2 units at 3 credits each");
  assert.equal((await reserve(vox, { service: "evaluation", units: 3, idempotencyKey: "route-reserve-000001" })).status, 409, "a reused key with other units conflicts");
  assert.equal((await reserve(vox, { service: "evaluation", credits: 1000, idempotencyKey: "route-reserve-000002" })).status, 200, "the client can't set the charge; units default to 1");
  assert.equal(await balance(), 21);
  for (const units of [0, 6, 1.5, "2"]) assert.equal((await reserve(vox, { service: "evaluation", units, idempotencyKey: "route-reserve-units-" + String(units).replace(".", "-") })).status, 422, "units " + units);
  assert.equal((await reserve(vox, { service: "analysis", idempotencyKey: "route-reserve-000003" })).status, 422, "another client's service is unknown here");
  assert.equal((await reserve(vox, { service: "nonexistent", idempotencyKey: "route-reserve-000004" })).status, 422);
  assert.equal((await reserve(vox, { service: "evaluation", idempotencyKey: "short" })).status, 422);
  // Another account's token, even from the same client, cannot settle this hold.
  const stranger = await bearerToken(app, { sub: other, client_id: "vox", scope: "credits" });
  assert.equal((await call(app.base, "/api/platform/credits/settle", { bearer: stranger, method: "POST", data: { service: "evaluation", reservationId: hold.id, outcome: "capture" } })).status, 404);
  assert.equal((await call(app.base, "/api/platform/credits/settle", { bearer: vox, method: "POST", data: { service: "evaluation", reservationId: hold.id, outcome: "capture" } })).status, 200);
  const notListed = await reserve(await bearerToken(app, { sub, client_id: "other-app", scope: "credits" }), { service: "evaluation", idempotencyKey: "route-reserve-000005" });
  assert.equal(notListed.status, 403);
  assert.match((await notListed.json()).error, /not allowed/);
  await assertScope(await reserve(await bearerToken(app, { sub, client_id: "vox", scope: "openid" }), { service: "evaluation", idempotencyKey: "route-reserve-000006" }), "credits");
  assert.equal((await reserve(await bearerToken(app, { sub, client_id: "billing-two", scope: "credits" }), { service: "analysis", idempotencyKey: "route-reserve-000007" })).status, 200);
  // Without a billing file, platform billing is off.
  const closed = await start(t, { billingClients: null });
  const off = await call(closed.base, "/api/platform/credits/reserve", { bearer: await bearerToken(closed, { client_id: "vox", scope: "credits" }), method: "POST", data: { service: "evaluation", idempotencyKey: "route-reserve-000008" } });
  assert.equal(off.status, 503);
  assert.equal((await call(closed.base, "/api/platform/credits/settle", { bearer: await bearerToken(closed, { client_id: "vox", scope: "credits" }), method: "POST", data: {} })).status, 503);
});

test("reserves are rate-limited per account at 60 a minute", async (t) => {
  const app = await start(t);
  const sub = app.fake.accountId();
  const vox = await bearerToken(app, { sub, client_id: "vox", scope: "credits" });
  await app.store.ensureAccount(sub);
  await createLedger(app.store).deposit(sub, 1000, "Test grant", "grant-rate-test");
  for (let index = 0; index < 60; index++) assert.equal((await call(app.base, "/api/platform/credits/reserve", { bearer: vox, method: "POST", data: { service: "evaluation", idempotencyKey: "rate-limit-reserve-" + String(index).padStart(3, "0") } })).status, 200, "reserve " + index);
  assert.equal((await call(app.base, "/api/platform/credits/reserve", { bearer: vox, method: "POST", data: { service: "evaluation", idempotencyKey: "rate-limit-reserve-over" } })).status, 429);
});

test("a bearer token reads its own account even with another account's cookie", async (t) => {
  const app = await start(t);
  const x = app.fake.accountId();
  const browser = await browserSignIn(app);
  const browserAccount = (await (await call(app.base, "/api/me", { cookie: browser.cookie })).json()).account.id;
  await createLedger(app.store).deposit(browserAccount, 9, "Browser grant", "grant-browser-account");
  await app.store.ensureAccount(x);
  await createLedger(app.store).deposit(x, 4, "Token grant", "grant-token-account");
  const response = await call(app.base, "/api/credits/balance", { cookie: browser.cookie, bearer: await bearerToken(app, { sub: x, scope: "credits" }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).credits, 4);
});

test("bearer requests skip the same-origin check; unknown /api paths are 404 for them", async (t) => {
  const app = await start(t);
  const token = await bearerToken(app, { scope: "credits" });
  assert.equal((await call(app.base, "/api/services/chat", { bearer: token, method: "POST", data: { message: "Hi there" }, headers: { Origin: "https://app.example", "Sec-Fetch-Site": "cross-site" } })).status, 200);
  const missing = await call(app.base, "/api/nothing-here", { bearer: token });
  assert.equal(missing.status, 404);
  assert.equal((await call(app.base, "/api/credits/balance", { bearer: token, method: "DELETE" })).status, 404);
});

test("over https the session cookie is __Host-house_session", async (t) => {
  const app = await start(t, { siteUrl: "https://portal.example" });
  const response = await call(app.base, "/api/profile", { method: "POST", data: profile("Secure guest") });
  const line = cookieNamed(response, "__Host-house_session");
  assert.match(line, /^__Host-house_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000; Secure$/);
  assert.equal(cookieNamed(response, "house_session"), undefined);
  assert.equal((await (await call(app.base, "/api/me", { cookie: pair(line) })).json()).profile.name, "Secure guest");
  assert.equal((await (await call(app.base, "/api/me", { cookie: "house_session=" + pair(line).split("=")[1] })).json()).profile, null, "the plain name is not read over https");
});

test("back-channel logout with sid and sub ends only that sub's session; without an IdP it answers 503", async (t) => {
  const app = await start(t);
  const a = app.fake.accountId(), b = app.fake.accountId();
  const first = await browserSignIn(app, { claims: { sub: a, sid: "shared-sid" } });
  const second = await browserSignIn(app, { claims: { sub: b, sid: "shared-sid" } });
  const post = async (token) => fetch(app.base + "/auth/backchannel-logout", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: token }) });
  assert.equal((await post(await app.fake.issueLogoutToken({ sub: a, sid: "shared-sid" }))).status, 200);
  assert.equal((await (await call(app.base, "/api/me", { cookie: first.cookie })).json()).account, null);
  assert.equal((await (await call(app.base, "/api/me", { cookie: second.cookie })).json()).account.id, b);
  const missing = await start(t, { idp: null });
  const response = await fetch(missing.base + "/auth/backchannel-logout", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "logout_token=x" });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("auth config gives the front end the issuer and its account page", async (t) => {
  const app = await start(t);
  assert.deepEqual(await (await call(app.base, "/api/auth/config")).json(), { issuer, accountUrl: issuer + "/account" });
});

test("the Portal's own provider sign-in, linking, OAuth server and identity lookup are gone", async (t) => {
  const app = await start(t);
  for (const path of ["/auth/github", "/auth/google/callback", "/auth/agora", "/oauth/authorize", "/oauth/userinfo", "/api/auth/providers", "/api/auth/pending-link", "/api/identity/accounts/account:11111111-1111-4111-8111-111111111111"]) assert.equal((await call(app.base, path)).status, 404, path);
  for (const path of ["/oauth/token", "/api/auth/logout-all", "/api/auth/pending-link"]) assert.ok([404, 405].includes((await call(app.base, path, { method: "POST", data: {} })).status), path);
});

test("a store error during the callback still clears the transaction cookie and fails the sign-in", async (t) => {
  const store = createStore(resolve(root, "data/people.json"), resolve(temporary, "callback-error.json"), { log: () => {} });
  store.takeAuthTransaction = async () => { throw new Error("storage unavailable"); };
  const app = await start(t, { store });
  const response = await call(app.base, "/auth/callback?code=c&state=s", { cookie: "portal_auth=some-transaction-id" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/?signin=failed");
  assert.match(cookieNamed(response, "portal_auth"), /Max-Age=0/);
});
