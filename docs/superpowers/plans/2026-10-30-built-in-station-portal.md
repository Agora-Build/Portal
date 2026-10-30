# Built-in Station (D24, Portal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Portal shows the built-in Station (`https://station.agora.build`, dev `https://station-dev.agora.build`)
to every signed-in account, refuses removing, sharing and re-registering it, offers it for integrations only while
Agora.Build has them on, enforces the per-plan integration limits on it, lets Agora.Build admins pause and revoke other
accounts' integrations on it, and accepts the built-in Station's own report token (whose `sub` is its `s-` client ID).

**Architecture:** Auth (branch `feat/built-in-station`, already built) seeds the built-in Station and lists it to every
account with `builtIn: true`, `owner: null`, `access`, `integrations` and `name`. The Portal mirrors it as a row in its
`stations` table (migration 002: nullable owner, `built_in`, `access`, `integrations_enabled`, `name`), created and
updated by the ordinary listing reconcile but never removed by it. Repository queries list built-in Stations for every
account with role `built_in`; the service refuses the actions Auth refuses (409 `built_in`, `origin_taken`,
`not_supported`) before calling Auth, counts plan limits from its own rows, and gives `PLATFORM_ADMINS` the role
`station_admin` on others' integrations there. `scripts/idp.mjs` accepts a token whose `sub` is its own `s-` client
ID only for `station.report`, and `scripts/serve.mjs` confines such a caller to the two report routes without making
an account.

**Tech Stack:** Node.js ≥ 20.12 built-ins (`node:http`, `node:https`, `node:crypto`, `node:test`), `pg` 8.16.3,
`jose` 6.2.12 (tests and e2e only), browser DOM. Node 22 for the end-to-end suite. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-built-in-station.md`. Binding: §3.3.2 items 1–11 (item 5 is the Portal's
list), §3.3.2.1 (Astation's accepted review and "What Auth/Portal must build"), §4 D24 and D21 (revised), §6 "Built-in
Station (D24)". The Auth contract is `~/Dev/Agora.Build/Auth/docs/integrating.md` ("Stations, integrations and the
management API", "Station report clients", "Clients-file fields") and `~/Dev/Agora.Build/Auth/src/manage.mjs` on
`feat/built-in-station` (commits `2783d9b`…`c0e52fb`). Conventions follow
`docs/superpowers/plans/2026-10-24-integrations-phase1-portal.md`. Out of scope: D25 (mobile app), Discord, account
deletion, Station AI.

## Global Constraints

- Node.js 20.12+ for the Portal and `npm test`; Node 22 for `npm run test:e2e` and the browser smoke
  (`export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"`). Built-in modules plus the existing dependencies only;
  **no new npm dependencies.** ESM `.mjs` for Node code; two-space indent, double quotes, semicolons (AGENTS.md).
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
- **Never touch `portal-postgres`, `portal-local`, `auth-local` or port 3002** while implementing. Task 9's deployment
  steps are documentation for the owner, not executed by the implementer.
- `npm test` must pass at the end of every task.
- Account IDs match `^ab[0-9A-HJKMNP-TV-Z]{26}$`; report client IDs `^s-[0-9a-hjkmnp-tv-z]{26}$` (`s-` + 26 lower-case
  Crockford base32).
- A bearer token whose `sub` is not an account is accepted **only** when `sub` matches the `s-` pattern,
  `client_id === sub` and `scope` includes `station.report`. Such a caller is never a Portal account (no
  `ensureAccount`) and reaches only `POST /api/v1/stations/reports` and `GET /api/v1/stations/changes`. Every other
  non-`ab` subject stays refused (401).
- Built-in refusals mirror Auth, without calling Auth: removing it, sharing, unsharing or leaving it and listing its
  members answer `409 built_in`; checking or registering its origin `409 origin_taken`; creating an integration on it
  while its integrations are off `409 not_supported`.
- Plan limits apply to built-in Stations only: **Basic 4, Premium 10, Principal and Fellow no cap**, counting the
  account's integrations on that Station in every state except `revoked` and not expired. At the limit: `403`, code
  `plan_limit`, message exactly `Your plan allows N integrations on the built-in Station. Revoke one, upgrade, or use
  your own Station.` Custom Stations are never capped. After a downgrade existing integrations keep working.
- Agora.Build admins are the Portal's `PLATFORM_ADMINS` (the same accounts as Auth's `admins` for the Station). On a
  built-in Station they see others' integrations and may pause or revoke them; never approve, resume, renew, rotate,
  change settings or act as the owner. Nobody else sees others' integrations there. Nobody can remove it.
- Rows are never deleted (D19); `integration_events` stays append-only.
- Never log tokens, ID tokens, keys, challenge values or request bodies; log reasons only (`log("…: " + reason + ".")`).
  Account IDs, Station IDs, report client IDs and origins are not secret.
- Dev uses its own built-in Station `https://station-dev.agora.build`, never the production origin.
- Commits: imperative subject; the message ends with the line `🤖 Built with SMT <smt@agora.build>`; no co-author
  trailers.

## Design decisions (where the spec left room)

| # | Decision | Why |
|---|---|---|
| P1 | `verifyAccessToken` returns `{ sub, clientId, scopes, station: true }` for a Station's own report token; the account shape is unchanged | Callers already branch on `caller`; one flag keeps every existing check and test intact |
| P2 | A Station's own report token on any other route gets **403** "A Station's own report token can only send reports and read the change feed." (checked before the route gates and before `ensureAccount`) | The token is valid, only used for the wrong purpose; 403 says so without creating anything |
| P3 | Migration 002 mirrors Auth's columns (`built_in`, `access`, `integrations_enabled`, `name` 1–60) with a CHECK tying `built_in` to a NULL owner and `any_account`; no admins column | Same shape as Auth's `005_built_in_stations.sql`; the Portal's admins are `PLATFORM_ADMINS`, not stored data |
| P4 | Station-level events of a built-in Station (`station_reconciled`, a `station_removed` from `retireStale`) use `account_id` = `actor` = `"system"` | `integration_events.account_id` is NOT NULL and the Station has no owner; `system` is already an actor value |
| P5 | Reconcile inserts a built-in Station from any account's listing, updates its `name` and `integrations_enabled` on every listing, and **never** removes it or revokes anything when a listing lacks it (logged). It is retired in the Portal only when Auth lists another Station at its origin (the existing `retireStale`) | Spec §3.3.2 item 5; Auth also refuses to start when a seeded built-in entry is missing (fail closed), so absence is never a normal signal |
| P6 | Stations get role `built_in`; an admin's view of another account's integration there gets role `station_admin` (recorded as the event reason) | Distinct from `station_owner`, so the page and the history say "admin", not "your Station" |
| P7 | The Portal also refuses Leave (`DELETE …/members/<self>`) and `GET …/members` with 409 `built_in` | Auth answers 409 `built_in` to every member route (Auth plan R12) |
| P8 | The built-in origin is refused already at `POST /api/stations/challenges` (and again at registration, before the proof fetch) | No challenge budget spent and no fetch to Agora.Build's server |
| P9 | Built-in Station views carry no `reportClientId` | It is not secret but only the owner sees a report client today; operators read it from Auth's database (Task 9) |
| P10 | The route resolves the account's plan (`effectivePlan` over the Portal store) and passes `{ plan }` to `createIntegration`; an unknown plan counts as Basic. The 403 adds `limit` next to `code` | The service stays storage-agnostic and testable; `limit` lets a client show the number without parsing |
| P11 | Creations by one account on one built-in Station run one at a time in the Portal process, so two racing requests cannot both pass the count; across replicas the limit is soft (bounded by the per-account creation limit of 20 a minute) | Holding a database lock across Auth's HTTP call is worse; the Portal runs one instance today |
| P12 | The Portal refuses creation while its copy of `integrations_enabled` is false, and maps Auth's own `409 not_supported` the same way (a setting turned off since the last listing) | Spec: "offers the built-in Station only while integrations are enabled", Auth stays the authority |
| P13 | Admins' listing reads every other account's integration on built-in Stations from the Portal's rows, unpaged | Auth has no per-Station listing (Auth plan C5); YAGNI until the list is large |
| P14 | Account page: the built-in row shows its name, a "Built in" badge, its origin, whether integrations are available, and Details only; the selector labels it "Agora Station (built in)" and leaves it out while off | Spec item 5 ("marked Built in, with Details, without Remove or Share") |
| P15 | `tests/helpers/fake-manage.mjs` gains `seedBuiltIn()`; no built-in Station unless a test seeds one | Existing tests keep their expectations |
| P16 | The e2e built-in flows get their own file and a stack option `builtIn: { admin }`. The harness picks the stub's `https://station.test:<port>` before Auth starts, signs the admin in at Auth through the sample app, restarts Auth on the same database with `admins: [<that account>]`, and starts the Portal with `PLATFORM_ADMINS` set to it (the real environment path). Turning integrations on is a second Auth instance on the same database, as Auth's own tests do | The admin's account ID only exists after a sign-in; the existing flows and their single-Station assertions stay untouched |
| P17 | No account-less sync of built-in Stations: the Portal learns of one from the first listing by any account; a report or feed read before that answers `403 station`. The rollout signs in once before handing the `s-` ID to Astation | Auth's listing needs an account; startup sync would tie the Portal's start to Auth |

---

## File structure

| File | Change |
| --- | --- |
| `scripts/idp.mjs` | `verifyAccessToken` accepts a Station's own report token (C1) |
| `scripts/serve.mjs` | Confine Station report callers; admins and `planOf` for the integrations |
| `migrations/002_built_in_stations.sql` (new) | Nullable owner, `built_in`, `access`, `integrations_enabled`, `name`, CHECK, indexes |
| `scripts/integrations/repository.mjs` | Built-in fields; `stationsFor` with role `built_in`; `builtInStations`, `updateBuiltInStation`, `countLiveIntegrations` |
| `scripts/integrations/service.mjs` | Reconcile, views and refusals for built-in Stations; integrations gate, plan limits, admins |
| `scripts/integrations/routes.mjs` | `admins` through the stack; `planOf` into creation |
| `scripts/plans.mjs` | `builtInIntegrationLimit(plan)` |
| `integrations.js`, `account.html`, `styles.css` | Built-in row, selector, admin note, copy |
| `tests/helpers/fake-manage.mjs` | Built-in Stations as Auth answers them |
| `tests/idp.test.mjs`, `tests/integrations-routes.test.mjs`, `tests/integrations-db.test.mjs`, `tests/integrations-repository.test.mjs`, `tests/integrations-stations.test.mjs`, `tests/integrations-service.test.mjs`, `tests/integrations-page.test.mjs`, `tests/platform.test.mjs` | Tests per task |
| `tests/e2e/harness.mjs` | `builtIn` stack option, `reconfigureAuth`, exported `clientCredentials` |
| `tests/e2e/integrations.e2e.mjs` | Uses the exported `clientCredentials` |
| `tests/e2e/built-in-station.e2e.mjs` (new) | Built-in flows against the real Auth |
| `scripts/browser-smoke-integrations.mjs` | Built-in row and selector checks |
| `docs/platform.md` | "Stations And Integrations" and "Apps" sections, "Verification" |

---

### Task 1: Accept the built-in Station's own report token (C1)

**Files:**
- Modify: `scripts/idp.mjs:347-353` (`verifyAccessToken`)
- Modify: `scripts/serve.mjs:60-80` (constants), `scripts/serve.mjs:292-298` (route gates)
- Test: `tests/idp.test.mjs`, `tests/integrations-routes.test.mjs`

**Interfaces:**
- Produces: `idp.verifyAccessToken(token)` → `{ sub, clientId, scopes }` for an account (unchanged) or
  `{ sub, clientId, scopes, station: true }` when `sub` is an `s-` report client ID equal to `client_id` and `scopes`
  includes `station.report`. In `serve.mjs`, `caller.station === true` callers reach only
  `POST /api/v1/stations/reports` and `GET /api/v1/stations/changes`, and `caller.account` is never set for them.
  `scripts/integrations/routes.mjs` `reporter()` is unchanged (it uses `caller.clientId`).

- [ ] **Step 1: Write the failing idp test.** Append to `tests/idp.test.mjs`:

```js
test("bearer: a Station report client's own token (sub = its s- client ID) is accepted only with station.report", async () => {
  const { fake, idp } = await setup();
  const client = "s-" + "0".repeat(24) + "bs";
  assert.deepEqual(await idp.verifyAccessToken(await fake.issueAccessToken({ sub: client, client_id: client, scope: "station.report" })), { sub: client, clientId: client, scopes: ["station.report"], station: true });
  for (const claims of [
    { sub: client, client_id: "s-" + "1".repeat(26), scope: "station.report" },
    { sub: client, client_id: client, scope: "credits" },
    { sub: client, client_id: client, scope: undefined },
    { sub: "s-" + "0".repeat(24) + "BS", client_id: "s-" + "0".repeat(24) + "BS", scope: "station.report" },
    { sub: "s-" + "0".repeat(24) + "bu", client_id: "s-" + "0".repeat(24) + "bu", scope: "station.report" },
    { sub: "s-" + "0".repeat(25), client_id: "s-" + "0".repeat(25), scope: "station.report" },
    { sub: "i-" + "0".repeat(26), client_id: "i-" + "0".repeat(26), scope: "station.report" },
    { sub: "portal", client_id: "portal", scope: "station.report" }
  ]) await rejectsToken(idp.verifyAccessToken(await fake.issueAccessToken(claims)), 401);
  const owner = fake.accountId();
  assert.deepEqual(await idp.verifyAccessToken(await fake.issueAccessToken({ sub: owner, client_id: client, scope: "station.report" })), { sub: owner, clientId: client, scopes: ["station.report"] }, "a custom Station's report token (sub = its owner) is unchanged");
});
```

- [ ] **Step 2: Write the failing route test.** In `tests/integrations-routes.test.mjs` add, after the existing
  `"Station reports and the change feed take only the Station's station.report token"` test:

```js
const STATION_CLIENT = "s-" + "0".repeat(24) + "bs";
const REPORT_TOKEN_ONLY = "A Station's own report token can only send reports and read the change feed.";

test("a Station report client's own token reaches only the report routes and never becomes an account", async (t) => {
  const app = await start(t, { integrations: null });
  const token = await app.fake.issueAccessToken({ sub: STATION_CLIENT, client_id: STATION_CLIENT, scope: "station.report" });
  // Without the Portal database the report routes answer 503: the token got through the gates to the route itself.
  const reports = await call(app.base, "/api/v1/stations/reports", { bearer: token, method: "POST", data: {} });
  assert.deepEqual([reports.status, (await reports.json()).error], [503, UNAVAILABLE]);
  assert.equal((await call(app.base, "/api/v1/stations/changes?cursor=0", { bearer: token })).status, 503);
  for (const [method, path] of [["GET", "/api/v1/me"], ["GET", "/api/v1/integrations"], ["GET", "/api/v1/credits/balance"], ["GET", "/api/people"], ["GET", "/api/auth/config"], ["GET", "/api/billing/account"], ["GET", "/api/stations"]]) {
    const response = await call(app.base, path, { bearer: token, method });
    assert.deepEqual([response.status, (await response.json()).error], [403, REPORT_TOKEN_ONLY], method + " " + path);
  }
  assert.equal((await call(app.base, "/api/stations/reports", { bearer: token, method: "POST", data: {} })).status, 404, "the unversioned path still names /api/v1");
  assert.equal((await app.store.snapshot()).accounts.some((account) => account.id === STATION_CLIENT), false, "no Portal account for the report client");
});
```

- [ ] **Step 3: Run them to verify they fail.**
  Run: `node --test tests/idp.test.mjs tests/integrations-routes.test.mjs`
  Expected: FAIL — the idp test with a 401 for the first token, the route test with 401 instead of 503.

- [ ] **Step 4: Implement in `scripts/idp.mjs`.** Next to the other module-level patterns add:

```js
// A Station report client: s- and 26 lower-case Crockford base32 characters (Auth's runtime client IDs).
const STATION_CLIENT_ID = /^s-[0-9a-hjkmnp-tv-z]{26}$/;
```

  and replace `verifyAccessToken` with:

```js
    // An account's token (sub = ab…), or a Station report client's own token: a built-in Station has no owner, so Auth
    // gives its report token sub = the report client's own s- ID (Auth's integrating.md, "Station report clients").
    // That form is accepted only for that client and only with station.report; any other subject is refused.
    async verifyAccessToken(token) {
      const payload = await verify(token, { audience, typ: "at+jwt", requiredClaims: ["exp", "sub"] });
      if (!plainString(payload.client_id, 200)) throw new TokenError(401, "client_id");
      const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
      if (typeof payload.sub === "string" && STATION_CLIENT_ID.test(payload.sub)) {
        if (payload.client_id !== payload.sub || !scopes.includes("station.report")) throw new TokenError(401, "sub");
        return { sub: payload.sub, clientId: payload.client_id, scopes, station: true };
      }
      if (typeof payload.sub !== "string" || !ACCOUNT_ID.test(payload.sub)) throw new TokenError(401, "sub");
      return { sub: payload.sub, clientId: payload.client_id, scopes };
    }
```

- [ ] **Step 5: Implement in `scripts/serve.mjs`.** After the `isBearerRoute` line (around line 72) add:

```js
// A Station's own report token (sub = its s- report client; a built-in Station has no owner) is not an account: it
// reaches these two routes only, and no Portal account is made for it.
const stationReportRoutes = new Set(["POST /api/stations/reports", "GET /api/stations/changes"]);
const reportTokenOnly = () => new AppError(403, "A Station's own report token can only send reports and read the change feed.");
```

  and replace the gate lines after `const route = request.method + " " + path;` with:

```js
        if (caller?.station && !stationReportRoutes.has(route)) throw reportTokenOnly();
        if (caller && !publicRoutes.has(route) && !isBearerRoute(route)) throw browserRoute(route, path) ? browserOnly() : new AppError(404, "This page or service was not found.");
        if (caller && !versioned && isBearerRoute(route)) throw new AppError(404, "Access tokens use the versioned API: " + API_V1 + path.slice("/api/".length) + ".");
        // Only after the route gate, so a token that reaches a 404, browser-only or public route creates nothing; a
        // Station's own report token never makes an account.
        if (caller && !caller.station && isBearerRoute(route)) caller.account = await store.ensureAccount(caller.sub);
```

- [ ] **Step 6: Run the tests.**
  Run: `node --test tests/idp.test.mjs tests/integrations-routes.test.mjs && npm test`
  Expected: PASS (route tests needing PostgreSQL are skipped without `PORTAL_TEST_DATABASE_URL`; run once with it set).

- [ ] **Step 7: Commit.**

```bash
git add scripts/idp.mjs scripts/serve.mjs tests/idp.test.mjs tests/integrations-routes.test.mjs
git commit -m "Accept a Station's own report token, for the report routes only" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: Migration 002 and the repository for built-in Stations

**Files:**
- Create: `migrations/002_built_in_stations.sql`
- Modify: `scripts/integrations/repository.mjs` (`stationRow`, `insertStation`, `stationsFor`; new `builtInStations`,
  `updateBuiltInStation`, `countLiveIntegrations`)
- Test: `tests/integrations-db.test.mjs:11,14`, `tests/integrations-repository.test.mjs`

**Interfaces:**
- Produces (repository, every method takes an optional transaction `client` last):
  - Station objects gain `builtIn: boolean`, `access: "members" | "any_account"`, `integrationsEnabled: boolean`,
    `name: string | null`; `ownerAccount` is `null` for a built-in Station.
  - `insertStation({ id, origin, ownerAccount = null, reportClientId, verifiedAt, builtIn = false, integrationsEnabled = true, name = null }) → boolean`
  - `stationsFor(accountId)` → active Stations with `role` `"built_in"` (every built-in Station), `"owner"` or
    `"member"`, built-in first, then `created_at, id`.
  - `builtInStations() → Station[]` (active built-in, oldest first)
  - `updateBuiltInStation(id, { name, integrationsEnabled }) → boolean` (true when something changed; custom rows untouched)
  - `countLiveIntegrations(stationId, ownerAccount, now) → number` (state ≠ `revoked`, `expires_at > now`)

- [ ] **Step 1: Write the failing tests.** In `tests/integrations-db.test.mjs` change both expected lists to
  `["001_integrations.sql", "002_built_in_stations.sql"]` (the `results.flat()` line 11 and the `rows.map` line 14).
  Append to `tests/integrations-repository.test.mjs`:

```js
test("built-in Stations: no owner, listed for every account first with role built_in, and following Auth", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  await station(repo, "st1", "ab1");
  assert.equal(await repo.insertStation({ id: "stb", origin: "https://station.agora.test", reportClientId: "s-stb", verifiedAt: NOW, builtIn: true, integrationsEnabled: false, name: "Agora Station" }), true);
  const built = await repo.station("stb");
  assert.deepEqual([built.builtIn, built.ownerAccount, built.access, built.integrationsEnabled, built.name], [true, null, "any_account", false, "Agora Station"]);
  const custom = await repo.station("st1");
  assert.deepEqual([custom.builtIn, custom.access, custom.integrationsEnabled, custom.name], [false, "members", true, null]);
  assert.deepEqual((await repo.stationsFor("ab1")).map((s) => [s.id, s.role]), [["stb", "built_in"], ["st1", "owner"]]);
  assert.deepEqual((await repo.stationsFor("ab9")).map((s) => [s.id, s.role]), [["stb", "built_in"]]);
  assert.deepEqual((await repo.builtInStations()).map((s) => s.id), ["stb"]);
  assert.equal(await repo.updateBuiltInStation("stb", { name: "Agora Station", integrationsEnabled: false }), false, "nothing to change");
  assert.equal(await repo.updateBuiltInStation("stb", { name: "Agora Station", integrationsEnabled: true }), true);
  assert.equal((await repo.station("stb")).integrationsEnabled, true);
  assert.equal(await repo.updateBuiltInStation("st1", { name: "Renamed", integrationsEnabled: false }), false, "custom Stations are not touched");
  await assert.rejects(repo.insertStation({ id: "stx", origin: "https://x.example", reportClientId: "s-stx", verifiedAt: NOW }), { code: "23514" }, "a custom Station needs an owner");
  await assert.rejects(repo.insertStation({ id: "sty", origin: "https://y.example", ownerAccount: "ab1", reportClientId: "s-sty", verifiedAt: NOW, builtIn: true, name: "Y" }), { code: "23514" }, "a built-in Station has no owner");
  await assert.rejects(repo.insertStation({ id: "stz", origin: "https://z.example", reportClientId: "s-stz", verifiedAt: NOW, builtIn: true, name: "z".repeat(61) }), { code: "23514" }, "names are 1 to 60 characters, as at Auth");
  await repo.markStationRemoved("stb", later(1000));
  assert.deepEqual(await repo.stationsFor("ab9"), []);
  assert.deepEqual(await repo.builtInStations(), []);
});

test("countLiveIntegrations counts one account's integrations on one Station that are neither revoked nor expired", async (t) => {
  const { repo } = await setup(t);
  if (!repo) return;
  await station(repo, "st1", "ab1");
  await station(repo, "st2", "ab1");
  await repo.insertIntegration(sample("i-1"));
  await repo.insertIntegration(sample("i-2"));
  await repo.updateIntegration("i-2", { state: "paused" });
  await repo.insertIntegration(sample("i-3"));
  await repo.updateIntegration("i-3", { state: "revoking" });
  await repo.insertIntegration(sample("i-4"));
  await repo.updateIntegration("i-4", { state: "revoked" });
  await repo.insertIntegration(sample("i-5", { expiresAt: later(1000) }));
  await repo.insertIntegration(sample("i-6", { ownerAccount: "ab2" }));
  await repo.insertIntegration(sample("i-7", { stationId: "st2" }));
  assert.equal(await repo.countLiveIntegrations("st1", "ab1", NOW), 4, "awaiting, paused, revoking and the short one");
  assert.equal(await repo.countLiveIntegrations("st1", "ab1", later(2000)), 3, "i-5 has expired");
  assert.equal(await repo.countLiveIntegrations("st1", "ab2", NOW), 1);
});
```

- [ ] **Step 2: Run them to verify they fail.**
  Run: `node --test tests/integrations-db.test.mjs tests/integrations-repository.test.mjs` (with `PORTAL_TEST_DATABASE_URL`)
  Expected: FAIL — the migration list lacks 002; `builtIn` is undefined; `builtInStations` is not a function.

- [ ] **Step 3: Write `migrations/002_built_in_stations.sql`:**

```sql
-- The built-in Station (spec §3.3.2, D24): Auth admits it from its clients file, nobody owns it and every account may
-- use it. Portal's row mirrors Auth's listing (builtIn, access, integrations, name); owner_account is NULL for it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE stations ALTER COLUMN owner_account DROP NOT NULL;
ALTER TABLE stations ADD COLUMN built_in boolean NOT NULL DEFAULT false;
ALTER TABLE stations ADD COLUMN access text NOT NULL DEFAULT 'members' CHECK (access IN ('members', 'any_account'));
ALTER TABLE stations ADD COLUMN integrations_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE stations ADD COLUMN name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 60);
ALTER TABLE stations ADD CONSTRAINT stations_built_in_owner_check CHECK (
  (built_in AND owner_account IS NULL AND access = 'any_account')
  OR (NOT built_in AND owner_account IS NOT NULL AND access = 'members')
);
-- Every account's listing reads the active built-in Stations; plan limits count per Station and owner.
CREATE INDEX stations_built_in_idx ON stations (created_at, id) WHERE built_in AND status = 'active';
CREATE INDEX integrations_station_owner_idx ON integrations (station_id, owner_account) WHERE state <> 'revoked';
```

- [ ] **Step 4: Implement the repository.** In `scripts/integrations/repository.mjs`:

  `stationRow` returns, in addition to the current fields:

```js
    builtIn: row.built_in === true,
    access: row.access ?? "members",
    integrationsEnabled: row.integrations_enabled !== false,
    name: row.name ?? null,
```

  Replace `insertStation` and `stationsFor`, and add the three new methods after `stationsFor`:

```js
    async insertStation({ id, origin, ownerAccount = null, reportClientId, verifiedAt, builtIn = false, integrationsEnabled = true, name = null }, client) {
      const { rowCount } = await run(client,
        "INSERT INTO stations (id, origin, owner_account, report_client_id, status, verified_at, built_in, access, integrations_enabled, name) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING",
        [id, origin, ownerAccount, reportClientId, when(verifiedAt), builtIn, builtIn ? "any_account" : "members", integrationsEnabled, name]);
      return rowCount > 0;
    },

    // The active Stations this account may use: every built-in Station (role built_in), its own (owner) and those
    // shared with it (member). Built-in Stations come first, as in Auth's listing.
    async stationsFor(accountId, client) {
      const { rows } = await run(client,
        "SELECT s.*, CASE WHEN s.built_in THEN 'built_in' WHEN s.owner_account = $1 THEN 'owner' ELSE 'member' END AS role FROM stations s WHERE s.status = 'active' AND (s.built_in OR s.owner_account = $1 OR EXISTS (SELECT 1 FROM station_members m WHERE m.station_id = s.id AND m.account_id = $1 AND m.removed_at IS NULL)) ORDER BY s.built_in DESC, s.created_at, s.id",
        [accountId]);
      return rows.map((row) => ({ ...stationRow(row), role: row.role }));
    },

    async builtInStations(client) {
      const { rows } = await run(client, "SELECT * FROM stations WHERE built_in AND status = 'active' ORDER BY created_at, id");
      return rows.map(stationRow);
    },

    // Follows Auth's listing of a built-in Station: its name and whether integrations may be created on it. Returns
    // whether anything changed; custom Stations are never touched.
    async updateBuiltInStation(id, { name, integrationsEnabled }, client) {
      const { rowCount } = await run(client,
        "UPDATE stations SET name = $2, integrations_enabled = $3 WHERE id = $1 AND built_in AND status = 'active' AND (name IS DISTINCT FROM $2 OR integrations_enabled IS DISTINCT FROM $3)",
        [id, name, integrationsEnabled]);
      return rowCount > 0;
    },

    // The account's integrations on a Station that count against a plan limit: every state but revoked, not expired.
    async countLiveIntegrations(stationId, ownerAccount, now, client) {
      const { rows } = await run(client,
        "SELECT count(*)::int AS n FROM integrations WHERE station_id = $1 AND owner_account = $2 AND state <> 'revoked' AND expires_at > $3",
        [stationId, ownerAccount, when(now)]);
      return rows[0].n;
    },
