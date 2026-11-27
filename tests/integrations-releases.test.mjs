// Releasing a built-in Station's R9 binding (D27 slice 1, docs/integrations.md §3.3.5; Portal #41): the admin API's release
// at the service, its checks in their order, its idempotency, admin_actions and the binding_released change on the Station's
// feed; and (below) reading bindings and releases, the checkpoint's pendingReleases and settling.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { createIntegrationService } from "../scripts/integrations/service.mjs";
import { AppError } from "../scripts/store.mjs";
import { fakeManage } from "./helpers/fake-manage.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const OWNER = "ab" + "0".repeat(25) + "1";
const OTHER = "ab" + "0".repeat(25) + "3";
const ADMIN = "ab" + "0".repeat(25) + "4";
const ADMIN_TOO = "ab" + "0".repeat(25) + "5";
const GENESIS = "b".repeat(64);
const R9_ACCOUNT = "r9:account-1";
const REASON = "The owner lost their Agora.Build account; ticket 4821.";
const RELEASE_ID = /^rl-[0-9a-hjkmnp-tv-z]{26}$/;
const RELEASE_KEYS = ["releaseId", "stationId", "account", "accountId", "genesisHash", "bindingId", "version", "state", "requestedAt", "settledAt", "settledVersion", "actor", "reason"];
const publicJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });

// The built-in Station (admins ADMIN and ADMIN_TOO) synced on a delegated Portal whose clock is still unless a test moves
// it. `wrap` wraps the repository the service uses; `make(repository, options)` builds another service on the same database.
// node:test runs a test's after hooks in the order they were added, and a push still in flight reads the database, so the
// database is closed by our own hook, once every service made here has finished its pushes.
async function setup(t, { delegatedHostWork = true, wrap = (repository) => repository } = {}) {
  const closing = [];
  const services = [];
  t.after(async () => {
    for (const made of services) await made._pushesIdle();
    for (const hook of closing) await hook();
  });
  const db = await testDatabase({ after: (hook) => closing.push(hook) });
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const clock = { now: Date.parse("2026-11-27T10:00:00.000Z") };
  const manage = fakeManage({ now: () => clock.now, delegated: true });
  const built = manage.seedBuiltIn({ integrations: true, admins: [ADMIN, ADMIN_TOO] });
  const pushFetch = { posts: [], async post(url, body) { pushFetch.posts.push({ url, body }); return { status: 202 }; } };
  const logged = [];
  const served = { status: 200, body: "" };
  let counter = 0;
  const make = (repo, options = {}) => {
    const made = createIntegrationService({
      repository: repo, db, manage, stationFetch: { async get() { return { ...served }; } }, pushFetch, exchange: async () => ({}), now: () => clock.now,
      log: (line) => logged.push(line), challengeValue: () => "proof-value-" + (++counter), delegatedHostWork, ...options
    });
    services.push(made);
    return made;
  };
  const service = make(wrap(repository));
  assert.equal(await service.syncBuiltIn(), true);
  await service._pushesIdle();
  pushFetch.posts.length = 0;
  // A custom Station of `accountId`, registered the way the browser does it.
  const register = async (accountId = OWNER, origin = "https://custom.example") => {
    const challenge = await service.createChallenge(accountId, origin);
    served.body = challenge.value;
    return service.registerStation(accountId, { challengeId: challenge.challengeId, reportKey: publicJwk() });
  };
  return { db, repository, manage, clock, built, service, make, register, pushFetch, logged };
}

let reports = 0;
// The built-in Station reports a binding (binding_changed): by default OWNER's R9_ACCOUNT at GENESIS, bind-1, version 3,
// bound. Each report has a reportId of its own.
const report = (s, fields = {}) => s.service.report(s.built.reportClientId, {
  state: "binding_changed", reportId: "binding_changed:" + String(++reports).padStart(64, "0"), account: OWNER, accountId: R9_ACCOUNT,
  genesisHash: GENESIS, bindingId: "bind-1", version: 3, bindingState: "bound", ...fields
});
let forms = 0;
// A release request for that binding, with a form key of its own.
const body = (s, fields = {}) => ({
  stationId: s.built.id, accountId: R9_ACCOUNT, genesisHash: GENESIS, bindingId: "bind-1", version: 3, reason: REASON,
  key: "form:" + String(++forms).padStart(8, "0"), ...fields
});
const actions = async (s) => (await s.db.pool.query("SELECT actor, action, target_kind, target, reason, outcome, details FROM admin_actions ORDER BY at, id")).rows;
const count = async (s, table, where = "") => (await s.db.pool.query("SELECT count(*)::int AS n FROM " + table + (where ? " WHERE " + where : ""))).rows[0].n;
const refused = (status, code, message) => (error) => {
  assert.ok(error instanceof AppError, "an AppError, not " + error);
  assert.equal(error.status, status);
  assert.equal(error.details?.code, code);
  if (message !== undefined) assert.equal(error.message, message);
  return true;
};

