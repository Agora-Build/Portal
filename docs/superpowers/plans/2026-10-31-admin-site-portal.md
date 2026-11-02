# Admin Site (D26, Portal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Portal follows Agora.Build admins' changes made at Auth: it reads Auth's change feed on Auth's data-less
nudge and about every 30 seconds, records each change in `integration_events` with the admin as actor and the reason,
appends it to the Station's feed and pushes the Station; it shows an admin's pause as "Paused by Agora.Build" with no
Resume (Auth's `409 admin_paused`); it syncs built-in Stations through Auth's account-less listing; and it drops its own
admin views, so `PLATFORM_ADMINS` no longer matters for Stations and integrations.

**Architecture:** A new reader (`scripts/integrations/auth-changes.mjs`) pulls `GET /manage/v1/integration-changes`
one read at a time, coalesced and spaced, keeps Auth's opaque cursor in a one-row table (migration 003), and hands each
entry to `service.applyAuthChange`, which skips the Portal's own changes, applies the rest exactly once inside the
existing event-lock transaction (`appending`), records the event and pushes the Station with the existing `changed()`.
The nudge is `POST /auth/integration-changes` in `scripts/serve.mjs`, a server-to-server route next to the back-channel
logout that only asks the reader for a read. Who paused an integration (`paused_by`, Auth's `pausedBy`) and an owner
account disabled by Agora.Build (`owner_disabled_at`) are two new integration columns; `effectiveState()` shows the
latter as `paused`, which is what the Station already acts on.

**Tech Stack:** Node.js ≥ 20.12 built-ins (`node:http`, `node:crypto`, `node:test`), `pg` 8.16.3, `jose` 6.2.12 (tests
and e2e only), browser DOM. Node 22 for the end-to-end suite and the browser smoke. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-admin-site-portal.md` (verbatim copy of the Agora.Build integrations
design §3.3.4 "The admin site (D26)" with its owner decisions, owner requirements and "Owner decisions after the Auth
review", §3.3.2 (D24) for context, §3.5, §4 D16/D24/D26 and the §6 D24 and D26 work tables). The Auth contract is
`~/Dev/Agora.Build/Auth/docs/superpowers/plans/2026-10-31-admin-mfa-auth.md` on Auth branch `feat/admin-mfa`: rulings
R12 (the Portal cannot act across accounts), R17 (`GET /manage/v1/built-in-stations`), R23–R26 and R29 (the change
feed and the nudge, Task 13), R27–R28 (the admin pause lock, Task 14), notes C4 and C13 (deploy order); and, as built,
`~/Dev/Agora.Build/Auth/src/manage.mjs` and `docs/integrating.md`. Conventions follow
`docs/superpowers/plans/2026-10-30-built-in-station-portal.md`. Out of scope: the admin site itself
(`Agora-Build/Portal-Admin`), passkeys, account administration pages, the Station's session teardown.

## Global Constraints

- Branch: `feat/admin-site-portal`, created from `feat/built-in-station` (Portal PR #22, unmerged):
  `git switch -c feat/admin-site-portal feat/built-in-station`.
- Node.js 20.12+ for the Portal and `npm test`; Node 22 for `npm run test:e2e` and the browser smoke
  (`export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"`). Built-in modules plus the existing dependencies only;
  **no new npm dependencies.** ESM `.mjs` for Node code; two-space indent, double quotes, semicolons (AGENTS.md).
  Restrained palette and the existing CSS classes; semantic HTML and native buttons.
- PostgreSQL tests use `PORTAL_TEST_DATABASE_URL` (database `agora_portal_test`) on the throwaway container
  `pg-auth-phase1`, each test in its own schema. Set it like this and **never print it** (it holds a password):

  ```bash
  export PORTAL_TEST_DATABASE_URL="postgres://postgres:$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' pg-auth-phase1 | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55450/agora_portal_test"
  ```

  The end-to-end suite also needs Auth's `TEST_DATABASE_URL` (never print it either):

  ```bash
  E=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' pg-auth-phase1)
  export TEST_DATABASE_URL="postgres://postgres:$(echo "$E" | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55450/$(echo "$E" | sed -n 's/^POSTGRES_DB=//p')"
  unset E
  ```
  (Read-only `docker inspect`; never start, stop or change a container.)
- **Never touch `portal-postgres`, `portal-local`, `auth-local` or port 3002.** Task 10's rollout steps are
  documentation for the owner, not executed by the implementer. Never read or copy credential values from `~/.config`.
- `npm test` must pass at the end of every task.
- Spec wording that is binding here, verbatim: "Right after a change the Portal did not make (an admin's), Auth sends
  the Portal a nudge. The nudge carries no data; the Portal then reads the feed over its authenticated management
  connection." "The Portal records each change in `integration_events` with the admin as actor and the reason. It then
  appends the change to the Station's feed and pushes the Station, which denies still-valid tokens and closes open
  sessions." "The Portal also polls the feed about every 30 seconds, in case a nudge is lost." "The integration's owner,
  and a custom Station's owner, cannot resume an integration an admin paused: `409 admin_paused`." "The Portal shows
  "Paused by Agora.Build" and offers no Resume." "the startup/hourly sync uses `/manage/v1/built-in-stations` instead of
  listing as the first `PLATFORM_ADMINS` account" "the `station_admin` role, admin notes and admin pause/revoke on
  others' integrations are removed from the account page and the Portal API".
- Exact values: nudge path `/auth/integration-changes` (method `POST`, answer `204`, at most 60 a minute per client
  address); reader timing `pollMs` 30000, `minGapMs` 1000, `pageSize` 100, `pagesPerPull` 10; the 409 message
  `Agora.Build paused this integration. Only Agora.Build can resume it.` with code `admin_paused`; badge text
  `Paused by Agora.Build`; the masked actor and Station-feed reason `agora_build`.
- Auth's contract as the Portal uses it (Auth plan R25–R28): a feed entry is `{ cursor, at, kind, clientId, stationId,
  owner, status, pausedBy, actorAccountId, reason, admin }`, `kind` ∈ `paused`, `resumed`, `revoked`,
  `owner_disabled`, `owner_enabled`; `actorAccountId` is `null` for Auth's own changes; `admin` is `true` only for an
  admin's change through the admin client; `nextCursor` is the last entry's cursor, `after` unchanged when nothing is
  new, `null` before the first change; cursors are opaque. `pausedBy` ∈ `owner`, `station`, `admin`, `null` (only while
  paused) on integrations in Auth's listings, PATCH answers and feed entries (Task 14; absent before it). Resuming an
  admin-paused integration through the Portal client is `409 admin_paused`. `GET /manage/v1/built-in-stations` answers
  `{ stations: [{ id, origin, owner: null, status, reportClientId, createdAt, builtIn: true, access, integrations, name }] }`.
  The nudge is an empty `POST` with no credentials, any `2xx` accepted, redirects not followed, a 3-second timeout.
- Rows are never deleted (D19); `integration_events` stays append-only; every event is appended under the existing
  event lock (`repository.appendEvent`, `lockEvents` first).
- Never log tokens, keys, request bodies, cursors or reasons; log fixed messages with a reason code only
  (`log("…: " + code + ".")`). Account IDs, Station IDs and integration IDs are not secret.
- Commits: imperative subject; the message ends with the line `🤖 Built with SMT <smt@agora.build>`; no co-author
  trailers.

## Design decisions (where the spec left room)

| # | Decision | Why |
|---|---|---|
| A1 | **The nudge endpoint is `POST /auth/integration-changes`** (the `portal` client's `changesNudgeUri`: `https://agora.build/auth/integration-changes`, dev `https://dev.agora.build/auth/integration-changes`; the address Auth's plan uses in its example). It sits in `scripts/serve.mjs` right after `/auth/backchannel-logout`, the other server-to-server route, so the `/api/` same-origin checks don't apply. `204` and nothing read; `405` (`Allow: POST`) for any other method; `429` beyond 60 a minute per client address (the existing `limit()`); `413` with `Connection: close` for any body (`Content-Length` other than `0`, or `Transfer-Encoding`), never reading it; `404` when the Portal has no Stations and integrations. Its only effect is `integrations.nudge()` | The nudge carries nothing to trust (Auth R26). It can only cause reads of the feed over the Portal's own authenticated connection, which are one at a time and at least a second apart (A3), so a forged flood costs at most one management read a second (Auth gives the Portal 6,000 a minute). `/auth/` already holds the Auth-facing routes |
| A2 | **Only changes the Portal did not make are applied.** An entry is the Portal's own when its kind is `paused`, `resumed` or `revoked`, `admin` is not `true` and `actorAccountId` is not `null`: the Portal made it through its routes and recorded it (Auth first, then the Portal). An admin's (`admin: true`), Auth's own (`actorAccountId: null`, e.g. `configuration`) and every `owner_disabled`/`owner_enabled` entry is applied | The feed lists every access change, whoever made it (R25). Re-applying the Portal's own entries in feed order after the Portal has moved on (a pause read after its resume) would flap the integration at the Station. A Portal write that failed after Auth answered is still healed by the owner's next listing, as today |
| A3 | **The reader**: one read at a time per process; a request while one runs makes exactly one more after it; reads start at least `minGapMs` apart; without requests it polls every `pollMs`; a read takes up to `pagesPerPull` pages of `pageSize`, saves Auth's `nextCursor` after each page and asks for another read when every page was full; a failure is logged once per message until a read succeeds and the cursor stays where it was. It starts when the stack is ready (migrations, then the first built-in sync); a nudge makes the stack ready if needed. A resume refused by Auth with `admin_paused` also asks for a read | Spec: push plus poll "about every 30 seconds", "the same push-plus-poll pattern the Portal already uses towards the Station" (the service's `push()` coalesces the same way) |
| A4 | **Each entry is applied once.** The event it writes keeps `details.authCursor` and `details.authAt`; an entry whose cursor and time are already on one of that integration's events is skipped, checked inside the applying transaction after the event lock. The saved cursor is only a read position | Two Portal processes, a crash between applying and saving the cursor, or a reset cursor (A11) all re-read entries; the event lock serialises appliers, so the check is exact. The time tells apart a cursor Auth hands out again after its database was restored |
| A5 | **What an applied entry does** (Auth is authoritative; transitions are checked at time 0, as reconcile does): `paused` → `paused` (resume state kept), `paused_by` = Auth's `pausedBy`; on a row already paused only `paused_by` changes (an admin turning an owner's pause into theirs). `resumed` → back to the resume state, `paused_by` cleared. `revoked` → `revoking`, or `revoked` before approval, as an owner's revoke. `owner_disabled` → `owner_disabled_at` set; `owner_enabled` → cleared. Each appends one event (`integration_paused`, `integration_resumed`, `integration_revoked`, `integration_owner_disabled`, `integration_owner_enabled`) with `actor` the admin (`system` for Auth's own) and `reason` Auth's reason, then pushes the Station. A revoking or revoked row takes only a revocation's record; a row already as the entry says (the owner's listing followed Auth first) still gets the admin's event | Spec: "The Portal records each change in `integration_events` with the admin as actor and the reason. It then appends the change to the Station's feed and pushes the Station" |
| A6 | **Ruling: `owner_disabled`/`owner_enabled` are a per-integration flag, not a Portal pause.** `integrations.owner_disabled_at` is set and cleared by them; while it is set `effectiveState()` answers `paused` (after `revoking`/`revoked` and `expired`), so the account page, `GET /api/v1/integrations` and the Station's feed (`integration.state` and the cursor-0 snapshot) all show `paused`. The row's own state, resume state and `paused_by` stay as they were. The event's `state` is `paused` for `integration_owner_disabled` and the row's state for `integration_owner_enabled` | (1) The Station already denies a `paused` integration's still-valid tokens and closes its sessions (Astation verified pause on 2026-10-30), and the feed contract says to act on the `integration` of an unknown kind: no Station change is needed. (2) Enabling restores each integration exactly, including one its owner had paused (Auth keeps each integration's own status, R24). (3) An access token issued before the disable stays valid until it expires; an owner's listing through it reconciles from Auth, where the status stays `active`, and would "resume" a Portal pause and let the Station accept tokens again; a separate flag is never touched by reconcile |
| A7 | **The admin's account and typed reason stay in the audit.** `integration_events.actor` and `reason` hold them (spec), but the Station's feed gives such an event (`details.admin`) the `reason` `agora_build`, and the account page's history shows it as by `agora_build` with no reason | A custom Station's operator (for `owner_disabled`) and the integration's owner need to know Agora.Build acted, not a moderation note or which admin. Revealing the text later is a one-line change; un-revealing it is impossible (owner note N2) |
| A8 | **`paused_by`** mirrors Auth's `pausedBy` and is read only while the row is paused. The Portal's own pause takes it from Auth's PATCH answer (fallback by role, `owner` or `station`, for an Auth without the lock); A5 and the owner's listing (reconcile follows `pausedBy` while both sides are paused, recorded as an `integration_reconciled` setting) set it; resume and revoke clear it. Views get `pausedBy`: Auth's while paused, and `admin` while `owner_disabled_at` is set | One field tells the page "Paused by Agora.Build" from the Portal's own rows, also when Auth is unreachable and lists are stale |
| A9 | **The lock in the Portal.** `resume` answers `409 admin_paused` before asking Auth when the row is paused by an admin (after the 404/403 checks, so a stranger learns nothing); Auth's own `409 admin_paused` maps to the same answer and asks the reader for a read (the Portal has not heard yet). Revoke, renew, quota and key rotation stay the owner's | Spec "An admin pause locks"; Auth R28 |
| A10 | **No admin powers in the Portal.** The role `station_admin`, `asAdmin` and the service's `admins` go; another account's integration on the built-in Station is 404 for everyone but its owner. The built-in sync reads `GET /manage/v1/built-in-stations` with no actor and keeps its startup, hourly and one-minute-retry schedule. `PLATFORM_ADMINS` itself stays: `scripts/spaces/service.mjs` uses it for Stoa admin rights; it is no longer passed to the integrations stack or documented for it | Spec §3.3.4 "Changes this needs" and the §6 Portal row; Auth R12 already refuses the Portal acting across accounts |
| A11 | **The cursor starts empty** (migration 003): the first read goes through Auth's whole feed once, skipping the Portal's own entries (A2) and applying the rest once (A4). After Auth's database is restored from a backup, the operator empties the Portal's cursor (documented) | Auth's feed is never purged and its cursor is opaque; starting at Auth's current end could miss changes made before the Portal's first read |
| A12 | **The e2e suite makes admin changes through Auth's integration store** (`services.integrations.change(id, { status }, { actor, admin: true, reason })`), the call Auth's admin route makes once its step-up gate has passed; it writes the feed row and sends the real nudge. The admin client's HTTP gate (passkey step-up) is Auth's own test coverage | A passkey sign-in in this harness would copy Auth's private test helpers; the store path exercises everything the Portal depends on |
| A13 | The e2e harness names the nudge address in Auth's clients file only when the Auth checkout has the feed (`src/change-nudge.mjs`), and the D26 e2e tests skip with a reason unless Auth also has the lock (`migrations/009_admin_pause.sql`). Its `nudge: "lost"` option points `changesNudgeUri` at a closed port | Auth is built task by task; an older Auth refuses `changesNudgeUri`. A closed port is a real lost nudge |

## Notes for the owner

| # | Item | Resolution in this plan |
|---|---|---|
| N1 | Spec §3.3.4: "Until it exists, the D24 behaviour stays as deployed: admins act from their own Portal browser session only." Auth `feat/admin-mfa` already refuses the Portal's admin pause and revoke (Auth R12, C4) | The Portal drops its admin views to match (Task 3). On dev, admins have no pause or revoke from that deploy until the admin site is live; integrations are off on the dev built-in Station, so nothing there needs it now |
| N2 | The spec says the reason is recorded; it does not say who may read it | A7: kept in the Portal's events and Auth's audit, not shown to the owner or the Station. Showing it to the owner is one line in `history()` |
| N3 | The Station's feed gains the kinds `integration_owner_disabled` and `integration_owner_enabled` and the reason `agora_build` | Additions the feed contract allows ("New kinds may be added"); Astation should hear of them. Denial needs no Station change (A6) |
| N4 | Deploy order ("Portal first, then Auth with `changesNudgeUri`") | Task 10 documents the order, the transitional log lines and the rollback |

## File structure

| File | Change |
| --- | --- |
| `migrations/003_auth_changes.sql` (new) | `integrations.paused_by`, `integrations.owner_disabled_at`, the one-row `auth_change_feed` |
| `scripts/integrations/repository.mjs` | The new columns; `authChangeCursor`, `saveAuthChangeCursor`, `authChangeApplied` |
| `scripts/integrations/states.mjs` | `effectiveState` shows an owner-disabled integration as `paused` |
| `scripts/integrations/auth-manage.mjs` | `builtInStations()`, `integrationChanges()` |
| `scripts/integrations/auth-changes.mjs` (new) | The reader of Auth's change feed |
| `scripts/integrations/service.mjs` | Built-in sync without admins; no `station_admin`; `pausedBy` and the lock; `applyAuthChange`; masking in the Station's feed and the history |
| `scripts/integrations/routes.mjs` | The stack without admins; the reader started at `ready()`, `nudge()`, `close()`; `CHANGES_NUDGE_PATH`, `NUDGES_PER_MINUTE` |
| `scripts/serve.mjs` | The nudge route; no `admins` for integrations |
| `integrations.js` | No admin note; "Paused by Agora.Build" without Resume; history names Agora.Build |
| `tests/helpers/fake-manage.mjs` | Account-less built-in listing, no built-in admin rights through the Portal, `pausedBy` and the lock, Auth's change feed and admin/system/owner changes |
| `tests/integrations-db.test.mjs`, `tests/integrations-repository.test.mjs`, `tests/integrations-states.test.mjs`, `tests/integrations-auth-manage.test.mjs`, `tests/integrations-stations.test.mjs`, `tests/integrations-service.test.mjs`, `tests/integrations-routes.test.mjs`, `tests/integrations-page.test.mjs` | Updated per task |
| `tests/integrations-admin-changes.test.mjs` (new) | `applyAuthChange` against the database |
| `tests/integrations-auth-changes.test.mjs` (new) | The reader, without a database |
| `tests/e2e/harness.mjs`, `tests/e2e/built-in-station.e2e.mjs` | No `PLATFORM_ADMINS`; the nudge address; `adminChange`, `portalQuery`; D26 flows |
| `scripts/browser-smoke-integrations.mjs` | "Paused by Agora.Build" row |
| `docs/platform.md`, `README.md` | Contract, operations, rollout and rollback |

---

### Task 1: Who paused, the owner's disabled flag and Auth's feed cursor in the database

**Files:**
- Create: `migrations/003_auth_changes.sql`
- Modify: `scripts/integrations/repository.mjs` (`updatable`, the constants, `integrationRow`, `updateIntegration`, three
  methods after `latestCursor`)
- Modify: `scripts/integrations/states.mjs:22-25` (`effectiveState`)
- Modify: `docs/platform.md` ("Database And Settings" table)
- Test: `tests/integrations-db.test.mjs`, `tests/integrations-repository.test.mjs`, `tests/integrations-states.test.mjs`

**Interfaces:**
- Produces:
  ```js
  // integration rows (repository.integration, integrationForUpdate, integrationsFor, integrationsOnStation) gain
  //   pausedBy: "owner" | "station" | "admin" | null, ownerDisabledAt: string (ISO 8601) | null
  repository.updateIntegration(id, { pausedBy, ownerDisabledAt /* Date | number | string | null */, ...existing }, client?)
  repository.authChangeCursor(client?): Promise<string | null>
  repository.saveAuthChangeCursor(cursor: string, client?): Promise<void>   // TypeError unless /^[A-Za-z0-9_-]{1,64}$/
  repository.authChangeApplied(integrationId: string, cursor: string, at: string, client?): Promise<boolean>
  effectiveState(row, now) // "paused" while row.ownerDisabledAt != null (revoking/revoked and expired take precedence)
  ```

- [ ] **Step 1: Write the failing database tests.** In `tests/integrations-db.test.mjs`:
  - In "migrate applies each migration once, even when two instances race", both expected lists become
    `["001_integrations.sql", "002_built_in_stations.sql", "003_auth_changes.sql"]`.
  - In "migration 002 leaves an existing database's custom Stations, integrations and events as they were", the
    `integrations:` line of `snapshot` becomes (003 adds columns, so `SELECT *` would differ):

```js
    integrations: (await db.pool.query("SELECT id, owner_account, station_id, kind, name, scopes, state, resume_state, r9_svc, quota_per_second, expires_at, approved_by, approved_at, last_error, created_at, updated_at FROM integrations ORDER BY id")).rows,
```

    and `assert.deepEqual(await db.migrate(), ["002_built_in_stations.sql"]);` becomes
    `assert.deepEqual(await db.migrate(), ["002_built_in_stations.sql", "003_auth_changes.sql"]);`.
  - Append:

