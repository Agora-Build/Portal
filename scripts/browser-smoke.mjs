// Drives a real headless Chromium through the Portal's sign-in with auth.agora.build (spec §5, browser smoke). Not part
// of `npm test`, and no dependency of this package: point it at an existing playwright-core install and Chromium
// binary.
//
// It runs against the end-to-end stack (tests/e2e/harness.mjs): the real auth.agora.build from an Agora-Build/Auth
// checkout, with its stand-in GitHub, and the real Portal server, both on free local ports. The local deployment's
// real GitHub and Google sign-in can't be automated, so this is where a browser can complete the IdP page. Needs
// Node 22, the Auth checkout (AUTH_REPO, default ../Auth) and TEST_DATABASE_URL, as `npm run test:e2e` does.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM_PATH=/path/to/chrome \
//     TEST_DATABASE_URL=postgres://… node scripts/browser-smoke.mjs
//
// At a desktop (1280×800) and a mobile (390×844) viewport it checks: one keyboard-reachable "Sign in" on the home
// page; signing in through the IdP page and back; the account page (name, Manage sign-in, credits); a guest's sign-in
// prompts; the account page when /api/auth/config fails; and signing out of the Portal and the IdP.
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { loadAuth, person, skipReason, startStack } from "../tests/e2e/harness.mjs";

const { PLAYWRIGHT_CORE: playwrightPath, CHROMIUM_PATH: chromiumPath } = process.env;
if (!playwrightPath || !chromiumPath) {
  console.error("Set PLAYWRIGHT_CORE (a playwright-core directory) and CHROMIUM_PATH (a Chromium or Chrome binary).");
  process.exit(2);
}
const skip = await skipReason();
if (skip) {
  console.error("The browser smoke can't run: " + skip + ".");
  process.exit(2);
}
// playwright-core is CommonJS; require resolves a package directory as well as a file.
const { chromium } = createRequire(import.meta.url)(isAbsolute(playwrightPath) ? playwrightPath : resolve(playwrightPath));

const failures = [];
const check = (ok, message) => {
  console.log((ok ? "ok      " : "FAILED  ") + message);
  if (!ok) failures.push(message);
  return ok;
};
// Runs one step; an exception fails it (with the reason and where the page was, without its query) instead of ending
// the whole run.
async function step(label, run, page) {
  try { await run(); }
  catch (error) {
    let at = "";
    try { const url = new URL(page.url()); at = " (page at " + url.origin + url.pathname.replace(/\/interaction\/[^/]+/, "/interaction/<uid>") + ")"; } catch {}
    check(false, label + ": " + String(error?.message || error).split("\n")[0] + at);
  }
}

const VIEWPORTS = [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }];
const ACCOUNT_ID = /^acct_[0-9A-HJKMNP-TV-Z]{26}$/;

const lib = await loadAuth();
const stack = await startStack(lib);
// Launched inside the try below, so a failed launch still stops the stack.
let browser = null;
console.log("        Portal " + stack.site + ", IdP " + stack.issuer);

// A browser context that reaches only the Portal and the IdP; any other origin (GitHub, fonts, avatars) is refused.
// The IdP's "Continue with GitHub" answers with a redirect to GitHub. A browser follows redirects without asking the
// route again, so that one POST is fetched here and its redirect is pointed at Auth's stand-in GitHub, which
// approves as `user` and sends the browser straight back to the IdP's callback.
const UPSTREAM_GITHUB = /^\/interaction\/[^/]+\/upstream\/github$/;
async function newContext(viewport, user) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.name === "mobile", hasTouch: viewport.name === "mobile" });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === stack.issuer && user && route.request().method() === "POST" && UPSTREAM_GITHUB.test(url.pathname)) {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers().location;
      if (!location || new URL(location, url).origin !== "https://github.com") return route.fulfill({ response });
      return route.fulfill({ response, headers: { ...response.headers(), location: stack.idp.fake.approve(new URL(location, url).href, user) } });
    }
    if (url.origin === stack.site || url.origin === stack.issuer) return route.continue();
    return route.abort();
  });
  return context;
}
const me = (page) => page.evaluate(() => fetch("/api/me", { headers: { Accept: "application/json" } }).then((response) => response.json()));
// Presses Tab until `locator` has focus (at most `limit` presses); true if it did.
async function tabTo(page, locator, limit = 60) {
  for (let presses = 0; presses < limit; presses += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((node) => node === document.activeElement).catch(() => false)) return true;
  }
  return false;
}
// The home page's sign-in: Tab to "Take a seat", Enter opens the sign-in dialog, Tab to its one "Sign in", Enter.
async function keyboardSignIn(page, tag) {
  await page.goto(stack.site + "/");
  const seat = page.locator(".header-actions [data-join]");
  check(await tabTo(page, seat), tag + "Tab reaches \"Take a seat\" on the home page");
  await page.keyboard.press("Enter");
  const dialog = page.locator("#login-dialog");
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  await page.locator(".login-status").filter({ hasNotText: "Checking sign-in" }).waitFor({ timeout: 5000 });
  const signIns = page.getByRole("link", { name: "Sign in", exact: true }).or(page.getByRole("button", { name: "Sign in", exact: true }));
  const visible = [];
  for (const control of await signIns.all()) if (await control.isVisible()) visible.push(control);
  check(visible.length === 1, tag + "the sign-in dialog shows one \"Sign in\" control (" + visible.length + ")");
  check(await page.getByRole("button", { name: "Continue with this browser" }).isVisible(), tag + "the dialog offers \"Continue with this browser\"");
  const signIn = dialog.locator(".login-start");
  check(await tabTo(page, signIn, 15), tag + "Tab reaches \"Sign in\" in the dialog");
  await page.keyboard.press("Enter");
}