```

- [ ] **Step 5: Run the tests.**
  Run: `node --test tests/integrations-db.test.mjs tests/integrations-repository.test.mjs && npm test` (with `PORTAL_TEST_DATABASE_URL`)
  Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add migrations/002_built_in_stations.sql scripts/integrations/repository.mjs tests/integrations-db.test.mjs tests/integrations-repository.test.mjs
git commit -m "Store built-in Stations without an owner and list them for every account" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 3: Built-in Stations in the Stations service and the fake Auth

**Files:**
- Modify: `tests/helpers/fake-manage.mjs` (whole file, below)
- Modify: `scripts/integrations/service.mjs` (constants, `MANAGE_CONFLICTS`, `stationView`, `retireStale`,
  `ownStation`, `reconcile`, new `reconcileBuiltIn`, `notBuiltIn`, `notBuiltInOrigin`; `createChallenge`,
  `registerStation`, `members`, `unshare`)
- Test: `tests/integrations-stations.test.mjs`

**Interfaces:**
- Consumes: Task 2's repository methods and Station fields.
- Produces:
  - Station view (`GET /api/stations`, `service.stations()`): `{ id, origin, role, ownerAccount, status, createdAt,
    builtIn, name, integrationsEnabled }` plus `reportClientId` for `role === "owner"`. A built-in Station has
    `role: "built_in"`, `ownerAccount: null`, `builtIn: true`.
  - Errors: `409 built_in` "The built-in Station is always there: it can't be removed, shared or left."; `409
    origin_taken` "This is the built-in Station. Every account already has it."; Auth's `409 not_supported` maps to
    "Integrations aren't available on the built-in Station yet."
  - `fakeManage()` gains `seedBuiltIn({ id = "stbuiltin", origin = "https://station.agora.test", name = "Agora Station",
    integrations = false, admins = [], reportClientId = BUILT_IN_REPORT_CLIENT })` → the record (mutable: tests set
    `.integrations`, `.name`, `.status`), and exports `BUILT_IN_REPORT_CLIENT` (`"s-" + "0".repeat(24) + "bs"`).

- [ ] **Step 1: Replace `tests/helpers/fake-manage.mjs`** with this version (the existing behaviour plus built-in
  Stations, following Auth's `src/manage.mjs` on `feat/built-in-station`):

```js
import { ManageError } from "../../scripts/integrations/auth-manage.mjs";

const DAY = 86400000;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];
// The report client a seeded built-in Station gets at Auth: s- and 26 lower-case Crockford characters.
export const BUILT_IN_REPORT_CLIENT = "s-" + "0".repeat(24) + "bs";

// An in-memory Auth /manage/v1 following the actor rules of Auth's docs/integrating.md, including built-in Stations
// (seedBuiltIn): listed first for every account, with no owner or members (409 built_in), integrations only while
// switched on (409 not_supported), and admins who may pause or revoke others' integrations on them. `failNext` makes
// the next call of that name fail with the given status and code (after the gate, so the call is still recorded).
export function fakeManage({ now = Date.now } = {}) {
  const stations = [];
  const integrations = [];
  let next = 0;
  let nextIntegration = 0;
  const valid = (account) => typeof account === "string" && /^ab[0-9A-HJKMNP-TV-Z]{26}$/.test(account);
  const fail = (status, code) => { throw new ManageError(status, code); };
  const uses = (station, account) => station.builtIn || station.owner === account || station.members.some((member) => member.account === account);
  const notBuiltIn = (station) => { if (station.builtIn) fail(409, "built_in"); return station; };
  const listedStation = ({ id, origin, owner, status, reportClientId, createdAt, builtIn, access, integrations: enabled, name }) => ({ id, origin, owner, status, reportClientId, createdAt, builtIn, access, integrations: enabled, name });
  const listed = ({ keys, ...integration }) => ({ ...integration, scopes: [...integration.scopes] });
  const checkKey = (publicJwk) => {
    if (!publicJwk || typeof publicJwk !== "object") fail(400, "jwk");
    if (PRIVATE_MEMBERS.some((member) => Object.hasOwn(publicJwk, member))) fail(400, "private_key");
  };
  const checkExpiry = (expiresAt) => {
    const at = new Date(expiresAt).getTime();
    if (!Number.isFinite(at) || at <= now() || at > now() + 90 * DAY) fail(400, "expiry");
    return new Date(at).toISOString();
  };
  const auth = {
    down: false,
    calls: [],
    failNext: {},
    records: stations,
    integrationRecords: integrations,
    find(id) {
      const station = stations.find((entry) => entry.id === id && entry.status === "active");
      if (!station) fail(404, "not_found");
      return station;
    },
    findIntegration(id) {
      const integration = integrations.find((entry) => entry.clientId === id);
      if (!integration || !stations.some((entry) => entry.id === integration.stationId && entry.status === "active")) fail(404, "not_found");
      return integration;
    },
    async gate(name, actor, ...accounts) {
      auth.calls.push(name);
      if (auth.down) fail(503, "unavailable");
      if (![actor, ...accounts].every(valid)) fail(400, "invalid_request");
      const failure = auth.failNext[name];
      if (failure) {
        delete auth.failNext[name];
        fail(failure.status, failure.code);
      }
    },
    revokeWhere(pick) {
      for (const integration of integrations) if (pick(integration)) integration.status = "revoked";
    },
    // A built-in Station as Auth seeds it from its clients file. Not a management call, so it is not recorded.
    seedBuiltIn({ id = "stbuiltin", origin = "https://station.agora.test", name = "Agora Station", integrations: enabled = false, admins = [], reportClientId = BUILT_IN_REPORT_CLIENT } = {}) {
      const station = { id, origin, owner: null, status: "active", reportClientId, createdAt: new Date(now() - 2000).toISOString(), members: [], builtIn: true, access: "any_account", integrations: enabled, name, admins: [...admins] };
      stations.push(station);
      return station;
    },
    async registerStation({ origin, owner, reportKey, actor }) {
      await auth.gate("registerStation", actor, owner);
      if (actor !== owner) fail(403, "forbidden");
      if (!reportKey || typeof reportKey !== "object") fail(400, "jwk");
      if (stations.some((entry) => entry.origin === origin && entry.status === "active")) fail(409, "origin_taken");
      next += 1;
      const station = { id: "st" + next, origin, owner, status: "active", reportClientId: "s-st" + next, createdAt: new Date(Date.now() - 1000).toISOString(), members: [], builtIn: false, access: "members", integrations: true, name: null };
      stations.push(station);
      return { id: station.id, origin, owner, status: "active", reportClientId: station.reportClientId };
    },
    async stations(account) {
      await auth.gate("stations", account);
      const active = stations.filter((entry) => entry.status === "active");
      return [...active.filter((entry) => entry.builtIn), ...active.filter((entry) => !entry.builtIn && uses(entry, account))].map(listedStation);
    },
    async removeStation(id, actor) {
      await auth.gate("removeStation", actor);
      const station = notBuiltIn(auth.find(id));
      if (station.owner !== actor) fail(403, "forbidden");
      station.status = "removed";
      auth.revokeWhere((integration) => integration.stationId === id);
    },
    async members(id, actor) {
      await auth.gate("members", actor);
      const station = notBuiltIn(auth.find(id));
      if (!uses(station, actor)) fail(403, "forbidden");
      return { owner: station.owner, members: station.members.map((member) => ({ ...member })) };
    },
    async addMember(id, account, actor) {
      await auth.gate("addMember", actor, account);
      const station = notBuiltIn(auth.find(id));
      if (station.owner !== actor) fail(403, "forbidden");
      if (!station.members.some((member) => member.account === account)) station.members.push({ account, addedAt: new Date().toISOString() });
    },
    async removeMember(id, account, actor) {
      await auth.gate("removeMember", actor, account);
      const station = notBuiltIn(auth.find(id));
      if (station.owner !== actor && account !== actor) fail(403, "forbidden");
      station.members = station.members.filter((member) => member.account !== account);
      auth.revokeWhere((integration) => integration.stationId === id && integration.owner === account);
    },
    async createIntegration({ owner, stationId, name, scopes, publicJwk, r9Svc = null, quotaPerSecond = 200, expiresAt, actor }) {
      await auth.gate("createIntegration", actor, owner);
      if (actor !== owner) fail(403, "forbidden");
      const station = stations.find((entry) => entry.id === stationId && entry.status === "active");
      if (station?.builtIn && !station.integrations) fail(409, "not_supported");
      if (!station || !uses(station, owner)) fail(400, "invalid_request");
      if (!Array.isArray(scopes) || !scopes.includes("agent.view") || !scopes.every((scope) => /^agent\.[a-z]+$/.test(scope))) fail(400, "scopes");
      checkKey(publicJwk);
      const expiry = expiresAt === undefined ? new Date(now() + 30 * DAY).toISOString() : checkExpiry(expiresAt);
      nextIntegration += 1;
      const integration = {
        clientId: "i-" + String(nextIntegration).padStart(26, "0"), kind: "integration", owner, stationId, name, scopes: [...scopes], r9Svc,
        quotaPerSecond, status: "active", expiresAt: expiry, createdAt: new Date(now()).toISOString(), keys: [JSON.stringify(publicJwk)]
      };
      integrations.push(integration);
      return { clientId: integration.clientId, status: integration.status, expiresAt: integration.expiresAt };
    },
    async integrations(account) {
      await auth.gate("integrations", account);
      return integrations.filter((entry) => entry.owner === account).map(listed);
    },
    async addKey(id, publicJwk, actor) {
      await auth.gate("addKey", actor);
      const integration = auth.findIntegration(id);
      if (integration.owner !== actor) fail(403, "forbidden");
      if (integration.status === "revoked") fail(409, "revoked");
      checkKey(publicJwk);
      if (integration.keys.includes(JSON.stringify(publicJwk))) fail(409, "duplicate_key");
      integration.keys.push(JSON.stringify(publicJwk));
      return { kid: "kid-" + integration.keys.length, overlapEndsAt: new Date(now() + 600000).toISOString() };
    },
    async changeIntegration(id, { status, r9Svc, quotaPerSecond, expiresAt } = {}, actor) {
      await auth.gate("changeIntegration", actor);
      const integration = auth.findIntegration(id);
      const others = [r9Svc, quotaPerSecond, expiresAt].some((value) => value !== undefined);
      const station = stations.find((entry) => entry.id === integration.stationId);
      // The Station-owner rights: the owner of a custom Station, the configured admins of a built-in one.
      const stationRights = station.builtIn ? station.admins : [station.owner];
      const mayStop = (status === "paused" || status === "revoked") && !others;
      if (integration.owner !== actor && !(mayStop && stationRights.includes(actor))) fail(403, "forbidden");
      if (integration.status === "revoked") {
        if (status === "revoked" && !others) return listed(integration);
        fail(409, "revoked");
      }
      if (status !== undefined && !["active", "paused", "revoked"].includes(status)) fail(400, "invalid_request");
      if (r9Svc !== undefined && r9Svc !== null && !/^[0-9a-f]{64}$/.test(r9Svc)) fail(400, "invalid_request");
      if (quotaPerSecond !== undefined && !(Number.isInteger(quotaPerSecond) && quotaPerSecond >= 1 && quotaPerSecond <= 10000)) fail(400, "invalid_request");
      const expiry = expiresAt === undefined ? undefined : checkExpiry(expiresAt);
      if (status !== undefined) integration.status = status;
      if (r9Svc !== undefined) integration.r9Svc = r9Svc;
      if (quotaPerSecond !== undefined) integration.quotaPerSecond = quotaPerSecond;
      if (expiry !== undefined) integration.expiresAt = expiry;
      return listed(integration);
    }
  };
  return auth;
}
```

- [ ] **Step 2: Run the existing suite against the new fake.**
  Run: `npm test` (with `PORTAL_TEST_DATABASE_URL`)
  Expected: PASS — no test seeds a built-in Station yet, so nothing changes.

- [ ] **Step 3: Write the failing service tests.** In `tests/integrations-stations.test.mjs`, add to the `cases` of
  the `fromManage` test:

```js
    [409, "built_in", 409, "built_in", "The built-in Station is always there: it can't be removed, shared or left."],
    [409, "not_supported", 409, "not_supported", "Integrations aren't available on the built-in Station yet."],
```

  and append:

```js
const BUILT_IN = "https://station.agora.test";
const BUILT_IN_FIXED = "The built-in Station is always there: it can't be removed, shared or left.";

test("every account lists the built-in Station first, with no owner or report client, and a listing without it removes nothing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  const mine = await s.register(OWNER);
  const listed = await s.service.stations(OWNER);
  assert.deepEqual(listed.stations.map((station) => [station.id, station.role]), [[built.id, "built_in"], [mine.id, "owner"]]);
  assert.deepEqual(listed.stations[0], { id: built.id, origin: BUILT_IN, role: "built_in", ownerAccount: null, status: "active", createdAt: listed.stations[0].createdAt, builtIn: true, name: "Agora Station", integrationsEnabled: false });
  assert.deepEqual([listed.stations[1].builtIn, listed.stations[1].name, listed.stations[1].integrationsEnabled], [false, null, true]);
  assert.deepEqual((await s.service.stations(STRANGER)).stations.map((station) => [station.id, station.role]), [[built.id, "built_in"]]);
  const reconciled = (await s.events("station_reconciled")).filter((row) => row.station_id === built.id);
  assert.deepEqual(reconciled.map((row) => [row.account_id, row.actor]), [["system", "system"]], "recorded once, as system");
  assert.deepEqual(await s.repository.currentMembers(built.id), [], "nobody is made a member");
  // A listing that lacks it (a stale answer, a bug at Auth) never removes it or revokes its integrations.
  await seedIntegration(s.repository, "i-b1", built.id, STRANGER, "ready");
  s.manage.records.splice(s.manage.records.indexOf(built), 1);
  assert.deepEqual((await s.service.stations(OWNER)).stations.map((station) => station.id), [built.id, mine.id]);
  assert.equal((await s.repository.station(built.id)).status, "active");
  assert.equal((await s.repository.integration("i-b1")).state, "ready");
  assert.equal((await s.events("station_removed")).length, 0);
});

test("the built-in Station follows Auth's integrations setting and name on every listing", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  await s.service.stations(OWNER);
  built.integrations = true;
  built.name = "Agora Station (dev)";
  const [first] = (await s.service.stations(MEMBER)).stations;
  assert.deepEqual([first.integrationsEnabled, first.name], [true, "Agora Station (dev)"]);
});

test("removing, sharing, leaving or listing the members of the built-in Station is 409 built_in without asking Auth", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn({ admins: [OWNER] });
  await s.service.stations(OWNER);
  const calls = s.manage.calls.length;
  for (const [what, run] of [
    ["remove", () => s.service.removeStation(OWNER, built.id)],
    ["share", () => s.service.share(OWNER, built.id, MEMBER)],
    ["unshare", () => s.service.unshare(OWNER, built.id, MEMBER)],
    ["leave", () => s.service.unshare(MEMBER, built.id, MEMBER)],
    ["members", () => s.service.members(MEMBER, built.id)]
  ]) await assert.rejects(run(), refused(409, "built_in", BUILT_IN_FIXED), what);
  assert.equal(s.manage.calls.length, calls, "Auth is not asked");
  // Auth answers the same requests the same way.
  await assert.rejects(s.manage.removeStation(built.id, OWNER), (error) => error.status === 409 && error.code === "built_in");
  await assert.rejects(s.manage.members(built.id, OWNER), (error) => error.status === 409 && error.code === "built_in");
});

