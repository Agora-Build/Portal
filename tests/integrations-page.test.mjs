import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createAppServer } from "../scripts/serve.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";

const root = new URL("../", import.meta.url).pathname;
const read = (name) => readFile(resolve(root, name), "utf8");
const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });

async function served(t) {
  const temporary = await mkdtemp(resolve(tmpdir(), "agora-integrations-page-"));
  const instance = createAppServer(root, { monitor: false, storageFile: resolve(temporary, "store.json"), models: createModelClient(modelConfig({})), calls: createAgoraCalls(agoraConfig({})), idp: null });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  t.after(async () => { await close(instance); await rm(temporary, { recursive: true, force: true }); });
  return "http://127.0.0.1:" + instance.address().port;
}

test("/account/ carries the Stations and Integrations sections, hidden by default, with accessible names", async (t) => {
  const html = await (await fetch((await served(t)) + "/account/")).text();
  const stations = html.match(/<section id="stations"[^>]*>/)?.[0] || "";
  const integrations = html.match(/<section id="integrations"[^>]*>/)?.[0] || "";
  assert.match(stations, /class="membership-section"/);
  assert.match(stations, /aria-labelledby="stations-title"/);
  assert.match(stations, /\shidden[\s>]/);
  assert.match(integrations, /aria-labelledby="integrations-title"/);
  assert.match(integrations, /\shidden[\s>]/);
  assert.match(html, /06 \/ STATIONS/);
  assert.match(html, /<h2 id="stations-title">Your relays and Stations\.<\/h2>/);
  assert.match(html, /07 \/ INTEGRATIONS/);
  assert.match(html, /<h2 id="integrations-title">Apps that act for you\.<\/h2>/);
  assert.match(html, /08 \/ STATEMENT/);
  assert.doesNotMatch(html, /06 \/ STATEMENT/);
  const order = ["05 / CONNECTIONS", "06 / STATIONS", "07 / INTEGRATIONS", "08 / STATEMENT"].map((part) => html.indexOf(part));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /<script type="module" src="\/integrations\.js"><\/script>/);
  const dialogs = html.match(/<dialog id="(station|integration)-[^"]*"[^>]*>/g) || [];
  assert.ok(dialogs.length);
  for (const dialog of dialogs) assert.match(dialog, /aria-labelledby="/, dialog);
});

