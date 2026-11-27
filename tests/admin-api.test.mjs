// The admin API's gate (D27 slice 1, docs/integrations.md §3.3.5): Auth's 60-second portal.admin token, the admins from
// Auth's built-in listing, the auth_time windows and the per-admin limits, over HTTP against a real service on the test
// database. Slice 1's routes need DELEGATED_HOST_WORK (Task 4's tests, below); the gate's own tests use a path no route
// has, which answers 404 not_found only once the gate has passed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { adminClientIdFrom } from "../scripts/admin-api.mjs";
import { createAppServer } from "../scripts/serve.mjs";
import { AppError, createStore } from "../scripts/store.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { createSignaling, signalingConfig } from "../scripts/spaces/signaling.mjs";
import { createIdp } from "../scripts/idp.mjs";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { createIntegrationService } from "../scripts/integrations/service.mjs";
import { createFakeIdp } from "./helpers/fake-idp.mjs";
import { fakeManage } from "./helpers/fake-manage.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const root = new URL("../", import.meta.url).pathname;
const issuer = "https://auth.example";
const clientSecret = "portal-admin-test-secret-".padEnd(48, "x");
const siteUrl = "http://localhost:3080";
const env = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACES_SIGNALING_SECRET: "s".repeat(32) };
const ADMIN_CLIENT = "admin";
const OWNER = "ab" + "0".repeat(25) + "1";
const ADMIN = "ab" + "0".repeat(25) + "4";
const ADMIN_TOO = "ab" + "0".repeat(25) + "5";
// Past the gate, a path no route has.
const PASSED = "/api/admin/v1/no-such-route";
const passed = [404, { error: "This admin route was not found.", code: "not_found" }];
const TOKEN = [401, { error: "A valid Agora.Build admin token is required.", code: "token" }];
const UNAVAILABLE = [503, { error: "The admin API is unavailable right now. Try again shortly.", code: "unavailable" }];
const ADMIN_ONLY = [403, { error: "An Agora.Build admin token works only on the admin API, /api/admin/v1." }];
const seconds = () => Math.floor(Date.now() / 1000);
let temporary;
before(async () => { temporary = await mkdtemp(resolve(tmpdir(), "admin-api-")); });
after(() => rm(temporary, { recursive: true, force: true }));
const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });

// A real service on the test database, with the built-in Station Auth seeds (admins ADMIN and ADMIN_TOO), synced unless
// `synced` is false; null (and the test skipped) without PORTAL_TEST_DATABASE_URL. node:test runs a test's after hooks in
// the order they were added, and a push still in flight reads the database, so the database is closed by our own hook, once
// the service's pushes are done.
async function stack(t, { delegatedHostWork = false, synced = true } = {}) {
  const closing = [];
  let service = null;
  t.after(async () => {
    await service?._pushesIdle();
    for (const hook of closing) await hook();
  });
  const db = await testDatabase({ after: (hook) => closing.push(hook) });
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const manage = fakeManage({ delegated: delegatedHostWork });
  const built = manage.seedBuiltIn({ integrations: true, admins: [ADMIN, ADMIN_TOO] });
  const pushes = [];
  service = createIntegrationService({
    repository: createRepository(db), db, manage, stationFetch: { async get() { return { status: 404, body: "" }; } },
    pushFetch: { async post(url, body) { pushes.push({ url, body }); return { status: 202 }; } }, exchange: async () => ({}), log: () => {}, delegatedHostWork
  });
  if (synced) assert.equal(await service.syncBuiltIn(), true);
  await service._pushesIdle();
  return { db, manage, built, service, pushes };
}

// The Portal with the stand-in IdP. `integrations` is the service (or null: no Portal database), `adminClientId` is
// PORTAL_ADMIN_CLIENT_ID (null: unset), `idp: false` is a Portal without Auth's settings.
async function start(t, { integrations = null, adminClientId = ADMIN_CLIENT, delegatedHostWork = false, idp: withIdp = true, ...options } = {}) {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  t.after(() => { if (saved !== undefined) process.env.DATABASE_URL = saved; });
  const fake = await createFakeIdp({ issuer, clientId: "portal", clientSecret });
  const idp = withIdp ? createIdp({ issuer, clientId: "portal", clientSecret, siteUrl, request: fake.request }) : null;
  const store = createStore(resolve(root, "data/people.json"), resolve(temporary, randomBytes(8).toString("hex") + ".json"), { log: () => {} });
  const instance = createAppServer(root, {
    monitor: false, store, idp, siteUrl, billingClients: null, log: () => {}, models: createModelClient(modelConfig({})),
    calls: createAgoraCalls(agoraConfig(env)), signaling: createSignaling(signalingConfig(env)), channelSecret: env.SPACES_SIGNALING_SECRET,
    integrations, portalAdminClientId: adminClientId ?? "", delegatedHostWork: delegatedHostWork ? "1" : "0", ...options
  });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  t.after(() => close(instance));
  return { fake, store, base: "http://127.0.0.1:" + instance.address().port };
}