test("a release is 201 with a pending release, admin_actions started then done, one binding_released change on the built-in Station's feed, and one push after the commit", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const before = await s.service.changes(s.built.reportClientId, "0");
  const made = await s.service.releaseBinding(ADMIN, body(s, { reason: "  " + REASON + "  " }));
  assert.equal(made.status, 201);
  const { release } = made;
  assert.deepEqual(Object.keys(release), RELEASE_KEYS);
  assert.match(release.releaseId, RELEASE_ID);
  assert.deepEqual({ ...release, releaseId: "" }, {
    releaseId: "", stationId: s.built.id, account: OWNER, accountId: R9_ACCOUNT, genesisHash: GENESIS, bindingId: "bind-1", version: 3,
    state: "pending", requestedAt: "2026-11-27T10:00:00.000Z", settledAt: null, settledVersion: null, actor: ADMIN, reason: REASON
  });
  assert.deepEqual(await actions(s), [{
    actor: ADMIN, action: "binding_released", target_kind: "binding", target: JSON.stringify([s.built.id, R9_ACCOUNT, GENESIS]), reason: REASON,
    outcome: "done", details: { releaseId: release.releaseId }
  }]);
  const after = await s.service.changes(s.built.reportClientId, String(before.cursor));
  assert.equal(after.changes.length, 1);
  const [change] = after.changes;
  assert.deepEqual(Object.keys(change), ["id", "at", "integrationId", "kind", "state", "reason", "account", "releaseId", "binding"]);
  assert.deepEqual({ ...change, id: 0, at: "" }, {
    id: 0, at: "", integrationId: null, kind: "binding_released", state: null, reason: "agora_build", account: OWNER, releaseId: release.releaseId,
    binding: { accountId: R9_ACCOUNT, genesisHash: GENESIS, bindingId: "bind-1", version: 3 }
  });
  assert.deepEqual(Object.keys(change.binding), ["accountId", "genesisHash", "bindingId", "version"]);
  // The event keeps the admin and their reason; the feed says only agora_build.
  assert.deepEqual((await s.db.pool.query("SELECT actor, account_id, reason, integration_id FROM integration_events WHERE kind = 'binding_released'")).rows, [{ actor: ADMIN, account_id: OWNER, reason: REASON, integration_id: null }]);
  await s.service._pushesIdle();
  assert.deepEqual(s.pushFetch.posts, [{ url: s.built.origin + "/agora-build/v1/changes", body: { cursor: change.id } }]);
});

test("the request's own fields are checked first, in order (the body's shape, reason, key), and a refusal there writes nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const good = body(s);
  const bad = (input, code, label) => assert.rejects(s.service.releaseBinding(ADMIN, input), refused(400, code), label);
  const { key, ...noKey } = good;
  const { reason, ...noReason } = good;
  for (const input of [null, [], "x", 3, {}, { ...good, extra: 1 }, noKey, noReason]) {
    await bad(input, "body", JSON.stringify(input));
  }
  await assert.rejects(s.service.releaseBinding(ADMIN, {}), refused(400, "body", "Send { stationId, accountId, genesisHash, bindingId, version, reason, key }."));
  for (const value of ["", "   ", "\u200b", "two\nlines", "tab\there", "bidi\u202e", "x".repeat(501), 5, null, "\uD800"]) {
    await bad({ ...good, reason: value }, "reason", JSON.stringify(value));
  }
  await assert.rejects(s.service.releaseBinding(ADMIN, { ...good, reason: "" }), refused(400, "reason", "Give a reason of 1 to 500 characters on one line."));
  for (const value of ["ab", "-abc", "a b c", "a".repeat(201), "ké", 7, null]) await bad({ ...good, key: value }, "key", JSON.stringify(value));
  await assert.rejects(s.service.releaseBinding(ADMIN, { ...good, key: "-" }), refused(400, "key", "Send the form's key: 3 to 200 letters, digits, ':', '_' or '-', starting with a letter or digit."));
  await bad({ ...good, reason: "", key: "" }, "reason", "the reason before the key");
  await bad({ ...good, reason: "", extra: 1 }, "body", "the shape before the reason");
  assert.deepEqual(await actions(s), [], "nothing is written for the request's own fields");
  assert.equal(await count(s, "binding_releases"), 0);
  assert.equal((await s.service.releaseBinding(ADMIN, { ...good, reason: "x".repeat(500), key: "a".repeat(200) })).status, 201, "the limits themselves pass");
});

