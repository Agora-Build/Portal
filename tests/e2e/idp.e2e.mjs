// Practical end-to-end tests (spec §5): the real Portal server against the real auth.agora.build, over real HTTP.
// Run with `npm run test:e2e` on Node 22, with TEST_DATABASE_URL set as Auth's own tests use it. Not part of npm test.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { decodeProtectedHeader } from "jose";
import { createLedger } from "../../scripts/ledger.mjs";
import { API, bearer, completeSignIn, createBrowser, eventually, interactionUid, loadAuth, person, portalSignIn, skipReason, sleep, startStack } from "./harness.mjs";

const skip = await skipReason();
if (skip) console.log("# Skipping the Portal ↔ auth.agora.build end-to-end suite: " + skip + ".");

const ACCOUNT_ID = /^ab[0-9A-HJKMNP-TV-Z]{26}$/;
const VOX_REDIRECT = "https://vox.test/callback";
let lib;
let stack;
const tokensSeen = new Set();

// Nothing the Portal logged carries a secret, a token or an ID token (global constraints: reasons only).
function assertNothingSecretLogged(target = stack) {
  const text = target.logs.join("\n");
  for (const value of [...Object.values(target.secrets), ...tokensSeen].filter(Boolean)) assert.ok(!text.includes(value), "the Portal log contains a secret or token");
}

// An app signs in the browser's person through the IdP and exchanges the code for tokens (code + PKCE, resource
// indicator for the Portal API). If the IdP has no session yet, the person signs in as `user`.
async function appTokens(browser, { client, secret, method, redirectUri, scope, user, target = stack }) {
  const rp = await lib.relyingParty(target.idp, client, secret, method ? { method } : {});
  const started = await lib.startAuthorization(rp, { redirectUri, scope, extra: { resource: API } });
  let page = await browser.visit(started.url);
  if (!page.location) page = await completeSignIn(browser, target, page, user);
  assert.ok(page.location?.startsWith(redirectUri + "?"), "the IdP sends the person back to " + client + " with a code");
  const tokens = await lib.finishAuthorization(rp, page.location, started);
  tokensSeen.add(tokens.access_token);
  tokensSeen.add(tokens.id_token);
  return tokens;
}
const voxTokens = (browser, user, target = stack) => appTokens(browser, { client: "vox", secret: target.secrets.VOX_CLIENT_SECRET, method: "post", redirectUri: VOX_REDIRECT, scope: "openid credits", user, target });
const json = async (response) => ({ status: response.status, body: await response.json() });
const meOf = async (browser) => (await browser.api("/api/me")).json();
const balanceOf = async (token) => (await (await bearer(stack, "/api/credits/balance", token)).json()).credits;

// The atem-like native app: device authorization, approved by the person in their browser, then one token poll.
async function deviceTokens(browser, user, scope) {
  const atem = await lib.relyingParty(stack.idp, "atem");
  const device = await lib.oidc.initiateDeviceAuthorization(atem, { scope, resource: API });
  assert.equal(device.verification_uri, stack.issuer + "/device");
  const entry = await browser.request("/device");
  const confirm = await browser.request("/device", { form: { xsrf: lib.xsrfOf(entry.text), user_code: device.user_code } });
  assert.match(confirm.text, /Approve Atem\?/);
  let page = await browser.follow("/device", { form: { xsrf: lib.xsrfOf(confirm.text), user_code: device.user_code, confirm: "yes" } });
  if (/Continue with GitHub/.test(page.text)) {
    const start = await browser.request("/interaction/" + interactionUid(page.url) + "/upstream/github", { form: {} });
    page = await browser.follow(stack.idp.fake.approve(start.location, user));
  }
  assert.match(page.text, /signed in to Atem on your device/);
  const response = await fetch(stack.issuer + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: "atem" }).toString() });
  assert.equal(response.status, 200, "the first poll after approval gets the tokens");
  const tokens = await response.json();
  tokensSeen.add(tokens.access_token);
  tokensSeen.add(tokens.id_token);
  return tokens;
}