// A token as Auth's portal.admin exchange issues it (60 s), its passkey sign-in `age` seconds ago; `claims` override it.
const adminToken = (app, { sub = ADMIN, age = 10, ...claims } = {}, opts = {}) => app.fake.issueAccessToken({
  sub, client_id: ADMIN_CLIENT, scope: "portal.admin", acr: "urn:agora:mfa", auth_time: seconds() - age, exp: seconds() + 60, ...claims
}, opts);
const call = (app, path, { bearer, cookie, method = "GET", data, headers = {} } = {}) => fetch(app.base + path, {
  method, redirect: "manual",
  headers: { ...(bearer ? { Authorization: "Bearer " + bearer } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
  ...(data !== undefined ? { body: JSON.stringify(data) } : {})
});
const answer = async (response) => [response.status, await response.json()];
const pair = (line) => line.split(";")[0];
const cookieNamed = (response, name) => response.headers.getSetCookie().find((line) => line.startsWith(name + "="));
// Signs in through /auth/login, the stand-in IdP and /auth/callback, as a browser does; returns the session cookie.
async function signIn(app, sub) {
  const login = await call(app, "/auth/login?returnTo=%2Faccount%2F");
  const transaction = cookieNamed(login, "portal_auth");
  const callback = new URL(app.fake.authorize(login.headers.get("location"), { sub }));
  const back = await call(app, callback.pathname + callback.search, { cookie: pair(transaction) });
  return { sub, cookie: pair(cookieNamed(back, "house_session")) };
}

test("without PORTAL_ADMIN_CLIENT_ID, or without the Portal database, every admin path is today's 404, a valid admin token included", async (t) => {
  const s = await stack(t);
  if (!s) return;
  for (const [label, settings] of [["no client ID", { integrations: s.service, adminClientId: null }], ["no database", { integrations: null }]]) {
    const app = await start(t, settings);
    const token = await adminToken(app);
    for (const [method, path] of [["GET", "/api/admin/v1/bindings?account=" + OWNER], ["POST", "/api/admin/v1/bindings/release"], ["GET", "/api/admin/v1"], ["DELETE", PASSED]]) {
      for (const bearer of [token, undefined, "not.a.jwt"]) {
        const response = await call(app, path, { method, bearer, ...(method === "POST" ? { data: {} } : {}) });
        assert.deepEqual(await answer(response), [404, { error: "This page or service was not found." }], label + ": " + method + " " + path);
      }
    }
  }
});

test("a valid admin token passes the gate, portal.admin among other scopes too, whatever DELEGATED_HOST_WORK is", async (t) => {
  const s = await stack(t);
  if (!s) return;
  for (const delegatedHostWork of [false, true]) {
    const app = await start(t, { integrations: s.service, delegatedHostWork });
    assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app) })), passed);
    assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app, { scope: "openid portal.admin" }) })), passed);
    assert.deepEqual(await answer(await call(app, "/api/admin/v1", { method: "POST", bearer: await adminToken(app) })), passed);
  }
});

test("a missing, malformed or invalid token is 401 token, and a cookie never counts", async (t) => {
  const s = await stack(t);
  if (!s) return;
  const app = await start(t, { integrations: s.service });
  const past = seconds() - 120;
  const refused = {
    "no token": undefined,
    "garbage": "not.a.jwt",
    "wrong typ": await adminToken(app, {}, { typ: "JWT" }),
    "HS256": await adminToken(app, {}, { alg: "HS256" }),
    "wrong issuer": await adminToken(app, { iss: "https://evil.example" }),
    "wrong audience": await adminToken(app, { aud: "https://agora.build" }),
    "expired": await adminToken(app, { iat: past - 60, exp: past }),
    "sub not an account": await adminToken(app, { sub: "s-" + "0".repeat(26) }),
    "no auth_time": await adminToken(app, {}, { omit: ["auth_time"] }),
    "auth_time not a number": await adminToken(app, { auth_time: String(seconds()) }),
    "auth_time two minutes ahead": await adminToken(app, { auth_time: seconds() + 120 })
  };
  for (const [label, bearer] of Object.entries(refused)) {
    for (const method of ["GET", "POST"]) {
      const response = await call(app, PASSED, { method, bearer });
      assert.equal(response.headers.get("www-authenticate"), 'Bearer error="invalid_token"', label);
      assert.deepEqual(await answer(response), TOKEN, label + " " + method);
    }
  }
  assert.deepEqual(await answer(await call(app, PASSED, { headers: { Authorization: "Basic YWRtaW46eA==" } })), TOKEN, "not a bearer token");
  // A signed-in admin's session cookie is never a credential here; with a token, the token decides.
  const { cookie } = await signIn(app, ADMIN);
  assert.deepEqual(await answer(await call(app, PASSED, { cookie })), TOKEN);
  assert.deepEqual(await answer(await call(app, PASSED, { cookie, bearer: await adminToken(app) })), passed);
});

