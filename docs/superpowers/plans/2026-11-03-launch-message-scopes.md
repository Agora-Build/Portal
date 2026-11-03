# Launch and message scopes (D28) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auth issues, and the Portal offers, two new integration scopes: `agent.launch` and `agent.message`.

**Architecture:** Both repositories keep a fixed scope list. Auth's `INTEGRATION_SCOPES` and `STATION_SCOPES`
(`src/integrations.mjs`) gate which scopes an integration may hold, and the token endpoint already issues only
granted scopes. The Portal's `SCOPES` (`scripts/integrations/service.mjs`) gates what the form may send. The form in
`account.html` offers the checkboxes. Nothing else changes: the Station maps the scopes to Atem ops later, and
Astation applies the signing gate. Those are other teams' work.

**Tech Stack:** Node 22 (`node:test`), oidc-provider 9 (Auth), PostgreSQL for the database-backed tests, static HTML
plus vanilla JS (Portal).

**Spec:** `~/Dev/Agora.Build/reviews/agora-build-integrations/AGORA-BUILD-INTEGRATIONS.md` §3.1.3 "Launch and
message scopes (D28)", the D28 row in §4, and the D28 block in §6. Review request: Portal issue #26.

## Global Constraints

- The new scopes are exactly `agent.launch` and `agent.message`, appended after `agent.terminal` in every list.
- `agent.view` stays required. The new scopes are independent: neither implies nor requires another.
- Existing integrations are not changed. No migration, and no change to stored scopes.
- The Portal shows both checkboxes at once (no switch). The page says each needs an upgraded Atem on the host. The
  checkbox descriptions are exactly:
  - *agent.launch*: "Start new agent sessions on your hosts, only from profiles you approved there."
  - *agent.message*: "Send messages, context and attachments to your hosts and agents. For an agent to act on one,
    also allow agent.prompt."
- Node: `export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"`.
- Run suites with `timeout 580 npm test` and a tool timeout of 600000 ms. Never leave a suite running in the
  background.
- Database tests need `TEST_DATABASE_URL`. The controller provides it; implementers never read credentials or start
  containers.
- Commits end with the line `🤖 Built with SMT <smt@agora.build>`. No co-author trailers. No force pushes, `git stash`,
  checkout or reset. Never stage `.superpowers/`.
- Write prose in plain English, matching the surrounding docs. Comments follow the file's existing density.

---

### Task 1: Auth accepts and issues `agent.launch` and `agent.message`

Repository: `~/Dev/Agora.Build/Auth`, branch `feat/launch-message-scopes` (created from `main` `9beb070`).

