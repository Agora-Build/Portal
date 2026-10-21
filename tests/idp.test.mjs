import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "jose";
import { createIdp, LoginError, TokenError } from "../scripts/idp.mjs";
import { createFakeIdp, LOGOUT_EVENT } from "./helpers/fake-idp.mjs";

const issuer = "https://auth.example";
const clientSecret = "portal-test-secret-".padEnd(40, "x");
const siteUrl = "https://portal.example";
const audience = "https://api.agora.build";

async function setup(options = {}) {
  const fake = await createFakeIdp({ issuer, clientId: "portal", clientSecret });
  const idp = createIdp({ issuer, clientId: "portal", clientSecret, siteUrl, audience, request: fake.request, ...options });
  return { fake, idp };
}
async function signIn(fake, idp, claims = {}, { returnTo = "/account.html", tamper } = {}) {
  const { url, transaction } = await idp.beginLogin({ returnTo });
  let callback = fake.authorize(url, claims);
  if (tamper) callback = tamper(callback);
  return idp.completeLogin(callback, transaction);
}
const rejectsLogin = (promise, reason) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof LoginError, "expected a LoginError, got " + error?.name);
  if (reason) assert.equal(error.reason, reason);
  return true;
});
const rejectsToken = (promise, status = 401) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof TokenError, "expected a TokenError, got " + error?.name + ": " + error?.message);
  assert.equal(error.status, status);
  return true;
});
afterEach(() => mock.timers.reset());

test("config derives the redirect, post-logout and account URLs; bad settings are refused by name", () => {
  const idp = createIdp({ issuer, clientSecret, siteUrl: "https://portal.example/some/path", request: async () => { throw new Error("unused"); } });
  assert.deepEqual(idp.config, {
    issuer,
    clientId: "portal",
    redirectUri: "https://portal.example/auth/callback",
    postLogoutRedirectUri: "https://portal.example/",
    accountUrl: "https://auth.example/account"
  });
  assert.equal(createIdp({ issuer: "http://auth.localhost:3090", clientSecret, siteUrl: "http://localhost:3080" }).config.redirectUri, "http://localhost:3080/auth/callback");
  assert.throws(() => createIdp({ issuer, clientSecret: "short", siteUrl }), /PORTAL_CLIENT_SECRET/);
  assert.throws(() => createIdp({ issuer: "http://auth.example", clientSecret, siteUrl }), /AUTH_ISSUER/);
  assert.throws(() => createIdp({ issuer: "not a url", clientSecret, siteUrl }), /AUTH_ISSUER/);
  assert.throws(() => createIdp({ issuer, clientSecret, siteUrl: "http://portal.example" }), /SITE_URL/);
  for (const message of [/PORTAL_CLIENT_SECRET/, /AUTH_ISSUER/]) assert.doesNotMatch(String(message), new RegExp(clientSecret));
});

test("available() is false while the IdP is unreachable, retries at most every 30 s, then succeeds", async () => {
  let clock = 1_000_000;
  const { fake, idp } = await setup({ now: () => clock });
  fake.setDown(true);
  assert.equal(await idp.available(), false);
  fake.setDown(false);
  clock += 10_000;
  assert.equal(await idp.available(), false, "no retry inside 30 s");
  assert.equal(fake.counts.discovery, 0);
  await rejectsLogin(idp.beginLogin({ returnTo: "/" }), "unavailable");
  clock += 20_001;
  assert.equal(await idp.available(), true);
  assert.equal(await idp.available(), true);
  assert.equal(fake.counts.discovery, 1, "discovery is cached");
});