test("the built-in Station's origin can't be checked or registered, and no proof is fetched", async (t) => {
  const s = await setup(t);
  if (!s) return;
  s.manage.seedBuiltIn();
  const early = await s.service.createChallenge(OWNER, BUILT_IN); // before the Portal knows the built-in Station
  await s.service.stations(OWNER);
  await assert.rejects(s.service.createChallenge(OWNER, BUILT_IN), refused(409, "origin_taken", "This is the built-in Station. Every account already has it."));
  await assert.rejects(s.service.createChallenge(OWNER, BUILT_IN + "/"), refused(409, "origin_taken"));
  await assert.rejects(s.service.registerStation(OWNER, { challengeId: early.challengeId, reportKey: REPORT_KEY }), refused(409, "origin_taken"));
  assert.deepEqual(s.fetched, []);
});

test("any account gets a read token for the built-in Station", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = s.manage.seedBuiltIn();
  await s.service.stations(OWNER);
  assert.deepEqual(await s.service.readToken(STRANGER, "id-token", built.id), { accessToken: "read-token-for-" + BUILT_IN, expiresIn: 300, origin: BUILT_IN });
});

test("a new built-in Station at the same origin retires the old one in Portal, with its integrations", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const old = s.manage.seedBuiltIn({ id: "stold" });
  await s.service.stations(OWNER);
  await seedIntegration(s.repository, "i-old", old.id, OWNER, "ready");
  old.status = "removed";
  s.manage.seedBuiltIn({ id: "stnew", reportClientId: "s-" + "0".repeat(24) + "bt" });
  assert.deepEqual((await s.service.stations(MEMBER)).stations.map((station) => station.id), ["stnew"]);
  assert.equal((await s.repository.station("stold")).status, "removed");
  assert.equal((await s.repository.integration("i-old")).state, "revoked");
  assert.deepEqual((await s.events("station_removed")).map((row) => [row.station_id, row.account_id, row.reason]), [["stold", "system", "reconciled"]]);
});
```

- [ ] **Step 4: Run them to verify they fail.**
  Run: `node --test tests/integrations-stations.test.mjs` (with `PORTAL_TEST_DATABASE_URL`)
  Expected: FAIL — `fromManage` cases, the built-in entry is treated as a custom Station (an `ownerAccount` NOT NULL
  insert or a member row), no 409s.

- [ ] **Step 5: Implement in `scripts/integrations/service.mjs`.**

  Constants next to `failure`/`notFound`:

```js
const SYSTEM = "system";
const BUILT_IN_FIXED = "The built-in Station is always there: it can't be removed, shared or left.";
const BUILT_IN_ORIGIN = "This is the built-in Station. Every account already has it.";
const NOT_SUPPORTED = "Integrations aren't available on the built-in Station yet.";
```

  `MANAGE_CONFLICTS` gains `built_in: BUILT_IN_FIXED,` and `not_supported: NOT_SUPPORTED,`.

  `stationView` becomes:

```js
// Members are not shown the Station's report client; it is not secret, but they have no use for it. Nobody is shown a
// built-in Station's report client (its role is built_in).
function stationView(station, role) {
  const view = {
    id: station.id, origin: station.origin, role, ownerAccount: station.ownerAccount, status: station.status, createdAt: station.createdAt,
    builtIn: station.builtIn, name: station.name, integrationsEnabled: station.integrationsEnabled
  };
  if (role === "owner") view.reportClientId = station.reportClientId;
  return view;
}
```

  In `retireStale` the event line becomes
  `await repository.appendEvent({ stationId: stale.id, accountId: stale.ownerAccount ?? SYSTEM, actor: SYSTEM, kind: "station_removed", reason: "reconciled" }, client);`.

  Below `usable`, replace `ownStation` and add the two guards:

```js
  // Remove, share, leave and the member list don't exist for a built-in Station; refused here as Auth refuses them
  // (409 built_in), without asking Auth.
  function notBuiltIn(station) {
    if (station.builtIn) throw failure(409, BUILT_IN_FIXED, "built_in");
    return station;
  }

  // Auth answers 409 origin_taken for a built-in Station's origin; Portal says so before a check is issued or fetched.
  async function notBuiltInOrigin(origin) {
    if ((await repository.builtInStations()).some((station) => station.origin === origin)) throw failure(409, BUILT_IN_ORIGIN, "origin_taken");
  }

  // For changes only the Station's owner may make; a member sees the Station, so it is told why.
  async function ownStation(accountId, stationId) {
    const station = notBuiltIn(await usable(accountId, stationId));
    if (station.role !== "owner") throw ownerOnly();
    return station;
  }
```

  In `reconcile`, the first loop starts with:

```js
    for (const station of await repository.stationsFor(accountId)) {
      // A built-in Station is every account's: a listing without it never removes it or revokes anything (D24).
      if (station.builtIn) {
        if (!known.has(station.id)) log("Built-in Station absent from Auth's listing: left as it is.");
        continue;
      }
```

  and the second loop starts with `for (const entry of listed) { if (entry.builtIn) { await reconcileBuiltIn(entry); continue; }`.
  Add after `reconcile`:

```js
  // Inserts a built-in Station Auth lists (no owner, no members) or follows its name and integrations setting. A new
  // Station at the origin of an older one retires the older one, as for custom Stations.
  async function reconcileBuiltIn(entry) {
    const existing = await repository.station(entry.id);
    if (existing?.status === "removed") {
      log("Built-in Station listed by Auth is removed in Portal: not restored.");
      return;
    }
    const settings = { name: entry.name, integrationsEnabled: entry.integrations === true };
    if (existing) {
      if (await repository.updateBuiltInStation(entry.id, settings)) log("Built-in Station settings followed from Auth.");
      return;
    }
    const { added, stale } = await appending(async (client) => {
      const stale = await retireStale(client, entry.origin, entry.id);
      if (!(await repository.insertStation({ id: entry.id, origin: entry.origin, reportClientId: entry.reportClientId, verifiedAt: entry.createdAt, builtIn: true, ...settings }, client))) return { added: false, stale };
      await repository.appendEvent({ stationId: entry.id, accountId: SYSTEM, actor: SYSTEM, kind: "station_reconciled", reason: "built_in" }, client);
      return { added: true, stale };
    });
    retired(stale);
    if (added) {
      log("Built-in Station added from Auth.");
      changed(entry.id);
    }
  }
```

  In the returned methods:
  - `createChallenge`: after `const origin = stationOrigin(originInput);` add `await notBuiltInOrigin(origin);`.
  - `registerStation`: after `const { origin, value } = challenge;` add `await notBuiltInOrigin(origin);`.
  - `members`: first line becomes `notBuiltIn(await usable(accountId, stationId));`.
  - `unshare`: `const station = notBuiltIn(await usable(accountId, stationId));`.

- [ ] **Step 6: Run the tests.**
  Run: `node --test tests/integrations-stations.test.mjs && npm test` (with `PORTAL_TEST_DATABASE_URL`)
  Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add tests/helpers/fake-manage.mjs scripts/integrations/service.mjs tests/integrations-stations.test.mjs
git commit -m "List the built-in Station for every account and refuse removing, sharing and registering it" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 4: Integrations on the built-in Station: the switch, plan limits and admins

**Files:**
- Modify: `scripts/plans.mjs` (add `builtInIntegrationLimit`)
- Modify: `scripts/integrations/service.mjs` (options `admins`; `access`, `owned`, `createIntegration`, `integrations`)
- Modify: `scripts/integrations/routes.mjs` (`createIntegrationStack`, `integrationsFromEnv`, `handleIntegrations`)
- Modify: `scripts/serve.mjs` (admins once, `planOf`, pass both)
- Test: `tests/platform.test.mjs`, `tests/integrations-service.test.mjs`, `tests/integrations-routes.test.mjs`

**Interfaces:**
- Consumes: Task 2 `countLiveIntegrations`, `builtInStations`; Task 3 views and `fakeManage().seedBuiltIn`.
- Produces:
  - `builtInIntegrationLimit(plan) → number | null` (`basic` 4, `premium` 10, `principal`/`fellow` `null`; anything
    else counts as `basic`).
  - `createIntegrationService({ …, admins = [] })`; `service.createIntegration(accountId, fields, { plan = "basic" } = {})`.
    Refusals: `409 not_supported` (built-in, off), `403 plan_limit` with `details.limit`.
  - Integration views for admins: `role: "station_admin"`; admins may `pause` and `revoke` (event `reason`
    `station_admin`), every owner-only action answers 403 `forbidden`, `approve` 404.
  - `createIntegrationStack({ db, manage, idp, log, stationFetch, pushFetch, admins = [] })`;
    `integrationsFromEnv(env, { idp, log, stationFetch, pushFetch, admins })`;
    `handleIntegrations({ …, planOf = async () => "basic" })`.

- [ ] **Step 1: Write the failing tests.**

  `tests/platform.test.mjs`: import `builtInIntegrationLimit` from `../scripts/plans.mjs` and add:

```js
test("integrations on the built-in Station are limited by plan: Basic 4, Premium 10, Principal and Fellow none", () => {
  assert.deepEqual(["basic", "premium", "principal", "fellow"].map(builtInIntegrationLimit), [4, 10, null, null]);
  assert.equal(builtInIntegrationLimit(undefined), 4, "an unknown plan counts as Basic");
});
```

  `tests/integrations-service.test.mjs`: change `setup(t, { wrap = (repository) => repository } = {})` to
  `setup(t, { wrap = (repository) => repository, admins = [] } = {})` and pass `admins` to `createIntegrationService`.
  Append:

```js
const ADMIN = "ab" + "0".repeat(25) + "4";
const PLAN_MESSAGE = (n) => "Your plan allows " + n + " integrations on the built-in Station. Revoke one, upgrade, or use your own Station.";
async function builtIn(s, settings = {}) {
  const built = s.manage.seedBuiltIn({ integrations: true, admins: [ADMIN], ...settings });
  await s.service.stations(OWNER);
  return built;
}
const onBuiltIn = (s, built, accountId = OWNER, plan, fields = {}) => s.service.createIntegration(accountId, { stationId: built.id, name: "Hosted app", scopes: [], publicJwk: publicJwk(), ...fields }, plan ? { plan } : undefined);

test("while the built-in Station's integrations are off, creating one there is 409 not_supported, before Auth", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s, { integrations: false });
  const calls = s.authCalls("createIntegration");
  await assert.rejects(onBuiltIn(s, built), refused(409, "not_supported"));
  assert.equal(s.authCalls("createIntegration"), calls, "Auth is not asked");
  // Turned off at Auth after the Portal last listed it: Auth's own refusal reads the same.
  built.integrations = true;
  await s.service.stations(OWNER);
  built.integrations = false;
  await assert.rejects(onBuiltIn(s, built), (error) => refused(409, "not_supported")(error) && error.message === "Integrations aren't available on the built-in Station yet.");
  assert.equal(s.authCalls("createIntegration"), calls + 1);
});

test("with integrations on, any account creates one on the built-in Station, owned by it and seen only by it", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  const theirs = await onBuiltIn(s, built, STRANGER);
  assert.deepEqual([theirs.stationId, theirs.stationOrigin, theirs.role, theirs.state], [built.id, "https://station.agora.test", "owner", "awaiting_approval"]);
  assert.equal(s.record(theirs.id).owner, STRANGER);
  assert.equal((await s.service.integrations(OWNER)).integrations.some((entry) => entry.id === theirs.id), false);
  await assert.rejects(s.service.pause(OWNER, theirs.id), refused(404, "not_found"));
  await s.service.approve(STRANGER, theirs.id, { r9Svc: R9 });
  assert.equal((await s.service.pause(STRANGER, theirs.id)).state, "paused");
  assert.equal((await s.service.resume(STRANGER, theirs.id)).state, "provisioning");
});

test("plan limits on the built-in Station: Basic 4, Premium 10, Principal and Fellow none; revoked and expired ones don't count", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  const ids = [];
  const short = (await onBuiltIn(s, built, OWNER, "basic", { expiresInDays: 1 })).id;
  for (let i = 0; i < 3; i += 1) ids.push((await onBuiltIn(s, built, OWNER, "basic")).id);
  const calls = s.authCalls("createIntegration");
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), (error) => refused(403, "plan_limit")(error) && error.message === PLAN_MESSAGE(4) && error.details.limit === 4);
  await assert.rejects(onBuiltIn(s, built, OWNER), refused(403, "plan_limit"), "no plan given counts as Basic");
  assert.equal(s.authCalls("createIntegration"), calls, "refused before Auth");
  for (let i = 0; i < 5; i += 1) await s.create(OWNER); // custom Stations are never capped
  await s.service.pause(OWNER, ids[0]);
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), refused(403, "plan_limit"), "a paused one still counts");
  await s.service.revoke(OWNER, ids[1]);
  ids.push((await onBuiltIn(s, built, OWNER, "basic")).id); // a revoked one frees a place
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), refused(403, "plan_limit"));
  s.clock.now += 2 * DAY;
  ids.push((await onBuiltIn(s, built, OWNER, "basic")).id); // so does an expired one
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), refused(403, "plan_limit"));
  for (let i = 0; i < 6; i += 1) ids.push((await onBuiltIn(s, built, OWNER, "premium")).id);
  await assert.rejects(onBuiltIn(s, built, OWNER, "premium"), (error) => refused(403, "plan_limit")(error) && error.message === PLAN_MESSAGE(10));
  for (const plan of ["principal", "fellow"]) ids.push((await onBuiltIn(s, built, OWNER, plan)).id);
  // After a downgrade the existing ones keep working; new ones are refused until the account is under the limit.
  const live = (await s.service.integrations(OWNER)).integrations.filter((entry) => entry.stationId === built.id && !["revoked", "expired"].includes(entry.state));
  assert.equal(live.length, 12);
  assert.ok(live.every((entry) => s.record(entry.id).status === (entry.state === "paused" ? "paused" : "active")));
  assert.equal((await s.repository.integration(short)).state, "awaiting_approval", "expired is shown, not stored");
  await assert.rejects(onBuiltIn(s, built, OWNER, "basic"), refused(403, "plan_limit"));
  assert.equal((await onBuiltIn(s, built, MEMBER, "basic")).role, "owner", "each account counts its own");
});

