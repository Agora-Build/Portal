import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createStore } from "../scripts/store.mjs";
import { createIdentity, identityConfig } from "../scripts/identity.mjs";
import { createLedger } from "../scripts/ledger.mjs";
import { createCredits, creditsConfig } from "../scripts/credits.mjs";
import { createConnections, connectionsConfig } from "../scripts/connections.mjs";
import { authConfig, createAuth } from "../scripts/auth.mjs";
import { createAppServer } from "../scripts/serve.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { createBilling, billingConfig } from "../scripts/billing.mjs";
import { effectivePlan, entitlements } from "../scripts/plans.mjs";
import { createAgoraBuildClient } from "../integrations/agora-build-client.mjs";

const root = new URL("../", import.meta.url).pathname;
let temp;
before(async () => { temp = await mkdtemp(resolve(tmpdir(), "agora-platform-")); });
after(async () => { await rm(temp, { recursive: true, force: true }); });
const newStore = (options) => createStore(resolve(root, "data/people.json"), resolve(temp, randomBytes(8).toString("hex") + ".json"), options);
const proof = (subject = "stable-builder") => ({ provider: "github", issuer: "https://github.com", subject, name: "Builder" });
const clientSecret = "test-client-credential-" + "x".repeat(32);
const registry = () => ({ clients: [
  { id: "vox", name: "Vox", secret: clientSecret, redirects: ["https://vox.agora.build/callback"], scopes: ["identity", "credits", "services"], identityLookup: true, rates: { evaluation: 4 } },
  { id: "other", name: "Other app", secret: clientSecret, redirects: ["https://other.agora.build/callback"], scopes: ["identity", "credits"], rates: { analysis: 2 } },
  { id: "astation", name: "Astation", loopback: true, scopes: ["identity", "credits", "services", "agora:projects"] }
] });
function parameters(extra = {}) {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, params: new URLSearchParams({ client_id: "vox", redirect_uri: "https://vox.agora.build/callback", response_type: "code", state: randomBytes(24).toString("base64url"), code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "identity credits services", ...extra }) };
}
async function grant(store, hub, token, input = parameters()) {
  const details = hub.authorization(input.params);
  const code = await store.authorize(token, details);
  const tokens = await hub.token(new URLSearchParams({ grant_type: "authorization_code", client_id: details.clientId, ...(details.client.secret ? { client_secret: details.client.secret } : {}), code, code_verifier: input.verifier, redirect_uri: details.redirectUri }));
  return { ...tokens, code, details, verifier: input.verifier };
}

test("registered redirects, strong credentials, native loopbacks and scopes prevent an arbitrary app from requesting access", () => {
  const store = newStore(), hub = createIdentity(store, registry());
  for (const change of [{ client_id: "unregistered" }, { redirect_uri: "https://vox.agora.build.evil.example/callback" }, { redirect_uri: "https://vox.agora.build/callback/extra" }, { code_challenge_method: "plain" }, { state: "short" }, { scope: "identity agora:certificates" }]) assert.throws(() => hub.authorization(parameters(change).params), { status: 400 });
  const native = parameters({ client_id: "astation", redirect_uri: "http://127.0.0.1:45123/oauth/callback", scope: "identity credits" });
  assert.equal(hub.authorization(native.params).clientId, "astation");
  for (const redirect_uri of ["http://localhost:45123/oauth/callback", "http://127.0.0.1:45123/other", "http://127.0.0.1:45123/oauth/callback?extra=1", "https://127.0.0.1:45123/oauth/callback"]) assert.throws(() => hub.authorization(parameters({ client_id: "astation", redirect_uri }).params));
  const duplicate = parameters().params; duplicate.append("state", "another");
  assert.throws(() => hub.authorization(duplicate), { status: 400 });
  assert.throws(() => identityConfig({ VOX_IDENTITY_CLIENT_SECRET: "short", VOX_IDENTITY_REDIRECT_URI: "https://vox.agora.build/callback" }));
});