test("available() re-checks an IdP that has been silent for 30 s: a stopped IdP makes sign-in unavailable, then it recovers", async () => {
  let clock = 1_000_000;
  const { fake, idp } = await setup({ now: () => clock });
  assert.equal(await idp.available(), true);
  const token = await fake.issueAccessToken();
  await idp.verifyAccessToken(token);
  fake.setDown(true);
  clock += 10_000;
  const attempts = fake.counts.attempts;
  assert.equal(await idp.available(), true, "within 30 s of the last contact nothing is probed");
  assert.equal(fake.counts.attempts, attempts);
  clock += 20_001;
  assert.equal(await idp.available(), false, "a silent IdP is probed and found down");
  assert.equal(fake.counts.attempts, attempts + 1);
  fake.setDown(false);
  clock += 10_000;
  assert.equal(await idp.available(), false, "no new probe inside the 30 s retry interval");
  assert.equal(fake.counts.attempts, attempts + 1);
  assert.equal((await idp.verifyAccessToken(token)).sub.length > 0, true, "cached keys still verify access tokens meanwhile");
  clock += 20_001;
  const discoveries = fake.counts.discovery;
  assert.equal(await idp.available(), true, "the IdP answers again");
  assert.equal(fake.counts.discovery, discoveries + 1);
  assert.equal(await idp.available(), true);
  assert.equal(fake.counts.discovery, discoveries + 1, "a successful probe counts as contact");
});

test("a probe refreshes changed IdP metadata, and gives up after 2 s on an IdP that hangs", async () => {
  let clock = 1_000_000;
  let hang = false;
  const fake = await createFakeIdp({ issuer, clientId: "portal", clientSecret });
  const request = (url, options = {}) => hang ? new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(options.signal.reason))) : fake.request(url, options);
  const idp = createIdp({ issuer, clientId: "portal", clientSecret, siteUrl, audience, request, now: () => clock });
  assert.equal(await idp.available(), true);
  assert.match(idp.endSessionUrl(), /^https:\/\/auth\.example\/logout\?/);
  fake.metadata.end_session_endpoint = issuer + "/session/end";
  clock += 31_000;
  assert.equal(await idp.available(), true);
  assert.match(idp.endSessionUrl(), /^https:\/\/auth\.example\/session\/end\?/, "the refreshed end-session endpoint is used");
  hang = true;
  clock += 31_000;
  const started = Date.now();
  // AbortSignal.timeout() doesn't hold the event loop open; a server's listener does, so this test holds it.
  const keepAlive = setTimeout(() => {}, 5000);
  assert.equal(await idp.available(), false);
  clearTimeout(keepAlive);
  const waited = Date.now() - started;
  assert.ok(waited >= 1900 && waited < 3000, "the probe timed out after about 2 s (" + waited + " ms)");
  await rejectsLogin((async () => { if (!(await idp.available())) throw new LoginError("unavailable"); })(), "unavailable");
});

test("bearer: after a rotation a new kid is refetched 5 s after the last JWKS fetch, not 30 s", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { fake, idp } = await setup();
  await idp.verifyAccessToken(await fake.issueAccessToken());
  assert.equal(fake.counts.jwks, 1);
  await fake.rotate({ drop: true });
  mock.timers.tick(1_000);
  await rejectsToken(idp.verifyAccessToken(await fake.issueAccessToken()), 401);
  assert.equal(fake.counts.jwks, 1, "no refetch within 5 s of the last one");
  mock.timers.tick(4_100);
  const sub = fake.accountId();
  assert.equal((await idp.verifyAccessToken(await fake.issueAccessToken({ sub }))).sub, sub, "the new key is accepted");
  assert.equal(fake.counts.jwks, 2);
});

test("beginLogin builds a code + PKCE S256 request with state, nonce and the openid profile email scopes", async () => {
  const { idp } = await setup({ now: () => 1234 });
  const { url, transaction } = await idp.beginLogin({ returnTo: "/explore.html?q=voice" });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, issuer + "/authorize");
  const params = parsed.searchParams;
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("client_id"), "portal");
  assert.equal(params.get("redirect_uri"), "https://portal.example/auth/callback");
  assert.equal(params.get("scope"), "openid profile email");
  assert.equal(params.get("state"), transaction.state);
  assert.equal(params.get("nonce"), transaction.nonce);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.ok(params.get("code_challenge"));
  assert.equal(params.has("code_verifier"), false);
  assert.ok(!url.includes(transaction.verifier));
  assert.deepEqual(Object.keys(transaction).sort(), ["createdAt", "id", "nonce", "returnTo", "state", "verifier"]);
  assert.equal(transaction.returnTo, "/explore.html?q=voice");
  assert.equal(transaction.createdAt, 1234);
  for (const name of ["id", "state", "nonce", "verifier"]) assert.ok(transaction[name].length >= 32, name);
  assert.notEqual(transaction.id, transaction.state);
  const second = await idp.beginLogin({ returnTo: "/" });
  assert.notEqual(second.transaction.state, transaction.state);
  for (const unsafe of ["https://evil.example", "//evil.example", "/\\evil.example", undefined]) assert.equal((await idp.beginLogin({ returnTo: unsafe })).transaction.returnTo, "/");
});

