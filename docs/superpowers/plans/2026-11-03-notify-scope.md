# The `agent.notify` scope (D28, three scopes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auth and the Portal add a third D28 scope, `agent.notify`, which requires `agent.message` and
`agent.prompt`. `agent.message` no longer covers notify.

**Architecture:** This is the same pattern as `docs/superpowers/plans/2026-11-03-launch-message-scopes.md`:
- Each repository keeps a fixed scope list, and both gain `agent.notify`.
- Both repositories add one rule at creation: `agent.notify` requires `agent.message` and `agent.prompt`. Auth
  enforces it in `createIntegration`; the Portal checks it first in `integrationScopes`.
- The form gains a third checkbox and the revised descriptions.

**Tech Stack:** Node 22 (`node:test`), oidc-provider 9 (Auth), PostgreSQL for the database-backed tests, static HTML
plus vanilla JS (Portal).

**Spec:** `~/Dev/Agora.Build/reviews/agora-build-integrations/AGORA-BUILD-INTEGRATIONS.md` §3.1.3 "Launch, message
and notify scopes (D28)", the D28 row in §4 and the D28 block in §6. The contract is posted on Auth #14 and Portal #25.

## Global Constraints

- The scopes are `agent.launch`, `agent.message` and `agent.notify`, in that order, after `agent.terminal` in every
  list.
- `agent.notify` requires both `agent.message` and `agent.prompt`. Auth refuses it otherwise with the error code
  `scope`, and the Portal with 400 and the code `scopes`. Both use the message exactly
  "agent.notify needs agent.message and agent.prompt."
- `agent.view` stays required. `agent.launch` and `agent.message` stay independent.
- Existing integrations are not changed. No migration.
- The form's descriptions are exactly:
  - *agent.launch*: "Start new agent sessions on your hosts, only from profiles you approved there."
  - *agent.message*: "Send messages, context and attachments to your hosts and projects. On their own, messages
    never make an agent act."
  - *agent.notify*: "Let this app's messages become work for an agent, handed to it when the agent is free. Also
    needs agent.message and agent.prompt, and your approval of the route on the host."
  - The closing sentence: "All three need an upgraded Atem on the host."