test("then the binding's fields, in order (accountId, genesisHash, bindingId, version): each refusal is started, then failed with its code", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const cases = [
    [{ accountId: "" }, "account_id"], [{ accountId: "x".repeat(129) }, "account_id"], [{ genesisHash: "B".repeat(64) }, "genesis_hash"],
    [{ bindingId: "a b" }, "binding_id"], [{ version: 0 }, "version"], [{ version: 1.5 }, "version"], [{ version: "3" }, "version"],
    [{ version: 2 ** 53 }, "version"], [{ accountId: 7, genesisHash: "x", bindingId: "", version: 0 }, "account_id"],
    [{ genesisHash: "x", bindingId: "", version: 0 }, "genesis_hash"], [{ bindingId: "", version: 0 }, "binding_id"]
  ];
  for (const [fields, code] of cases) {
    s.clock.now += 1000;
    await assert.rejects(s.service.releaseBinding(ADMIN, body(s, fields)), refused(400, code), JSON.stringify(fields));
  }
  s.clock.now += 1000;
  await assert.rejects(s.service.releaseBinding(ADMIN, body(s, { version: 0 })), refused(400, "version", "Send the version as a positive whole number."));
  assert.deepEqual((await actions(s)).slice(0, cases.length).map((row) => [row.outcome, row.details]), cases.map(([, code]) => ["failed", { code }]));
  assert.equal(await count(s, "binding_releases"), 0);
});

test("then the Station and its binding: an unknown, custom or removed Station, or no binding recorded there, is 404 binding", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const custom = await s.register(OWNER);
  const missing = refused(404, "binding", "No binding is recorded for this R9 account on that built-in Station.");
  for (const stationId of ["st-unknown", custom.id, 7, null, "bad id"]) await assert.rejects(s.service.releaseBinding(ADMIN, body(s, { stationId })), missing, String(stationId));
  await assert.rejects(s.service.releaseBinding(ADMIN, body(s, { accountId: "r9:nobody" })), missing);
  await assert.rejects(s.service.releaseBinding(ADMIN, body(s, { genesisHash: "c".repeat(64) })), missing);
  await s.repository.markStationRemoved(s.built.id, s.clock.now);
  await assert.rejects(s.service.releaseBinding(ADMIN, body(s)), missing, "a removed built-in Station");
  const rows = await actions(s);
  assert.equal(rows.length, 8);
  assert.ok(rows.every((row) => row.outcome === "failed" && row.details.code === "binding"));
  assert.equal(await count(s, "binding_releases"), 0);
});