test("completeLogin exchanges the code with the verifier and returns the verified identity", async () => {
  const { fake, idp } = await setup();
  const sub = fake.accountId();
  const result = await signIn(fake, idp, { sub, sid: "sid-1", name: "Ada", picture: "https://avatars.example/ada.png", email: "Ada@Example.com", email_verified: true });
  assert.equal(result.sub, sub);
  assert.equal(result.sid, "sid-1");
  assert.equal(result.name, "Ada");
  assert.equal(result.picture, "https://avatars.example/ada.png");
  assert.equal(result.email, "ada@example.com");
  assert.equal(typeof result.idToken, "string");
  assert.equal(result.idToken.split(".").length, 3);
  assert.equal(fake.counts.token, 1);
});

test("an unverified email is dropped", async () => {
  const { fake, idp } = await setup();
  for (const claims of [{ email: "ada@example.com", email_verified: false }, { email: "ada@example.com" }, { email: "ada@example.com", email_verified: "false" }]) {
    const result = await signIn(fake, idp, claims);
    assert.equal(result.email, null);
  }
  const noPicture = await signIn(fake, idp, { picture: "javascript:alert(1)" });
  assert.equal(noPicture.picture, null);
});

test("callback validation: IdP error, state mismatch, expired transaction and failed exchange", async () => {
  let clock = Date.now();
  const { fake, idp } = await setup({ now: () => clock });
  // The IdP returned an error.
  const started = await idp.beginLogin({ returnTo: "/" });
  const denied = new URL(idp.config.redirectUri);
  denied.search = new URLSearchParams({ error: "access_denied", state: started.transaction.state, iss: issuer }).toString();
  await rejectsLogin(idp.completeLogin(denied.href, started.transaction), "idp_error");
  // The state does not match the transaction.
  await rejectsLogin(signIn(fake, idp, {}, { tamper: (url) => url.replace(/state=[^&]+/, "state=forged") }), "state");
  // A missing transaction.
  const other = await idp.beginLogin({ returnTo: "/" });
  await rejectsLogin(idp.completeLogin(fake.authorize(other.url), undefined), "state");
  // An expired transaction (10 minutes).
  const old = await idp.beginLogin({ returnTo: "/" });
  clock += 600_001;
  await rejectsLogin(idp.completeLogin(fake.authorize(old.url), old.transaction), "expired");
  // The token exchange fails: a replayed code, and an IdP error response.
  const fresh = await idp.beginLogin({ returnTo: "/" });
  const callback = fake.authorize(fresh.url);
  await idp.completeLogin(callback, fresh.transaction);
  await rejectsLogin(idp.completeLogin(callback, fresh.transaction), "exchange");
  fake.tokenResponse(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await rejectsLogin(signIn(fake, idp), "exchange");
  // Malformed token-endpoint answers are exchange failures, not ID token failures.
  for (const reply of [() => new Response("<html>", { status: 200 }), () => new Response("<html>", { status: 500 }), () => [], () => ({ access_token: "a", token_type: "mac" }), () => ({ access_token: "a", token_type: "Bearer", expires_in: "soon" })]) {
    fake.tokenResponse(reply);
    await rejectsLogin(signIn(fake, idp), "exchange");
  }
});

test("ID token time checks use the injected clock", async () => {
  const { fake, idp } = await setup({ now: () => Date.now() + 2 * 3600_000 });
  await rejectsLogin(signIn(fake, idp), "id_token");
  const behind = await setup({ now: () => Date.now() - 10 * 60_000 });
  assert.ok((await signIn(behind.fake, behind.idp)).sub);
});

test("callback validation: the ID token's nonce, iss, aud, expiry, signature, alg and sub are all checked", async () => {
  const { fake, idp } = await setup();
  const stranger = await generateKeyPair("ES256");
  const cases = {
    "wrong nonce": { claims: { nonce: "wrong-nonce" } },
    "no nonce": { omit: ["nonce"] },
    "wrong iss": { claims: { iss: "https://evil.example" } },
    "wrong aud": { claims: { aud: "another-client" } },
    "expired": { claims: { iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 } },
    "forged signature": { key: { kid: fake.keys[0].kid, privateKey: stranger.privateKey } },
    "HS256": { alg: "HS256" },
    "alg none": { alg: "none" },
    "sub not an account ID": { claims: { sub: "github|12345" } }
  };
  for (const [name, { claims = {}, omit, ...opts }] of Object.entries(cases)) {
    fake.tokenResponse(async ({ grant }) => ({
      access_token: "opaque", token_type: "Bearer", expires_in: 3600,
      id_token: await fake.issueIdToken({ nonce: grant.nonce, sid: "sid", ...claims }, { omit, ...opts })
    }));
    await assert.rejects(signIn(fake, idp), (error) => {
      assert.ok(error instanceof LoginError, name + ": " + error?.name);
      assert.equal(error.reason, "id_token", name);
      return true;
    });
  }
  fake.tokenResponse(() => ({ access_token: "opaque", token_type: "Bearer", expires_in: 3600 }));
  await rejectsLogin(signIn(fake, idp), "id_token");
});

test("login errors carry only a reason, never token values", async () => {
  const { fake, idp } = await setup();
  let idToken;
  fake.tokenResponse(async ({ grant }) => { idToken = await fake.issueIdToken({ nonce: grant.nonce, aud: "other" }); return { access_token: "secret-access-value", token_type: "Bearer", id_token: idToken }; });
  await assert.rejects(signIn(fake, idp), (error) => {
    const text = error.message + JSON.stringify(error) + String(error.stack);
    assert.ok(!text.includes(idToken));
    assert.ok(!text.includes("secret-access-value"));
    assert.ok(!text.includes(clientSecret));
    return true;
  });
});

test("endSessionUrl points at the IdP end_session_endpoint with client_id, post_logout_redirect_uri and id_token_hint", async () => {
  const { fake, idp } = await setup();
  const { idToken } = await signIn(fake, idp);
  const url = new URL(idp.endSessionUrl({ idToken }));
  assert.equal(url.origin + url.pathname, issuer + "/logout");
  assert.equal(url.searchParams.get("client_id"), "portal");
  assert.equal(url.searchParams.get("post_logout_redirect_uri"), "https://portal.example/");
  assert.equal(url.searchParams.get("id_token_hint"), idToken);
  const early = createIdp({ issuer, clientId: "portal", clientSecret, siteUrl, request: fake.request });
  const before = new URL(early.endSessionUrl({ idToken }));
  assert.equal(before.origin + before.pathname, issuer + "/logout", "built from the issuer before discovery");
  assert.equal(before.searchParams.get("client_id"), "portal");
  assert.equal(before.searchParams.get("post_logout_redirect_uri"), "https://portal.example/");
  assert.equal(before.searchParams.get("id_token_hint"), idToken);
  const bare = new URL(idp.endSessionUrl({}));
  assert.equal(bare.searchParams.has("id_token_hint"), false);
  assert.equal(bare.searchParams.get("client_id"), "portal");
});

test("bearer: a valid at+jwt access token gives sub, client ID and scopes", async () => {
  const { fake, idp } = await setup();
  const sub = fake.accountId();
  const token = await fake.issueAccessToken({ sub, client_id: "vox", scope: "openid credits" });
  assert.deepEqual(await idp.verifyAccessToken(token), { sub, clientId: "vox", scopes: ["openid", "credits"] });
  assert.deepEqual((await idp.verifyAccessToken(await fake.issueAccessToken({ sub }))).scopes, ["credits"]);
  const multi = await fake.issueAccessToken({ sub, aud: [audience, "https://other.example"], scope: undefined });
  assert.deepEqual(await idp.verifyAccessToken(multi), { sub, clientId: "portal", scopes: [] });
});

test("bearer: wrong typ, alg none or HS256, wrong iss or aud, expiry, forged signatures and bad subjects give 401", async () => {
  const { fake, idp } = await setup();
  const stranger = await generateKeyPair("ES256");
  const past = Math.floor(Date.now() / 1000) - 60;
  const tokens = {
    "typ JWT": fake.issueAccessToken({}, { typ: "JWT" }),
    "no typ": fake.issueAccessToken({}, { typ: undefined }),
    "logout token": fake.issueLogoutToken({ aud: audience }),
    "alg none": fake.issueAccessToken({}, { alg: "none" }),
    "HS256": fake.issueAccessToken({}, { alg: "HS256" }),
    "wrong iss": fake.issueAccessToken({ iss: "https://evil.example" }),
    "wrong aud": fake.issueAccessToken({ aud: "portal" }),
    "expired": fake.issueAccessToken({ iat: past - 900, exp: past }),
    "no exp": fake.issueAccessToken({}, { omit: ["exp"] }),
    "no sub": fake.issueAccessToken({}, { omit: ["sub"] }),
    "sub not an account ID": fake.issueAccessToken({ sub: "user-1" }),
    "forged signature": fake.issueAccessToken({}, { key: { kid: fake.keys[0].kid, privateKey: stranger.privateKey } }),
    "garbage": Promise.resolve("not.a.jwt"),
    "empty": Promise.resolve("")
  };
  for (const [name, pending] of Object.entries(tokens)) {
    const token = await pending;
    await assert.rejects(idp.verifyAccessToken(token), (error) => {
      assert.ok(error instanceof TokenError, name + ": " + error?.name + " " + error?.message);
      assert.equal(error.status, 401, name);
      return true;
    }, name);
  }
  await rejectsToken(idp.verifyAccessToken(undefined), 401);
});

test("bearer: key rotation refetches JWKS for an unknown kid", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { fake, idp } = await setup();
  await idp.verifyAccessToken(await fake.issueAccessToken());
  assert.equal(fake.counts.jwks, 1);
  await idp.verifyAccessToken(await fake.issueAccessToken());
  assert.equal(fake.counts.jwks, 1, "keys are cached");
  await fake.rotate({ drop: true });
  mock.timers.tick(31_000);
  const sub = fake.accountId();
  assert.equal((await idp.verifyAccessToken(await fake.issueAccessToken({ sub }))).sub, sub);
  assert.equal(fake.counts.jwks, 2);
});