test("a token that isn't the admin client's portal.admin token at the MFA level is 403 insufficient_scope", async (t) => {
  const s = await stack(t);
  if (!s) return;
  const app = await start(t, { integrations: s.service });
  const insufficient = [403, { error: "This token is not an Agora.Build admin token.", code: "insufficient_scope" }];
  for (const [label, claims] of [["another client", { client_id: "portal" }], ["no portal.admin", { scope: "credits" }], ["no scope", { scope: undefined }], ["no acr", { acr: undefined }], ["the federated level", { acr: "urn:agora:fed" }]]) {
    const response = await call(app, PASSED, { bearer: await adminToken(app, claims) });
    assert.equal(response.headers.get("www-authenticate"), 'Bearer error="insufficient_scope", scope="portal.admin"', label);
    assert.deepEqual(await answer(response), insufficient, label);
  }
  // Checked before the admin set: a stranger's token of another client is insufficient_scope, not not_admin.
  assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app, { sub: OWNER, client_id: "portal" }) })), insufficient);
});

test("only an admin Auth lists for an active built-in Station passes: none before the first sync, and one removed is refused after the next sync", async (t) => {
  const s = await stack(t, { synced: false });
  if (!s) return;
  const app = await start(t, { integrations: s.service });
  const notAdmin = [403, { error: "This account is not an Agora.Build admin.", code: "not_admin" }];
  assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app) })), notAdmin, "before the first sync there are none");
  await s.service.syncBuiltIn();
  assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app) })), passed);
  assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app, { sub: OWNER }) })), notAdmin, "an ordinary account");
  s.built.admins = [ADMIN_TOO];
  assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app) })), passed, "until the next sync");
  await s.service.syncBuiltIn();
  assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app) })), notAdmin, "removed at Auth: refused after the sync");
  assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app, { sub: ADMIN_TOO }) })), passed);
  // A non-admin's old token is not_admin, not mfa_required: a fresh sign-in wouldn't help.
  assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app, { sub: OWNER, age: 2000 }) })), notAdmin);
});

test("a read rests on a passkey sign-in up to 900 s old and a change up to 300 s; older is 401 mfa_required", async (t) => {
  const s = await stack(t);
  if (!s) return;
  const app = await start(t, { integrations: s.service });
  const mfa = (max) => ({ max, expected: [401, { error: "Sign in again with your passkey to continue.", code: "mfa_required" }] });
  const cases = [
    ["GET", 10, null], ["GET", -25, null], ["GET", 899, null], ["GET", 901, mfa(900)],
    ["POST", 10, null], ["POST", 299, null], ["POST", 301, mfa(300)], ["POST", 899, mfa(300)], ["DELETE", 301, mfa(300)]
  ];
  for (const [method, age, refusal] of cases) {
    const response = await call(app, PASSED, { method, bearer: await adminToken(app, { age }) });
    if (!refusal) { assert.deepEqual(await answer(response), passed, method + " " + age); continue; }
    assert.equal(response.headers.get("www-authenticate"), 'Bearer error="insufficient_user_authentication", error_description="A more recent passkey sign-in is required", max_age=' + refusal.max, method + " " + age);
    assert.deepEqual(await answer(response), refusal.expected, method + " " + age);
  }
});