async function signInFlow(viewport) {
  const tag = viewport.name + ": ";
  // A GitHub login is one word, and person() derives it from the name.
  const user = person(viewport.name === "desktop" ? 7101 : 7102, viewport.name === "desktop" ? "Grace" : "Mary");
  const context = await newContext(viewport, user);
  const page = await context.newPage();
  try {
    await step(tag + "sign in", async () => {
      await keyboardSignIn(page, tag);
      await page.waitForURL((url) => url.origin === stack.issuer && url.pathname.startsWith("/interaction/"), { timeout: 10000 });
      check(true, tag + "\"Sign in\" opens the auth.agora.build sign-in page (" + new URL(page.url()).pathname.replace(/\/interaction\/[^/]+/, "/interaction/<uid>") + ")");
      // The portal client is first-party, so the IdP asks no consent: the stand-in GitHub approves and the IdP sends
      // the browser straight back to the Portal.
      const back = page.waitForURL((url) => url.origin === stack.site, { timeout: 10000 });
      await page.getByRole("button", { name: "Continue with GitHub" }).click();
      await back;
      check(new URL(page.url()).origin === stack.site, tag + "the IdP returns the browser to the Portal (" + new URL(page.url()).pathname + ")");
      const session = await me(page);
      check(ACCOUNT_ID.test(session.account?.id || "") && session.account?.name === user.name, tag + "/api/me shows the signed-in account acct_… with its name");
      await page.locator("#toast").filter({ hasText: /./ }).waitFor({ timeout: 3000 }).catch(() => {});
      check(!new URL(page.url()).searchParams.has("signin"), tag + "the Portal removes ?signin= from the address");
    }, page);

    await step(tag + "account page", async () => {
      await page.goto(stack.site + "/account.html");
      const name = page.locator("#account-identity h3");
      await name.waitFor({ timeout: 5000 });
      check((await name.textContent()) === user.name, tag + "the account page shows the account's name");
      check(ACCOUNT_ID.test((await page.locator("#account-identity .account-user-id").textContent()) || ""), tag + "the account page shows the account ID");
      const manage = page.getByRole("link", { name: /Manage sign-in/ });
      check(await manage.isVisible() && (await manage.getAttribute("href")) === stack.issuer + "/account", tag + "\"Manage sign-in\" links to " + stack.issuer + "/account");
      await page.locator("#credit-balance").filter({ hasNotText: "--" }).waitFor({ timeout: 5000 });
      check(await page.getByRole("heading", { name: "Credits for the work." }).isVisible() && /^\d[\d,]*$/.test((await page.locator("#credit-balance").textContent()) || ""), tag + "the credits section shows a balance");
      check(await tabTo(page, page.locator("#account-logout")), tag + "Tab reaches \"Sign out\" on the account page");
    }, page);

    await step(tag + "sign-in config fails", async () => {
      // Regression (Task 5): if /api/auth/config fails, the account page still loads, without "Manage sign-in".
      const second = await context.newPage();
      await second.route("**/api/auth/config", (route) => route.abort());
      await second.goto(stack.site + "/account.html");
      const name = second.locator("#account-identity h3");
      const loaded = await name.waitFor({ timeout: 5000 }).then(() => true, () => false);
      check(loaded && (await name.textContent()) === user.name, tag + "with /api/auth/config blocked, the account page still loads the account");
      check(loaded && !(await second.locator("#manage-signin").isVisible()), tag + "with /api/auth/config blocked, \"Manage sign-in\" is hidden");
      check(!/Loading your account/.test((await second.locator("#account-status").textContent()) || ""), tag + "with /api/auth/config blocked, the status line settles");
      await second.close();
    }, page);

    await step(tag + "sign out", async () => {
      await page.goto(stack.site + "/account.html");
      await page.locator("#account-identity h3").waitFor({ timeout: 5000 });
      await page.locator("#account-logout").focus();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.origin === stack.issuer, { timeout: 10000 });
      check(new URL(page.url()).pathname.startsWith("/logout") || new URL(page.url()).pathname.startsWith("/session/end"), tag + "\"Sign out\" goes to the IdP's sign-out page (" + new URL(page.url()).pathname + ")");
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.waitForURL((url) => url.origin === stack.site, { timeout: 10000 });
      check(page.url() === stack.site + "/", tag + "the IdP returns to the Portal home (" + new URL(page.url()).pathname + ")");
      check((await me(page)).account === null, tag + "the Portal is signed out (/api/me has no account)");
      await page.goto(stack.issuer + "/account");
      check(await page.getByRole("button", { name: "Sign in" }).isVisible() && !(await page.getByText(user.name).count()), tag + "the IdP session is gone (its account page asks to sign in)");
    }, page);
  } finally {
    await context.close();
  }
}