test("bearer: a key the IdP dropped is refused once the 60 s cache passes", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { fake, idp } = await setup();
  const old = await fake.issueAccessToken();
  await idp.verifyAccessToken(old);
  await fake.rotate({ drop: true });
  mock.timers.tick(61_000);
  await rejectsToken(idp.verifyAccessToken(old), 401);
  assert.equal(fake.counts.jwks, 2);
});

test("bearer: cached keys are trusted for at most 1 h of outage, and a failed refetch backs off for 30 s", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { fake, idp } = await setup();
  await idp.verifyAccessToken(await fake.issueAccessToken());
  fake.setDown(true);
  mock.timers.tick(120_000);
  const attempts = fake.counts.attempts;
  await idp.verifyAccessToken(await fake.issueAccessToken());
  assert.equal(fake.counts.attempts, attempts + 1, "the stale cache tries the network once");
  await idp.verifyAccessToken(await fake.issueAccessToken());
  await rejectsToken(idp.verifyAccessToken(await fake.issueAccessToken({}, { kid: "unknown-kid" })), 503);
  assert.equal(fake.counts.attempts, attempts + 1, "no network attempt during the 30 s backoff");
  mock.timers.tick(31_000);
  await idp.verifyAccessToken(await fake.issueAccessToken());
  assert.equal(fake.counts.attempts, attempts + 2, "retried after the backoff");
  mock.timers.tick(3600_000);
  await rejectsToken(idp.verifyAccessToken(await fake.issueAccessToken()), 503);
  fake.setDown(false);
  mock.timers.tick(31_000);
  await idp.verifyAccessToken(await fake.issueAccessToken());
});