test("each admin may make 120 reads and 30 changes a minute, then 429 rate_limited; refused requests spend nothing", async (t) => {
  const s = await stack(t);
  if (!s) return;
  const app = await start(t, { integrations: s.service });
  const bearer = await adminToken(app);
  for (let n = 1; n <= 120; n += 1) assert.equal((await call(app, PASSED, { bearer })).status, 404, "read " + n);
  const limited = await call(app, PASSED, { bearer });
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.deepEqual(await answer(limited), [429, { error: "Too many admin requests. Try again in a minute.", code: "rate_limited" }]);
  for (let n = 1; n <= 30; n += 1) assert.equal((await call(app, PASSED, { bearer, method: "POST" })).status, 404, "change " + n);
  assert.equal((await call(app, PASSED, { bearer, method: "POST" })).status, 429);
  // The other admin has their own budgets, and a refused request (here a stale change) doesn't count against them.
  const stale = await adminToken(app, { sub: ADMIN_TOO, age: 400 });
  for (let n = 1; n <= 30; n += 1) assert.equal((await call(app, PASSED, { bearer: stale, method: "POST" })).status, 401);
  assert.equal((await call(app, PASSED, { bearer: await adminToken(app, { sub: ADMIN_TOO }), method: "POST" })).status, 404);
  assert.equal((await call(app, PASSED, { bearer: await adminToken(app, { sub: ADMIN_TOO }) })).status, 404);
});

test("with Auth's settings missing or the Portal database down, the gate answers 503 unavailable", async (t) => {
  const s = await stack(t);
  if (!s) return;
  const noIdp = await start(t, { integrations: s.service, idp: false });
  assert.deepEqual(await answer(await call(noIdp, PASSED, { bearer: "x.y.z" })), UNAVAILABLE);
  const down = await start(t, {
    integrations: s.service,
    integrationStack: { service: null, ready: async () => { throw new AppError(503, "Stations and integrations are unavailable right now. Try again shortly."); }, nudge() {}, close: async () => {} }
  });
  assert.deepEqual(await answer(await call(down, PASSED, { bearer: await adminToken(down) })), UNAVAILABLE);
});

// Routes an admin token reaches today (a valid token with a sub): each now refuses it before anything else.
const OTHER_ROUTES = [
  ["GET", "/api/v1/me"], ["GET", "/api/me"], ["GET", "/api/v1/integrations"], ["GET", "/api/v1/credits/balance"], ["GET", "/api/v1/connections"],
  ["POST", "/api/v1/stations/reports"], ["GET", "/api/v1/stations/changes"], ["POST", "/api/v1/platform/credits/reserve"], ["GET", "/api/people"], ["GET", "/api/stations"]
];

test("an admin token works on no other route and never makes an account", async (t) => {
  for (const adminClientId of [ADMIN_CLIENT, null]) {
    const app = await start(t, { adminClientId });
    // The scope alone makes a token an admin token; with the setting, so does the admin client.
    const tokens = [await adminToken(app), await adminToken(app, { client_id: "astation" })];
    if (adminClientId) tokens.push(await adminToken(app, { scope: "credits" }));
    for (const bearer of tokens) {
      for (const [method, path] of OTHER_ROUTES) {
        assert.deepEqual(await answer(await call(app, path, { method, bearer, ...(method === "POST" ? { data: {} } : {}) })), ADMIN_ONLY, String(adminClientId) + " " + method + " " + path);
      }
    }
    assert.equal(((await app.store.snapshot()).accounts ?? []).some((account) => account.id === ADMIN), false, "no account is made for it");
    // Without the setting, the admin client's token without portal.admin is an ordinary app token, as today.
    if (!adminClientId) assert.equal((await call(app, "/api/v1/me", { bearer: await adminToken(app, { sub: OWNER, scope: "credits" }) })).status, 200);
  }
});

// Fix round 1: the database failing after the service was ready, a misconfigured client ID, and the odd requests.
// A log that keeps the admin API's lines only (the Portal logs others at startup).
const adminLog = (lines) => (line) => { if (line.startsWith("The admin API")) lines.push(line); };

test("a database that fails after the service was ready is 503 unavailable, logged by its code only", async (t) => {
  const failures = [
    ["a connection refused", Object.assign(new Error("connect ECONNREFUSED db.internal.example:5432"), { code: "ECONNREFUSED" }), "ECONNREFUSED"],
    ["a server shutdown", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }), "57P01"],
    ["an error with no code", new TypeError("Cannot read properties of undefined (reading 'query') at db.internal.example"), "error"],
    ["a code that isn't a plain one", Object.assign(new Error("odd"), { code: "has a space and db.internal.example" }), "error"]
  ];
  for (const [label, failure, reason] of failures) {
    const lines = [];
    let checks = 0;
    // The first check answers (ready() succeeded and the first request passed); every later one fails, as in an outage.
    const app = await start(t, { integrations: { isPortalAdmin: async () => { checks += 1; if (checks === 1) return true; throw failure; } }, log: adminLog(lines) });
    const bearer = await adminToken(app);
    assert.deepEqual(await answer(await call(app, PASSED, { bearer })), passed, label);
    for (const method of ["GET", "POST"]) {
      const response = await call(app, PASSED, { method, bearer });
      assert.equal(response.headers.get("www-authenticate"), null, label);
      assert.deepEqual(await answer(response), UNAVAILABLE, label + " " + method);
    }
    assert.deepEqual(lines, Array(2).fill("The admin API could not check the admins: " + reason + "."), label);
    assert.equal(lines.some((line) => line.includes(bearer) || line.includes("db.internal")), false, label + ": nothing but the code is logged");
  }
});