test("two creations racing on the built-in Station can't both pass the plan limit", async (t) => {
  const s = await setup(t);
  if (!s) return;
  const built = await builtIn(s);
  for (let i = 0; i < 3; i += 1) await onBuiltIn(s, built, OWNER, "basic");
  const results = await Promise.allSettled([onBuiltIn(s, built, OWNER, "basic"), onBuiltIn(s, built, OWNER, "basic")]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((result) => result.status === "rejected").reason.details.code, "plan_limit");
});

test("Agora.Build admins see others' integrations on the built-in Station and may pause or revoke them, nothing else", async (t) => {
  const s = await setup(t, { admins: [ADMIN] });
  if (!s) return;
  const built = await builtIn(s);
  const theirs = await onBuiltIn(s, built, OWNER);
  const other = await onBuiltIn(s, built, MEMBER);
  const custom = await s.create(OWNER);
  assert.deepEqual((await s.service.integrations(ADMIN)).integrations.map((entry) => [entry.id, entry.role]), [[theirs.id, "station_admin"], [other.id, "station_admin"]]);
  assert.deepEqual((await s.service.integrations(STRANGER)).integrations, [], "nobody else sees them");
  await assert.rejects(s.service.pause(ADMIN, custom.id), refused(404, "not_found"), "no rights on custom Stations");
  await assert.rejects(s.service.pause(STRANGER, theirs.id), refused(404, "not_found"));
  await s.service.approve(OWNER, theirs.id, { r9Svc: R9 });
  const paused = await s.service.pause(ADMIN, theirs.id);
  assert.deepEqual([paused.state, paused.role], ["paused", "station_admin"]);
  assert.equal(s.record(theirs.id).status, "paused", "Auth accepted the admin's pause");
  for (const call of [() => s.service.resume(ADMIN, theirs.id), () => s.service.renew(ADMIN, theirs.id, { expiresInDays: 10 }), () => s.service.settings(ADMIN, theirs.id, { quotaPerSecond: 5 }), () => s.service.rotateKey(ADMIN, theirs.id, { publicJwk: publicJwk() })]) {
    await assert.rejects(call(), refused(403, "forbidden"));
  }
  await assert.rejects(s.service.approve(ADMIN, other.id, { r9Svc: R9 }), refused(404, "not_found"), "never approves");
  assert.equal((await s.service.revoke(ADMIN, other.id)).state, "revoked");
  assert.deepEqual((await s.events()).filter((event) => event.actor === ADMIN).map((event) => [event.kind, event.account_id, event.reason]), [
    ["integration_paused", OWNER, "station_admin"], ["integration_revoked", MEMBER, "station_admin"]
  ]);
  assert.ok((await s.service.history(ADMIN, theirs.id)).events.length > 0);
});
```

  `tests/integrations-routes.test.mjs`: make the helper `async function stack(t, { admins = [] } = {})` pass
  `admins` to `createIntegrationService`, then append:

```js
test("creating an integration on the built-in Station uses the account's Portal plan", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service });
  const owner = await signIn(app);
  assert.equal((await call(app.base, "/api/stations", { cookie: owner.cookie })).status, 200);
  const create = () => call(app.base, "/api/integrations", { cookie: owner.cookie, method: "POST", data: { stationId: built.id, name: "Hosted", scopes: ["agent.view"], publicJwk: publicJwk() } });
  const account = (state) => state.accounts.find((entry) => entry.id === owner.sub);
  for (let i = 0; i < 4; i += 1) assert.equal((await create()).status, 201);
  const basic = await create();
  assert.deepEqual([basic.status, (await basic.json()).code], [403, "plan_limit"]);
  await app.store.transaction((state) => { account(state).assignedPlan = "fellow"; });
  assert.equal((await create()).status, 201, "a Fellow has no cap");
  await app.store.transaction((state) => { account(state).assignedPlan = null; account(state).subscription = { status: "active", currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400 }; });
  for (let i = 0; i < 5; i += 1) assert.equal((await create()).status, 201, "Premium allows 10");
  const premium = await create();
  assert.deepEqual([premium.status, await premium.json()], [403, { error: "Your plan allows 10 integrations on the built-in Station. Revoke one, upgrade, or use your own Station.", code: "plan_limit", limit: 10 }]);
  await integrations.service._pushesIdle();
});