```js
test("migration 003 adds who paused and when the owner was disabled, keeps every row, and starts Auth's feed cursor empty", async (t) => {
  const open = await emptySchema(t);
  if (!open) return t.skip("PORTAL_TEST_DATABASE_URL is not set");
  const db = open();
  // A database that has run 001 and 002, with a Station, a paused integration and its event.
  await db.transaction(async (client) => {
    await client.query("CREATE TABLE portal_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of ["001_integrations.sql", "002_built_in_stations.sql"]) {
      await client.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
      await client.query("INSERT INTO portal_migrations (version) VALUES ($1)", [file]);
    }
  });
  await db.pool.query("INSERT INTO stations (id, origin, owner_account, report_client_id, status, verified_at) VALUES ('st1', 'https://a.example', 'ab1', 's-st1', 'active', '2026-10-01T00:00:00Z')");
  await db.pool.query("INSERT INTO integrations (id, owner_account, station_id, kind, name, scopes, state, resume_state, quota_per_second, expires_at) VALUES ('i-1', 'ab1', 'st1', 'custom_app', 'App', '{agent.view}', 'paused', 'ready', 200, '2027-01-01T00:00:00Z')");
  await db.pool.query("INSERT INTO integration_events (at, station_id, integration_id, account_id, actor, kind, state) VALUES ('2026-10-03T00:00:00Z', 'st1', 'i-1', 'ab1', 'ab1', 'integration_paused', 'paused')");
  const integrations = (await db.pool.query("SELECT * FROM integrations")).rows;
  const events = (await db.pool.query("SELECT * FROM integration_events")).rows;
  assert.deepEqual(await db.migrate(), ["003_auth_changes.sql"]);
  const after = (await db.pool.query("SELECT * FROM integrations")).rows;
  assert.deepEqual(after.map(({ paused_by, owner_disabled_at, ...rest }) => rest), integrations);
  assert.deepEqual(after.map((row) => [row.paused_by, row.owner_disabled_at]), [[null, null]], "a pause from before 003 names nobody");
  assert.deepEqual((await db.pool.query("SELECT * FROM integration_events")).rows, events);
  assert.deepEqual((await db.pool.query("SELECT id, cursor FROM auth_change_feed")).rows, [{ id: true, cursor: null }]);
  await assert.rejects(db.pool.query("UPDATE integrations SET paused_by = 'someone'"), { code: "23514" });
  await assert.rejects(db.pool.query("UPDATE auth_change_feed SET cursor = 'not a cursor'"), { code: "23514" });
  await assert.rejects(db.pool.query("INSERT INTO auth_change_feed (id) VALUES (false)"), { code: "23514" });
  await assert.rejects(db.pool.query("INSERT INTO auth_change_feed (id) VALUES (true)"), { code: "23505" });
});
```

- [ ] **Step 2: Write the failing repository and state tests.** Append to `tests/integrations-repository.test.mjs`:

```js
test("integrations carry who paused them and when Auth said their owner was disabled", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  await station(repo, "st1");
  await repo.insertIntegration(sample("i-1"));
  const fresh = await repo.integration("i-1");
  assert.deepEqual([fresh.pausedBy, fresh.ownerDisabledAt], [null, null]);
  await db.transaction((client) => repo.updateIntegration("i-1", { state: "paused", resumeState: "ready", pausedBy: "admin", ownerDisabledAt: NOW }, client));
  const paused = await repo.integration("i-1");
  assert.deepEqual([paused.state, paused.pausedBy, paused.ownerDisabledAt], ["paused", "admin", new Date(NOW).toISOString()]);
  await repo.updateIntegration("i-1", { pausedBy: null, ownerDisabledAt: null });
  const cleared = await repo.integration("i-1");
  assert.deepEqual([cleared.pausedBy, cleared.ownerDisabledAt], [null, null]);
  await assert.rejects(repo.updateIntegration("i-1", { pausedBy: "someone" }), { code: "23514" });
});

test("Auth's change feed cursor starts empty and is saved as given; an applied change is found by its cursor and time", async (t) => {
  const { repo, db } = await setup(t);
  if (!repo) return;
  assert.equal(await repo.authChangeCursor(), null);
  await repo.saveAuthChangeCursor("YzEy");
  assert.equal(await repo.authChangeCursor(), "YzEy");
  for (const bad of ["", "has space", "x".repeat(65), 12, null]) await assert.rejects(repo.saveAuthChangeCursor(bad), TypeError, JSON.stringify(bad));
  assert.equal(await repo.authChangeCursor(), "YzEy");
  await station(repo, "st1");
  const at = "2026-10-31T10:00:00.000Z";
  assert.equal(await repo.authChangeApplied("i-1", "YzEy", at), false);
  await db.transaction((client) => repo.appendEvent({ stationId: "st1", integrationId: "i-1", accountId: "ab1", actor: "system", kind: "integration_paused", details: { authCursor: "YzEy", authAt: at } }, client));
  assert.equal(await repo.authChangeApplied("i-1", "YzEy", at), true);
  assert.equal(await repo.authChangeApplied("i-1", "YzEy", "2026-10-31T11:00:00.000Z"), false, "the same cursor at another time is another change (Auth's database was restored)");
  assert.equal(await repo.authChangeApplied("i-2", "YzEy", at), false);
});
```

  Append to `tests/integrations-states.test.mjs`:

```js
test("effectiveState shows an integration whose owner Agora.Build disabled as paused, after revocation and expiry", () => {
  const past = new Date(NOW - 1000).toISOString();
  const disabled = { ownerDisabledAt: new Date(NOW - 5000).toISOString() };
  assert.equal(effectiveState(row("ready", disabled), NOW), "paused");
  assert.equal(effectiveState(row("awaiting_approval", disabled), NOW), "paused");
  assert.equal(effectiveState(row("paused", disabled), NOW), "paused");
  assert.equal(effectiveState(row("ready", { ...disabled, expiresAt: past }), NOW), "expired");
  assert.equal(effectiveState(row("revoking", disabled), NOW), "revoking");
  assert.equal(effectiveState(row("revoked", disabled), NOW), "revoked");
  assert.equal(effectiveState(row("ready", { ownerDisabledAt: null }), NOW), "ready");
  // Transitions follow the row's own state: a disabled owner is not a pause of the row.
  assert.deepEqual(transition(row("ready", disabled), "pause", NOW), { state: "paused", resumeState: "ready" });
});
```

- [ ] **Step 3: Run the tests to see them fail.**
  Run: `node --test tests/integrations-db.test.mjs tests/integrations-repository.test.mjs tests/integrations-states.test.mjs`
  Expected: FAIL: the migration lists (no `003_auth_changes.sql`), "migration 003 …" (`relation "auth_change_feed"
  does not exist`), the repository tests (`repo.authChangeCursor is not a function`, `Cannot update integration field
  pausedBy`), the state test (`"ready"` instead of `"paused"`).

- [ ] **Step 4: Create `migrations/003_auth_changes.sql`.**

```sql
-- Admin changes from Auth (Agora.Build integrations design §3.3.4, D26, owner decisions after the Auth review): the
-- Portal reads Auth's change feed and follows each change on its own rows (scripts/integrations/auth-changes.mjs,
-- service.applyAuthChange).
SET LOCAL lock_timeout = '5s';

-- Who paused a paused integration, as Auth answers it (pausedBy): its owner, its custom Station's owner, or an
-- Agora.Build admin, whose pause only an admin lifts. NULL when nobody is recorded; read only while state is 'paused'.
ALTER TABLE integrations ADD COLUMN paused_by text CHECK (paused_by IN ('owner', 'station', 'admin'));
-- Set while Auth's feed says the integration's owner account is disabled (owner_disabled, until owner_enabled). Auth
-- issues it no token meanwhile; the Portal and the Station's feed show it as paused (states.mjs effectiveState).
ALTER TABLE integrations ADD COLUMN owner_disabled_at timestamptz;

-- Where the Portal is in Auth's change feed: Auth's opaque cursor after the last page it read, NULL before the first.
-- Exactly one row.
CREATE TABLE auth_change_feed (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cursor text CHECK (cursor ~ '^[A-Za-z0-9_-]{1,64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO auth_change_feed (id) VALUES (true);
```

- [ ] **Step 5: `scripts/integrations/repository.mjs`.**
  - `updatable` gains two entries after `lastError: "last_error"`:

```js
  lastError: "last_error",
  pausedBy: "paused_by",
  ownerDisabledAt: "owner_disabled_at"
```

  - After `function cursorNumber(cursor) { … }` add:

```js
// Auth's change feed cursor: opaque to the Portal, base64url as Auth hands it out.
const AUTH_CURSOR = /^[A-Za-z0-9_-]{1,64}$/;
```

  - In `integrationRow`, after `lastError: row.last_error,` add:

```js
    pausedBy: row.paused_by ?? null,
    ownerDisabledAt: iso(row.owner_disabled_at) ?? null,
```

  - In `updateIntegration`, the line
    `values.push(key === "expiresAt" || key === "approvedAt" ? (value === null ? null : when(value)) : value);` becomes
    `values.push(key === "expiresAt" || key === "approvedAt" || key === "ownerDisabledAt" ? (value === null ? null : when(value)) : value);`.
  - `latestCursor` is the object's last method and has no trailing comma: put a comma after its closing brace, then
    add:

```js
    // Where the Portal is in Auth's change feed (auth-changes.mjs): Auth's opaque cursor, or null before the first page.
    async authChangeCursor(client) {
      const { rows } = await run(client, "SELECT cursor FROM auth_change_feed WHERE id");
      return rows[0]?.cursor ?? null;
    },

    async saveAuthChangeCursor(cursor, client) {
      if (typeof cursor !== "string" || !AUTH_CURSOR.test(cursor)) throw new TypeError("An Auth change cursor is 1 to 64 base64url characters.");
      await run(client, "UPDATE auth_change_feed SET cursor = $1, updated_at = now() WHERE id", [cursor]);
    },

    // Whether an entry of Auth's change feed was already applied to this integration: its cursor and time are kept in
    // the details of the event it wrote (service.applyAuthChange). The time tells apart a cursor Auth hands out again
    // after its database was restored from a backup.
    async authChangeApplied(integrationId, cursor, at, client) {
      const { rows } = await run(client, "SELECT 1 FROM integration_events WHERE integration_id = $1 AND details->>'authCursor' = $2 AND details->>'authAt' = $3 LIMIT 1", [integrationId, cursor, at]);
      return rows.length > 0;
    }
```

- [ ] **Step 6: `scripts/integrations/states.mjs`.** `effectiveState` and its comment become:

```js
// The state as shown and as Stations see it: expired for anything not yet revoking, and paused while Auth's change feed
// says the owner's account is disabled (Auth issues the integration no token then; spec §3.3.4), whatever the row's own
// state. Transitions use the row's own state.
export function effectiveState(row, now) {
  if (row.state === "revoking" || row.state === "revoked") return row.state;
  if (row.expiresAt != null && new Date(row.expiresAt).getTime() <= now) return "expired";
  if (row.ownerDisabledAt != null) return "paused";
  return row.state;
}
```

- [ ] **Step 7: Run the tests to see them pass.**
  Run: `node --test tests/integrations-db.test.mjs tests/integrations-repository.test.mjs tests/integrations-states.test.mjs`
  Expected: PASS.

- [ ] **Step 8: `docs/platform.md`, "Database And Settings".** The `integrations` row becomes
  ``| `integrations` | Auth's `i-` client ID, owner, Station, scopes, state, `resume_state`, `r9_svc`, quota, expiry, `last_error`, `paused_by` (who paused it, as Auth says: `owner`, `station` or `admin`), `owner_disabled_at` (while Agora.Build has the owner's account disabled) |``
  and after the `integration_events` row add
  ``| `auth_change_feed` | one row: where the Portal is in Auth's change feed (Auth's cursor) |``.

- [ ] **Step 9: Run the whole suite.** Run: `npm test`. Expected: PASS.

- [ ] **Step 10: Commit.**

```bash
git add migrations/003_auth_changes.sql scripts/integrations/repository.mjs scripts/integrations/states.mjs docs/platform.md tests/integrations-db.test.mjs tests/integrations-repository.test.mjs tests/integrations-states.test.mjs
git commit -F - <<'EOF'
Keep who paused an integration, a disabled owner and Auth's feed cursor

🤖 Built with SMT <smt@agora.build>
EOF
```

---
### Task 2: Sync built-in Stations through Auth's account-less listing

**Files:**
- Modify: `scripts/integrations/auth-manage.mjs` (the returned object: `builtInStations`)
- Modify: `scripts/integrations/service.mjs:831-852` (`syncBuiltIn` and its comment)
- Modify: `scripts/integrations/routes.mjs:38-49` (the built-in sync schedule and its comment)
- Modify: `tests/helpers/fake-manage.mjs` (`gate` split into `open` and `gate`; `builtInStations`)
- Modify: `docs/platform.md` ("The Built-in Station", the **Sync.** bullet)
- Test: `tests/integrations-auth-manage.test.mjs`, `tests/integrations-stations.test.mjs`, `tests/integrations-routes.test.mjs`

**Interfaces:**
- Consumes: Auth `GET /manage/v1/built-in-stations` (Auth R17, built: any management client, no actor).
- Produces:
  ```js
  manage.builtInStations(): Promise<Station[]>          // Auth's { stations } answer; bad_response unless an array
  service.syncBuiltIn(): Promise<boolean>               // no admins; never throws; logs "Built-in Station sync failed: <code>."
  // fake-manage: auth.open(name, check?) (a call without an actor), auth.builtInStations()
  ```
  `createIntegrationStack` still accepts `admins` after this task (removed in Task 3); the sync no longer uses it.

- [ ] **Step 1: Write the failing client test.** Append to `tests/integrations-auth-manage.test.mjs`:

```js
test("builtInStations lists Auth's built-in Stations without naming an account", async () => {
  const station = { id: "st1", origin: "https://station.agora.build", owner: null, status: "active", reportClientId: "s-x", createdAt: "2026-10-30T00:00:00Z", builtIn: true, access: "any_account", integrations: false, name: "Agora Station" };
  const s = stub({ stations: [station] });
  assert.deepEqual(await clientWith(s).builtInStations(), [station]);
  assert.deepEqual([s.calls[0].method, s.calls[0].url, s.calls[0].body], ["GET", issuer + "/manage/v1/built-in-stations", undefined]);
  await assert.rejects(clientWith(stub({ nope: [] })).builtInStations(), (error) => error instanceof ManageError && error.code === "bad_response");
});
```

- [ ] **Step 2: Write the failing sync tests.** In `tests/integrations-stations.test.mjs`, delete the line
  `const ADMIN = "ab" + "0".repeat(25) + "4";` and the two tests "syncBuiltIn brings the built-in Stations in as the
  first admin, follows their settings and adds nothing else" and "syncBuiltIn without admins asks nothing, and with
  Auth down changes nothing; both are logged by reason"; put in their place:

```js
test("syncBuiltIn brings in the built-in Stations from Auth's listing that names no account, follows their settings and adds nothing else", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  await s.manage.registerStation({ origin: "https://custom.example", owner: OWNER, reportKey: REPORT_KEY, actor: OWNER });
  assert.equal(await s.service.syncBuiltIn(), true);
  assert.deepEqual(s.manage.calls.filter((name) => name !== "registerStation"), ["builtInStations"], "no account's listing is asked for");
  assert.deepEqual((await s.repository.builtInStations()).map((station) => [station.id, station.reportClientId, station.integrationsEnabled]), [[built.id, built.reportClientId, false]]);
  assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM stations WHERE NOT built_in")).rows[0].n, 0, "custom Stations are left to their accounts' listings");
  assert.equal((await s.repository.stationByReportClient(built.reportClientId)).id, built.id, "its report client is known without anyone signing in");
  built.integrations = true;
  assert.equal(await s.service.syncBuiltIn(), true);
  assert.equal((await s.repository.station(built.id)).integrationsEnabled, true);
  assert.equal((await s.events("station_reconciled")).length, 1, "inserted once");
});

test("syncBuiltIn with Auth down, or an Auth without the listing, changes nothing and is logged by reason", async (t) => {
  const s = await setup(t);
  if (!s) return;
  s.manage.seedBuiltIn();
  s.manage.down = true;
  assert.equal(await s.service.syncBuiltIn(), false);
  assert.ok(s.logs.includes("Built-in Station sync failed: unavailable."));
  s.manage.down = false;
  s.manage.failNext.builtInStations = { status: 404, code: "not_found" };
  assert.equal(await s.service.syncBuiltIn(), false);
  assert.ok(s.logs.includes("Built-in Station sync failed: not_found."));
  assert.deepEqual(await s.repository.builtInStations(), []);
});
```

  In "a sync whose listing lacks a built-in Station removes nothing and revokes nothing",
  `const s = await setup(t, { admins: [ADMIN] });` becomes `const s = await setup(t);`.

  In `tests/integrations-routes.test.mjs`, replace the three tests "the stack syncs the built-in Stations from Auth once
  when it becomes ready, as the first platform admin", "the stack is ready even when the first built-in sync fails,
  retries it a minute later, and close() stops the syncs" and "without platform admins the skipped sync keeps the hourly
  schedule, so it is logged at most once an hour" with:

```js
test("the stack syncs the built-in Stations from Auth once when it becomes ready, naming no account", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const manage = fakeManage();
  const built = manage.seedBuiltIn();
  const integrations = createIntegrationStack({ db, manage, idp: null, log: () => {} });
  const listings = () => manage.calls.filter((name) => name === "builtInStations").length;
  assert.equal(listings(), 0, "nothing before the first request");
  await integrations.ready();
  assert.equal(listings(), 1);
  assert.equal(manage.calls.includes("stations"), false, "no account's listing");
  assert.deepEqual((await db.pool.query("SELECT id, built_in, report_client_id FROM stations")).rows, [{ id: built.id, built_in: true, report_client_id: built.reportClientId }]);
  await integrations.ready();
  assert.equal(listings(), 1, "memoised with ready()");
});

test("the stack is ready even when the first built-in sync fails, retries it a minute later, and close() stops the syncs", async () => {
  const db = { async migrate() { return []; }, async ensureEventPartitions() { return []; }, async close() {} };
  const manage = fakeManage();
  let listings = 0;
  manage.builtInStations = async () => { listings += 1; throw new ManageError(503, "unavailable"); };
  const logs = [];
  const integrations = createIntegrationStack({ db, manage, idp: null, log: (line) => logs.push(line), builtInSyncAfter: { ok: 3600000, failed: 20 } });
  assert.equal(typeof (await integrations.ready()).stations, "function", "ready despite Auth refusing the listing");
  assert.deepEqual([listings, logs.filter((line) => line.startsWith("Built-in"))], [1, ["Built-in Station sync failed: unavailable."]]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(listings >= 2, "a failed sync is retried soon, not an hour later");
  await integrations.close();
  const after = listings;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(listings, after, "no sync after close()");
});

test("a successful built-in sync is repeated on the hourly schedule, with no platform admins anywhere", async () => {
  // A database whose every query finds nothing: enough for the built-in part of reconcile.
  const db = { pool: { async query() { return { rows: [] }; } }, async migrate() { return []; }, async ensureEventPartitions() { return []; }, async close() {} };
  const manage = fakeManage();
  let listings = 0;
  manage.builtInStations = async () => { listings += 1; return []; };
  const integrations = createIntegrationStack({ db, manage, idp: null, log: () => {}, builtInSyncAfter: { ok: 20, failed: 3600000 } });
  await integrations.ready();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(listings >= 2, "synced again on the ok schedule (" + listings + ")");
  await integrations.close();
});
```

- [ ] **Step 3: Run the tests to see them fail.**
  Run: `node --test tests/integrations-auth-manage.test.mjs tests/integrations-stations.test.mjs tests/integrations-routes.test.mjs`
  Expected: FAIL (`builtInStations is not a function` on the client and the fake; the service still logs
  "Built-in Station sync skipped: no PLATFORM_ADMINS.").

- [ ] **Step 4: `scripts/integrations/auth-manage.mjs`.** In the returned object, after the `stations` line add:

```js
    // The active built-in Stations, naming no account (D26): the Portal's startup and hourly sync.
    async builtInStations() { return list(await call("GET", "/built-in-stations"), "stations"); },
```

- [ ] **Step 5: `tests/helpers/fake-manage.mjs`.** Replace `gate` with:

```js
    // A management call: recorded, refused while Auth is down, then `check` (the actor rules), then a failNext.
    async open(name, check = () => {}) {
      auth.calls.push(name);
      if (auth.down) fail(503, "unavailable");
      check();
      const failure = auth.failNext[name];
      if (failure) {
        delete auth.failNext[name];
        fail(failure.status, failure.code);
      }
    },
    async gate(name, actor, ...accounts) {
      await auth.open(name, () => { if (![actor, ...accounts].every(valid)) fail(400, "invalid_request"); });
    },
```

  and after the `stations` method add:

```js
    // GET /manage/v1/built-in-stations: the active built-in Stations, for any management client, naming no account.
    async builtInStations() {
      await auth.open("builtInStations");
      return stations.filter((entry) => entry.builtIn && entry.status === "active").map(listedStation);
    },
```

- [ ] **Step 6: `scripts/integrations/service.mjs`.** `syncBuiltIn` and its comment become:

```js
    // The built-in Stations as Auth lists them naming no account (GET /manage/v1/built-in-stations, spec §3.3.4), so
    // their report clients are known before anyone signs in. Only the built-in part of reconcile runs: nothing is
    // removed or revoked on absence. Never throws; returns whether it synced. Run by the stack at ready(), hourly, and
    // a minute after a failure.
    async syncBuiltIn() {
      try {
        const listed = (await manage.builtInStations()).filter((entry) => entry.builtIn === true);
        const known = new Set(listed.map((entry) => entry.id));
        for (const station of await repository.builtInStations()) {
          if (!known.has(station.id)) log("Built-in Station absent from Auth's listing: left as it is.");
        }
        for (const entry of listed) await reconcileBuiltIn(entry);
        return true;
      } catch (error) {
        log("Built-in Station sync failed: " + (error instanceof ManageError ? error.code : error.code || "error") + ".");
        return false;
      }
    },
```

- [ ] **Step 7: `scripts/integrations/routes.mjs`.** The block from `// The built-in Stations, synced from Auth once the
  stack is ready` through `builtInSync.unref();\n  };` becomes:

```js
  // The built-in Stations, synced from Auth's account-less listing once the stack is ready and then hourly (P17, D26);
  // a failed sync is logged by syncBuiltIn and tried again a minute later. ready() waits for the first sync, which is
  // bounded by the management call's 10 s timeout plus the database statements of reconciling (each within
  // statement_timeout).
  let builtInSync = null;
  let closed = false;
  const syncBuiltIn = async () => {
    const synced = await service.syncBuiltIn();
    if (closed) return;
    builtInSync = setTimeout(syncBuiltIn, synced ? builtInSyncAfter.ok : builtInSyncAfter.failed);
    builtInSync.unref();
  };
```

- [ ] **Step 8: Run the tests to see them pass.**
  Run: `node --test tests/integrations-auth-manage.test.mjs tests/integrations-stations.test.mjs tests/integrations-routes.test.mjs`
  Expected: PASS.

- [ ] **Step 9: `docs/platform.md`.** The **Sync.** bullet of "The Built-in Station" becomes:

```markdown
- **Sync.** The Portal learns of built-in Stations from Auth itself: when the Stations and integrations stack becomes
  ready (the first request to one of their routes, which waits for it) and then hourly, it reads Auth's listing of
  built-in Stations, which names no account (`GET /manage/v1/built-in-stations`), and adds or updates them, never
  removing one. With Auth unreachable, or an Auth without that listing (404), the log says so by reason and the sync
  is tried again a minute later (hourly again once it succeeds); every account's own listing also syncs them. The
  first sync holds the first request for up to Auth's 10-second management timeout plus the database writes it makes.
  A report client the Portal does not know answers 403 `station`.
```

- [ ] **Step 10: Run the whole suite.** Run: `npm test`. Expected: PASS.

- [ ] **Step 11: Commit.**

```bash
git add scripts/integrations/auth-manage.mjs scripts/integrations/service.mjs scripts/integrations/routes.mjs tests/helpers/fake-manage.mjs docs/platform.md tests/integrations-auth-manage.test.mjs tests/integrations-stations.test.mjs tests/integrations-routes.test.mjs
git commit -F - <<'EOF'
Sync built-in Stations through Auth's listing that names no account

🤖 Built with SMT <smt@agora.build>
EOF
```

---

### Task 3: No admin powers in the Portal

**Files:**
- Modify: `scripts/integrations/service.mjs` (the `createIntegrationService` parameters; `access` and its comment;
  `integrations` and its comment)
- Modify: `scripts/integrations/routes.mjs` (`createIntegrationStack`, `integrationsFromEnv`, the `GET /api/integrations`
  handler)
- Modify: `scripts/serve.mjs:135-137` (the integrations stack from the environment)
- Modify: `integrations.js:317-318`, `integrations.js:455`
- Modify: `tests/helpers/fake-manage.mjs` (header comment; the Station-owner right in `changeIntegration`)
- Modify: `tests/e2e/harness.mjs` (header comment, `startPortal`, `startStack`), `tests/e2e/built-in-station.e2e.mjs`
  (tests 1 and 8)
- Modify: `docs/platform.md` ("The Built-in Station" **Admins.** bullet, the routes table, "Verification")
- Test: `tests/integrations-service.test.mjs`, `tests/integrations-stations.test.mjs`, `tests/integrations-routes.test.mjs`,
  `tests/integrations-page.test.mjs`

**Interfaces:**
- Consumes: Task 2's account-less `syncBuiltIn`.
- Produces:
  ```js
  createIntegrationService({ repository, db, manage, stationFetch, exchange, now, log, ids, challengeValue, pushFetch, notify })
  service.integrations(accountId): Promise<{ integrations, stale }>   // roles "owner" and "station_owner" only
  createIntegrationStack({ db, manage, idp, log, stationFetch, pushFetch, builtInSyncAfter })
  integrationsFromEnv(env, { idp, log, stationFetch, pushFetch })
  // e2e: startStack(lib, { integrations, builtIn }) no longer sets PLATFORM_ADMINS for the Portal
  ```

- [ ] **Step 1: Write the failing tests.**
  - `tests/integrations-service.test.mjs`: the setup's first line
    `async function setup(t, { wrap = (repository) => repository, admins = [] } = {}) {` becomes
    `async function setup(t, { wrap = (repository) => repository } = {}) {`, and in its `createIntegrationService` call
    `notify: (stationId) => notified.push(stationId), admins` becomes `notify: (stationId) => notified.push(stationId)`.
    Replace the test "Agora.Build admins see others' integrations on the built-in Station and may pause or revoke
    them, nothing else" with:

```js
test("an Agora.Build admin is just another account in the Portal: their own integrations only, no rights on others' on the built-in Station", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  const theirs = await onBuiltIn(s, built, OWNER);
  const own = await onBuiltIn(s, built, ADMIN);
  assert.deepEqual((await s.service.integrations(ADMIN)).integrations.map((entry) => [entry.id, entry.role]), [[own.id, "owner"]]);
  const calls = s.manage.calls.length;
  for (const call of [() => s.service.pause(ADMIN, theirs.id), () => s.service.revoke(ADMIN, theirs.id), () => s.service.resume(ADMIN, theirs.id), () => s.service.history(ADMIN, theirs.id)]) {
    await assert.rejects(call(), refused(404, "not_found"));
  }
  assert.equal(s.manage.calls.length, calls, "Auth is not asked");
  // Auth refuses the Portal acting for an admin on someone else's integration (Auth D26 R12).
  await assert.rejects(s.manage.changeIntegration(theirs.id, { status: "paused" }, ADMIN), (error) => error.status === 403 && error.code === "forbidden");
  assert.equal(s.record(theirs.id).status, "active");
});
```

  - `tests/integrations-stations.test.mjs`: the setup's first line becomes
    `async function setup(t, { wrap = (repository) => repository } = {}) {` and its call's
    `admins, log: (line) => logs.push(line)` becomes `log: (line) => logs.push(line)`.
  - `tests/integrations-routes.test.mjs`: `async function stack(t, { admins = [] } = {}) {` becomes
    `async function stack(t) {`, and its `createIntegrationService(…, log: () => {}, admins })` becomes
    `createIntegrationService({ repository: createRepository(db), db, manage, stationFetch, pushFetch, exchange, log: () => {} })`.
    Delete the test "the stack hands the platform admins to the service". In "the built-in Station's own report token
    reads and reports a feed of every integration on it, and only those", replace its first three lines with:

```js
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
```

    Replace the test "an admin's bearer token lists only the admin's own built-in integrations; only the browser
    session shows others' and acts on them" with:

```js
test("an Agora.Build admin's browser session and tokens list only the admin's own integrations; others' on the built-in Station are 404", async (t) => {
  const admin = accountId();
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true, admins: [admin] });
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  const boss = await signIn(app, admin);
  assert.equal((await call(app.base, "/api/stations", { cookie: owner.cookie })).status, 200);
  const create = async (cookie) => (await (await call(app.base, "/api/integrations", { cookie, method: "POST", data: { stationId: built.id, name: "Hosted", scopes: ["agent.view"], publicJwk: publicJwk() } })).json()).id;
  const theirs = await create(owner.cookie);
  const own = await create(boss.cookie);
  const roles = async (response) => (await response.json()).integrations.map((entry) => [entry.id, entry.role]);
  assert.deepEqual(await roles(await call(app.base, "/api/integrations", { cookie: boss.cookie })), [[own, "owner"]]);
  const bearer = await app.fake.issueAccessToken({ sub: admin, scope: "integrations:read integrations:approve" });
  assert.deepEqual(await roles(await call(app.base, "/api/v1/integrations", { bearer })), [[own, "owner"]]);
  for (const action of ["pause", "revoke", "resume"]) assert.equal((await call(app.base, "/api/integrations/" + theirs + "/" + action, { cookie: boss.cookie, method: "POST" })).status, 404, action);
  assert.equal((await call(app.base, "/api/integrations/" + theirs + "/events", { cookie: boss.cookie })).status, 404);
  assert.equal((await integrations.service.integrations(owner.sub)).integrations[0].state, "awaiting_approval", "nothing changed");
  await integrations.service._pushesIdle();
});
```

  - `tests/integrations-page.test.mjs`, in "the built-in Station shows as Built in with Details only, …", the line
    `assert.match(script, /As an Agora\.Build admin you can pause or revoke it\./);` becomes
    `assert.doesNotMatch(script, /station_admin|As an Agora\.Build admin/, "admins act on the admin site, never here (D26)");`.

- [ ] **Step 2: Run the tests to see them fail.**
  Run: `node --test tests/integrations-service.test.mjs tests/integrations-routes.test.mjs tests/integrations-page.test.mjs`
  Expected: FAIL: the fake still gives a built-in Station's admins the Station-owner right (the admin's pause reaches
  Auth and succeeds there); the admin's session still lists `station_admin` rows; the script still has the admin note.

- [ ] **Step 3: `tests/helpers/fake-manage.mjs`.** In the header comment, `and admins who may pause or revoke others'
  integrations on them` becomes `and admins, who have no rights on them through the Portal (Auth D26 R12)`. In
  `changeIntegration`, the two lines

```js
      // The Station-owner rights: the owner of a custom Station, the configured admins of a built-in one.
      const stationRights = station.builtIn ? station.admins : [station.owner];
```

  become

```js
      // The Station-owner right: the owner of a custom Station may pause or revoke. A built-in Station's admins act
      // through Auth's admin client only (Auth D26 R12): through the Portal an admin is just another account.
      const stationRights = station.builtIn ? [] : [station.owner];
```

- [ ] **Step 4: `scripts/integrations/service.mjs`.**
  - The parameters end `pushFetch = createStationFetch({ timeoutMs: 3000 }), notify` (drop `, admins = []`).
  - `access` and its comment become:

```js
  // The row and the account's part in it: "owner", "station_owner" (it owns the integration's custom Station) or null.
  // A built-in Station has no owner, so only the integration's owner finds it here: Agora.Build admins act on the
  // admin site through Auth, never through the Portal (spec §3.3.4, D26).
  async function access(accountId, id) {
    const row = typeof id === "string" && id ? await repository.integration(id) : null;
    if (!row) throw notFound();
    if (row.ownerAccount === accountId) return { row, role: "owner" };
    const station = await repository.station(row.stationId);
    return { row, role: station && !station.builtIn && station.ownerAccount === accountId ? "station_owner" : null };
  }
```

  - `integrations` and its comment become:

```js
    // The account's own integrations (reconciled with Auth's list of them) and, read from Portal only, the others on
    // custom Stations it owns, which it may pause or revoke. The same for a browser session and an app's token.
    async integrations(accountId) {
      let listed;
      try {
        listed = await manage.integrations(accountId);
      } catch (error) {
        if (!(error instanceof ManageError) || fromManage(error).status !== 503) throw fromManage(error);
        log("Integration list served from Portal: Auth " + error.code + ".");
      }
      if (listed) await reconcileIntegrations(listed);
      const views = [];
      for (const row of await repository.integrationsFor(accountId)) views.push(await viewOf(row, "owner"));
      for (const station of await repository.stationsFor(accountId)) {
        if (station.role !== "owner") continue;
        for (const row of await repository.integrationsOnStation(station.id)) {
          if (row.ownerAccount !== accountId) views.push(integrationView(row, "station_owner", station.origin));
        }
      }
      return { integrations: views, stale: !listed };
    },
```

- [ ] **Step 5: `scripts/integrations/routes.mjs` and `scripts/serve.mjs`.**
  - `createIntegrationStack`'s first two lines become:

```js
export function createIntegrationStack({ db, manage, idp, log, stationFetch = createStationFetch(), pushFetch, builtInSyncAfter = BUILT_IN_SYNC_AFTER }) {
  const exchange = (idToken, origin) => idp ? idp.exchangeForStation(idToken, origin) : Promise.reject(new TokenError(503, "unavailable"));
  const service = createIntegrationService({ repository: createRepository(db), db, manage, stationFetch, pushFetch, exchange, log });
```

  - `integrationsFromEnv(env, { idp, log, stationFetch, pushFetch, admins })` becomes
    `integrationsFromEnv(env, { idp, log, stationFetch, pushFetch })`, and its last line
    `return createIntegrationStack({ db: createDatabase(env.DATABASE_URL, { log }), manage, idp, log, stationFetch, pushFetch });`.
  - In `handleIntegrations`, the comment line `// Agora.Build admins see other accounts' built-in integrations only in
    their browser session, never through a token.` goes, and the list call becomes
    `return ok(await service.integrations(listing("integrations", caller ? scoped("integrations:read") : await portalUser())));`.
  - `scripts/serve.mjs`: the call becomes
    `integrationsFromEnv(process.env, { ...options.integrationOptions, idp, log })`; `admins` stays for `createSpaces`.

- [ ] **Step 6: `integrations.js`.** The comment at lines 317–318 becomes:

```js
// Integrations: the account's own, and others on custom Stations it owns (which it may pause or revoke). Agora.Build
// admins act on the admin site, never here (spec D26).
```

  and line 455 becomes:

```js
    ...(owner ? [] : [el("p", { class: "muted", text: "Another account's integration on your Station. You can pause or revoke it." })]),
```

- [ ] **Step 7: Run the tests to see them pass.**
  Run: `node --test tests/integrations-service.test.mjs tests/integrations-stations.test.mjs tests/integrations-routes.test.mjs tests/integrations-page.test.mjs`
  Expected: PASS.

- [ ] **Step 8: End-to-end: no `PLATFORM_ADMINS`, and test 8 for the removed views.**
  - `tests/e2e/harness.mjs`: in the header comment, `the admin is signed in at Auth first and named in Auth's
    \`admins\` and the Portal's \`PLATFORM_ADMINS\`` becomes `the admin is signed in at Auth first and named in Auth's
    \`admins\` (the Portal does not know who the admins are)`. `startPortal`'s parameters lose `admins = []` and its
    environment loses `PLATFORM_ADMINS: admins.join(","),`. In `startStack`, the call becomes
    `startPortal({ issuer, port: portalPort, directory, clientSecret: secrets.PORTAL_CLIENT_SECRET, logs, databaseUrl: database?.url })`.
  - `tests/e2e/built-in-station.e2e.mjs`: the comment above test 1 becomes `// P-D1: the Portal syncs the built-in
    Station when its integration stack is ready, from Auth's listing that names no account (D26; no PLATFORM_ADMINS is
    set), so the Station's report token works before anyone has signed in to the Portal.`, and at the end of test 1 add
    `assert.ok(!stack.logs.some((line) => line.startsWith("Built-in Station sync")), "the sync ran without PLATFORM_ADMINS");`.
    Replace test 8 with:

```js
  test("8. an Agora.Build admin is just another account in the Portal: no views or actions on others' integrations", async () => {
    const cy = await portalSignIn(stack, person(7301, "Cy"));
    assert.equal((await meOf(cy.browser)).account.id, built.adminId);
    assert.deepEqual((await (await cy.browser.api("/api/integrations")).json()).integrations, [], "Cy owns none and sees nobody else's");
    for (const action of ["pause", "revoke"]) {
      const answer = await json(await cy.browser.api("/api/integrations/" + state.boFirst.id + "/" + action, { method: "POST", json: {} }));
      assert.equal(answer.status, 404, action);
    }
    const atAuth = await manage("PATCH", "/integrations/" + state.boFirst.id, { status: "paused", actor: built.adminId });
    assert.deepEqual([atAuth.status, atAuth.body.error], [403, "forbidden"], "Auth refuses the Portal acting for an admin across accounts");
    assert.equal((await manage("GET", "/integrations?account=" + state.boId)).body.integrations.find((entry) => entry.clientId === state.boFirst.id).status, "active");
    const refused = await manage("PATCH", "/integrations/" + state.adaFirst.id, { status: "paused", actor: state.boId });
    assert.deepEqual([refused.status, refused.body.error], [403, "forbidden"], "nor a non-admin pausing another's integration");
    for (const value of Object.values(stack.secrets)) assert.ok(!stack.logs.join("\n").includes(value), "no secret in the Portal log");
  });
```

  Run (opt-in, Node 22, the settings in Global Constraints, Auth checked out on `feat/admin-mfa`):
  `node --test tests/e2e/built-in-station.e2e.mjs`. Expected: PASS.

- [ ] **Step 9: `docs/platform.md`.**
  - The **Admins** bullet of "The Built-in Station" becomes:

```markdown
- **Admins.** Agora.Build admins act on the admin site (`https://admin.agora.build`, dev
  `https://admin.dev.agora.build`; spec D26), which calls Auth, never in the Portal. In the Portal an admin is just
  another account: every listing shows an account its own integrations and those on custom Stations it owns, another
  account's integration on the built-in Station is 404 for everyone but its owner, and Auth refuses the Portal's
  management calls that act across accounts.
```

  - In the routes table: the `POST /api/integrations/<id>/pause`, `resume`, `revoke` row's last cell becomes `pause and
    revoke also by the owner of the integration's custom Station`; the `GET /api/integrations` row's last cell becomes
    `the account's integrations, and others on custom Stations it owns`; the `GET /api/v1/integrations` row's last cell
    becomes `the same list`.
  - In "Verification", `its feed, integrations off then on, the plan limit and admin pause and revoke.` becomes
    `its feed, integrations off then on, the plan limit, and that an Agora.Build admin has no admin views or rights in the Portal.`

- [ ] **Step 10: Run the whole suite.** Run: `npm test`. Expected: PASS.
  Run: `git grep -nE "station_admin|asAdmin|admins(\.includes|\[0\]| = \[\])|PLATFORM_ADMINS" -- scripts/integrations integrations.js tests/e2e/harness.mjs`
  Expected: no hits (`scripts/serve.mjs` keeps `PLATFORM_ADMINS` for `createSpaces` only).

- [ ] **Step 11: Commit.**

```bash
git add scripts/integrations/service.mjs scripts/integrations/routes.mjs scripts/serve.mjs integrations.js tests/helpers/fake-manage.mjs tests/e2e/harness.mjs tests/e2e/built-in-station.e2e.mjs docs/platform.md tests/integrations-service.test.mjs tests/integrations-stations.test.mjs tests/integrations-routes.test.mjs tests/integrations-page.test.mjs
git commit -F - <<'EOF'
Drop the Portal's admin views: admins act on the admin site

🤖 Built with SMT <smt@agora.build>
EOF
```

---

### Task 4: Who paused an integration, and the admin pause lock, in the service

**Files:**
- Modify: `scripts/integrations/service.mjs` (constants after `NOT_SUPPORTED`; `MANAGE_CONFLICTS`; a `pausedByOf`
  function after `feedIntegration`; the `createIntegrationService` parameters; `integrationView`; `stop`;
  `difference`; `resume`)
- Modify: `tests/helpers/fake-manage.mjs` (`listed`; `changeIntegration`)
- Modify: `docs/platform.md` ("Lifecycle" and the common error codes)
- Test: `tests/integrations-service.test.mjs`

**Interfaces:**
- Consumes: Task 1's `pausedBy` and `ownerDisabledAt` on rows; Auth's `pausedBy` in its PATCH answers and listings,
  `409 admin_paused` (Auth Task 14; absent before it, which the fallbacks below cover).
- Produces:
  ```js
  createIntegrationService({ …, authChanged = () => {} })   // called when Auth answers 409 admin_paused to a resume
  // integration views gain pausedBy: "owner" | "station" | "admin" | null   ("admin" also while ownerDisabledAt is set)
  service.resume(accountId, id)  // 409 { code: "admin_paused" } "Agora.Build paused this integration. Only Agora.Build can resume it."
  // fake-manage: integrations carry pausedBy; changeIntegration answers 409 admin_paused to a resume of an admin's pause
  ```