test("bearer: an unreachable IdP gives 503 for an unknown key, while cached keys keep working", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // Discovery never succeeded.
  const down = await setup();
  down.fake.setDown(true);
  await rejectsToken(down.idp.verifyAccessToken(await down.fake.issueAccessToken()), 503);
  // Discovery succeeded, but JWKS is unreachable for a key we have never seen.
  const { fake, idp } = await setup();
  assert.equal(await idp.available(), true);
  fake.setDown(true);
  await rejectsToken(idp.verifyAccessToken(await fake.issueAccessToken()), 503);
  // The failed fetch backs off for 30 s. Once keys are cached, an outage past the cache lifetime still accepts known keys, and gives 503 for new ones.
  fake.setDown(false);
  await rejectsToken(idp.verifyAccessToken(await fake.issueAccessToken()), 503);
  mock.timers.tick(31_000);
  await idp.verifyAccessToken(await fake.issueAccessToken());
  fake.setDown(true);
  mock.timers.tick(120_000);
  await idp.verifyAccessToken(await fake.issueAccessToken());
  await fake.rotate();
  await rejectsToken(idp.verifyAccessToken(await fake.issueAccessToken()), 503);
  // A forged signature on a known kid is still a 401 while the IdP is down.
  const stranger = await generateKeyPair("ES256");
  await rejectsToken(idp.verifyAccessToken(await fake.issueAccessToken({}, { key: { kid: fake.keys[0].kid, privateKey: stranger.privateKey } })), 401);
});

