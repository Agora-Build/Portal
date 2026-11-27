// The example answers in docs/platform.md are the "test fixtures" the D29 contracts promise (Portal issues 40 and 41): each is
// a fenced block "json example:<name>". The binding report examples are sent to the service, and what it answers must be the
// answer the document shows. The others (the directory, the checkpoint, the account changes and the browser list's notices)
// carry ids and times, so they are held to the shape the service gives: the same keys in the same order, the same kind of
// value (null included), and the same value for the fields that are a fixed vocabulary. The D27 examples (the admin API's
// bindings, release request, answer and refusal, and the binding_released change) are held the same way; the release request
// is sent to the service on this test's built-in Station, and its refusal must be the one the document shows.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { createIntegrationService } from "../scripts/integrations/service.mjs";
import { fakeManage } from "./helpers/fake-manage.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const NAMES = [
  "directory", "directory-page", "directory-removing", "notices", "checkpoint", "checkpoint-custom", "account-changes",
  "binding-changed-request", "binding-changed-answer", "binding-version-error", "binding-attempt-request", "binding-attempt-answer",
  "admin-bindings", "admin-release-request", "admin-release-answer", "admin-release-error", "binding-released-change"
];
const FIXED = ["kind", "reason", "role", "status", "membership", "access", "state", "bindingState", "builtIn", "integrationsEnabled", "stale", "complete", "interruptRunning", "quotaPerSecond", "version", "name", "accountState"];
const document = readFileSync(new URL("../docs/platform.md", import.meta.url), "utf8");
const examples = Object.fromEntries([...document.matchAll(/^[ ]*```json example:([a-z-]+)\n([\s\S]*?)^[ ]*```$/gm)].map((match) => [match[1], JSON.parse(match[2])]));

const OWNER = "ab" + "0".repeat(25) + "1";
const MEMBER = "ab" + "0".repeat(25) + "2";
const OTHER = "ab" + "0".repeat(25) + "3";
const ADMIN = "ab" + "0".repeat(25) + "4";
const DISABLED = "ab" + "0".repeat(25) + "5";
const DISABLED_TOO = "ab" + "0".repeat(25) + "6";
const R9 = "a".repeat(64);
const publicJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });

const kindOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
function assertSameShape(doc, real, path) {
  assert.equal(kindOf(doc), kindOf(real), path + ": the kind of value");
  if (Array.isArray(doc)) {
    // A list of objects has the same entries; a list of strings (scopes, account IDs) only has to be a list.
    if (doc.some((entry) => kindOf(entry) === "object")) {
      assert.equal(doc.length, real.length, path + ": the number of entries");
      doc.forEach((entry, index) => assertSameShape(entry, real[index], path + "[" + index + "]"));
    }
  } else if (kindOf(doc) === "object") {
    assert.deepEqual(Object.keys(doc), Object.keys(real), path + ": the keys, in order");
    for (const key of Object.keys(doc)) assertSameShape(doc[key], real[key], path + "." + key);
  }
}
// The fixed-vocabulary fields hold the value the document shows.
function assertFixedValues(doc, real, path) {
  if (kindOf(doc) === "array") doc.forEach((entry, index) => kindOf(entry) === "object" && assertFixedValues(entry, real[index], path + "[" + index + "]"));
  if (kindOf(doc) !== "object") return;
  for (const key of Object.keys(doc)) {
    if (FIXED.includes(key) && kindOf(doc[key]) !== "array") assert.deepEqual(doc[key], real[key], path + "." + key);
    else assertFixedValues(doc[key], real[key], path + "." + key);
  }
}
const assertMatches = (name, real) => {
  assertSameShape(examples[name], real, name);
  assertFixedValues(examples[name], real, name);
};

test("platform.md has each example answer of the D29 contracts, as valid JSON", () => {
  assert.deepEqual(Object.keys(examples).sort(), [...NAMES].sort());
});

