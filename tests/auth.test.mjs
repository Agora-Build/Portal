import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { authConfig, createAuth, returnPath } from "../scripts/auth.mjs";
import { createStore } from "../scripts/store.mjs";
import { createAppServer } from "../scripts/serve.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";

const root = new URL("../", import.meta.url).pathname;
const profile = { name: "OAuth builder", bio: "Building voice tooling.", intent: "Build an audio routing tool and demo it in person.", skills: ["Rust"], contact: "https://example.com/builder" };
const identity = (provider = "google", subject = "stable-person") => ({ provider, issuer: "https://identity.example/" + provider, subject, name: "Signed-in builder", contact: "https://example.com/builder" });
let temp, keys, appleKeys, jwk, keyFile;
before(async () => {
  temp = await mkdtemp(resolve(tmpdir(), "foundry-auth-"));
  keys = await generateKeyPair("RS256");
  appleKeys = await generateKeyPair("ES256", { extractable: true });
  jwk = { ...await exportJWK(keys.publicKey), kid: "test-key", use: "sig", alg: "RS256" };
  keyFile = resolve(temp, "apple.p8");
  await writeFile(keyFile, await exportPKCS8(appleKeys.privateKey));
});
after(async () => { await rm(temp, { recursive: true, force: true }); });
const store = (name, options) => createStore(resolve(root, "data/people.json"), resolve(temp, name + ".json"), options);
function configuration(extra = {}) {
  return authConfig({ SITE_URL: "https://portal.example", GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", APPLE_CLIENT_ID: "test-client", APPLE_TEAM_ID: "test-team", APPLE_KEY_ID: "test-key", APPLE_PRIVATE_KEY_FILE: keyFile, AGORA_OIDC_ISSUER: "https://identity.agora.example", AGORA_OIDC_CLIENT_ID: "test-client", AGORA_OIDC_CLIENT_SECRET: "test-secret", ...extra });
}
function providerRequests({ id = "google", nonce, expectedChallenge, claims = {}, badSignature = false, audience = "test-client", tokenIssuer, expired = false } = {}) {
  let seenBody;
  const issuer = id === "google" ? "https://accounts.google.com" : id === "apple" ? "https://appleid.apple.com" : "https://identity.agora.example";
  const request = async (value, options = {}) => {
    const url = new URL(value);
    if (url.pathname.includes(".well-known")) return Response.json({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", jwks_uri: issuer + "/keys", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    if (url.pathname.endsWith("/keys") || url.pathname.endsWith("/certs")) return Response.json({ keys: [jwk] });
    if (url.pathname.endsWith("/token") || url.pathname.endsWith("/access_token")) {
      seenBody = new URLSearchParams(options.body);
      assert.equal(seenBody.get("code"), "test-code");
      if (expectedChallenge) assert.equal(createHash("sha256").update(seenBody.get("code_verifier")).digest("base64url"), expectedChallenge());
      if (id === "apple") {
        const secret = await jwtVerify(seenBody.get("client_secret"), appleKeys.publicKey, { issuer: "test-team", subject: "test-client", audience: issuer });
        assert.ok(secret.payload.exp - secret.payload.iat <= 300);
        assert.equal(seenBody.has("code_verifier"), false);
      }
      if (id === "github") return Response.json({ access_token: "test-access", token_type: "bearer", scope: "read:user" });
      const jwt = new SignJWT({ sub: "signed-subject", nonce: nonce(), name: "Verified provider name", ...claims }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(tokenIssuer || issuer).setAudience(audience).setIssuedAt().setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 600 : "5m");
      let token = await jwt.sign(keys.privateKey);
      if (badSignature) { const pieces = token.split("."); pieces[2] = Buffer.alloc(256).toString("base64url"); token = pieces.join("."); }
      return Response.json({ access_token: "test-access", token_type: "Bearer", expires_in: 300, id_token: token });
    }
    if (url.href === "https://api.github.com/user") return Response.json({ id: 12345, login: "test-builder", name: "GitHub builder", avatar_url: "https://avatars.example/builder" });
    throw new Error("Unexpected upstream URL " + url.href);
  };
  return { request, body: () => seenBody };
}

test("provider readiness requires a safe public origin and actual provider configuration; Agora RTC credentials do not enable login", () => {
  assert.ok(createAuth(authConfig({})).providers().every((provider) => !provider.ready));
  assert.ok(createAuth(configuration()).providers().every((provider) => provider.ready));
  assert.equal(authConfig({ SITE_URL: "http://portal.example", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }).providers.google.ready, false);
  assert.equal(authConfig({ SITE_URL: "http://localhost:3002", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }).providers.google.ready, true);
  assert.equal(configuration({ SITE_URL: "http://localhost:3002" }).providers.apple.ready, false);
  assert.equal(authConfig({ SITE_URL: "https://portal.example", AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32) }).providers.agora.ready, false);
  for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "/auth/google", "/api/profile", "/\ninvalid"]) assert.equal(returnPath(value), "/");
  assert.equal(returnPath("/meet/11111111-1111-1111-1111-111111111111?signin=failed"), "/meet/11111111-1111-1111-1111-111111111111");
});

for (const id of ["google", "github", "apple", "agora"]) test(id + " authenticates using a code flow with bound state and verified identity", async () => {
  let nonce, challenge;
  const upstream = providerRequests({ id, nonce: () => nonce, expectedChallenge: id === "apple" ? undefined : () => challenge });
  const auth = createAuth(configuration(), { request: upstream.request });
  const started = await auth.begin(id, { returnTo: "/meet/11111111-1111-1111-1111-111111111111" });
  const url = new URL(started.url);
  nonce = url.searchParams.get("nonce"); challenge = url.searchParams.get("code_challenge");
  assert.equal(url.searchParams.get("state"), started.state);
  if (id === "apple") { assert.equal(url.searchParams.get("response_mode"), "form_post"); assert.equal(challenge, null); }
  else { assert.ok(challenge); assert.equal(url.searchParams.get("code_challenge_method"), "S256"); }
  const parameters = new URLSearchParams({ code: "test-code", state: started.state, ...(id === "apple" ? { user: JSON.stringify({ name: { firstName: "Apple", lastName: "builder" } }) } : {}) });
  const result = await auth.complete(id, parameters, started.state);
  assert.equal(result.identity.provider, id);
  assert.equal(result.identity.subject, id === "github" ? "12345" : "signed-subject");
  assert.equal(result.returnTo, "/meet/11111111-1111-1111-1111-111111111111");
  assert.ok(!JSON.stringify(result).includes("test-access"));
  await assert.rejects(auth.complete(id, parameters, started.state), { status: 400 });
});

test("OAuth rejects missing or wrong browser state, swapped providers, expired transactions, and forged ID-token signatures", async () => {
  let clock = Date.now(), nonce;
  const auth = createAuth(configuration(), { request: providerRequests({ nonce: () => nonce, badSignature: true }).request, now: () => clock });
  const first = await auth.begin("google"); nonce = new URL(first.url).searchParams.get("nonce");
  const parameters = new URLSearchParams({ code: "test-code", state: first.state });
  for (const browserState of [undefined, "wrong", "\u00e9".repeat(first.state.length)]) await assert.rejects(auth.complete("google", parameters, browserState), { status: 400 });
  await assert.rejects(auth.complete("apple", parameters, first.state), { status: 400 });
  await assert.rejects(auth.complete("google", parameters, first.state), { status: 400 });
  const expired = await auth.begin("github"); clock += 600001;
  await assert.rejects(auth.complete("github", new URLSearchParams({ code: "test-code", state: expired.state }), expired.state), { status: 400 });
});
test("OIDC rejects a nonce mismatch even when a provider token has a valid signature", async () => {
  const auth = createAuth(configuration(), { request: providerRequests({ nonce: () => "wrong-nonce" }).request });
  const first = await auth.begin("google");
  await assert.rejects(auth.complete("google", new URLSearchParams({ code: "test-code", state: first.state }), first.state), { status: 400 });
});
test("OIDC rejects another client's audience, another issuer, and expired signed tokens", async () => {
  for (const invalid of [{ audience: "another-client" }, { tokenIssuer: "https://another-issuer.example" }, { expired: true }]) {
    let nonce;
    const auth = createAuth(configuration(), { request: providerRequests({ ...invalid, nonce: () => nonce }).request });
    const first = await auth.begin("google"); nonce = new URL(first.url).searchParams.get("nonce");
    await assert.rejects(auth.complete("google", new URLSearchParams({ code: "test-code", state: first.state }), first.state), { status: 400 });
  }
});

test("returning logins recover the same profile and rooms across devices without inventing a public profile", async () => {
  const data = store("devices");
  const first = await data.login(identity());
  assert.equal(first.profile, null);
  assert.equal((await data.people()).length, 1);
  const member = await data.join(profile, first.token);
  const room = await data.createRoom(member.token, { title: "Persistent room", intent: "Compare designs" });
  const second = await data.login(identity());
  assert.equal(second.account.id, first.account.id);
  assert.equal(second.profile.id, member.person.id);
  assert.equal((await data.me(first.token)).id, member.person.id);
  assert.equal((await data.rooms())[0].ownerId, second.profile.id);
  assert.equal((await data.rooms())[0].path, "/meet/" + room.id);
  await data.logout(second.token);
  assert.equal(await data.me(second.token), null);
  assert.equal((await data.me(member.token)).id, member.person.id);
  const restarted = store("devices");
  assert.equal((await restarted.me(member.token)).id, member.person.id);
  const saved = await readFile(resolve(temp, "devices.json"), "utf8");
  assert.ok(!saved.includes(first.token) && !saved.includes(member.token));
  const publicText = JSON.stringify(await data.people());
  assert.ok(!publicText.includes("identities") && !publicText.includes("accountId") && !publicText.includes("sessionHash") && !publicText.includes("stable-person"));
});
test("connecting a provider preserves browser-only profiles; identities are never merged by email or transferred between accounts", async () => {
  const data = store("linking");
  const guest = await data.join(profile);
  const room = await data.createRoom(guest.token, { title: "Guest room", intent: "Keep the room" });
  const connected = await data.login(identity("github", "123"), { linkToken: guest.token });
  assert.equal(connected.profile.id, guest.person.id);
  assert.equal(await data.me(guest.token), null);
  assert.equal((await data.me(connected.token)).id, room.ownerId);
  const google = await data.login(identity("google", "456"), { linkToken: connected.token });
  assert.equal(google.account.id, connected.account.id);
  assert.deepEqual(google.account.providers, ["github", "google"]);
  assert.equal((await data.login(identity("google", "456"))).profile.id, guest.person.id);
  const other = await data.login({ ...identity("apple", "different"), email: "same@example.com" });
  assert.notEqual(other.account.id, connected.account.id);
  await assert.rejects(data.login(identity("google", "456"), { linkToken: other.token }), { status: 409 });
  await assert.rejects(data.login(identity("google", "new-subject"), { linkToken: connected.token }), { status: 409 });
});
test("account sessions expire and public profile removal preserves account recovery without restoring deleted rooms", async () => {
  let clock = Date.now();
  const data = store("expiry", { now: () => clock });
  const login = await data.login(identity());
  const member = await data.join(profile, login.token);
  await data.createRoom(member.token, { title: "Temporary room", intent: "Delete this room" });
  await data.remove(member.token);
  assert.equal((await data.session(member.token)).account.id, login.account.id);
  assert.equal((await data.login(identity())).profile, null);
  assert.equal((await data.rooms()).length, 0);
  clock += 31 * 86400000;
  assert.deepEqual(await data.session(member.token), { profile: null, account: null });
});

test("HTTP sign-in sets a browser-bound state cookie, rotates authenticated sessions, returns to the room, and supports Apple's POST callback", async () => {
  const data = store("http-auth");
  let nonce;
  const upstream = providerRequests({ nonce: () => nonce });
  const appleUpstream = providerRequests({ id: "apple", nonce: () => nonce });
  const auth = createAuth(configuration(), { request: (url, options) => new URL(url).hostname === "appleid.apple.com" ? appleUpstream.request(url, options) : upstream.request(url, options) });
  const server = createAppServer(root, { store: data, auth, monitor: false, models: createModelClient(modelConfig({})), calls: createAgoraCalls(agoraConfig({})) });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const response = await fetch(base + "/auth/google?returnTo=%2Fmeet%2F11111111-1111-1111-1111-111111111111", { redirect: "manual" });
    assert.equal(response.status, 303);
    const authorization = new URL(response.headers.get("location"));
    nonce = authorization.searchParams.get("nonce");
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; Path=\/auth\/; Max-Age=600; SameSite=Lax; Secure/);
    const callback = "/auth/google/callback?code=test-code&state=" + authorization.searchParams.get("state");
    const signedIn = await fetch(base + callback, { headers: { Cookie: cookie.split(";")[0] }, redirect: "manual" });
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get("location"), "/meet/11111111-1111-1111-1111-111111111111?signin=success");
    const sessionCookie = signedIn.headers.getSetCookie().find(cookie => cookie.startsWith("house_session="));
    assert.match(sessionCookie, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000; Secure/);
    const me = await (await fetch(base + "/api/me", { headers: { Cookie: sessionCookie.split(";")[0] } })).json();
    assert.equal(me.profile, null);
    assert.deepEqual(me.account.providers, ["google"]);
    const replay = await fetch(base + callback, { headers: { Cookie: cookie.split(";")[0] }, redirect: "manual" });
    assert.equal(replay.headers.get("location"), "/?signin=failed");
    assert.ok(!replay.headers.getSetCookie().some(cookie => cookie.startsWith("house_session=")));
    assert.equal((await fetch(base + "/scripts/auth.mjs")).status, 404);
    const appleStart = await fetch(base + "/auth/apple?returnTo=/meetings.html", { redirect: "manual" });
    const appleUrl = new URL(appleStart.headers.get("location")); nonce = appleUrl.searchParams.get("nonce");
    const appleCookie = appleStart.headers.get("set-cookie");
    assert.match(appleCookie, /SameSite=None; Secure/);
    const appleResult = await fetch(base + "/auth/apple/callback", { method: "POST", headers: { Cookie: appleCookie.split(";")[0], "Content-Type": "application/x-www-form-urlencoded", Origin: "https://appleid.apple.com" }, body: new URLSearchParams({ code: "test-code", state: appleUrl.searchParams.get("state") }), redirect: "manual" });
    assert.equal(appleResult.headers.get("location"), "/meetings.html?signin=success");
    assert.ok(appleResult.headers.getSetCookie().some(cookie => cookie.startsWith("house_session=")));
    assert.equal((await fetch(base + "/api/auth/logout", { method: "POST", headers: { Cookie: sessionCookie.split(";")[0], Origin: "https://untrusted.example" } })).status, 403);
    const logout = await fetch(base + "/api/auth/logout", { method: "POST", headers: { Cookie: sessionCookie.split(";")[0] } });
    assert.equal(logout.status, 200);
    assert.equal((await (await fetch(base + "/api/me", { headers: { Cookie: sessionCookie.split(";")[0] } })).json()).account, null);
  } finally { await new Promise(done => { server.close(done); server.closeIdleConnections(); }); }
});
test("unconfigured providers report availability without secrets and cannot issue login redirects", async () => {
  const server = createAppServer(root, { store: store("unconfigured"), auth: createAuth(authConfig({})), monitor: false, models: createModelClient(modelConfig({})), calls: createAgoraCalls(agoraConfig({})) });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const providers = await (await fetch(base + "/api/auth/providers")).json();
    assert.deepEqual(providers.providers.map(provider => provider.id), ["google", "github", "apple", "agora"]);
    assert.ok(providers.providers.every(provider => !provider.ready && Object.keys(provider).length === 3));
    for (const provider of providers.providers) assert.equal((await fetch(base + "/auth/" + provider.id, { redirect: "manual" })).status, 503);
    assert.deepEqual(await (await fetch(base + "/api/me")).json(), { profile: null, account: null });
  } finally { await new Promise(done => { server.close(done); server.closeIdleConnections(); }); }
});