describe("the Portal against the real auth.agora.build", { skip: skip || false }, () => {
  before(async () => {
    lib = await loadAuth();
    stack = await startStack(lib);
  });
  after(async () => { await stack?.close(); });

  test("1. sign in: a fresh browser goes through the IdP with GitHub and comes back signed in to the Portal", async () => {
    const browser = createBrowser(stack);
    assert.equal((await meOf(browser)).account, null, "a fresh browser has no account");
    const login = await browser.request(stack.site + "/auth/login?returnTo=" + encodeURIComponent("/account/"));
    assert.equal(login.status, 303);
    assert.equal(new URL(login.location).origin, stack.issuer, "the Portal sends the browser to auth.agora.build");
    const authorize = new URL(login.location);
    assert.equal(authorize.pathname, "/authorize");
    assert.equal(authorize.searchParams.get("client_id"), "portal");
    assert.equal(authorize.searchParams.get("redirect_uri"), stack.site + "/auth/callback");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("scope"), "openid profile email");
    assert.ok(browser.hasCookie("127.0.0.1", "portal_auth"), "the sign-in transaction cookie is set");
    const signIn = await browser.visit(login.location);
    assert.match(signIn.text, /Continue with GitHub/, "the IdP shows its sign-in page");
    const done = await completeSignIn(browser, stack, signIn, person(5101, "Grace"));
    assert.equal(done.status, 200);
    assert.equal(done.url, stack.site + "/account/?signin=success", "back on the Portal page that started sign-in");
    assert.ok(browser.history.some((url) => url.startsWith(stack.site + "/auth/callback?code=")), "the IdP returned to the Portal callback with a code");
    assert.ok(!browser.hasCookie("127.0.0.1", "portal_auth"), "the transaction cookie is cleared");
    assert.ok(browser.hasCookie("127.0.0.1", "house_session"));
    const me = await meOf(browser);
    assert.match(me.account.id, ACCOUNT_ID);
    assert.equal(me.account.name, "Grace");
    assert.equal(me.account.email, "grace@example.com");
    assert.equal(me.account.avatar, "https://avatars.example/5101");
    const config = await (await browser.api("/api/auth/config")).json();
    assert.deepEqual(config, { issuer: stack.issuer, accountUrl: stack.issuer + "/account" });
    assertNothingSecretLogged();
  });

  test("2. SSO: the sample app signs in in the same browser without a login page, with the same sub", async () => {
    const { browser } = await portalSignIn(stack, person(5201, "Hedy"));
    const portalId = (await meOf(browser)).account.id;
    const sample = await lib.relyingParty(stack.idp, "sample", stack.secrets.SAMPLE_CLIENT_SECRET);
    const started = await lib.startAuthorization(sample, { redirectUri: "https://sample.test/callback" });
    // visit() stops at the first page it gets; a redirect out to the app means no sign-in or consent page was shown.
    const page = await browser.visit(started.url);
    assert.ok(page.location?.startsWith("https://sample.test/callback?code="), "straight back to the app with a code, no page shown");
    const tokens = await lib.finishAuthorization(sample, page.location, started);
    tokensSeen.add(tokens.id_token);
    const id = await lib.verifyJwt(stack.idp, tokens.id_token, { audience: "sample" });
    assert.equal(id.payload.sub, portalId, "one account across apps");
    assertNothingSecretLogged();
  });

  test("3. sign out: RP-initiated logout ends the Portal session and the IdP session", async () => {
    const { browser } = await portalSignIn(stack, person(5301, "Joan"));
    assert.match((await browser.request("/account")).text, /Sign out everywhere/, "signed in at the IdP too");
    const logout = await browser.api("/api/auth/logout", { method: "POST", json: {} });
    assert.equal(logout.status, 200);
    const { endSessionUrl } = logout.json();
    const end = new URL(endSessionUrl);
    assert.equal(end.origin + end.pathname, stack.issuer + "/logout");
    assert.equal(end.searchParams.get("post_logout_redirect_uri"), stack.site + "/");
    assert.ok(end.searchParams.get("id_token_hint"), "the ID token is the hint");
    tokensSeen.add(end.searchParams.get("id_token_hint"));
    assert.equal((await meOf(browser)).account, null, "the Portal session is gone at once");
    const confirm = await browser.visit(endSessionUrl);
    assert.match(confirm.text, /Sign out of Agora Build\?/);
    const done = await browser.visit("/logout/confirm", { form: { xsrf: lib.xsrfOf(confirm.text), logout: "yes" } });
    assert.equal(done.url, stack.site + "/", "the IdP returns to the Portal home page");
    assert.equal(done.status, 200);
    const account = await browser.request("/account");
    assert.doesNotMatch(account.text, /Sign out everywhere/, "the IdP session is gone");
    assert.match(account.text, /Manage your Agora Build account/, "the IdP account page asks to sign in");
    // A new Portal sign-in now needs the IdP's sign-in page again.
    assert.match((await browser.visit(stack.site + "/auth/login")).text, /Continue with GitHub/);
    assertNothingSecretLogged();
  });

  test("4. back-channel: sign out everywhere on the IdP account page ends every Portal session of the account", async () => {
    const user = person(5401, "Katherine");
    const { browser: laptop } = await portalSignIn(stack, user);
    const { browser: phone } = await portalSignIn(stack, user);
    const { browser: other } = await portalSignIn(stack, person(5402, "Lise"));
    const id = (await meOf(laptop)).account.id;
    assert.equal((await meOf(phone)).account.id, id);
    const account = await laptop.request("/account");
    assert.match(account.text, /Sign out everywhere/);
    const started = Date.now();
    const result = await laptop.follow("/account/sign-out-everywhere", { form: {} });
    assert.match(result.text, /You are signed out everywhere/);
    const ended = await eventually(async () => (await meOf(laptop)).account === null && (await meOf(phone)).account === null, { timeout: 5000 });
    assert.ok(ended, "both Portal sessions ended through back-channel logout within 5 s");
    const elapsed = Date.now() - started;
    assert.equal((await laptop.api("/api/credits/balance")).status, 401, "the old cookie is a stranger now");
    assert.equal((await meOf(other)).account.name, "Lise", "another account's session stays");
    assert.ok(!stack.logs.some((line) => /Back-channel logout refused/.test(line)), "the Portal accepted the IdP's logout tokens");
    console.log("# flow 4: Portal sessions ended " + elapsed + " ms after sign out everywhere was posted");
    assertNothingSecretLogged();
  });

  test("5. billing client: a vox-like app reserves and settles a user's credits with the user's access token", async () => {
    const { browser } = await portalSignIn(stack, person(5501, "Mary"));
    const id = (await meOf(browser)).account.id;
    // The admin grant, through the ledger the offline admin command uses (scripts/platform-admin.mjs grant-credits).
    await createLedger(stack.store).deposit(id, 50, "E2E grant", "e2e-grant-" + id);
    const tokens = await voxTokens(browser);
    const access = await lib.verifyJwt(stack.idp, tokens.access_token, { audience: API, typ: "at+jwt" });
    assert.equal(access.payload.sub, id);
    assert.equal(access.payload.client_id, "vox");
    assert.ok(access.payload.scope.split(" ").includes("credits"));
    assert.equal(await balanceOf(tokens.access_token), 50);
    const key = "e2e-reserve-" + Date.now();
    const held = await json(await bearer(stack, "/api/platform/credits/reserve", tokens.access_token, { method: "POST", json: { service: "evaluation", units: 2, idempotencyKey: key } }));
    assert.equal(held.status, 200);
    assert.equal(held.body.status, "reserved");
    assert.equal(await balanceOf(tokens.access_token), 44, "2 units at the server's price of 3 are held");
    const again = await json(await bearer(stack, "/api/platform/credits/reserve", tokens.access_token, { method: "POST", json: { service: "evaluation", units: 2, idempotencyKey: key } }));
    assert.deepEqual([again.status, again.body.id], [200, held.body.id], "a retried reserve is idempotent");
    const settled = await json(await bearer(stack, "/api/platform/credits/settle", tokens.access_token, { method: "POST", json: { service: "evaluation", reservationId: held.body.id, outcome: "capture" } }));
    assert.deepEqual([settled.status, settled.body], [200, { settled: true }]);
    assert.equal(await balanceOf(tokens.access_token), 44);
    assert.equal((await (await browser.api("/api/credits/balance")).json()).credits, 44, "the browser sees the same wallet");
    const statement = await json(await bearer(stack, "/api/credits/statement", tokens.access_token));
    assert.equal(statement.status, 200);
    assert.ok(statement.body.entries.length >= 2, "the grant and the charge are on the statement");
    assertNothingSecretLogged();
  });

  test("6. native app: an atem-like device-code token reads /api/me and the balance; without credits it gets 403", async () => {
    const browser = createBrowser(stack);
    const user = person(5601, "Ada");
    const tokens = await deviceTokens(browser, user, "openid profile credits");
    const header = decodeProtectedHeader(tokens.access_token);
    assert.deepEqual([header.typ, header.alg], ["at+jwt", "ES256"]);
    const me = await json(await bearer(stack, "/api/me", tokens.access_token));
    assert.equal(me.status, 200);
    assert.match(me.body.account.id, ACCOUNT_ID, "the first token for a new sub gets an account");
    assert.equal(me.body.account.email, undefined, "bearer callers don't get the email");
    const balance = await json(await bearer(stack, "/api/credits/balance", tokens.access_token));
    assert.deepEqual([balance.status, balance.body.userId, balance.body.credits], [200, me.body.account.id, 0]);
    // The same person, the same app, without the credits scope.
    const narrow = await deviceTokens(browser, user, "openid profile agora:projects");
    const scopes = (await lib.verifyJwt(stack.idp, narrow.access_token, { audience: API, typ: "at+jwt" })).payload.scope.split(" ");
    assert.ok(!scopes.includes("credits"));
    assert.equal((await bearer(stack, "/api/me", narrow.access_token)).status, 200);
    const refused = await bearer(stack, "/api/credits/balance", narrow.access_token);
    assert.equal(refused.status, 403);
    assert.match(refused.headers.get("www-authenticate"), /^Bearer error="insufficient_scope", scope="credits"/);
    assertNothingSecretLogged();
  });

  test("7. billing allowlist: a non-allowlisted app's credits token is refused for reserve and settle", async () => {
    const { browser } = await portalSignIn(stack, person(5701, "Barbara"));
    const id = (await meOf(browser)).account.id;
    await createLedger(stack.store).deposit(id, 20, "E2E grant", "e2e-grant-" + id);
    const tokens = await appTokens(browser, { client: "notes", secret: stack.secrets.NOTES_CLIENT_SECRET, redirectUri: "https://notes.test/callback", scope: "openid credits" });
    const access = await lib.verifyJwt(stack.idp, tokens.access_token, { audience: API, typ: "at+jwt" });
    assert.deepEqual([access.payload.client_id, access.payload.scope.split(" ").includes("credits")], ["notes", true]);
    assert.equal(await balanceOf(tokens.access_token), 20, "the token is valid and may read the balance");
    const reserve = await json(await bearer(stack, "/api/platform/credits/reserve", tokens.access_token, { method: "POST", json: { service: "evaluation", units: 1, idempotencyKey: "e2e-notes-reserve-0001" } }));
    assert.equal(reserve.status, 403);
    assert.match(reserve.body.error, /not allowed to charge credits/);
    const settle = await bearer(stack, "/api/platform/credits/settle", tokens.access_token, { method: "POST", json: { service: "evaluation", reservationId: "00000000-0000-0000-0000-000000000000", outcome: "capture" } });
    assert.equal(settle.status, 403);
    assert.equal(await balanceOf(tokens.access_token), 20, "nothing was held");
    assertNothingSecretLogged();
  });

  // What `npm run keys -- emergency <kid>` does in the Auth checkout, against the IdP's database. Returns the kids
  // the IdP publishes once it has dropped the old one (the running IdP reloads on NOTIFY).
  async function emergencyRotation(kid) {
    const keys = lib.createKeyStore(stack.auth.db, { encryptionKey: stack.auth.app.services.config.keyEncryptionKey });
    const audit = lib.createAudit(stack.auth.db, { knownClient: () => false, log: { error: () => {} } });
    assert.equal((await lib.keysCommand({ keys, audit }, "emergency", kid)).code, 0);
    const published = await eventually(async () => {
      const kids = (await (await fetch(stack.issuer + "/jwks")).json()).keys.map((key) => key.kid);
      return kids.includes(kid) ? null : kids;
    }, { timeout: 3000 });
    assert.ok(published?.length, "the IdP dropped the old key from its JWKS");
    return published;
  }

  test("8a. key rotation: after an emergency rotation a fresh token works within about 6 s, and then the old one is refused", { timeout: 60000 }, async () => {
    const { browser } = await portalSignIn(stack, person(5801, "Rosalind"));
    const old = await voxTokens(browser);
    const oldKid = decodeProtectedHeader(old.access_token).kid;
    assert.equal((await bearer(stack, "/api/me", old.access_token)).status, 200, "the Portal knows the current key");
    const published = await emergencyRotation(oldKid);
    const rotatedAt = Date.now();
    const fresh = await voxTokens(browser);
    assert.equal(decodeProtectedHeader(fresh.access_token).kid, published[0], "the fresh token uses the replacement key");
    // The Portal may refetch the JWKS for a new kid 5 s after its last fetch.
    const accepted = await eventually(async () => (await bearer(stack, "/api/me", fresh.access_token)).status === 200, { timeout: 6500, every: 250 });
    const elapsed = Date.now() - rotatedAt;
    assert.ok(accepted, "a fresh token works within about 6 s of the rotation");
    const refused = await bearer(stack, "/api/me", old.access_token);
    assert.equal(refused.status, 401, "the refetched JWKS no longer has the old key");
    assert.match(refused.headers.get("www-authenticate"), /^Bearer error="invalid_token"/);
    console.log("# flow 8a: the fresh token was accepted " + elapsed + " ms after the rotation");
    assertNothingSecretLogged();
  });

  test("8b. key rotation: with no fresh traffic, the old token is refused once the Portal's 60 s JWKS cache expires", { timeout: 120000 }, async () => {
    const { browser } = await portalSignIn(stack, person(5802, "Chien-Shiung"));
    const old = await voxTokens(browser);
    assert.equal((await bearer(stack, "/api/me", old.access_token)).status, 200, "the Portal knows the current key");
    await emergencyRotation(decodeProtectedHeader(old.access_token).kid);
    const rotatedAt = Date.now();
    // The documented trade-off: until the 60 s cache expires, the cached JWKS still has the old key.
    const meanwhile = (await bearer(stack, "/api/me", old.access_token)).status;
    // jose's cache uses the real clock and no Portal option shortens it, so this test waits.
    await sleep(Math.max(0, rotatedAt + 61000 - Date.now()));
    const refused = await bearer(stack, "/api/me", old.access_token);
    assert.equal(refused.status, 401, "the old token's key is unknown once the Portal refetches the JWKS");
    assert.match(refused.headers.get("www-authenticate"), /^Bearer error="invalid_token"/);
    const fresh = await voxTokens(browser);
    assert.equal((await bearer(stack, "/api/me", fresh.access_token)).status, 200);
    console.log("# flow 8b: right after the rotation the cached JWKS still answered " + meanwhile + " for the old token; after 61 s it answered 401");
    assertNothingSecretLogged();
  });

  test("10. wrong account: a token for account X can't read or settle account Y's credits", async () => {
    const { browser: xBrowser } = await portalSignIn(stack, person(6001, "Xenia"));
    const { browser: yBrowser } = await portalSignIn(stack, person(6002, "Yara"));
    const xId = (await meOf(xBrowser)).account.id;
    const yId = (await meOf(yBrowser)).account.id;
    assert.notEqual(xId, yId);
    await createLedger(stack.store).deposit(yId, 40, "E2E grant", "e2e-grant-" + yId);
    const x = await voxTokens(xBrowser);
    const y = await voxTokens(yBrowser);
    const hold = await json(await bearer(stack, "/api/platform/credits/reserve", y.access_token, { method: "POST", json: { service: "evaluation", units: 1, idempotencyKey: "e2e-wrong-account-0001" } }));
    assert.equal(hold.status, 200);
    const me = await json(await bearer(stack, "/api/me", x.access_token));
    assert.equal(me.body.account.id, xId);
    const balance = await json(await bearer(stack, "/api/credits/balance?userId=" + yId, x.access_token));
    assert.deepEqual([balance.body.userId, balance.body.credits], [xId, 0], "X's token reads only X's wallet");
    const statement = await json(await bearer(stack, "/api/credits/statement", x.access_token));
    assert.deepEqual(statement.body.entries, [], "none of Y's entries");
    const settle = await bearer(stack, "/api/platform/credits/settle", x.access_token, { method: "POST", json: { service: "evaluation", reservationId: hold.body.id, outcome: "capture" } });
    assert.equal(settle.status, 404, "X's token can't settle Y's hold");
    const release = await json(await bearer(stack, "/api/platform/credits/settle", y.access_token, { method: "POST", json: { service: "evaluation", reservationId: hold.body.id, outcome: "release" } }));
    assert.equal(release.status, 200, "Y's hold was untouched");
    assert.equal(await balanceOf(y.access_token), 40);
    assert.equal((await (await xBrowser.api("/api/credits/balance")).json()).userId, xId);
    assertNothingSecretLogged();
  });

  test("9a. IdP down: existing Portal sessions keep working; a Portal started during the outage reports sign-in unavailable, then recovers", { timeout: 120000 }, async () => {
    // Its own IdP and Portal, because this flow takes the IdP off the network.
    const own = await startStack(lib);
    try {
      const { browser } = await portalSignIn(own, person(5901, "Emmy"));
      const id = (await meOf(browser)).account.id;
      assert.match(id, ACCOUNT_ID);
      // The IdP stops answering at its address (its listener closes and drops open connections).
      await own.front.stop();
      assert.equal(await fetch(own.issuer + "/jwks").catch(() => null), null, "the IdP is unreachable");
      assert.equal((await meOf(browser)).account.id, id, "the existing session still works");
      assert.equal((await browser.api("/api/credits/balance")).status, 200);
      // A Portal that starts while the IdP is down.
      const cold = await own.extraPortal();
      const login = () => fetch(cold.site + "/auth/login?returnTo=%2Faccount%2F", { redirect: "manual" });
      const firstAttempt = Date.now();
      const refused = await login();
      assert.equal(refused.status, 303);
      assert.equal(refused.headers.get("location"), "/account/?signin=unavailable", "sign-in reports itself unavailable");
      // The IdP comes back. Discovery is retried at most every 30 s, so sign-in stays unavailable until then.
      await own.front.restart();
      assert.equal((await fetch(own.issuer + "/jwks")).status, 200, "the IdP answers again");
      assert.equal((await login()).headers.get("location"), "/account/?signin=unavailable", "within 30 s of the failed discovery the Portal doesn't retry");
      await sleep(Math.max(0, firstAttempt + 30500 - Date.now()));
      const recovered = await login();
      assert.equal(recovered.status, 303);
      assert.equal(new URL(recovered.headers.get("location")).origin + new URL(recovered.headers.get("location")).pathname, own.issuer + "/authorize", "after 30 s sign-in goes to the IdP again");
      assert.equal((await meOf(browser)).account.id, id, "the session survived the outage");
      assertNothingSecretLogged(own);
    } finally {
      await own.close();
    }
  });

  // A running Portal re-checks the IdP when it has heard nothing from it for 30 s (its last contact here is the
  // sign-in's token exchange), so a new sign-in after that reports itself unavailable.
  test("9b. IdP down: a new sign-in on a running Portal shows the unavailable message", { timeout: 120000 }, async () => {
    const own = await startStack(lib);
    try {
      const { browser } = await portalSignIn(own, person(5902, "Sophie"));
      const signedInAt = Date.now();
      assert.match((await meOf(browser)).account.id, ACCOUNT_ID);
      await own.front.stop();
      assert.equal(await fetch(own.issuer + "/jwks").catch(() => null), null, "the IdP is unreachable");
      await sleep(Math.max(0, signedInAt + 30500 - Date.now()));
      assert.equal((await meOf(browser)).account.name, "Sophie", "the existing session still works");
      const newcomer = createBrowser(own);
      const login = await newcomer.request(own.site + "/auth/login?returnTo=%2Faccount%2F");
      assert.equal(login.status, 303);
      // Reported without the authorize URL's query (state, nonce, PKCE challenge).
      const sentTo = login.location?.startsWith(own.issuer) ? "the unreachable IdP at " + new URL(login.location).pathname : login.location;
      assert.equal(sentTo, own.site + "/account/?signin=unavailable", "a new sign-in on the running Portal shows the unavailable message");
    } finally {
      await own.close();
    }
  });
});
