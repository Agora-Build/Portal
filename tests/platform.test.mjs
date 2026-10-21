import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createStore } from "../scripts/store.mjs";
import { createIdentity, identityConfig } from "../scripts/identity.mjs";
import { createLedger } from "../scripts/ledger.mjs";
import { createCredits, creditsConfig } from "../scripts/credits.mjs";
import { createConnections, connectionsConfig } from "../scripts/connections.mjs";
import { authConfig, createAuth } from "../scripts/auth.mjs";
import { effectivePlan, entitlements } from "../scripts/plans.mjs";

let temp;
before(async () => { temp = await mkdtemp(resolve(tmpdir(), "agora-platform-")); });
after(async () => { await rm(temp, { recursive: true, force: true }); });
const newStore = (options) => createStore(new URL("../data/people.json", import.meta.url).pathname, resolve(temp, randomBytes(8).toString("hex") + ".json"), { log: () => {}, ...options });
const subjects = { "stable-builder": "acct_" + "1".repeat(26), other: "acct_" + "2".repeat(26), "without-agora": "acct_" + "3".repeat(26), "other-agora": "acct_" + "4".repeat(26) };
// Signs in an auth.agora.build subject; the result keeps the old { token, account: { id } } shape these tests read.
const signIn = async (store, subject = "stable-builder") => ({ ...(await store.signIn({ sub: subjects[subject], sid: "sid-" + subject, name: "Builder", idToken: "id-token" })), account: { id: subjects[subject] } });
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

test("credit reservations serialize competing spends, preserve double-entry balance and reject parameter changes or another owner", async () => {
  const store = newStore(), ledger = createLedger(store), login = await signIn(store), other = await signIn(store, "other");
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
  const store = newStore(), ledger = createLedger(store, { now: () => clock }), login = await signIn(store);
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
  assert.deepEqual(entitlements("basic"), { projects: 5, evalFlowsPerProject: 10, apiEvalFlows: 50, privateResources: false, ownStorage: false, publishMainline: false, spaces: 3 });
  assert.equal(entitlements("premium").publishMainline, false);
  assert.equal(entitlements("fellow").publishMainline, true);
});

test("Agora OAuth refuses changing loginId and email as identities; verified access binds encrypted owner-only Console resources", async () => {
  const config = authConfig({ SITE_URL: "https://agora.build", AGORA_OAUTH_CLIENT_ID: "portal-test", AGORA_OAUTH_USERINFO_URL: "https://sso.agora.io/userinfo", AGORA_OAUTH_BASE_URL: "https://sso.agora.io" });
  const bad = createAuth(config, { request: async () => Response.json({ loginId: "changes-each-time", email: "builder@example.com" }) });
  await assert.rejects(bad.agoraIdentity("upstream-token"), { status: 401 });
  const auth = createAuth(config, { request: async () => Response.json({ sub: "permanent-agora-user", name: "Agora builder" }) });
  const store = newStore(), login = await signIn(store);
  const connectionConfig = connectionsConfig({ AGORA_CONSOLE_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
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
  const other = await signIn(store, "without-agora");
  await assert.rejects(resources.projects(other.account.id), { status: 403 });
  const snapshot = JSON.stringify(await store.snapshot());
  for (const secret of ["upstream-token", "upstream-refresh", "rotated-upstream-refresh", "private-test-certificate"]) assert.ok(!snapshot.includes(secret));
  assert.ok(!JSON.stringify(await store.session(login.token)).includes("ciphertext"));
  const secondAgora = await signIn(store, "other-agora");
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

test("the Agora Console key is read under its new name, with the old name as a fallback", () => {
  const key = randomBytes(32).toString("base64"), other = randomBytes(32).toString("base64");
  assert.equal(connectionsConfig({ AGORA_CONSOLE_ENCRYPTION_KEY: key }).key.toString("base64"), key);
  assert.equal(connectionsConfig({ CONNECTION_ENCRYPTION_KEY: key }).key.toString("base64"), key);
  assert.equal(connectionsConfig({ AGORA_CONSOLE_ENCRYPTION_KEY: key, CONNECTION_ENCRYPTION_KEY: other }).key.toString("base64"), key, "the new name wins");
  assert.equal(connectionsConfig({}).ready, false);
});
