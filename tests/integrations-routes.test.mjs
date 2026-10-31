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
import { createStore } from "../scripts/store.mjs";
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
    ...(options.log ? { log: (line) => { logs.push(line); options.log(line); } } : {})
  });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  t.after(() => close(instance));
  return { fake, idp, store, logs, server: instance, stop: () => close(instance), base: "http://127.0.0.1:" + instance.address().port };
}

// A real service on the test database; null (and the test skipped) without PORTAL_TEST_DATABASE_URL.
async function stack(t) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const manage = fakeManage();
  const served = { status: 200, body: "" };
  const stationFetch = { async get() { return { ...served }; } };
  const pushes = [];
  const pushFetch = { async post(url, body) { pushes.push({ url, body }); return { status: 202 }; } };
  const exchanges = [];
  const exchange = async (idToken, origin) => { exchanges.push({ idToken, origin }); return { accessToken: "station-read-token", expiresIn: 300 }; };
  const service = createIntegrationService({ repository: createRepository(db), db, manage, stationFetch, pushFetch, exchange, log: () => {} });
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
  // The address's allowance is 60 a minute, every POST counted; refused ones ask for nothing.
  let accepted = 0;
  let refused = null;
  for (let index = 0; index < 70; index += 1) {
    const response = await nudge();
    if (response.status === 204) accepted += 1;
    else refused ??= response;
  }
  assert.equal(accepted, 56, "four POSTs above already counted");
  assert.deepEqual([refused.status, refused.headers.get("retry-after")], [429, "60"]);
  assert.equal(nudges.length, 58);
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
