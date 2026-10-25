// Drives a real headless Chromium through the Stations and Integrations sections of /account/ for a signed-in account,
// at a desktop (1280×800) and a mobile (390×844) viewport. Not part of `npm test`, and no dependency of this package,
// like scripts/browser-smoke.mjs: point it at an existing playwright-core install and Chromium binary.
//
// It runs against the end-to-end stack with Stations and integrations (tests/e2e/harness.mjs): the real
// auth.agora.build from an Agora-Build/Auth checkout, the real Portal with its own PostgreSQL schema, and Station stubs
// on https://station.test:<port>, as tests/e2e/integrations.e2e.mjs does. Needs Node 22, the Auth checkout (AUTH_REPO,
// default ../Auth), TEST_DATABASE_URL and PORTAL_TEST_DATABASE_URL, as `npm run test:e2e` does.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM_PATH=/path/to/chrome \
//     TEST_DATABASE_URL=postgres://… PORTAL_TEST_DATABASE_URL=postgres://…/agora_portal_test \
//     node scripts/browser-smoke-integrations.mjs
//
// For each viewport one account is set up over the API first: a registered Station shared with a second account, and
// three integrations (one ready through an Astation approval and a Station report, one awaiting approval, one paused).
// Then, in the browser, it checks: both sections and their lists; adding a Station (a failed proof, then a good one);
// creating an integration with a key pair generated in the browser (the private JWK is downloaded and never sent);
// Pause, Resume, Renew, Quota, Rotate key, History and Revoke; keyboard navigation (reachability, focus indicators,
// accessible names, Enter and Space, the dialogs' focus); and reduced motion. With SCREENSHOT_DIR set, it saves
// <viewport>-<what>.png there.
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { API, interactionUid, integrationsSkipReason, loadAuth, person, portalSignIn, skipReason, startStack, STATION_HOST, stationTls } from "../tests/e2e/harness.mjs";

const { PLAYWRIGHT_CORE: playwrightPath, CHROMIUM_PATH: chromiumPath, SCREENSHOT_DIR: screenshotDir } = process.env;
if (!playwrightPath || !chromiumPath) {
  console.error("Set PLAYWRIGHT_CORE (a playwright-core directory) and CHROMIUM_PATH (a Chromium or Chrome binary).");
  process.exit(2);
}
const skip = (await skipReason()) ?? (await integrationsSkipReason());
if (skip) {
  console.error("The integrations browser smoke can't run: " + skip + ".");
  process.exit(2);
}
const { chromium } = createRequire(import.meta.url)(isAbsolute(playwrightPath) ? playwrightPath : resolve(playwrightPath));
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

const failures = [];
const check = (ok, message) => {
  console.log((ok ? "ok      " : "FAILED  ") + message);
  if (!ok) failures.push(message);
  return ok;
};
const note = (message) => console.log("        " + message);
async function step(label, run) {
  try { await run(); }
  catch (error) { check(false, label + ": " + String(error?.message || error).split("\n")[0]); }
}
const shot = async (target, name) => { if (screenshotDir) await target.screenshot({ path: resolve(screenshotDir, name + ".png"), ...(target.url ? { fullPage: true } : {}) }); };

const VIEWPORTS = [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }];
const SCOPES = ["agent.view", "agent.prompt"];

const lib = await loadAuth();
const stack = await startStack(lib, { integrations: true });
const stubs = [];
let browser = null;
note("Portal " + stack.site + ", IdP " + stack.issuer);