test("the portal and two applications receive the same permanent user with separate, nonreplayable app tokens", async () => {
  const store = newStore(), hub = createIdentity(store, registry()), login = await store.login(proof());
  const vox = await grant(store, hub, login.token);
  const astation = await grant(store, hub, login.token, parameters({ client_id: "astation", redirect_uri: "http://127.0.0.1:42001/oauth/callback", scope: "identity credits agora:projects" }));
  assert.equal((await store.access(vox.access_token)).sub, login.account.id);
  assert.equal((await store.access(astation.access_token)).sub, login.account.id);
  assert.notEqual(vox.access_token, astation.access_token);
  assert.equal((await store.session(vox.access_token)).profile, null);
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: "vox", client_secret: clientSecret, code: vox.code, code_verifier: vox.verifier, redirect_uri: vox.details.redirectUri });
  await assert.rejects(hub.token(body), { status: 400 });
  await assert.rejects(store.access(vox.access_token, "agora:certificates"), { status: 401 });
  await assert.rejects(store.login({ provider: "apple", issuer: "https://appleid.apple.com", subject: "app-controlled-subject" }, { linkToken: vox.access_token }), { status: 401 });
  const saved = JSON.stringify(await store.snapshot());
  for (const secret of [login.token, vox.access_token, vox.refresh_token, astation.access_token, vox.code]) assert.ok(!saved.includes(secret));
});