test("PORTAL_ADMIN_CLIENT_ID that is no client ID, this Portal's own or a Station report client's turns the admin API off, logged without the value", () => {
  const lines = [];
  const log = (line) => lines.push(line);
  const own = "portal-own-client-id";
  const station = "s-0123456789abcdefghjkmnpqrs";
  assert.equal(adminClientIdFrom("  admin-client  ", log, own), "admin-client");
  assert.equal(adminClientIdFrom("", log, own), null);
  assert.equal(adminClientIdFrom(undefined, log, own), null);
  assert.equal(adminClientIdFrom("admin", log), "admin");
  assert.deepEqual(lines, [], "an unset or usable value logs nothing");
  assert.equal(adminClientIdFrom(own, log, own), null);
  assert.equal(adminClientIdFrom(station, log, own), null);
  assert.equal(adminClientIdFrom("has a space", log, own), null);
  assert.deepEqual(lines, [
    "The admin API is off: PORTAL_ADMIN_CLIENT_ID is this Portal's own client ID.",
    "The admin API is off: PORTAL_ADMIN_CLIENT_ID is a Station report client ID.",
    "The admin API is off: PORTAL_ADMIN_CLIENT_ID is not a client ID."
  ]);
  // Only the exact Station report client shape; without the Portal's own ID to compare, that one is a client ID.
  assert.equal(adminClientIdFrom("s-admin", log, own), "s-admin");
  assert.equal(adminClientIdFrom(own, log, null), own);
});

test("a PORTAL_ADMIN_CLIENT_ID that is the Portal's own client ID or a Station report client's leaves the admin API off, 404, and ordinary tokens unchanged", async (t) => {
  const s = await stack(t);
  if (!s) return;
  for (const [label, adminClientId] of [["the Portal's own client", "portal"], ["a Station report client", "s-" + "0".repeat(26)]]) {
    const lines = [];
    const app = await start(t, { integrations: s.service, adminClientId, log: adminLog(lines) });
    assert.equal(lines.length, 1, label);
    assert.match(lines[0], /^The admin API is off: PORTAL_ADMIN_CLIENT_ID is /, label);
    assert.equal(lines[0].includes(adminClientId), false, label + ": the value is not logged");
    // The token the admin API would have taken, and the ordinary app token of the same client.
    const token = await adminToken(app, { client_id: adminClientId });
    assert.deepEqual(await answer(await call(app, PASSED, { bearer: token })), [404, { error: "This page or service was not found." }], label);
    assert.deepEqual(await answer(await call(app, PASSED, { bearer: await adminToken(app, { client_id: "portal", scope: "credits" }) })), [404, { error: "This page or service was not found." }], label);
    // With the admin API off, the Portal's own client's ordinary token is an ordinary token: not an "admin token".
    assert.equal((await call(app, "/api/v1/me", { bearer: await adminToken(app, { sub: OWNER, client_id: "portal", scope: "credits" }) })).status, 200, label);
  }
});

const raw = (app, path, bearer) => new Promise((done, fail) => {
  const { hostname, port } = new URL(app.base);
  const sent = httpRequest({ hostname, port, path, method: "GET", headers: { Authorization: "Bearer " + bearer } }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => { try { done([response.statusCode, JSON.parse(Buffer.concat(chunks).toString()), response.headers]); } catch (error) { fail(error); } });
  });
  sent.on("error", fail);
  sent.end();
});