const json = async (response) => ({ status: response.status, body: await response.json() });
// A client-credentials token with private_key_jwt, as a Station report client asks for one.
async function clientCredentials({ clientId, privateKey, resource, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setIssuer(clientId).setSubject(clientId)
    .setAudience(stack.issuer + "/token").setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + 60).sign(privateKey);
  const response = await fetch(stack.issuer + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", resource, scope, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion }).toString()
  });
  return (await response.json()).access_token;
}
// A Station stub (as in tests/e2e/integrations.e2e.mjs): serves the proof value it is given and accepts change nudges.
async function startStation() {
  const reportKeys = await generateKeyPair("ES256");
  let proof = null;
  const server = createServer(stationTls(), (request, response) => {
    if (request.method === "GET" && request.url === "/.well-known/agora-build-station" && proof !== null) return void response.writeHead(200, { "Content-Type": "text/plain" }).end(proof);
    if (request.method === "POST" && request.url === "/agora-build/v1/changes") { request.resume(); request.on("end", () => response.writeHead(202).end()); return; }
    response.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const stub = {
    origin: "https://" + STATION_HOST + ":" + server.address().port,
    reportJwk: await exportJWK(reportKeys.publicKey),
    reportClientId: null,
    serve(value) { proof = value; },
    reportToken: () => clientCredentials({ clientId: stub.reportClientId, privateKey: reportKeys.privateKey, resource: API, scope: "station.report" }),
    close: () => new Promise((done) => { server.close(done); server.closeAllConnections(); })
  };
  stubs.push(stub);
  return stub;
}
// The native "astation" app's tokens (device flow approved in the cookie-jar browser), to approve an integration.
async function astationToken(owner, user) {
  const astation = await lib.relyingParty(stack.idp, "astation");
  const device = await lib.oidc.initiateDeviceAuthorization(astation, { scope: "openid integrations:read integrations:approve", resource: API });
  const entry = await owner.request("/device");
  const confirm = await owner.request("/device", { form: { xsrf: lib.xsrfOf(entry.text), user_code: device.user_code } });
  let page = await owner.follow("/device", { form: { xsrf: lib.xsrfOf(confirm.text), user_code: device.user_code, confirm: "yes" } });
  if (/Continue with GitHub/.test(page.text)) {
    const start = await owner.request("/interaction/" + interactionUid(page.url) + "/upstream/github", { form: {} });
    page = await owner.follow(stack.idp.fake.approve(start.location, user));
  }
  const response = await fetch(stack.issuer + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: "astation" }).toString() });
  return (await response.json()).access_token;
}
const bearerPost = (path, token, body) => fetch(stack.site + path, { method: "POST", headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json);

// The account a viewport works with, set up over the API: a Station shared with a second account, and integrations
// "Release bot" (ready), "Ops agent" (awaiting approval) and "Night shift" (paused).
async function setUp(user, memberUser) {
  const { browser: owner } = await portalSignIn(stack, user);
  const ownerId = (await (await owner.api("/api/me")).json()).account.id;
  const station = await startStation();
  const issued = (await json(await owner.api("/api/stations/challenges", { method: "POST", json: { origin: station.origin } }))).body;
  station.serve(issued.value);
  const registered = await json(await owner.api("/api/stations", { method: "POST", json: { challengeId: issued.challengeId, reportKey: station.reportJwk } }));
  if (registered.status !== 201) throw new Error("registering the setup Station answered " + registered.status);
  station.reportClientId = registered.body.reportClientId;
  const { browser: member } = await portalSignIn(stack, memberUser);
  const memberId = (await (await member.api("/api/me")).json()).account.id;
  await owner.api("/api/stations/" + registered.body.id + "/members/" + memberId, { method: "PUT" });
  const create = async (name) => {
    const keys = await generateKeyPair("ES256");
    const created = await json(await owner.api("/api/integrations", { method: "POST", json: { stationId: registered.body.id, name, scopes: SCOPES, publicJwk: await exportJWK(keys.publicKey) } }));
    if (created.status !== 201) throw new Error("creating " + name + " answered " + created.status);
    return created.body;
  };
  const ready = await create("Release bot");
  const approved = await bearerPost("/api/v1/integrations/" + ready.id + "/approval", await astationToken(owner, user), { r9Svc: "a".repeat(64) });
  if (approved.status !== 200) throw new Error("approving answered " + approved.status + " " + JSON.stringify(approved.body));
  const reported = await bearerPost("/api/v1/stations/reports", await station.reportToken(), { integrationId: ready.id, state: "ready" });
  if (reported.body.state !== "ready") throw new Error("the ready report answered " + reported.status);
  await create("Ops agent");
  const paused = await create("Night shift");
  await owner.api("/api/integrations/" + paused.id + "/pause", { method: "POST", json: {} });
  return { ownerId, memberId, station };
}

// A browser context that reaches only the Portal and the IdP (and, for "Details", the Station stubs, answered here);
// the IdP's GitHub redirect goes to Auth's stand-in GitHub, as in scripts/browser-smoke.mjs.
const UPSTREAM_GITHUB = /^\/interaction\/[^/]+\/upstream\/github$/;
async function newContext(viewport, user) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.name === "mobile", hasTouch: viewport.name === "mobile", acceptDownloads: true });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === stack.issuer && route.request().method() === "POST" && UPSTREAM_GITHUB.test(url.pathname)) {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers().location;
      if (!location || new URL(location, url).origin !== "https://github.com") return route.fulfill({ response });
      return route.fulfill({ response, headers: { ...response.headers(), location: stack.idp.fake.approve(new URL(location, url).href, user) } });
    }
    if (url.origin === stack.site || url.origin === stack.issuer) return route.continue();
    if (stubs.some((stub) => stub.origin === url.origin)) {
      const cors = { "Access-Control-Allow-Origin": stack.site, "Access-Control-Allow-Headers": "Authorization" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === "/agora-build/v1/details") return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ label: "Smoke Station", status: "online" }) });
    }
    return route.abort();
  });
  return context;
}
const item = (page, scope, name) => page.locator(scope, { has: page.locator("h3", { hasText: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }) });
const integration = (page, name) => item(page, ".integration-item", name);
const badgeOf = async (page, name) => (await integration(page, name).locator(".state-badge").textContent()) || "";
const until = async (test, label, timeout = 8000) => { const end = Date.now() + timeout; while (!(await test())) { if (Date.now() > end) throw new Error("timed out waiting for " + label); await new Promise((done) => setTimeout(done, 100)); } };
const overflowCheck = async (page, tag, when) => {
  const [width, inner] = await page.evaluate(() => [document.scrollingElement.scrollWidth, innerWidth]);
  check(width <= inner, tag + "no horizontal overflow " + when + " (" + width + " ≤ " + inner + ")");
};
// The accessible role and name of the focused element, from Playwright's ARIA snapshot.
const focusedAria = async (page) => ((await page.locator(":focus").ariaSnapshot().catch(() => "")) || "").split("\n")[0].replace(/^- /, "");
// Outline and box shadow of an element, as computed now.
const ring = (handle) => handle.evaluate((node) => { const style = getComputedStyle(node); return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow].join(" | "); });