async function guestFlow(viewport) {
  const tag = viewport.name + " guest: ";
  const context = await newContext(viewport, null);
  const page = await context.newPage();
  try {
    await step(tag + "continue with this browser", async () => {
      await page.goto(stack.site + "/");
      await page.locator(".header-actions [data-join]").click();
      await page.locator(".login-status").filter({ hasNotText: "Checking sign-in" }).waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: "Continue with this browser" }).click();
      const form = page.locator("#profile-form");
      await form.waitFor({ state: "visible", timeout: 5000 });
      await form.locator("[name=name]").fill("Smoke Guest");
      await form.locator("[name=bio]").fill("Checking the Portal in a real browser.");
      await form.locator("[name=intent]").fill("Make sure guests see where to sign in.");
      await form.locator("[name=skills]").fill("testing");
      await form.locator("[name=contact]").fill("https://example.com/smoke-guest");
      await page.locator("#profile-submit").click();
      await form.waitFor({ state: "hidden", timeout: 5000 });
      const session = await me(page);
      check(Boolean(session.profile) && session.account === null, tag + "\"Continue with this browser\" makes a guest profile without an account");
    }, page);
    await step(tag + "services", async () => {
      await page.goto(stack.site + "/services.html");
      const notes = page.locator(".service-note");
      await notes.first().filter({ hasText: "Sign in to use credits." }).waitFor({ timeout: 5000 });
      check((await notes.allTextContents()).every((text) => text === "Sign in to use credits."), tag + "the services page says \"Sign in to use credits.\"");
    }, page);
    await step(tag + "account", async () => {
      await page.goto(stack.site + "/account.html");
      await page.locator("#credit-statement").filter({ hasText: "Sign in to see your credit statement." }).waitFor({ timeout: 5000 });
      check(true, tag + "the account page says \"Sign in to see your credit statement.\"");
      check((await page.locator("#credit-balance").textContent()) === "--", tag + "the account page shows no balance");
      check(await page.locator("#account-login").isVisible() && !(await page.locator("#manage-signin").isVisible()), tag + "the account page offers \"Sign in\" and no \"Manage sign-in\"");
      check(await tabTo(page, page.locator("#account-login")), tag + "Tab reaches \"Sign in\" on the account page");
    }, page);
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  for (const viewport of VIEWPORTS) {
    console.log("-- " + viewport.name + " " + viewport.width + "×" + viewport.height);
    await signInFlow(viewport);
    await guestFlow(viewport);
  }
} finally {
  await browser?.close();
  await stack.close();
}

if (failures.length) {
  console.error(failures.length + " check(s) failed.");
  process.exit(1);
}
console.log("All browser checks passed.");