test("the stack hands the platform admins to the service", async (t) => {
  const db = await testDatabase(t);
  if (!db) { t.skip("PORTAL_TEST_DATABASE_URL is not set."); return; }
  const owner = accountId();
  const admin = accountId();
  const manage = fakeManage();
  const built = manage.seedBuiltIn({ integrations: true, admins: [admin] });
  const integrations = createIntegrationStack({ db, manage, idp: null, log: () => {}, admins: [admin], pushFetch: { async post() { return { status: 202 }; } } });
  await integrations.service.stations(owner);
  const created = await integrations.service.createIntegration(owner, { stationId: built.id, name: "Hosted", scopes: [], publicJwk: publicJwk() });
  assert.deepEqual((await integrations.service.integrations(admin)).integrations.map((entry) => [entry.id, entry.role]), [[created.id, "station_admin"]]);
  await integrations.service._pushesIdle();
});
```

- [ ] **Step 2: Run them to verify they fail.**
  Run: `node --test tests/platform.test.mjs tests/integrations-service.test.mjs tests/integrations-routes.test.mjs` (with `PORTAL_TEST_DATABASE_URL`)
  Expected: FAIL — `builtInIntegrationLimit` is not exported; no `not_supported`, `plan_limit` or `station_admin`.

- [ ] **Step 3: Implement `scripts/plans.mjs`:** append

```js
// Integrations an account may have on a built-in Station at once (D24): counted in every state but revoked, and not
// expired. null is no cap. Custom Stations are never capped. An unknown plan counts as Basic.
const BUILT_IN_INTEGRATIONS = { basic: 4, premium: 10, principal: null, fellow: null };
export function builtInIntegrationLimit(plan) {
  return Object.hasOwn(BUILT_IN_INTEGRATIONS, plan) ? BUILT_IN_INTEGRATIONS[plan] : BUILT_IN_INTEGRATIONS.basic;
}
```

- [ ] **Step 4: Implement the service.** In `scripts/integrations/service.mjs`:
  - import `import { builtInIntegrationLimit } from "../plans.mjs";`
  - the options gain `admins = []` (after `notify`).
  - inside the factory, after `pushes`:

```js
  // Per account and built-in Station: the creation in flight, so a second one waits for its count (plan limits).
  const creations = new Map();
  function oneAtATime(key, work) {
    const run = (creations.get(key) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    creations.set(key, settled);
    settled.then(() => { if (creations.get(key) === settled) creations.delete(key); });
    return run;
  }
```

  - `access` becomes:

```js
  // The row and the account's part in it: "owner"; "station_owner" (it owns the integration's custom Station);
  // "station_admin" (an Agora.Build admin, on a built-in Station); or null.
  async function access(accountId, id) {
    const row = typeof id === "string" && id ? await repository.integration(id) : null;
    if (!row) throw notFound();
    if (row.ownerAccount === accountId) return { row, role: "owner" };
    const station = await repository.station(row.stationId);
    if (station?.builtIn) return { row, role: admins.includes(accountId) ? "station_admin" : null };
    return { row, role: station?.ownerAccount === accountId ? "station_owner" : null };
  }
```

  - in `owned`, the check becomes `if (role !== "owner") throw failure(403, "Only the integration's owner can do this.", "forbidden");`
  - replace `createIntegration` with:

```js
    // On a built-in Station: only while Agora.Build has integrations on there, and within the account's plan limit
    // (Basic 4, Premium 10, Principal and Fellow none). Custom Stations are never capped.
    async createIntegration(accountId, { stationId, name, scopes = [], publicJwk, quotaPerSecond = 200, expiresInDays = 30 } = {}, { plan = "basic" } = {}) {
      const fields = { name: integrationName(name), scopes: integrationScopes(scopes), quotaPerSecond: quota(quotaPerSecond) };
      expiryDays(expiresInDays);
      publicKey(publicJwk);
      const station = await usable(accountId, stationId);
      if (!station.builtIn) return create(accountId, station, fields, publicJwk, expiresInDays);
      if (!station.integrationsEnabled) throw failure(409, NOT_SUPPORTED, "not_supported");
      return oneAtATime(accountId + " " + station.id, async () => {
        const limit = builtInIntegrationLimit(plan);
        if (limit !== null && await repository.countLiveIntegrations(station.id, accountId, now()) >= limit) {
          throw failure(403, "Your plan allows " + limit + " integrations on the built-in Station. Revoke one, upgrade, or use your own Station.", "plan_limit", { limit });
        }
        return create(accountId, station, fields, publicJwk, expiresInDays);
      });
    },
```

  and add, inside the factory before `return {` (the body moved from the old `createIntegration`):

```js
  async function create(accountId, station, fields, publicJwk, expiresInDays) {
    const stationId = station.id;
    const expiresAt = new Date(now() + expiresInDays * DAY).toISOString();
    const created = await viaAuth(() => manage.createIntegration({ owner: accountId, stationId, ...fields, publicJwk, expiresAt, actor: accountId }));
    await appending(async (client) => {
      await repository.insertIntegration({ id: created.clientId, ownerAccount: accountId, stationId, kind: "custom_app", ...fields, expiresAt: created.expiresAt ?? expiresAt }, client);
      await repository.appendEvent({ stationId, integrationId: created.clientId, accountId, actor: accountId, kind: "integration_created", state: "awaiting_approval", details: { scopes: fields.scopes, name: fields.name } }, client);
    });
    changed(stationId);
    return integrationView(await repository.integration(created.clientId), "owner", station.origin);
  }
```

  - in `integrations(accountId)`, after the loop over owned Stations and before `return`:

```js
      // Agora.Build admins: every other account's integration on the built-in Stations, which they may pause or revoke.
      if (admins.includes(accountId)) {
        for (const station of await repository.builtInStations()) {
          for (const row of await repository.integrationsOnStation(station.id)) {
            if (row.ownerAccount !== accountId) views.push(integrationView(row, "station_admin", station.origin));
          }
        }
      }
```

  and update its comment to "…the others on Stations it owns, and for Agora.Build admins the others on built-in Stations".

- [ ] **Step 5: Wire it.** `scripts/integrations/routes.mjs`:
  - `createIntegrationStack({ db, manage, idp, log, stationFetch = createStationFetch(), pushFetch, admins = [] })`
    passes `admins` to `createIntegrationService({ …, admins })`.
  - `integrationsFromEnv(env, { idp, log, stationFetch, pushFetch, admins })` passes `admins` to `createIntegrationStack`.
  - `handleIntegrations({ …, limit, planOf = async () => "basic" })`; the creation line becomes
    `return { status: 201, body: await service.createIntegration(accountId, await read(), { plan: await planOf(accountId) }) };`

  `scripts/serve.mjs`:
  - import `import { effectivePlan } from "./plans.mjs";`
  - before `const spaces = …` add `const admins = platformAdmins(process.env.PLATFORM_ADMINS, log);`, and pass
    `admins` (instead of calling `platformAdmins` again) to `createSpaces`.
  - the integrations line becomes
    `const integrations = "integrations" in options ? (options.integrations && readyIntegrations(options.integrations)) : integrationsFromEnv(process.env, { ...options.integrationOptions, idp, log, admins });`
  - after it:

```js
  // The account's plan (scripts/plans.mjs), for the integration limits on the built-in Station.
  const planOf = async (accountId) => effectivePlan((await store.snapshot()).accounts.find((account) => account.id === accountId), clock());
```

  - the `handleIntegrations({ … })` call gains `planOf`.

- [ ] **Step 6: Run the tests.**
  Run: `node --test tests/platform.test.mjs tests/integrations-service.test.mjs tests/integrations-routes.test.mjs && npm test` (with `PORTAL_TEST_DATABASE_URL`)
  Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add scripts/plans.mjs scripts/integrations/service.mjs scripts/integrations/routes.mjs scripts/serve.mjs tests/platform.test.mjs tests/integrations-service.test.mjs tests/integrations-routes.test.mjs
git commit -m "Gate integrations on the built-in Station, limit them by plan and let admins pause or revoke them" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 5: Reports, feed and push for the built-in Station

**Files:**
- Test: `tests/integrations-routes.test.mjs`
- Modify (only if the test finds a gap): `scripts/integrations/service.mjs` `report`, `changes`, `pushOnce`

**Interfaces:**
- Consumes: Task 1 (`caller.station` tokens reach the report routes), Tasks 2–4 (built-in rows and integrations).
- Produces: nothing new; it proves `POST /api/v1/stations/reports` and `GET /api/v1/stations/changes` work for the
  built-in Station's own report token, that its feed lists every integration on it (each with `ownerAccount`) and only
  those, that push hints go to its origin, and that a report before the Portal knows the Station answers `403 station`.

- [ ] **Step 1: Write the test.** Import `BUILT_IN_REPORT_CLIENT` from `./helpers/fake-manage.mjs` and append to
  `tests/integrations-routes.test.mjs`:

```js
test("the built-in Station's own report token reports and reads a feed of every integration on it, and only those", async (t) => {
  const integrations = await stack(t);
  if (!integrations) return;
  const built = integrations.manage.seedBuiltIn({ integrations: true });
  const app = await start(t, { integrations: integrations.service });
  const token = await app.fake.issueAccessToken({ sub: BUILT_IN_REPORT_CLIENT, client_id: BUILT_IN_REPORT_CLIENT, scope: "station.report" });
  // Until an account's listing has brought it into the Portal, the Station is unknown here.
  const early = await call(app.base, "/api/v1/stations/changes?cursor=0", { bearer: token });
  assert.deepEqual([early.status, (await early.json()).code], [403, "station"]);
  const ada = await signIn(app);
  const bo = await signIn(app);
  const custom = (await registerStation(app, integrations, ada.cookie)).station;
  assert.equal((await call(app.base, "/api/stations", { cookie: ada.cookie })).status, 200);
  const mine = await createIntegration(app, ada.cookie, built.id);
  const theirs = await createIntegration(app, bo.cookie, built.id);
  const elsewhere = await createIntegration(app, ada.cookie, custom.id);
  const feed = await (await call(app.base, "/api/v1/stations/changes?cursor=0", { bearer: token })).json();
  assert.deepEqual(feed.integrations.map((entry) => [entry.id, entry.ownerAccount]), [[mine.id, ada.sub], [theirs.id, bo.sub]]);
  assert.ok(feed.changes.every((change) => change.integrationId !== elsewhere.id), "nothing of another Station");
  await integrations.service.approve(ada.sub, mine.id, { r9Svc: R9 });
  const reported = await call(app.base, "/api/v1/stations/reports", { bearer: token, method: "POST", data: { integrationId: mine.id, state: "waiting_for_host" } });
  assert.deepEqual([reported.status, (await reported.json()).state], [200, "waiting_for_host"]);
  const foreign = await call(app.base, "/api/v1/stations/reports", { bearer: token, method: "POST", data: { integrationId: elsewhere.id, state: "waiting_for_host" } });
  assert.equal(foreign.status, 404, "another Station's integration is unknown to it");
  assert.equal((await app.store.snapshot()).accounts.some((account) => account.id === BUILT_IN_REPORT_CLIENT), false, "no Portal account");
  await integrations.service._pushesIdle();
  const hints = integrations.pushes.filter((push) => push.url === "https://station.agora.test/agora-build/v1/changes");
  assert.ok(hints.length > 0 && hints.every((push) => Number.isSafeInteger(push.body.cursor)), "push hints go to its origin");
});
```

- [ ] **Step 2: Run it.**
  Run: `node --test tests/integrations-routes.test.mjs` (with `PORTAL_TEST_DATABASE_URL`)
  Expected: PASS with Tasks 1–4 in place. If it fails, fix the cause in `scripts/integrations/service.mjs` (the
  report and feed code must not branch on Station kind) and run again.

- [ ] **Step 3: Run the whole suite.** Run: `npm test`. Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add tests/integrations-routes.test.mjs
git commit -m "Test the built-in Station's reports, change feed and push hints" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 6: The account page

**Files:**
- Modify: `integrations.js` (`stationRow`, new `builtInRow` placed directly above `stationRow`, `syncStationSelect`,
  `integrationRow`)
- Modify: `account.html:30` (Stations description), `styles.css` (after `.state-badge--revoking…` at line 109)
- Test: `tests/integrations-page.test.mjs`

**Interfaces:**
- Consumes: Station views (`builtIn`, `name`, `integrationsEnabled`, `role: "built_in"`) and integration roles
  (`station_admin`) from Tasks 3–4.
- Produces: `.station-item--built-in` rows with `h3` = the name, `.state-badge--built-in` "Built in",
  `.station-origin`, and one "Details" button (used by the browser smoke in Task 8).

- [ ] **Step 1: Write the failing test.** Append to `tests/integrations-page.test.mjs`:

```js
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
  assert.match(script, /As an Agora\.Build admin you can pause or revoke it\./);
  assert.match(await read("account.html"), /Every account has the built-in Agora Station/);
  assert.match(await read("styles.css"), /\.state-badge--built-in \{/);
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `node --test tests/integrations-page.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement `integrations.js`.** Insert directly above `function stationRow(station) {`:

```js
// The built-in Station: Agora.Build runs it and every account has it, so it offers Details only (no Remove, Share or
// Leave).
function builtInRow(station) {
  const output = el("p", { class: "station-details", role: "status" });
  const details = el("button", { class: "inline-link", type: "button", text: "Details" });
  details.addEventListener("click", () => act(details, null, () => stationDetails(station, output)));
  const facts = ["Run by Agora.Build for every account", station.integrationsEnabled ? "Integrations available" : "Integrations not available yet"].join(" · ");
  return el("article", { class: "account-card station-item station-item--built-in", "data-row": station.id }, [
    el("div", { class: "integration-heading" }, [el("h3", { text: station.name || "Agora Station" }), el("span", { class: "state-badge state-badge--built-in", text: "Built in" })]),
    el("p", { class: "mono station-origin", text: station.origin }),
    el("p", { class: "muted", text: facts }),
    el("div", { class: "agora-project-actions" }, [details]),
    output
  ]);
}
```

  The first line of `stationRow`'s body becomes `if (station.builtIn) return builtInRow(station);`.

  Replace `syncStationSelect` with:

```js
const BUILT_IN_OFF = "Integrations aren't available on the built-in Station yet. Add your own Station to create one.";
function syncStationSelect() {
  const select = integrationForm.elements.stationId;
  const chosen = select.value;
  // The built-in Station is offered only while Agora.Build allows integrations on it.
  const usable = stations.filter((station) => (!station.status || station.status === "active") && (!station.builtIn || station.integrationsEnabled));
  select.replaceChildren(...usable.map((station) => el("option", { value: station.id, text: station.builtIn ? (station.name || "Agora Station") + " (built in)" : station.origin })));
  if (usable.some((station) => station.id === chosen)) select.value = chosen;
  document.querySelector("#integration-submit").disabled = !usable.length;
  if (!usable.length && !integrationForm.hidden) integrationStatus.textContent = stations.some((station) => station.builtIn) ? BUILT_IN_OFF : "Add a Station first.";
}
```

  In `integrationRow`, replace the "Another account's integration on your Station…" line with:

```js
    ...(owner ? [] : [el("p", { class: "muted", text: integration.role === "station_admin" ? "Another account's integration on the built-in Station. As an Agora.Build admin you can pause or revoke it." : "Another account's integration on your Station. You can pause or revoke it." })]),
```

  and update the comment above `integrationStatus` to "Integrations: the account's own, others on Stations it owns
  (which it may pause or revoke), and for Agora.Build admins others on the built-in Station."

- [ ] **Step 4: Implement the copy and style.** In `account.html` line 30, the Stations description becomes:
  `<p class="section-description">A Station is a relay for your agents. Every account has the built-in Agora Station, run by Agora.Build. You can also register your own by proving you control its address, then share it with other accounts.</p>`
  In `styles.css` after the `.state-badge--revoking, .state-badge--revoked` rule:

```css
.state-badge--built-in { color: var(--ink); border-color: var(--ink); }
.station-origin { margin: 2px 0 0; font-size: 13px; overflow-wrap: anywhere; }
```

- [ ] **Step 5: Run the tests.** Run: `node --test tests/integrations-page.test.mjs && npm test`. Expected: PASS
  (the existing "4 confirmations" assertion still holds).

- [ ] **Step 6: Check by hand at desktop (1280×800) and mobile (390×844) widths** once Task 7's stack exists, or with
  Task 8's smoke: the built-in row first, its badge and origin wrap without overflow, Tab reaches its Details button
  with a visible focus ring.

- [ ] **Step 7: Commit.**

```bash
git add integrations.js account.html styles.css tests/integrations-page.test.mjs
git commit -m "Show the built-in Station on the account page" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 7: The end-to-end harness and flows against the real Auth

**Files:**
- Modify: `tests/e2e/harness.mjs` (imports, `loadAuth`, `clientsDocument`, `startPortal`, `startStack`; new
  `clientCredentials`, `startBuiltInStation`, `signInAtAuth`)
- Modify: `tests/e2e/integrations.e2e.mjs:45-59` (use the exported `clientCredentials`)
- Create: `tests/e2e/built-in-station.e2e.mjs`

**Interfaces:**
- Consumes: Tasks 1–6 in the Portal; Auth on `feat/built-in-station` in `AUTH_REPO` (`src/app.mjs` `createApp`,
  `tests/helpers/server.mjs` `startAuth`, `tests/helpers/flows.mjs`).
- Produces:
  - `export async function clientCredentials(stack, { clientId, privateKey, resource, scope }) → { status, body }`
  - `startStack(lib, { integrations = false, builtIn = null })`; with `builtIn: { admin: <person> }` (needs
    `integrations: true`) the stack has `stack.builtIn = { id, origin, reportClientId, adminId, nudges,
    reportToken({ resource = API, scope = "station.report" } = {}) → { status, body }, close }` and
    `stack.reconfigureAuth({ integrations?, admins? })` (a new Auth instance on the same database, the front pointed at it).
  - `loadAuth()` also returns `createApp`.

- [ ] **Step 1: Extend the harness.** In `tests/e2e/harness.mjs`:
  - imports: `import { createServer as createHttpsServer, Agent as HttpsAgent } from "node:https";`,
    `import { randomBytes, randomUUID } from "node:crypto";`, `import { exportJWK, generateKeyPair, SignJWT } from "jose";`
  - `loadAuth` adds `authModule("src/app.mjs")` to its `Promise.all` and returns `createApp: app.createApp`.
  - `clientsDocument(site, { integrations = false, builtIn = null } = {})`, before its final `return document;`:

```js
  // Auth's built-in Station (its `stations` list): no owner, every account, report key from the stub.
  if (builtIn) document.stations = [{ origin: builtIn.origin, name: "Agora Station", access: "any_account", integrations: builtIn.integrations, admins: builtIn.admins, reportKey: builtIn.reportJwk }];
```

  - after `stationFetches()`:

```js
// A client-credentials token with private_key_jwt (Auth's docs/integrating.md: the client assertion), as a Station
// report client or an integration asks for one.
export async function clientCredentials(stack, { clientId, privateKey, resource, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setIssuer(clientId).setSubject(clientId)
    .setAudience(stack.issuer + "/token").setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + 60).sign(privateKey);
  const response = await fetch(stack.issuer + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", resource, scope, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion }).toString()
  });
  return { status: response.status, body: await response.json() };
}

// Auth refuses an empty admins list; the stack starts with this placeholder, then names the admin it signed in.
const PLACEHOLDER_ADMIN = "ab" + "0".repeat(26);

// The built-in Station's stub: https://station.test:<port>, chosen before Auth starts because Auth's clients document
// names it. It records change nudges and holds its own ES256 report key; Auth sees only the public JWK.
async function startBuiltInStation() {
  const port = await freePort();
  const keys = await generateKeyPair("ES256");
  const nudges = [];
  const server = createHttpsServer(stationTls(), (request, response) => {
    if (request.method === "POST" && request.url === "/agora-build/v1/changes") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        nudges.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(202).end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  await listen(server, port, "127.0.0.1");
  return { origin: "https://" + STATION_HOST + ":" + port, nudges, privateKey: keys.privateKey, reportJwk: await exportJWK(keys.publicKey), close: () => shut(server) };
}

// Signs `user` in at Auth through the sample app, so their account exists there; returns its ID.
async function signInAtAuth(lib, partial, user) {
  const browser = createBrowser(partial);
  const rp = await lib.relyingParty(partial.idp, "sample", partial.secrets.SAMPLE_CLIENT_SECRET);
  const started = await lib.startAuthorization(rp, { redirectUri: SAMPLE_REDIRECT, scope: "openid" });
  const page = await lib.signInThrough(browser, partial.idp, started.url, { user });
  return (await lib.finishAuthorization(rp, page.location, started)).claims().sub;
}
```

  - `startPortal({ …, databaseUrl, admins = [] })` sets `PLATFORM_ADMINS: admins.join(",")` instead of `""`.
  - `startStack(lib, { integrations = false, builtIn = null } = {})` becomes:

```js
export async function startStack(lib, { integrations = false, builtIn = null } = {}) {
  if (builtIn && !integrations) throw new TypeError("builtIn needs integrations: true");
  const directory = await mkdtemp(resolve(tmpdir(), "portal-e2e-"));
  const front = createFront();
  await front.start();
  const issuer = "http://auth.localhost:" + front.port;
  const portalPort = await freePort();
  const site = "http://127.0.0.1:" + portalPort;
  const secrets = { PORTAL_CLIENT_SECRET: secret(), SAMPLE_CLIENT_SECRET: secret(), VOX_CLIENT_SECRET: secret(), NOTES_CLIENT_SECRET: secret() };
  const station = builtIn ? await startBuiltInStation() : null;
  let entry = station ? { origin: station.origin, reportJwk: station.reportJwk, integrations: false, admins: [PLACEHOLDER_ADMIN] } : null;
  const auth = await lib.startAuth({ issuer, clients: clientsDocument(site, { integrations, builtIn: entry }), env: secrets });
  front.point(auth.origin);
  const idp = { issuer, fake: auth.fake, fetch: (input, init) => fetch(input, init) };
  // Another Auth instance on the same database with a changed built-in entry (Auth re-seeds it at startup), as a
  // restart with an edited clients file; the front then sends everything there.
  const instances = [];
  async function reconfigureAuth(changes) {
    entry = { ...entry, ...changes };
    const app = await lib.createApp({ config: auth.app.services.config, db: auth.db, clientsDocument: clientsDocument(site, { integrations, builtIn: entry }), upstream: auth.app.services.upstream, timers: false, listen: false });
    const server = createServer(app.handler);
    await listen(server, 0, "127.0.0.1");
    instances.push({ app, server });
    front.point("http://127.0.0.1:" + server.address().port);
  }
  const adminId = builtIn ? await signInAtAuth(lib, { issuer, site, idp, secrets }, builtIn.admin) : null;
  if (adminId) await reconfigureAuth({ admins: [adminId] });
  const logs = [];
  const database = integrations ? await portalDatabase() : null;
  const portal = await startPortal({ issuer, port: portalPort, directory, clientSecret: secrets.PORTAL_CLIENT_SECRET, logs, databaseUrl: database?.url, admins: adminId ? [adminId] : [] })
    .catch(async (error) => { await database?.drop(); throw error; });
  const closers = [];
  const stack = {
    issuer, site, auth, idp, front, portal, store: portal.store, logs, secrets, directory, reconfigureAuth, builtIn: null,
    // Another Portal against the same issuer (for example one started while the IdP is down).
    async extraPortal() {
      const extra = await startPortal({ issuer, port: await freePort(), directory, clientSecret: secrets.PORTAL_CLIENT_SECRET, logs });
      closers.push(extra.close);
      return extra;
    },
    async close() {
      for (const close of closers) await close();
      await station?.close();
      await portal.close();
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

  Update the header comment of the file: "With `{ integrations: true, builtIn: { admin } }` Auth's clients document also has
  a built-in Station at https://station.test:<port> (a stub here), the admin is signed in at Auth first and named in
  Auth's `admins` and the Portal's `PLATFORM_ADMINS`, and `reconfigureAuth()` changes the entry as an Auth restart would."

- [ ] **Step 2: Use it in `tests/e2e/integrations.e2e.mjs`.** Import `clientCredentials as harnessClientCredentials`
  from `./harness.mjs`; replace the local `clientCredentials` with:

```js
// A client-credentials token with private_key_jwt, as a Station report client or an integration asks for one.
async function clientCredentials(options) {
  const answer = await harnessClientCredentials(stack, options);
  remember(answer.body);
  return answer;
}
```

  and drop `SignJWT` from its `jose` import and `randomUUID` from its `node:crypto` import if nothing else uses them.

- [ ] **Step 3: Write `tests/e2e/built-in-station.e2e.mjs`:**

```js
// End-to-end check of the built-in Station (spec §3.3.2, D24): the real Portal, the real auth.agora.build with a
// built-in Station in its clients file, and that Station's stub, over real HTTP(S). Run with `npm run test:e2e` on
// Node 22, with TEST_DATABASE_URL (Auth) and PORTAL_TEST_DATABASE_URL (the Portal) set. Not part of npm test.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeJwt, exportJWK, generateKeyPair } from "jose";
import { API, authRepo, bearer, eventually, integrationsSkipReason, loadAuth, person, portalSignIn, skipReason, startStack } from "./harness.mjs";

const skip = (await skipReason()) ?? (await integrationsSkipReason());
if (skip) console.log("# Skipping the built-in Station end-to-end suite: " + skip + ".");

const SCOPES = ["agent.view", "agent.prompt"];
const REPORT_CLIENT = /^s-[0-9a-hjkmnp-tv-z]{26}$/;
const PLAN_MESSAGE = (n) => "Your plan allows " + n + " integrations on the built-in Station. Revoke one, upgrade, or use your own Station.";
let lib;
let reference;
let stack;
let built;
const state = {};

const json = async (response) => ({ status: response.status, body: await response.json() });
const meOf = async (browser) => (await browser.api("/api/me")).json();
// Auth's management API, as the Portal calls it (HTTP Basic with the Portal client).
const manage = (method, path, body) => fetch(stack.issuer + "/manage/v1" + path, {
  method,
  headers: { Authorization: "Basic " + Buffer.from("portal:" + encodeURIComponent(stack.secrets.PORTAL_CLIENT_SECRET)).toString("base64"), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {})
}).then(async (response) => ({ status: response.status, body: response.status === 204 ? null : await response.json() }));
const publicJwk = async () => exportJWK((await generateKeyPair("ES256")).publicKey);
const create = async (browser, name = "Hosted app") => json(await browser.api("/api/integrations", { method: "POST", json: { stationId: built.id, name, scopes: SCOPES, publicJwk: await publicJwk() } }));
const feed = async (cursor, token) => json(await bearer(stack, "/api/v1/stations/changes?cursor=" + cursor, token));
const setPlan = (accountId, change) => stack.store.transaction((data) => { Object.assign(data.accounts.find((account) => account.id === accountId), change); });

describe("The built-in Station against the real auth.agora.build", { skip: skip || false }, () => {
  before(async () => {
    lib = await loadAuth();
    reference = await import(pathToFileURL(resolve(authRepo, "scripts/verify-station-token.mjs")).href);
    stack = await startStack(lib, { integrations: true, builtIn: { admin: person(7301, "Cy") } });
    built = stack.builtIn;
  });
  after(async () => { await stack?.close(); });

  test("1. two accounts both list the built-in Station first, with no owner; Auth lists it the same way; both may read it", async () => {
    state.ada = await portalSignIn(stack, person(7311, "Ada"));
    state.adaId = (await meOf(state.ada.browser)).account.id;
    state.bo = await portalSignIn(stack, person(7312, "Bo"));
    state.boId = (await meOf(state.bo.browser)).account.id;
    for (const [browser, id] of [[state.ada.browser, state.adaId], [state.bo.browser, state.boId]]) {
      const { stations } = await (await browser.api("/api/stations")).json();
      assert.deepEqual(stations.map(({ id: stationId, origin, role, builtIn, ownerAccount, name, integrationsEnabled }) => ({ stationId, origin, role, builtIn, ownerAccount, name, integrationsEnabled })), [{ stationId: built.id, origin: built.origin, role: "built_in", builtIn: true, ownerAccount: null, name: "Agora Station", integrationsEnabled: false }]);
      assert.equal(stations[0].reportClientId, undefined);
      const inAuth = await manage("GET", "/stations?account=" + id);
      assert.deepEqual(inAuth.body.stations.map(({ id: stationId, builtIn, owner, access, integrations }) => ({ stationId, builtIn, owner, access, integrations })), [{ stationId: built.id, builtIn: true, owner: null, access: "any_account", integrations: false }]);
    }
    const read = await json(await state.bo.browser.api("/api/stations/" + built.id + "/read-token", { method: "POST", json: {} }));
    assert.equal(read.status, 200);
    const verifier = reference.createStationVerifier({ issuer: stack.issuer, origin: built.origin });
    assert.deepEqual(await verifier.verify(read.body.accessToken, { scope: "station.read" }), { sub: state.boId, clientId: "portal", scopes: ["station.read"] });
  });

  test("2. removing, sharing, leaving, listing members and registering it are refused, as Auth refuses them", async () => {
    for (const [method, path] of [["DELETE", "/api/stations/" + built.id], ["PUT", "/api/stations/" + built.id + "/members/" + state.boId], ["DELETE", "/api/stations/" + built.id + "/members/" + state.adaId], ["GET", "/api/stations/" + built.id + "/members"]]) {
      const answer = await json(await state.ada.browser.api(path, { method }));
      assert.deepEqual([answer.status, answer.body.code], [409, "built_in"], method + " " + path);
    }
    const challenge = await json(await state.ada.browser.api("/api/stations/challenges", { method: "POST", json: { origin: built.origin } }));
    assert.deepEqual([challenge.status, challenge.body.code], [409, "origin_taken"]);
    const removed = await manage("DELETE", "/stations/" + built.id + "?actor=" + built.adminId);
    assert.deepEqual([removed.status, removed.body.error], [409, "built_in"], "not even an admin removes it at Auth");
    assert.equal((await manage("GET", "/stations/" + built.id + "/members?actor=" + state.adaId)).body.error, "built_in");
    const register = await manage("POST", "/stations", { origin: built.origin, owner: state.adaId, reportKey: await publicJwk(), actor: state.adaId });
    assert.deepEqual([register.status, register.body.error], [409, "origin_taken"]);
  });

  test("3. its report token's sub is its own s- client; the Portal accepts it for the feed and makes no account for it", async () => {
    const issued = await built.reportToken();
    assert.equal(issued.status, 200);
    const claims = decodeJwt(issued.body.access_token);
    assert.deepEqual([claims.sub, claims.client_id, claims.aud, claims.scope], [built.reportClientId, built.reportClientId, API, "station.report"]);
    assert.match(claims.sub, REPORT_CLIENT);
    const first = await feed(0, issued.body.access_token);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.integrations, []);
    const elsewhere = await json(await bearer(stack, "/api/v1/me", issued.body.access_token));
    assert.equal(elsewhere.status, 403, "it reaches nothing but the report routes");
    assert.equal((await stack.store.snapshot()).accounts.some((account) => account.id === built.reportClientId), false);
  });

  test("4. creating an integration on it is refused while its integrations are off, and works once they are on", async () => {
    const off = await create(state.ada.browser);
    assert.deepEqual([off.status, off.body.code], [409, "not_supported"]);
    const atAuth = await manage("POST", "/integrations", { owner: state.adaId, stationId: built.id, name: "Direct", scopes: ["agent.view"], publicJwk: await publicJwk(), actor: state.adaId });
    assert.deepEqual([atAuth.status, atAuth.body.error], [409, "not_supported"], "Auth refuses it the same way");
    await stack.reconfigureAuth({ integrations: true });
    assert.equal((await (await state.ada.browser.api("/api/stations")).json()).stations[0].integrationsEnabled, true);
    const nudgesBefore = built.nudges.length;
    const ada = await create(state.ada.browser);
    assert.deepEqual([ada.status, ada.body.role, ada.body.state], [201, "owner", "awaiting_approval"]);
    state.adaFirst = ada.body;
    const bo = await create(state.bo.browser);
    assert.equal(bo.status, 201);
    state.boFirst = bo.body;
    const listed = await manage("GET", "/integrations?account=" + state.boId);
    assert.deepEqual(listed.body.integrations.map(({ clientId, owner, stationId }) => [clientId, owner, stationId]), [[state.boFirst.id, state.boId, built.id]]);
    assert.ok(await eventually(() => built.nudges.length > nudgesBefore), "a push hint reached the built-in Station's origin");
  });

  test("5. its feed lists every integration on it, each with its owner, and its reports are accepted", async () => {
    const token = (await built.reportToken()).body.access_token;
    const snapshot = await feed(0, token);
    assert.deepEqual(snapshot.body.integrations.map(({ id, ownerAccount }) => [id, ownerAccount]), [[state.adaFirst.id, state.adaId], [state.boFirst.id, state.boId]]);
    const reported = await json(await bearer(stack, "/api/v1/stations/reports", token, { method: "POST", json: { integrationId: state.adaFirst.id, state: "error", reason: "host offline" } }));
    assert.deepEqual([reported.status, reported.body.lastError], [200, "host offline"]);
    const unknown = await json(await bearer(stack, "/api/v1/stations/reports", token, { method: "POST", json: { integrationId: "i-" + "0".repeat(26), state: "error", reason: "x" } }));
    assert.equal(unknown.status, 404);
  });

  test("6. plan limits on it: Basic 4, Principal no cap, and a downgrade keeps the existing ones", async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await create(state.ada.browser)).status, 201);
    const limited = await create(state.ada.browser);
    assert.deepEqual([limited.status, limited.body.code, limited.body.error, limited.body.limit], [403, "plan_limit", PLAN_MESSAGE(4), 4]);
    await setPlan(state.adaId, { assignedPlan: "principal" });
    assert.equal((await create(state.ada.browser)).status, 201, "a Principal has no cap");
    await setPlan(state.adaId, { assignedPlan: null });
    const mine = (await (await state.ada.browser.api("/api/integrations")).json()).integrations.filter((entry) => entry.stationId === built.id);
    assert.equal(mine.length, 5, "all five are still there after the downgrade");
    const atAuth = (await manage("GET", "/integrations?account=" + state.adaId)).body.integrations.filter((entry) => entry.stationId === built.id);
    assert.ok(atAuth.every((entry) => entry.status === "active"), "and still active at Auth");
    assert.equal((await create(state.ada.browser)).status, 403, "new ones wait until the account is under the limit");
    for (const entry of mine.slice(1, 3)) assert.equal((await json(await state.ada.browser.api("/api/integrations/" + entry.id + "/revoke", { method: "POST", json: {} }))).status, 200);
    assert.equal((await create(state.ada.browser)).status, 201, "under the limit again");
  });

  test("7. Agora.Build admins pause and revoke others' integrations on it; nobody else sees them", async () => {
    const cy = await portalSignIn(stack, person(7301, "Cy"));
    assert.equal((await meOf(cy.browser)).account.id, built.adminId);
    const seen = (await (await cy.browser.api("/api/integrations")).json()).integrations;
    assert.ok(seen.some((entry) => entry.id === state.boFirst.id && entry.role === "station_admin"));
    assert.ok(seen.every((entry) => entry.role === "station_admin"));
    const bosView = (await (await state.bo.browser.api("/api/integrations")).json()).integrations;
    assert.ok(bosView.every((entry) => entry.role === "owner"), "Bo sees only his own");
    const nudgesBefore = built.nudges.length;
    const paused = await json(await cy.browser.api("/api/integrations/" + state.boFirst.id + "/pause", { method: "POST", json: {} }));
    assert.deepEqual([paused.status, paused.body.state, paused.body.role], [200, "paused", "station_admin"]);
    assert.equal((await manage("GET", "/integrations?account=" + state.boId)).body.integrations.find((entry) => entry.clientId === state.boFirst.id).status, "paused", "paused at Auth");
    assert.equal((await cy.browser.api("/api/integrations/" + state.boFirst.id + "/resume", { method: "POST", json: {} })).status, 403, "only the owner resumes");
    const revoked = await json(await cy.browser.api("/api/integrations/" + state.adaFirst.id + "/revoke", { method: "POST", json: {} }));
    assert.deepEqual([revoked.status, revoked.body.state], [200, "revoked"]);
    assert.equal((await state.bo.browser.api("/api/integrations/" + state.adaFirst.id + "/pause", { method: "POST", json: {} })).status, 404, "an ordinary account can't find another's integration");
    assert.ok(await eventually(() => built.nudges.length > nudgesBefore), "the changes were pushed to the Station");
    for (const value of Object.values(stack.secrets)) assert.ok(!stack.logs.join("\n").includes(value), "no secret in the Portal log");
  });
});
```

- [ ] **Step 4: Run the suites.** With Node 22, `TEST_DATABASE_URL`, `PORTAL_TEST_DATABASE_URL`, and the Auth checkout
  on `feat/built-in-station` with `npm ci` done:
  Run: `npm run test:e2e`
  Expected: PASS for `idp.e2e.mjs`, `integrations.e2e.mjs` (unchanged flows) and `built-in-station.e2e.mjs`. If Auth's
  sign-in for Cy through the sample app shows a consent page, `signInThrough` gives consent; if `claims()` is
  missing, decode `id_token` with `decodeJwt` instead.

- [ ] **Step 5: Run `npm test`.** Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add tests/e2e/harness.mjs tests/e2e/integrations.e2e.mjs tests/e2e/built-in-station.e2e.mjs
git commit -m "Run the built-in Station end to end against the real Auth" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 8: Docs and the browser smoke

**Files:**
- Modify: `docs/platform.md` ("Apps: IdP Access Tokens And Scopes" table and errors; "Stations And Integrations" intro,
  tables, new "The Built-in Station" subsection, routes, error codes; "Verification")
- Modify: `scripts/browser-smoke-integrations.mjs` (stack option, shared `clientCredentials`, built-in checks)

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: the operator and integrator documentation; a smoke that checks the built-in row and selector.

- [ ] **Step 1: Write the docs.** In `docs/platform.md`:
  - "Apps" table, the `POST /stations/reports` row's scope cell becomes "`station.report`, from a Station's `s-` client
    (`sub` is the Station's owner, or for the built-in Station the `s-` client itself)". Add to "Bearer errors": "a
    built-in Station's own report token (`sub` = its `s-` client) on any other route: 403".
  - "Stations And Integrations" intro, after the first paragraph:

```markdown
Every account also has the **built-in Station** (`https://station.agora.build`; on dev
`https://station-dev.agora.build`), which Agora.Build runs (spec D24). Auth admits it from the `stations` list in
its clients file instead of proof of control; nobody owns it, every signed-in account may use it, and nobody can
remove it through any page or API.
```

  - `stations` table row: "Auth's Station ID, origin, owner (none for a built-in Station), report client ID, `active`
    or `removed`, `built_in`, `access` (`members` or `any_account`), `integrations_enabled`, `name`".
  - New subsection before "### Routes":

```markdown
### The Built-in Station

