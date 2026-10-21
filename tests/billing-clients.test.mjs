import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { billingClients, loadBillingClients, priceFor } from "../scripts/billing-clients.mjs";

let temp;
before(async () => { temp = await mkdtemp(resolve(tmpdir(), "billing-clients-")); });
after(() => rm(temp, { recursive: true, force: true }));

test("the example billing file is valid", () => {
  const logs = [];
  const clients = loadBillingClients(new URL("../config/billing-clients.example.json", import.meta.url).pathname, (line) => logs.push(line));
  assert.ok(clients.has("vox"));
  assert.deepEqual(logs, []);
});

test("prices are per client and service, units are bounded, and the charge is computed here", () => {
  const clients = billingClients({ vox: { services: { evaluation: { credits: 4, maxUnits: 10 } } } });
  assert.equal(priceFor(clients, "vox", "evaluation", undefined), 4);
  assert.equal(priceFor(clients, "vox", "evaluation", 10), 40);
  for (const units of [0, 11, 2.5, "3", -1, null]) assert.throws(() => priceFor(clients, "vox", "evaluation", units), { status: 422 }, String(units));
  assert.throws(() => priceFor(clients, "vox", "unknown", 1), { status: 422 });
  assert.throws(() => priceFor(clients, "Bad Name", "evaluation", 1), { status: 422 });
});

test("invalid registries are refused", () => {
  for (const value of [[], null, "x", { vox: {} }, { vox: { services: [] } }, { "Bad Client!": { services: {} } }, { vox: { services: { "Bad Service": { credits: 1, maxUnits: 1 } } } }, { vox: { services: { evaluation: { credits: 0, maxUnits: 1 } } } }, { vox: { services: { evaluation: { credits: 1, maxUnits: 0 } } } }, { vox: { services: { evaluation: { credits: 1.5, maxUnits: 1 } } } }, { vox: { services: { evaluation: { credits: 1e9, maxUnits: 1e9 } } } }]) assert.throws(() => billingClients(value), JSON.stringify(value));
});

test("a missing or invalid file disables billing and logs only the setting name", async () => {
  const logs = [];
  assert.equal(loadBillingClients("", (line) => logs.push(line)), null);
  assert.match(logs.pop(), /PORTAL_BILLING_FILE/);
  assert.equal(loadBillingClients(resolve(temp, "missing.json"), (line) => logs.push(line)), null);
  assert.match(logs.pop(), /PORTAL_BILLING_FILE/);
  const file = resolve(temp, "bad.json");
  await writeFile(file, '{"vox": {"services": {"evaluation": {"credits": "secret-looking-value", "maxUnits": 1}}}}');
  assert.equal(loadBillingClients(file, (line) => logs.push(line)), null);
  const line = logs.pop();
  assert.match(line, /PORTAL_BILLING_FILE/);
  assert.ok(!line.includes("secret-looking-value") && !line.includes(file));
});