test("back-channel logout: a valid logout token gives sub and sid", async () => {
  const { fake, idp } = await setup();
  const sub = fake.accountId();
  assert.deepEqual(await idp.verifyLogoutToken(await fake.issueLogoutToken({ sub, sid: "sid-9" })), { sub, sid: "sid-9" });
  assert.deepEqual(await idp.verifyLogoutToken(await fake.issueLogoutToken({ sub, sid: undefined })), { sub, sid: undefined });
  assert.deepEqual(await idp.verifyLogoutToken(await fake.issueLogoutToken({ sub: undefined, sid: "sid-only" })), { sub: undefined, sid: "sid-only" });
  assert.deepEqual(await idp.verifyLogoutToken(await fake.issueLogoutToken({ sub, sid: "s" }, { omit: ["exp"] })), { sub, sid: "s" });
});

test("back-channel logout: forged, misaddressed, eventless, nonce-bearing and other malformed tokens are rejected", async () => {
  const { fake, idp } = await setup();
  const stranger = await generateKeyPair("ES256");
  const now = Math.floor(Date.now() / 1000);
  const tokens = {
    "forged signature": fake.issueLogoutToken({}, { key: { kid: fake.keys[0].kid, privateKey: stranger.privateKey } }),
    "wrong aud": fake.issueLogoutToken({ aud: "another-client" }),
    "API aud": fake.issueLogoutToken({ aud: audience }),
    "wrong iss": fake.issueLogoutToken({ iss: "https://evil.example" }),
    "missing events": fake.issueLogoutToken({ events: undefined }),
    "wrong event": fake.issueLogoutToken({ events: { "http://schemas.openid.net/event/other": {} } }),
    "event not an object": fake.issueLogoutToken({ events: { [LOGOUT_EVENT]: "yes" } }),
    "nonce present": fake.issueLogoutToken({ nonce: "n" }),
    "neither sid nor sub": fake.issueLogoutToken({ sid: undefined, sub: undefined }),
    "no iat": fake.issueLogoutToken({}, { omit: ["iat"] }),
    "no jti": fake.issueLogoutToken({}, { omit: ["jti"] }),
    "expired": fake.issueLogoutToken({ iat: now - 600, exp: now - 300 }),
    "stale iat": fake.issueLogoutToken({ iat: now - 3600 }, { omit: ["exp"] }),
    "HS256": fake.issueLogoutToken({}, { alg: "HS256" }),
    "alg none": fake.issueLogoutToken({}, { alg: "none" }),
    "access token": fake.issueAccessToken({ aud: "portal", events: { [LOGOUT_EVENT]: {} }, sid: "s" }),
    "ID token": fake.issueIdToken({ events: { [LOGOUT_EVENT]: {} }, sid: "s" }),
    "sub not an account ID": fake.issueLogoutToken({ sub: "user-1" }),
    "garbage": Promise.resolve("garbage")
  };
  for (const [name, pending] of Object.entries(tokens)) {
    const token = await pending;
    await assert.rejects(idp.verifyLogoutToken(token), (error) => {
      assert.ok(error instanceof TokenError, name + ": " + error?.name + " " + error?.message);
      return true;
    }, name);
  }
});
