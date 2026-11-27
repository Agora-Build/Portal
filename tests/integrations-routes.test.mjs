// The Stations and integrations HTTP routes (browser and /api/v1), against a real service on the test database, the
// stand-in IdP and an in-memory Auth /manage/v1.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAppServer } from "../scripts/serve.mjs";
import { AppError, createStore } from "../scripts/store.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { createSignaling, signalingConfig } from "../scripts/spaces/signaling.mjs";
import { createIdp } from "../scripts/idp.mjs";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { createIntegrationService } from "../scripts/integrations/service.mjs";
import { createIntegrationStack, integrationsFromEnv, readyIntegrations } from "../scripts/integrations/routes.mjs";
import { ManageError } from "../scripts/integrations/auth-manage.mjs";
import { accountId, createFakeIdp } from "./helpers/fake-idp.mjs";
import { BUILT_IN_REPORT_CLIENT, fakeManage } from "./helpers/fake-manage.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const root = new URL("../", import.meta.url).pathname;
const issuer = "https://auth.example";
const clientSecret = "portal-route-test-secret-".padEnd(48, "x");
const siteUrl = "http://localhost:3080";
const env = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACES_SIGNALING_SECRET: "s".repeat(32) };
const R9 = "a".repeat(64);
const UNAVAILABLE = "Stations and integrations need the Portal database.";
const profile = (name = "Route tester") => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });
const publicJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
const waitFor = async (check, label, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
let temporary;
before(async () => { temporary = await mkdtemp(resolve(tmpdir(), "integrations-routes-")); });
after(() => rm(temporary, { recursive: true, force: true }));

// DATABASE_URL is unset for each test (and restored afterwards), so no server builds a stack from the environment.
function withoutDatabaseUrl(t) {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  t.after(() => { if (saved !== undefined) process.env.DATABASE_URL = saved; });
}

// The server's own log lines about the stack, not the unrelated ones it writes at startup.
const stackLines = (app) => app.logs.filter((line) => !line.startsWith("Agora Console"));
const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });
async function start(t, options = {}) {
  withoutDatabaseUrl(t);
  const fake = await createFakeIdp({ issuer, clientId: "portal", clientSecret });
  const idp = createIdp({ issuer, clientId: "portal", clientSecret, siteUrl, request: fake.request });
  const store = createStore(resolve(root, "data/people.json"), resolve(temporary, randomBytes(8).toString("hex") + ".json"), { log: () => {} });
  const logs = [];
  const instance = createAppServer(root, {
    monitor: false, store, idp, siteUrl, billingClients: null, log: (line) => logs.push(line), models: createModelClient(modelConfig({})),
    calls: createAgoraCalls(agoraConfig(env)), signaling: createSignaling(signalingConfig(env)), channelSecret: env.SPACES_SIGNALING_SECRET,
    ...("integrations" in options ? { integrations: options.integrations } : {}),
    ...("integrationNudge" in options ? { integrationNudge: options.integrationNudge } : {}),
    ...("integrationStack" in options ? { integrationStack: options.integrationStack } : {}),
    ...("integrationRetryMs" in options ? { integrationRetryMs: options.integrationRetryMs } : {}),
    ...("trustProxy" in options ? { trustProxy: options.trustProxy } : {}),
    ...("delegatedHostWork" in options ? { delegatedHostWork: options.delegatedHostWork } : {}),
    ...(options.log ? { log: (line) => { logs.push(line); options.log(line); } } : {})
  });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  t.after(() => close(instance));
  return { fake, idp, store, logs, server: instance, stop: () => close(instance), base: "http://127.0.0.1:" + instance.address().port };
}

// A real service on the test database; null (and the test skipped) without PORTAL_TEST_DATABASE_URL.
// `now` is the service's clock (and Auth's), for the tests that move it.
async function stack(t, { delegatedHostWork = false, authDelegated = delegatedHostWork, now } = {}) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const manage = fakeManage({ delegated: authDelegated, ...(now ? { now } : {}) });
  const served = { status: 200, body: "" };
  const stationFetch = { async get() { return { ...served }; } };
  const pushes = [];
  const pushFetch = { async post(url, body) { pushes.push({ url, body }); return { status: 202 }; } };
  const exchanges = [];
  const exchange = async (idToken, origin) => { exchanges.push({ idToken, origin }); return { accessToken: "station-read-token", expiresIn: 300 }; };
  const service = createIntegrationService({ repository: createRepository(db), db, manage, stationFetch, pushFetch, exchange, log: () => {}, delegatedHostWork, ...(now ? { now } : {}) });
  t.after(() => service._pushesIdle());
  return { db, manage, served, service, exchanges, pushes };
}

const call = (base, path, { cookie, bearer, method = "GET", data, headers = {} } = {}) => fetch(base + path, {
  method, redirect: "manual",
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: "Bearer " + bearer } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
  ...(data !== undefined ? { body: JSON.stringify(data) } : {})
});
const pair = (line) => line.split(";")[0];
const cookieNamed = (response, name) => response.headers.getSetCookie().find((line) => line.startsWith(name + "="));

// Signs in through /auth/login → the stand-in IdP → /auth/callback, as a browser would; returns the session cookie.
async function signIn(app, sub = accountId()) {
  const login = await call(app.base, "/auth/login?returnTo=%2Faccount%2F");
  const transaction = cookieNamed(login, "portal_auth");
  const callback = new URL(app.fake.authorize(login.headers.get("location"), { sub }));
  const back = await call(app.base, callback.pathname + callback.search, { cookie: pair(transaction) });
  return { sub, cookie: pair(cookieNamed(back, "house_session")) };
}
const assertScope = (response, scope) => {
  assert.equal(response.status, 403, "expected insufficient_scope for " + scope);
  assert.match(response.headers.get("www-authenticate"), new RegExp('^Bearer error="insufficient_scope", scope="' + scope.replace(".", "\\.") + '"'));
};

// Registers a Station for the signed-in account through the browser routes.
async function registerStation(app, integrations, cookie, origin = "https://one.example") {
  const challenge = await call(app.base, "/api/stations/challenges", { cookie, method: "POST", data: { origin } });
  assert.equal(challenge.status, 201);
  const issued = await challenge.json();
  integrations.served.body = issued.value;
  const registered = await call(app.base, "/api/stations", { cookie, method: "POST", data: { challengeId: issued.challengeId, reportKey: publicJwk() } });
  assert.equal(registered.status, 201);
  return { issued, station: await registered.json() };
}
async function createIntegration(app, cookie, stationId) {
  const created = await call(app.base, "/api/integrations", { cookie, method: "POST", data: { stationId, name: "My app", scopes: ["agent.view"], publicJwk: publicJwk() } });
  assert.equal(created.status, 201);
  return created.json();
}

test("without the Portal database every Stations and integrations route answers 503", async (t) => {
  const app = await start(t);
  const { cookie } = await signIn(app);
  for (const [path, options] of [["/api/stations", { cookie }], ["/api/stations", {}], ["/api/v1/integrations", {}], ["/api/integrations/abc/events", { cookie }], ["/api/stations/challenges", { cookie, method: "POST", data: { origin: "https://one.example" } }]]) {
    const response = await call(app.base, path, options);
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), { error: UNAVAILABLE });
  }
  const bearer = await app.fake.issueAccessToken({ scope: "integrations:read" });
  assert.equal((await call(app.base, "/api/v1/integrations", { bearer })).status, 503);
  assert.equal((await (await call(app.base, "/api/me", { cookie })).json()).integrationsAvailable, false);
});

test("/api/me names delegatedHostWork only when it is on: DELEGATED_HOST_WORK=1, or the option; any other value is off", async (t) => {
  const meOf = async (app) => (await call(app.base, "/api/me", { cookie: (await signIn(app)).cookie })).json();
  const off = await meOf(await start(t));
  assert.equal("delegatedHostWork" in off, false, "off by default: the /api/me shape is unchanged");
  assert.equal(off.integrationsAvailable, false);
  for (const value of ["0", "true", "", "2", " 1"]) assert.equal("delegatedHostWork" in await meOf(await start(t, { delegatedHostWork: value })), false, JSON.stringify(value));
  const on = await start(t, { delegatedHostWork: "1" });
  assert.equal((await meOf(on)).delegatedHostWork, true);
  const bearer = await on.fake.issueAccessToken({ sub: accountId(), scope: "credits" });
  assert.equal("delegatedHostWork" in await (await call(on.base, "/api/v1/me", { bearer })).json(), false, "the bearer /api/me shape is unchanged");
  const saved = process.env.DELEGATED_HOST_WORK;
  t.after(() => { if (saved === undefined) delete process.env.DELEGATED_HOST_WORK; else process.env.DELEGATED_HOST_WORK = saved; });
  process.env.DELEGATED_HOST_WORK = "1";
  assert.equal((await meOf(await start(t))).delegatedHostWork, true, "the environment, when the option is absent");
  assert.equal("delegatedHostWork" in await meOf(await start(t, { delegatedHostWork: "0" })), false, "the option wins over the environment");
});

test("missing Auth settings leave the integrations unavailable, logged once by setting name", () => {
  const logs = [];
  assert.equal(integrationsFromEnv({ DATABASE_URL: "postgres://user@127.0.0.1:1/none" }, { idp: null, log: (line) => logs.push(line) }), null);
  assert.deepEqual(logs, ["Stations and integrations are unavailable: set AUTH_ISSUER, PORTAL_CLIENT_SECRET."]);
  logs.length = 0;
  assert.equal(integrationsFromEnv({ DATABASE_URL: "postgres://user@127.0.0.1:1/none", AUTH_ISSUER: issuer, PORTAL_CLIENT_SECRET: "short" }, { idp: null, log: (line) => logs.push(line) }), null);
  assert.deepEqual(logs, ["Stations and integrations are unavailable: PORTAL_CLIENT_SECRET must be at least 32 characters."]);
  logs.length = 0;
  assert.equal(integrationsFromEnv({ AUTH_ISSUER: issuer, PORTAL_CLIENT_SECRET: clientSecret }, { idp: null, log: (line) => logs.push(line) }), null, "no DATABASE_URL, no stack");
  assert.deepEqual(logs, []);
});

test("the stack migrates once before the first request, answers 503 and retries after a failure, and closes its pool", async () => {
  const calls = [];
  let failMigrate = true;
  const db = {
    async migrate() { calls.push("migrate"); if (failMigrate) { failMigrate = false; throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } return []; },
    async ensureEventPartitions() { calls.push("partitions"); return []; },
    async close() { calls.push("close"); }
  };
  const logs = [];
  const integrations = createIntegrationStack({ db, manage: fakeManage(), idp: null, log: (line) => logs.push(line) });
  await assert.rejects(integrations.ready(), (error) => error.status === 503);
  assert.deepEqual(logs, ["Portal database is not ready: ECONNREFUSED."]);
  const [first, second] = await Promise.all([integrations.ready(), integrations.ready()]);
  assert.equal(first, second);
  assert.equal(typeof first.stations, "function");
  await integrations.ready();
  assert.deepEqual(calls, ["migrate", "migrate", "partitions"], "memoised after the first success");
  await integrations.close();
  assert.equal(calls.at(-1), "close");
});

// The end-to-end harness injects its own Station fetches; without them the stack keeps the real, guarded fetch.
test("the stack uses injected Station fetches for proof and pushes, and the real network fetch by default", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const owner = accountId();
  const register = async (service, origin) => {
    const issued = await service.createChallenge(owner, origin);
    return { issued, result: await service.registerStation(owner, { challengeId: issued.challengeId, reportKey: publicJwk() }).catch((error) => error) };
  };

  const logs = [];
  const fallback = createIntegrationStack({ db, manage: fakeManage(), idp: null, log: (line) => logs.push(line) });
  const refused = (await register(fallback.service, "https://station.invalid")).result;
  assert.equal(refused.status, 422, "the default proof fetch goes to the network, which cannot reach station.invalid");
  assert.equal(refused.details.reason, "network");

  const fetched = [];
  const pushed = [];
  const stationFetch = { async get(url) { fetched.push(url); return { status: 200, body: served }; } };
  const pushFetch = { async post(url, body) { pushed.push({ url, body }); return { status: 202 }; } };
  let served = "";
  const injected = integrationsFromEnv({ DATABASE_URL: "postgres://unused@127.0.0.1:1/none", AUTH_ISSUER: issuer, PORTAL_CLIENT_SECRET: clientSecret }, { idp: null, log: () => {}, stationFetch, pushFetch });
  assert.ok(injected, "integrationsFromEnv accepts the injected fetches");
  await injected.close();
  const stack = createIntegrationStack({ db, manage: fakeManage(), idp: null, log: () => {}, stationFetch, pushFetch });
  const issued = await stack.service.createChallenge(owner, "https://two.example");
  served = issued.value;
  const station = await stack.service.registerStation(owner, { challengeId: issued.challengeId, reportKey: publicJwk() });
  assert.deepEqual(fetched, ["https://two.example/.well-known/agora-build-station"]);
  await stack.service.share(owner, station.id, accountId());
  await stack.service._pushesIdle();
  assert.deepEqual(pushed.map((entry) => entry.url), ["https://two.example/agora-build/v1/changes"]);
});