test("HEAD and OPTIONS are changes, and no other path is ever taken for the admin API or for a route an admin token could use", async (t) => {
  const s = await stack(t);
  if (!s) return;
  const app = await start(t, { integrations: s.service });
  const challenge = 'Bearer error="insufficient_user_authentication", error_description="A more recent passkey sign-in is required", max_age=300';
  // Any method but GET is a change: a 301 s old sign-in is a read's to use, not a change's.
  assert.equal((await call(app, PASSED, { bearer: await adminToken(app, { age: 301 }) })).status, 404, "a GET of that age passes");
  for (const method of ["HEAD", "OPTIONS", "PATCH"]) {
    const stale = await call(app, PASSED, { method, bearer: await adminToken(app, { age: 301 }) });
    assert.equal(stale.status, 401, method);
    assert.equal(stale.headers.get("www-authenticate"), challenge, method);
    assert.equal((await call(app, PASSED, { method, bearer: await adminToken(app, { age: 299 }) })).status, 404, method);
    assert.equal((await call(app, PASSED, { method })).status, 401, method + " without a token");
  }
  // The versioned prefix never reaches the admin API, with a token or without.
  const bearer = await adminToken(app);
  for (const path of ["/api/v1/admin/v1/x", "/api/v1/admin/v1", "/api/v1/admin/v1/"]) {
    for (const token of [bearer, undefined]) {
      const [status, body] = await answer(await call(app, path, { bearer: token }));
      assert.equal(status, 404, path);
      assert.match(body.error, /^This API was not found\./, path);
      assert.equal(body.code, undefined, path);
    }
  }
  // Look-alikes are not the admin API: an admin token is refused as on any other route, and a trailing slash is its own.
  for (const path of ["/api/admin/v1x", "/api/admin/v1x/y", "/api/admin/v10", "/api/admin", "/api/admin/", "/api//admin/v1/x", "/api/admin/v1%2Fx"]) {
    assert.deepEqual(await answer(await call(app, path, { bearer })), ADMIN_ONLY, path);
  }
  assert.deepEqual(await answer(await call(app, "/api/admin/v1/", { bearer })), passed);
  // Dot segments are resolved before routing, so a path out of the admin API lands on that route, which refuses the token;
  // an encoded slash is no segment at all and stays inside the admin API.
  for (const path of ["/api/admin/v1/%2e%2e/%2e%2e/v1/me", "/api/admin/v1/%2E%2e/%2e%2E/v1/me", "/api/admin/v1/../../v1/me", "/api/admin/v1/%2e%2e/%2e%2e/me", "/api/admin/v1/..%2f..%2fv1/me"]) {
    const [status, body] = await raw(app, path, bearer);
    const expected = path.includes("%2f") ? passed : ADMIN_ONLY;
    assert.deepEqual([status, body], expected, "raw " + path);
  }
  // What fetch normalises itself reaches the same answer.
  assert.deepEqual(await answer(await call(app, "/api/admin/v1/%2e%2e/%2e%2e/v1/me", { bearer })), ADMIN_ONLY);
  // A path into the admin API through a dot segment is judged as the path it resolves to.
  const [status, body] = await raw(app, "/api/x/../admin/v1/y", bearer);
  assert.deepEqual([status, body], passed);
});

test("a request on an admin path makes no account and sets no cookie, whoever sends it", async (t) => {
  const s = await stack(t);
  if (!s) return;
  const app = await start(t, { integrations: s.service });
  const tokens = {
    "an admin": await adminToken(app),
    "an admin's stale token": await adminToken(app, { age: 2000 }),
    "a stranger with an admin token": await adminToken(app, { sub: OWNER }),
    "an ordinary app token": await adminToken(app, { sub: OWNER, client_id: "portal", scope: "credits" }),
    "no token": undefined
  };
  for (const [label, bearer] of Object.entries(tokens)) {
    for (const method of ["GET", "POST", "HEAD"]) {
      const response = await call(app, PASSED, { method, bearer, cookie: "house_session=" + "0".repeat(43) });
      assert.deepEqual(response.headers.getSetCookie(), [], label + " " + method);
      await response.arrayBuffer();
    }
  }
  const { accounts = [] } = await app.store.snapshot();
  assert.deepEqual(accounts.filter((account) => [ADMIN, ADMIN_TOO, OWNER].includes(account.id)), [], "no account is made");
});

// Slice 1's routes (D27, DELEGATED_HOST_WORK=1): reading bindings, releasing one, and reading a release, as the admin site
// calls them.
const BODY = (error) => ({ error, code: "body" });