- [ ] **Step 1: Write the failing tests.** In `tests/integrations-service.test.mjs`:
  - In `setup`, the `createIntegrationService({ … })` call gains a hook and the result exposes it:

```js
  let asked = 0;
  const service = createIntegrationService({
    repository: wrap(repository), db, manage, stationFetch, exchange: async () => ({}), now: () => clock.now, log: (line) => logs.push(line),
    challengeValue: () => "proof-value-" + (++counter), notify: (stationId) => notified.push(stationId), authChanged: () => { asked += 1; }
  });
```

    and its `return { … }` gains `authAsked: () => asked`.
  - In "createIntegration adds agent.view, uses the defaults and records the creation after Auth", the expected view's
    `state: "awaiting_approval", pausedFrom: null,` becomes `state: "awaiting_approval", pausedFrom: null, pausedBy: null,`.
  - Append:

```js
const ADMIN_PAUSED = "Agora.Build paused this integration. Only Agora.Build can resume it.";

test("a pause records who paused it, as Auth answers; resuming or revoking clears it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  await s.service.approve(MEMBER, id, { r9Svc: R9 });
  assert.equal((await s.service.pause(MEMBER, id)).pausedBy, "owner");
  assert.deepEqual([s.record(id).pausedBy, (await s.repository.integration(id)).pausedBy], ["owner", "owner"]);
  assert.equal((await s.service.resume(MEMBER, id)).pausedBy, null);
  assert.equal((await s.repository.integration(id)).pausedBy, null);
  assert.equal((await s.service.pause(OWNER, id)).pausedBy, "station", "the custom Station's owner");
  assert.equal((await s.service.revoke(OWNER, id)).pausedBy, null);
  assert.equal((await s.repository.integration(id)).pausedBy, null);
});

test("an admin's pause locks: Resume is 409 admin_paused without asking Auth, and Auth's own 409 reads the same and asks for Auth's feed", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  await s.service.approve(OWNER, id, { r9Svc: R9 });
  await s.repository.updateIntegration(id, { state: "ready" });
  // An admin paused it at Auth; the owner's listing follows it.
  Object.assign(s.record(id), { status: "paused", pausedBy: "admin" });
  const view = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([view.state, view.pausedFrom, view.pausedBy], ["paused", "ready", "admin"]);
  const calls = s.authCalls("changeIntegration");
  await assert.rejects(s.service.resume(OWNER, id), (error) => refused(409, "admin_paused")(error) && error.message === ADMIN_PAUSED);
  assert.equal(s.authCalls("changeIntegration"), calls, "Auth is not asked");
  assert.equal(s.authAsked(), 0);
  // The Portal has not heard yet: Auth refuses with its own 409, which reads the same and asks for a read of its feed.
  await s.repository.updateIntegration(id, { pausedBy: "owner" });
  await assert.rejects(s.service.resume(OWNER, id), (error) => refused(409, "admin_paused")(error) && error.message === ADMIN_PAUSED);
  assert.equal(s.authCalls("changeIntegration"), calls + 1);
  assert.equal(s.authAsked(), 1);
  assert.equal((await s.repository.integration(id)).state, "paused", "nothing changed in the Portal");
  // The quota stays the owner's, and revoking is never locked.
  assert.equal((await s.service.settings(OWNER, id, { quotaPerSecond: 9 })).quotaPerSecond, 9);
  assert.equal((await s.service.revoke(OWNER, id)).state, "revoking");
});

test("pausing an integration Auth already holds in an admin's pause keeps it the admin's", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  // Paused by an admin at Auth; the Portal has not heard and still shows it awaiting approval.
  Object.assign(s.record(id), { status: "paused", pausedBy: "admin" });
  const paused = await s.service.pause(OWNER, id);
  assert.deepEqual([paused.state, paused.pausedBy, s.record(id).pausedBy], ["paused", "admin", "admin"]);
  await assert.rejects(s.service.resume(OWNER, id), refused(409, "admin_paused"));
});

test("an owner's listing follows who paused an integration at Auth, recorded like other settings", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { id } = await s.create();
  await s.service.pause(OWNER, id);
  s.record(id).pausedBy = "admin"; // an admin turned the owner's pause into theirs
  const view = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([view.state, view.pausedBy], ["paused", "admin"]);
  const [event] = await s.events("integration_reconciled");
  assert.deepEqual([event.integration_id, event.actor, event.state, event.details], [id, "system", "paused", { changed: ["pausedBy"], pausedBy: "admin" }]);
  await s.service.integrations(OWNER);
  assert.equal((await s.events("integration_reconciled")).length, 1, "nothing more to record");
});

test("while Agora.Build has its owner's account disabled, an integration shows as paused by Agora.Build", async (t) => {
  const s = await setup(t);
  if (!s) return;
  await s.service.share(OWNER, s.station.id, MEMBER);
  const { id } = await s.create(MEMBER);
  await s.repository.updateIntegration(id, { state: "ready", ownerDisabledAt: s.clock.now });
  const seen = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([seen.state, seen.pausedBy, seen.role], ["paused", "admin", "station_owner"]);
  assert.equal((await s.repository.integration(id)).state, "ready", "the row keeps its own state");
});
```

- [ ] **Step 2: Run the tests to see them fail.**
  Run: `node --test tests/integrations-service.test.mjs`
  Expected: FAIL (views have no `pausedBy`; the fake has no lock; `resume` reaches Auth and resumes).

- [ ] **Step 3: `tests/helpers/fake-manage.mjs`.**
  - `listed` becomes
    `const listed = ({ keys, ...integration }) => ({ ...integration, scopes: [...integration.scopes], pausedBy: integration.status === "paused" ? integration.pausedBy ?? null : null });`.
  - In `changeIntegration`, right after the line ending `fail(403, "forbidden");` add:

```js
      // An admin's pause locks (Auth D26 R28): resuming it is 409 admin_paused for anyone but an admin, with or without
      // other fields; only Auth's admin client lifts it.
      if (status === "active" && integration.status === "paused" && integration.pausedBy === "admin") fail(409, "admin_paused");
```

    and `if (status !== undefined) integration.status = status;` becomes:

```js
      // Who paused it (Auth D26 R27): its owner or its custom Station's owner; pausing an admin's pause changes nothing.
      if (status !== undefined && status !== integration.status) {
        integration.status = status;
        integration.pausedBy = status === "paused" ? (integration.owner === actor ? "owner" : "station") : null;
      }
```

- [ ] **Step 4: `scripts/integrations/service.mjs`.**
  - After `const NOT_SUPPORTED = "Integrations aren't available on the built-in Station yet.";` add:

```js
// Who paused a paused integration, as Auth records it (Auth D26 R27): its owner, its custom Station's owner, or an
// Agora.Build admin, whose pause only an admin lifts, on the admin site.
const PAUSED_BY = ["owner", "station", "admin"];
const ADMIN_PAUSED = "Agora.Build paused this integration. Only Agora.Build can resume it.";
const adminPaused = () => failure(409, ADMIN_PAUSED, "admin_paused");
```

  - `MANAGE_CONFLICTS` gains `admin_paused: ADMIN_PAUSED` after `not_supported: NOT_SUPPORTED` (with a comma after
    the latter).
  - After `function feedIntegration(row, at) { … }` add:

```js
// Who stopped a paused integration, for the page: Auth's pausedBy while the row is paused, and "admin" while Agora.Build
// has its owner's account disabled (Auth then issues it no token, and the Station sees it paused). null otherwise.
function pausedByOf(row, state) {
  if (state !== "paused") return null;
  if (row.ownerDisabledAt != null) return "admin";
  return row.state === "paused" && PAUSED_BY.includes(row.pausedBy) ? row.pausedBy : null;
}
```

  - The parameters end `pushFetch = createStationFetch({ timeoutMs: 3000 }), notify, authChanged = () => {}`, and the
    line above `export function createIntegrationService({` gains the comment
    `// authChanged() asks the stack to read Auth's change feed soon (Auth refused a resume as admin_paused).`
  - `integrationView` becomes:

```js
  function integrationView(row, role, origin) {
    const state = effectiveState(row, now());
    return {
      id: row.id, kind: row.kind, name: row.name, stationId: row.stationId, stationOrigin: origin, scopes: row.scopes,
      state, pausedFrom: row.resumeState, pausedBy: pausedByOf(row, state), r9Svc: row.r9Svc, quotaPerSecond: row.quotaPerSecond,
      expiresAt: row.expiresAt, approvedAt: row.approvedAt, lastError: row.lastError, createdAt: row.createdAt, role
    };
  }
```

  - `stop` and its comment become:

```js
  // pause and revoke: the integration's owner or its Station's owner; anyone else is told nothing about it. A pause
  // records who paused it as Auth answers (an admin's pause already there stays the admin's: Auth never lowers it), or
  // by role from an Auth without the admin pause lock. A revocation clears it.
  async function stop(accountId, id, event) {
    const { row, role } = await visible(accountId, id);
    step(row, event, now());
    if (event === "revoke" && STOPPED.includes(row.state)) return viewOf(row, role);
    const answer = await viaAuth(() => manage.changeIntegration(id, { status: event === "pause" ? "paused" : "revoked" }, accountId));
    const kind = event === "pause" ? "integration_paused" : "integration_revoked";
    const pausedBy = event !== "pause" ? null : PAUSED_BY.includes(answer?.pausedBy) ? answer.pausedBy : role === "owner" ? "owner" : "station";
    const updated = await commit(id, (current) => {
      if (event === "revoke" && STOPPED.includes(current.state)) return null;
      return { fields: { ...step(current, event, now()), pausedBy }, event: { actor: accountId, kind, reason: role } };
    });
    return viewOf(updated, role);
  }
```

  - `difference` and its comment become:

```js
  // What following Auth's entry changes on Portal's row: the fields to write, the status event ([transition, kind]) or
  // null, and the settings that changed. Auth is authoritative, so following it is not held back by expiry:
  // transitions are checked at time 0. Who paused it (pausedBy, from Auth's admin pause lock on) goes with a status
  // change, and on its own while both sides have it paused.
  function difference(row, entry) {
    const fields = {};
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() !== new Date(row.expiresAt).getTime()) fields.expiresAt = entry.expiresAt;
    if (entry.quotaPerSecond !== undefined && entry.quotaPerSecond !== row.quotaPerSecond) fields.quotaPerSecond = entry.quotaPerSecond;
    if ((entry.r9Svc ?? null) !== row.r9Svc) fields.r9Svc = entry.r9Svc ?? null;
    let event = null;
    if (entry.status === "revoked" && !STOPPED.includes(row.state)) event = ["revoke", "integration_revoked"];
    else if (entry.status === "paused" && row.state !== "paused" && !STOPPED.includes(row.state)) event = ["pause", "integration_paused"];
    else if (entry.status === "active" && row.state === "paused") event = ["resume", "integration_resumed"];
    const pausedBy = entry.status === "paused" && PAUSED_BY.includes(entry.pausedBy) ? entry.pausedBy : null;
    if (!event && row.state === "paused" && entry.status === "paused" && entry.pausedBy !== undefined && pausedBy !== row.pausedBy) fields.pausedBy = pausedBy;
    const settings = Object.keys(fields);
    if (event) Object.assign(fields, step(row, event[0], 0), { pausedBy: event[0] === "pause" ? pausedBy : null });
    return { fields, event, settings };
  }
```

  - `resume` and a comment above it become:

```js
    // The owner only, and never out of an Agora.Build admin's pause, which only an admin lifts on the admin site. Auth
    // holds the lock too: its own 409 admin_paused means the Portal has not read that change yet, so the stack is asked
    // to read Auth's change feed now.
    async resume(accountId, id) {
      const row = await owned(accountId, id);
      if (row.state === "paused" && row.pausedBy === "admin") throw adminPaused();
      step(row, "resume", now());
      try {
        await viaAuth(() => manage.changeIntegration(id, { status: "active" }, accountId));
      } catch (error) {
        if (error.details?.code === "admin_paused") authChanged();
        throw error;
      }
      const updated = await commit(id, (current) => ({ fields: { ...step(current, "resume", now()), pausedBy: null }, event: { actor: accountId, kind: "integration_resumed", reason: "owner" } }));
      return viewOf(updated, "owner");
    },
```

- [ ] **Step 5: Run the tests to see them pass.**
  Run: `node --test tests/integrations-service.test.mjs tests/integrations-reports.test.mjs tests/integrations-routes.test.mjs`
  Expected: PASS.

- [ ] **Step 6: `docs/platform.md`.**
  - In "Lifecycle", the `paused` row becomes
    ``| `paused` | stopped by the owner, the Station's owner or Agora.Build; remembers where it was | resume returns it there; after Agora.Build's pause only Agora.Build resumes it (409 `admin_paused`) |``
    and after the paragraph that ends `or have their quota changed.` add:

```markdown
A paused integration also says who paused it, `pausedBy`: `owner`, `station` (the custom Station's owner) or `admin`
(Agora.Build), as Auth recorded it, and `null` for a pause from before Auth recorded it. `pausedBy` is also `admin`,
and the state `paused`, while Agora.Build has the owner's account disabled.
```

  - In "Common error codes", after `` `plan_limit` (403, the plan's limit on the built-in Station)`` add
    `` , `admin_paused` (409, Agora.Build paused the integration; only Agora.Build resumes it)``.

- [ ] **Step 7: Run the whole suite.** Run: `npm test`. Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add scripts/integrations/service.mjs tests/helpers/fake-manage.mjs docs/platform.md tests/integrations-service.test.mjs
git commit -F - <<'EOF'
Record who paused an integration and keep an admin's pause locked

🤖 Built with SMT <smt@agora.build>
EOF
```

---

### Task 5: Apply Auth's change entries: record them, tell the Station

**Files:**
- Modify: `scripts/integrations/service.mjs` (constants; an `authEffect` function after `pausedByOf`; `applyAuthChange`
  in the returned object after `syncBuiltIn`; the change mapping in `changes`; `history`)
- Modify: `tests/helpers/fake-manage.mjs` (Auth's change feed: `recordChange`, `revokeWhere`, `removeStation`,
  `removeMember`, `changeIntegration`; new `adminChange`, `systemRevoke`, `setOwnerDisabled`, `integrationChanges`,
  `feed`, `onNudge`)
- Create: `tests/integrations-admin-changes.test.mjs`
- Modify: `docs/platform.md` ("For Station Builders", the feed's kinds)

**Interfaces:**
- Consumes: Task 1 (`authChangeApplied`, `pausedBy`, `ownerDisabledAt`, `effectiveState`), Task 2 (`syncBuiltIn`, used
  by the test setup), Task 4 (`PAUSED_BY`, `pausedByOf`, the lock), the existing `appending`, `step`, `changed`.
- Produces:
  ```js
  service.applyAuthChange(entry): Promise<"applied" | "skipped">   // throws only on a database failure
  //   events: integration_paused | integration_resumed | integration_revoked | integration_owner_disabled |
  //           integration_owner_enabled, actor = the admin's ab… ID or "system", reason = Auth's reason (≤ 500),
  //           details = { authCursor, authAt, admin, pausedBy? }
  // Station feed (service.changes): reason "agora_build" for an event with details.admin === true
  // history: { at, kind, state, reason: null, actor: "agora_build" } for such an event
  // fake-manage:
  //   auth.feed: entries { cursor, at, kind, clientId, stationId, owner, status, pausedBy, actorAccountId, reason, admin }
  //   auth.integrationChanges({ after, limit = 100 }) -> { changes, nextCursor }   (recorded in calls)
  //   auth.adminChange(id, { status, actor, reason }), auth.systemRevoke(id, reason = "configuration"),
  //   auth.setOwnerDisabled(account, disabled, { actor, reason }); each calls auth.onNudge?.() like Auth's nudge
  ```

- [ ] **Step 1: Write the failing tests.** Create `tests/integrations-admin-changes.test.mjs`:

```js
// Auth's change feed applied by the service (applyAuthChange, spec §3.3.4 "Owner decisions after the Auth review"),
// against the test database and the in-memory Auth, whose adminChange, systemRevoke and setOwnerDisabled stand in for
// the admin site's calls and Auth's own changes (Auth D26 Tasks 13 and 14).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createRepository } from "../scripts/integrations/repository.mjs";
import { createIntegrationService } from "../scripts/integrations/service.mjs";
import { AppError } from "../scripts/store.mjs";
import { fakeManage } from "./helpers/fake-manage.mjs";
import { testDatabase } from "./helpers/test-db.mjs";

const OWNER = "ab" + "0".repeat(25) + "1";
const OTHER = "ab" + "0".repeat(25) + "2";
const ADMIN = "ab" + "0".repeat(25) + "4";
const R9 = "a".repeat(64);
const publicJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });

async function setup(t) {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return null; }
  const repository = createRepository(db);
  const clock = { now: Date.now() };
  const manage = fakeManage({ now: () => clock.now });
  const built = manage.seedBuiltIn({ integrations: true, admins: [ADMIN] });
  const notified = [];
  const logs = [];
  const service = createIntegrationService({
    repository, db, manage, stationFetch: { async get() { return { status: 404, body: "" }; } }, exchange: async () => ({}),
    now: () => clock.now, log: (line) => logs.push(line), notify: (stationId) => notified.push(stationId)
  });
  await service.syncBuiltIn();
  const create = async (accountId = OWNER) => (await service.createIntegration(accountId, { stationId: built.id, name: "Hosted", scopes: [], publicJwk: publicJwk() })).id;
  const ready = async (accountId = OWNER) => {
    const id = await create(accountId);
    await service.approve(accountId, id, { r9Svc: R9 });
    await repository.updateIntegration(id, { state: "ready" });
    return id;
  };
  // Applies every entry of Auth's feed after the last one applied, as the reader does; returns what each did.
  let seen;
  const follow = async () => {
    const { changes, nextCursor } = await manage.integrationChanges({ after: seen });
    seen = nextCursor ?? undefined;
    const results = [];
    for (const change of changes) results.push(await service.applyAuthChange(change));
    return results;
  };
  const events = async (id) => (await db.pool.query("SELECT kind, state, actor, reason, details FROM integration_events WHERE integration_id = $1 ORDER BY id", [id])).rows;
  const stationFeed = () => service.changes(built.reportClientId, "0");
  return { db, repository, manage, clock, service, built, create, ready, follow, events, stationFeed, notified, logs };
}

test("an admin's pause in Auth's feed pauses the Portal's row, records the admin and the reason, and pushes the Station", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.notified.length = 0;
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam in #general" });
  assert.deepEqual(await s.follow(), ["applied"]);
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.resumeState, row.pausedBy], ["paused", "ready", "admin"]);
  const event = (await s.events(id)).at(-1);
  assert.deepEqual([event.kind, event.state, event.actor, event.reason], ["integration_paused", "paused", ADMIN, "Spam in #general"]);
  const entry = s.manage.feed.at(-1);
  assert.deepEqual(event.details, { authCursor: entry.cursor, authAt: entry.at, admin: true, pausedBy: "admin" });
  assert.deepEqual(s.notified, [s.built.id], "the Station is pushed");
  // The Station's feed has it, with the integration paused, and says only that Agora.Build did it.
  const change = (await s.stationFeed()).changes.at(-1);
  assert.deepEqual([change.integrationId, change.kind, change.state, change.reason, change.integration.state], [id, "integration_paused", "paused", "agora_build", "paused"]);
  // The owner sees Paused by Agora.Build; the history names Agora.Build, not the admin or the reason.
  const view = (await s.service.integrations(OWNER)).integrations.find((entry) => entry.id === id);
  assert.deepEqual([view.state, view.pausedBy], ["paused", "admin"]);
  const [latest] = (await s.service.history(OWNER, id)).events;
  assert.deepEqual([latest.kind, latest.state, latest.reason, latest.actor], ["integration_paused", "paused", null, "agora_build"]);
});

test("each entry is applied once, however often the feed is read again", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [entry] = (await s.manage.integrationChanges()).changes.filter((change) => change.clientId === id && change.admin);
  assert.equal(await s.service.applyAuthChange(entry), "applied");
  const count = (await s.events(id)).length;
  s.notified.length = 0;
  assert.equal(await s.service.applyAuthChange(entry), "skipped");
  assert.equal(await s.service.applyAuthChange({ ...entry }), "skipped");
  assert.equal((await s.events(id)).length, count);
  assert.deepEqual(s.notified, []);
  // The same cursor at another time is another change (Auth's database was restored and handed it out again).
  assert.equal(await s.service.applyAuthChange({ ...entry, at: new Date(Date.parse(entry.at) + 1000).toISOString() }), "applied");
});

