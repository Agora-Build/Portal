import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (name) => readFile(new URL("../" + name, import.meta.url), "utf8");
const files = ["index.html", "explore.html", "account.html", "marketplaces.html", "radar.html", "stoa.html", "script.js", "account.js", "marketplaces.js", "stoa.js", "stoa/panel.js", "styles.css"];
const removed = [/auth\/providers/, /pending-link/, /confirmLink|confirmConnect/, /confirm-link|confirm-connect|link-mismatch|link-expired/, /logout-all|logout-everywhere/, /login-provider/, /Logins:/, /account\.providers|account\.emails/, /Connect a login/];

test("pages and scripts carry no provider buttons, link dialogs, or logout-all", async () => {
  for (const file of files) {
    const source = await read(file);
    for (const pattern of removed) assert.doesNotMatch(source, pattern, file + " " + pattern);
  }
});
test("sign-in is one step: no modal anywhere, and every Sign in goes to /auth/login with returnTo", async () => {
  for (const file of files) {
    const source = await read(file);
    for (const pattern of [/login-dialog|loginDialog|openSignIn|login-start|login-status|login-guest|login-note/]) assert.doesNotMatch(source, pattern, file + " " + pattern);
  }
  const script = await read("script.js");
  assert.match(script, /export const signInHref = \(\) => "\/auth\/login\?returnTo=" \+ encodeURIComponent\(returnTarget\(\)\)/);
  assert.match(script, /export const seatHref = \(\) => "\/account\/\?returnTo=" \+ encodeURIComponent\(location\.pathname \+ location\.search\)/);
  assert.match(script, /location\.assign\(signInHref\(\)\)/);
  assert.match(script, /link\.href = seat \? seatHref\(\) : signInHref\(\)/);
  assert.doesNotMatch(script, /innerHTML/);
  for (const file of ["marketplaces.js", "stoa.js", "account.js"]) assert.match(await read(file), /signIn\(\)/, file);
  const stoa = await read("stoa.html");
  assert.match(stoa, /<a class="button button-secondary button-small" id="stoa-signin-button" href="\/account\/" data-signin="seat">Sign in<\/a>/);
  assert.doesNotMatch(await read("stoa/panel.js"), /signin\(\)/);
  assert.match(await read("account.js"), /endSessionUrl/);
  assert.match(script, /Sign-in didn't complete\. Try again\./);
  assert.match(script, /result === "unavailable"/);
});
test("the account page links to Manage sign-in from /api/auth/config and reports Agora connect results", async () => {
  const html = await read("account.html");
  assert.match(html, /id="manage-signin"/);
  assert.match(html, /Manage sign-in/);
  const script = await read("account.js");
  assert.match(script, /authConfig\?\.accountUrl/);
  assert.match(script, /searchParams\.get\("connected"\)/);
  assert.match(await read("script.js"), /\/api\/auth\/config/);
});
test("guests are told to sign in for credits, services, and creating spaces", async () => {
  assert.match(await read("marketplaces.js"), /Sign in to use credits\./);
  assert.match(await read("stoa.js"), /state\.account \? spacesUi\.openCreate/);
});
test("the account page never waits on an event: a failed auth config still settles", async () => {
  const script = await read("script.js");
  assert.match(script, /export const authConfigReady = api\("\/api\/auth\/config"\)\.catch\(\(\) => \(\{ issuer: null, accountUrl: null \}\)\)/);
  const account = await read("account.js");
  assert.match(account, /await authConfigReady;/);
  assert.doesNotMatch(account + script, /house:authconfig/);
  assert.match(script, /signInUnavailable\(\)/);
  assert.match(script, /a\[data-signin\]\[aria-disabled=true\]/);
});
test("signed out, the account page's one identity card is the sign-in, with the guest choice", async () => {
  const html = await read("account.html");
  assert.doesNotMatch(html, /account-signin|signin-card|YOUR PLACE, ON EVERY DEVICE|A seat at the workbench|Sign in, or start with this browser/);
  const card = html.match(/<section class="account-card identity-card"[\s\S]*?<\/section>/)?.[0] || "";
  const order = ["01 / IDENTITY", "<h2 id=\"identity-title\">Your builder account.</h2>", "id=\"account-identity\"", "id=\"account-login\"", "id=\"account-guest\"", "id=\"signin-note\""].map((part) => card.indexOf(part));
  assert.ok(order.every((index) => index >= 0) && order.every((index, at) => !at || index > order[at - 1]), "kicker, heading, text, Sign in, Continue with this browser, note, in order: " + order);
  assert.match(card, /<a class="button" id="account-login" href="\/auth\/login" data-signin hidden>Sign in<\/a>/);
  assert.match(card, /<button class="inline-link signin-guest" id="account-guest" type="button" hidden>Continue with this browser<\/button>/);
  assert.match(card, /Browser-only profiles stay linked to this browser\. Sign in later to keep access\. Your email and sign-in identity are never published\./);
  assert.ok(html.indexOf("identity-card") < html.indexOf("credits-card") && html.indexOf('<div class="account-workbench">') < html.indexOf("identity-card"), "the card sits in the 01 slot beside the wallet");
  assert.equal((html.match(/id="account-login"/g) || []).length, 1, "one Sign in on the account page");
  assert.doesNotMatch(html, /<dialog id="login-dialog"/);
  const account = await read("account.js");
  assert.match(account, /One Agora\.Build account for your profile, services, subscription, and credits, on every device\. It stays separate from your public community profile\./);
  assert.match(account, /#account-login"\)\.hidden = Boolean\(account\)/);
  assert.match(account, /#account-guest"\)\.hidden = Boolean\(account \|\| profile\)/);
  assert.match(account, /openJoin\(back \? \(\) => location\.assign\(back\) : null, true\)/);
  assert.match(account, /samePath\(new URLSearchParams\(location\.search\)\.get\("returnTo"\)\)/);
  assert.doesNotMatch(account, /innerHTML/);
});
test("a guest's returnTo is only ever a same-site path", async () => {
  const script = await read("script.js");
  const source = script.match(/export const samePath = (.*);\n/)[1];
  const samePath = new Function("return " + source)();
  assert.equal(samePath("/stoa/"), "/stoa/");
  assert.equal(samePath("/explore/?q=voice"), "/explore/?q=voice");
  for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "evil", "", null, undefined]) assert.equal(samePath(bad), null, String(bad));
});
test("pages link to each other at clean /name/ URLs, never /name.html", async () => {
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /["'`]\/?(?:index|explore|services|marketplaces|radar|account|stoa)\.html/, file);
  }
  for (const file of ["index.html", "explore.html", "account.html", "marketplaces.html", "radar.html", "stoa.html"]) {
    const html = await read(file);
    assert.match(html, /<a href="\/explore\/"[^>]*>Projects<\/a>/, file);
    assert.match(html, /<a href="\/account\/"[^>]*>Account<\/a>/, file);
    assert.match(html, /<a href="\/marketplaces\/"[^>]*>Marketplaces<\/a>/, file);
    assert.doesNotMatch(html, /href="\/services\/"|>Services<\/a>/, file);
    for (const [, link] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) assert.ok(/^(\/|https:\/\/)/.test(link), file + " " + link + " is absolute");
  }
});