test("a browser account registers, shares and removes a Station and manages an integration", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  const friend = await signIn(app);
  assert.equal((await (await call(app.base, "/api/me", { cookie: owner.cookie })).json()).integrationsAvailable, true);
  const { issued, station } = await registerStation(app, integrations, owner.cookie);
  assert.equal(issued.url, "https://one.example/.well-known/agora-build-station");
  assert.equal(station.origin, "https://one.example");
  const listed = await (await call(app.base, "/api/stations", { cookie: owner.cookie })).json();
  assert.deepEqual(listed.stations.map((entry) => entry.id), [station.id]);
  assert.equal(listed.stale, false);

  const shared = await call(app.base, "/api/stations/" + station.id + "/members/" + friend.sub, { cookie: owner.cookie, method: "PUT" });
  assert.deepEqual([shared.status, await shared.json()], [200, { shared: true }]);
  const members = await (await call(app.base, "/api/stations/" + station.id + "/members", { cookie: owner.cookie })).json();
  assert.deepEqual(members.members.map((entry) => entry.account), [friend.sub]);
  assert.equal(members.owner, owner.sub);
  assert.deepEqual((await (await call(app.base, "/api/stations", { cookie: friend.cookie })).json()).stations.map((entry) => entry.id), [station.id]);
  const unshared = await call(app.base, "/api/stations/" + station.id + "/members/" + friend.sub, { cookie: owner.cookie, method: "DELETE" });
  assert.deepEqual([unshared.status, await unshared.json()], [200, { unshared: true }]);

  const integration = await createIntegration(app, owner.cookie, station.id);
  assert.equal(integration.state, "awaiting_approval");
  const mine = await (await call(app.base, "/api/integrations", { cookie: owner.cookie })).json();
  assert.deepEqual(mine.integrations.map((entry) => entry.id), [integration.id]);
  const action = (name, data) => call(app.base, "/api/integrations/" + integration.id + "/" + name, { cookie: owner.cookie, method: "POST", data });
  const paused = await action("pause");
  assert.deepEqual([paused.status, (await paused.json()).state], [200, "paused"]);
  assert.equal((await (await action("resume")).json()).state, "awaiting_approval");
  const renewed = await action("renew", { expiresInDays: 60 });
  assert.equal(renewed.status, 200);
  assert.ok(Date.parse((await renewed.json()).expiresAt) > Date.now() + 59 * 86400000);
  assert.equal((await (await action("settings", { quotaPerSecond: 50 })).json()).quotaPerSecond, 50);
  const rotated = await action("keys", { publicJwk: publicJwk() });
  assert.equal(rotated.status, 201);
  assert.ok((await rotated.json()).kid);
  const history = await (await call(app.base, "/api/integrations/" + integration.id + "/events", { cookie: owner.cookie })).json();
  assert.ok(history.events.some((event) => event.kind === "integration_created" && event.actor === "you"));
  assert.equal((await (await action("revoke")).json()).state, "revoked", "never provisioned, so revoked at once");

  const removed = await call(app.base, "/api/stations/" + station.id, { cookie: owner.cookie, method: "DELETE" });
  assert.deepEqual([removed.status, await removed.json()], [200, { removed: true }]);
  assert.deepEqual((await (await call(app.base, "/api/stations", { cookie: owner.cookie })).json()).stations, []);
});

test("browser routes refuse guests, other sites, bearer tokens and malformed IDs", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service });
  const visitor = pair(cookieNamed(await call(app.base, "/api/profile", { method: "POST", data: profile() }), "house_session"));
  assert.equal((await call(app.base, "/api/stations", { cookie: visitor })).status, 401);
  assert.equal((await call(app.base, "/api/stations")).status, 401);
  const { cookie } = await signIn(app);
  const crossOrigin = await call(app.base, "/api/stations/challenges", { cookie, method: "POST", data: { origin: "https://one.example" }, headers: { Origin: "https://evil.example" } });
  assert.equal(crossOrigin.status, 403);
  const bearer = await app.fake.issueAccessToken({ scope: "integrations:read integrations:approve" });
  for (const [path, method] of [["/api/stations", "GET"], ["/api/stations/challenges", "POST"], ["/api/integrations/abc/pause", "POST"], ["/api/stations/abc/read-token", "POST"]]) {
    const response = await call(app.base, path, { bearer, method });
    assert.equal(response.status, 403, path);
    assert.match((await response.json()).error, /browser session/);
  }
  assert.equal((await call(app.base, "/api/v1/stations", { bearer })).status, 404, "no v1 route for the browser list");
  for (const path of ["/api/stations/bad.id/members", "/api/stations/" + "a".repeat(65) + "/members", "/api/stations/abc/members/not-an-account", "/api/integrations/bad.id/events", "/api/stations/abc/unknown"]) {
    assert.equal((await call(app.base, path, { cookie })).status, 404, path);
  }
});

test("a stranger's Station routes answer 404 and a member's owner-only ones 403, both without asking Auth", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  const member = await signIn(app);
  const stranger = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  assert.equal((await call(app.base, "/api/stations/" + station.id + "/members/" + member.sub, { cookie: owner.cookie, method: "PUT" })).status, 200);
  const calls = integrations.manage.calls.length;
  const base = "/api/stations/" + station.id;
  for (const id of [station.id, "st-unknown"]) {
    for (const [path, method] of [["/members", "GET"], ["/members/" + stranger.sub, "PUT"], ["/members/" + member.sub, "DELETE"], ["", "DELETE"]]) {
      const response = await call(app.base, "/api/stations/" + id + path, { cookie: stranger.cookie, method });
      assert.deepEqual([response.status, (await response.json()).error], [404, "This Station or integration was not found."], method + " " + id + path);
    }
  }
  for (const [path, method] of [["/members/" + stranger.sub, "PUT"], ["/members/" + owner.sub, "DELETE"], ["", "DELETE"]]) {
    const response = await call(app.base, base + path, { cookie: member.cookie, method });
    assert.deepEqual([response.status, (await response.json()).code], [403, "forbidden"], method + path);
  }
  assert.equal(integrations.manage.calls.length, calls, "Auth was not called");
  assert.equal((await call(app.base, base + "/members", { cookie: member.cookie })).status, 200, "a member may list the members");
});

test("routes that call Auth are limited per account: lists 60 a minute, changes 30", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service });
  const busy = await signIn(app);
  const other = await signIn(app);
  const limited = async (path, options, max) => {
    for (let index = 0; index < max; index += 1) assert.notEqual((await call(app.base, path, options)).status, 429, path + " #" + (index + 1));
    const over = await call(app.base, path, options);
    assert.deepEqual([over.status, (await over.json()).error], [429, "A few too many requests. Please try again in a moment."], path);
  };
  await limited("/api/stations", { cookie: busy.cookie }, 60);
  await limited("/api/stations/st-unknown/members", { cookie: busy.cookie }, 60);
  await limited("/api/integrations", { cookie: busy.cookie }, 60);
  const calls = integrations.manage.calls.length;
  assert.equal((await call(app.base, "/api/v1/integrations", { bearer: await app.fake.issueAccessToken({ sub: busy.sub, scope: "integrations:read" }) })).status, 429, "the v1 list shares the account's budget");
  assert.equal(integrations.manage.calls.length, calls, "a limited request does not reach Auth");
  // Changes share one budget across Station and integration routes.
  for (let index = 0; index < 10; index += 1) assert.equal((await call(app.base, "/api/stations/st-unknown", { cookie: busy.cookie, method: "DELETE" })).status, 404);
  for (let index = 0; index < 10; index += 1) assert.equal((await call(app.base, "/api/stations/st-unknown/members/" + other.sub, { cookie: busy.cookie, method: "PUT" })).status, 404);
  await limited("/api/integrations/i-unknown/pause", { cookie: busy.cookie, method: "POST" }, 10);
  const approver = await app.fake.issueAccessToken({ sub: busy.sub, scope: "integrations:approve" });
  assert.equal((await call(app.base, "/api/v1/integrations/i-unknown/approval", { bearer: approver, method: "POST", data: { r9Svc: R9 } })).status, 429);
  assert.equal((await call(app.base, "/api/stations", { cookie: other.cookie })).status, 200, "another account is not limited");
  assert.equal((await call(app.base, "/api/integrations/i-unknown/revoke", { cookie: other.cookie, method: "POST" })).status, 404);
});

test("the v1 integration list and approval take scoped access tokens", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const integration = await createIntegration(app, owner.cookie, station.id);

  const reader = await app.fake.issueAccessToken({ sub: owner.sub, client_id: "astation", scope: "integrations:read" });
  const listed = await call(app.base, "/api/v1/integrations", { bearer: reader });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).integrations.map((entry) => entry.id), [integration.id]);
  assertScope(await call(app.base, "/api/v1/integrations", { bearer: await app.fake.issueAccessToken({ sub: owner.sub, scope: "credits" }) }), "integrations:read");
  const unversioned = await call(app.base, "/api/integrations", { bearer: reader });
  assert.equal(unversioned.status, 404);
  assert.match((await unversioned.json()).error, /\/api\/v1\/integrations/);

  const approvalPath = "/api/v1/integrations/" + integration.id + "/approval";
  assertScope(await call(app.base, approvalPath, { bearer: reader, method: "POST", data: { r9Svc: R9 } }), "integrations:approve");
  assert.equal((await call(app.base, "/api/integrations/" + integration.id + "/approval", { cookie: owner.cookie, method: "POST", data: { r9Svc: R9 } })).status, 401, "approval needs an access token");
  const approver = await app.fake.issueAccessToken({ sub: owner.sub, client_id: "astation", scope: "integrations:approve" });
  const approved = await call(app.base, approvalPath, { bearer: approver, method: "POST", data: { r9Svc: R9 } });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).state, "provisioning");
  assert.equal((await call(app.base, "/api/v1/integrations/bad.id/approval", { bearer: approver, method: "POST", data: { r9Svc: R9 } })).status, 404);
});

// D29: a revocation states whether to interrupt running tasks, from the browser and from Astation (the setting on).
const INTERRUPT_RUNNING = "Say whether to interrupt running tasks: send interruptRunning as true or false.";

test("with the setting on, the browser's revoke must say whether to interrupt running tasks", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const revoke = (id, data) => call(app.base, "/api/integrations/" + id + "/revoke", { cookie: owner.cookie, method: "POST", data });
  const mine = await createIntegration(app, owner.cookie, station.id);
  const calls = integrations.manage.calls.length;
  assert.equal((await revoke(mine.id)).status, 415, "no JSON body");
  for (const data of [{}, { interruptRunning: "true" }, { interruptRunning: null }, { interruptRunning: 1 }]) {
    const refused = await revoke(mine.id, data);
    assert.deepEqual([refused.status, await refused.json()], [400, { error: INTERRUPT_RUNNING, code: "interrupt_running" }], JSON.stringify(data));
  }
  assert.equal((await revoke("i-unknown", {})).status, 400, "an unknown ID is refused the same way");
  assert.equal(integrations.manage.calls.length, calls, "Auth was not asked");
  // Pause and resume take no body.
  const pause = (name) => call(app.base, "/api/integrations/" + mine.id + "/" + name, { cookie: owner.cookie, method: "POST" });
  assert.equal((await pause("pause")).status, 200);
  assert.equal((await pause("resume")).status, 200);
  const revoked = await revoke(mine.id, { interruptRunning: true });
  assert.equal(revoked.status, 200);
  const view = await revoked.json();
  assert.deepEqual([view.state, view.interruptRunning, typeof view.revokedAt], ["revoked", true, "string"]);
  assert.equal(integrations.manage.integrationRecords.find((entry) => entry.clientId === mine.id).interruptRunning, true);
  const second = await createIntegration(app, owner.cookie, station.id);
  assert.equal((await (await revoke(second.id, { interruptRunning: false })).json()).interruptRunning, false);
  assert.equal((await revoke("i-unknown", { interruptRunning: false })).status, 404);
});

test("with the setting on, Astation revokes at POST /api/v1/integrations/<id>/revoke with integrations:approve, for the owner only", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const integration = await createIntegration(app, owner.cookie, station.id);
  const path = "/api/v1/integrations/" + integration.id + "/revoke";
  const token = (scope, sub = owner.sub) => app.fake.issueAccessToken({ sub, client_id: "astation", scope });
  const native = (bearer, data = { interruptRunning: true }, target = path) => call(app.base, target, { bearer, method: "POST", data });

  assertScope(await native(await token("integrations:read")), "integrations:approve");
  assertScope(await native(await token("credits")), "integrations:approve");
  const approver = await token("integrations:approve");
  assert.equal((await call(app.base, path, { bearer: approver, method: "POST" })).status, 415, "no JSON body");
  const refused = await native(approver, {});
  assert.deepEqual([refused.status, (await refused.json()).code], [400, "interrupt_running"]);
  // Not the owner: another account, or the Station's owner on a member's integration, finds nothing.
  const stranger = await signIn(app);
  assert.equal((await native(await token("integrations:approve", stranger.sub))).status, 404);
  assert.equal((await native(approver, { interruptRunning: true }, "/api/v1/integrations/i-unknown/revoke")).status, 404);
  const friend = await signIn(app);
  assert.equal((await call(app.base, "/api/stations/" + station.id + "/members/" + friend.sub, { cookie: owner.cookie, method: "PUT" })).status, 200);
  const theirs = await createIntegration(app, friend.cookie, station.id);
  assert.equal((await native(approver, { interruptRunning: true }, "/api/v1/integrations/" + theirs.id + "/revoke")).status, 404, "the Station's owner is not the integration's owner");
  assert.equal((await (await call(app.base, "/api/integrations", { cookie: friend.cookie })).json()).integrations.find((entry) => entry.id === theirs.id).state, "awaiting_approval");

  const revoked = await native(approver);
  assert.equal(revoked.status, 200);
  const view = await revoked.json();
  assert.deepEqual([view.id, view.state, view.role, view.interruptRunning, typeof view.revokedAt], [integration.id, "revoked", "owner", true, "string"]);
  assert.equal(integrations.manage.integrationRecords.find((entry) => entry.clientId === integration.id).interruptRunning, true);
  const event = (await integrations.db.pool.query("SELECT actor, reason, details FROM integration_events WHERE integration_id = $1 AND kind = 'integration_revoked'", [integration.id])).rows;
  assert.equal(event.length, 1);
  assert.deepEqual([event[0].actor, event[0].reason, event[0].details.clientId, event[0].details.interruptRunning], [owner.sub, "owner", "astation", true]);
  assert.equal((await native(approver, { interruptRunning: false })).status, 200, "a repeat is the same no-op");
  assert.equal((await integrations.service.integrations(owner.sub)).integrations.find((entry) => entry.id === integration.id).interruptRunning, true);

  // A token on the unversioned path gets the versioned-API 404, as for the other token routes; a browser session on it still works.
  const unversioned = await native(approver, { interruptRunning: true }, "/api/integrations/" + integration.id + "/revoke");
  assert.equal(unversioned.status, 404);
  assert.match((await unversioned.json()).error, new RegExp("^Access tokens use the versioned API: /api/v1/integrations/" + integration.id + "/revoke\\.$"));
  assert.equal((await call(app.base, "/api/integrations/" + integration.id + "/revoke", { cookie: owner.cookie, method: "POST", data: { interruptRunning: true } })).status, 200);
  // Only POST, and only revoke: nothing else became a token route.
  assert.equal((await call(app.base, path, { bearer: approver, method: "GET" })).status, 404);
  assert.equal((await call(app.base, "/api/v1/integrations/" + integration.id + "/pause", { bearer: approver, method: "POST" })).status, 404);
});