test("the Portal's own changes in the feed are skipped; Auth's own are followed, with the system as actor", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  await s.service.pause(OWNER, id);
  await s.service.resume(OWNER, id);
  const count = (await s.events(id)).length;
  assert.deepEqual(await s.follow(), ["skipped", "skipped"], "the owner's pause and resume, already recorded");
  assert.equal((await s.events(id)).length, count);
  s.manage.systemRevoke(id, "configuration");
  assert.deepEqual(await s.follow(), ["applied"]);
  assert.equal((await s.repository.integration(id)).state, "revoking", "until the Station confirms");
  const event = (await s.events(id)).at(-1);
  assert.deepEqual([event.kind, event.actor, event.reason, event.details.admin], ["integration_revoked", "system", "configuration", false]);
  assert.equal((await s.stationFeed()).changes.at(-1).reason, "configuration", "Auth's own reason is a code, shown as it is");
});

test("an admin's pause of an owner's pause makes it the admin's; only the admin's lift resumes it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  await s.service.pause(OWNER, id);
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Abuse reports" });
  assert.deepEqual(await s.follow(), ["skipped", "applied"]);
  const row = await s.repository.integration(id);
  assert.deepEqual([row.state, row.resumeState, row.pausedBy], ["paused", "ready", "admin"]);
  assert.deepEqual((await s.events(id)).slice(-2).map((event) => [event.kind, event.actor, event.details.pausedBy ?? null]), [["integration_paused", OWNER, null], ["integration_paused", ADMIN, "admin"]]);
  await assert.rejects(s.service.resume(OWNER, id), (error) => error instanceof AppError && error.status === 409 && error.details.code === "admin_paused");
  s.manage.adminChange(id, { status: "active", actor: ADMIN, reason: "Cleared after review" });
  assert.deepEqual(await s.follow(), ["applied"]);
  const lifted = await s.repository.integration(id);
  assert.deepEqual([lifted.state, lifted.resumeState, lifted.pausedBy], ["ready", null, null]);
  assert.equal((await s.stationFeed()).changes.at(-1).integration.state, "ready");
});

test("an admin's revocation in the feed revokes the Portal's row: revoking until the Station confirms, or at once before approval", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const live = await s.ready();
  const waiting = await s.create();
  for (const id of [live, waiting]) s.manage.adminChange(id, { status: "revoked", actor: ADMIN, reason: "Confirmed abuse" });
  assert.deepEqual(await s.follow(), ["applied", "applied"]);
  assert.equal((await s.repository.integration(live)).state, "revoking");
  assert.equal((await s.repository.integration(waiting)).state, "revoked");
  const states = Object.fromEntries((await s.stationFeed()).integrations.map((entry) => [entry.id, entry.state]));
  assert.deepEqual([states[live], states[waiting]], ["revoking", "revoked"]);
});

test("disabling an owner's account pauses its integrations for the Station until it is enabled; each keeps its own state, and the owner's listing never undoes it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const live = await s.ready();
  const paused = await s.ready();
  await s.service.pause(OWNER, paused);
  const others = await s.ready(OTHER);
  s.manage.setOwnerDisabled(OWNER, true, { actor: ADMIN, reason: "Abusive integrations" });
  assert.equal((await s.follow()).filter((result) => result === "applied").length, 2, "one entry per integration the account owns");
  for (const id of [live, paused]) assert.ok((await s.repository.integration(id)).ownerDisabledAt);
  assert.equal((await s.repository.integration(others)).ownerDisabledAt, null);
  const feed = await s.stationFeed();
  const stateOf = (answer, id) => answer.integrations.find((entry) => entry.id === id).state;
  assert.deepEqual([stateOf(feed, live), stateOf(feed, paused), stateOf(feed, others)], ["paused", "paused", "ready"]);
  const event = (await s.events(live)).at(-1);
  assert.deepEqual([event.kind, event.state, event.actor, event.reason], ["integration_owner_disabled", "paused", ADMIN, "Abusive integrations"]);
  assert.equal(feed.changes.find((change) => change.integrationId === live && change.kind === "integration_owner_disabled").reason, "agora_build");
  // Auth still has the integration active: a listing for the owner (through an access token issued before the account
  // was disabled) must not bring it back for the Station.
  await s.service.integrations(OWNER);
  assert.equal(stateOf(await s.stationFeed(), live), "paused");
  s.manage.setOwnerDisabled(OWNER, false, { actor: ADMIN, reason: "Appeal accepted" });
  await s.follow();
  const back = await s.stationFeed();
  assert.deepEqual([stateOf(back, live), stateOf(back, paused)], ["ready", "paused"], "each is back as it was");
  assert.equal((await s.repository.integration(live)).ownerDisabledAt, null);
  assert.equal((await s.events(live)).at(-1).kind, "integration_owner_enabled");
});

test("entries that are not changes, and changes to integrations the Portal does not know, are skipped and logged", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  const [entry] = (await s.manage.integrationChanges()).changes;
  for (const bad of [null, "x", { ...entry, kind: "deleted" }, { ...entry, cursor: "not a cursor" }, { ...entry, clientId: 7 }, { ...entry, at: undefined }]) {
    assert.equal(await s.service.applyAuthChange(bad), "skipped", JSON.stringify(bad));
  }
  assert.ok(s.logs.includes("Auth change skipped: not a change entry."));
  assert.equal(await s.service.applyAuthChange({ ...entry, clientId: "i-" + "9".repeat(26) }), "skipped");
  assert.ok(s.logs.includes("Auth change skipped: the integration is unknown to Portal."));
  assert.equal((await s.repository.integration(id)).state, "ready");
});

test("a change the owner's listing already followed is still recorded once, with the admin as actor", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const id = await s.ready();
  s.manage.adminChange(id, { status: "paused", actor: ADMIN, reason: "Spam" });
  await s.service.integrations(OWNER); // follows Auth's status first, as the system
  assert.deepEqual(await s.follow(), ["applied"]);
  assert.deepEqual((await s.events(id)).slice(-2).map((event) => [event.kind, event.actor, event.reason]), [["integration_paused", "system", "reconciled"], ["integration_paused", ADMIN, "Spam"]]);
});
```

- [ ] **Step 2: Run them to see them fail.**
  Run: `node --test tests/integrations-admin-changes.test.mjs`
  Expected: FAIL (`s.manage.adminChange is not a function`).

- [ ] **Step 3: `tests/helpers/fake-manage.mjs`.**
  - The header comment gains, before "`failNext` makes": `` `feed` is Auth's change feed (integrationChanges): every
    status change and owner account change, whoever made it; adminChange, systemRevoke and setOwnerDisabled stand in
    for the admin site's calls and Auth's own changes, and call `onNudge` as Auth nudges the Portal (Auth D26 Task 13).``
  - After `const checkExpiry = …;` (its closing `};`) add:

```js
  // Auth's change feed (Auth D26 R25): one entry per change to an integration's access, oldest first, with an opaque
  // cursor as Auth hands it out.
  const feed = [];
  const feedCursor = (n) => Buffer.from("c" + n, "utf8").toString("base64url");
  function recordChange(integration, kind, { actor = null, reason = null, admin = false } = {}) {
    feed.push({
      cursor: feedCursor(feed.length + 1), at: new Date(now()).toISOString(), kind, clientId: integration.clientId, stationId: integration.stationId,
      owner: integration.owner, status: integration.status, pausedBy: integration.status === "paused" ? integration.pausedBy ?? null : null,
      actorAccountId: actor, reason, admin
    });
  }
  const statusKind = (status) => (status === "paused" ? "paused" : status === "revoked" ? "revoked" : "resumed");
```

  - After `integrationRecords: integrations,` add `feed,` and `onNudge: null,`.
  - `revokeWhere` becomes:

```js
    revokeWhere(pick, by = {}) {
      for (const integration of integrations) {
        if (!pick(integration) || integration.status === "revoked") continue;
        integration.status = "revoked";
        integration.pausedBy = null;
        recordChange(integration, "revoked", by);
      }
    },
```

  - In `removeStation`, `auth.revokeWhere((integration) => integration.stationId === id);` becomes
    `auth.revokeWhere((integration) => integration.stationId === id, { actor, reason: "station_removed" });`; in
    `removeMember`, `auth.revokeWhere((integration) => integration.stationId === id && integration.owner === account);`
    becomes `auth.revokeWhere((integration) => integration.stationId === id && integration.owner === account, { actor, reason: "member_removed" });`.
  - In `changeIntegration`, the status block from Task 4 gains the record:

```js
      if (status !== undefined && status !== integration.status) {
        integration.status = status;
        integration.pausedBy = status === "paused" ? (integration.owner === actor ? "owner" : "station") : null;
        recordChange(integration, statusKind(status), { actor });
      }
```

  - `changeIntegration` is the object's last method and has no trailing comma: put a comma after its closing brace,
    then add:

```js
    // An Agora.Build admin's change through Auth's admin client (the admin site): pause, revoke, or lift an admin's
    // pause, on a built-in Station the admin administers, with a reason; in the feed with admin: true, then Auth's
    // nudge. Not a Portal call, so it is not recorded in calls.
    adminChange(id, { status, actor, reason = "Admin test" }) {
      const integration = auth.findIntegration(id);
      const station = stations.find((entry) => entry.id === integration.stationId);
      const lifts = status === "active" && integration.status === "paused" && integration.pausedBy === "admin";
      if (!station.builtIn || !station.admins.includes(actor) || !(status === "paused" || status === "revoked" || lifts)) fail(403, "forbidden");
      if (integration.status === "revoked") fail(409, "revoked");
      const converts = status === "paused" && integration.status === "paused" && integration.pausedBy !== "admin";
      if (status === integration.status && !converts) return listed(integration);
      integration.status = status;
      integration.pausedBy = status === "paused" ? "admin" : null;
      recordChange(integration, statusKind(status), { actor, reason, admin: true });
      auth.onNudge?.();
      return listed(integration);
    },
    // Auth's own change (no actor): a built-in Station retired by its clients file revokes its integrations.
    systemRevoke(id, reason = "configuration") {
      const integration = auth.findIntegration(id);
      if (integration.status === "revoked") return;
      integration.status = "revoked";
      integration.pausedBy = null;
      recordChange(integration, "revoked", { reason });
      auth.onNudge?.();
    },
    // An admin disabling or enabling an account: one owner_disabled or owner_enabled entry per integration it owns
    // that is not revoked, each with that integration's status (Auth D26 R24).
    setOwnerDisabled(account, disabled, { actor = null, reason = null } = {}) {
      let written = 0;
      for (const integration of integrations) {
        if (integration.owner !== account || integration.status === "revoked") continue;
        recordChange(integration, disabled ? "owner_disabled" : "owner_enabled", { actor, reason, admin: actor !== null });
        written += 1;
      }
      if (written) auth.onNudge?.();
    },
    // GET /manage/v1/integration-changes (the Portal only): oldest first, after a cursor it handed out.
    async integrationChanges({ after, limit = 100 } = {}) {
      await auth.open("integrationChanges");
      let start = 0;
      if (after !== undefined) {
        start = feed.findIndex((entry) => entry.cursor === after) + 1;
        if (start === 0) fail(400, "invalid_request");
      }
      const changes = feed.slice(start, start + limit).map((entry) => ({ ...entry }));
      return { changes, nextCursor: changes.length ? changes.at(-1).cursor : after ?? null };
    }
```

- [ ] **Step 4: `scripts/integrations/service.mjs`.**
  - After the `adminPaused` line (Task 4) add:

```js
// Auth's change feed (Auth D26 R25): the kinds of entry, those about an owner's account, and its cursor's shape.
const AUTH_KINDS = ["paused", "resumed", "revoked", "owner_disabled", "owner_enabled"];
const OWNER_KINDS = ["owner_disabled", "owner_enabled"];
const AUTH_CURSOR = /^[A-Za-z0-9_-]{1,64}$/;
const AUTH_REASON_MAX = 500;
// How the Station's feed and an integration's history name a change an Agora.Build admin made (spec §3.3.4): the admin
// and the reason they gave stay in the Portal's event (actor, reason) and in Auth's audit.
const AGORA_BUILD = "agora_build";
```

  - After `function pausedByOf(row, state) { … }` add:

```js
// What an entry of Auth's change feed does to the Portal's row: the event kind and the fields to write, or null when
// there is nothing to record (a stopped integration is not paused, resumed, disabled or enabled again). Auth is
// authoritative, so following it is not held back by expiry: transitions are checked at time 0, as in reconcile. An
// owner's account being disabled is its own flag, not a pause of the row (effectiveState shows it as paused), so
// enabling it restores each integration as it was.
function authEffect(row, entry, at) {
  const stopped = STOPPED.includes(row.state);
  if (entry.kind === "revoked") return { kind: "integration_revoked", fields: stopped ? {} : { ...step(row, "revoke", 0), pausedBy: null } };
  if (stopped) return null;
  if (entry.kind === "paused") {
    const pausedBy = PAUSED_BY.includes(entry.pausedBy) ? entry.pausedBy : null;
    if (row.state !== "paused") return { kind: "integration_paused", fields: { ...step(row, "pause", 0), pausedBy } };
    return { kind: "integration_paused", fields: row.pausedBy === pausedBy ? {} : { pausedBy } };
  }
  if (entry.kind === "resumed") return { kind: "integration_resumed", fields: row.state === "paused" ? { ...step(row, "resume", 0), pausedBy: null } : {} };
  if (entry.kind === "owner_disabled") {
    const when = Date.parse(entry.at);
    return { kind: "integration_owner_disabled", fields: row.ownerDisabledAt ? {} : { ownerDisabledAt: Number.isFinite(when) ? when : at } };
  }
  return { kind: "integration_owner_enabled", fields: row.ownerDisabledAt ? { ownerDisabledAt: null } : {} };
}
```

  - In the returned object, after `syncBuiltIn` add:

```js
    // One entry of Auth's change feed (GET /manage/v1/integration-changes, read by auth-changes.mjs): Auth's change to
    // an integration's access, followed on the Portal's row (authEffect), recorded in integration_events with the
    // account that made it and its reason (an Agora.Build admin and the reason they gave; spec §3.3.4), then appended
    // to the Station's feed and pushed to it. Changes the Portal made itself (an account's pause, resume or revoke
    // through these routes) are already recorded and are skipped, as are integrations the Portal does not know (their
    // owner's next listing brings them in). Each entry is applied once: its cursor and time are kept in the event's
    // details. Returns "applied" or "skipped"; only a database failure throws, so the reader reads it again.
    async applyAuthChange(entry) {
      if (!plainObject(entry) || !AUTH_KINDS.includes(entry.kind) || typeof entry.clientId !== "string" || typeof entry.cursor !== "string" || !AUTH_CURSOR.test(entry.cursor) || typeof entry.at !== "string") {
        log("Auth change skipped: not a change entry.");
        return "skipped";
      }
      const ours = !OWNER_KINDS.includes(entry.kind) && entry.admin !== true && entry.actorAccountId !== null;
      if (ours) return "skipped";
      if (!(await repository.integration(entry.clientId))) {
        log("Auth change skipped: the integration is unknown to Portal.");
        return "skipped";
      }
      const actor = typeof entry.actorAccountId === "string" && ACCOUNT_ID.test(entry.actorAccountId) ? entry.actorAccountId : SYSTEM;
      const reason = typeof entry.reason === "string" && entry.reason ? [...entry.reason].slice(0, AUTH_REASON_MAX).join("") : null;
      const stationId = await appending(async (client) => {
        const row = await repository.integrationForUpdate(entry.clientId, client);
        if (!row || await repository.authChangeApplied(row.id, entry.cursor, entry.at, client)) return null;
        const effect = authEffect(row, entry, now());
        if (!effect) return null;
        if (Object.keys(effect.fields).length) await repository.updateIntegration(row.id, effect.fields, client);
        const after = { ...row, ...effect.fields };
        await repository.appendEvent({
          stationId: row.stationId, integrationId: row.id, accountId: row.ownerAccount, actor, kind: effect.kind,
          state: effectiveState(after, 0), reason,
          details: { authCursor: entry.cursor, authAt: entry.at, admin: entry.admin === true, ...(after.state === "paused" && PAUSED_BY.includes(after.pausedBy) ? { pausedBy: after.pausedBy } : {}) }
        }, client);
        return row.stationId;
      });
      if (!stationId) return "skipped";
      changed(stationId);
      return "applied";
    },