test("with the setting on: GET bindings, POST bindings/release and GET releases/<id> over HTTP", async (t) => {
  const s = await stack(t, { delegatedHostWork: true });
  if (!s) return;
  const app = await start(t, { integrations: s.service, delegatedHostWork: true });
  const genesisHash = "b".repeat(64);
  await s.service.report(s.built.reportClientId, { state: "binding_changed", reportId: "binding_changed:" + "1".repeat(64), account: OWNER, accountId: "r9:account-1", genesisHash, bindingId: "bind-1", version: 3, bindingState: "bound" });
  const read = await adminToken(app);
  const listed = await call(app, "/api/admin/v1/bindings?account=" + OWNER, { bearer: read });
  assert.equal(listed.status, 200);
  const { bindings } = await listed.json();
  assert.deepEqual(bindings.map((entry) => [entry.stationId, entry.account, entry.accountState, entry.accountId, entry.bindingId, entry.version, entry.bindingState, entry.releases]), [[s.built.id, OWNER, "unknown", "r9:account-1", "bind-1", 3, "bound", []]]);
  assert.equal((await (await call(app, "/api/admin/v1/bindings?accountId=" + encodeURIComponent("r9:account-1"), { bearer: read })).json()).bindings.length, 1);
  const query = [400, { error: "Search by exactly one of account (an ab… account ID) or accountId (an R9 account ID).", code: "query" }];
  for (const search of ["", "?account=", "?account=" + OWNER + "&accountId=r9", "?account=" + OWNER + "&account=" + OWNER, "?owner=" + OWNER, "?account=" + OWNER + "&page=2"]) {
    assert.deepEqual(await answer(await call(app, "/api/admin/v1/bindings" + search, { bearer: read })), query, search);
  }
  const data = { stationId: s.built.id, accountId: "r9:account-1", genesisHash, bindingId: "bind-1", version: 3, reason: "Lost account; ticket 4821.", key: "form:0001" };
  const made = await call(app, "/api/admin/v1/bindings/release", { method: "POST", bearer: await adminToken(app), data });
  assert.equal(made.status, 201);
  const created = await made.json();
  assert.deepEqual(Object.keys(created), ["release"], "the same wrapper as GET /releases/<id>");
  const { release } = created;
  assert.deepEqual([release.state, release.actor, release.account, release.reason], ["pending", ADMIN, OWNER, "Lost account; ticket 4821."]);
  assert.deepEqual(await answer(await call(app, "/api/admin/v1/bindings/release", { method: "POST", bearer: await adminToken(app), data })), [200, { release }], "a retry with the form's key");
  assert.deepEqual(await answer(await call(app, "/api/admin/v1/bindings/release", { method: "POST", bearer: await adminToken(app), data: { ...data, key: "form:0002" } })), [200, { release }], "the pending release, under another key");
  assert.deepEqual(await answer(await call(app, "/api/admin/v1/releases/" + release.releaseId, { bearer: read })), [200, { release }]);
  for (const id of ["rl-" + "0".repeat(26), "nope", release.releaseId.toUpperCase()]) {
    assert.deepEqual(await answer(await call(app, "/api/admin/v1/releases/" + id, { bearer: read })), [404, { error: "This release was not found.", code: "release" }], id);
  }
  assert.deepEqual((await (await call(app, "/api/admin/v1/bindings?account=" + OWNER, { bearer: read })).json()).bindings[0].releases, [release]);
  // The body: JSON, an object, at most 16 KB.
  const raw = async (contentType, payload) => answer(await fetch(app.base + "/api/admin/v1/bindings/release", { method: "POST", headers: { Authorization: "Bearer " + read, "Content-Type": contentType }, body: payload }));
  assert.deepEqual(await raw("text/plain", "{}"), [415, BODY("Send JSON for this request.")]);
  assert.deepEqual(await raw("application/json", "[1]"), [400, BODY("Send { stationId, accountId, genesisHash, bindingId, version, reason, key }.")]);
  assert.deepEqual(await raw("application/json", "{"), [400, BODY("Send { stationId, accountId, genesisHash, bindingId, version, reason, key }.")]);
  assert.deepEqual(await raw("application/json", JSON.stringify({ ...data, reason: "x".repeat(17000) })), [413, BODY("This request is too large.")]);
  // A wrong method on a route's path is no route.
  assert.deepEqual(await answer(await call(app, "/api/admin/v1/bindings", { method: "POST", bearer: read, data: {} })), passed);
  // The built-in Station's feed has the change.
  const feed = await s.service.changes(s.built.reportClientId, "0");
  assert.deepEqual(feed.changes.filter((change) => change.kind === "binding_released").map((change) => change.releaseId), [release.releaseId]);
});