// Issue 38: Astation's mirror of a manager's "revoke and interrupt" converges after someone else's revoke without it.
test("with the setting on, Astation's revoke with true on an integration someone else already revoked answers 200 with interruptRunning true, once", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const stationOwner = await signIn(app);
  const { station } = await registerStation(app, integrations, stationOwner.cookie);
  const member = await signIn(app);
  assert.equal((await call(app.base, "/api/stations/" + station.id + "/members/" + member.sub, { cookie: stationOwner.cookie, method: "PUT" })).status, 200);
  const integration = await createIntegration(app, member.cookie, station.id);
  // The Station's owner revokes it first, without the interrupt (the browser's route).
  const first = await call(app.base, "/api/integrations/" + integration.id + "/revoke", { cookie: stationOwner.cookie, method: "POST", data: { interruptRunning: false } });
  assert.deepEqual([first.status, (await first.json()).interruptRunning], [200, false]);
  const approver = await app.fake.issueAccessToken({ sub: member.sub, client_id: "astation", scope: "integrations:approve" });
  const native = (data) => call(app.base, "/api/v1/integrations/" + integration.id + "/revoke", { bearer: approver, method: "POST", data });
  const calls = integrations.manage.calls.length;
  const mirrored = await native({ interruptRunning: true });
  assert.equal(mirrored.status, 200);
  const view = await mirrored.json();
  assert.deepEqual([view.id, view.state, view.role, view.interruptRunning], [integration.id, "revoked", "owner", true]);
  const written = () => integrations.db.pool.query("SELECT actor, reason, details FROM integration_events WHERE integration_id = $1 AND kind = 'integration_interrupt_requested'", [integration.id]).then((result) => result.rows);
  const [event, ...more] = await written();
  assert.deepEqual([more.length, event.actor, event.reason, event.details], [0, member.sub, "owner", { interruptRunning: true, clientId: "astation" }]);
  assert.equal(integrations.manage.calls.length, calls, "Auth is not asked");
  // The retry converges to the same, with nothing more written; a false after it changes nothing.
  for (const data of [{ interruptRunning: true }, { interruptRunning: false }]) {
    const retried = await native(data);
    assert.deepEqual([retried.status, (await retried.json()).interruptRunning], [200, true], JSON.stringify(data));
  }
  assert.equal((await written()).length, 1);
  assert.equal((await (await call(app.base, "/api/integrations", { cookie: member.cookie })).json()).integrations.find((entry) => entry.id === integration.id).interruptRunning, true);
});

// Auth's setting is turned on first (docs/platform.md); if the order is broken, only a ticked revoke is refused, by Auth.
test("with the Portal's setting on and Auth's off, the browser's and Astation's unticked revokes work and a ticked one is Auth's 400", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true, authDelegated: false });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const approver = await app.fake.issueAccessToken({ sub: owner.sub, client_id: "astation", scope: "integrations:approve" });
  const browser = (id, interruptRunning) => call(app.base, "/api/integrations/" + id + "/revoke", { cookie: owner.cookie, method: "POST", data: { interruptRunning } });
  const native = (id, interruptRunning) => call(app.base, "/api/v1/integrations/" + id + "/revoke", { bearer: approver, method: "POST", data: { interruptRunning } });
  const stateOf = async (id) => (await integrations.service.integrations(owner.sub)).integrations.find((entry) => entry.id === id).state;
  for (const [name, revoke] of [["browser", browser], ["native", native]]) {
    const unticked = await createIntegration(app, owner.cookie, station.id);
    const done = await revoke(unticked.id, false);
    assert.equal(done.status, 200, name + ": unticked");
    assert.deepEqual([(await done.json()).interruptRunning, integrations.manage.sent.at(-1).fields.interruptRunning], [false, undefined], name + ": Auth was sent no choice");
    const ticked = await createIntegration(app, owner.cookie, station.id);
    const refused = await revoke(ticked.id, true);
    assert.deepEqual([refused.status, await refused.json()], [400, { error: "Auth refused this request.", code: "invalid_request" }], name + ": ticked");
    assert.equal(await stateOf(ticked.id), "awaiting_approval", name + ": nothing was written");
  }
});

test("with the setting off, the browser's revoke reads no body and Astation's native revoke does not exist", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const first = await createIntegration(app, owner.cookie, station.id);
  const second = await createIntegration(app, owner.cookie, station.id);
  const approver = await app.fake.issueAccessToken({ sub: owner.sub, client_id: "astation", scope: "integrations:approve" });
  const nativePath = "/api/v1/integrations/" + first.id + "/revoke";
  const missing = await call(app.base, nativePath, { bearer: approver, method: "POST", data: { interruptRunning: true } });
  assert.deepEqual([missing.status, (await missing.json()).error], [404, "This API was not found. See https://github.com/Agora-Build/Portal/blob/main/docs/platform.md for the /api/v1 routes."]);
  const token = await call(app.base, "/api/integrations/" + first.id + "/revoke", { bearer: approver, method: "POST" });
  assert.equal(token.status, 403, "a token on the browser path is refused as today");
  assert.match((await token.json()).error, /browser session/);
  const revoked = await call(app.base, "/api/integrations/" + first.id + "/revoke", { cookie: owner.cookie, method: "POST" });
  assert.equal(revoked.status, 200, "no body, no 415");
  const view = await revoked.json();
  assert.equal(view.state, "revoked");
  assert.equal(Object.hasOwn(view, "interruptRunning") || Object.hasOwn(view, "revokedAt"), false);
  const given = await call(app.base, "/api/integrations/" + second.id + "/revoke", { cookie: owner.cookie, method: "POST", data: { interruptRunning: true } });
  assert.equal(given.status, 200, "a body is not read");
  assert.equal(integrations.manage.integrationRecords.find((entry) => entry.clientId === second.id).interruptRunning, undefined);
});

// D29: the later "interrupt running tasks": the browser session only, the setting on only.
const INTERRUPT_LATE = "Running tasks can be interrupted only within 24 hours of the revocation.";

test("with the setting on, POST /api/integrations/<id>/interrupt adds the interrupt for the owner and the Station's owner, for the browser session only", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const friend = await signIn(app);
  assert.equal((await call(app.base, "/api/stations/" + station.id + "/members/" + friend.sub, { cookie: owner.cookie, method: "PUT" })).status, 200);
  const mine = await createIntegration(app, owner.cookie, station.id);
  const theirs = await createIntegration(app, friend.cookie, station.id);
  const interrupt = (id, options = { cookie: owner.cookie }) => call(app.base, "/api/integrations/" + id + "/interrupt", { method: "POST", ...options });
  const revoke = (id, cookie) => call(app.base, "/api/integrations/" + id + "/revoke", { cookie, method: "POST", data: { interruptRunning: false } });

  // Not stopped yet, so the owner is told so; a stranger is told nothing; no body is read.
  const live = await interrupt(mine.id);
  assert.deepEqual([live.status, (await live.json()).code], [409, "invalid_state"]);
  const stranger = await signIn(app);
  assert.equal((await interrupt(mine.id, { cookie: stranger.cookie })).status, 404);
  assert.equal((await interrupt("i-unknown")).status, 404);
  assert.equal((await interrupt("bad.id")).status, 404);

  assert.equal((await revoke(mine.id, owner.cookie)).status, 200);
  const done = await interrupt(mine.id);
  assert.equal(done.status, 200);
  const view = await done.json();
  assert.deepEqual([view.id, view.role, view.state, view.interruptRunning, typeof view.revokedAt], [mine.id, "owner", "revoked", true, "string"]);
  assert.equal((await interrupt(mine.id)).status, 200, "a repeat is the same answer");
  const events = (await integrations.db.pool.query("SELECT actor, reason, details FROM integration_events WHERE integration_id = $1 AND kind = 'integration_interrupt_requested'", [mine.id])).rows;
  assert.deepEqual(events.map((event) => [event.actor, event.reason, event.details]), [[owner.sub, "owner", { interruptRunning: true }]]);
  assert.equal(integrations.manage.integrationRecords.find((entry) => entry.clientId === mine.id).interruptRunning, false, "Auth was not told");
  assert.equal(integrations.manage.sent.some((call) => call.fields.interruptRunning === true), false, "neither by the revocation, which was unticked, nor by the interrupt");
  const history = await (await call(app.base, "/api/integrations/" + mine.id + "/events", { cookie: owner.cookie })).json();
  assert.equal(history.events[0].kind, "integration_interrupt_requested");

  // The Station's owner, on a member's integration.
  assert.equal((await revoke(theirs.id, friend.cookie)).status, 200);
  const station_owner = await (await interrupt(theirs.id)).json();
  assert.deepEqual([station_owner.role, station_owner.interruptRunning], ["station_owner", true]);

  // Too late: the clock is the service's own, so only the row's date can age it.
  const late = await createIntegration(app, owner.cookie, station.id);
  assert.equal((await revoke(late.id, owner.cookie)).status, 200);
  await integrations.db.pool.query("UPDATE integrations SET revoked_at = now() - interval '25 hours' WHERE id = $1", [late.id]);
  const refused = await interrupt(late.id);
  assert.deepEqual([refused.status, await refused.json()], [409, { error: INTERRUPT_LATE, code: "too_late" }]);

  // Only POST, only from the browser session: a token is refused as on the other browser routes, and a guest is 401.
  const approver = await app.fake.issueAccessToken({ sub: owner.sub, client_id: "astation", scope: "integrations:approve integrations:read" });
  for (const path of ["/api/integrations/" + mine.id + "/interrupt", "/api/v1/integrations/" + mine.id + "/interrupt"]) {
    const response = await call(app.base, path, { bearer: approver, method: "POST" });
    assert.equal(response.status, path.startsWith("/api/v1/") ? 404 : 403, path);
  }
  const token = await interrupt(mine.id, { bearer: approver });
  assert.equal(token.status, 403);
  assert.match((await token.json()).error, /browser session/);
  assert.equal((await interrupt(mine.id, { cookie: undefined })).status, 401);
  assert.equal((await call(app.base, "/api/integrations/" + mine.id + "/interrupt", { cookie: owner.cookie })).status, 404, "GET is not a route");
});

test("with the setting on, an integration of a removed Station answers the interrupt 409 station_removed, and its listed view says stationRemoved", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const mine = await createIntegration(app, owner.cookie, station.id);
  assert.equal((await call(app.base, "/api/integrations/" + mine.id + "/revoke", { cookie: owner.cookie, method: "POST", data: { interruptRunning: false } })).status, 200);
  assert.equal((await call(app.base, "/api/stations/" + station.id, { cookie: owner.cookie, method: "DELETE" })).status, 200);
  const refused = await call(app.base, "/api/integrations/" + mine.id + "/interrupt", { cookie: owner.cookie, method: "POST" });
  assert.deepEqual([refused.status, await refused.json()], [409, { error: "This integration's Station has been removed, so its running tasks can't be interrupted here.", code: "station_removed" }]);
  const listed = (await (await call(app.base, "/api/integrations", { cookie: owner.cookie })).json()).integrations.find((entry) => entry.id === mine.id);
  assert.deepEqual([listed.state, listed.stationRemoved, listed.interruptRunning], ["revoked", true, false]);
});