test("PKCE, client authentication, exact callback and concurrent redemption protect authorization codes", async () => {
  const store = newStore(), hub = createIdentity(store, registry()), login = await store.login(proof()), input = parameters();
  const code = await store.authorize(login.token, hub.authorization(input.params));
  const valid = { grant_type: "authorization_code", client_id: "vox", client_secret: clientSecret, code, code_verifier: input.verifier, redirect_uri: "https://vox.agora.build/callback" };
  for (const change of [{ client_secret: "wrong" }, { code_verifier: "x".repeat(43) }, { redirect_uri: "https://other.agora.build/callback" }, { client_id: "other" }]) await assert.rejects(hub.token(new URLSearchParams({ ...valid, ...change })));
  const results = await Promise.allSettled([hub.token(new URLSearchParams(valid)), hub.token(new URLSearchParams(valid))]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
});

test("refresh tokens rotate, replay revokes the grant, global logout revokes every client and stale grants expire", async () => {
  let clock = Date.now();
  const store = newStore({ now: () => clock }), hub = createIdentity(store, registry()), login = await store.login(proof());
  const first = await grant(store, hub, login.token);
  const refresh = (token) => hub.token(new URLSearchParams({ grant_type: "refresh_token", client_id: "vox", client_secret: clientSecret, refresh_token: token }));
  const rotated = await refresh(first.refresh_token);
  await assert.rejects(store.access(first.access_token), { status: 401 });
  assert.equal((await store.access(rotated.access_token)).sub, login.account.id);
  await assert.rejects(refresh(first.refresh_token), { status: 400 });
  await assert.rejects(store.access(rotated.access_token), { status: 401 });
  const other = await grant(store, hub, login.token);
  const native = await grant(store, hub, login.token, parameters({ client_id: "astation", redirect_uri: "http://127.0.0.1:42001/oauth/callback", scope: "identity" }));
  await store.logoutEverywhere(login.token);
  for (const token of [other.access_token, native.access_token]) await assert.rejects(store.access(token), { status: 401 });
  assert.equal((await store.session(login.token)).account, null);
  const again = await store.login(proof()); assert.equal(again.account.id, login.account.id);
  const expiring = await grant(store, hub, again.token); clock += 16 * 60000;
  await assert.rejects(store.access(expiring.access_token), { status: 401 });
  assert.ok((await refresh(expiring.refresh_token)).access_token);
  clock += 31 * 86400000;
  await assert.rejects(refresh(expiring.refresh_token), { status: 400 });
});

test("credit reservations serialize competing spends, preserve double-entry balance and reject parameter changes or another owner", async () => {
  const store = newStore(), ledger = createLedger(store), login = await store.login(proof()), other = await store.login(proof("other"));
  await ledger.deposit(login.account.id, 10, "Test purchase", "purchase-1");
  await ledger.deposit(login.account.id, 10, "Test purchase", "purchase-1");
  await assert.rejects(ledger.deposit(login.account.id, 11, "Test purchase", "purchase-1"), { status: 409 });
  const results = await Promise.allSettled([ledger.reserve(login.account.id, "vox:evaluation", 7, "request-one"), ledger.reserve(login.account.id, "astation:tts", 7, "request-two")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await ledger.balance(login.account.id)).credits, 3);
  const reservation = results.find((result) => result.status === "fulfilled").value;
  const savedReservation = (await store.snapshot()).ledger.reservations[0];
  const duplicate = await ledger.reserve(login.account.id, savedReservation.service, 7, savedReservation.key);
  assert.equal(duplicate.id, reservation.id); assert.equal(duplicate.status, "pending");
  await assert.rejects(ledger.reserve(login.account.id, savedReservation.service, 8, savedReservation.key), { status: 409 });
  await assert.rejects(ledger.settle(other.account.id, reservation.id, "release"), { status: 404 });
  await ledger.settle(login.account.id, reservation.id, "capture");
  await ledger.settle(login.account.id, reservation.id, "capture");
  await assert.rejects(ledger.settle(login.account.id, reservation.id, "release"), { status: 409 });
  const book = (await store.snapshot()).ledger;
  assert.equal(book.entries.reduce((total, entry) => total + entry.amount, 0), 0);
  assert.equal(Object.values(book.balances).reduce((total, value) => total + value, 0), 0);
  assert.equal(book.balances["system:escrow"], 0);
  assert.equal((await ledger.balance(other.account.id)).credits, 0);
});

test("failed services and abandoned holds return credits without duplicate usage; retry keys do not rerun completed work", async () => {
  let clock = Date.now(), actions = 0;
  const store = newStore(), ledger = createLedger(store, { now: () => clock }), login = await store.login(proof());
  await ledger.deposit(login.account.id, 20, "Test balance", "balance");
  const credits = createCredits(creditsConfig({ SERVICE_CHAT_CREDITS: "3" }), { ledger });
  await assert.rejects(credits.run(login.account.id, "chat", "request-failed-001", async () => { throw new Error("provider unavailable"); }));
  assert.equal((await ledger.balance(login.account.id)).credits, 20);
  await credits.run(login.account.id, "chat", "request-success-001", async () => { actions++; return "answer"; });
  await assert.rejects(credits.run(login.account.id, "chat", "request-success-001", async () => { actions++; }), { status: 409 });
  assert.equal(actions, 1); assert.equal((await ledger.balance(login.account.id)).credits, 17);
  await ledger.reserve(login.account.id, "other:analysis", 4, "abandoned"); clock += 3600001;
  await ledger.expire(); assert.equal((await ledger.balance(login.account.id)).credits, 17);
  await ledger.expire(); assert.equal((await ledger.balance(login.account.id)).credits, 17);
});

test("Vox-compatible entitlements depend on verified subscription state and period expiry", () => {
  const now = Date.now(), subscription = { status: "active", currentPeriodEnd: Math.floor(now / 1000) + 1000 };
  assert.equal(effectivePlan({ subscription }, now), "premium");
  for (const status of ["past_due", "unpaid", "canceled", "incomplete"]) assert.equal(effectivePlan({ subscription: { ...subscription, status } }, now), "basic");
  assert.equal(effectivePlan({ subscription }, now + 2000000), "basic");
  assert.equal(effectivePlan({ assignedPlan: "principal" }, now), "principal");
  assert.deepEqual(entitlements("basic"), { projects: 5, evalFlowsPerProject: 10, apiEvalFlows: 50, privateResources: false, ownStorage: false, publishMainline: false });
  assert.equal(entitlements("premium").publishMainline, false);
  assert.equal(entitlements("fellow").publishMainline, true);
});

test("Agora OAuth refuses changing loginId and email as identities; verified access binds encrypted owner-only Console resources", async () => {
  const config = authConfig({ SITE_URL: "https://agora.build", AGORA_OAUTH_CLIENT_ID: "portal-test", AGORA_OAUTH_USERINFO_URL: "https://sso.agora.io/userinfo", AGORA_OAUTH_BASE_URL: "https://sso.agora.io" });
  const bad = createAuth(config, { request: async () => Response.json({ loginId: "changes-each-time", email: "builder@example.com" }) });
  await assert.rejects(bad.agoraIdentity("upstream-token"), { status: 401 });
  const auth = createAuth(config, { request: async () => Response.json({ sub: "permanent-agora-user", name: "Agora builder" }) });
  const store = newStore(), login = await store.login(await auth.agoraIdentity("upstream-token"));
  const connectionConfig = connectionsConfig({ CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
  let refreshes = 0;
  const resources = createConnections(store, auth, connectionConfig, { request: async (url, options) => {
    if (url.endsWith("/token")) { refreshes++; return Response.json({ access_token: "renewed-upstream-token", refresh_token: "rotated-upstream-refresh", expires_in: 7200 }); }
    assert.match(options.headers.Authorization, /upstream-token/);
    return Response.json({ items: [{ projectId: "project-1", name: "Private project", appId: "agora-app-id", signKey: "private-test-certificate", status: "active" }] });
  } });
  await resources.save(login.account.id, { accessToken: "upstream-token", refreshToken: "upstream-refresh", expiresAt: Date.now() - 1 });
  const lists = await Promise.all([resources.projects(login.account.id), resources.projects(login.account.id)]);
  assert.equal(refreshes, 1);
  assert.ok(!JSON.stringify(lists).includes("private-test-certificate"));
  assert.equal((await resources.certificate(login.account.id, "project-1")).certificate, "private-test-certificate");
  const other = await store.login(proof("without-agora"));
  await assert.rejects(resources.projects(other.account.id), { status: 403 });
  const snapshot = JSON.stringify(await store.snapshot());
  for (const secret of ["upstream-token", "upstream-refresh", "rotated-upstream-refresh", "private-test-certificate"]) assert.ok(!snapshot.includes(secret));
  assert.ok(!JSON.stringify(await store.session(login.token)).includes("ciphertext"));
  const secondAgora = await store.login({ provider: "agora", issuer: "https://sso.agora.io", subject: "other-agora-user", name: "Other Agora user" });
  await store.transaction((state) => {
    const owner = state.accounts.find((account) => account.id === login.account.id);
    const other = state.accounts.find((account) => account.id === secondAgora.account.id);
    other.connections = { agora: structuredClone(owner.connections.agora) };
  });
  await assert.rejects(resources.projects(secondAgora.account.id), { status: 503 });
  await resources.disconnect(login.account.id);
  await assert.rejects(resources.projects(login.account.id), { status: 403 });
});

test("the existing Agora OAuth code flow validates PKCE/state and returns a separate Console connection for encryption", async () => {
  const config = authConfig({ SITE_URL: "https://agora.build", AGORA_OAUTH_CLIENT_ID: "portal-test", AGORA_OAUTH_USERINFO_URL: "https://sso.agora.io/userinfo", AGORA_OAUTH_BASE_URL: "https://sso.agora.io" });
  let challenge;
  const auth = createAuth(config, { request: async (url, options) => {
    if (new URL(url).pathname.endsWith("/token")) {
      const fields = new URLSearchParams(options.body);
      assert.equal(fields.get("client_id"), "portal-test");
      assert.equal(fields.get("grant_type"), "authorization_code");
      assert.equal(createHash("sha256").update(fields.get("code_verifier")).digest("base64url"), challenge);
      return Response.json({ token_type: "Bearer", access_token: "verified-console-access", refresh_token: "verified-console-refresh", expires_in: 7200 });
    }
    assert.equal(options.headers.Authorization, "Bearer verified-console-access");
    return Response.json({ sub: "agora-permanent-subject", name: "Agora builder" });
  } });
  const started = await auth.begin("agora", { returnTo: "/account.html" });
  const url = new URL(started.url); challenge = url.searchParams.get("code_challenge");
  assert.equal(url.pathname, "/api/v0/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), "basic_info,console");
  assert.equal(url.searchParams.has("nonce"), false);
  const result = await auth.complete("agora", new URLSearchParams({ code: "verified-code", state: started.state }), started.state);
  assert.equal(result.identity.subject, "agora-permanent-subject");
  assert.equal(result.returnTo, "/account.html");
  assert.equal(result.connection.accessToken, "verified-console-access");
  assert.equal(result.connection.refreshToken, "verified-console-refresh");
});

test("server-side integration completes direct app login, shares credits, isolates scopes and exposes no server credentials", async () => {
  const store = newStore(), hub = createIdentity(store, registry()), login = await store.login(proof());
  const ledger = createLedger(store); await ledger.deposit(login.account.id, 10, "Test purchase", "test-purchase");
  const auth = createAuth(authConfig({ SITE_URL: "https://agora.build" }));
  const server = createAppServer(root, { store, identity: hub, auth, billing: createBilling(store, billingConfig({})), models: createModelClient(modelConfig({})), monitor: false });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;
  const localFetch = (url, options) => fetch(base + new URL(url).pathname + new URL(url).search, options);
  const sdk = createAgoraBuildClient({ origin: "https://agora.build", clientId: "vox", clientSecret, redirectUri: "https://vox.agora.build/callback", request: localFetch });
  try {
    const start = sdk.begin();
    const response = await localFetch(start.url, { headers: { Cookie: "house_session=" + login.token }, redirect: "manual" });
    assert.equal(response.status, 303);
    const tokens = await sdk.complete(response.headers.get("location"), start.transaction);
    assert.equal((await sdk.user(tokens.access_token)).sub, login.account.id);
    assert.equal((await sdk.balance(tokens.access_token)).credits, 10);
    const linkingAttempt = await fetch(base + "/auth/github?link=1", { headers: { Authorization: "Bearer " + tokens.access_token }, redirect: "manual" });
    assert.equal(linkingAttempt.status, 403);
    const hold = await sdk.reserve(tokens.access_token, "evaluation", "integration-request-001");
    assert.equal((await sdk.balance(tokens.access_token)).credits, 6);
    await sdk.settle(tokens.access_token, "evaluation", hold.id, "release");
    assert.equal((await sdk.balance(tokens.access_token)).credits, 10);
    const forbidden = await fetch(base + "/api/connections/agora/certificate", { method: "POST", headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "project-1" }) });
    assert.equal(forbidden.status, 401);
    const disguisedCookie = await fetch(base + "/api/me", { headers: { Cookie: "house_session=" + tokens.access_token } });
    assert.equal((await disguisedCookie.json()).account, null);
    const mismatch = await fetch(base + "/api/platform/credits/reserve", { method: "POST", headers: { Authorization: "Bearer " + clientSecret, "X-Agora-Client-Id": "other", "X-Agora-User-Token": tokens.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ service: "analysis", idempotencyKey: "other-request-001" }) });
    assert.equal(mismatch.status, 403);
    const signInPage = await fetch(base + "/oauth/authorize?" + new URL(start.url).searchParams);
    assert.match(await signInPage.text(), /Continue to Vox/);
    for (const path of ["/scripts/ledger.mjs", "/config/identity-clients.example.json", "/integrations/agora-build-client.mjs", "/scripts/connections.mjs"]) assert.equal((await fetch(base + path)).status, 404);
    const billingAttempt = await fetch(base + "/api/billing/checkout", { method: "POST", headers: { Cookie: "house_session=" + login.token, "Content-Type": "application/json", "Idempotency-Key": "checkout-attempt-001" }, body: JSON.stringify({ productId: "premium-monthly", plan: "fellow", credits: 100000 }) });
    assert.equal(billingAttempt.status, 503);
    assert.equal((await store.session(login.token)).account.plan, "basic");
    await sdk.revoke(tokens.refresh_token);
    await assert.rejects(sdk.user(tokens.access_token));
  } finally { await new Promise((done) => { server.close(done); server.closeIdleConnections(); }); }
});

test("an app can use paid portal services without a public profile, with scopes and idempotent charging enforced", async () => {
  const store = newStore(), hub = createIdentity(store, registry()), login = await store.login(proof());
  const ledger = createLedger(store); await ledger.deposit(login.account.id, 8, "Service test credits", "service-test");
  const tokens = await grant(store, hub, login.token);
  const identityOnly = await grant(store, hub, login.token, parameters({ scope: "identity" }));
  let requests = 0;
  const models = { config: { language: { ready: true }, speech: { ready: false }, radar: { ready: false } }, chat: async () => { requests++; return "Actual fixture response"; } };
  const server = createAppServer(root, { store, identity: hub, auth: createAuth(authConfig({})), billing: createBilling(store, billingConfig({})), credits: createCredits(creditsConfig({ SERVICE_CHAT_CREDITS: "3" }), { ledger }), models, monitor: false });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;
  const chat = (token, key) => fetch(base + "/api/services/chat", { method: "POST", headers: { Authorization: "Bearer " + token, "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ message: "Help me build a voice project." }) });
  try {
    assert.equal((await chat(identityOnly.access_token, "identity-request-001")).status, 401);
    assert.equal((await chat(tokens.access_token, "successful-request-001")).status, 200);
    assert.equal((await chat(tokens.access_token, "successful-request-001")).status, 409);
    assert.equal(requests, 1);
    assert.equal((await ledger.balance(login.account.id)).credits, 5);
    assert.equal((await store.session(login.token)).profile, null);
  } finally { await new Promise((done) => { server.close(done); server.closeIdleConnections(); }); }
});