async function flow(viewport, index) {
  const tag = viewport.name + ": ";
  const user = person(7300 + index, viewport.name === "desktop" ? "Grace" : "Mary");
  const setup = await setUp(user, person(7310 + index, viewport.name === "desktop" ? "Bo" : "Kai"));
  const context = await newContext(viewport, user);
  const page = await context.newPage();
  const errors = [];
  // The deliberate failed Station check answers 422; the browser reports that as a console error.
  const expectedErrors = [/^Failed to load resource: the server responded with a status of 422/];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const at = message.location()?.url || "";
    // Refused third-party loads (fonts, avatars) are this context's doing, not the page's.
    if (/^Failed to load resource/.test(message.text()) && at && ![stack.site, stack.issuer].includes(new URL(at).origin)) return;
    if (expectedErrors.some((pattern) => pattern.test(message.text()))) { expectedErrors.splice(expectedErrors.findIndex((pattern) => pattern.test(message.text())), 1); return; }
    errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  const sentBodies = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/integrations") sentBodies.push(request.postData() || ""); });
  try {
    await step(tag + "sign in", async () => {
      await page.goto(stack.site + "/auth/login?returnTo=" + encodeURIComponent("/account/"));
      await page.getByRole("button", { name: "Continue with GitHub" }).click();
      await page.waitForURL((url) => url.origin === stack.site && url.pathname === "/account/", { timeout: 10000 });
      check(true, tag + "signed in through the IdP and back on /account/");
    });

    await step(tag + "lists", async () => {
      await page.locator("#station-list .station-item").first().waitFor({ timeout: 8000 });
      await page.locator("#integration-list .integration-item").nth(2).waitFor({ timeout: 8000 });
      check(await page.locator("#stations").isVisible() && await page.locator("#integrations").isVisible(), tag + "both sections are visible");
      const row = item(page, ".station-item", setup.station.origin);
      check(await row.isVisible() && /You own it/.test(await row.locator(".muted").first().textContent()), tag + "the Station shows its origin and role (You own it)");
      await row.locator(".station-members summary").click();
      await row.locator(".member-list .mono").first().waitFor({ timeout: 5000 });
      check((await row.locator(".member-list .mono").allTextContents()).includes(setup.memberId), tag + "Members lists the shared account");
      await row.getByRole("button", { name: "Details", exact: true }).click();
      await until(async () => !/^(|Asking the Station\.\.\.)$/.test(await row.locator(".station-details").textContent()), "the Station's details");
      check((await row.locator(".station-details").textContent()) === "Smoke Station · online", tag + "Details shows the Station's label and status (" + (await row.locator(".station-details").textContent()) + ")");
      const labels = { "Release bot": "Ready", "Ops agent": "Awaiting approval in Astation", "Night shift": "Paused" };
      for (const [name, label] of Object.entries(labels)) check((await badgeOf(page, name)) === label, tag + name + " shows \"" + label + "\" (" + (await badgeOf(page, name)) + ")");
      const facts = await integration(page, "Release bot").locator(".integration-facts").innerText();
      check(/Scopes\s+agent\.view, agent\.prompt/i.test(facts) && /Quota\s+200 token requests \/ s/i.test(facts) && /Expires\s+\S/i.test(facts) && /Station\s+https:\/\/station\.test/i.test(facts), tag + "an integration lists Station, scopes, quota and expiry");
      await overflowCheck(page, tag, "with the lists and members shown");
      await shot(page, viewport.name + "-account-full");
      await shot(page.locator("#stations"), viewport.name + "-stations");
      await shot(page.locator("#integrations"), viewport.name + "-integrations");
    });

    await step(tag + "add Station", async () => {
      const stub = await startStation();
      await page.locator("#station-add").click();
      const form = page.locator("#station-form");
      check(await form.isVisible() && (await page.locator("#station-add").getAttribute("aria-expanded")) === "true", tag + "Add Station opens the form");
      await form.locator("[name=origin]").fill(stub.origin);
      await page.locator("#station-submit").click();
      await page.locator("#station-challenge").waitFor({ state: "visible", timeout: 5000 });
      const value = await page.locator("#station-challenge-value").textContent();
      check(/^[A-Za-z0-9_-]{43}$/.test(value) && (await page.locator("#station-challenge-url").textContent()) === stub.origin + "/.well-known/agora-build-station", tag + "the check value and its URL are shown");
      check((await page.locator("#station-submit").textContent()) === "Verify and register", tag + "the button becomes \"Verify and register\"");
      await overflowCheck(page, tag, "with the check value shown");
      await shot(form, viewport.name + "-station-challenge");
      // Error path: the Station serves something else.
      stub.serve("not-the-value");
      await form.locator("[name=reportKey]").fill(JSON.stringify(stub.reportJwk));
      await page.locator("#station-submit").click();
      await page.locator("#station-status").filter({ hasText: /./ }).waitFor({ timeout: 8000 });
      const failed = await page.locator("#station-status").textContent();
      check(/did not serve the check value/.test(failed), tag + "a failed proof shows a readable status (" + failed + ")");
      await shot(form, viewport.name + "-station-error");
      // The failed check used the value up: the form asks for a new one rather than offering a dead retry.
      check((await page.locator("#station-submit").textContent()) === "Get the check value" && await page.locator("#station-challenge").isHidden(), tag + "after a failed proof the form offers a new check value");
      await page.locator("#station-submit").click();
      await page.locator("#station-challenge").waitFor({ state: "visible", timeout: 5000 });
      stub.serve((await page.locator("#station-challenge-value").textContent()) + "\n");
      await form.locator("[name=reportKey]").fill(JSON.stringify(stub.reportJwk));
      await page.locator("#station-submit").click();
      await form.waitFor({ state: "hidden", timeout: 8000 });
      await item(page, ".station-item", stub.origin).waitFor({ timeout: 8000 });
      check(await page.locator("#station-list .station-item").count() === 2, tag + "Verify and register adds the second Station to the list");
      check((await page.locator("#station-add").getAttribute("aria-expanded")) === "false", tag + "the form closes after registering");
      check(await page.evaluate(() => document.activeElement?.id) === "station-add", tag + "focus returns to Add Station after registering");
    });

    await step(tag + "create integration with a generated key", async () => {
      await page.locator("#integration-add").click();
      const form = page.locator("#integration-form");
      await form.waitFor({ state: "visible" });
      await form.locator("[name=name]").fill("Smoke app");
      await form.locator("[name=stationId]").selectOption({ label: setup.station.origin });
      await form.getByLabel("agent.prompt").check();
      await form.getByRole("button", { name: "Generate a key pair in this browser" }).click();
      const link = form.locator(".key-download a");
      await link.waitFor({ timeout: 5000 });
      check((await link.getAttribute("download")) === "smoke-app.private.jwk.json", tag + "the download is named smoke-app.private.jwk.json");
      await overflowCheck(page, tag, "with the integration form and key shown");
      await shot(form, viewport.name + "-integration-form");
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      const file = JSON.parse(await readFile(await download.path(), "utf8"));
      check(download.suggestedFilename() === "smoke-app.private.jwk.json" && file.kty === "EC" && file.crv === "P-256" && typeof file.d === "string" && file.d.length > 0, tag + "the download is the private JWK (EC P-256 with d)");
      const publicJwk = JSON.parse(await form.locator("textarea[name=publicJwk]").inputValue());
      check(!("d" in publicJwk) && publicJwk.x === file.x && publicJwk.y === file.y, tag + "the textarea holds the matching public JWK, without d");
      await page.locator("#integration-submit").click();
      await integration(page, "Smoke app").waitFor({ timeout: 8000 });
      const body = JSON.parse(sentBodies.at(-1) || "{}");
      check(sentBodies.length === 1 && body.publicJwk && !("d" in body.publicJwk) && !JSON.stringify(body).includes(file.d) && !/"d"\s*:/.test(sentBodies[0]), tag + "the request to /api/integrations has no \"d\" member");
      check(JSON.stringify(body.scopes) === JSON.stringify(SCOPES), tag + "the request carries the chosen scopes");
      check((await badgeOf(page, "Smoke app")) === "Awaiting approval in Astation", tag + "the new integration awaits approval");
      check(await form.isHidden() && await form.locator(".key-download a").count() === 0, tag + "the form closes and the key link is gone");
      check(await page.evaluate(() => document.activeElement?.id) === "integration-add", tag + "focus returns to Create integration after creating");
      await page.locator("#integration-add").press("Enter");
      await form.waitFor({ state: "visible" });
      await form.getByRole("button", { name: "Cancel" }).focus();
      await page.keyboard.press("Enter");
      await form.waitFor({ state: "hidden" });
      check(await page.evaluate(() => document.activeElement?.id) === "integration-add", tag + "Cancel closes the form and focus returns to Create integration");
    });

    await step(tag + "actions", async () => {
      const row = () => integration(page, "Release bot");
      await row().getByRole("button", { name: "Pause", exact: true }).click();
      await until(async () => (await badgeOf(page, "Release bot")) === "Paused", "Paused");
      check(true, tag + "Pause shows \"Paused\"");
      await row().getByRole("button", { name: "Resume", exact: true }).click();
      await until(async () => (await badgeOf(page, "Release bot")) === "Ready", "Ready");
      check(true, tag + "Resume shows \"Ready\" again");
      const expiresBefore = await row().locator(".integration-facts").innerText();
      const renew = row().locator("details", { has: page.locator("summary", { hasText: /^Renew$/ }) });
      await renew.locator("summary").click();
      await renew.locator("input").fill("60");
      await renew.getByRole("button", { name: "Renew" }).click();
      await until(async () => (await row().locator(".integration-facts").innerText()) !== expiresBefore, "the new expiry");
      check(true, tag + "Renew for 60 days changes the expiry");
      const quota = row().locator("details", { has: page.locator("summary", { hasText: /^Quota$/ }) });
      await quota.locator("summary").click();
      await quota.locator("input").fill("500");
      await quota.getByRole("button", { name: "Save quota" }).click();
      await until(async () => /500 token requests \/ s/.test(await row().locator(".integration-facts").innerText()), "the new quota");
      check(true, tag + "Quota 500 shows \"500 token requests / s\"");
      const quotaBad = row().locator("details", { has: page.locator("summary", { hasText: /^Quota$/ }) });
      await quotaBad.locator("summary").click();
      await quotaBad.locator("input").fill("0");
      await quotaBad.getByRole("button", { name: "Save quota" }).click();
      check((await quotaBad.locator(".form-note").textContent()) === "Choose a whole number from 1 to 10000.", tag + "an out-of-range quota is refused with a readable message");
      const rotate = row().locator("details", { has: page.locator("summary", { hasText: /^Rotate key$/ }) });
      await rotate.locator("summary").click();
      await rotate.getByRole("button", { name: "Generate a key pair in this browser" }).click();
      const link = rotate.locator(".key-download a");
      await link.waitFor({ timeout: 5000 });
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      check(download.suggestedFilename() === "release-bot.private.jwk.json", tag + "Rotate key downloads release-bot.private.jwk.json");
      await overflowCheck(page, tag, "with the action panels open");
      await shot(row(), viewport.name + "-integration-actions");
      await rotate.getByRole("button", { name: "Add key" }).click();
      await rotate.locator(".form-note").filter({ hasText: /New key added/ }).waitFor({ timeout: 8000 });
      check(true, tag + "Add key reports \"" + (await rotate.locator("form > .form-note").textContent()) + "\"");
      await row().getByRole("button", { name: "History" }).click();
      const history = page.locator("#integration-history");
      await history.locator("#integration-events li").first().waitFor({ timeout: 5000 });
      const kinds = await history.locator("#integration-events strong").allTextContents();
      check(await history.isVisible() && kinds.length >= 5, tag + "History lists the events (" + kinds.join(", ") + ")");
      await overflowCheck(page, tag, "with History open");
      await shot(page, viewport.name + "-history");
      await history.getByRole("button", { name: "Close integration history" }).click();
      check(await history.isHidden(), tag + "History closes with its close button");
      await integration(page, "Ops agent").getByRole("button", { name: "Revoke" }).click();
      const confirm = page.locator("#integration-confirm");
      await confirm.waitFor({ state: "visible" });
      check((await confirm.locator("h2").textContent()) === "Revoke Ops agent?", tag + "Revoke asks for confirmation");
      await shot(page, viewport.name + "-revoke-confirm");
      await confirm.getByRole("button", { name: "Revoke integration" }).click();
      await until(async () => (await badgeOf(page, "Ops agent")) === "Revoked", "Revoked");
      check(await integration(page, "Ops agent").getByRole("button", { name: "Revoke" }).count() === 0, tag + "confirmed Revoke shows \"Revoked\" and the button goes");
    });

    await step(tag + "keyboard", async () => {
      await page.goto(stack.site + "/account/");
      await page.locator("#integration-list .integration-item").nth(3).waitFor({ timeout: 8000 });
      // The sequential focus starting point: the Stations heading, just before "Add Station".
      await page.locator("#stations-title").click();
      const order = [];
      const missing = [];
      let previous = null;
      const inSections = () => page.evaluate(() => Boolean(document.activeElement?.closest("#stations, #integrations")));
      for (let presses = 0; presses < 220; presses += 1) {
        await page.keyboard.press("Tab");
        if (previous) {
          const { handle, focused, label } = previous;
          if (await handle.evaluate((node) => node.isConnected)) {
            const unfocused = await ring(handle);
            if (unfocused === focused) missing.push(label);
          }
        }
        if (!(await inSections())) { if (order.length) break; continue; }
        const handle = await page.evaluateHandle(() => document.activeElement);
        const aria = await focusedAria(page);
        const named = /"[^"]+"/.test(aria) || /: .+/.test(aria);
        const label = aria || await handle.evaluate((node) => node.tagName.toLowerCase());
        if (!named) missing.push(label + " (no accessible name)");
        order.push(label);
        previous = { handle, focused: await ring(handle), label };
        const kind = await handle.evaluate((node) => [node.tagName, node.id, node.parentElement?.open]);
        // Enter opens the forms and the closed panels, so their controls join the order.
        if ((kind[0] === "SUMMARY" && !kind[2]) || ["station-add", "integration-add"].includes(kind[1])) {
          await page.keyboard.press("Enter");
          if (kind[0] !== "SUMMARY") {
            const opened = await page.evaluate(() => [document.activeElement?.name, document.activeElement?.closest("form")?.id]);
            check(Boolean(opened[1]), tag + "Enter on " + label + " opens its form and focuses " + opened[0]);
            const handle2 = await page.evaluateHandle(() => document.activeElement);
            const label2 = await focusedAria(page);
            order.push(label2);
            previous = { handle: handle2, focused: await ring(handle2), label: label2 };
          } else {
            check(await handle.evaluate((node) => node.parentElement.open), tag + "Enter on " + label + " opens its panel");
          }
        }
      }
      note(tag + "tab order (" + order.length + "): " + order.join(" → "));
      check(order.length > 20, tag + "Tab walks the two sections (" + order.length + " stops)");
      check(!missing.length, tag + "every stop has a visible focus indicator and an accessible name" + (missing.length ? " (missing: " + missing.join("; ") + ")" : ""));
      const expected = ["Add Station", "Details", "Remove Station", "Members and sharing", "Create integration", "Pause", "Resume", "Revoke", "History", "Renew", "Quota", "Rotate key", "Generate a key pair in this browser", "Share"];
      const absent = expected.filter((name) => !order.some((stop) => stop.includes("\"" + name + "\"") || stop.includes(name)));
      check(!absent.length, tag + "every kind of control is reachable by Tab" + (absent.length ? " (not reached: " + absent.join(", ") + ")" : ""));
      await shot(page, viewport.name + "-keyboard-open");
      await overflowCheck(page, tag, "with every panel open");

      // Space opens History; the modal keeps focus; Escape closes it and focus returns to the opener.
      const historyButton = integration(page, "Release bot").getByRole("button", { name: "History" });
      await historyButton.focus();
      await page.keyboard.press("Space");
      const history = page.locator("#integration-history");
      await history.waitFor({ state: "visible", timeout: 3000 });
      check(true, tag + "Space activates History");
      // A modal <dialog> makes the rest of the page inert: Tab cycles through its controls and, past the last one, may
      // pass through the browser's own UI (activeElement is then <body>), but never reaches the page behind it.
      const trapped = async (dialog) => {
        const stops = [];
        for (let presses = 0; presses < 8; presses += 1) {
          await page.keyboard.press("Tab");
          const [inside, name] = await page.evaluate((id) => [document.querySelector("#" + id).contains(document.activeElement), document.activeElement === document.body ? "(browser UI)" : (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent.trim())], dialog);
          stops.push(name);
          if (!inside && name !== "(browser UI)") { note(tag + dialog + " Tab order: " + stops.join(" → ")); return false; }
        }
        note(tag + dialog + " Tab order: " + stops.join(" → "));
        return stops.filter((name) => name !== "(browser UI)").length >= 4;
      };
      check(await trapped("integration-history"), tag + "Tab stays inside the History dialog");
      await page.keyboard.press("Escape");
      check(await history.isHidden(), tag + "Escape closes History");
      check(await historyButton.evaluate((node) => node === document.activeElement), tag + "focus returns to History after Escape");

      await page.evaluate(() => { window.__log = []; const d = document.querySelector("#integration-confirm"); d.addEventListener("close", () => window.__log.push("close:" + d.returnValue)); d.addEventListener("cancel", () => window.__log.push("cancel")); document.addEventListener("click", (e) => window.__log.push("click:" + (e.target.textContent || "").trim().slice(0, 20)), true); document.addEventListener("keydown", (e) => window.__log.push("keydown:" + e.key + "@" + (document.activeElement.textContent || "").trim().slice(0, 20)), true); });
      const revoke = integration(page, "Night shift").getByRole("button", { name: "Revoke" });
      await revoke.focus();
      await page.keyboard.press("Enter");
      const confirm = page.locator("#integration-confirm");
      await confirm.waitFor({ state: "visible", timeout: 3000 });
      check(true, tag + "Enter activates Revoke and opens the confirmation");
      check(await trapped("integration-confirm"), tag + "Tab stays inside the confirmation dialog");
      await page.keyboard.press("Escape");
      check(await confirm.isHidden() && (await badgeOf(page, "Night shift")) === "Paused", tag + "Escape closes the confirmation without revoking");
      const back = await page.evaluate(() => [document.activeElement?.tagName, (document.activeElement?.textContent || "").trim().slice(0, 40)]);
      check(await revoke.evaluate((node) => node === document.activeElement), tag + "focus returns to Revoke after Escape (now on " + back.join(" ") + ")");
      await revoke.focus();
      await page.keyboard.press("Enter");
      await confirm.waitFor({ state: "visible", timeout: 3000 });
      const ok = confirm.getByRole("button", { name: "Revoke integration" });
      for (let presses = 0; presses < 4 && !(await ok.evaluate((node) => node === document.activeElement)); presses += 1) await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      // A paused integration is revoked through "Revoking" until its Station confirms (only one still awaiting approval
      // is revoked at once).
      const answers = [];
      const listen = (response) => { if (/\/revoke$/.test(new URL(response.url()).pathname)) answers.push(response.status()); };
      page.on("response", listen);
      await until(async () => (await badgeOf(page, "Night shift")) === "Revoking", "Revoking by keyboard").catch(async (error) => {
        throw new Error(error.message + " (revoke answered " + JSON.stringify(answers) + "; row says \"" + await integration(page, "Night shift").locator(".agora-project-actions + .form-note").textContent() + "\") " + JSON.stringify(await page.evaluate(() => window.__log)));
      });
      page.off("response", listen);
      check(true, tag + "Tab to \"Revoke integration\" and Enter revokes (Revoking)");
      const after = await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.textContent, document.activeElement?.closest("[data-row]")?.querySelector("h3")?.textContent]);
      check(after[0] === "BUTTON" && after[2] === "Night shift", tag + "after revoking, focus moves to the re-rendered row (" + after[1] + " on " + after[2] + ")");
      await integration(page, "Release bot").getByRole("button", { name: "Pause", exact: true }).focus();
      await page.keyboard.press("Enter");
      await until(async () => (await badgeOf(page, "Release bot")) === "Paused", "Paused by keyboard");
      const resumed = await page.evaluate(() => [document.activeElement?.textContent, document.activeElement?.closest("[data-row]")?.querySelector("h3")?.textContent]);
      check(resumed[0] === "Resume" && resumed[1] === "Release bot", tag + "Enter on Pause pauses, and focus lands on the new row's Resume (" + resumed.join(" on ") + ")");
    });

    await step(tag + "reduced motion", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const moving = await page.evaluate(() => {
        const seconds = (value) => Math.max(...value.split(",").map((part) => part.trim().endsWith("ms") ? parseFloat(part) / 1000 : parseFloat(part)));
        const nodes = [...document.querySelectorAll("#stations, #stations *, #integrations, #integrations *, #integration-confirm, #integration-confirm *, #integration-history, #integration-history *")];
        return nodes.filter((node) => { const style = getComputedStyle(node); return seconds(style.transitionDuration) > 0.01 || style.animationName !== "none"; }).map((node) => node.tagName.toLowerCase() + (node.className ? "." + String(node.className).split(" ")[0] : ""));
      });
      check(!moving.length, tag + "with reduced motion nothing in the sections or dialogs animates" + (moving.length ? " (" + [...new Set(moving)].join(", ") + ")" : ""));
      await page.emulateMedia({ reducedMotion: "no-preference" });
    });

    check(!errors.length, tag + "no console errors" + (errors.length ? " (" + errors.join("; ") + ")" : ""));
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  for (const [index, viewport] of VIEWPORTS.entries()) {
    console.log("-- " + viewport.name + " " + viewport.width + "×" + viewport.height);
    await step(viewport.name + ": set up", () => flow(viewport, index));
  }
} finally {
  await browser?.close();
  for (const stub of stubs) await stub.close();
  await stack.close();
}

if (failures.length) {
  console.error(failures.length + " check(s) failed.");
  process.exit(1);
}
console.log("All integrations browser checks passed.");