test("the interrupt shares the change budget, and with the setting off the route does not exist", async (t) => {
  const on = await stack(t, { delegatedHostWork: true });
  if (!on) return;
  const app = await start(t, { integrations: on.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  let last;
  for (let count = 0; count < 31; count += 1) last = await call(app.base, "/api/integrations/i-unknown/interrupt", { cookie: owner.cookie, method: "POST" });
  assert.equal(last.status, 429, "30 changes a minute, shared with revoke and the rest");

  const integrations = await stack(t);
  const off = await start(t, { integrations: integrations.service });
  const person = await signIn(off);
  const { station } = await registerStation(off, integrations, person.cookie);
  const created = await createIntegration(off, person.cookie, station.id);
  assert.equal((await call(off.base, "/api/integrations/" + created.id + "/revoke", { cookie: person.cookie, method: "POST" })).status, 200);
  const calls = integrations.manage.calls.length;
  const response = await call(off.base, "/api/integrations/" + created.id + "/interrupt", { cookie: person.cookie, method: "POST", data: { interruptRunning: true } });
  assert.deepEqual([response.status, (await response.json()).error], [404, "This page or service was not found."]);
  const approver = await off.fake.issueAccessToken({ sub: person.sub, client_id: "astation", scope: "integrations:approve" });
  assert.equal((await call(off.base, "/api/integrations/" + created.id + "/interrupt", { bearer: approver, method: "POST" })).status, 403, "a token is refused as on any browser route");
  assert.deepEqual([integrations.manage.calls.length, (await integrations.service.integrations(person.sub)).integrations[0].interruptRunning], [calls, undefined]);
});

// The data side's setting comes from the environment through the stack: integrationsFromEnv, createIntegrationStack, the service.
test("DELEGATED_HOST_WORK=1 reaches the service through integrationsFromEnv, and the stack's service serves the choice end to end", async (t) => {
  const settings = { AUTH_ISSUER: issuer, PORTAL_CLIENT_SECRET: clientSecret, DATABASE_URL: "postgres://unused@127.0.0.1:1/none" };
  const on = integrationsFromEnv({ ...settings, DELEGATED_HOST_WORK: "1" }, { idp: null, log: () => {} });
  t.after(() => on.close());
  // Refused before any database work, so this stack needs none.
  await assert.rejects(on.service.revoke(accountId(), "i-1", {}), (error) => error.status === 400 && error.details?.code === "interrupt_running");
  // With the variable unset (or anything but "1") the data side is off too: a browser revoke needs no body, so it gets
  // past that check and fails only at this stack's unreachable database.
  const unreachable = (error) => !(error instanceof AppError);
  for (const value of [undefined, "", "0", "true", "11"]) {
    const off = integrationsFromEnv({ ...settings, ...(value === undefined ? {} : { DELEGATED_HOST_WORK: value }) }, { idp: null, log: () => {} });
    t.after(() => off.close());
    await assert.rejects(off.service.revoke(accountId(), "i-1"), unreachable, JSON.stringify(value));
    await assert.rejects(off.service.revokeNative(accountId(), "i-1", {}), (error) => error.status === 404, "no native revoke: " + JSON.stringify(value));
  }

  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const manage = fakeManage({ delegated: true });
  const served = { body: "" };
  const stationFetch = { async get() { return { status: 200, body: served.body }; } };
  const pushFetch = { async post() { return { status: 202 }; } };
  // The stack closes its database when the server stops; the test database closes with the test.
  const stackDb = { ...db, close: async () => {} };
  const integrationStack = createIntegrationStack({ db: stackDb, manage, idp: null, log: () => {}, stationFetch, pushFetch, delegatedHostWork: true, authChanges: { pollMs: 3600000, minGapMs: 5 } });
  t.after(() => integrationStack.service._pushesIdle());
  const app = await start(t, { integrationStack, delegatedHostWork: "1" });
  const owner = await signIn(app);
  await integrationStack.ready();
  const { station } = await registerStation(app, { served }, owner.cookie);
  const integration = await createIntegration(app, owner.cookie, station.id);
  const revoke = (data) => call(app.base, "/api/integrations/" + integration.id + "/revoke", { cookie: owner.cookie, method: "POST", data });
  assert.equal((await revoke({})).status, 400);
  const revoked = await revoke({ interruptRunning: true });
  assert.deepEqual([revoked.status, (await revoked.json()).interruptRunning], [200, true]);
  assert.equal(manage.integrationRecords.find((entry) => entry.clientId === integration.id).interruptRunning, true);
});

test("Station reports and the change feed take only the Station's station.report token", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const integration = await createIntegration(app, owner.cookie, station.id);
  await integrations.service.approve(owner.sub, integration.id, { r9Svc: R9 });

  const report = (bearer, data = { integrationId: integration.id, state: "waiting_for_host" }, prefix = "/api/v1/") => call(app.base, prefix + "stations/reports", { bearer, method: "POST", data });
  const stationToken = await app.fake.issueAccessToken({ sub: owner.sub, client_id: station.reportClientId, scope: "station.report" });
  assert.match(station.reportClientId, /^s-/);
  const reported = await report(stationToken);
  assert.equal(reported.status, 200);
  const view = await reported.json();
  assert.equal(view.state, "waiting_for_host");
  assert.equal(view.role, undefined);

  const otherClient = await report(await app.fake.issueAccessToken({ sub: owner.sub, client_id: "astation", scope: "station.report" }));
  assert.deepEqual([otherClient.status, (await otherClient.json()).error], [403, "This token is not a Station report token."]);
  const unknownStation = await report(await app.fake.issueAccessToken({ sub: owner.sub, client_id: "s-unknown", scope: "station.report" }));
  assert.equal(unknownStation.status, 403);
  assertScope(await report(await app.fake.issueAccessToken({ sub: owner.sub, client_id: station.reportClientId, scope: "credits" })), "station.report");
  const unversioned = await report(stationToken, undefined, "/api/");
  assert.equal(unversioned.status, 404);
  assert.match((await unversioned.json()).error, /\/api\/v1\/stations\/reports/);
  assert.equal((await call(app.base, "/api/v1/stations/reports", { cookie: owner.cookie, method: "POST", data: {} })).status, 401, "a browser session cannot report");

  const feed = await call(app.base, "/api/v1/stations/changes?cursor=0", { bearer: stationToken });
  assert.equal(feed.status, 200);
  const changes = await feed.json();
  assert.deepEqual(changes.integrations.map((entry) => entry.id), [integration.id]);
  assert.ok(changes.changes.some((change) => change.kind === "integration_reported"));
  const next = await (await call(app.base, "/api/v1/stations/changes?cursor=" + changes.cursor, { bearer: stationToken })).json();
  assert.deepEqual([next.changes, next.cursor, next.integrations], [[], changes.cursor, undefined]);
  assert.equal((await call(app.base, "/api/v1/stations/changes?cursor=-1", { bearer: stationToken })).status, 400);
  const ahead = await call(app.base, "/api/v1/stations/changes?cursor=" + (changes.cursor + 1), { bearer: stationToken });
  assert.equal(ahead.status, 409);
  assert.equal((await ahead.json()).code, "cursor_ahead");
  assertScope(await call(app.base, "/api/v1/stations/changes", { bearer: await app.fake.issueAccessToken({ client_id: station.reportClientId, scope: "credits" }) }), "station.report");
  const unversionedFeed = await call(app.base, "/api/stations/changes", { bearer: stationToken });
  assert.equal(unversionedFeed.status, 404);
});

// The exact-cursor checkpoint (D29): ?checkpoint=1 on the change feed, with the same token and limits, and only with the
// setting on.
test("with the setting on, ?checkpoint=1 answers the Station's checkpoint; with it off the parameter is ignored", async (t) => {
  const on = await stack(t, { delegatedHostWork: true });
  if (!on) return;
  const app = await start(t, { integrations: on.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  const { station } = await registerStation(app, on, owner.cookie);
  const integration = await createIntegration(app, owner.cookie, station.id);
  await on.service.approve(owner.sub, integration.id, { r9Svc: R9 });
  const token = await app.fake.issueAccessToken({ sub: owner.sub, client_id: station.reportClientId, scope: "station.report" });
  const feed = await (await call(app.base, "/api/v1/stations/changes?cursor=0", { bearer: token })).json();

  const asked = await call(app.base, "/api/v1/stations/changes?checkpoint=1", { bearer: token });
  assert.equal(asked.status, 200);
  const checkpoint = await asked.json();
  assert.deepEqual(Object.keys(checkpoint), ["changes", "cursor", "checkpoint"]);
  assert.deepEqual([checkpoint.changes, checkpoint.cursor], [[], feed.cursor]);
  assert.deepEqual(Object.keys(checkpoint.checkpoint), ["at", "integrations"]);
  assert.deepEqual(checkpoint.checkpoint.integrations.map((entry) => [entry.id, entry.ownerAccount, entry.state]), [[integration.id, owner.sub, "provisioning"]]);
  // A cursor beside it is not checked against the history; anything but "1" is the ordinary feed.
  assert.equal((await (await call(app.base, "/api/v1/stations/changes?checkpoint=1&cursor=" + (feed.cursor + 5), { bearer: token })).json()).cursor, feed.cursor);
  for (const value of ["0", "true", "", "1 "]) {
    const ordinary = await call(app.base, "/api/v1/stations/changes?checkpoint=" + encodeURIComponent(value) + "&cursor=" + feed.cursor, { bearer: token });
    assert.deepEqual([ordinary.status, Object.hasOwn(await ordinary.json(), "checkpoint")], [200, false], JSON.stringify(value));
  }
  // The same token and scope as the feed.
  assertScope(await call(app.base, "/api/v1/stations/changes?checkpoint=1", { bearer: await app.fake.issueAccessToken({ sub: owner.sub, client_id: station.reportClientId, scope: "credits" }) }), "station.report");
  assert.equal((await call(app.base, "/api/v1/stations/changes?checkpoint=1", { cookie: owner.cookie })).status, 401, "a browser session cannot read it");

  const integrations = await stack(t);
  if (!integrations) return;
  const off = await start(t, { integrations: integrations.service });
  const person = await signIn(off);
  const registered = await registerStation(off, integrations, person.cookie);
  await createIntegration(off, person.cookie, registered.station.id);
  const offToken = await off.fake.issueAccessToken({ sub: person.sub, client_id: registered.station.reportClientId, scope: "station.report" });
  const today = await (await call(off.base, "/api/v1/stations/changes?cursor=0", { bearer: offToken })).json();
  const ignored = await call(off.base, "/api/v1/stations/changes?checkpoint=1", { bearer: offToken });
  assert.equal(ignored.status, 200);
  assert.deepEqual(await ignored.json(), today, "today's cursor-0 answer, with no checkpoint key");
  assert.equal(Object.hasOwn(today, "checkpoint"), false);
  assert.equal(Array.isArray(today.integrations), true);
});

const STATION_CLIENT = "s-" + "0".repeat(24) + "bs";
const REPORT_TOKEN_ONLY = "A Station's own report token can only send reports and read the change feed.";

test("a Station report client's own token reaches only the report routes and never becomes an account", async (t) => {
  const app = await start(t, { integrations: null });
  const token = await app.fake.issueAccessToken({ sub: STATION_CLIENT, client_id: STATION_CLIENT, scope: "station.report" });
  // Without the Portal database the report routes answer 503: the token got through the gates to the route itself.
  const reports = await call(app.base, "/api/v1/stations/reports", { bearer: token, method: "POST", data: {} });
  assert.deepEqual([reports.status, (await reports.json()).error], [503, UNAVAILABLE]);
  assert.equal((await call(app.base, "/api/v1/stations/changes?cursor=0", { bearer: token })).status, 503);
  for (const [method, path] of [["GET", "/api/v1/me"], ["GET", "/api/v1/integrations"], ["GET", "/api/v1/credits/balance"], ["GET", "/api/people"], ["GET", "/api/auth/config"], ["GET", "/api/billing/account"], ["GET", "/api/stations"]]) {
    const response = await call(app.base, path, { bearer: token, method });
    assert.deepEqual([response.status, (await response.json()).error], [403, REPORT_TOKEN_ONLY], method + " " + path);
  }
  assert.equal((await call(app.base, "/api/stations/reports", { bearer: token, method: "POST", data: {} })).status, 404, "the unversioned path still names /api/v1");
  assert.equal((await app.store.snapshot()).accounts.some((account) => account.id === STATION_CLIENT), false, "no Portal account for the report client");
});

// D29 Phase B: a Station's revocation reports over HTTP (the setting on). A final names at most 100 hosts of 128
// characters, which fits the 16 KiB body limit.
test("with the setting on, a Station sends revocation_applied and the final revoked at /api/v1/stations/reports", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const integration = await createIntegration(app, owner.cookie, station.id);
  await integrations.service.approve(owner.sub, integration.id, { r9Svc: R9 });
  await integrations.service.revoke(owner.sub, integration.id, { interruptRunning: false });
  const token = await app.fake.issueAccessToken({ sub: owner.sub, client_id: station.reportClientId, scope: "station.report" });
  const report = (data) => call(app.base, "/api/v1/stations/reports", { bearer: token, method: "POST", data });
  const applied = { integrationId: integration.id, state: "revocation_applied", reportId: "revocation_applied:" + "a".repeat(64), host: "laptop", recordId: "0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b" };
  const first = await report(applied);
  assert.equal(first.status, 200);
  const answer = await first.json();
  assert.deepEqual([answer.id, answer.state], [integration.id, "revoking"]);
  for (const hidden of ["role", "pausedBy", "revokedAt", "interruptRunning", "stationRemoved", "revocation"]) assert.equal(hidden in answer, false, hidden);
  assert.deepEqual(await (await report(applied)).json(), answer, "the same id and body: the recorded answer");
  const reused = await report({ ...applied, host: "desktop" });
  assert.deepEqual([reused.status, await reused.json()], [409, { error: "This reportId was already used for another report.", code: "report_id_reused" }]);
  const invalid = await report({ ...applied, recordId: "nope" });
  assert.deepEqual([invalid.status, (await invalid.json()).code], [400, "record_id"]);
  const notNew = await report({ ...applied, reason: "done" });
  assert.deepEqual([notNew.status, (await notNew.json()).code], [400, "report"]);

  const hosts = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, "0") + "h".repeat(125));
  const final = { integrationId: integration.id, state: "revoked", reportId: "revoked:" + "b".repeat(64), outcome: "deadline_passed", pendingHosts: hosts };
  assert.ok(JSON.stringify(final).length > 13000 && JSON.stringify(final).length < 16384);
  const done = await report(final);
  assert.equal(done.status, 200);
  assert.equal((await done.json()).state, "revoked");
  const second = await report({ ...final, reportId: "revoked:" + "c".repeat(64) });
  assert.deepEqual([second.status, (await second.json()).code], [409, "invalid_state"]);
  const mine = (await (await call(app.base, "/api/integrations", { cookie: owner.cookie })).json()).integrations.find((entry) => entry.id === integration.id);
  assert.deepEqual(mine.revocation, { appliedHosts: 1, outcome: "deadline_passed", unconfirmedHosts: 100 });
});