- **Listing.** `GET /api/stations` lists it first for every account, with `role` `built_in`, `builtIn: true`,
  `ownerAccount: null`, its `name` and `integrationsEnabled`, and no `reportClientId`. Each listing follows Auth's
  `integrations` setting and name. A listing from Auth that lacks it changes nothing (it is never removed and its
  integrations are never revoked because of that; the log says so); the Portal retires it only when Auth lists a new
  Station at its origin.
- **Refused without asking Auth** (as Auth refuses them): remove, share, unshare, leave and its member list answer
  409 `built_in`; a check value for, or registration of, its origin 409 `origin_taken`. Any account gets a
  `station.read` token for it.
- **Integrations** are offered only while `integrationsEnabled` is true; otherwise creation answers 409
  `not_supported`. Each is owned by and visible to its creator, with the usual approval in Astation. **Plan limits**
  apply here only: Basic 4, Premium 10, Principal and Fellow no cap, counting the account's integrations on it in every
  state except `revoked` and not expired. At the limit creation answers 403 `{ "error": "Your plan allows N integrations
  on the built-in Station. Revoke one, upgrade, or use your own Station.", "code": "plan_limit", "limit": N }`. After a
  downgrade existing integrations keep working; new ones wait until the account is under its limit. Custom Stations
  have no cap. One account's creations on it are taken one at a time per Portal process.