test("/integrations.js is served as JavaScript", async (t) => {
  const response = await fetch((await served(t)) + "/integrations.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/javascript/);
  assert.equal(await response.text(), await read("integrations.js"));
});

test("the script generates keys in the browser and never stores or logs the private key", async () => {
  const script = await read("integrations.js");
  assert.match(script, /crypto\.subtle\.generateKey\(\{ name: "ECDSA", namedCurve: "P-256" \}, true, \["sign", "verify"\]\)/);
  assert.match(script, /\.private\.jwk\.json/);
  assert.match(script, /URL\.revokeObjectURL/);
  // Re-rendering or hiding the integration rows first releases any private-key URL their key fields still hold.
  assert.equal((script.match(/releaseRotateKeys\(\);\n\s*(document\.querySelector\("#integration-list"\)|list)\.replaceChildren\(/g) || []).length, 3);
  assert.match(script, /panel\.addEventListener\("toggle", \(\) => \{ if \(!panel\.open\) key\.reset\(\); \}\)/, "closing a rotate panel releases its key");
  assert.match(script, /Agora\.Build never receives this file\. Keep it with your app\./);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.doesNotMatch(script, /console\./);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /credentials: "same-origin"/);
  assert.match(script, /mode: "cors", credentials: "omit"/);
  assert.match(script, /This Station does not offer details yet\./);
  assert.match(script, /integrationsAvailable/);
  for (const label of ["Awaiting approval in Astation", "Provisioning", "Waiting for host", "Ready", "Paused", "Expired", "Revoking", "Revoked"]) assert.match(script, new RegExp("\"" + label + "\""), label);
  assert.match(script, /Showing saved details; Auth could not be reached\./);
});

test("the build copies integrations.js and the server lists it as public", async () => {
  assert.match(await read("scripts/build.mjs"), /"account\.js", "integrations\.js"/);
  assert.match(await read("scripts/serve.mjs"), /"account\.js", "integrations\.js"/);
  assert.match(await read("tests/server.test.mjs"), /"account\.js", "integrations\.js"/);
});

test("confirmations ask before the action runs, so the opener stays enabled and gets focus back", async () => {
  const script = await read("integrations.js");
  // A button disabled while its <dialog> is open can't take focus back when the dialog closes (Escape or Keep it).
  assert.doesNotMatch(script, /act\([^\n]*\n?\s*if \(!await confirmAction/);
  assert.equal((script.match(/confirmed\(\w+, output, \[/g) || []).length, 4, "Remove member, Remove Station, Leave and Revoke confirm first");
  // After the rows re-render, focus that was on the action's button moves to the same control of the new row.
  assert.match(script, /data-row/);
  assert.match(script, /function restoreFocus\(button, row\)/);
});

test("a failed Station check drops the used value so the form asks for a new one", async () => {
  const script = await read("integrations.js");
  // The Portal spends the check value before it fetches the proof; only a refused report key leaves it unused.
  assert.match(script, /if \(error\.code !== "report_key"\) \{ resetChallenge\(\{ keepKey: true \}\);/);
  assert.match(script, /Get a new check value and try again\./);
});

test("closing a form that held focus hands it back to the button that opened it", async () => {
  const script = await read("integrations.js");
  assert.match(script, /else if \(form\.contains\(document\.activeElement\) \|\| document\.activeElement === document\.body\) opener\.focus\(\);/);
  // A hidden button is still connected; focus goes back to it only when it is rendered.
  assert.match(script, /button\.isConnected && button\.getClientRects\(\)\.length/);
});

test("the built-in Station shows as Built in with Details only, and is offered for integrations only while enabled", async () => {
  const script = await read("integrations.js");
  assert.match(script, /if \(station\.builtIn\) return builtInRow\(station\);/);
  const row = script.slice(script.indexOf("function builtInRow("), script.indexOf("function stationRow("));
  assert.ok(row.length > 0, "builtInRow comes right before stationRow");
  assert.match(row, /text: "Built in"/);
  assert.match(row, /text: "Details"/);
  assert.doesNotMatch(row, /Remove|Share|Leave|membersPanel|confirmed\(/);
  assert.match(script, /\(!station\.builtIn \|\| station\.integrationsEnabled\)/);
  assert.match(script, /Integrations aren't available on the built-in Station yet\. Add your own Station to create one\./);
  assert.doesNotMatch(script, /station_admin|As an Agora\.Build admin/, "admins act on the admin site, never here (D26)");
  assert.match(await read("account.html"), /Every account has the built-in Agora Station/);
  assert.match(await read("styles.css"), /\.state-badge--built-in \{/);
});

test("an integration Agora.Build paused shows Paused by Agora.Build, offers no Resume, and its history names Agora.Build", async () => {
  const script = await read("integrations.js");
  assert.match(script, /const PAUSED_BY_AGORA = "Paused by Agora\.Build";/);
  assert.match(script, /const locked = state === "paused" && integration\.pausedBy === "admin";/);
  assert.match(script, /if \(owner && state === "paused" && !locked\) \{/);
  assert.match(script, /text: locked \? PAUSED_BY_AGORA : stateLabel\(state\)/);
  assert.match(script, /Agora\.Build paused this integration\. Only Agora\.Build can resume it; you can still revoke it\./);
  // A resume refused because Agora.Build paused it meanwhile says so and shows the list as it is now.
  assert.match(script, /if \(error\.code !== "admin_paused"\) throw error;/);
  assert.match(script, /entry\.actor === "agora_build" \? "Agora\.Build" : entry\.actor/);
  assert.equal((script.match(/confirmed\(\w+, output, \[/g) || []).length, 4, "no new confirmation");
});