test("with the setting on, the built-in Station sends binding reports at /api/v1/stations/reports and the account's list shows its refused attempts; a custom Station is 403 and with it off they are 400", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  await integrations.service.syncBuiltIn();
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const genesisHash = "b".repeat(64);
  const changed = { state: "binding_changed", reportId: "binding_changed:" + "a".repeat(64), account: owner.sub, accountId: "r9:account-1", genesisHash, bindingId: "bind-1", version: 2, bindingState: "bound" };
  const attempted = { state: "binding_attempt", reportId: "binding_attempt:" + "a".repeat(64), account: owner.sub, accountId: "r9:account-1", genesisHash, reason: "bound_elsewhere", attemptedAt: new Date().toISOString() };
  const builtToken = await app.fake.issueAccessToken({ sub: owner.sub, client_id: built.reportClientId, scope: "station.report" });
  const report = (data, bearer = builtToken) => call(app.base, "/api/v1/stations/reports", { bearer, method: "POST", data });
  const answered = async (response) => [response.status, await response.json()];

  assert.deepEqual(await answered(await report(changed)), [200, { accountId: "r9:account-1", genesisHash, bindingId: "bind-1", version: 2, bindingState: "bound" }]);
  assert.deepEqual(await answered(await report(changed)), [200, { accountId: "r9:account-1", genesisHash, bindingId: "bind-1", version: 2, bindingState: "bound" }], "the same id and body: the recorded answer");
  assert.deepEqual(await answered(await report({ ...changed, reportId: "binding_changed:" + "b".repeat(64), version: 1 })), [409, { error: "This binding's version is not newer than the one recorded.", code: "binding_version" }]);
  assert.deepEqual(await answered(await report({ ...changed, version: 3 })), [409, { error: "This reportId was already used for another report.", code: "report_id_reused" }]);
  assert.deepEqual(await answered(await report({ ...changed, version: 0 })), [400, { error: "Send the version as a positive whole number.", code: "version" }]);
  assert.deepEqual(await answered(await report({ ...changed, integrationId: "i-1" })), [400, { error: 'Send a binding report as { state: "binding_changed", reportId, account, accountId, genesisHash, bindingId, version, bindingState } or { state: "binding_attempt", reportId, account, accountId, genesisHash, reason, attemptedAt }.', code: "report" }]);
  assert.deepEqual(await answered(await report(attempted)), [200, { recorded: true }]);
  // The checkpoint, with the Station's own token, has the binding.
  const checkpoint = await (await call(app.base, "/api/v1/stations/changes?checkpoint=1", { bearer: builtToken })).json();
  assert.deepEqual(checkpoint.checkpoint.bindings, [{ account: owner.sub, accountId: "r9:account-1", genesisHash, bindingId: "bind-1", version: 2, bindingState: "bound" }]);

  // The browser's list carries the attempt, to the account it was made for and no one else.
  const mine = await (await call(app.base, "/api/stations", { cookie: owner.cookie })).json();
  assert.deepEqual(mine.notices, [{ kind: "binding_attempt", accountId: "r9:account-1", genesisHash, reason: "bound_elsewhere", attemptedAt: attempted.attemptedAt }]);
  const stranger = await signIn(app);
  assert.deepEqual((await (await call(app.base, "/api/stations", { cookie: stranger.cookie })).json()).notices, []);

  // A custom Station may not.
  const customToken = await app.fake.issueAccessToken({ sub: owner.sub, client_id: station.reportClientId, scope: "station.report" });
  assert.deepEqual(await answered(await report(changed, customToken)), [403, { error: "Only the built-in Station reports bindings.", code: "forbidden" }]);
  assert.deepEqual(await answered(await report(attempted, customToken)), [403, { error: "Only the built-in Station reports bindings.", code: "forbidden" }]);
  // Without the Station's scope it is no report at all.
  const readToken = await app.fake.issueAccessToken({ sub: owner.sub, client_id: built.reportClientId, scope: "integrations:read" });
  assertScope(await report(changed, readToken), "station.report");

  // With the setting off: today's report body rules, and a list as it was.
  const off = await stack(t);
  const offBuilt = off.manage.seedBuiltIn({ integrations: true });
  await off.service.syncBuiltIn();
  const offApp = await start(t, { integrations: off.service });
  const offOwner = await signIn(offApp);
  const offToken = await offApp.fake.issueAccessToken({ sub: offOwner.sub, client_id: offBuilt.reportClientId, scope: "station.report" });
  const rejected = await call(offApp.base, "/api/v1/stations/reports", { bearer: offToken, method: "POST", data: { ...changed, account: offOwner.sub } });
  assert.deepEqual([rejected.status, (await rejected.json()).code], [400, "report"]);
  const list = await (await call(offApp.base, "/api/stations", { cookie: offOwner.cookie })).json();
  assert.equal("notices" in list, false);
});

test("a read token for a Station comes from exchanging the session's ID token", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  const stranger = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const read = await call(app.base, "/api/stations/" + station.id + "/read-token", { cookie: owner.cookie, method: "POST" });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { accessToken: "station-read-token", expiresIn: 300, origin: "https://one.example" });
  assert.equal(integrations.exchanges.length, 1);
  assert.equal(integrations.exchanges[0].origin, "https://one.example");
  assert.equal(integrations.exchanges[0].idToken.split(".").length, 3, "the session's ID token");
  assert.equal((await call(app.base, "/api/stations/" + station.id + "/read-token", { cookie: stranger.cookie, method: "POST" })).status, 404);
  const bearer = await app.fake.issueAccessToken({ sub: owner.sub, scope: "credits" });
  const me = await (await call(app.base, "/api/v1/me", { bearer })).json();
  assert.equal("integrationsAvailable" in me, false, "the bearer /api/me shape is unchanged");
});

test("creating an integration on the built-in Station uses the account's Portal plan", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  assert.equal((await call(app.base, "/api/stations", { cookie: owner.cookie })).status, 200);
  const create = () => call(app.base, "/api/integrations", { cookie: owner.cookie, method: "POST", data: { stationId: built.id, name: "Hosted", scopes: ["agent.view"], publicJwk: publicJwk() } });
  const account = (state) => state.accounts.find((entry) => entry.id === owner.sub);
  for (let i = 0; i < 4; i += 1) assert.equal((await create()).status, 201);
  const basic = await create();
  assert.deepEqual([basic.status, (await basic.json()).code], [403, "plan_limit"]);
  await app.store.transaction((state) => { account(state).assignedPlan = "fellow"; });
  assert.equal((await create()).status, 201, "a Fellow has no cap");
  await app.store.transaction((state) => { account(state).assignedPlan = null; account(state).subscription = { status: "active", currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400 }; });
  for (let i = 0; i < 5; i += 1) assert.equal((await create()).status, 201, "Premium allows 10");
  const premium = await create();
  assert.deepEqual([premium.status, await premium.json()], [403, { error: "Your plan allows 10 integrations on the built-in Station. Revoke one, upgrade, or use your own Station.", code: "plan_limit", limit: 10 }]);
  await integrations.service._pushesIdle();
});


test("renewing an expired integration on the built-in Station is checked against the account's Portal plan", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  assert.equal((await call(app.base, "/api/stations", { cookie: owner.cookie })).status, 200);
  const create = async () => (await (await call(app.base, "/api/integrations", { cookie: owner.cookie, method: "POST", data: { stationId: built.id, name: "Hosted", scopes: ["agent.view"], publicJwk: publicJwk() } })).json()).id;
  const renew = (id) => call(app.base, "/api/integrations/" + id + "/renew", { cookie: owner.cookie, method: "POST", data: { expiresInDays: 30 } });
  const old = [];
  for (let i = 0; i < 4; i += 1) old.push(await create());
  await integrations.db.pool.query("UPDATE integrations SET expires_at = now() - interval '1 day' WHERE id = ANY($1)", [old]);
  const fresh = [];
  for (let i = 0; i < 4; i += 1) fresh.push(await create());
  const refused = await renew(old[0]);
  assert.deepEqual([refused.status, await refused.json()], [403, { error: "Your plan allows 4 integrations on the built-in Station. Revoke one, upgrade, or use your own Station.", code: "plan_limit", limit: 4 }]);
  assert.equal((await renew(fresh[0])).status, 200, "a live one renews at the limit");
  await app.store.transaction((state) => { state.accounts.find((entry) => entry.id === owner.sub).assignedPlan = "fellow"; });
  assert.equal((await renew(old[0])).status, 200, "a Fellow has no cap");
  await integrations.service._pushesIdle();
});

test("an Agora.Build admin's browser session and tokens list only the admin's own integrations; others' on the built-in Station are 404", async (t) => {
  const admin = accountId();
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true, admins: [admin] });
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  const boss = await signIn(app, admin);
  assert.equal((await call(app.base, "/api/stations", { cookie: owner.cookie })).status, 200);
  const create = async (cookie) => (await (await call(app.base, "/api/integrations", { cookie, method: "POST", data: { stationId: built.id, name: "Hosted", scopes: ["agent.view"], publicJwk: publicJwk() } })).json()).id;
  const theirs = await create(owner.cookie);
  const own = await create(boss.cookie);
  const roles = async (response) => (await response.json()).integrations.map((entry) => [entry.id, entry.role]);
  assert.deepEqual(await roles(await call(app.base, "/api/integrations", { cookie: boss.cookie })), [[own, "owner"]]);
  const bearer = await app.fake.issueAccessToken({ sub: admin, scope: "integrations:read integrations:approve" });
  assert.deepEqual(await roles(await call(app.base, "/api/v1/integrations", { bearer })), [[own, "owner"]]);
  for (const action of ["pause", "revoke", "resume"]) assert.equal((await call(app.base, "/api/integrations/" + theirs + "/" + action, { cookie: boss.cookie, method: "POST" })).status, 404, action);
  assert.equal((await call(app.base, "/api/integrations/" + theirs + "/events", { cookie: boss.cookie })).status, 404);
  assert.equal((await integrations.service.integrations(owner.sub)).integrations[0].state, "awaiting_approval", "nothing changed");
  await integrations.service._pushesIdle();
});

test("the stack syncs the built-in Stations from Auth once when it becomes ready, naming no account", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const manage = fakeManage();
  const built = manage.seedBuiltIn();
  const integrations = createIntegrationStack({ db, manage, idp: null, log: () => {} });
  const listings = () => manage.calls.filter((name) => name === "builtInStations").length;
  assert.equal(listings(), 0, "nothing before the first request");
  await integrations.ready();
  assert.equal(listings(), 1);
  assert.equal(manage.calls.includes("stations"), false, "no account's listing");
  assert.deepEqual((await db.pool.query("SELECT id, built_in, report_client_id FROM stations")).rows, [{ id: built.id, built_in: true, report_client_id: built.reportClientId }]);
  await integrations.ready();
  assert.equal(listings(), 1, "memoised with ready()");
});

test("the stack is ready even when the first built-in sync fails, retries it a minute later, and close() stops the syncs", async () => {
  const db = { async migrate() { return []; }, async ensureEventPartitions() { return []; }, async close() {} };
  const manage = fakeManage();
  let listings = 0;
  manage.builtInStations = async () => { listings += 1; throw new ManageError(503, "unavailable"); };
  const logs = [];
  const integrations = createIntegrationStack({ db, manage, idp: null, log: (line) => logs.push(line), builtInSyncAfter: { ok: 3600000, failed: 20 } });
  assert.equal(typeof (await integrations.ready()).stations, "function", "ready despite Auth refusing the listing");
  assert.deepEqual([listings, logs.filter((line) => line.startsWith("Built-in"))], [1, ["Built-in Station sync failed: unavailable."]]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(listings >= 2, "a failed sync is retried soon, not an hour later");
  await integrations.close();
  const after = listings;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(listings, after, "no sync after close()");
});

test("a successful built-in sync is repeated on the hourly schedule, with no platform admins anywhere", async () => {
  // A database whose every query finds nothing: enough for the built-in part of reconcile.
  const db = { pool: { async query() { return { rows: [] }; } }, async migrate() { return []; }, async ensureEventPartitions() { return []; }, async close() {} };
  const manage = fakeManage();
  let listings = 0;
  manage.builtInStations = async () => { listings += 1; return []; };
  const integrations = createIntegrationStack({ db, manage, idp: null, log: () => {}, builtInSyncAfter: { ok: 20, failed: 3600000 } });
  await integrations.ready();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(listings >= 2, "synced again on the ok schedule (" + listings + ")");
  await integrations.close();
});

test("the stack reads Auth's change feed once it is ready and again on each nudge, following an admin's pause", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const admin = accountId();
  const owner = accountId();
  const manage = fakeManage();
  const built = manage.seedBuiltIn({ integrations: true, admins: [admin] });
  const pushes = [];
  // The test database closes its own pool when the test ends.
  const integrations = createIntegrationStack({ db: { ...db, close: async () => {} }, manage, idp: null, log: () => {}, pushFetch: { async post(url) { pushes.push(url); return { status: 202 }; } }, authChanges: { pollMs: 3600000, minGapMs: 10 } });
  const reads = () => manage.calls.filter((name) => name === "integrationChanges").length;
  integrations.nudge(); // before ready(): nothing, not even preparing the stack (Ruling R-F)
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(manage.calls, [], "a nudge neither prepares the stack nor reads before it is ready");
  await integrations.ready();
  await waitFor(() => reads() === 1, "the first read, once ready");
  const created = await integrations.service.createIntegration(owner, { stationId: built.id, name: "Hosted", scopes: [], publicJwk: publicJwk() });
  manage.adminChange(created.id, { status: "paused", actor: admin, reason: "Spam" });
  integrations.nudge();
  await waitFor(async () => (await db.pool.query("SELECT paused_by FROM integrations WHERE id = $1", [created.id])).rows[0].paused_by === "admin", "the admin's pause in the Portal");
  assert.equal(reads(), 2);
  assert.equal((await db.pool.query("SELECT state FROM integrations WHERE id = $1", [created.id])).rows[0].state, "paused");
  await waitFor(async () => (await db.pool.query("SELECT cursor FROM auth_change_feed")).rows[0]?.cursor === manage.feed.at(-1).cursor, "the cursor saved after the page");
  await integrations.service._pushesIdle();
  assert.ok(pushes.includes(built.origin + "/agora-build/v1/changes"), "the Station was pushed");
  await integrations.close();
});

// The stack wires the reader's hooks and its read pass to the service (D29): the first read starts the feed over and
// rebuilds the accounts, every change in the pass's epoch, and when it reaches the end the rebuild is adopted: the view is
// complete and each built-in Station is told the end state. With the setting off the same feed completes nothing.
async function readAccountsThroughTheStack(t, delegatedHostWork) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const admin = accountId();
  const owner = accountId();
  const manage = fakeManage({ delegated: true });
  const built = manage.seedBuiltIn({ integrations: true, admins: [admin] });
  manage.accountChange(owner, true, { actor: admin, reason: "Abuse" });
  manage.baselineChange();
  const integrations = createIntegrationStack({ db: { ...db, close: async () => {} }, manage, idp: null, log: () => {}, delegatedHostWork, authChanges: { pollMs: 3600000, minGapMs: 5 } });
  await integrations.ready();
  await waitFor(async () => (await db.pool.query("SELECT cursor FROM auth_change_feed")).rows[0]?.cursor === manage.feed.at(-1).cursor, "the whole feed read");
  const complete = async () => (await db.pool.query("SELECT complete FROM account_baseline")).rows.map((row) => row.complete);
  if (delegatedHostWork) {
    await waitFor(async () => (await complete()).includes(true), "the baseline completed");
    const feed = await integrations.service.changes(built.reportClientId, "0");
    assert.deepEqual(feed.changes.filter((change) => change.kind.startsWith("account")).map((change) => [change.kind, change.account]), [["account_disabled", owner], ["accounts_baseline", null]]);
    assert.deepEqual(feed.disabledAccounts, [owner]);
  } else {
    assert.deepEqual(await complete(), [], "no mark with the setting off");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM integration_events WHERE kind IN ('account_disabled', 'accounts_baseline')")).rows[0].n, 0);
  }
  await integrations.close();
}
test("the stack's reader tells the service when it has caught up: with the setting on the baseline completes and reaches the built-in Station", (t) => readAccountsThroughTheStack(t, true));
test("the stack's reader with the setting off completes nothing and records nothing of Auth's account entries", (t) => readAccountsThroughTheStack(t, false));