```

  - In `changes`, the mapping's first two lines become:

```js
      const changes = events.map(({ id, at: when, integrationId, kind, state, reason, details }) => {
        // Agora.Build's changes say only that: the admin and their reason stay in the Portal's event (spec §3.3.4).
        const change = { id, at: when, integrationId, kind, state, reason: details?.admin === true ? AGORA_BUILD : reason };
```

  - `history` becomes:

```js
    // Newest first. The reader's own changes show as "you". An Agora.Build admin's change shows as Agora.Build's: the
    // admin's account and their reason stay in the event, for the audit (spec §3.3.4).
    async history(accountId, id) {
      const { row } = await visible(accountId, id);
      const events = await repository.eventsFor(row.id);
      return { events: events.map(({ at, kind, state, reason, actor, details }) => details?.admin === true
        ? { at, kind, state, reason: null, actor: AGORA_BUILD }
        : { at, kind, state, reason, actor: actor === accountId ? "you" : actor }) };
    }
```

- [ ] **Step 5: Run the tests to see them pass.**
  Run: `node --test tests/integrations-admin-changes.test.mjs tests/integrations-service.test.mjs tests/integrations-stations.test.mjs tests/integrations-reports.test.mjs`
  Expected: PASS.

- [ ] **Step 6: `docs/platform.md`, "For Station Builders".** In the **Cursors.** paragraph, the text from
  `` `integration_reconciled` (the Portal caught up with a change made at Auth,`` through `carries.` becomes:

```markdown
`integration_reconciled` (the Portal caught up with a change made at Auth,
such as a new expiry, quota or R9 binding, or an integration it had missed),
`integration_owner_disabled` and `integration_owner_enabled` (Agora.Build
disabled or enabled the integration's owner account: Auth issues it no token
while it is disabled, and its `state` is `paused` until it is enabled again),
and for the Station itself `station_registered`, `station_reconciled`,
`member_added` and `member_removed`, which have no integration. New kinds may
be added; treat an unknown one as a reason to act on the `integration` it
carries. A change Agora.Build made (an admin's, on the admin site) has the
`reason` `agora_build`. As soon as an integration's `state` is `paused`,
`revoking`, `revoked` or `expired`, refuse its still-valid tokens and close its
open sessions and streams; its tokens are never trusted past their 300-second
lifetime anyway.
```

- [ ] **Step 7: Run the whole suite.** Run: `npm test`. Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add scripts/integrations/service.mjs tests/helpers/fake-manage.mjs tests/integrations-admin-changes.test.mjs docs/platform.md
git commit -F - <<'EOF'
Follow Auth's change entries: record the admin and reason, tell the Station

🤖 Built with SMT <smt@agora.build>
EOF
```

---

### Task 6: Read Auth's change feed: the reader and the stack

**Files:**
- Create: `scripts/integrations/auth-changes.mjs`
- Modify: `scripts/integrations/auth-manage.mjs` (the returned object: `integrationChanges`)
- Modify: `scripts/integrations/routes.mjs` (import; `createIntegrationStack`; `integrationsFromEnv`)
- Create: `tests/integrations-auth-changes.test.mjs`
- Test: `tests/integrations-auth-manage.test.mjs`, `tests/integrations-routes.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`authChangeCursor`, `saveAuthChangeCursor`), Task 4 (`authChanged` parameter), Task 5
  (`service.applyAuthChange`, the fake's `feed`, `adminChange`, `integrationChanges`).
- Produces:
  ```js
  // scripts/integrations/auth-manage.mjs
  manage.integrationChanges({ after?: string, limit?: number }): Promise<{ changes: object[], nextCursor: string | null }>
  // scripts/integrations/auth-changes.mjs
  export const AUTH_CHANGES = { pollMs: 30000, minGapMs: 1000, pageSize: 100, pagesPerPull: 10 };
  export function createAuthChanges({ repository, manage, apply, log, settings = AUTH_CHANGES, now = Date.now }):
    { start(): void, request(): void, stop(): Promise<void>, idle(): Promise<void> }
  //   logs: "Auth change feed read failed: <code>." | "Auth change feed failed: <code>." | "Auth change not applied: <code>."
  // scripts/integrations/routes.mjs
  createIntegrationStack({ db, manage, idp, log, stationFetch, pushFetch, builtInSyncAfter, authChanges = AUTH_CHANGES }):
    { service, ready(), nudge(): void, close() }
  integrationsFromEnv(env, { idp, log, stationFetch, pushFetch, authChanges })
  ```

- [ ] **Step 1: Write the failing reader tests.** Create `tests/integrations-auth-changes.test.mjs`:

```js
// The reader of Auth's change feed (scripts/integrations/auth-changes.mjs), with an in-memory cursor and feed: no
// database needed.
import assert from "node:assert/strict";
import test from "node:test";
import { ManageError } from "../scripts/integrations/auth-manage.mjs";
import { AUTH_CHANGES, createAuthChanges } from "../scripts/integrations/auth-changes.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The Portal's saved cursor; `fail` makes reading it throw.
function memoryCursor(cursor = null) {
  const repository = {
    cursor,
    saved: [],
    fail: null,
    async authChangeCursor() { if (repository.fail) throw repository.fail; return repository.cursor; },
    async saveAuthChangeCursor(next) { repository.cursor = next; repository.saved.push(next); }
  };
  return repository;
}
// Auth's feed with `count` entries c1, c2, …; each read is recorded with its cursor and start time. `hold` makes
// reads wait until it resolves; `fail` makes them throw.
function feedOf(count) {
  const entry = (n) => ({ cursor: "c" + n, kind: "paused", clientId: "i-" + n });
  const manage = {
    entries: Array.from({ length: count }, (_, index) => entry(index + 1)),
    reads: [],
    hold: null,
    fail: null,
    add() { manage.entries.push(entry(manage.entries.length + 1)); },
    async integrationChanges({ after, limit }) {
      manage.reads.push({ after: after ?? null, at: Date.now() });
      if (manage.hold) await manage.hold;
      if (manage.fail) throw manage.fail;
      const start = after === undefined ? 0 : manage.entries.findIndex((item) => item.cursor === after) + 1;
      const changes = manage.entries.slice(start, start + limit);
      return { changes, nextCursor: changes.length ? changes.at(-1).cursor : after ?? null };
    }
  };
  return manage;
}
const QUICK = { pollMs: 3600000, minGapMs: 20, pageSize: 2, pagesPerPull: 3 };
function reader(t, { manage, repository = memoryCursor(), apply, log = () => {}, settings = {} }) {
  const applied = [];
  const feed = createAuthChanges({ repository, manage, log, settings: { ...QUICK, ...settings }, apply: apply ?? (async (change) => { applied.push(change.cursor); }) });
  t.after(() => feed.stop());
  return { feed, applied, repository };
}

test("the defaults: a poll every 30 seconds, reads at least a second apart, up to 10 pages of 100", () => {
  assert.deepEqual(AUTH_CHANGES, { pollMs: 30000, minGapMs: 1000, pageSize: 100, pagesPerPull: 10 });
});

test("start reads Auth's feed at once from the saved cursor, applies each change in order and saves the cursor after each page", async (t) => {
  const manage = feedOf(3);
  const { feed, applied, repository } = reader(t, { manage, repository: memoryCursor("c1") });
  feed.start();
  await feed.idle();
  assert.deepEqual(applied, ["c2", "c3"]);
  assert.deepEqual(manage.reads.map((read) => read.after), ["c1", "c3"], "a full page is followed by the next at once");
  assert.deepEqual(repository.saved, ["c3"], "an empty page leaves the cursor as it was");
});

test("without requests the reader polls every pollMs", async (t) => {
  const manage = feedOf(0);
  const { feed, applied } = reader(t, { manage, settings: { pollMs: 40 } });
  feed.start();
  await feed.idle();
  manage.add();
  await sleep(150);
  await feed.idle();
  assert.deepEqual(applied, ["c1"]);
  assert.ok(manage.reads.length >= 3, "it read again on its own (" + manage.reads.length + " reads)");
});

test("requests coalesce: one read at a time, requests during it make exactly one more, and reads start minGapMs apart", async (t) => {
  const manage = feedOf(0);
  let release;
  manage.hold = new Promise((resolve) => { release = resolve; });
  const { feed } = reader(t, { manage, settings: { minGapMs: 60 } });
  feed.start();
  await sleep(10);
  assert.equal(manage.reads.length, 1, "the first read is in flight");
  for (let index = 0; index < 20; index += 1) feed.request();
  await sleep(10);
  assert.equal(manage.reads.length, 1, "nothing more while it runs");
  manage.hold = null;
  release();
  await feed.idle();
  assert.equal(manage.reads.length, 2, "twenty requests during the read made one more");
  assert.ok(manage.reads[1].at - manage.reads[0].at >= 55, "spaced by minGapMs");
  for (let index = 0; index < 20; index += 1) feed.request();
  await feed.idle();
  assert.equal(manage.reads.length, 3, "a burst after it makes one read");
  assert.ok(manage.reads[2].at - manage.reads[1].at >= 55);
});

test("a read whose pages were all full asks for another read, after the gap", async (t) => {
  const manage = feedOf(7);
  const { feed, applied, repository } = reader(t, { manage, settings: { pagesPerPull: 2 } });
  feed.start();
  await feed.idle();
  assert.deepEqual(applied, ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  assert.deepEqual(manage.reads.map((read) => read.after), [null, "c2", "c4", "c6"]);
  assert.deepEqual(repository.saved, ["c2", "c4", "c6", "c7"]);
  assert.ok(manage.reads[2].at - manage.reads[0].at >= 15, "the second read waited for the gap");
});

test("a failed read is logged once per reason until a read succeeds; the cursor stays and the next poll tries again", async (t) => {
  const manage = feedOf(2);
  manage.fail = new ManageError(503, "unavailable");
  const logs = [];
  const { feed, applied, repository } = reader(t, { manage, log: (line) => logs.push(line), settings: { pollMs: 25, pageSize: 10 } });
  feed.start();
  await sleep(120);
  assert.ok(manage.reads.length >= 3, "the poll kept trying");
  assert.deepEqual(logs, ["Auth change feed read failed: unavailable."]);
  assert.deepEqual([applied, repository.saved], [[], []]);
  manage.fail = null;
  await sleep(60);
  await feed.idle();
  assert.deepEqual(applied, ["c1", "c2"]);
  manage.fail = new ManageError(404, "not_found");
  await sleep(60);
  manage.fail = null;
  repository.fail = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
  await sleep(60);
  assert.deepEqual(logs, ["Auth change feed read failed: unavailable.", "Auth change feed read failed: not_found.", "Auth change feed failed: ECONNREFUSED."]);
});

test("a change that cannot be applied stops the read before its page's cursor is saved; the next read starts there again", async (t) => {
  const manage = feedOf(3);
  let failing = true;
  const logs = [];
  const seen = [];
  const { feed, repository } = reader(t, { manage, log: (line) => logs.push(line), settings: { pageSize: 10, pollMs: 30 }, apply: async (change) => {
    seen.push(change.cursor);
    if (change.cursor === "c2" && failing) throw Object.assign(new Error("statement timeout"), { code: "57014" });
  } });
  feed.start();
  await feed.idle();
  assert.deepEqual([seen, repository.saved, logs], [["c1", "c2"], [], ["Auth change not applied: 57014."]]);
  failing = false;
  await sleep(80);
  await feed.idle();
  assert.deepEqual(seen.slice(0, 5), ["c1", "c2", "c1", "c2", "c3"], "the page is read again from the saved cursor; applying is idempotent");
  assert.equal(repository.cursor, "c3");
});

test("stop() cancels the next read and waits for the one in flight; requests after it read nothing", async (t) => {
  const manage = feedOf(0);
  let release;
  manage.hold = new Promise((resolve) => { release = resolve; });
  const { feed } = reader(t, { manage, settings: { pollMs: 20 } });
  feed.start();
  await sleep(10);
  let stopped = false;
  const stopping = feed.stop().then(() => { stopped = true; });
  await sleep(10);
  assert.equal(stopped, false, "it waits for the read in flight");
  manage.hold = null;
  release();
  await stopping;
  feed.request();
  await sleep(60);
  assert.equal(manage.reads.length, 1);
});
```

- [ ] **Step 2: Write the failing client and stack tests.**
  - Append to `tests/integrations-auth-manage.test.mjs`:

```js
test("integrationChanges reads Auth's change feed after a cursor and checks the answer's shape", async () => {
  const change = { cursor: "YzE", at: "2026-10-31T10:00:00.000Z", kind: "paused", clientId: "i-1", stationId: "st1", owner: actor, status: "paused", pausedBy: "admin", actorAccountId: other, reason: "Spam", admin: true };
  let s = stub({ changes: [change], nextCursor: "YzE" });
  assert.deepEqual(await clientWith(s).integrationChanges({ after: "YzA", limit: 100 }), { changes: [change], nextCursor: "YzE" });
  assert.deepEqual([s.calls[0].method, s.calls[0].url], ["GET", issuer + "/manage/v1/integration-changes?after=YzA&limit=100"]);
  s = stub({ changes: [], nextCursor: null });
  assert.deepEqual(await clientWith(s).integrationChanges(), { changes: [], nextCursor: null });
  assert.equal(s.calls[0].url, issuer + "/manage/v1/integration-changes", "no cursor before the first read");
  for (const body of [{ nextCursor: null }, { changes: [], nextCursor: 7 }, { changes: [] }]) {
    await assert.rejects(clientWith(stub(body)).integrationChanges(), (error) => error instanceof ManageError && error.code === "bad_response", JSON.stringify(body));
  }
});
```

  - In `tests/integrations-routes.test.mjs`, after the `publicJwk` helper near the top add:

```js
const waitFor = async (check, label, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
```

    and after "a successful built-in sync is repeated on the hourly schedule, with no platform admins anywhere" add:

```js
test("the stack reads Auth's change feed once it is ready and again on each nudge, following an admin's pause", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const admin = accountId();
  const owner = accountId();
  const manage = fakeManage();
  const built = manage.seedBuiltIn({ integrations: true, admins: [admin] });
  const pushes = [];
  const integrations = createIntegrationStack({ db, manage, idp: null, log: () => {}, pushFetch: { async post(url) { pushes.push(url); return { status: 202 }; } }, authChanges: { pollMs: 3600000, minGapMs: 10 } });
  const reads = () => manage.calls.filter((name) => name === "integrationChanges").length;
  integrations.nudge(); // before ready(): makes the stack ready, then reads
  await waitFor(() => reads() === 1, "the first read");
  const created = await integrations.service.createIntegration(owner, { stationId: built.id, name: "Hosted", scopes: [], publicJwk: publicJwk() });
  manage.adminChange(created.id, { status: "paused", actor: admin, reason: "Spam" });
  integrations.nudge();
  await waitFor(async () => (await db.pool.query("SELECT paused_by FROM integrations WHERE id = $1", [created.id])).rows[0].paused_by === "admin", "the admin's pause in the Portal");
  assert.equal(reads(), 2);
  assert.equal((await db.pool.query("SELECT state FROM integrations WHERE id = $1", [created.id])).rows[0].state, "paused");
  assert.equal((await db.pool.query("SELECT cursor FROM auth_change_feed")).rows[0].cursor, manage.feed.at(-1).cursor, "the cursor is saved");
  await integrations.service._pushesIdle();
  assert.ok(pushes.includes(built.origin + "/agora-build/v1/changes"), "the Station was pushed");
});

test("close() stops reading Auth's change feed", async () => {
  // A database whose every query finds nothing: an empty cursor, no built-in Stations.
  const db = { pool: { async query() { return { rows: [] }; } }, async migrate() { return []; }, async ensureEventPartitions() { return []; }, async close() {} };
  const manage = fakeManage();
  const reads = () => manage.calls.filter((name) => name === "integrationChanges").length;
  const integrations = createIntegrationStack({ db, manage, idp: null, log: () => {}, authChanges: { pollMs: 20, minGapMs: 5 } });
  await integrations.ready();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(reads() >= 2, "it polls (" + reads() + " reads)");
  await integrations.close();
  const after = reads();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reads(), after, "no read after close()");
});
```

- [ ] **Step 3: Run the tests to see them fail.**
  Run: `node --test tests/integrations-auth-changes.test.mjs tests/integrations-auth-manage.test.mjs tests/integrations-routes.test.mjs`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `auth-changes.mjs`; `integrationChanges is not a function`;
  `integrations.nudge is not a function`).

- [ ] **Step 4: `scripts/integrations/auth-manage.mjs`.** In the returned object, after `changeIntegration` (comma
  after it) add:

```js
    // Auth's change feed (D26, the Portal's alone): the changes to integration access after `after` (an opaque cursor
    // Auth handed out), oldest first, and the cursor to pass next (null before the feed's first change).
    async integrationChanges({ after, limit } = {}) {
      const query = {};
      if (after !== undefined) query.after = after;
      if (limit !== undefined) query.limit = String(limit);
      const json = await call("GET", "/integration-changes", { query: Object.keys(query).length ? query : undefined });
      const changes = list(json, "changes");
      if (json.nextCursor !== null && typeof json.nextCursor !== "string") throw new ManageError(200, "bad_response");
      return { changes, nextCursor: json.nextCursor };
    }
```

- [ ] **Step 5: Create `scripts/integrations/auth-changes.mjs`.**

```js
// Reads Auth's change feed (GET /manage/v1/integration-changes; Agora.Build integrations design §3.3.4, "Owner
// decisions after the Auth review", D26): every change to an integration's access, whoever made it, oldest first.
// Right after a change the Portal did not make, Auth nudges it (POST /auth/integration-changes, scripts/serve.mjs);
// the Portal also reads every 30 seconds in case a nudge is lost, the push-plus-poll pattern the Stations use with the
// Portal's own feed. Each change goes to `apply` (service.applyAuthChange, which records it once and tells the
// Station). Auth's cursor is saved in the Portal database after each page, so a restart continues where it stopped.
//
// One read at a time. A request while one runs asks for exactly one more after it (the running read may have passed
// before the newer change committed); requests meanwhile collapse into that one, and reads start at least minGapMs
// apart, so a burst of nudges, forged or not, costs at most one read a second. A read takes up to pagesPerPull pages
// of pageSize; when every page was full it asks for another. A failure is logged once per message until a read
// succeeds; the cursor stays where it was and the next poll tries again. Nothing here throws.
import { ManageError } from "./auth-manage.mjs";

export const AUTH_CHANGES = Object.freeze({ pollMs: 30000, minGapMs: 1000, pageSize: 100, pagesPerPull: 10 });

export function createAuthChanges({ repository, manage, apply, log = () => {}, settings = AUTH_CHANGES, now = Date.now }) {
  const { pollMs, minGapMs, pageSize, pagesPerPull } = { ...AUTH_CHANGES, ...settings };
  let started = false;
  let running = null;
  let again = false;
  // The next read: when, and whether a request asked for it (soon) or it is the poll.
  let timer = null;
  let lastStart = -Infinity;
  let reported = null;

  function report(message) {
    if (reported === message) return;
    reported = message;
    log(message);
  }

  function schedule(at, soon) {
    if (timer) clearTimeout(timer.handle);
    const handle = setTimeout(run, Math.max(0, at - now()));
    handle.unref?.();
    timer = { handle, at, soon };
  }

  function request() {
    if (!started) return;
    if (running) {
      again = true;
      return;
    }
    const at = Math.max(now(), lastStart + minGapMs);
    if (timer && timer.at <= at) return;
    schedule(at, true);
  }

  // One read: pages from the saved cursor until a short page, or pagesPerPull of them. Returns whether more may wait.
  async function read() {
    let cursor = await repository.authChangeCursor();
    for (let page = 0; page < pagesPerPull; page += 1) {
      const { changes, nextCursor } = await manage.integrationChanges({ after: cursor ?? undefined, limit: pageSize });
      for (const change of changes) {
        try {
          await apply(change);
        } catch (error) {
          report("Auth change not applied: " + (error?.code || "error") + ".");
          return false;
        }
      }
      if (nextCursor && nextCursor !== cursor) {
        await repository.saveAuthChangeCursor(nextCursor);
        cursor = nextCursor;
      }
      if (changes.length < pageSize) {
        reported = null;
        return false;
      }
    }
    reported = null;
    return true;
  }

  function run() {
    timer = null;
    again = false;
    lastStart = now();
    running = (async () => {
      let more = false;
      try {
        more = await read();
      } catch (error) {
        report(error instanceof ManageError ? "Auth change feed read failed: " + error.code + "." : "Auth change feed failed: " + (error?.code || "error") + ".");
      }
      running = null;
      if (!started) return;
      if (more || again) request();
      else schedule(now() + pollMs, false);
    })();
  }

  return {
    // Reads at once, then as above.
    start() {
      if (started) return;
      started = true;
      request();
    },
    // Asks for a read soon (Auth's nudge; a resume Auth refused as admin_paused).
    request,
    // No more reads; resolves once the one in flight, if any, has finished.
    stop() {
      started = false;
      if (timer) clearTimeout(timer.handle);
      timer = null;
      return running ?? Promise.resolve();
    },
    // For tests: resolves once no read is in flight or asked for (only the poll may be waiting).
    async idle() {
      for (;;) {
        if (running) await running;
        else if (timer?.soon) await new Promise((resolve) => setTimeout(resolve, Math.max(0, timer.at - now()) + 5));
        else return;
      }
    }
  };
}
```

- [ ] **Step 6: `scripts/integrations/routes.mjs`.**
  - After `import { createIntegrationService } from "./service.mjs";` add
    `import { AUTH_CHANGES, createAuthChanges } from "./auth-changes.mjs";` (keep the imports sorted as they are:
    put it after `import { createManageClient } from "./auth-manage.mjs";`).
  - The comment above `createIntegrationStack` and the function become:

```js
// The service over `db`. ready() migrates and creates the event partitions before the first request, once; a failure
// answers 503 and the next request tries again. The partitions are then kept up hourly. `stationFetch` (proof of
// control), `pushFetch` (change nudges), `builtInSyncAfter` and `authChanges` (the timing of the reader of Auth's
// change feed) are only given by tests; production uses the defaults.
export function createIntegrationStack({ db, manage, idp, log, stationFetch = createStationFetch(), pushFetch, builtInSyncAfter = BUILT_IN_SYNC_AFTER, authChanges = AUTH_CHANGES }) {
  const exchange = (idToken, origin) => idp ? idp.exchangeForStation(idToken, origin) : Promise.reject(new TokenError(503, "unavailable"));
  const repository = createRepository(db);
  // Auth's change feed (spec §3.3.4, D26): read once the stack is ready, then after every nudge from Auth, every 30
  // seconds, and when Auth answers 409 admin_paused to a resume (it changed something the Portal has not read yet).
  let feed = null;
  const service = createIntegrationService({ repository, db, manage, stationFetch, pushFetch, exchange, log, authChanged: () => feed?.request() });
  feed = createAuthChanges({ repository, manage, apply: (change) => service.applyAuthChange(change), log, settings: authChanges });
  let pending = null;
  let prepared = false;
  const partitions = setInterval(() => {
    if (prepared) db.ensureEventPartitions().catch((error) => log("Integration event partitions failed: " + (error.code || "error") + "."));
  }, PARTITION_INTERVAL);
  partitions.unref();
  // The built-in Stations, synced from Auth's account-less listing once the stack is ready and then hourly (P17, D26);
  // a failed sync is logged by syncBuiltIn and tried again a minute later. ready() waits for the first sync, which is
  // bounded by the management call's 10 s timeout plus the database statements of reconciling (each within
  // statement_timeout).
  let builtInSync = null;
  let closed = false;
  const syncBuiltIn = async () => {
    const synced = await service.syncBuiltIn();
    if (closed) return;
    builtInSync = setTimeout(syncBuiltIn, synced ? builtInSyncAfter.ok : builtInSyncAfter.failed);
    builtInSync.unref();
  };
  function ready() {
    pending ||= (async () => {
      await db.migrate();
      await db.ensureEventPartitions();
      prepared = true;
      await syncBuiltIn();
      if (!closed) feed.start();
      return service;
    })().catch((error) => {
      pending = null;
      log("Portal database is not ready: " + (error.code || "error") + ".");
      throw new AppError(503, "Stations and integrations are unavailable right now. Try again shortly.");
    });
    return pending;
  }
  // Auth's nudge (POST /auth/integration-changes, scripts/serve.mjs): read the feed soon, making the stack ready first
  // if it is not yet (ready() logs a failure). Never throws and never waits.
  function nudge() {
    ready().then(() => feed.request(), () => {});
  }
  return {
    service, ready, nudge,
    close: async () => {
      closed = true;
      clearInterval(partitions);
      clearTimeout(builtInSync);
      await feed.stop();
      await db.close();
    }
  };
}
```

  - `integrationsFromEnv`: the comment's last sentence becomes `Tests may pass \`stationFetch\`, \`pushFetch\` and
    \`authChanges\` (see createIntegrationStack).`, its parameters `(env, { idp, log, stationFetch, pushFetch, authChanges })`,
    and its last line
    `return createIntegrationStack({ db: createDatabase(env.DATABASE_URL, { log }), manage, idp, log, stationFetch, pushFetch, authChanges });`.

- [ ] **Step 7: Run the tests to see them pass.**
  Run: `node --test tests/integrations-auth-changes.test.mjs tests/integrations-auth-manage.test.mjs tests/integrations-routes.test.mjs`
  Expected: PASS.

- [ ] **Step 8: Run the whole suite.** Run: `npm test`. Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add scripts/integrations/auth-changes.mjs scripts/integrations/auth-manage.mjs scripts/integrations/routes.mjs tests/integrations-auth-changes.test.mjs tests/integrations-auth-manage.test.mjs tests/integrations-routes.test.mjs
git commit -F - <<'EOF'
Read Auth's change feed on a nudge and every 30 seconds, one read at a time

🤖 Built with SMT <smt@agora.build>
EOF
```

---

### Task 7: Auth's nudge: `POST /auth/integration-changes`

**Files:**
- Modify: `scripts/integrations/routes.mjs` (constants; `readyIntegrations`)
- Modify: `scripts/serve.mjs` (import; the integrations stack line; the nudge route after `/auth/backchannel-logout`)
- Test: `tests/integrations-routes.test.mjs`

**Interfaces:**
- Consumes: Task 6's `stack.nudge()`.
- Produces:
  ```js
  // scripts/integrations/routes.mjs
  export const CHANGES_NUDGE_PATH = "/auth/integration-changes";
  export const NUDGES_PER_MINUTE = 60;
  export const readyIntegrations = (service, nudge = () => {}) => ({ service, ready, nudge, close })
  // scripts/serve.mjs: createAppServer(directory, { integrations, integrationNudge }) — integrationNudge for tests
  // POST /auth/integration-changes -> 204 | 405 (Allow: POST) | 413 | 429 (Retry-After: 60) | 404 (no stack); no body
  ```

- [ ] **Step 1: Write the failing tests.** In `tests/integrations-routes.test.mjs`, in `start`, after the line
  `...("integrations" in options ? { integrations: options.integrations } : {})` add a comma and
  `...("integrationNudge" in options ? { integrationNudge: options.integrationNudge } : {})`. Append:

```js
test("Auth's nudge is a bodiless POST that only asks for a read of Auth's feed: no session, no same-origin check, 60 a minute", async (t) => {
  const nudges = [];
  const app = await start(t, { integrations: {}, integrationNudge: () => nudges.push(Date.now()) });
  const nudge = (init = {}) => fetch(app.base + "/auth/integration-changes", { method: "POST", ...init });
  const answer = await nudge();
  assert.deepEqual([answer.status, await answer.text(), answer.headers.get("cache-control")], [204, "", "no-store"]);
  assert.equal(nudges.length, 1);
  // Server to server: another site's Origin and Sec-Fetch-Site don't matter, and nothing it sends is read.
  assert.equal((await nudge({ headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } })).status, 204);
  for (const body of ["{}", "x"]) assert.equal((await nudge({ body, headers: { "Content-Type": "application/json" } })).status, 413, "a nudge carries no body");
  const get = await fetch(app.base + "/auth/integration-changes");
  assert.deepEqual([get.status, get.headers.get("allow")], [405, "POST"]);
  assert.equal(nudges.length, 2, "only the bodiless POSTs asked for a read");
  // The address's allowance is 60 a minute, every POST counted; refused ones ask for nothing.
  let accepted = 0;
  let refused = null;
  for (let index = 0; index < 70; index += 1) {
    const response = await nudge();
    if (response.status === 204) accepted += 1;
    else refused ??= response;
  }
  assert.equal(accepted, 56, "four POSTs above already counted");
  assert.deepEqual([refused.status, refused.headers.get("retry-after")], [429, "60"]);
  assert.equal(nudges.length, 58);
});

test("without Stations and integrations the nudge answers 404", async (t) => {
  const app = await start(t, { integrations: null });
  assert.equal((await fetch(app.base + "/auth/integration-changes", { method: "POST" })).status, 404);
});
```

- [ ] **Step 2: Run them to see them fail.**
  Run: `node --test tests/integrations-routes.test.mjs`
  Expected: FAIL (the POST answers 405 from the static file handler: `Method not allowed`).

- [ ] **Step 3: `scripts/integrations/routes.mjs`.** After `const CHANGES_PER_MINUTE = 30;` add:

```js
// Auth's nudge after an integration change the Portal did not make (spec §3.3.4): the path is the Portal client's
// changesNudgeUri in Auth's clients file, and one address may send this many a minute.
export const CHANGES_NUDGE_PATH = "/auth/integration-changes";
export const NUDGES_PER_MINUTE = 60;
```

  and `readyIntegrations` with its comment becomes:

```js
// The stack for a ready service (tests): nothing to prepare or close; `nudge` stands in for the reader's request.
export const readyIntegrations = (service, nudge = () => {}) => ({ service, ready: async () => service, nudge, close: async () => {} });
```

- [ ] **Step 4: `scripts/serve.mjs`.**
  - The import becomes
    `import { CHANGES_NUDGE_PATH, handleIntegrations, integrationPath, integrationsFromEnv, NUDGES_PER_MINUTE, readyIntegrations } from "./integrations/routes.mjs";`.
  - The integrations line and its comment become:

```js
  // Stations and integrations: a ready service (tests, with integrationNudge standing in for Auth's nudge), null (off),
  // or built from DATABASE_URL; without it every integration route answers 503. integrationOptions ({ stationFetch,
  // pushFetch, authChanges }) are for the end-to-end tests.
  const integrations = "integrations" in options ? (options.integrations && readyIntegrations(options.integrations, options.integrationNudge)) : integrationsFromEnv(process.env, { ...options.integrationOptions, idp, log });
```

  - After the `if (path === "/auth/backchannel-logout") { … }` block add:

```js
      if (path === CHANGES_NUDGE_PATH) {
        // Auth's nudge after an integration change the Portal did not make (an Agora.Build admin's, or Auth's own;
        // spec §3.3.4). Server to server like the back-channel logout, so it is the other exemption from the
        // same-origin checks below. It carries nothing and proves nothing: all it does is ask for a read of Auth's
        // change feed over the Portal's own authenticated connection, and those reads are one at a time and at least a
        // second apart however many nudges arrive (integrations/auth-changes.mjs), so a forged one costs no more than an
        // early poll. No body is ever read.
        const done = (status, headers = {}) => { response.writeHead(status, { "Cache-Control": "no-store", ...headers }).end(); };
        if (request.method !== "POST") { done(405, { Allow: "POST" }); return; }
        try { limit("nudge:" + clientAddress(request), NUDGES_PER_MINUTE, 60000); }
        catch { done(429, { "Retry-After": "60" }); return; }
        if (request.headers["transfer-encoding"] !== undefined || (request.headers["content-length"] ?? "0") !== "0") { done(413, { Connection: "close" }); return; }
        if (!integrations) { done(404); return; }
        integrations.nudge();
        done(204);
        return;
      }
```

- [ ] **Step 5: Run the tests to see them pass.**
  Run: `node --test tests/integrations-routes.test.mjs tests/server.test.mjs tests/routes-idp.test.mjs`
  Expected: PASS.

- [ ] **Step 6: Run the whole suite.** Run: `npm test`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add scripts/integrations/routes.mjs scripts/serve.mjs tests/integrations-routes.test.mjs
git commit -F - <<'EOF'
Take Auth's data-less nudge at /auth/integration-changes

🤖 Built with SMT <smt@agora.build>
EOF
```

---

### Task 8: The account page: "Paused by Agora.Build", no Resume

**Files:**
- Modify: `integrations.js` (constants after `NO_DETAILS`; `openHistory`; `integrationRow`)
- Test: `tests/integrations-page.test.mjs`

**Interfaces:**
- Consumes: Task 4's view field `pausedBy`, Task 5's history `actor` `agora_build`, the `409 admin_paused` answer
  (`{ error, code: "admin_paused" }`).
- Produces: an integration row whose `state` is `paused` and `pausedBy` is `admin` shows the badge
  "Paused by Agora.Build", no Resume button, the owner's note, and keeps Revoke and the owner's panels.

- [ ] **Step 1: Write the failing test.** Append to `tests/integrations-page.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it to see it fail.**
  Run: `node --test tests/integrations-page.test.mjs`
  Expected: FAIL (no `PAUSED_BY_AGORA`).

- [ ] **Step 3: `integrations.js`.**
  - After `const NO_DETAILS = "This Station does not offer details yet.";` add:

```js
// An integration Agora.Build stopped (an admin's pause, or its owner's account disabled): only Agora.Build lifts it.
const PAUSED_BY_AGORA = "Paused by Agora.Build";
const LOCKED_NOTE = "Agora.Build paused this integration. Only Agora.Build can resume it; you can still revoke it.";
```

  - In `openHistory`, `entry.actor ? "by " + entry.actor : ""` becomes
    `entry.actor ? "by " + (entry.actor === "agora_build" ? "Agora.Build" : entry.actor) : ""`.
  - In `integrationRow`, after `const state = integration.state;` add:

```js
  // Paused by Agora.Build: shown as such, with no Resume (Auth answers 409 admin_paused to anyone but an admin).
  const locked = state === "paused" && integration.pausedBy === "admin";
```

    the Resume block becomes:

```js
  if (owner && state === "paused" && !locked) {
    const resume = el("button", { class: "inline-link", type: "button", text: "Resume" });
    resume.addEventListener("click", () => act(resume, output, async () => {
      try { await change("resume"); }
      catch (error) {
        // Agora.Build paused it since this list was loaded: say so, and show the list as it is now.
        if (error.code !== "admin_paused") throw error;
        notify(error.message);
        await loadIntegrations();
      }
    }));
    actions.append(resume);
  }
```

    the badge's `text: stateLabel(state)` becomes `text: locked ? PAUSED_BY_AGORA : stateLabel(state)`, and after the
    line `...(owner ? [] : [el("p", { class: "muted", text: "Another account's integration on your Station. You can pause or revoke it." })]),`
    add:

```js
    ...(owner && locked ? [el("p", { class: "muted", text: LOCKED_NOTE })] : []),
```

- [ ] **Step 4: Run the tests to see them pass.**
  Run: `node --test tests/integrations-page.test.mjs tests/server.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Run the whole suite.** Run: `npm test`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add integrations.js tests/integrations-page.test.mjs
git commit -F - <<'EOF'
Show an admin's pause as Paused by Agora.Build, without Resume

🤖 Built with SMT <smt@agora.build>
EOF
```

---

### Task 9: End to end against the real Auth, and the browser smoke

**Files:**
- Modify: `tests/e2e/harness.mjs` (imports; `authHasChangeFeed`, `authHasAdminPauseLock`; header comment;
  `clientsDocument`; `startPortal`; `startStack`)
- Modify: `tests/e2e/built-in-station.e2e.mjs` (imports; the stack's options; tests 9 and 10; a second `describe`)
- Modify: `scripts/browser-smoke-integrations.mjs` (header comment; the "built-in Station with integrations on" step)

**Interfaces:**
- Consumes: Tasks 3–8; Auth `feat/admin-mfa` with Tasks 13 (feed, nudge, `changesNudgeUri`) and 14 (`pausedBy`,
  `409 admin_paused`); Auth's `services.integrations.change(clientId, { status }, { actor, admin: true, reason })`.
- Produces:
  ```js
  export const authHasChangeFeed: boolean;     // the Auth checkout has src/change-nudge.mjs
  export const authHasAdminPauseLock: boolean; // the Auth checkout has migrations/009_admin_pause.sql
  startStack(lib, { integrations, builtIn, nudge = authHasChangeFeed ? "portal" : null, authChanges })
  stack.adminChange(clientId, { status, reason }): Promise<integration>   // needs builtIn
  stack.portalQuery(text, values): Promise<pg.QueryResult>                // needs integrations
  ```

- [ ] **Step 1: `tests/e2e/harness.mjs`.**
  - After `import { createStationFetch } from "../../scripts/integrations/proof.mjs";` add
    `import { CHANGES_NUDGE_PATH } from "../../scripts/integrations/routes.mjs";`.
  - After `export const authRepo = …;` add:

```js
// What the Auth checkout has of D26 (spec §3.3.4), built task by task on feat/admin-mfa: the change feed and the nudge
// (Task 13), and the admin pause lock (Task 14). An older Auth refuses changesNudgeUri in its clients file.
export const authHasChangeFeed = existsSync(resolve(authRepo, "src/change-nudge.mjs"));
export const authHasAdminPauseLock = existsSync(resolve(authRepo, "migrations/009_admin_pause.sql"));
```

  - In the header comment, after the paragraph about `builtIn`, add:

```js
// With integrations, Auth's clients file gives the Portal client a changesNudgeUri (when the Auth checkout has the
// change feed): the Portal's own /auth/integration-changes, or with `nudge: "lost"` a port nobody listens on, so only
// the Portal's poll brings Auth's changes. `stack.adminChange()` makes an Agora.Build admin's change at Auth.
```

  - `clientsDocument(site, { integrations = false, builtIn = null } = {})` becomes
    `clientsDocument(site, { integrations = false, builtIn = null, nudgeUri = null } = {})`, and after
    `Object.assign(document.clients[0], { manage: true, exchange: true, stationScopes: ["station.read"] });` add
    `if (nudgeUri) document.clients[0].changesNudgeUri = nudgeUri;`.
  - `startPortal`'s parameters become `{ issuer, port, directory, clientSecret, logs, databaseUrl, authChanges }`, and
    `...(databaseUrl ? { integrationOptions: stationFetches() } : {})` becomes
    `...(databaseUrl ? { integrationOptions: { ...stationFetches(), ...(authChanges ? { authChanges } : {}) } } : {})`.
  - `startStack` and the comment above it become:

```js
// One IdP + one Portal. Returns everything a flow needs; close() tears it all down. `integrations` turns on Stations
// and integrations (see the top of this file); it needs PORTAL_TEST_DATABASE_URL (integrationsSkipReason()).
// `builtIn: { admin }` adds the built-in Station (see the top of this file); it needs `integrations`. `nudge` is where
// Auth sends its change nudge: "portal" (the Portal's /auth/integration-changes, the default when the Auth checkout
// has the change feed), "lost" (a port nobody listens on) or null (no changesNudgeUri). `authChanges` sets the
// Portal's reader timing (scripts/integrations/auth-changes.mjs).
export async function startStack(lib, { integrations = false, builtIn = null, nudge = authHasChangeFeed ? "portal" : null, authChanges } = {}) {
  if (builtIn && !integrations) throw new TypeError("builtIn needs integrations: true");
  const directory = await mkdtemp(resolve(tmpdir(), "portal-e2e-"));
  const front = createFront();
  await front.start();
  const issuer = "http://auth.localhost:" + front.port;
  const portalPort = await freePort();
  const site = "http://127.0.0.1:" + portalPort;
  const nudgeUri = !integrations || !nudge ? null : nudge === "lost" ? "http://127.0.0.1:" + (await freePort()) + CHANGES_NUDGE_PATH : site + CHANGES_NUDGE_PATH;
  const secrets = { PORTAL_CLIENT_SECRET: secret(), SAMPLE_CLIENT_SECRET: secret(), VOX_CLIENT_SECRET: secret(), NOTES_CLIENT_SECRET: secret() };
  const station = builtIn ? await startBuiltInStation() : null;
  let entry = station ? { origin: station.origin, reportJwk: station.reportJwk, integrations: false, admins: [PLACEHOLDER_ADMIN] } : null;
  const auth = await lib.startAuth({ issuer, clients: clientsDocument(site, { integrations, builtIn: entry, nudgeUri }), env: secrets });
  front.point(auth.origin);
  // What the relying-party helpers need: the issuer, reached over real HTTP through its public address.
  const idp = { issuer, fake: auth.fake, fetch: (input, init) => fetch(input, init) };
  // Another Auth instance on the same database with a changed built-in entry (Auth re-seeds it at startup), as a
  // restart with an edited clients file; the front then sends everything there.
  const instances = [];
  async function reconfigureAuth(changes) {
    entry = { ...entry, ...changes };
    const app = await lib.createApp({ config: auth.app.services.config, db: auth.db, clientsDocument: clientsDocument(site, { integrations, builtIn: entry, nudgeUri }), upstream: auth.app.services.upstream, timers: false, listen: false });
    const server = createServer(app.handler);
    await listen(server, 0, "127.0.0.1");
    instances.push({ app, server });
    front.point("http://127.0.0.1:" + server.address().port);
  }
  const adminId = builtIn ? await signInAtAuth(lib, { issuer, site, idp, secrets }, builtIn.admin) : null;
  if (adminId) await reconfigureAuth({ admins: [adminId] });
  const logs = [];
  const database = integrations ? await portalDatabase() : null;
  const portal = await startPortal({ issuer, port: portalPort, directory, clientSecret: secrets.PORTAL_CLIENT_SECRET, logs, databaseUrl: database?.url, authChanges })
    .catch(async (error) => { await database?.drop(); throw error; });
  const closers = [];
  let portalClient = null;
  const stack = {
    issuer, site, auth, idp, front, portal, store: portal.store, logs, secrets, directory, reconfigureAuth, builtIn: null,
    // Another Portal against the same issuer (for example one started while the IdP is down).
    async extraPortal() {
      const extra = await startPortal({ issuer, port: await freePort(), directory, clientSecret: secrets.PORTAL_CLIENT_SECRET, logs });
      closers.push(extra.close);
      return extra;
    },
    // An Agora.Build admin's change at Auth, as the admin site's call makes it once Auth's step-up gate has passed:
    // Auth's integration store with admin: true and a reason, which writes the change feed and sends the nudge (spec
    // §3.3.4; the gate itself is Auth's own test coverage). Needs `builtIn`, whose admin acts.
    adminChange(clientId, { status, reason }) {
      if (!adminId) throw new TypeError("adminChange needs the builtIn option");
      return auth.app.services.integrations.change(clientId, { status }, { actor: adminId, admin: true, reason });
    },
    // A query on this Portal's own database schema (integrations only), for what the Portal's API does not show.
    async portalQuery(text, values) {
      if (!database) throw new TypeError("portalQuery needs the integrations option");
      if (!portalClient) {
        portalClient = new pg.Client({ connectionString: database.url });
        await portalClient.connect();
      }
      return portalClient.query(text, values);
    },
    async close() {
      for (const close of closers) await close();
      await station?.close();
      await portal.close();
      await portalClient?.end();
      await database?.drop();
      for (const { app, server } of instances) { await shut(server); await app.close(); }
      await front.stop();
      await auth.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  if (station) {
    const answer = await fetch(issuer + "/manage/v1/stations?account=" + adminId, { headers: { Authorization: "Basic " + Buffer.from("portal:" + encodeURIComponent(secrets.PORTAL_CLIENT_SECRET)).toString("base64"), Accept: "application/json" } });
    const seeded = (await answer.json()).stations.find((listed) => listed.builtIn);
    stack.builtIn = {
      id: seeded.id, origin: station.origin, reportClientId: seeded.reportClientId, adminId, nudges: station.nudges, close: station.close,
      reportToken: ({ resource = API, scope = "station.report" } = {}) => clientCredentials(stack, { clientId: seeded.reportClientId, privateKey: station.privateKey, resource, scope })
    };
  }
  return stack;
}
```

- [ ] **Step 2: `tests/e2e/built-in-station.e2e.mjs`.**
  - The harness import gains `authHasAdminPauseLock, authHasChangeFeed`, and after the `skip` line add:

```js
// The D26 flows need Auth's change feed and admin pause lock (Auth feat/admin-mfa Tasks 13 and 14).
const d26Skip = !authHasChangeFeed ? "the Auth checkout has no change feed (Auth D26 Task 13)" : !authHasAdminPauseLock ? "the Auth checkout has no admin pause lock (Auth D26 Task 14)" : false;
const ADMIN_PAUSED = "Agora.Build paused this integration. Only Agora.Build can resume it.";
```

  - In `before`, the stack becomes
    `stack = await startStack(lib, { integrations: true, builtIn: { admin: person(7301, "Cy") }, authChanges: { pollMs: 3600000, minGapMs: 100 } });`
    (its poll is an hour, so changes reach the Portal here only through Auth's nudge).
  - After test 8, inside the `describe`, add:

```js
  test("9. an admin's pause at Auth reaches the Portal's events and the Station's feed through Auth's nudge", { skip: d26Skip }, async () => {
    const id = state.boFirst.id;
    const token = (await built.reportToken()).body.access_token;
    const start = (await feed(0, token)).body.cursor;
    const pushes = built.nudges.length;
    const paused = await stack.adminChange(id, { status: "paused", reason: "Spam in #general" });
    assert.deepEqual([paused.status, paused.pausedBy], ["paused", "admin"], "paused at Auth");
    // The Portal reads Auth's feed only on nudges here, and the Station's feed does not reconcile from Auth.
    const change = await eventually(async () => (await feed(start, token)).body.changes.find((entry) => entry.integrationId === id && entry.kind === "integration_paused"));
    assert.ok(change, "the Station's feed has the pause");
    assert.deepEqual([change.reason, change.integration.state], ["agora_build", "paused"]);
    assert.ok(await eventually(() => built.nudges.length > pushes), "and the Station was pushed");
    const [recorded] = (await stack.portalQuery("SELECT actor, reason, details FROM integration_events WHERE integration_id = $1 AND kind = 'integration_paused' ORDER BY id DESC LIMIT 1", [id])).rows;
    assert.deepEqual([recorded.actor, recorded.reason, recorded.details.admin, recorded.details.pausedBy], [built.adminId, "Spam in #general", true, "admin"], "recorded with the admin as actor and the reason");
    assert.deepEqual(await auditAtAuth(id, "integration_paused"), [[state.boId, built.adminId]], "as Auth recorded it");
    const mine = (await (await state.bo.browser.api("/api/integrations")).json()).integrations.find((entry) => entry.id === id);
    assert.deepEqual([mine.state, mine.pausedBy], ["paused", "admin"]);
    const [latest] = (await (await state.bo.browser.api("/api/integrations/" + id + "/events")).json()).events;
    assert.deepEqual([latest.kind, latest.actor, latest.reason], ["integration_paused", "agora_build", null], "Bo sees Agora.Build, not the admin or the reason");
  });

  test("10. the owner cannot resume an admin's pause, in the Portal or at Auth; the admin's lift and revocation reach the Portal", { skip: d26Skip }, async () => {
    const id = state.boFirst.id;
    const resumed = await json(await state.bo.browser.api("/api/integrations/" + id + "/resume", { method: "POST", json: {} }));
    assert.deepEqual([resumed.status, resumed.body.code, resumed.body.error], [409, "admin_paused", ADMIN_PAUSED]);
    const atAuth = await manage("PATCH", "/integrations/" + id, { status: "active", actor: state.boId });
    assert.deepEqual([atAuth.status, atAuth.body.error], [409, "admin_paused"], "Auth holds the lock too");
    const token = (await built.reportToken()).body.access_token;
    const start = (await feed(0, token)).body.cursor;
    await stack.adminChange(id, { status: "active", reason: "Cleared after review" });
    assert.ok(await eventually(async () => (await feed(start, token)).body.changes.some((entry) => entry.integrationId === id && entry.kind === "integration_resumed")), "the lift reaches the Station");
    const back = (await (await state.bo.browser.api("/api/integrations")).json()).integrations.find((entry) => entry.id === id);
    assert.deepEqual([back.state, back.pausedBy], ["awaiting_approval", null]);
    await stack.adminChange(id, { status: "revoked", reason: "Confirmed abuse" });
    assert.ok(await eventually(async () => (await stack.portalQuery("SELECT state FROM integrations WHERE id = $1", [id])).rows[0].state === "revoked"), "never approved, so revoked at once");
    const rows = (await stack.portalQuery("SELECT kind, reason FROM integration_events WHERE integration_id = $1 AND actor = $2 ORDER BY id", [id, built.adminId])).rows;
    assert.deepEqual(rows.map((row) => [row.kind, row.reason]), [["integration_paused", "Spam in #general"], ["integration_resumed", "Cleared after review"], ["integration_revoked", "Confirmed abuse"]]);
  });
```

  - After the first `describe(…)` block, at the end of the file, add:

```js
describe("Admin changes reach the Portal by its poll when Auth's nudge is lost", { skip: skip || d26Skip || false }, () => {
  let lost;
  before(async () => {
    lib ??= await loadAuth();
    lost = await startStack(lib, { integrations: true, builtIn: { admin: person(7401, "Di") }, nudge: "lost", authChanges: { pollMs: 300, minGapMs: 50 } });
    await lost.reconfigureAuth({ integrations: true });
  });
  after(async () => { await lost?.close(); });

  test("an admin's pause at Auth reaches the Station's feed at the Portal's next poll", async () => {
    const { browser } = await portalSignIn(lost, person(7411, "Eve"));
    assert.equal((await browser.api("/api/stations")).status, 200);
    const created = await json(await browser.api("/api/integrations", { method: "POST", json: { stationId: lost.builtIn.id, name: "Polled", scopes: SCOPES, publicJwk: await publicJwk() } }));
    assert.equal(created.status, 201);
    const token = (await lost.builtIn.reportToken()).body.access_token;
    const read = async (cursor) => (await json(await bearer(lost, "/api/v1/stations/changes?cursor=" + cursor, token))).body;
    const start = (await read(0)).cursor;
    await lost.adminChange(created.body.id, { status: "paused", reason: "Spam" });
    const change = await eventually(async () => (await read(start)).changes.find((entry) => entry.integrationId === created.body.id && entry.kind === "integration_paused"), { timeout: 5000 });
    assert.ok(change, "the poll brought it, with the nudge lost");
    assert.deepEqual([change.reason, change.integration.state], ["agora_build", "paused"]);
    const [recorded] = (await lost.portalQuery("SELECT actor, reason FROM integration_events WHERE integration_id = $1 AND kind = 'integration_paused'", [created.body.id])).rows;
    assert.deepEqual([recorded.actor, recorded.reason], [lost.builtIn.adminId, "Spam"]);
  });
});
```

- [ ] **Step 3: Run the end-to-end suite.** With Node 22, `TEST_DATABASE_URL`, `PORTAL_TEST_DATABASE_URL` (Global
  Constraints) and the Auth checkout at `../Auth` on `feat/admin-mfa` with `npm ci` done:
  Run: `npm run test:e2e`
  Expected: PASS. With an Auth checkout lacking Task 13 or 14, tests 9, 10 and the "nudge is lost" suite are skipped
  with the reason, and the rest passes.

- [ ] **Step 4: `scripts/browser-smoke-integrations.mjs`.**
  - In the header comment, `and the Basic plan's limit of 4 there.` becomes `the Basic plan's limit of 4 there, and an
    integration an Agora.Build admin paused at Auth ("Paused by Agora.Build", no Resume).`.
  - In the "built-in Station with integrations on" step, right after the `check(…, tag + "an integration created in the
    browser lands on the built-in Station");` line add:

```js
        // An Agora.Build admin pauses it at Auth (the admin site's call): the page shows it as Agora.Build's, with no Resume.
        const builtInApp = (await json(await setup.owner.api("/api/integrations"))).body.integrations.find((entry) => entry.name === "Built-in app");
        await stack.adminChange(builtInApp.id, { status: "paused", reason: "Browser smoke" });
        await page.goto(stack.site + "/account/");
        await integration(page, "Built-in app").waitFor({ timeout: 8000 });
        await until(async () => (await badgeOf(page, "Built-in app")) === "Paused by Agora.Build", "Paused by Agora.Build");
        const locked = integration(page, "Built-in app");
        check(await locked.getByRole("button", { name: "Resume", exact: true }).count() === 0, tag + "an admin's pause offers no Resume");
        check(await locked.getByRole("button", { name: "Revoke", exact: true }).count() === 1, tag + "Revoke is still offered");
        check(/Only Agora\.Build can resume it/.test(await locked.innerText()), tag + "the row says only Agora.Build can resume it");
        await overflowCheck(page, tag, "with an integration Agora.Build paused");
        await shot(locked, viewport.name + "-paused-by-agora-build");
```

    (The paused integration still counts towards the plan limit, so the "One too many" check that follows is unchanged.)

- [ ] **Step 5: Run the browser smoke.** It needs an Auth checkout with Tasks 13 and 14 (the new check reads Auth's
  `pausedBy`). With the Step 3 settings plus `PLAYWRIGHT_CORE` and `CHROMIUM_PATH`:
  Run: `node scripts/browser-smoke-integrations.mjs`
  Expected: `All integrations browser checks passed.`

- [ ] **Step 6: Run the whole suite.** Run: `npm test`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add tests/e2e/harness.mjs tests/e2e/built-in-station.e2e.mjs scripts/browser-smoke-integrations.mjs
git commit -F - <<'EOF'
Check admin changes from Auth end to end: nudge, poll, lock and the page

🤖 Built with SMT <smt@agora.build>
EOF
```

---

### Task 10: Documentation, rollout and rollback

**Files:**
- Modify: `docs/platform.md` ("Database And Settings" clients-file bullets; "The Built-in Station" **Admins.** bullet;
  a new "Admin Changes From Auth" subsection before "### Routes"; "Verification")
- Modify: `README.md` (the identity provider table)
- No code changes.

**Interfaces:**
- Consumes: everything above. Produces: the documented Portal side of D26 and the owner's rollout steps.

- [ ] **Step 1: `docs/platform.md`.**
  - In "Auth's clients file must be set up for this:", the last bullet becomes:

```markdown
- the `portal` client has `"manage": true`, `"exchange": true`,
  `"stationScopes": ["station.read"]`, its `backchannelLogoutUri`, and
  `"changesNudgeUri": "<SITE_URL>/auth/integration-changes"` (see "Admin Changes From Auth").
```

  - At the end of the **Admins.** bullet (Task 3) add: `Their changes reach the Portal through Auth's change feed (see
    "Admin Changes From Auth").`
  - Before `### Routes` add:

```markdown
### Admin Changes From Auth

Agora.Build admins work on the admin site, which calls Auth directly. When an admin pauses, resumes or revokes an
integration, or disables or enables an account that owns integrations, the change happens at Auth first: from then on
Auth issues those integrations no token. The Portal then follows it, so that its history records it and the
integration's Station refuses still-valid tokens and closes open sessions at once.

- **The nudge.** Right after a change the Portal did not make (an admin's, or Auth's own, such as a built-in Station
  retired by its configuration), Auth sends `POST /auth/integration-changes` with no body and no credentials. The
  Portal answers 204 and reads Auth's change feed soon; it trusts nothing in the request. Like
  `/auth/backchannel-logout` it is server to server, so the same-origin checks of the `/api/` routes don't apply. Any
  other method answers 405, a request with a body 413 (the body is never read), more than 60 a minute from one
  address 429, and a Portal without Stations and integrations 404. Register it as the `portal` client's
  `changesNudgeUri` in Auth's clients file: `https://agora.build/auth/integration-changes` (dev
  `https://dev.agora.build/auth/integration-changes`).
- **The feed.** The Portal reads `GET /manage/v1/integration-changes` over its management connection after each
  nudge, every 30 seconds in case a nudge is lost, and when Auth refuses a resume with `admin_paused`. One read runs at
  a time, and reads start at least a second apart however many nudges arrive, so a forged nudge costs no more than an
  early poll. A read takes up to 10 pages of 100 changes and saves Auth's cursor after each page in
  `auth_change_feed`, so a restart continues where it stopped; when every page was full, another read follows. A
  failed read is logged once by reason until a read succeeds, and the next poll tries again from the saved cursor.
  The reader starts when the Stations and integrations stack becomes ready (the first request to one of their routes,
  a Station's feed read, or a nudge). Its first read ever goes through Auth's whole feed once.
- **Following a change.** Changes the Portal made itself (an account's pause, resume or revoke through the routes
  below) are in the feed too; they are already recorded and are skipped. For each other change the Portal updates its
  row, records an `integration_events` row with the admin as `actor` (`system` when Auth acted itself) and the reason
  given (or Auth's code, such as `configuration`), appends it to the Station's feed and pushes the Station. A pause
  pauses the integration and records who paused it (`paused_by`); a resume returns it to where it was; a revocation
  sets it to `revoking` (or `revoked` before approval), as an owner's does. An owner's account being disabled sets
  `owner_disabled_at` on each of its integrations that is not revoked: the account page and the Station's feed show
  them `paused` until the account is enabled again, when each is back as it was (one its owner had paused stays
  paused). Each change is applied once: its Auth cursor and time are kept in the event's details.
- **An admin's pause locks.** An integration Agora.Build paused shows "Paused by Agora.Build" (`pausedBy` `admin`, also
  while its owner's account is disabled) and offers no Resume. `POST /api/integrations/<id>/resume` answers 409
  `{ "error": "Agora.Build paused this integration. Only Agora.Build can resume it.", "code": "admin_paused" }` without
  asking Auth, and Auth answers the same when the Portal has not heard yet. Revoking, renewing, the quota and keys stay
  the owner's. Only an admin lifts the pause, on the admin site; the Portal follows the resume from the feed.
- **What people and Stations see.** The admin's account and the reason they typed stay in the Portal's events and in
  Auth's audit. An integration's history shows such a change as by `agora_build` (Agora.Build) without a reason, and
  the Station's feed gives it the `reason` `agora_build`.
- **After restoring Auth's database** from a backup, Auth hands out cursors again from the backup's point. Set the
  Portal's cursor back so it reads Auth's feed from the start, with
  `UPDATE auth_change_feed SET cursor = NULL;` on the Portal database. Changes it already applied are recognised and
  skipped.

#### Rolling Out Admin Changes (Dev First)

1. Keep the running images for a rollback, as for D24 (`portal:pre-d26`, `auth:pre-d26`).
2. Deploy the Portal. Migration 003 runs at the first request. Until Auth has the change feed and the built-in
   listing, the log says `Auth change feed read failed: not_found.` once and `Built-in Station sync failed: not_found.`
   each minute; built-in Stations already in the Portal keep working and every account's listing still syncs them.
   From this deploy on, admins have no pause or revoke in the Portal; they use the admin site once it is live.
3. Deploy Auth with the change feed and the admin pause lock (`feat/admin-mfa`, Tasks 13–15), and in the same restart
   add `"changesNudgeUri": "https://dev.agora.build/auth/integration-changes"` to the `portal` client in the dev
   clients file (back the file up first; an Auth without the change feed refuses that field).
4. Check: the two log lines above stop; `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dev.agora.build/auth/integration-changes`
   prints 204 and the same without `-X POST` prints 405; Auth logs no "the Portal did not accept a change nudge". Once
   integrations are on at the dev built-in Station (Astation's disposable-integration test), an admin's pause on the
   admin site shows in the Station's feed within seconds, and the integration's owner sees "Paused by Agora.Build".
5. Rollback. The Portal: run `portal:pre-d26`. Migration 003 only added columns and a table, which that image ignores;
   its `/auth/integration-changes` answers 405, so Auth logs that its nudge was not accepted and nothing else changes.
   Back on this version, the Portal continues from its saved cursor and catches up. Auth: restore its previous image
   together with its previous clients file (Auth's `deploy/DEPLOY.md`).

Production follows only after the admin site and passkeys are verified on dev, with the owner's approval.
```

  - In "Verification", the sentence ending `management client, Station registration and sharing, integration changes,
    reports, the change feed and push, the routes and the account page;` becomes `…, reports, the change feed and
    push, the reader of Auth's change feed, the nudge route and applying admin changes, the routes and the account
    page;`, and after the sentence about `tests/e2e/built-in-station.e2e.mjs` add:

```markdown
It also makes admin changes at Auth (Auth's integration store with `admin: true`, the call the admin site's request
makes once Auth's step-up gate has passed): a pause reaches the Portal's events and the Station's feed through Auth's
nudge, the owner cannot resume it in the Portal or at Auth, the admin's lift and revocation follow, and with the nudge
lost the Portal's poll still brings a pause. Those need an Auth checkout with the change feed and the admin pause lock
(Auth `feat/admin-mfa`, Tasks 13 and 14) and are skipped otherwise. The browser smoke also checks such an
integration's row ("Paused by Agora.Build", no Resume).
```

- [ ] **Step 2: `README.md`.** In the identity provider table, `back-channel logout \`/auth/backchannel-logout\`` becomes
  `back-channel logout \`/auth/backchannel-logout\`, change nudge \`/auth/integration-changes\` (the client's \`changesNudgeUri\`, with Stations and integrations)`.

- [ ] **Step 3: Final verification.**
  Run: `npm test`
  Expected: PASS.
  Run: `node --check scripts/integrations/auth-changes.mjs && node --check scripts/browser-smoke-integrations.mjs`
  Expected: no output.
  Run: `git grep -nE "station_admin|asAdmin" -- . ':!docs/superpowers' ':!tests/integrations-page.test.mjs'`
  Expected: no hits (the page test only asserts their absence).
  Run: `git grep -n "PLATFORM_ADMINS" -- scripts docs/platform.md`
  Expected: only `scripts/serve.mjs` (`platformAdmins`, for Stoa spaces) and the `docs/platform.md` sentence about
  account IDs in "Accounts, Sessions And Guests".
  Run: `git grep -nE "log\(.*(cursor|entry\.|change\.)" -- scripts/integrations/auth-changes.mjs scripts/integrations/service.mjs`
  Expected: no hits (no cursor or feed entry is logged; the reader logs only its fixed messages through `report`).

- [ ] **Step 4: Commit.**

```bash
git add docs/platform.md README.md
git commit -F - <<'EOF'
Document admin changes from Auth, the nudge, rollout and rollback

🤖 Built with SMT <smt@agora.build>
EOF
```

---

## Self-review

**Spec coverage.**

| Spec requirement (spec copy) | Task |
|---|---|
| "the startup/hourly sync uses `/manage/v1/built-in-stations` instead of listing as the first `PLATFORM_ADMINS` account (so `PLATFORM_ADMINS` is no longer needed for the sync)" | 2 (startup, hourly and one-minute retry kept); 3 (the stack no longer takes admins; the e2e runs without `PLATFORM_ADMINS`) |
| "the `station_admin` role, admin notes and admin pause/revoke on others' integrations are removed from the account page and the Portal API" | 3 (service, routes, page, e2e test 8) |
| "The Portal's own management calls cannot act across accounts" (Auth enforces) | 3 (fake and e2e assert Auth's 403); A10 |
| Custom Station owners keep pause and revoke (Auth R12) | unchanged; covered by the existing tests and Task 4's `station` pause |
| "Right after a change the Portal did not make (an admin's), Auth sends the Portal a nudge. The nudge carries no data; the Portal then reads the feed over its authenticated management connection." | 7 (route, A1), 6 (reader) |
| "The Portal records each change in `integration_events` with the admin as actor and the reason. It then appends the change to the Station's feed and pushes the Station" | 5 (A2, A4, A5), e2e 9 |
| Owner account disabled or enabled in the feed; the Station denies the owner's integrations' tokens and closes sessions | 1 (`owner_disabled_at`, `effectiveState`), 5 (A6, test of the owner's listing not undoing it) |
| "The Portal also polls the feed about every 30 seconds, in case a nudge is lost." | 6 (A3), e2e "nudge is lost" |
| "This is the same push-plus-poll pattern the Portal already uses towards the Station." | 6 (coalescing like `push()`) |
| "The integration's owner, and a custom Station's owner, cannot resume an integration an admin paused: `409 admin_paused`." | 4 (A9; the Station's owner never resumes in the Portal anyway), e2e 10 |
| "An admin pausing an integration its owner had already paused turns it into an admin pause." | 4 (reconcile follows `pausedBy`), 5 (feed conversion test) |
| "Only an admin can lift it, from the admin site" | 5 (the lift from the feed), e2e 10 |
| "The Portal shows "Paused by Agora.Build" and offers no Resume." | 8, smoke (Task 9) |
| Owner requirement 2: "The Portal appends the change to the Station's feed and pushes the Station a nudge at once." / "Worst case without the push, the Station's poll picks it up within a minute." | 5 (`changed()` after commit); the Station's existing poll |
| Owner requirement 3: "The Portal records it in `integration_events` (reason, actor)" | 5 (A7 keeps both; masks them only in outward views) |
| Tests: fake-manage for the feed, nudge and built-in listing; e2e admin pause/revoke via nudge and via poll, owner cannot resume, built-in sync without `PLATFORM_ADMINS`; browser smoke | 2, 5, 6, 7, 9 |
| Docs and dev rollout (Portal first, then Auth with `changesNudgeUri`), rollback | 10 |

**Placeholder scan.** No TBD or TODO; each code step carries its code, each test step its test code and the command
that runs it, with the expected result.

**Type consistency.** `pausedBy` (`"owner" | "station" | "admin" | null`) is the row field (Task 1), the view field
(Task 4), the fake's and Auth's field (Tasks 4–5) and the `details.pausedBy` of applied events (Task 5); the column is
`paused_by`. `ownerDisabledAt` (row) / `owner_disabled_at` (column) is set and cleared only by `authEffect` (Task 5) and
read by `effectiveState` (Task 1) and `pausedByOf` (Task 4). `repository.authChangeApplied(integrationId, cursor, at,
client)` (Task 1) is called with `entry.cursor, entry.at` (Task 5), matching `details.authCursor` / `details.authAt`.
`repository.authChangeCursor()` / `saveAuthChangeCursor(cursor)` (Task 1) are what `createAuthChanges` calls (Task 6).
`manage.integrationChanges({ after, limit })` returns `{ changes, nextCursor }` in the client (Task 6), the fake (Task 5)
and the reader's tests (Task 6). `service.applyAuthChange(entry)` (Task 5) is the reader's `apply` (Task 6).
`createIntegrationService({ …, authChanged })` (Task 4) is given `() => feed?.request()` by the stack (Task 6);
`stack.nudge()` (Task 6) is what `scripts/serve.mjs` calls through `readyIntegrations(service, nudge)` (Task 7).
`CHANGES_NUDGE_PATH` (Task 7) is used by `scripts/serve.mjs` and the e2e harness (Task 9). The masked value
`agora_build` (`AGORA_BUILD`, Task 5) is what Task 8's page and Task 9's checks expect, and `ADMIN_PAUSED` has the same
text in Task 4, Task 9 and the docs.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-31-admin-site-portal.md`. Two execution options:

1. **Subagent-Driven (recommended):** a fresh subagent per task, review between tasks (superpowers:subagent-driven-development).
2. **Inline Execution:** tasks in one session with checkpoints (superpowers:executing-plans).