test("the same key with the same body answers the recorded release (200) and writes nothing; with another body it is 409 key_reused", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const asked = body(s);
  const first = await s.service.releaseBinding(ADMIN, asked);
  const rows = await actions(s);
  s.clock.now += 1000;
  // The same body in another key order, its reason spaced otherwise, is the same request.
  const again = await s.service.releaseBinding(ADMIN, { key: asked.key, reason: " " + asked.reason, version: 3, bindingId: "bind-1", genesisHash: GENESIS, accountId: R9_ACCOUNT, stationId: s.built.id });
  assert.deepEqual(again, { status: 200, release: first.release });
  assert.deepEqual(await actions(s), rows, "a repeat writes no row");
  // The actor isn't part of the body: another admin with the key and the body gets the same release.
  assert.deepEqual(await s.service.releaseBinding(ADMIN_TOO, asked), { status: 200, release: first.release });
  // Another body under the key, even for this pending binding: key_reused, checked before the pending release.
  for (const fields of [{ reason: "Another reason." }, { version: 4 }, { bindingId: "bind-2" }]) {
    s.clock.now += 1000;
    await assert.rejects(s.service.releaseBinding(ADMIN, { ...asked, ...fields }), refused(409, "key_reused", "This key was already used for another release request."), JSON.stringify(fields));
  }
  assert.deepEqual((await actions(s)).slice(rows.length).map((row) => [row.outcome, row.details]), [1, 2, 3].map(() => ["failed", { code: "key_reused" }]));
  // A key answers its release once the binding has moved on too.
  await report(s, { version: 4, bindingState: "released" });
  const later = await s.service.releaseBinding(ADMIN, asked);
  assert.deepEqual([later.status, later.release.releaseId], [200, first.release.releaseId]);
  assert.equal(await count(s, "binding_releases"), 1);
  assert.equal(await count(s, "integration_events", "kind = 'binding_released'"), 1);
});

test("a pending release of the exact binding answers that release (200) under any key, from any admin, and makes no other", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const first = await s.service.releaseBinding(ADMIN, body(s));
  const rows = await actions(s);
  assert.deepEqual(await s.service.releaseBinding(ADMIN_TOO, body(s)), { status: 200, release: first.release });
  assert.deepEqual(await s.service.releaseBinding(OWNER, body(s)), { status: 200, release: first.release }, "before own_account");
  assert.deepEqual(await actions(s), rows, "a repeat writes no row");
  assert.equal(await count(s, "binding_releases"), 1);
});

test("then, in order: the admin's own account is 403 own_account, a binding that isn't bound 409 not_bound, and a changed bindingId or version 409 binding_changed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s, { account: ADMIN });
  const codes = [];
  const expect = async (actor, fields, status, code, message) => {
    s.clock.now += 1000;
    await assert.rejects(s.service.releaseBinding(actor, body(s, fields)), refused(status, code, message), actor + " " + JSON.stringify(fields));
    codes.push(code);
  };
  await expect(ADMIN, {}, 403, "own_account", "You can't release a binding of your own account.");
  await expect(ADMIN, { version: 2 }, 403, "own_account");
  await report(s, { account: ADMIN, version: 4, bindingState: "unbound" });
  await expect(ADMIN, { version: 4 }, 403, "own_account");
  await expect(ADMIN_TOO, { version: 4 }, 409, "not_bound", "Only a bound binding can be released.");
  await expect(ADMIN_TOO, { version: 3 }, 409, "not_bound");
  await report(s, { account: OWNER, version: 5, bindingId: "bind-5" });
  for (const fields of [{ version: 4, bindingId: "bind-5" }, { version: 6, bindingId: "bind-5" }, { version: 5 }]) {
    await expect(ADMIN, fields, 409, "binding_changed", "This binding has changed since it was loaded. Load it again.");
  }
  s.clock.now += 1000;
  assert.equal((await s.service.releaseBinding(ADMIN, body(s, { version: 5, bindingId: "bind-5" }))).status, 201);
  assert.deepEqual((await actions(s)).map((row) => [row.outcome, row.details.code ?? null]), [...codes.map((code) => ["failed", code]), ["done", null]]);
  assert.equal(await count(s, "binding_releases"), 1);
});