- Node: `export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"`.
- Test databases (a throwaway local Postgres without credentials, provided by the controller):
  - Auth: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55460/agora_auth_test`
  - Portal: `PORTAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55460/agora_portal_test`
- Run tests with `timeout 580` and a tool timeout of 600000 ms. Never leave a run in the background.
- Commits end with `🤖 Built with SMT <smt@agora.build>`. No co-author trailers. No force pushes, `git stash`,
  checkout or reset. Never stage `.superpowers/`.

---

### Task 1: Auth adds `agent.notify` and its requirement

Repository: `~/Dev/Agora.Build/Auth`, branch `feat/notify-scope` (from `main` `2952fe7`).

**Files:**
- Modify: `src/integrations.mjs:6-7` (scope lists) and `:454` (after the `agent.view` check in `createIntegration`)
- Modify: `docs/integrating.md:229` and `:265`
- Test: `tests/integrations.test.mjs:44-49` ("scope lists") and a new test after the test "createIntegration accepts
  agent.launch and agent.message, alone or together, and still requires agent.view" (ends near `:136`)
- Test: `tests/station-resources.test.mjs`, a new test after "an integration gets agent.launch and agent.message only
  when granted them" (`:199-`)

**Interfaces:**
- Produces: `INTEGRATION_SCOPES` = `["agent.view", "agent.prompt", "agent.approve", "agent.interrupt",
  "agent.terminal", "agent.launch", "agent.message", "agent.notify"]`. `STATION_SCOPES` gains `agent.notify` (11).
  `createIntegration` throws `IntegrationError("scope", "agent.notify needs agent.message and agent.prompt.")`.

- [ ] **Step 1: Write the failing tests**

In `tests/integrations.test.mjs`, the body of `test("scope lists", ...)` becomes:

```js
test("scope lists", () => {
  assert.equal(STATION_SCOPES.length, 11);
  assert.ok(["agent.launch", "agent.message", "agent.notify"].every((scope) => STATION_SCOPES.includes(scope)));
  assert.deepEqual(INTEGRATION_SCOPES, ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message", "agent.notify"]);
  assert.equal(DEFAULT_QUOTA_PER_SECOND, 200);
});
```

Add after the test "createIntegration accepts agent.launch and agent.message, alone or together, and still requires
agent.view":

```js
test("createIntegration accepts agent.notify only with agent.message and agent.prompt", async () => {
  const s = await station();
  const make = async (scopes) => store.createIntegration({ owner, stationId: s.id, name: "Notifier", scopes, publicJwk: await publicJwk() });
  for (const scopes of [["agent.view", "agent.prompt", "agent.message", "agent.notify"], ["agent.view", "agent.prompt", "agent.launch", "agent.message", "agent.notify"]]) {
    const { clientId } = await make(scopes);
    assert.deepEqual((await store.integration(clientId)).scopes, scopes, JSON.stringify(scopes));
  }
  for (const scopes of [["agent.view", "agent.notify"], ["agent.view", "agent.message", "agent.notify"], ["agent.view", "agent.prompt", "agent.notify"]]) {
    await assert.rejects(make(scopes), (error) => error instanceof IntegrationError && error.code === "scope" && error.message === "agent.notify needs agent.message and agent.prompt.", JSON.stringify(scopes));
  }
});
```

In `tests/station-resources.test.mjs`, add after the test "an integration gets agent.launch and agent.message only
when granted them":

```js
test("an integration gets agent.notify only when granted it", async () => {
  const store = auth.app.services.integrations;
  const key = await keyPair();
  const { clientId } = await store.createIntegration({ owner: ownerA, stationId: station.id, name: "Notifier", scopes: ["agent.view", "agent.prompt", "agent.message", "agent.notify"], publicJwk: key.jwk, r9Svc: "ef".repeat(32) });
  const granted = await clientCredentials(clientId, key, { resource: STATION, scope: "agent.view agent.prompt agent.message agent.notify" });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(decodeJwt(granted.body.access_token).scope.split(" ").sort(), ["agent.message", "agent.notify", "agent.prompt", "agent.view"]);
  const otherKey = await keyPair();
  const plain = await store.createIntegration({ owner: ownerA, stationId: station.id, name: "Messenger", scopes: ["agent.view", "agent.prompt", "agent.message"], publicJwk: otherKey.jwk, r9Svc: "ef".repeat(32) });
  const refused = await clientCredentials(plain.clientId, otherKey, { resource: STATION, scope: "agent.notify" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid_scope");
});
```

- [ ] **Step 2: Run the tests to check that they fail**

Run: `timeout 580 node --test tests/integrations.test.mjs tests/station-resources.test.mjs`
Expected: FAIL. "scope lists" sees length 10. The new `createIntegration` test is refused for the accepted
combinations. The new token test fails at creation.

- [ ] **Step 3: Write the implementation**

In `src/integrations.mjs`, lines 6–7 become:

```js
export const STATION_SCOPES = Object.freeze(["astation.remote", "station.read", "assistant.chat", "agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message", "agent.notify"]);
export const INTEGRATION_SCOPES = Object.freeze(["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message", "agent.notify"]);
```

In `createIntegration`, right after the line
`if (!scopes.includes("agent.view")) throw new IntegrationError("scope", "An integration needs agent.view.");`, add:

```js
    if (scopes.includes("agent.notify") && !(scopes.includes("agent.message") && scopes.includes("agent.prompt"))) throw new IntegrationError("scope", "agent.notify needs agent.message and agent.prompt.");
```

- [ ] **Step 4: Run the tests to check that they pass**

Run: `timeout 580 node --test tests/integrations.test.mjs tests/station-resources.test.mjs`
Expected: PASS. The existing check `rejects(make(["agent.view", "agent.notify"]), "scope")` still passes, now
because of the requirement.

- [ ] **Step 5: Update the docs**

In `docs/integrating.md`:
- Line 229: the list `…, \`agent.launch\`, \`agent.message\`)` becomes
  `…, \`agent.launch\`, \`agent.message\`, \`agent.notify\`)`.
- Line 265: the list `\`agent.terminal\`, \`agent.launch\`, \`agent.message\`)` gains `, \`agent.notify\``. The
  sentence that starts "`agent.launch` lets the integration start agent sessions" and ends "until then a Station
  grants nothing for them." is replaced by:

  "`agent.launch` lets the integration start agent sessions from profiles the owner approved on a host.
  `agent.message` lets it send messages, context and attachments to the owner's hosts and projects; on their own,
  messages never make an agent act. `agent.notify` lets its messages go to an agent's queue and become that agent's
  work. It needs `agent.message` and `agent.prompt`, and Auth refuses it otherwise. The Station turns them into
  Atem's `launch`, `message` and `notify` permissions once an Atem release that supports them is out; until then a
  Station grants nothing for them."

- [ ] **Step 6: Run the full suite**

Run: `timeout 580 npm test`. Expected: all pass, which is 459 + 2 = 461.

- [ ] **Step 7: Commit**

```bash
git add src/integrations.mjs tests/integrations.test.mjs tests/station-resources.test.mjs docs/integrating.md
git commit -m "Add agent.notify, which needs agent.message and agent.prompt (D28)

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: The Portal offers `agent.notify` and checks its requirement

Repository: `~/Dev/Agora.Build/Portal`, branch `feat/notify-scope` (from `main` `a2087b4`).

**Files:**
- Modify: `scripts/integrations/service.mjs:17` (`SCOPES`) and `:113-119` (`integrationScopes`)
- Modify: `account.html:43` (the third checkbox and the note)
- Modify: `docs/platform.md:813-819`
- Modify: `scripts/browser-smoke-integrations.mjs:67-68` (`FORM_SCOPES`) and `:296-297` (the ticks)
- Test: `tests/integrations-page.test.mjs:46-57` (replace the D28 form test)
- Test: `tests/integrations-service.test.mjs`, a new test after "createIntegration takes agent.launch and
  agent.message, alone or together" (`:74-83`)

**Interfaces:**
- Consumes: Auth (Task 1) accepts `agent.notify` with `agent.message` and `agent.prompt`. The service tests use the
  fake Auth. The browser smoke and e2e (run by the controller) need Task 1's Auth.
- Produces: `POST /api/integrations` refuses `agent.notify` without `agent.message` and `agent.prompt`: 400, code
  `scopes`, message "agent.notify needs agent.message and agent.prompt.".

- [ ] **Step 1: Write the failing tests**

In `tests/integrations-page.test.mjs`, replace the whole test "the integration form offers agent.launch and
agent.message and says they need an upgraded Atem" with:

```js
test("the integration form offers agent.launch, agent.message and agent.notify and says they need an upgraded Atem", async () => {
  const html = await read("account.html");
  const fieldset = html.match(/<fieldset class="token-choice scope-choice"[^>]*>[\s\S]*?<\/fieldset>/)?.[0] || "";
  const values = [...fieldset.matchAll(/name="scope" value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message", "agent.notify"]);
  const note = html.match(/<p class="form-note" id="scope-note">[\s\S]*?<\/p>/)?.[0] || "";
  assert.match(note, /agent\.launch<\/strong>: Start new agent sessions on your hosts, only from profiles you approved there\./);
  assert.match(note, /agent\.message<\/strong>: Send messages, context and attachments to your hosts and projects\. On their own, messages never make an agent act\./);
  assert.match(note, /agent\.notify<\/strong>: Let this app's messages become work for an agent, handed to it when the agent is free\. Also needs agent\.message and agent\.prompt, and your approval of the route on the host\./);
  assert.match(note, /All three need an upgraded Atem on the host\./);
  assert.match(fieldset, /aria-describedby="scope-note"/);
});
```

In `tests/integrations-service.test.mjs`, add after the test "createIntegration takes agent.launch and agent.message,
alone or together":

```js
test("createIntegration takes agent.notify only with agent.message and agent.prompt", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const made = await s.create(OWNER, { scopes: ["agent.prompt", "agent.message", "agent.notify"] });
  assert.deepEqual(s.record(made.id).scopes, ["agent.view", "agent.prompt", "agent.message", "agent.notify"]);
  for (const scopes of [["agent.notify"], ["agent.message", "agent.notify"], ["agent.prompt", "agent.notify"]]) {
    await assert.rejects(s.create(OWNER, { scopes }), (error) => refused(400, "scopes")(error) && error.message === "agent.notify needs agent.message and agent.prompt.", JSON.stringify(scopes));
  }
});
```

- [ ] **Step 2: Run the tests to check that they fail**

Run: `timeout 580 node --test tests/integrations-service.test.mjs tests/integrations-page.test.mjs`
Expected: FAIL. `agent.notify` is not in `SCOPES`, and the form lacks it. Make sure the service test ran rather
than returning early.

- [ ] **Step 3: Write the implementation**

In `scripts/integrations/service.mjs`, line 17 becomes:

```js
const SCOPES = ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message", "agent.notify"];
```

and `integrationScopes` (lines 113–119) becomes:

```js
// Unique scopes from SCOPES; agent.view is always granted, so it is added when missing. agent.notify needs
// agent.message and agent.prompt, as Auth requires.
function integrationScopes(value) {
  if (!Array.isArray(value) || value.some((scope) => !SCOPES.includes(scope)) || new Set(value).size !== value.length) {
    throw failure(400, "Choose scopes from " + SCOPES.join(", ") + ", each at most once.", "scopes");
  }
  const scopes = value.includes("agent.view") ? [...value] : ["agent.view", ...value];
  if (scopes.includes("agent.notify") && !(scopes.includes("agent.message") && scopes.includes("agent.prompt"))) {
    throw failure(400, "agent.notify needs agent.message and agent.prompt.", "scopes");
  }
  return scopes;
}
```

In `account.html` (line 43, which stays one line):
- Right after `<label><input type="checkbox" name="scope" value="agent.message"> agent.message</label>`, add
  `<label><input type="checkbox" name="scope" value="agent.notify"> agent.notify</label>`.
- Replace the contents of `<p class="form-note" id="scope-note">…</p>` with:

```html
<strong>agent.launch</strong>: Start new agent sessions on your hosts, only from profiles you approved there. <strong>agent.message</strong>: Send messages, context and attachments to your hosts and projects. On their own, messages never make an agent act. <strong>agent.notify</strong>: Let this app's messages become work for an agent, handed to it when the agent is free. Also needs agent.message and agent.prompt, and your approval of the route on the host. All three need an upgraded Atem on the host.
```

In `docs/platform.md` (lines 813–819):
- The scope list becomes "…, `agent.terminal`, `agent.launch`, `agent.message` and `agent.notify` (each at most
  once; `agent.view` is always added)".
- The sentence "`agent.launch` and `agent.message` take effect only on a Station and host that support them (an
  upgraded Atem); see D28 in [Portal issue #26](https://github.com/Agora-Build/Portal/issues/26)." becomes:
  "`agent.notify` needs `agent.message` and `agent.prompt`. `agent.launch`, `agent.message` and `agent.notify` take
  effect only on a Station and host that support them (an upgraded Atem); see the D28 contract in
  [Portal issue #25](https://github.com/Agora-Build/Portal/issues/25)."

In `scripts/browser-smoke-integrations.mjs`:
- `FORM_SCOPES` becomes `["agent.view", "agent.prompt", "agent.launch", "agent.message", "agent.notify"]`. Update its
  comment to say it includes the D28 scopes, which a real Auth must accept.
- Right after `await form.getByLabel("agent.launch").check();`, add
  `await form.getByLabel("agent.message").check();` and `await form.getByLabel("agent.notify").check();`.

- [ ] **Step 4: Run the tests to check that they pass**

Run: `timeout 580 node --test tests/integrations-service.test.mjs tests/integrations-page.test.mjs`
Expected: PASS. The existing check that refuses `["agent.notify"]` in the earlier service test still passes, now
because of the requirement.

- [ ] **Step 5: Run the full suite**

Run: `timeout 580 npm test`. Expected: all pass (622 + 1 = 623; the page test is replaced, not added).

- [ ] **Step 6: Commit**

```bash
git add scripts/integrations/service.mjs account.html docs/platform.md scripts/browser-smoke-integrations.mjs tests/integrations-service.test.mjs tests/integrations-page.test.mjs docs/superpowers/plans/2026-11-03-notify-scope.md
git commit -m "Offer agent.notify, which needs agent.message and agent.prompt (D28)

🤖 Built with SMT <smt@agora.build>"
```

---

## Controller checks after both tasks (not for implementers)

1. **The Portal end-to-end run.** Run `npm run test:e2e` with Auth on `feat/notify-scope`.
2. **The browser smoke.** It ticks all three new scopes through the real Auth. It must pass at desktop and both
   mobile widths, with no overflow.
3. **Pull requests.** Open one PR per repository. CI must pass, then squash-merge, Auth first.
4. **Dev deployment.**
   1. Deploy Auth, then the Portal. Keep the rollback images `auth:pre-notify` and `portal:pre-notify`.
   2. Check that the account page shows the third checkbox and the revised note.
   3. Check that existing integrations are unchanged.
   4. Post the result on Auth #14, Portal #25 and #26.