**Files:**
- Modify: `src/integrations.mjs:6-7` (the two scope lists)
- Modify: `docs/integrating.md:228-229` and `:263-265` (the scope lists in prose)
- Test: `tests/integrations.test.mjs:44-48` (the scope-list test) and the `createIntegration` validation test (`:95-`)
- Test: `tests/station-resources.test.mjs` (a new token test after "a runtime client whose request leaves no scope
  is invalid_scope", `:185-197`)

**Interfaces:**
- Produces: `INTEGRATION_SCOPES` = `["agent.view", "agent.prompt", "agent.approve", "agent.interrupt",
  "agent.terminal", "agent.launch", "agent.message"]`. `STATION_SCOPES` = the existing 8 plus `agent.launch` and
  `agent.message` (10). The Portal (Task 2) relies on Auth accepting both new scopes in `createIntegration`.

- [ ] **Step 1: Write the failing tests**

In `tests/integrations.test.mjs`, replace the body of `test("scope lists", ...)` with:

```js
test("scope lists", () => {
  assert.equal(STATION_SCOPES.length, 10);
  assert.ok(STATION_SCOPES.includes("agent.launch") && STATION_SCOPES.includes("agent.message"));
  assert.deepEqual(INTEGRATION_SCOPES, ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message"]);
  assert.equal(DEFAULT_QUOTA_PER_SECOND, 200);
});
```

In the same file, add right after the test `createIntegration validates scopes, expiry, Station use and the key`:

```js
test("createIntegration accepts agent.launch and agent.message, alone or together, and still requires agent.view", async () => {
  const s = await station();
  const make = async (scopes) => store.createIntegration({ owner, stationId: s.id, name: "Launcher", scopes, publicJwk: await publicJwk() });
  for (const scopes of [["agent.view", "agent.launch"], ["agent.view", "agent.message"], ["agent.view", "agent.prompt", "agent.launch", "agent.message"]]) {
    const { clientId } = await make(scopes);
    assert.deepEqual((await store.integration(clientId)).scopes, scopes, JSON.stringify(scopes));
  }
  await rejects(make(["agent.launch"]), "scope");
  await rejects(make(["agent.message"]), "scope");
  await rejects(make(["agent.view", "agent.launch", "agent.launch"]), "scope");
  await rejects(make(["agent.view", "agent.notify"]), "scope");
});
```

In `tests/station-resources.test.mjs`, add right after `test("a runtime client whose request leaves no scope is invalid_scope", ...)`:

```js
test("an integration gets agent.launch and agent.message only when granted them", async () => {
  const store = auth.app.services.integrations;
  const key = await keyPair();
  const { clientId } = await store.createIntegration({ owner: ownerA, stationId: station.id, name: "Launcher", scopes: ["agent.view", "agent.launch", "agent.message"], publicJwk: key.jwk, r9Svc: "ef".repeat(32) });
  const granted = await clientCredentials(clientId, key, { resource: STATION, scope: "agent.view agent.launch agent.message" });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(decodeJwt(granted.body.access_token).scope.split(" ").sort(), ["agent.launch", "agent.message", "agent.view"]);
  const viewer = await keyPair();
  const plain = await store.createIntegration({ owner: ownerA, stationId: station.id, name: "Viewer", scopes: ["agent.view", "agent.prompt"], publicJwk: viewer.jwk, r9Svc: "ef".repeat(32) });
  for (const scope of ["agent.launch", "agent.message"]) {
    const refused = await clientCredentials(plain.clientId, viewer, { resource: STATION, scope });
    assert.equal(refused.status, 400, scope);
    assert.equal(refused.body.error, "invalid_scope", scope);
  }
});
```

- [ ] **Step 2: Run the tests to check that they fail**

Run: `timeout 580 node --test tests/integrations.test.mjs tests/station-resources.test.mjs`
Expected: FAIL in "scope lists" (length 8, not 10) and in the two new tests (`IntegrationError` code `scope` from
`createIntegration`).

- [ ] **Step 3: Write the implementation**

In `src/integrations.mjs`, lines 6–7 become:

```js
export const STATION_SCOPES = Object.freeze(["astation.remote", "station.read", "assistant.chat", "agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message"]);
export const INTEGRATION_SCOPES = Object.freeze(["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message"]);
```

- [ ] **Step 4: Run the tests to check that they pass**

Run: `timeout 580 node --test tests/integrations.test.mjs tests/station-resources.test.mjs`
Expected: PASS.

- [ ] **Step 5: Update the docs**

In `docs/integrating.md`:
- In the native-client paragraph (line 228–229), the list of Station scopes becomes: `astation.remote`,
  `station.read`, `assistant.chat`, `agent.view`, `agent.prompt`, `agent.approve`, `agent.interrupt`,
  `agent.terminal`, `agent.launch`, `agent.message`.
- In the integration-token paragraph (lines 263–265), the list of other scopes becomes `agent.prompt`,
  `agent.approve`, `agent.interrupt`, `agent.terminal`, `agent.launch`, `agent.message`. Add this sentence after it:
  "`agent.launch` lets the integration start agent sessions from profiles the owner approved on a host, and
  `agent.message` lets it send messages, context and attachments (a task for an agent also needs `agent.prompt`).
  The Station turns them into Atem's `launch`, `message` and `notify` permissions once the Atem release that
  supports them is out; until then a Station grants nothing for them."

- [ ] **Step 6: Run the full suite**

Run: `timeout 580 npm test`
Expected: all pass. The count is 457 on `main` plus the 2 new tests, so 459.

- [ ] **Step 7: Commit**

```bash
git add src/integrations.mjs tests/integrations.test.mjs tests/station-resources.test.mjs docs/integrating.md
git commit -m "Accept agent.launch and agent.message as integration scopes (D28)

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: The Portal offers and validates `agent.launch` and `agent.message`

Repository: `~/Dev/Agora.Build/Portal`, branch `feat/launch-message-scopes` (created from `main` `2d2415d`).

**Files:**
- Modify: `scripts/integrations/service.mjs:17` (`SCOPES`)
- Modify: `account.html:43` (the Scopes fieldset in the integration form)
- Modify: `docs/platform.md:814-815` (the scope list in prose)
- Test: `tests/integrations-service.test.mjs` (a new test after "createIntegration adds agent.view, uses the
  defaults and records the creation after Auth")
- Test: `tests/integrations-page.test.mjs` (a new test after "/account/ carries the Stations and Integrations
  sections ...")

**Interfaces:**
- Consumes: Auth (Task 1) accepts `agent.launch` and `agent.message` in `createIntegration`. The service tests use
  the fake Auth, so they don't need Task 1 deployed. The end-to-end run with the real Auth does.
- Produces: `POST /api/integrations` accepts `scopes` containing `agent.launch` and `agent.message`. The form sends
  them when ticked; `integrations.js` needs no change, because it already sends every checked `input[name=scope]`.

- [ ] **Step 1: Write the failing tests**

In `tests/integrations-service.test.mjs`, add after the test "createIntegration adds agent.view, uses the defaults
and records the creation after Auth":

```js
test("createIntegration takes agent.launch and agent.message, alone or together", async (t) => {
  const s = await setup(t);
  if (!s) return;
  for (const scopes of [["agent.launch"], ["agent.message"], ["agent.prompt", "agent.launch", "agent.message"]]) {
    const made = await s.create(OWNER, { scopes });
    assert.deepEqual(s.record(made.id).scopes, ["agent.view", ...scopes], JSON.stringify(scopes));
    assert.deepEqual(made.scopes, ["agent.view", ...scopes], JSON.stringify(scopes));
  }
  for (const scopes of [["agent.launch", "agent.launch"], ["agent.notify"]]) await assert.rejects(s.create(OWNER, { scopes }), refused(400, "scopes"), JSON.stringify(scopes));
});
```

In `tests/integrations-page.test.mjs`, add after the first test:

```js
test("the integration form offers agent.launch and agent.message and says they need an upgraded Atem", async () => {
  const html = await read("account.html");
  const fieldset = html.match(/<fieldset class="token-choice scope-choice">[\s\S]*?<\/fieldset>/)?.[0] || "";
  const values = [...fieldset.matchAll(/name="scope" value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message"]);
  const note = html.match(/<p class="form-note" id="scope-note">[\s\S]*?<\/p>/)?.[0] || "";
  assert.match(note, /agent\.launch<\/strong>: Start new agent sessions on your hosts, only from profiles you approved there\./);
  assert.match(note, /agent\.message<\/strong>: Send messages, context and attachments to your hosts and agents\. For an agent to act on one, also allow agent\.prompt\./);
  assert.match(note, /need an upgraded Atem on the host/);
  assert.match(fieldset, /aria-describedby="scope-note"/);
});
```

- [ ] **Step 2: Run the tests to check that they fail**

Run: `timeout 580 node --test tests/integrations-service.test.mjs tests/integrations-page.test.mjs`
Expected: FAIL. The service test gets `refused(400, "scopes")` for `agent.launch`, and the page test is missing the
values and the note. Without `TEST_DATABASE_URL` the service test returns early, so the controller provides it.

- [ ] **Step 3: Write the implementation**

In `scripts/integrations/service.mjs`, line 17 becomes:

```js
const SCOPES = ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message"];
```

In `account.html` (line 43), replace the whole Scopes fieldset with this markup, keeping it on one line like the
surrounding form:

```html
<fieldset class="token-choice scope-choice" aria-describedby="scope-note"><legend>Scopes</legend><label><input type="checkbox" name="scope" value="agent.view" checked disabled> agent.view <span class="optional">always included</span></label><label><input type="checkbox" name="scope" value="agent.prompt"> agent.prompt</label><label><input type="checkbox" name="scope" value="agent.approve"> agent.approve</label><label><input type="checkbox" name="scope" value="agent.interrupt"> agent.interrupt</label><label><input type="checkbox" name="scope" value="agent.terminal"> agent.terminal</label><label><input type="checkbox" name="scope" value="agent.launch"> agent.launch</label><label><input type="checkbox" name="scope" value="agent.message"> agent.message</label></fieldset><p class="form-note" id="scope-note"><strong>agent.launch</strong>: Start new agent sessions on your hosts, only from profiles you approved there. <strong>agent.message</strong>: Send messages, context and attachments to your hosts and agents. For an agent to act on one, also allow agent.prompt. Both need an upgraded Atem on the host.</p>
```

Make sure the note's sentence contains the exact phrase "need an upgraded Atem on the host" ("Both need an upgraded
Atem on the host.") so that the page test matches.

In `docs/platform.md` (lines 814–815), the scope list becomes "`agent.view`, `agent.prompt`, `agent.approve`,
`agent.interrupt`, `agent.terminal`, `agent.launch` and `agent.message` (each at most once; `agent.view` is always
added)". Add after that sentence: "`agent.launch` and `agent.message` take effect only on a Station and host that
support them (an upgraded Atem); see the design's D28."

- [ ] **Step 4: Run the tests to check that they pass**

Run: `timeout 580 node --test tests/integrations-service.test.mjs tests/integrations-page.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `timeout 580 npm test`
Expected: all pass. The count is the `main` count plus 2.

- [ ] **Step 6: Commit**

```bash
git add scripts/integrations/service.mjs account.html docs/platform.md tests/integrations-service.test.mjs tests/integrations-page.test.mjs docs/superpowers/plans/2026-11-03-launch-message-scopes.md
git commit -m "Offer agent.launch and agent.message on the integration form (D28)

🤖 Built with SMT <smt@agora.build>"
```

---

## Controller checks after both tasks (not for implementers)

1. **The Portal end-to-end run against the real Auth.** Point the Portal's e2e harness at the Auth checkout on
   `feat/launch-message-scopes`, so that Auth accepts the new scopes. Run `npm run test:e2e`; it must still pass.
2. **The browser smoke.** Run `scripts/browser-smoke-integrations.mjs`. It must pass at desktop and mobile widths
   with the two extra checkboxes and the note: no overflow, and the form still sends the chosen scopes.
3. **Pull requests.** Open one PR per repository against `main`. Their bodies end with
   `Generated with SMT <smt@agora.build>`. Merge only with the owner's approval.
4. **Dev deployment.** Deploy to dev in this order:
   1. Auth (it accepts the scopes), then the Portal.
   2. Keep rollback images.
   3. Check that creating an integration with `agent.launch` on the built-in Station works, and that the existing
      integrations are unchanged.