test("the example answers in platform.md are what the Portal gives", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const repository = createRepository(db);
  // The examples carry fixed times (the notice's attempt is 2026-11-21T09:59Z), and the page shows an attempt for 30 days
  // only, so the Portal's clock is pinned just after them rather than read: on the real date the test would stop passing a
  // month after the examples were written.
  const clock = { now: Date.parse("2026-11-22T10:00:00.000Z") };
  const manage = fakeManage({ now: () => clock.now, delegated: true });
  const served = { status: 200, body: "" };
  let counter = 0;
  const service = createIntegrationService({
    repository, db, manage, stationFetch: { async get() { return { ...served }; } }, pushFetch: { async post() { return { status: 202 }; } },
    exchange: async () => ({}), now: () => clock.now, log: () => {}, challengeValue: () => "proof-value-" + (++counter), delegatedHostWork: true
  });
  const register = async (accountId, origin) => {
    const challenge = await service.createChallenge(accountId, origin);
    served.body = challenge.value;
    return service.registerStation(accountId, { challengeId: challenge.challengeId, reportKey: publicJwk() });
  };
  const built = manage.seedBuiltIn({ integrations: true, admins: [ADMIN] });
  await service.syncBuiltIn();

  // The directory: the built-in Station, one the account owns, one whose membership ended, and an owned one that was removed.
  const mine = await register(OWNER, "https://station.example.net");
  const shared = await register(MEMBER, "https://shared.example.org");
  await service.share(MEMBER, shared.id, OWNER);
  await service.unshare(MEMBER, shared.id, OWNER);
  const old = await register(OWNER, "https://old.example.net");
  clock.now += 1000;
  await service.removeStation(OWNER, old.id);
  assertMatches("directory", await service.directory(OWNER, {}));
  assertMatches("directory-page", await service.directory(OWNER, { limit: "1" }));
  const page = await service.directory(OWNER, { limit: "1" });
  assert.equal(JSON.stringify(JSON.parse(Buffer.from(examples["directory-page"].nextCursor, "base64url"))), JSON.stringify([true, examples.directory.stations[0].createdAt, examples.directory.stations[0].id]), "the example cursor is [builtIn, createdAt, id] of the page's last Station");
  assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor, "base64url")), [true, page.stations[0].createdAt, page.stations[0].id]);

  // A Station whose two-phase removal is under way (D29), with an approved integration still revoking: its directory entry.
  const leaving = await register(OWNER, "https://leaving.example.net");
  const staying = await service.createIntegration(OWNER, { stationId: leaving.id, name: "Leaving", scopes: [], publicJwk: publicJwk() });
  await service.approve(OWNER, staying.id, { r9Svc: R9 });
  assert.equal((await service.removeStation(OWNER, leaving.id)).removing, true);
  const removing = (await service.directory(OWNER, {})).stations.find((entry) => entry.id === leaving.id);
  assertMatches("directory-removing", removing);
  // completeBy is 26 hours after removalStartedAt, in the document's example as in the service's entry.
  for (const [name, entry] of [["the example", examples["directory-removing"]], ["the service's entry", removing]]) {
    assert.equal(Date.parse(entry.completeBy) - Date.parse(entry.removalStartedAt), 26 * 3600000, name + ": completeBy is 26 hours after removalStartedAt");
  }

  // The checkpoint of the built-in Station: a ready integration, a revoking one that interrupts, Auth's baseline, a disabled
  // account and a binding.
  const integration = async (name) => {
    const view = await service.createIntegration(OWNER, { stationId: built.id, name, scopes: ["agent.prompt"], publicJwk: publicJwk() });
    await service.approve(OWNER, view.id, { r9Svc: R9 });
    return view.id;
  };
  const live = await integration("Dev bot");
  await service.report(built.reportClientId, { integrationId: live, state: "ready" });
  await service.revoke(OWNER, await integration("Old bot"), { interruptRunning: true });
  manage.accountChange(DISABLED, true, { actor: ADMIN, reason: "abuse" });
  manage.baselineChange();
  await service.accountsStartingOver();
  const pass = { epoch: Number((await db.pool.query("SELECT accounts_epoch FROM auth_change_feed")).rows[0].accounts_epoch) };
  for (const entry of manage.feed) await service.applyAuthChange(entry, pass);
  await service.accountsCaughtUp(pass);

  // The binding reports: the documented requests, and what the service answers.
  assert.deepEqual(await service.report(built.reportClientId, examples["binding-changed-request"]), examples["binding-changed-answer"]);
  assert.deepEqual(await service.report(built.reportClientId, examples["binding-attempt-request"]), examples["binding-attempt-answer"]);
  await assert.rejects(
    service.report(built.reportClientId, { ...examples["binding-changed-request"], reportId: "binding_changed:" + "0".repeat(64), version: examples["binding-changed-request"].version - 1 }),
    (error) => { assert.equal(error.status, 409); assert.deepEqual({ error: error.message, code: error.details.code }, examples["binding-version-error"]); return true; }
  );
  assert.equal(examples["binding-changed-answer"].version, examples["binding-changed-request"].version, "the answer is the recorded binding");
  // The admin API's release (D27): the documented request on this test's built-in Station, by an admin who doesn't own the
  // binding; and its documented refusal, a version the record no longer has.
  const asked = { ...examples["admin-release-request"], stationId: built.id };
  for (const name of ["accountId", "genesisHash", "bindingId", "version"]) assert.equal(asked[name], examples["binding-changed-request"][name], "the release names the documented binding: " + name);
  const released = await service.releaseBinding(ADMIN, asked);
  assert.equal(released.status, 201);
  // The route answers { release } (scripts/admin-api.mjs), the wrapper of GET /releases/<id> too.
  assertMatches("admin-release-answer", { release: released.release });
  assert.match(examples["admin-release-answer"].release.releaseId, /^rl-[0-9a-hjkmnp-tv-z]{26}$/);
  assert.equal(examples["admin-release-answer"].release.account, examples["binding-changed-request"].account);
  await assert.rejects(
    service.releaseBinding(ADMIN, { ...asked, key: asked.key + "-again", version: asked.version - 1 }),
    (error) => { assert.equal(error.status, 409); assert.deepEqual({ error: error.message, code: error.details.code }, examples["admin-release-error"]); return true; }
  );
  assertMatches("admin-bindings", await service.adminBindings({ account: examples["binding-changed-request"].account }));
  const checkpoint = await service.changes(built.reportClientId, "0", { checkpoint: true });
  assert.deepEqual(checkpoint.checkpoint.accounts, { complete: true, disabled: [DISABLED] });
  assertMatches("checkpoint", checkpoint);

  // A custom Station's checkpoint has no accounts and no bindings.
  const custom = await service.createIntegration(OWNER, { stationId: mine.id, name: "Mine", scopes: [], publicJwk: publicJwk() });
  await service.approve(OWNER, custom.id, { r9Svc: R9 });
  await service.pause(OWNER, custom.id);
  assertMatches("checkpoint-custom", await service.changes(mine.reportClientId, "0", { checkpoint: true }));

  // The four account changes: a disable and an enable applied live, the baseline of the first completion, and the
  // accounts_incomplete of a start-over.
  const seen = manage.feed.length;
  manage.accountChange(DISABLED_TOO, true, { actor: ADMIN, reason: "abuse" });
  manage.accountChange(DISABLED, false, { actor: ADMIN, reason: "appeal" });
  for (const entry of manage.feed.slice(seen)) assert.equal(await service.applyAuthChange(entry, pass), "applied");
  await service.accountsStartingOver();
  const feed = await service.changes(built.reportClientId, "0");
  // The binding_released change the release wrote.
  const releasedChange = feed.changes.find((change) => change.kind === "binding_released");
  assertMatches("binding-released-change", releasedChange);
  assert.equal(releasedChange.releaseId, released.release.releaseId);
  const changes = {};
  for (const change of feed.changes) if (["account_disabled", "account_enabled", "accounts_baseline", "accounts_incomplete"].includes(change.kind)) changes[change.kind] ??= change;
  assert.deepEqual(Object.keys(changes).sort(), ["account_disabled", "account_enabled", "accounts_baseline", "accounts_incomplete"]);
  const documented = examples["account-changes"];
  assert.deepEqual(Object.keys(documented), ["changes", "cursor"]);
  assert.equal(kindOf(documented.cursor), kindOf(feed.cursor));
  assert.deepEqual(new Set(documented.changes.map((change) => change.kind)), new Set(Object.keys(changes)), "the four kinds");
  for (const change of documented.changes) {
    assertSameShape(change, changes[change.kind], "account-changes " + change.kind);
    assertFixedValues(change, changes[change.kind], "account-changes " + change.kind);
  }
  assert.deepEqual(documented.changes.map((change) => change.account === null), documented.changes.map((change) => ["accounts_baseline", "accounts_incomplete"].includes(change.kind)), "the baseline and the incomplete change name no account");

  // The browser's list of an account that has only the built-in Station, with a refused binding attempt.
  await service.report(built.reportClientId, { ...examples["binding-attempt-request"], reportId: "binding_attempt:" + "1".repeat(64), account: OTHER });
  assertMatches("notices", await service.stations(OTHER));
});