test("with the setting off the three routes are 404 not_found once the gate has passed, and nothing is written", async (t) => {
  const s = await stack(t);
  if (!s) return;
  const app = await start(t, { integrations: s.service, delegatedHostWork: false });
  const routes = [
    ["GET", "/api/admin/v1/bindings?account=" + OWNER],
    ["POST", "/api/admin/v1/bindings/release", { stationId: s.built.id, accountId: "r9:account-1", genesisHash: "b".repeat(64), bindingId: "bind-1", version: 3, reason: "Lost account.", key: "form:0001" }],
    ["GET", "/api/admin/v1/releases/rl-" + "0".repeat(26)]
  ];
  for (const [method, path, data] of routes) {
    assert.deepEqual(await answer(await call(app, path, { method, bearer: await adminToken(app), data })), passed, method + " " + path);
    assert.deepEqual(await answer(await call(app, path, { method, data })), TOKEN, "the gate still comes first: " + path);
  }
  assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM admin_actions")).rows[0].n, 0);
});

test("an oversized body is 413 body, read through the 16 KB limit, and writes no admin_actions row, whether its length is declared or streamed", async (t) => {
  const s = await stack(t, { delegatedHostWork: true });
  if (!s) return;
  const app = await start(t, { integrations: s.service, delegatedHostWork: true });
  const bearer = await adminToken(app);
  const data = { stationId: s.built.id, accountId: "r9:account-1", genesisHash: "b".repeat(64), bindingId: "bind-1", version: 3, reason: "Lost account.", key: "form:0001" };
  const actions = async () => (await s.db.pool.query("SELECT count(*)::int AS n FROM admin_actions")).rows[0].n;
  const tooLarge = [413, BODY("This request is too large.")];
  // A declared length over the limit: refused before anything is read.
  assert.deepEqual(await answer(await call(app, "/api/admin/v1/bindings/release", { method: "POST", bearer, data: { ...data, stationId: "s".repeat(20000) } })), tooLarge);
  // A streamed body (no length declared) is cut off at the limit as it is read.
  const chunks = [Buffer.from('{"reason":"'), Buffer.alloc(9000, "x"), Buffer.alloc(9000, "x"), Buffer.from('"}')];
  const streamed = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  const response = await fetch(app.base + "/api/admin/v1/bindings/release", { method: "POST", duplex: "half", headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" }, body: streamed });
  assert.deepEqual(await answer(response), tooLarge);
  assert.equal(await actions(), 0, "nothing reached admin_actions");
});

test("a database failure inside a route is 503 unavailable, logged by its code only, and a refusal of the service passes through unchanged", async (t) => {
  const s = await stack(t, { delegatedHostWork: true });
  if (!s) return;
  const data = { stationId: s.built.id, accountId: "r9:account-1", genesisHash: "b".repeat(64), bindingId: "bind-1", version: 3, reason: "Lost account.", key: "form:0001" };
  const requests = [["GET", "/api/admin/v1/bindings?account=" + OWNER], ["POST", "/api/admin/v1/bindings/release", data], ["GET", "/api/admin/v1/releases/rl-" + "0".repeat(26)]];
  const failures = [
    ["a connection refused", Object.assign(new Error("connect ECONNREFUSED db.internal.example:5432 password=hunter2"), { code: "ECONNREFUSED" }), "ECONNREFUSED"],
    ["an error with no code", new TypeError("Cannot read properties of undefined (reading 'query') at db.internal.example"), "error"]
  ];
  for (const [label, failure, reason] of failures) {
    const lines = [];
    const down = () => { throw failure; };
    const app = await start(t, { integrations: { ...s.service, adminBindings: down, release: down, releaseBinding: down }, delegatedHostWork: true, log: adminLog(lines) });
    const bearer = await adminToken(app);
    for (const [method, path, payload] of requests) {
      const response = await call(app, path, { method, bearer, data: payload });
      assert.equal(response.headers.get("www-authenticate"), null, label);
      assert.deepEqual(await answer(response), UNAVAILABLE, label + ": " + method + " " + path);
    }
    assert.deepEqual(lines, Array(3).fill("The admin API could not answer: " + reason + "."), label);
    assert.equal(lines.some((line) => line.includes(bearer) || line.includes("db.internal") || line.includes("hunter2")), false, label + ": nothing but the code is logged");
  }
  // The service's own refusals are its answer, not a 503, and are not logged.
  const lines = [];
  const app = await start(t, { integrations: s.service, delegatedHostWork: true, log: adminLog(lines) });
  assert.deepEqual(await answer(await call(app, "/api/admin/v1/bindings", { bearer: await adminToken(app) })), [400, { error: "Search by exactly one of account (an ab… account ID) or accountId (an R9 account ID).", code: "query" }]);
  assert.deepEqual(await answer(await call(app, "/api/admin/v1/releases/nope", { bearer: await adminToken(app) })), [404, { error: "This release was not found.", code: "release" }]);
  assert.deepEqual(lines, []);
});
