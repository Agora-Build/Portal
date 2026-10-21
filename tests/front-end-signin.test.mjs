import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (name) => readFile(new URL("../" + name, import.meta.url), "utf8");
const files = ["index.html", "explore.html", "account.html", "services.html", "radar.html", "stoa.html", "script.js", "account.js", "services.js", "stoa.js", "stoa/panel.js", "styles.css"];
const removed = [/auth\/providers/, /pending-link/, /confirmLink|confirmConnect/, /confirm-link|confirm-connect|link-mismatch|link-expired/, /logout-all|logout-everywhere/, /login-provider/, /Logins:/, /account\.providers|account\.emails/, /Connect a login/];

test("pages and scripts carry no provider buttons, link dialogs, or logout-all", async () => {
  for (const file of files) {
    const source = await read(file);
    for (const pattern of removed) assert.doesNotMatch(source, pattern, file + " " + pattern);
  }
});
test("sign-in is one button that starts the auth.agora.build login by navigation", async () => {
  const script = await read("script.js");
  assert.match(script, /\/auth\/login/);
  assert.match(script, /location\.assign\(url\.href\)/);
  assert.match(script, /endSessionUrl/);
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
  assert.match(await read("services.js"), /Sign in to use credits\./);
  assert.match(await read("stoa.js"), /state\.account \? spacesUi\.openCreate/);
});