test("a nudge before the stack is ready asks for nothing: no ready() retries and no log per nudge while the database is down", async () => {
  const calls = [];
  const db = {
    async migrate() { calls.push("migrate"); throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); },
    async ensureEventPartitions() { calls.push("partitions"); return []; },
    async close() {}
  };
  const manage = fakeManage();
  const logs = [];
  const integrations = createIntegrationStack({ db, manage, idp: null, log: (line) => logs.push(line), authChanges: { pollMs: 3600000, minGapMs: 5 } });
  for (let index = 0; index < 20; index += 1) integrations.nudge();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual([calls, manage.calls, logs], [[], [], []]);
  await assert.rejects(integrations.ready(), (error) => error.status === 503);
  for (let index = 0; index < 20; index += 1) integrations.nudge();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual([calls, manage.calls], [["migrate"], []], "a failed ready() is retried by the next request, never by a nudge");
  assert.deepEqual(logs, ["Portal database is not ready: ECONNREFUSED."]);
  await integrations.close();
});

test("an injected ready service takes a nudge and does nothing with it", async () => {
  const service = {};
  const integrations = readyIntegrations(service);
  assert.equal(integrations.nudge(), undefined);
  assert.equal(await integrations.ready(), service);
});

test("an injected ready service hands a nudge to the function it was given", async () => {
  const nudges = [];
  const integrations = readyIntegrations({}, () => nudges.push("asked"));
  integrations.nudge();
  assert.deepEqual(nudges, ["asked"]);
});

test("Auth's nudge is a bodiless POST that only asks for a read of Auth's feed: no session, no same-origin check, 60 a minute", async (t) => {
  const nudges = [];
  const app = await start(t, { integrations: {}, integrationNudge: () => nudges.push(Date.now()) });
  const nudge = (init = {}) => fetch(app.base + "/auth/integration-changes", { method: "POST", ...init });
  const answer = await nudge();
  assert.deepEqual([answer.status, await answer.text(), answer.headers.get("cache-control")], [204, "", "no-store"]);
  assert.equal(nudges.length, 1);
  // Server to server: another site's Origin and Sec-Fetch-Site don't matter, and nothing it sends is read.
  assert.equal((await nudge({ headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } })).status, 204);
  for (const body of ["{}", "x"]) assert.equal((await nudge({ body, headers: { "Content-Type": "application/json" } })).status, 413, "a nudge carries no body");
  const get = await fetch(app.base + "/auth/integration-changes");
  assert.deepEqual([get.status, get.headers.get("allow")], [405, "POST"]);
  assert.equal(nudges.length, 2, "only the bodiless POSTs asked for a read");
  // The address's allowance is 60 a minute, every POST counted. A refused one still asks for a read (reads run at
  // most one a second however many ask), so Auth's real nudge is never lost to a forger who spends the allowance.
  let accepted = 0;
  let refused = null;
  for (let index = 0; index < 70; index += 1) {
    const response = await nudge();
    if (response.status === 204) accepted += 1;
    else refused ??= response;
  }
  assert.equal(accepted, 56, "four POSTs above already counted");
  assert.deepEqual([refused.status, refused.headers.get("retry-after")], [429, "60"]);
  assert.equal(nudges.length, 72, "the 56 accepted and the 14 refused each asked for a read");
});

test("without Stations and integrations the nudge answers 404", async (t) => {
  const app = await start(t, { integrations: null });
  assert.equal((await fetch(app.base + "/auth/integration-changes", { method: "POST" })).status, 404);
});

test("the nudge refuses a body with 413 and closes the connection at once, without waiting for the body", async (t) => {
  const nudges = [];
  const app = await start(t, { integrations: {}, integrationNudge: () => nudges.push(1) });
  const { port } = app.server.address();
  // A raw request: Transfer-Encoding: chunked with a body the server must not wait for, then Content-Length: 5 with none
  // sent. The connection is the server's to close; a client-side safety timer (1 s) only keeps a broken server from hanging the test.
  const raw = (head) => new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = connect(port, "127.0.0.1", () => socket.write(head));
    let received = "";
    const safety = setTimeout(() => { socket.destroy(); }, 1000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("close", () => { clearTimeout(safety); resolve({ received, elapsed: Date.now() - started }); });
    socket.on("error", (error) => { clearTimeout(safety); reject(error); });
  });
  for (const head of ["POST /auth/integration-changes HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n", "POST /auth/integration-changes HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n"]) {
    const { received, elapsed } = await raw(head);
    assert.match(received, /^HTTP\/1\.1 413 /, "the body is refused before it arrives");
    assert.match(received, /connection: close/i);
    assert.ok(elapsed < 500, "the server closed the connection itself (" + elapsed + " ms)");
  }
  assert.deepEqual(nudges, []);
});

test("an unauthenticated nudge never looks up the session cookie or a guest", async (t) => {
  const lookups = [];
  const app = await start(t, { integrations: {}, integrationNudge: () => {} });
  for (const name of ["browserToken", "guestToken", "session"]) {
    const original = app.store[name];
    app.store[name] = (...args) => { lookups.push(name); return original.apply(app.store, args); };
  }
  const answer = await fetch(app.base + "/auth/integration-changes", { method: "POST", headers: { Cookie: "house_session=" + "a".repeat(40), Authorization: "Bearer not-a-token" } });
  assert.equal(answer.status, 204);
  assert.deepEqual(lookups, [], "no session work for a nudge");
});

test("the nudge's allowance is per client address: behind TRUST_PROXY=1 the last X-Forwarded-For hop, never a leading one", async (t) => {
  const app = await start(t, { integrations: {}, integrationNudge: () => {}, trustProxy: "1" });
  const nudge = (forwardedFor) => fetch(app.base + "/auth/integration-changes", { method: "POST", headers: { "X-Forwarded-For": forwardedFor } });
  for (let index = 0; index < 60; index += 1) assert.equal((await nudge("198.51.100." + (index % 250) + ", 203.0.113.9")).status, 204, "a spoofed leading hop earns nothing");
  assert.equal((await nudge("192.0.2.1, 203.0.113.9")).status, 429, "the proxy-added hop is the client");
  assert.equal((await nudge("203.0.113.10")).status, 204, "another address has its own allowance");
});

test("a nudge asks the running stack for a read: it never starts, retries or logs for the stack", async (t) => {
  const calls = { ready: 0, nudge: 0 };
  const stack = { service: {}, ready: async () => { calls.ready += 1; return stack.service; }, nudge: () => { calls.nudge += 1; }, close: async () => {} };
  const app = await start(t, { integrationStack: stack });
  await waitFor(() => calls.ready === 1, "the stack's start at server start");
  for (let index = 0; index < 5; index += 1) assert.equal((await fetch(app.base + "/auth/integration-changes", { method: "POST" })).status, 204);
  assert.deepEqual(calls, { ready: 1, nudge: 5 });
  assert.deepEqual(stackLines(app), []);
});

test("the stack starts when the server starts, without holding up the server, and the start is retried until it succeeds", async (t) => {
  const calls = [];
  let failMigrate = true;
  const db = {
    pool: { async query() { return { rows: [] }; } },
    async migrate() { calls.push("migrate"); if (failMigrate) { failMigrate = false; throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } return []; },
    async ensureEventPartitions() { return []; },
    async close() { calls.push("close"); }
  };
  const manage = fakeManage();
  const reads = () => manage.calls.filter((name) => name === "integrationChanges").length;
  const stackLogs = [];
  const stack = createIntegrationStack({ db, manage, idp: null, log: (line) => stackLogs.push(line), authChanges: { pollMs: 3600000, minGapMs: 5 } });
  const app = await start(t, { integrationStack: stack, integrationRetryMs: { first: 20, max: 40 } });
  // No request has asked for the stack: it started itself, failed once, and tried again.
  await waitFor(() => reads() === 1, "the reader's first read");
  assert.deepEqual(calls, ["migrate", "migrate"]);
  assert.deepEqual(stackLogs, ["Portal database is not ready: ECONNREFUSED."]);
  assert.deepEqual(stackLines(app), ["Stations and integrations did not start; trying again in 1 s."], "a fixed message and the delay, nothing from the error");
  // Started, it is not started again.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(calls, ["migrate", "migrate"]);
  assert.equal(stackLines(app).length, 1);
  await app.stop();
  await waitFor(() => calls.at(-1) === "close", "the stack's close");
});

test("a start that never finishes does not hold up the server", async (t) => {
  const stack = { service: {}, ready: () => new Promise(() => {}), nudge: () => {}, close: async () => {} };
  const app = await start(t, { integrationStack: stack });
  const page = await fetch(app.base + "/");
  assert.equal(page.status, 200);
  await page.arrayBuffer();
});

test("closing the server stops the start's retries and closes the stack", async (t) => {
  const calls = { ready: 0, close: 0 };
  const stack = { service: {}, ready: async () => { calls.ready += 1; throw Object.assign(new Error("secret detail"), { code: "ECONNREFUSED" }); }, nudge: () => {}, close: async () => { calls.close += 1; } };
  const app = await start(t, { integrationStack: stack, integrationRetryMs: { first: 15, max: 15 } });
  await waitFor(() => calls.ready >= 3, "retries of the start");
  assert.ok(stackLines(app).length >= 3);
  assert.ok(stackLines(app).every((line) => /^Stations and integrations did not start \(ECONNREFUSED\)(; trying again in 1 s)?\.$/.test(line)), "a fixed message, the code and the delay only");
  await app.stop();
  await waitFor(() => calls.close === 1, "the stack's close");
  const settled = { ...calls, logs: stackLines(app).length };
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual({ ...calls, logs: stackLines(app).length }, settled, "no start after the server closed");
});

test("a start that fails with a non-Error, or whose log throws, is still retried and never an unhandled rejection", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const reasons = [undefined, null, "down", { code: "x".repeat(200) + " secret" }];
  let calls = 0;
  const stack = { service: {}, ready: () => { calls += 1; return calls <= reasons.length ? Promise.reject(reasons[calls - 1]) : Promise.resolve(); }, nudge: () => {}, close: async () => {} };
  let thrown = 0;
  const app = await start(t, { integrationStack: stack, integrationRetryMs: { first: 10, max: 10 }, log: (line) => { if (line.startsWith("Stations and integrations did not start") && thrown < 2) { thrown += 1; throw new Error("the log failed"); } } });
  await waitFor(() => calls === reasons.length + 1, "a retry after each failure");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, reasons.length + 1, "started, then left alone");
  assert.deepEqual(unhandled, []);
  assert.ok(stackLines(app).every((line) => /^Stations and integrations did not start(; trying again in 1 s)?\.$/.test(line)), "no code that is not a plain code, nothing from the error: " + JSON.stringify(stackLines(app)));
});

test("close() stops reading Auth's change feed", async () => {
  // A database whose every query finds nothing: an empty cursor, no built-in Stations.
  const db = { pool: { async query() { return { rows: [] }; } }, async migrate() { return []; }, async ensureEventPartitions() { return []; }, async close() {} };
  const manage = fakeManage();
  const reads = () => manage.calls.filter((name) => name === "integrationChanges").length;
  const integrations = createIntegrationStack({ db, manage, idp: null, log: () => {}, authChanges: { pollMs: 20, minGapMs: 5 } });
  await integrations.ready();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(reads() >= 2, "it polls (" + reads() + " reads)");
  await integrations.close();
  const after = reads();
  integrations.nudge();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reads(), after, "no read after close(), nudged or not");
});
test("the built-in Station's own report token reports and reads a feed of every integration on it, and only those", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service });
  const token = await app.fake.issueAccessToken({ sub: BUILT_IN_REPORT_CLIENT, client_id: BUILT_IN_REPORT_CLIENT, scope: "station.report" });
  // A report client the Portal does not know is refused.
  const strangerClient = "s-" + "0".repeat(24) + "bz";
  const stranger = await call(app.base, "/api/v1/stations/changes?cursor=0", { bearer: await app.fake.issueAccessToken({ sub: strangerClient, client_id: strangerClient, scope: "station.report" }) });
  assert.deepEqual([stranger.status, (await stranger.json()).code], [403, "station"]);
  // The startup sync (the stack runs it at ready(); this test injects the service, so it runs it as the stack would)
  // makes the built-in Station known before anyone has signed in.
  assert.equal(await integrations.service.syncBuiltIn(), true);
  const first = await call(app.base, "/api/v1/stations/changes?cursor=0", { bearer: token });
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).integrations, []);
  const ada = await signIn(app);
  const bo = await signIn(app);
  const custom = (await registerStation(app, integrations, ada.cookie)).station;
  assert.equal((await call(app.base, "/api/stations", { cookie: ada.cookie })).status, 200);
  const mine = await createIntegration(app, ada.cookie, built.id);
  const theirs = await createIntegration(app, bo.cookie, built.id);
  const elsewhere = await createIntegration(app, ada.cookie, custom.id);
  const feed = await (await call(app.base, "/api/v1/stations/changes?cursor=0", { bearer: token })).json();
  assert.deepEqual(feed.integrations.map((entry) => [entry.id, entry.ownerAccount]), [[mine.id, ada.sub], [theirs.id, bo.sub]]);
  assert.ok(feed.changes.every((change) => change.integrationId !== elsewhere.id), "nothing of another Station");
  await integrations.service.approve(ada.sub, mine.id, { r9Svc: R9 });
  const reported = await call(app.base, "/api/v1/stations/reports", { bearer: token, method: "POST", data: { integrationId: mine.id, state: "waiting_for_host" } });
  assert.deepEqual([reported.status, (await reported.json()).state], [200, "waiting_for_host"]);
  const foreign = await call(app.base, "/api/v1/stations/reports", { bearer: token, method: "POST", data: { integrationId: elsewhere.id, state: "waiting_for_host" } });
  assert.equal(foreign.status, 404, "another Station's integration is unknown to it");
  assert.equal((await app.store.snapshot()).accounts.some((account) => account.id === BUILT_IN_REPORT_CLIENT), false, "no Portal account");
  await integrations.service._pushesIdle();
  const hints = integrations.pushes.filter((push) => push.url === "https://station.agora.test/agora-build/v1/changes");
  assert.ok(hints.length > 0 && hints.every((push) => Number.isSafeInteger(push.body.cursor)), "push hints go to its origin");
});