- **Admins** are the accounts in `PLATFORM_ADMINS`, which must equal the Station's `admins` in Auth's clients file.
  They see every other account's integration on it (`role` `station_admin`) and may pause or revoke them, nothing
  else; the history records reason `station_admin`.
- **Reports and feed** use the same routes as any Station. Its report token's `sub` is its own `s-` client ID (it has
  no owner): the Portal accepts such a token only when `client_id` equals `sub`, `sub` is `s-` and 26 lower-case
  Crockford base32 characters, and the scope includes `station.report`. It reaches only the two report routes (403
  elsewhere) and is never a Portal account. Its feed lists every integration on it, each with `ownerAccount`, and
  nothing else; push hints go to its origin. The Portal learns of the Station from Auth's listing the first time any
  account lists its Stations; a report before that answers 403 `station`.
```

  - Routes table: `GET /api/stations` → "the account's Stations (`role` `built_in`, `owner` or `member`)";
    `POST /api/integrations` → add "on a built-in Station: only while its integrations are on, within the plan limit";
    `POST /api/integrations/<id>/pause`, `resume`, `revoke` → "pause and revoke also by the Station's owner, or on a
    built-in Station by an Agora.Build admin".
  - Common error codes: add "`built_in` (409, the built-in Station can't be removed, shared or left), `not_supported`
    (409, integrations are off on the built-in Station), `plan_limit` (403, the plan's limit on the built-in Station)".
  - "Verification": after the e2e paragraph add "`tests/e2e/built-in-station.e2e.mjs` runs the built-in Station: two
    accounts listing it, the refused actions, its `s-` report token, its feed, integrations off then on, the plan
    limit and admin pause and revoke. `scripts/browser-smoke-integrations.mjs` also checks its row and the Station
    selector."

- [ ] **Step 2: Update the smoke.** In `scripts/browser-smoke-integrations.mjs`:
  - import `clientCredentials as harnessClientCredentials` from `../tests/e2e/harness.mjs`; replace the local
    `clientCredentials` body with
    `return (await harnessClientCredentials(stack, { clientId, privateKey, resource, scope })).body.access_token;`
    and drop the now unused `SignJWT` and `randomUUID` imports.
  - `const stack = await startStack(lib, { integrations: true, builtIn: { admin: person(7999, "Smoke Admin") } });`
    and right after it `stubs.push({ origin: stack.builtIn.origin });` (so "Details" is answered for it).
  - In the "add Station" step, the count check becomes `=== 3` with the label "…adds the second custom Station to the
    list (after the built-in one)".
  - After the "lists" step add:

```js
    await step(tag + "built-in Station", async () => {
      const first = page.locator("#station-list .station-item").first();
      check(await first.evaluate((node) => node.classList.contains("station-item--built-in")), tag + "the built-in Station comes first");
      const row = item(page, ".station-item", "Agora Station");
      check((await row.locator(".state-badge").textContent()) === "Built in", tag + "it is marked Built in");
      check((await row.locator(".station-origin").textContent()) === stack.builtIn.origin, tag + "it shows its origin");
      const buttons = await row.getByRole("button").allTextContents();
      check(buttons.length === 1 && buttons[0] === "Details", tag + "it offers Details only (" + buttons.join(", ") + ")");
      check(await row.locator(".station-members").count() === 0, tag + "it has no Members and sharing panel");
      await row.getByRole("button", { name: "Details", exact: true }).click();
      await until(async () => !/^(|Asking the Station\.\.\.)$/.test(await row.locator(".station-details").textContent()), "the built-in Station's details");
      check((await row.locator(".station-details").textContent()) === "Smoke Station · online", tag + "Details reads the built-in Station");
      await shot(row, viewport.name + "-built-in-station");
    });
```

  - In the "create integration with a generated key" step, after the form is visible:

```js
      const offered = await form.locator("[name=stationId] option").allTextContents();
      check(!offered.some((label) => /built in/.test(label)), tag + "the Station selector leaves out the built-in Station while its integrations are off");
```

- [ ] **Step 3: Run the smoke** (opt-in; needs `PLAYWRIGHT_CORE`, `CHROMIUM_PATH` and the e2e settings):
  Run: `SCREENSHOT_DIR=/tmp/portal-smoke node scripts/browser-smoke-integrations.mjs`
  Expected: every check passes at desktop and mobile; look at `*-built-in-station.png` and `*-stations.png`.

- [ ] **Step 4: Run `npm test`.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add docs/platform.md scripts/browser-smoke-integrations.mjs
git commit -m "Document the built-in Station and check it in the browser smoke" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 9: Final verification and the dev rollout with Auth (documentation, not executed)

**Files:** none in the repository. The dev settings live outside it. This task changes no code.

- [ ] **Step 1: Full verification.** With `PORTAL_TEST_DATABASE_URL` set: `npm test` → PASS, no skipped PostgreSQL
  tests. With Node 22 and `TEST_DATABASE_URL` too: `npm run test:e2e` → PASS. Optional: the browser smoke (Task 8).
  Then `npm run build` and check `dist/migrations/002_built_in_stations.sql` exists.

- [ ] **Step 2: Spec check.** Walk §3.3.2 item 5 and item 10 (Portal parts) against the tests: listing for every
  account (Task 3, e2e 1), refused remove/share/re-register (Task 3, e2e 2), reconcile never treats it as missing
  (Task 3), integrations offered only while on (Tasks 4, 6, e2e 4), plan limits with revoked and expired not counted,
  custom never capped, downgrade (Task 4, e2e 6), admins' rights only pause/revoke (Task 4, e2e 7), feed lists only its
  own integrations with `ownerAccount` (Task 5, e2e 5), push to its origin (Task 5, e2e 4), `s-` report token (Task 1,
  e2e 3), two accounts against the real Auth (e2e).

- [ ] **Step 3: Dev rollout (the owner runs this, after both branches are reviewed; Auth and Portal go together).**
  The new Auth refuses to start with the old clients file and the old Auth refuses the new one, and the built-in
  Station's reports need this Portal, so both containers change in one window. Never print values from `local.env`.
  1. Build the images from the reviewed branches:
     `docker build -t auth:local /home/guohai/Dev/Agora.Build/Auth` (checked out at `feat/built-in-station`) and
     `docker build -t portal:local /home/guohai/Dev/Agora.Build/Portal` (at `feat/built-in-station`). Keep the
     previous images tagged (`docker tag auth:local auth:pre-d24` and `docker tag portal:local portal:pre-d24`, before
     building) for rollback.
  2. Back up the clients file: `cp ~/.config/ab-auth/clients.json ~/.config/ab-auth/clients.json.bak-$(date -u +%Y%m%dT%H%M%SZ)`.
  3. Edit `~/.config/ab-auth/clients.json`: in `resources`, delete the `https://station.agora.build` entry (scopes
     `astation.remote`); in the `astation` client, `resources` becomes `["https://dev.agora.build"]` (keep
     `stationScopes: ["astation.remote"]`); add the top-level list (the owner fills `admins` with exactly the account
     IDs in the Portal's `PLATFORM_ADMINS`, at least one; `~/.config/ab-portal/start.sh --check` shows it is set):

```json
  "stations": [
    {
      "origin": "https://station-dev.agora.build",
      "name": "Agora Station",
      "access": "any_account",
      "integrations": false,
      "admins": ["<the Portal's PLATFORM_ADMINS account IDs, ab…>"],
      "reportKey": { "kty": "EC", "crv": "P-256", "x": "ZTwVfP-VtvyfwUAlK1kfBAiOIT_r1aWUQy10HXdXY-Q", "y": "gY2gGxYziA6WmTPpvFwOzeOnN1I0tUVT_kKEVLxaeAw" }
    }
  ]
```

  4. Confirm the key is vault e96's: from the Auth checkout,
     `node -e 'import("jose").then(async ({ calculateJwkThumbprint }) => console.log(await calculateJwkThumbprint({ kty: "EC", crv: "P-256", x: "ZTwVfP-VtvyfwUAlK1kfBAiOIT_r1aWUQy10HXdXY-Q", y: "gY2gGxYziA6WmTPpvFwOzeOnN1I0tUVT_kKEVLxaeAw" }, "sha256")))'`
     prints `caIk-O1RarbiQ6_XTCJ36dgiFm_HfG6JvCQfUgMF2RA`.
  5. Confirm no custom Station holds the origin, in Auth's and the Portal's databases:
     `docker exec portal-postgres psql -U portal -d auth -c "SELECT id, status FROM stations WHERE origin = 'https://station-dev.agora.build'"`
     and the same with `-d portal` return no `active` row.
  6. Restart both together: `~/.config/ab-auth/start.sh auth:local`, wait for `docker logs auth-local` to show
     `built-in Station seeded {"origin":"https://station-dev.agora.build"}` (an error line names any admin that is not
     an account yet), then `~/.config/ab-portal/start.sh portal:local`.
  7. Verify on dev with two accounts (one of them an admin): sign in at `https://dev.agora.build/account/`; Stations
     lists "Agora Station · Built in" first, with only Details, for both; Details answers (the Station serves
     `/agora-build/v1/details` with CORS from the Portal); `DELETE /api/stations/<id>`, `PUT …/members/<ab…>` and a
     check for `https://station-dev.agora.build` answer 409 (`built_in`, `origin_taken`); the Station selector does not
     offer it (`integrations: false`). In the Portal database:
     `SELECT id, built_in, integrations_enabled, report_client_id FROM stations WHERE origin = 'https://station-dev.agora.build'`
     shows one active built-in row (the first listing created it; P17). `docker logs portal-local` shows no
     `Portal database is not ready` line (migration 002 ran).
  8. Read the stable report client ID:
     `docker exec portal-postgres psql -U portal -d auth -c "SELECT report_client_id FROM stations WHERE origin = 'https://station-dev.agora.build' AND status = 'active'"`.
  9. Hand it to Astation on Portal #21 (`gh issue comment 21 --repo Agora-Build/Portal`), with: the origin
     `https://station-dev.agora.build`, the key thumbprint `caIk-O1RarbiQ6_XTCJ36dgiFm_HfG6JvCQfUgMF2RA`, the token
     request (ES256 `private_key_jwt` at `https://auth.dev.agora.build/token`, `resource=https://dev.agora.build`,
     `scope=station.report`; the token's `sub` is the `s-` ID itself), the routes
     `POST https://dev.agora.build/api/v1/stations/reports` and `GET https://dev.agora.build/api/v1/stations/changes?cursor=`,
     that `integrations` stays `false` until Astation asks for its disposable-integration checks, and that Astation's
     earlier grants for `https://station.agora.build` don't cover the dev origin (sign in again with the new
     resource). End the comment with `Generated with SMT <smt@agora.build>`.
  10. Later, on Astation's request: the owner sets `"integrations": true` for the entry and restarts `auth-local`
      only; the Portal follows on the next listing.
  11. Rollback: restore the clients-file backup and start `auth:pre-d24` and `portal:pre-d24` together. Never delete
      the `stations` entry later: to retire it keep `{ "origin": "https://station-dev.agora.build", "retired": true }`.
      Production repeats this with `https://station.agora.build` and its own key, only on the owner's approval.

- [ ] **Step 4: No commit** (nothing in the repository changed). Report the test results and hand the rollout to the
  owner.

---

## Conflicts between the spec, the Auth branch and the Portal code

| # | Conflict | Resolution in this plan |
|---|---|---|
| X1 | Spec: the built-in Station has no owner; Auth gives its report token `sub` = the `s-` client ID (Auth plan R10/C1); Portal `scripts/idp.mjs:349-350` refuses any non-`ab` `sub` and `serve.mjs` calls `ensureAccount(sub)` for bearer routes | Task 1: accept exactly that form, confine it to the two report routes, never make an account |
| X2 | Portal `stations.owner_account` is NOT NULL (`migrations/001`); Auth lists built-in Stations with `owner: null` | Task 2: migration 002 makes it nullable, tied to `built_in` by a CHECK |
| X3 | `integration_events.account_id` is NOT NULL, but a built-in Station's own events have no owner | P4: `account_id` = `actor` = `"system"` for them (also in `retireStale`) |
| X4 | The Portal's reconcile removes a Station missing from an account's listing and adds a listing account as a member when it is not the owner; both are wrong for an ownerless Station every account sees | Task 3: built-in entries take their own path; never removed or revoked on absence (spec item 5) |
| X5 | Spec item 4 gives admins "listing its integrations"; Auth has no per-Station listing (Auth plan C5), and Auth's Station listing does not return `admins` | The Portal lists from its own rows (P13) and uses `PLATFORM_ADMINS`; if Auth's `admins` and `PLATFORM_ADMINS` differ, the Portal shows controls Auth refuses (shown as "Only the Station owner can do this."). The rollout keeps them equal |
| X6 | Spec §3.3.2.1: keep `integrations: false` until Astation's checks pass, yet create a disposable integration on the built-in Station | As ruled for Auth (Auth plan C3): dev keeps `false` until Astation asks, then the owner flips it; the Portal follows each listing |
| X7 | Spec "every state except `revoked`" also counts `revoking` and `paused` integrations | Followed literally; documented in `docs/platform.md` |
| X8 | Auth retires a built-in Station only with an explicit `retired: true` entry and then stops listing it; the spec forbids treating absence as removal | P5: the Portal keeps the row and logs; it is retired in the Portal only when Auth lists a new Station at the same origin (otherwise an operator marks it removed) |
| X9 | The Portal knows a built-in Station only after some account lists its Stations (Auth's listing needs an account); the Station may poll first | P17: a report or feed read before that is 403 `station`; the rollout lists once before the handoff |
| X10 | Spec: the Portal "refuses at the plan's limit"; a single count before Auth's call can be raced, and the Portal may later run several instances | P11: serialized per account and Station in one process; soft across replicas |
| X11 | The old e2e flows assert one Station per listing | The built-in Station is opt-in in the harness (`builtIn`), so they stay as they are (P16) |