test("requests at the same moment make exactly one release: one 201, the others 200 with it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const asked = body(s);
  const answers = await Promise.all(Array.from({ length: 5 }, () => s.service.releaseBinding(ADMIN, asked)));
  assert.deepEqual(answers.map((made) => made.status).sort(), [200, 200, 200, 200, 201]);
  const releaseId = answers[0].release.releaseId;
  assert.ok(answers.every((made) => made.release.releaseId === releaseId));
  assert.equal(await count(s, "binding_releases"), 1);
  assert.equal(await count(s, "integration_events", "kind = 'binding_released'"), 1);
  // A request that found the release before it started wrote nothing; one that started ended done, and one made it.
  const rows = await actions(s);
  assert.ok(rows.length >= 1 && rows.length <= 5, String(rows.length));
  assert.ok(rows.every((row) => row.outcome === "done" && row.details.releaseId === releaseId));
  assert.equal(rows.filter((row) => row.details.repeated !== true).length, 1);
  // Different keys at once (two admins, two forms): one release too.
  await report(s, { version: 4, bindingId: "bind-4" });
  const many = await Promise.all([ADMIN, ADMIN_TOO, ADMIN, ADMIN_TOO].map((actor) => s.service.releaseBinding(actor, body(s, { version: 4, bindingId: "bind-4" }))));
  assert.deepEqual(many.map((made) => made.status).sort(), [200, 200, 200, 201]);
  assert.equal(new Set(many.map((made) => made.release.releaseId)).size, 1);
  assert.equal(await count(s, "binding_releases", "binding_id = 'bind-4'"), 1);
});

test("the release, its feed change and its done are one transaction: a failure inside it leaves none of them, pushes nothing, and marks the action failed", async (t) => {
  const s = await setup(t, {
    wrap: (repository) => ({
      ...repository,
      async finishAdminAction(id, outcome, details, client) {
        if (client && outcome === "done") throw Object.assign(new Error("connection lost"), { code: "57P01" });
        return repository.finishAdminAction(id, outcome, details, client);
      }
    })
  });
  if (!s) return;
  await report(s);
  const before = await s.service.changes(s.built.reportClientId, "0");
  await assert.rejects(s.service.releaseBinding(ADMIN, body(s)), /connection lost/);
  await s.service._pushesIdle();
  assert.equal(await count(s, "binding_releases"), 0);
  assert.deepEqual((await s.service.changes(s.built.reportClientId, String(before.cursor))).changes, [], "no change on the feed");
  assert.deepEqual(s.pushFetch.posts, [], "no push");
  assert.deepEqual((await actions(s)).map((row) => [row.outcome, row.details]), [["failed", { code: "error" }]]);
});

test("the action is written started before anything else: if that write fails, nothing is released", async (t) => {
  const s = await setup(t, { wrap: (repository) => ({ ...repository, async startAdminAction() { throw Object.assign(new Error("read only"), { code: "25006" }); } }) });
  if (!s) return;
  await report(s);
  await assert.rejects(s.service.releaseBinding(ADMIN, body(s)), /read only/);
  assert.deepEqual([await count(s, "binding_releases"), await count(s, "integration_events", "kind = 'binding_released'"), await count(s, "admin_actions")], [0, 0, 0]);
});

test("with DELEGATED_HOST_WORK off a release is 404 not_found and writes nothing; a release recorded while it was on stays on the feed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const off = s.make(s.repository, { delegatedHostWork: false });
  await assert.rejects(off.releaseBinding(ADMIN, body(s)), refused(404, "not_found", "This admin route was not found."));
  await assert.rejects(off.releaseBinding(ADMIN, null), refused(404, "not_found"), "before the body is looked at");
  assert.deepEqual([await count(s, "binding_releases"), await count(s, "admin_actions")], [0, 0]);
  const made = await s.service.releaseBinding(ADMIN, body(s));
  const feed = await off.changes(s.built.reportClientId, "0");
  assert.deepEqual(feed.changes.filter((change) => change.kind === "binding_released").map((change) => change.releaseId), [made.release.releaseId], "served as recorded");
  await off._pushesIdle();
});

// Reading (D27): the admin site's "R9 bindings" page and a release's own page.
const BINDING_KEYS = ["stationId", "account", "accountState", "accountId", "genesisHash", "bindingId", "version", "bindingState", "updatedAt", "releases"];

