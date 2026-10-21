import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { authConfig, createAuth, returnPath } from "../scripts/auth.mjs";

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
function configuration(extra = {}) {
  return authConfig({ SITE_URL: "https://portal.example", GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", APPLE_CLIENT_ID: "test-client", APPLE_TEAM_ID: "test-team", APPLE_KEY_ID: "test-key", APPLE_PRIVATE_KEY_FILE: keyFile, AGORA_OIDC_ISSUER: "https://identity.agora.example", AGORA_OIDC_CLIENT_ID: "test-client", AGORA_OIDC_CLIENT_SECRET: "test-secret", ...extra });
}
function providerRequests({ id = "google", githubEmails = [], nonce, expectedChallenge, claims = {}, badSignature = false, audience = "test-client", tokenIssuer, expired = false } = {}) {
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
    if (url.href === "https://api.github.com/user/emails") return Response.json(githubEmails);
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
  assert.equal(returnPath("/stoa/"), "/stoa/");
  assert.equal(returnPath("/stoa/room/ai-agents?x=1"), "/stoa/room/ai-agents?x=1");
  assert.equal(returnPath("/stoa/s/11111111-1111-1111-1111-111111111111?invite=abc&signin=failed"), "/stoa/s/11111111-1111-1111-1111-111111111111?invite=abc");
  assert.equal(returnPath("/meetings.html"), "/");
  assert.equal(returnPath("/stoa/s/not-a-uuid"), "/");
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

test("providers report only verified ASCII emails, and a failed GitHub lookup reports nothing", async () => {
  for (const [emails, expected] of [[[{ email: "Ada@Example.com", primary: true, verified: true }, { email: "x@example.com", primary: false, verified: true }], "ada@example.com"], [[{ email: "ada@example.com", primary: true, verified: false }], null], [[], null], [{ message: "Requires authentication" }, undefined], [[{ email: "Kada@example.com", primary: true, verified: true }], null]]) {
    const upstream = providerRequests({ id: "github", githubEmails: emails });
    const auth = createAuth(configuration(), { request: upstream.request });
    const started = await auth.begin("github");
    assert.match(new URL(started.url).searchParams.get("scope"), /user:email/);
    const result = await auth.complete("github", new URLSearchParams({ code: "test-code", state: started.state }), started.state);
    assert.equal(result.identity.email, expected, JSON.stringify(emails));
  }
  for (const [claims, expected] of [[{ email: "Ada@Example.com", email_verified: true }, "ada@example.com"], [{ email: "ada@example.com", email_verified: false }, null], [{ email: "ada@example.com", email_verified: "true" }, "ada@example.com"], [{}, null]]) {
    let nonce;
    const upstream = providerRequests({ nonce: () => nonce, claims });
    const auth = createAuth(configuration(), { request: upstream.request });
    const started = await auth.begin("google");
    nonce = new URL(started.url).searchParams.get("nonce");
    const result = await auth.complete("google", new URLSearchParams({ code: "test-code", state: started.state }), started.state);
    assert.equal(result.identity.email, expected, JSON.stringify(claims));
  }
});