test("the built-in Station answers 409 through the routes: built_in, origin_taken and not_supported", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: false });
  const app = await start(t, { integrations: integrations.service });
  const ada = await signIn(app);
  const bo = await signIn(app);
  assert.equal((await call(app.base, "/api/stations", { cookie: ada.cookie })).status, 200);
  const code = async (response, status, expected) => assert.deepEqual([response.status, (await response.json()).code], [status, expected]);
  const path = "/api/stations/" + built.id;
  await code(await call(app.base, path, { cookie: ada.cookie, method: "DELETE" }), 409, "built_in");
  await code(await call(app.base, path + "/members/" + bo.sub, { cookie: ada.cookie, method: "PUT" }), 409, "built_in");
  await code(await call(app.base, path + "/members/" + bo.sub, { cookie: ada.cookie, method: "DELETE" }), 409, "built_in");
  await code(await call(app.base, path + "/members/" + ada.sub, { cookie: ada.cookie, method: "DELETE" }), 409, "built_in");
  await code(await call(app.base, path + "/members", { cookie: ada.cookie }), 409, "built_in");
  await code(await call(app.base, "/api/stations/challenges", { cookie: ada.cookie, method: "POST", data: { origin: built.origin } }), 409, "origin_taken");
  const create = await call(app.base, "/api/integrations", { cookie: ada.cookie, method: "POST", data: { stationId: built.id, name: "My app", scopes: ["agent.view"], publicJwk: publicJwk() } });
  await code(create, 409, "not_supported");
  await integrations.service._pushesIdle();
});

// D29: the native Station directory, GET /api/v1/stations (issue 40): a bearer token with integrations:read, keyset pages
// carrying stale and complete, and the Stations lost within 30 days. The setting on only.
const DAY = 86400000;
const LIST_KEYS = ["access", "builtIn", "createdAt", "id", "integrationsEnabled", "membership", "membershipEndedAt", "name", "origin", "removedAt", "role", "status"];
const NO_LIMIT = { error: "Choose a limit of 1 to 100.", code: "limit" };
const NO_CURSOR = { error: "Send the cursor this list gave you.", code: "cursor" };
const directoryToken = (app, sub, scope = "integrations:read") => app.fake.issueAccessToken({ sub, client_id: "astation", scope });
const directory = (app, bearer, query = "") => call(app.base, "/api/v1/stations" + query, { bearer });
// The Stations get creation times a day apart, so the directory's order is the order given (a built-in Station aside).
const dateStations = async (integrations, ...ids) => {
  for (const [index, id] of ids.entries()) await integrations.db.pool.query("UPDATE stations SET created_at = $2 WHERE id = $1", [id, new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * DAY)]);
};
const summary = (body) => body.stations.map((entry) => [entry.id, entry.role, entry.status, entry.membership]);

test("with the setting on, GET /api/v1/stations lists what the account can use, and what it lost in the last 30 days, with the loss stated", async (t) => {
  const clock = { now: Date.now() };
  const integrations = await stack(t, { delegatedHostWork: true, now: () => clock.now });
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  assert.equal(await integrations.service.syncBuiltIn(), true);
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const ada = await signIn(app);
  const bo = await signIn(app);
  const station = async (who, origin) => (await registerStation(app, integrations, who.cookie, origin)).station;
  const owned = await station(ada, "https://owned.example");
  const shared = await station(bo, "https://shared.example");
  const left = await station(bo, "https://left.example");
  const later = await station(ada, "https://later.example");
  const early = await station(ada, "https://early.example");
  const strangers = await station(bo, "https://strangers.example");
  for (const { id } of [shared, left]) assert.equal((await call(app.base, "/api/stations/" + id + "/members/" + ada.sub, { cookie: bo.cookie, method: "PUT" })).status, 200);
  await dateStations(integrations, owned.id, shared.id, left.id, later.id, early.id, strangers.id);
  const bearer = await directoryToken(app, ada.sub);
  const when = (ms) => new Date(ms).toISOString();

  const lostAt = clock.now;
  assert.equal((await call(app.base, "/api/stations/" + early.id, { cookie: ada.cookie, method: "DELETE" })).status, 200);
  assert.equal((await call(app.base, "/api/stations/" + left.id + "/members/" + ada.sub, { cookie: bo.cookie, method: "DELETE" })).status, 200);

  const first = await directory(app, bearer);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.deepEqual(Object.keys(body).sort(), ["complete", "nextCursor", "stale", "stations"]);
  assert.deepEqual([body.nextCursor, body.stale, body.complete], [null, false, true]);
  assert.deepEqual(summary(body), [
    [built.id, "built_in", "active", null], [owned.id, "owner", "active", null], [shared.id, "member", "active", "current"],
    [left.id, "member", "active", "ended"], [later.id, "owner", "active", null], [early.id, "owner", "removed", null]
  ], "the built-in Station first, then by creation; a Station of another account, and one it has no part in, are not there");
  for (const entry of body.stations) assert.deepEqual(Object.keys(entry).sort(), LIST_KEYS);
  const byId = Object.fromEntries(body.stations.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId[built.id], { id: built.id, origin: built.origin, name: "Agora Station", builtIn: true, access: "any_account", role: "built_in", status: "active", removedAt: null, membership: null, membershipEndedAt: null, integrationsEnabled: true, createdAt: byId[built.id].createdAt });
  assert.equal(typeof byId[built.id].createdAt, "string");
  assert.deepEqual(byId[owned.id], { id: owned.id, origin: "https://owned.example", name: null, builtIn: false, access: "members", role: "owner", status: "active", removedAt: null, membership: null, membershipEndedAt: null, integrationsEnabled: true, createdAt: when(Date.parse("2026-01-01T00:00:00.000Z")) });
  assert.deepEqual([byId[shared.id].membership, byId[shared.id].membershipEndedAt, byId[shared.id].integrationsEnabled], ["current", null, true]);
  assert.deepEqual([byId[left.id].status, byId[left.id].removedAt, byId[left.id].membershipEndedAt, byId[left.id].integrationsEnabled], ["active", null, when(lostAt), false], "an ended membership says when");
  assert.deepEqual([byId[early.id].removedAt, byId[early.id].membership, byId[early.id].integrationsEnabled], [when(lostAt), null, false], "a removed Station says when");
  const text = JSON.stringify(body);
  for (const hidden of [owned.reportClientId, bo.sub, "reportClientId", "ownerAccount"]) assert.equal(text.includes(hidden), false, hidden);

  // 20 days later: a Station removed now, and the earlier losses are still stated.
  clock.now = lostAt + 20 * DAY;
  assert.equal((await call(app.base, "/api/stations/" + later.id, { cookie: ada.cookie, method: "DELETE" })).status, 200);
  const twenty = await (await directory(app, bearer)).json();
  assert.deepEqual(summary(twenty), [
    [built.id, "built_in", "active", null], [owned.id, "owner", "active", null], [shared.id, "member", "active", "current"],
    [left.id, "member", "active", "ended"], [later.id, "owner", "removed", null], [early.id, "owner", "removed", null]
  ]);
  assert.equal(twenty.stations.find((entry) => entry.id === later.id).removedAt, when(lostAt + 20 * DAY));
  // 31 days after the first losses: they may be omitted, and are; the later removal is 11 days old and stays.
  clock.now = lostAt + 31 * DAY;
  assert.deepEqual(summary(await (await directory(app, bearer)).json()), [
    [built.id, "built_in", "active", null], [owned.id, "owner", "active", null], [shared.id, "member", "active", "current"], [later.id, "owner", "removed", null]
  ]);
  clock.now = lostAt + 51 * DAY;
  const after = await (await directory(app, bearer)).json();
  assert.deepEqual(summary(after), [[built.id, "built_in", "active", null], [owned.id, "owner", "active", null], [shared.id, "member", "active", "current"]]);
  assert.deepEqual([after.stale, after.complete], [false, true]);
  // A token's account never sees another's Stations, and has the built-in Station alone to begin with.
  const newcomer = await (await directory(app, await directoryToken(app, accountId()))).json();
  assert.deepEqual(summary(newcomer), [[built.id, "built_in", "active", null]]);
});

test("GET /api/v1/stations pages with limit and cursor: complete only on the last page", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const ada = await signIn(app);
  const a = (await registerStation(app, integrations, ada.cookie, "https://a.example")).station;
  const b = (await registerStation(app, integrations, ada.cookie, "https://b.example")).station;
  const c = (await registerStation(app, integrations, ada.cookie, "https://c.example")).station;
  await dateStations(integrations, a.id, b.id, c.id);
  const bearer = await directoryToken(app, ada.sub);
  const walk = async (limit) => {
    const pages = [];
    let cursor = null;
    do {
      const response = await directory(app, bearer, "?limit=" + limit + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      assert.equal(response.status, 200);
      pages.push(await response.json());
      cursor = pages.at(-1).nextCursor;
      assert.ok(pages.length <= 10, "the pages end");
    } while (cursor);
    return pages;
  };
  const ids = [built.id, a.id, b.id, c.id];
  const single = await walk(1);
  assert.deepEqual(single.map((page) => page.stations.map((entry) => entry.id)), ids.map((id) => [id]));
  assert.deepEqual(single.map((page) => page.complete), [false, false, false, true], "a page with another after it is incomplete");
  assert.deepEqual(single.map((page) => page.nextCursor === null), [false, false, false, true]);
  assert.deepEqual(single.map((page) => page.stale), [false, false, false, false]);
  const decoded = JSON.parse(Buffer.from(single[0].nextCursor, "base64url").toString("utf8"));
  assert.deepEqual(decoded, [true, single[0].stations[0].createdAt, built.id], "[builtIn, createdAt, id] of the last Station on the page");
  assert.deepEqual((await walk(3)).map((page) => [page.stations.length, page.complete]), [[3, false], [1, true]]);
  assert.deepEqual((await walk(4)).map((page) => [page.stations.length, page.complete]), [[4, true]], "the page that ends the list is complete");
  const whole = await (await directory(app, bearer)).json();
  assert.deepEqual([whole.stations.map((entry) => entry.id), whole.complete], [ids, true], "the default limit is 100");
  assert.deepEqual((await (await directory(app, bearer, "?limit=100")).json()).stations.length, 4);
  // Every page the same entries as the one list.
  assert.deepEqual(single.flatMap((page) => page.stations), whole.stations);
});

test("GET /api/v1/stations refuses a bad limit or cursor with 400 limit or cursor, before Auth", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const ada = await signIn(app);
  const bearer = await directoryToken(app, ada.sub);
  const calls = integrations.manage.calls.length;
  for (const limit of ["0", "101", "-1", "1.5", "abc", "", "%20", "1e2", "0x1", "+5", "5%20", "1000000000000000000000"]) {
    const response = await directory(app, bearer, "?limit=" + limit);
    assert.deepEqual([response.status, await response.json()], [400, NO_LIMIT], "limit=" + limit);
  }
  const wellFormed = Buffer.from(JSON.stringify([false, "2026-01-02T03:04:05.678Z", "st1"])).toString("base64url");
  for (const cursor of ["", "garbage!", "e30", "%20", wellFormed + "=", Buffer.from("[1,2,3]").toString("base64url"), Buffer.from(JSON.stringify([false, "2026-01-02", "st1"])).toString("base64url"), Buffer.from(JSON.stringify([false, "2026-01-02T03:04:05.678Z", ""])).toString("base64url"), "a".repeat(2000)]) {
    const response = await directory(app, bearer, "?cursor=" + cursor);
    assert.deepEqual([response.status, await response.json()], [400, NO_CURSOR], "cursor=" + cursor.slice(0, 40));
  }
  // The limit is checked first, and a refusal does not hide behind another: both bad is the limit.
  assert.deepEqual((await (await directory(app, bearer, "?limit=0&cursor=!")).json()).code, "limit");
  assert.equal(integrations.manage.calls.length, calls, "Auth was not asked");
  assert.equal((await directory(app, bearer, "?limit=1&cursor=" + wellFormed)).status, 200, "a cursor of this list's form is a place in it");
  assert.equal((await directory(app, bearer, "?limit=100")).status, 200);
  assert.equal((await directory(app, bearer, "?limit=1&foo=bar")).status, 200, "other parameters are ignored");
});