test("adminBindings lists the active built-in Stations' bindings of an account or an R9 account, each with its ten newest releases, newest first", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  await report(s, { genesisHash: "a".repeat(64), version: 1 });
  await report(s, { account: OTHER, accountId: "r9:account-2", bindingId: "bind-o", version: 1 });
  const mine = await s.service.adminBindings({ account: OWNER });
  assert.deepEqual(Object.keys(mine), ["bindings"]);
  assert.deepEqual(mine.bindings.map((entry) => [entry.stationId, entry.account, entry.accountState, entry.accountId, entry.genesisHash.slice(0, 1), entry.bindingId, entry.version, entry.bindingState, entry.releases]), [
    [s.built.id, OWNER, "unknown", R9_ACCOUNT, "a", "bind-1", 1, "bound", []],
    [s.built.id, OWNER, "unknown", R9_ACCOUNT, "b", "bind-1", 3, "bound", []]
  ]);
  for (const entry of mine.bindings) {
    assert.deepEqual(Object.keys(entry), BINDING_KEYS);
    assert.equal(typeof entry.updatedAt, "string");
  }
  assert.deepEqual((await s.service.adminBindings({ accountId: "r9:account-2" })).bindings.map((entry) => [entry.account, entry.bindingId]), [[OTHER, "bind-o"]]);
  assert.deepEqual(await s.service.adminBindings({ accountId: "r9:nobody" }), { bindings: [] });
  // Eleven releases of one binding, one version after another: the ten newest, newest first.
  const made = [];
  for (let n = 1; n <= 11; n += 1) {
    s.clock.now += 1000;
    await report(s, { version: 3 + n, bindingId: "bind-" + n });
    made.push((await s.service.releaseBinding(ADMIN, body(s, { version: 3 + n, bindingId: "bind-" + n }))).release.releaseId);
  }
  const [, released] = (await s.service.adminBindings({ account: OWNER })).bindings;
  assert.deepEqual(released.releases.map((release) => release.releaseId), made.slice(1).reverse());
  for (const release of released.releases) assert.deepEqual(Object.keys(release), RELEASE_KEYS);
  // A removed built-in Station's bindings are not listed.
  await s.repository.markStationRemoved(s.built.id, s.clock.now);
  assert.deepEqual(await s.service.adminBindings({ account: OWNER }), { bindings: [] });
});

test("accountState is disabled while the account is listed disabled, enabled while the view is complete, and unknown otherwise", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  await report(s, { account: OTHER, accountId: "r9:account-2", bindingId: "bind-o", version: 1 });
  const states = async () => [(await s.service.adminBindings({ account: OWNER })).bindings[0].accountState, (await s.service.adminBindings({ account: OTHER })).bindings[0].accountState];
  assert.deepEqual(await states(), ["unknown", "unknown"]);
  await s.repository.setAvailability(OTHER, true, "YzE", s.clock.now);
  assert.deepEqual(await states(), ["unknown", "disabled"], "disabled even while the view isn't complete");
  await s.repository.setBaseline("YzI", s.clock.now);
  await s.repository.markBaselineComplete();
  assert.deepEqual(await states(), ["enabled", "disabled"]);
  await s.repository.setAvailability(OTHER, false, "YzM", s.clock.now);
  assert.deepEqual(await states(), ["enabled", "enabled"]);
});

test("adminBindings takes exactly one of account or accountId, each in its grammar; anything else is 400 query", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const query = refused(400, "query", "Search by exactly one of account (an ab… account ID) or accountId (an R9 account ID).");
  for (const asked of [{}, { account: OWNER, accountId: R9_ACCOUNT }, { account: "ab123" }, { account: "ab" + "k".repeat(26) }, { account: "" }, { accountId: "" }, { accountId: "a b" }, { accountId: "x".repeat(129) }, { account: 7 }]) {
    await assert.rejects(s.service.adminBindings(asked), query, JSON.stringify(asked));
  }
});

test("release reads one release by its id, and anything else is 404 release", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const made = (await s.service.releaseBinding(ADMIN, body(s))).release;
  assert.deepEqual(await s.service.release(made.releaseId), { release: made });
  for (const id of ["rl-" + "0".repeat(26), made.releaseId.toUpperCase(), "rl-", undefined, 7]) {
    await assert.rejects(s.service.release(id), refused(404, "release", "This release was not found."), String(id));
  }
});

test("with DELEGATED_HOST_WORK off, reading bindings and releases is 404 not_found", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await report(s);
  const made = (await s.service.releaseBinding(ADMIN, body(s))).release;
  const off = s.make(s.repository, { delegatedHostWork: false });
  await assert.rejects(off.adminBindings({ account: OWNER }), refused(404, "not_found"));
  await assert.rejects(off.release(made.releaseId), refused(404, "not_found"));
});
