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