test("GET /api/v1/stations is stale, and never complete, when Auth's listing fails with 503", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const ada = await signIn(app);
  const a = (await registerStation(app, integrations, ada.cookie, "https://a.example")).station;
  const bearer = await directoryToken(app, ada.sub);
  const fresh = await (await directory(app, bearer)).json();
  assert.deepEqual([fresh.stale, fresh.complete, fresh.stations.length], [false, true, 2]);
  integrations.manage.failNext.stations = { status: 503, code: "unavailable" };
  const stale = await directory(app, bearer);
  assert.equal(stale.status, 200, "the Portal's last copy, not an error");
  const body = await stale.json();
  assert.deepEqual([body.stale, body.complete, body.nextCursor], [true, false, null], "the last page, but not complete");
  assert.deepEqual(body.stations, fresh.stations);
  // Each page of a stale list is stale and incomplete, the last one too.
  integrations.manage.down = true;
  const pages = [];
  let cursor = null;
  do {
    const page = await (await directory(app, bearer, "?limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""))).json();
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor && pages.length < 5);
  assert.deepEqual(pages.map((page) => [page.stations.map((entry) => entry.id), page.stale, page.complete]), [[[built.id], true, false], [[a.id], true, false]]);
  integrations.manage.down = false;
  assert.deepEqual([(await (await directory(app, bearer)).json()).stale, (await (await directory(app, bearer)).json()).complete], [false, true], "Auth is back");
  // Only Auth being unavailable is stale: another refusal is the error the browser's list gives.
  integrations.manage.failNext.stations = { status: 400, code: "invalid_request" };
  const refused = await directory(app, bearer);
  assert.deepEqual([refused.status, (await refused.json()).code], [400, "invalid_request"]);
});

test("GET /api/v1/stations needs integrations:read, shares the account's list budget, and is for access tokens", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const ada = await signIn(app);
  const calls = integrations.manage.calls.length;
  for (const scope of ["credits", "integrations:approve", "station.read"]) assertScope(await directory(app, await directoryToken(app, ada.sub, scope)), "integrations:read");
  assert.equal(integrations.manage.calls.length, calls, "a token without the scope reaches nothing");
  assert.equal((await directory(app, await directoryToken(app, ada.sub, "integrations:read integrations:approve"))).status, 200, "among others");
  // A Station's own report token is not an account's.
  const reporter = await directory(app, await app.fake.issueAccessToken({ sub: BUILT_IN_REPORT_CLIENT, client_id: BUILT_IN_REPORT_CLIENT, scope: "station.report integrations:read" }));
  assert.equal(reporter.status, 403);
  assert.match((await reporter.json()).error, /report token/);
  // No credentials, or a bad token.
  assert.equal((await call(app.base, "/api/v1/stations")).status, 401);
  const bad = await directory(app, "not-a-token");
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate"), /invalid_token/);
  // Only GET.
  assert.equal((await call(app.base, "/api/v1/stations", { bearer: await directoryToken(app, ada.sub), method: "POST", data: {} })).status, 404);
  assert.equal((await call(app.base, "/api/v1/stations/st-unknown", { bearer: await directoryToken(app, ada.sub) })).status, 404);
  // 60 a minute for an account, as for the browser's list; a limited request does not reach Auth.
  const busy = await signIn(app);
  const bearer = await directoryToken(app, busy.sub);
  for (let index = 0; index < 59; index += 1) assert.notEqual((await directory(app, bearer)).status, 429, "#" + (index + 1));
  assert.equal((await call(app.base, "/api/stations", { cookie: busy.cookie })).status, 200, "the 60th is the browser's");
  const seen = integrations.manage.calls.length;
  const over = await directory(app, bearer);
  assert.deepEqual([over.status, (await over.json()).error], [429, "A few too many requests. Please try again in a moment."]);
  assert.equal(integrations.manage.calls.length, seen);
  assert.equal((await directory(app, await directoryToken(app, ada.sub))).status, 200, "another account is not limited");
});

test("with the setting on, a token on the unversioned /api/stations gets the versioned-API 404, and the browser's list is as it was", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const ada = await signIn(app);
  const { station } = await registerStation(app, integrations, ada.cookie);
  const token = await call(app.base, "/api/stations", { bearer: await directoryToken(app, ada.sub) });
  assert.equal(token.status, 404);
  assert.equal((await token.json()).error, "Access tokens use the versioned API: /api/v1/stations.");
  const listed = await call(app.base, "/api/stations?limit=1&cursor=nonsense", { cookie: ada.cookie });
  assert.equal(listed.status, 200, "a browser session ignores the directory's parameters");
  const body = await listed.json();
  assert.deepEqual(Object.keys(body).sort(), ["notices", "stale", "stations"], "with the setting on the list also carries the account's notices (none here)");
  assert.deepEqual(body.notices, []);
  assert.deepEqual(body.stations.map((entry) => [entry.id, entry.role]), [[built.id, "built_in"], [station.id, "owner"]]);
  assert.deepEqual(Object.keys(body.stations[1]).sort(), ["builtIn", "createdAt", "id", "integrationsEnabled", "name", "origin", "ownerAccount", "reportClientId", "role", "status"], "today's view, not the directory's");
});

test("with the setting on, a cookie with no token on /api/v1/stations gets the browser's list, as on /api/v1/integrations: the directory needs a token", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const ada = await signIn(app);
  const { station } = await registerStation(app, integrations, ada.cookie);
  const cookie = await call(app.base, "/api/v1/stations?limit=1", { cookie: ada.cookie });
  assert.equal(cookie.status, 200);
  const body = await cookie.json();
  assert.deepEqual(Object.keys(body).sort(), ["notices", "stale", "stations"], "the browser's list: no nextCursor, no complete");
  assert.deepEqual(body.stations.map((entry) => entry.id), [built.id, station.id], "and the limit is ignored");
  assert.deepEqual(Object.keys(body.stations[1]).sort(), ["builtIn", "createdAt", "id", "integrationsEnabled", "name", "origin", "ownerAccount", "reportClientId", "role", "status"]);
  const token = await (await directory(app, await directoryToken(app, ada.sub, "integrations:read"), "?limit=1")).json();
  assert.deepEqual(Object.keys(token).sort(), ["complete", "nextCursor", "stale", "stations"], "with a token it is the directory");
  assert.equal(token.stations.length, 1);
});

test("with the setting off, GET /api/v1/stations does not exist and the browser's list is as it was", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service });
  const ada = await signIn(app);
  const { station } = await registerStation(app, integrations, ada.cookie);
  const calls = integrations.manage.calls.length;
  const missing = await directory(app, await directoryToken(app, ada.sub));
  assert.deepEqual([missing.status, (await missing.json()).error], [404, "This API was not found. See https://github.com/Agora-Build/Portal/blob/main/docs/platform.md for the /api/v1 routes."]);
  assert.equal(integrations.manage.calls.length, calls, "no listing");
  const unversioned = await call(app.base, "/api/stations", { bearer: await directoryToken(app, ada.sub) });
  assert.equal(unversioned.status, 403, "a token on the browser's route is refused as it was");
  assert.match((await unversioned.json()).error, /browser session/);
  const listed = await call(app.base, "/api/stations?limit=1", { cookie: ada.cookie });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.deepEqual(Object.keys(body).sort(), ["stale", "stations"]);
  assert.deepEqual(body.stations.map((entry) => [entry.id, entry.role]), [[built.id, "built_in"], [station.id, "owner"]]);
});

// D29 two-phase removal: the browser's DELETE answers what the service says.
test("with the setting on, DELETE /api/stations/<id> answers the two-phase removal: removing with completeBy, or removed when nothing was left to pass on", async (t) => {
  const integrations = await stack(t, { delegatedHostWork: true });
  if (!integrations) return;
  const app = await start(t, { integrations: integrations.service, delegatedHostWork: "1" });
  const owner = await signIn(app);
  const { station } = await registerStation(app, integrations, owner.cookie);
  const mine = await createIntegration(app, owner.cookie, station.id);
  await integrations.db.pool.query("UPDATE integrations SET state = 'ready' WHERE id = $1", [mine.id]);
  const removing = await call(app.base, "/api/stations/" + station.id, { cookie: owner.cookie, method: "DELETE" });
  const body = await removing.json();
  assert.deepEqual([removing.status, Object.keys(body), body.removed, body.removing, typeof body.completeBy], [200, ["removed", "removing", "completeBy"], false, true, "string"]);
  const listed = (await (await call(app.base, "/api/stations", { cookie: owner.cookie })).json()).stations;
  assert.deepEqual(listed.map((entry) => [entry.id, entry.status]), [[station.id, "removing"]]);
  const empty = (await registerStation(app, integrations, owner.cookie, "https://two.example")).station;
  const removed = await call(app.base, "/api/stations/" + empty.id, { cookie: owner.cookie, method: "DELETE" });
  assert.deepEqual([removed.status, await removed.json()], [200, { removed: true }]);
});

// D29: the stack's hourly sync also completes the removals that are done; the first sync, at ready(), included.
test("the stack's built-in sync then completes the removals that are done: a Station removing for 26 hours is removed, its integration flagged, and pushed once more", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const owner = accountId();
  const manage = fakeManage({ delegated: true });
  const registered = await manage.registerStation({ origin: "https://one.example", owner, reportKey: {}, actor: owner });
  await manage.beginStationRemoval(registered.id, owner);
  const repository = createRepository(db);
  await repository.insertStation({ id: registered.id, origin: "https://one.example", ownerAccount: owner, reportClientId: registered.reportClientId, verifiedAt: Date.now() });
  await repository.markStationRemoving(registered.id, Date.now() - 27 * 3600000);
  await repository.insertIntegration({ id: "i-1", ownerAccount: owner, stationId: registered.id, kind: "custom_app", name: "App", scopes: ["agent.view"], quotaPerSecond: 200, expiresAt: Date.now() + 86400000 });
  await repository.updateIntegration("i-1", { state: "revoking", r9Svc: R9, revokedAt: Date.now() - 27 * 3600000 });
  const logs = [];
  const pushes = [];
  const integrations = createIntegrationStack({
    db: { ...db, close: async () => {} }, manage, idp: null, log: (line) => logs.push(line), delegatedHostWork: true, authChanges: { pollMs: 3600000, minGapMs: 5 },
    pushFetch: { async post(url) { pushes.push(url); return { status: 202 }; } }
  });
  try {
    await integrations.ready();
    // ready() does not wait for the completions: the first sync starts them, and the log line comes once one has committed.
    await waitFor(() => logs.includes("Station removal completed after 26 hours: 1 integration pending host revocation."), "the removal the first sync completes");
    assert.equal((await repository.station(registered.id)).status, "removed", "completed after the first sync");
    const row = await repository.integration("i-1");
    assert.deepEqual([row.state, row.pendingHostRevocation], ["revoked", true]);
    assert.equal(manage.calls.filter((name) => name === "completeStationRemoval").length, 1);
    await integrations.service._pushesIdle();
    assert.deepEqual(pushes, ["https://one.example/agora-build/v1/changes"]);
  } finally {
    await integrations.close();
  }
});

// A removing Station (D29) with one revoking integration, begun `hoursAgo` hours ago, in both Auth and the Portal's database.
async function seedRemoving(db, manage, hoursAgo) {
  const owner = accountId();
  const registered = await manage.registerStation({ origin: "https://one.example", owner, reportKey: {}, actor: owner });
  await manage.beginStationRemoval(registered.id, owner);
  const repository = createRepository(db);
  await repository.insertStation({ id: registered.id, origin: "https://one.example", ownerAccount: owner, reportClientId: registered.reportClientId, verifiedAt: Date.now() });
  await repository.markStationRemoving(registered.id, Date.now() - hoursAgo * 3600000);
  await repository.insertIntegration({ id: "i-1", ownerAccount: owner, stationId: registered.id, kind: "custom_app", name: "App", scopes: ["agent.view"], quotaPerSecond: 200, expiresAt: Date.now() + 86400000 });
  await repository.updateIntegration("i-1", { state: "revoking", r9Svc: R9, revokedAt: Date.now() - hoursAgo * 3600000 });
  return { repository, station: registered };
}

test("a built-in sync that fails completes no removal: Auth is not asked to complete one", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const manage = fakeManage({ delegated: true });
  const { repository, station } = await seedRemoving(db, manage, 27);
  manage.down = true;
  const logs = [];
  const integrations = createIntegrationStack({
    db: { ...db, close: async () => {} }, manage, idp: null, log: (line) => logs.push(line), delegatedHostWork: true,
    authChanges: { pollMs: 3600000, minGapMs: 5 }, builtInSyncAfter: { ok: 3600000, failed: 3600000 }
  });
  try {
    await integrations.ready();
    assert.ok(logs.includes("Built-in Station sync failed: unavailable."));
    assert.equal(manage.calls.includes("completeStationRemoval"), false);
    assert.equal((await repository.station(station.id)).status, "removing");
  } finally {
    await integrations.close();
  }
});

test("the hourly sync completes a removal that has become 26 hours old since the last one", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const manage = fakeManage({ delegated: true });
  const { repository, station } = await seedRemoving(db, manage, 1);
  const integrations = createIntegrationStack({
    db: { ...db, close: async () => {} }, manage, idp: null, log: () => {}, delegatedHostWork: true,
    authChanges: { pollMs: 3600000, minGapMs: 5 }, builtInSyncAfter: { ok: 20, failed: 3600000 }
  });
  try {
    await integrations.ready();
    assert.equal((await repository.station(station.id)).status, "removing", "an hour old: still removing");
    await db.pool.query("UPDATE stations SET removal_started_at = now() - interval '27 hours' WHERE id = $1", [station.id]);
    await waitFor(async () => (await repository.station(station.id)).status === "removed", "the removal completed by the next sync");
    assert.deepEqual([(await repository.integration("i-1")).pendingHostRevocation, manage.calls.filter((name) => name === "completeStationRemoval").length], [true, 1]);
  } finally {
    await integrations.close();
  }
});

test("ready() does not wait for the removals the first sync completes: it is ready while Auth's completion is still held", { timeout: 20000 }, async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const manage = fakeManage({ delegated: true });
  const { repository, station } = await seedRemoving(db, manage, 27);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const complete = manage.completeStationRemoval;
  let asked = 0;
  manage.completeStationRemoval = async (...args) => { asked += 1; await held; return complete(...args); };
  const integrations = createIntegrationStack({
    db: { ...db, close: async () => {} }, manage, idp: null, log: () => {}, delegatedHostWork: true,
    authChanges: { pollMs: 3600000, minGapMs: 5 }
  });
  try {
    // Bounded, so a ready() that waited for the held completion fails this test instead of hanging the run.
    const expired = new Promise((resolve, reject) => setTimeout(() => reject(new Error("ready() waited for the completions")), 5000).unref());
    assert.equal(typeof (await Promise.race([integrations.ready(), expired])).stations, "function", "ready although Auth has not answered the completion");
    await waitFor(() => asked > 0, "the completion asked of Auth");
    assert.equal((await repository.station(station.id)).status, "removing");
    release();
    await waitFor(async () => (await repository.station(station.id)).status === "removed", "the removal completed once Auth answers");
  } finally {
    release();
    await integrations.close();
  }
});
