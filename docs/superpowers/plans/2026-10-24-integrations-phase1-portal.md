# Unified Integrations Phase 1 (Portal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portal manages registered Stations (proof of control, sharing, removal) and integrations (create, approve, rotate, pause, resume, revoke, renew), keeps them forever in new PostgreSQL tables, accepts authenticated Station reports, gives Stations a change feed plus a push nudge, and hands the browser 5-minute `station.read` tokens.

**Architecture:** Auth (already built, Agora-Build/Auth PR #9) is the authority for who may get tokens: Portal calls its `/manage/v1` API with the acting account on every change, and only writes its own rows after Auth agrees. Portal's own PostgreSQL tables (separate from the `agora_build_state` JSON document) hold the Portal-side record: Stations, members, integrations with the shared design's lifecycle states, proof-of-control challenges, and an append-only, monthly-partitioned `integration_events` table that is both the history (kept forever) and the Stations' change feed. A list call reconciles Portal's rows with Auth's answer, so a crash between the Auth call and the Portal write heals on the next read. Everything lives in a new `scripts/integrations/` directory; `serve.mjs` only wires routes. Without `DATABASE_URL` (file-store mode) every integration route answers 503.

**Tech Stack:** Node.js ≥ 20.12 built-ins (`node:http`, `node:https`, `node:dns`, `node:net`, `node:crypto`, `node:test`), `pg` 8.16.3, `jose` 6.2.12 (tests only for signing), browser WebCrypto. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-24-agora-build-integrations.md` (copy of the companion design, decisions D1–D23; §3.3, §3.5, §3.6 and D3, D5, D6, D9, D15–D17, D19 bind this plan). The Auth contract Portal calls is `~/Dev/Agora.Build/Auth/docs/integrating.md` ("Stations, integrations and the management API", "Token exchange for browser reads") and `~/Dev/Agora.Build/Auth/docs/station-tokens.md` §B.

## Global Constraints

- Node.js 20.12+; built-in modules only; ESM `.mjs`; two-space indent, double quotes, semicolons (AGENTS.md).
- No new npm dependencies.
- Integration features need PostgreSQL (`DATABASE_URL`). In file-store mode every `/api/stations…`, `/api/integrations…` and `/api/v1/…` integration route answers `503` with `{ error: "Stations and integrations need the Portal database." }`, and the account page hides those sections.
- Auth is called first; Portal writes its rows only after Auth answers success. Every Auth change carries `actor` = the signed-in account (`ab…`).
- Rows are never deleted in normal operation (D19): status columns, `removed_at`, `revoked` states, append-only `integration_events`. (Account deletion is a later plan.)
- `integration_events` is partitioned by month on `at` (UTC, names `integration_events_yYYYYmMM`) with a DEFAULT partition; partitions for this month and next are created at startup and hourly.
- Integration expiry: default 30 days, maximum 90 days (D9). Quota default 200/s, 1–10000 (D15).
- **Portal never sets Ready itself (D6)**; only an authenticated Station report does.
- Proof of control (station-tokens.md §B1): HTTPS only, no redirects, timeout 5 s, body at most 1024 bytes, status 200, body equals the issued value exactly with at most one trailing `\n`; an issued value is valid 10 minutes and single-use. The fetch refuses loopback, private, link-local, CGNAT, multicast and unspecified addresses (IPv4 and IPv6), checked on the resolved address that is actually connected to.
- Station reports and the change feed accept only bearer tokens with scope `station.report` whose `client_id` is the `reportClientId` of an active Station Portal knows.
- Never log tokens, ID tokens, keys, challenge values or request bodies. Log by reason only (existing style: `log("…: " + reason + ".")`).
- Credentials: none in source, docs, tests fixtures beyond obvious test-only strings; tests use generated keys.
- Error bodies use the existing `{ error: "<sentence>" }` shape via `AppError(status, message)`; integration routes may add `code` (e.g. `{ error, code: "forbidden" }`) through `AppError` `details`.
- The `/api` router only allows GET, POST, PUT, DELETE; actions are `POST …/<action>`.
- Tests: `node --test`; PostgreSQL tests use `PORTAL_TEST_DATABASE_URL` (database name `agora_portal_test`), each test file in its own schema created and dropped by the test, and are skipped when it is unset. CI gets a PostgreSQL service so they run there.
- Commits end with `🤖 Built with SMT <smt@agora.build>`; no co-author trailers.

Local test database for this build (a throwaway container, never `portal-postgres`):

```bash
export PORTAL_TEST_DATABASE_URL="postgres://postgres:$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' pg-auth-phase1 | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55450/agora_portal_test"
```

Never print that variable.

---

## File structure

| File | Responsibility |
| --- | --- |
| `migrations/001_integrations.sql` | Portal integration tables (new; first Portal SQL migration) |
| `scripts/integrations/db.mjs` | Pool with optional schema, `transaction`, `migrate`, `ensureEventPartitions` |
| `scripts/integrations/auth-manage.mjs` | Client for Auth `/manage/v1` (HTTP Basic) and `ManageError` |
| `scripts/idp.mjs` (modify) | `exchangeForStation(idToken, origin)` RFC 8693 call |
| `scripts/integrations/proof.mjs` | Origin normalisation, SSRF-safe HTTPS fetch, proof check, push nudge transport |
| `scripts/integrations/states.mjs` | Pure lifecycle state machine |
| `scripts/integrations/repository.mjs` | All SQL for Stations, members, challenges, integrations, events/feed |
| `scripts/integrations/service.mjs` | Business flows combining Auth, repository, proof, push, exchange |
| `scripts/integrations/routes.mjs` | HTTP handler for `/api/stations…`, `/api/integrations…`, `/api/v1/…` integration routes |
| `scripts/serve.mjs` (modify) | Wiring, bearer route patterns, 503 in file mode, `close` |
| `scripts/store.mjs` (modify) | `sessionIdToken(token)` |
| `account.html`, `integrations.js` (new), `styles.css`, `scripts/serve.mjs` publicFiles, `scripts/build.mjs` | Stations and Integrations sections on `/account/` |
| `docs/platform.md` | "Stations And Integrations" section incl. the Station-facing contract |
| `.github/workflows/docker.yml` | PostgreSQL service and `PORTAL_TEST_DATABASE_URL` for `npm test` |
| `tests/helpers/test-db.mjs` | Per-file schema helper |
| `tests/integrations-*.test.mjs` | Tests per module |

---

### Task 1: SQL foundation (migrations, partitions, CI database)

**Files:**
- Create: `migrations/001_integrations.sql`, `scripts/integrations/db.mjs`, `tests/helpers/test-db.mjs`, `tests/integrations-db.test.mjs`
- Modify: `.github/workflows/docker.yml` (test step), `scripts/build.mjs` (the image runs from `dist/`: add `await cp(new URL("migrations/", root), new URL("migrations/", output), { recursive: true });` and the same for `scripts/integrations/`), `tests/server.test.mjs` or the existing build test (assert `dist/migrations/001_integrations.sql` and `dist/scripts/integrations/db.mjs` exist after `npm run build`; find where build output is tested with `grep -rn "dist/" tests`)

**Interfaces:**
- Produces: `createDatabase(connectionString, { schema?, max?, log? }) → { pool, transaction(work), migrate() → string[], ensureEventPartitions({ months = 2, now = new Date() }) → string[], close() }`; `transaction(work)` runs `work(client)` inside BEGIN/COMMIT and rolls back on throw.
- Produces (test helper): `testDatabase(t) → Promise<db | null>` creating schema `t_<random hex>` in `PORTAL_TEST_DATABASE_URL`, running `migrate()`, and dropping the schema `CASCADE` in `t.after`; `null` when the variable is unset. Asserts the database name is `agora_portal_test`.

- [ ] **Step 1: Write the migration** `migrations/001_integrations.sql`:

```sql
-- Portal's record of registered Stations and integrations (spec §3.3, §3.6, D19). Auth decides who may get tokens;
-- these tables are Portal's own history and the Stations' change feed. Rows are never deleted in normal operation.
SET LOCAL lock_timeout = '5s';

CREATE TABLE stations (
  id text PRIMARY KEY,                         -- Auth's Station ID
  origin text NOT NULL,
  owner_account text NOT NULL,
  report_client_id text NOT NULL UNIQUE,       -- Auth's s-… report client
  status text NOT NULL CHECK (status IN ('active', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL,
  removed_at timestamptz
);
CREATE UNIQUE INDEX stations_active_origin_idx ON stations (origin) WHERE status = 'active';
CREATE INDEX stations_owner_idx ON stations (owner_account);

CREATE TABLE station_members (
  station_id text NOT NULL REFERENCES stations (id),
  account_id text NOT NULL,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by text,
  PRIMARY KEY (station_id, account_id, added_at)
);
CREATE UNIQUE INDEX station_members_current_idx ON station_members (station_id, account_id) WHERE removed_at IS NULL;
CREATE INDEX station_members_account_idx ON station_members (account_id) WHERE removed_at IS NULL;

CREATE TABLE station_challenges (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  origin text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX station_challenges_account_idx ON station_challenges (account_id, created_at);

CREATE TABLE integrations (
  id text PRIMARY KEY,                         -- Auth's i-… client ID
  owner_account text NOT NULL,
  station_id text NOT NULL REFERENCES stations (id),
  kind text NOT NULL CHECK (kind IN ('custom_app')),
  name text NOT NULL,
  scopes text[] NOT NULL,
  state text NOT NULL CHECK (state IN ('awaiting_approval', 'provisioning', 'waiting_for_host', 'ready', 'paused', 'revoking', 'revoked')),
  resume_state text CHECK (resume_state IN ('awaiting_approval', 'provisioning', 'waiting_for_host', 'ready')),
  r9_svc text CHECK (r9_svc ~ '^[0-9a-f]{64}$'),
  quota_per_second integer NOT NULL CHECK (quota_per_second BETWEEN 1 AND 10000),
  expires_at timestamptz NOT NULL,
  approved_by text,
  approved_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integrations_owner_idx ON integrations (owner_account, created_at);
CREATE INDEX integrations_station_idx ON integrations (station_id);

-- Every change to a Station, its sharing or an integration, kept forever. Also the Stations' change feed: rows are
-- appended under one advisory lock (repository.appendEvent), so id order is commit order and a cursor never skips.
CREATE SEQUENCE integration_events_seq AS bigint;
CREATE TABLE integration_events (
  id bigint NOT NULL DEFAULT nextval('integration_events_seq'),
  at timestamptz NOT NULL DEFAULT now(),
  station_id text NOT NULL,
  integration_id text,
  account_id text NOT NULL,                    -- the object's owner, or the member added or removed
  actor text NOT NULL,                         -- an ab… account, 'station' (a Station report) or 'system'
  kind text NOT NULL CHECK (kind ~ '^[a-z0-9_]{2,40}$'),
  state text,
  reason text,
  details jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
ALTER SEQUENCE integration_events_seq OWNED BY integration_events.id;
CREATE INDEX integration_events_station_idx ON integration_events (station_id, id);
CREATE INDEX integration_events_integration_idx ON integration_events (integration_id, at);
CREATE INDEX integration_events_account_idx ON integration_events (account_id, at);
CREATE TABLE integration_events_default PARTITION OF integration_events DEFAULT;
```

- [ ] **Step 2: Write `scripts/integrations/db.mjs`**, modelled on Auth's `src/db.mjs` (read it: `~/Dev/Agora.Build/Auth/src/db.mjs` lines 1–56, and `ensureAuditPartitions` in `~/Dev/Agora.Build/Auth/src/integrations.mjs` lines 398–418):
  - schema name must match `/^[a-z_][a-z0-9_]{0,62}$/`; pool `options` = `"-c statement_timeout=30000" + (schema ? " -c search_path=" + schema : "")`; `pool.on("error")` logs `"Portal database pool error."`.
  - `migrate()`: files in `../../migrations/` named `^\d{3}_[a-z0-9_]+\.sql$` (else throw), sorted, applied once each inside one transaction under `pg_advisory_xact_lock(hashtext('agora_portal_migrations'))`, recorded in `portal_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`. Returns the names applied.
  - `ensureEventPartitions({ months = 2, now = new Date() })`: for this UTC month and the next `months - 1`, under `pg_advisory_xact_lock(hashtext('portal_event_partitions'))` and `SET LOCAL lock_timeout = '5s'`: skip if `to_regclass(name)` exists; else `CREATE TABLE <name> (LIKE integration_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`, move rows of that month out of `integration_events_default` into it, `ALTER TABLE integration_events ATTACH PARTITION <name> FOR VALUES FROM ('<start ISO>') TO ('<end ISO>')`. Names and bounds come only from dates. Returns names created.
- [ ] **Step 3: Write `tests/helpers/test-db.mjs`** (Interfaces above). Uses `pg` directly for `CREATE SCHEMA` / `DROP SCHEMA … CASCADE`.
- [ ] **Step 4: Write `tests/integrations-db.test.mjs`** (all skipped when `testDatabase(t)` is null):
  - `migrate()` applies `001_integrations.sql` once; a second call returns `[]`; two concurrent `migrate()` calls on two `createDatabase` instances for the same schema both succeed and the migration is recorded once.
  - `ensureEventPartitions({ now: new Date("2026-10-24T00:00:00Z") })` returns `["integration_events_y2026m10", "integration_events_y2026m11"]`; again returns `[]`.
  - A row inserted with `at = '2026-12-05'` before the December partition exists lands in the default partition; `ensureEventPartitions({ now: new Date("2026-12-01T00:00:00Z") })` creates `integration_events_y2026m12` and the row is now in it (`SELECT tableoid::regclass`), and not in the default.
  - `transaction` rolls back on throw (insert then throw; row absent).
  - Check constraints: `integrations.state = 'expired'` is refused; `r9_svc` of 63 hex is refused.
- [ ] **Step 5: Run** `node --test tests/integrations-db.test.mjs` with `PORTAL_TEST_DATABASE_URL` set → PASS; and without it → skipped, not failed.
- [ ] **Step 6: CI** — in `.github/workflows/docker.yml` job `build`, add a service:

```yaml
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: portal-ci-only
          POSTGRES_DB: agora_portal_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 10
```

and on the `Run tests` step `env: PORTAL_TEST_DATABASE_URL: postgres://postgres:portal-ci-only@localhost:5432/agora_portal_test`. (The Dockerfile copies `dist/`, so the `build.mjs` change is what puts the migrations in the image; `.dockerignore` does not exclude them.) `db.mjs` resolves the migrations directory as `new URL("../../migrations/", import.meta.url)`, which is right both in the repo and in `dist/`.
- [ ] **Step 7: Run** `npm test` → all pass. **Commit** `Add Portal SQL migrations and the integration tables`.

---

### Task 2: Auth management client and token exchange

**Files:**
- Create: `scripts/integrations/auth-manage.mjs`, `tests/integrations-auth-manage.test.mjs`
- Modify: `scripts/idp.mjs` (add `exchangeForStation`), `tests/idp.test.mjs` (exchange tests)

**Interfaces:**
- Produces: `class ManageError extends Error { status; code }` (`code` is Auth's `error` string, or `"unavailable"` for network failure/timeout/5xx without JSON, or `"bad_response"` for an unparsable 2xx).
- Produces: `createManageClient({ issuer, clientId, clientSecret, request = fetch, timeoutMs = 10000 }) → {`
  - `registerStation({ origin, owner, reportKey, actor }) → { id, origin, owner, status, reportClientId }`
  - `stations(account) → [{ id, origin, owner, status, reportClientId, createdAt }]`
  - `removeStation(id, actor) → void`
  - `members(id, actor) → { owner, members: [{ account, addedAt }] }`
  - `addMember(id, account, actor) → void`, `removeMember(id, account, actor) → void`
  - `createIntegration({ owner, stationId, name, scopes, publicJwk, r9Svc?, quotaPerSecond?, expiresAt?, actor }) → { clientId, status, expiresAt }`
  - `integrations(account) → [integration]` (Auth's shape: `{ clientId, kind, owner, stationId, name, scopes, r9Svc, quotaPerSecond, status, expiresAt, createdAt }`)
  - `addKey(id, publicJwk, actor) → { kid, overlapEndsAt }`
  - `changeIntegration(id, { status?, r9Svc?, quotaPerSecond?, expiresAt? }, actor) → integration`
  - `}`
- Produces (idp.mjs): `idp.exchangeForStation(idToken, origin) → { accessToken, expiresIn }`; throws `TokenError(503, "unavailable")` when Auth is unreachable, `TokenError(401, "<auth error code>")` when Auth refuses (`invalid_grant`, `invalid_target`, `unauthorized_client`, …).

- [ ] **Step 1: Tests first** (`tests/integrations-auth-manage.test.mjs`) with a stub `request(url, options)` that records calls and returns `Response` objects:
  - Basic header is `base64(formEncode(clientId) + ":" + formEncode(clientSecret))` where `formEncode` is `encodeURIComponent` with `%20` → `+` (RFC 6749 §2.3.1); test with a secret containing `+`, `:` and a space.
  - URLs: base is `<issuer>/manage/v1` (issuer without trailing slash); `stations(account)` → `GET …/stations?account=<id>`; `removeStation` → `DELETE …/stations/<id>?actor=<id>`; `addMember` → `PUT …/stations/<id>/members/<account>?actor=<id>`; path segments are `encodeURIComponent`-ed; `changeIntegration` → `PATCH …/integrations/<id>` with JSON body including `actor`.
  - JSON bodies are sent with `Content-Type: application/json; charset=utf-8`; GET/DELETE/PUT send no body.
  - `201`/`200` JSON parsed; `204` → `undefined`.
  - `{ error: "forbidden" }` with 403 → `ManageError` status 403 code `forbidden`; message never contains the request body or the secret.
  - `request` rejecting (network) or aborting after `timeoutMs` → `ManageError` status 503 code `unavailable`; a 500 with non-JSON body → status 503 code `unavailable`.
  - Constructor throws `TypeError` when `issuer` is not an http(s) origin, `clientSecret` shorter than 32, or `clientId` empty.
- [ ] **Step 2: Implement** `auth-manage.mjs` to pass. One internal `call(method, path, { query, body })`. `AbortSignal.timeout(timeoutMs)`.
- [ ] **Step 3: Exchange tests** in `tests/idp.test.mjs` using the existing fake IdP helper's `tokenResponse(fn)` hook if it can see the grant type; if the fake rejects non-`authorization_code` grants before the hook (it does: `if (body.get("grant_type") !== "authorization_code") return fail(...)`), extend `tests/helpers/fake-idp.mjs` so that check is skipped when `customToken` is set. Cases: request body has `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<id token>`, `subject_token_type=urn:ietf:params:oauth:token-type:id_token`, `resource=<origin>`, `scope=station.read`, client authenticated with Basic; a success returns `{ accessToken, expiresIn }`; `{ error: "invalid_target" }` 400 → `TokenError` 401 reason `invalid_target`; IdP down → `TokenError` 503; a success whose `issued_token_type` is not `urn:ietf:params:oauth:token-type:access_token` or whose `access_token` is missing → `TokenError` 401 reason `response`.
- [ ] **Step 4: Implement** `exchangeForStation` in `scripts/idp.mjs` with a direct `clientRequest` POST to the discovered `token_endpoint` (via the existing `discover()`; `null` → `TokenError(503, "unavailable")`), Basic credentials encoded as in Step 1, `Content-Type: application/x-www-form-urlencoded`. Do not use openid-client for this grant.
- [ ] **Step 5: Run** both test files → PASS; `npm test` → PASS. **Commit** `Add the Auth management client and station.read token exchange`.

---

### Task 3: Proof of control and the safe Station fetch

**Files:**
- Create: `scripts/integrations/proof.mjs`, `tests/integrations-proof.test.mjs`

**Interfaces:**
- Produces: `stationOrigin(value) → string` (normalised origin) or throws `AppError(400, "Enter the Station's address as https://host, without a path.")`. Accepts only `https:`, no username/password, path `/` or empty, no query, no fragment, no trailing characters; returns `new URL(value).origin` and requires `value === origin` or `value === origin + "/"`. Hostname must contain a dot and not be an IP literal.
- Produces: `blockedAddress(address, family) → boolean` — true for IPv4 `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`, `255.255.255.255`; IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, and IPv4-mapped `::ffff:a.b.c.d` checked as IPv4.
- Produces: `createStationFetch({ allowPrivate = false, lookup = dns.lookup, timeoutMs = 5000, maxBytes = 1024 }) → { get(url) → { status, body }, post(url, json) → { status } }` — uses `node:https` `request` with `lookup` wrapped so every resolved address is checked with `blockedAddress` (error `"blocked_address"`), `redirect` never followed (a 3xx is just a status), response body read up to `maxBytes + 1` then aborted (`"too_large"`), whole request aborted at `timeoutMs` (`"timeout"`). Errors are `ProofError` with `reason` in `blocked_address | timeout | too_large | network`.
- Produces: `checkProof(origin, value, { fetch }) → { ok: true } | { ok: false, reason }` where reason is `status_<code>`, `mismatch`, or a `ProofError` reason. Fetches `origin + "/.well-known/agora-build-station"`. Body equal to `value` or `value + "\n"` passes; anything else (`value + "\r\n"`, `" " + value`, `value + "\n\n"`) is `mismatch`.
- Produces: `class ProofError extends Error { reason }`.

- [ ] **Step 1: Tests first.** `stationOrigin`: accepts `https://station.example`, `https://station.example/`, `https://Station.Example` (→ lower case), `https://station.example:8443`; refuses `http://…`, `https://station.example/path`, `https://station.example?x`, `https://station.example#f`, `https://u:p@station.example`, `https://localhost`, `https://10.0.0.1`, `https://[::1]`, `""`, non-strings, length > 300. `blockedAddress`: a table of each range edge (e.g. `172.15.255.255` false, `172.16.0.0` true, `100.63.255.255` false, `100.64.0.1` true, `::ffff:127.0.0.1` true, `2001:db8::1` false, `fd00::1` true, `8.8.8.8` false).
- [ ] **Step 2: Fetch tests** against a local `https.createServer` with a self-signed certificate generated in the test (use `node:crypto` `generateKeyPairSync` plus a minimal certificate is not available built-in — instead inject `allowPrivate: true` and an `https.Agent({ rejectUnauthorized: false })`-equivalent option `agent` for tests only, and start the server with a test certificate committed under `tests/fixtures/tls/` generated once by `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj /CN=station.test` — test-only, never used elsewhere). Cases: 200 exact body → ok; trailing `\n` → ok; `\r\n` → mismatch; 302 with `Location` → `status_302` and the redirect target is never requested; body of 2000 bytes → `too_large`; a server that never answers → `timeout` within ~`timeoutMs` (use `timeoutMs: 200`); with `allowPrivate: false`, a `lookup` stub returning `127.0.0.1` → `blocked_address` and no connection is made (server sees no request). `post` sends JSON and returns the status, same safety.
- [ ] **Step 3: Implement** to pass. `createStationFetch` options also accept `agent` (tests only; production passes none). Use `servername` = hostname for SNI.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS. **Commit** `Check Station proof of control over a safe HTTPS fetch`.

---

### Task 4: Lifecycle state machine

**Files:**
- Create: `scripts/integrations/states.mjs`, `tests/integrations-states.test.mjs`

**Interfaces:**
- Produces: `STATES = ["awaiting_approval", "provisioning", "waiting_for_host", "ready", "paused", "revoking", "revoked"]`.
- Produces: `effectiveState(row, now) → state | "expired"` — `"expired"` when `row.state` is not `revoking`/`revoked` and `row.expiresAt <= now`.
- Produces: `transition(row, event, now) → { state, resumeState }` or throws `AppError(409, "<sentence>")` with `details: { code: "invalid_state" }`. `row` = `{ state, resumeState, expiresAt }`. Events and their rules:

| Event | From | To |
| --- | --- | --- |
| `approve` (native manager, Astation) | `awaiting_approval` | `provisioning` |
| `report:waiting_for_host` (Station) | `provisioning`, `ready` | `waiting_for_host` |
| `report:ready` (Station) | `provisioning`, `waiting_for_host` | `ready` |
| `report:revoked` (Station: R9 removal done) | `revoking` | `revoked` |
| `pause` | `awaiting_approval`, `provisioning`, `waiting_for_host`, `ready` | `paused`, `resumeState` = from |
| `resume` | `paused` | `resumeState` (then `resumeState` = null) |
| `revoke` | `awaiting_approval` | `revoked` (nothing was granted in R9) |
| `revoke` | `provisioning`, `waiting_for_host`, `ready`, `paused` | `revoking` |
| `revoke` | `revoking`, `revoked` | unchanged (idempotent) |
| `renew` | any but `revoking`/`revoked` | unchanged state |

  A Station report while `paused` updates `resumeState` instead (`report:ready` while paused with resumeState `provisioning` → state stays `paused`, resumeState `ready`), following the same From rules applied to `resumeState`. `approve`, `pause`, `resume` on an expired row (effectiveState `expired`) throw 409 `expired`, except `revoke` and `renew`, which are allowed.
- Produces: `REPORT_STATES = ["waiting_for_host", "ready", "revoked"]`.

- [ ] **Step 1: Tests first**: every row of the table, every illegal pair (generate the cross product of STATES × events and assert the allowed set exactly), paused report handling, expired handling, idempotent revoke.
- [ ] **Step 2: Implement**; **Step 3: Run** → PASS. **Commit** `Add the integration lifecycle state machine`.

---

### Task 5: Repository (SQL)

**Files:**
- Create: `scripts/integrations/repository.mjs`, `tests/integrations-repository.test.mjs`

**Interfaces:**
- Consumes: `createDatabase` (Task 1), `transaction(client => …)`.
- Produces: `createRepository(db)` with these methods. Every method takes an optional `client` last argument to run inside a caller's transaction; without one it uses the pool. Rows are returned camelCased (`ownerAccount`, `reportClientId`, `createdAt` as ISO strings, `expiresAt` ISO, `scopes` arrays).
  - Challenges: `createChallenge({ id, accountId, origin, value, expiresAt })`, `takeChallenge(id, accountId, now) → { origin, value } | null` (atomically sets `used_at` where unused, unexpired and owned by the account; `UPDATE … RETURNING`).
  - Stations: `insertStation({ id, origin, ownerAccount, reportClientId, verifiedAt })` (idempotent on `id`: `ON CONFLICT (id) DO NOTHING`), `station(id)`, `stationByReportClient(clientId)` (active only), `stationsFor(accountId)` (active, owned or current member, oldest first, with `role: "owner" | "member"`), `markStationRemoved(id, now)`.
  - Members: `addMember(stationId, accountId, addedBy, now)` (no-op if current), `removeMember(stationId, accountId, removedBy, now) → boolean`, `currentMembers(stationId)`.
  - Integrations: `insertIntegration({ id, ownerAccount, stationId, kind, name, scopes, quotaPerSecond, expiresAt })` (state `awaiting_approval`, idempotent on id), `integration(id)`, `integrationForUpdate(id, client)` (`SELECT … FOR UPDATE`), `integrationsFor(accountId)` (owned, oldest first), `integrationsOnStation(stationId)`, `updateIntegration(id, fields, client)` where fields ⊆ `{ state, resumeState, r9Svc, quotaPerSecond, expiresAt, approvedBy, approvedAt, lastError }`, always setting `updated_at = now()`.
  - Events: `appendEvent({ stationId, integrationId?, accountId, actor, kind, state?, reason?, details? }, client)` — takes `pg_advisory_xact_lock(hashtext('portal_integration_events'))` first (requires a transaction client; throws if called without one), returns `{ id, at }`. `changesSince(stationId, cursor, limit = 500) → [{ id, at, integrationId, kind, state, reason, details }]` with `id > cursor`, ordered by id. `eventsFor(integrationId, limit = 100)` newest first. `latestCursor(stationId) → number` (0 when none).
- Ids: `bigint` columns come back from `pg` as strings; return event `id` as a JS number (safe below 2^53) and accept cursors as non-negative integers.

- [ ] **Step 1: Tests first** with `testDatabase(t)` (skip when null): each method's happy path; `takeChallenge` is single-use (second call null), refuses another account, refuses expired; `stationsFor` returns owner and member roles and excludes removed Stations and removed members; `addMember` twice keeps one current row; remove then add again creates a second history row; `appendEvent` without a transaction throws; **feed ordering**: two concurrent transactions each appending one event, where the first-started commits last (hold it open with a promise), yield ids such that `changesSince(station, 0)` after both commit lists them in commit order and a reader that read after the first commit with cursor = that id still sees the second (i.e. no skipped ids); `changesSince` honours `limit` and only returns its Station's rows.
- [ ] **Step 2: Implement**; **Step 3: Run** → PASS. **Commit** `Add the Stations and integrations repository`.

---

### Task 6: Stations service (register, list, share, remove, read token)

**Files:**
- Create: `scripts/integrations/service.mjs` (Stations half), `tests/integrations-stations.test.mjs`
- Modify: `scripts/store.mjs` (`sessionIdToken(token) → string | null`: the ID token of the account session for this cookie token, null for guests/none), `tests/store-identity.test.mjs` (a test for it)

**Interfaces:**
- Consumes: repository (Task 5), `ManageError`/manage client (Task 2), `stationOrigin`, `checkProof`, `createStationFetch` (Task 3), `idp.exchangeForStation` (Task 2).
- Produces: `createIntegrationService({ repository, db, manage, stationFetch, exchange, now = Date.now, log = () => {}, ids = randomUUID, challengeValue = () => randomBytes(32).toString("base64url") })` returning (this task):
  - `createChallenge(accountId, originInput) → { challengeId, origin, value, url, expiresAt }` — `url` = `origin + "/.well-known/agora-build-station"`, valid 10 minutes; at most 10 challenges per account per hour (count rows; 429 `"Too many Station checks. Try again later."`).
  - `registerStation(accountId, { challengeId, reportKey }) → station view` — `takeChallenge` (null → 400 `"This check has expired or was already used. Start again."`, code `challenge`); `checkProof` (not ok → 422 `"The Station did not serve the check value at <url>."` code `proof`, `details.reason` = proof reason); `manage.registerStation({ origin, owner: accountId, reportKey, actor: accountId })`; then in one transaction `insertStation` + `appendEvent({ kind: "station_registered", actor: accountId, accountId, stationId })`. `reportKey` must be a plain object (≤ 4 KB JSON) — Auth validates the key itself.
  - `stations(accountId) → { stations: [view], stale: boolean }` — calls `manage.stations(accountId)`; for each Auth Station missing in Portal, `insertStation` (verifiedAt = Auth `createdAt`) + event `station_reconciled` actor `system`; for each Portal Station of this account (owned) active in Portal but absent from Auth's list, `markStationRemoved` + revoke its integrations in Portal (state `revoked`, event `station_removed` reason `reconciled`); returns Portal's `stationsFor`. If Auth answers `ManageError` 503, returns Portal's rows with `stale: true`.
  - `members(accountId, stationId)` → Auth `members` (authoritative), shaped `{ owner, members: [{ account, addedAt }] }`.
  - `share(accountId, stationId, memberAccount)` — `memberAccount` must match `ACCOUNT_ID` from `scripts/store.mjs` and differ from the owner; Auth `addMember`, then Portal `addMember` + event `member_added` (accountId = member).
  - `unshare(accountId, stationId, memberAccount)` — Auth `removeMember` (owner, or the member themself); then in one transaction Portal `removeMember`, every non-revoked integration of that member on the Station → `transition(…, "revoke")` with event `integration_revoked` reason `member_removed`, and event `member_removed`.
  - `removeStation(accountId, stationId)` — Auth `removeStation`; then in one transaction `markStationRemoved`, every non-revoked integration → revoked-or-revoking per `transition`, events `integration_revoked` reason `station_removed` and `station_removed`.
  - `readToken(accountId, idToken, stationId) → { accessToken, expiresIn, origin }` — Station must be in `stationsFor(accountId)`; `idToken` null → 401 `"Sign in again to read this Station's details."`; `exchange(idToken, origin)`; `TokenError` 401 → 403 `"Auth did not allow reading this Station."` code `exchange`, 503 → 503.
  - Station view: `{ id, origin, role, ownerAccount, status, createdAt }` (never `reportClientId` to members; owners see it, it is not secret but members need not).
  - `ManageError` mapping (shared helper `fromManage(error)`): 400 → 400 `"Auth refused this request."` code = Auth code; 403 → 403 `"Only the Station owner can do this."` code `forbidden`; 404 → 404 `"This Station or integration was not found."`; 409 `origin_taken` → 409 `"This Station is already registered."`; 409 `revoked` → 409 `"This integration has been revoked."`; 409 `duplicate_key` → 409 `"This key is already registered."`; 503/`unavailable`/500 → 503 `"Auth is unavailable. Try again shortly."`. Each `AppError` carries `details: { code }`.
- [ ] **Step 1: Tests first** with `testDatabase(t)` and a fake manage client (an in-memory object implementing the Task 2 interface with the Auth actor rules from `integrating.md`'s table, plus a switch to make it answer 503), a fake `stationFetch` whose `get` returns a configured `{ status, body }`, and a fake exchange. Cases: full registration; a reused or expired or other account's challenge; proof mismatch; Auth `origin_taken`; Portal insert failing after Auth success (inject a repository whose `insertStation` throws once) followed by `stations()` reconciling it; Auth down → `stale: true`; share/unshare (owner; member removing themself; a stranger gets 403 from the fake Auth and Portal changes nothing); unshare revokes that member's integrations in Portal with reason `member_removed` (seed one via repository); removeStation revokes all; readToken happy path, not a member → 404, exchange refused → 403, no idToken → 401; the challenge rate limit.
- [ ] **Step 2: Implement**; **Step 3: Run** → PASS; `npm test` → PASS. **Commit** `Register, share and remove Stations with proof of control`.

---

### Task 7: Integrations service (create, approve, rotate, pause, resume, revoke, renew, settings)

**Files:**
- Modify: `scripts/integrations/service.mjs` (integrations half)
- Create: `tests/integrations-service.test.mjs`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6 (`fromManage`).
- Produces (added to the service object):
  - `createIntegration(accountId, { stationId, name, scopes, publicJwk, quotaPerSecond = 200, expiresInDays = 30 })` — `name` 1–80 chars after trim, no control characters; `scopes` an array of unique strings from `agent.view`, `agent.prompt`, `agent.approve`, `agent.interrupt`, `agent.terminal`, `agent.view` added if missing; `expiresInDays` integer 1–90; Station must be in `stationsFor(accountId)` (else 404). `publicJwk` must be a plain object without `d`, `p`, `q`, `dp`, `dq`, `qi`, `k` (400 `"Send only the public key."` code `private_key`) — Auth checks the rest. Auth `createIntegration({ owner: accountId, stationId, name, scopes, publicJwk, quotaPerSecond, expiresAt, actor: accountId })`, then in one transaction `insertIntegration` (expiresAt from Auth's answer) + event `integration_created` (state `awaiting_approval`, details `{ scopes, name }`). Returns the integration view.
  - `integrations(accountId) → { integrations: [view], stale }` — Auth `integrations(accountId)`; reconcile: missing in Portal → insert (state `awaiting_approval`, event `integration_reconciled`); Auth `revoked` and Portal not `revoking`/`revoked` → `transition(revoke)` + event `integration_revoked` reason `reconciled`; Auth `paused` and Portal not `paused` → `pause` + event; Auth `active` and Portal `paused` → `resume` + event; Portal `expiresAt`/`quotaPerSecond`/`r9Svc` follow Auth's. Auth down → Portal rows, `stale: true`.
  - `approve(accountId, integrationId, { r9Svc })` — the caller is a native app with `integrations:approve` for the owner; must be the owner (else 404); `r9Svc` `/^[0-9a-f]{64}$/`; `transition(approve)` checked before calling Auth; Auth `changeIntegration(id, { r9Svc }, accountId)`; then transaction: `updateIntegration({ state, r9Svc, approvedBy: accountId, approvedAt })` + event `integration_approved`.
  - `pause`, `resume`, `revoke(accountId, id)` — owner, or for `pause`/`revoke` the Station owner (Auth enforces too); Auth `changeIntegration(id, { status: "paused" | "active" | "revoked" })`; transaction with `integrationForUpdate`, `transition`, update, event `integration_paused` / `integration_resumed` / `integration_revoked` (reason `owner` or `station_owner`).
  - `renew(accountId, id, { expiresInDays })` — 1–90; Auth `changeIntegration(id, { expiresAt })`; Portal `expiresAt` from Auth's answer; event `integration_renewed`.
  - `settings(accountId, id, { quotaPerSecond })` — 1–10000; Auth change; event `integration_settings_changed` details `{ quotaPerSecond }`.
  - `rotateKey(accountId, id, { publicJwk })` — same private-member check; Auth `addKey`; event `integration_key_added` details `{ kid, overlapEndsAt }`; returns `{ kid, overlapEndsAt }`.
  - `history(accountId, id) → { events }` — owner or Station owner; `eventsFor` newest first; each `{ at, kind, state, reason, actor }` (actor shown as `"you"` when it equals accountId, else the raw value).
  - Integration view: `{ id, kind, name, stationId, stationOrigin, scopes, state: effectiveState(...), pausedFrom: resumeState, r9Svc, quotaPerSecond, expiresAt, approvedAt, lastError, createdAt, role: "owner" | "station_owner" }`. `integrations(accountId)` also includes integrations on Stations the account owns (role `station_owner`), so a Station owner can pause or revoke them.
  - Every successful change after the transaction calls `notify(stationId)` (Task 8 provides it; in this task accept an injected `notify = () => {}` option and call it).
- [ ] **Step 1: Tests first** with `testDatabase(t)` and the fake manage client from Task 6 (move it to `tests/helpers/fake-manage.mjs` here and make Task 6's tests import it). Cases: create (default scopes get `agent.view`, defaults 200/30 days, private member refused, a Station the account cannot use → 404, Auth `scopes` error → 400 code `scopes`); approve (wrong state 409, bad r9Svc 400, not owner 404, success → `provisioning`, event, notify called with the Station id); pause/resume round trip restores the prior state; revoke from `awaiting_approval` → `revoked`, from `ready` → `revoking`; revoke twice is idempotent; a Station owner (another account) pausing and revoking someone's integration works, a stranger gets 403 from Auth and Portal is unchanged; renew > 90 → 400, renew an expired integration works and the view is no longer `expired`; settings; rotateKey returns Auth's kid; reconcile cases (Auth revoked, Auth paused, Auth active while Portal paused, missing in Portal); Auth down → `stale`; history ordering and actor display.
- [ ] **Step 2: Implement**; **Step 3: Run** → PASS; `npm test` → PASS. **Commit** `Create, approve and manage integrations through Auth`.

---

### Task 8: Station reports, change feed and push nudge

**Files:**
- Modify: `scripts/integrations/service.mjs`
- Create: `tests/integrations-reports.test.mjs`

**Interfaces:**
- Consumes: repository `stationByReportClient`, `changesSince`, `latestCursor`; `transition`; `stationFetch.post`.
- Produces (service):
  - `report(clientId, { integrationId, state, reason? })` — Station = `stationByReportClient(clientId)` (null → 403 `"This Station is not registered."` code `station`); integration must be on that Station (else 404 — never reveal integrations of other Stations); `state` ∈ `REPORT_STATES`, or `state: "error"` with `reason` (1–200 printable chars) which sets `lastError` without a state change; otherwise `transition("report:" + state)`; a report repeating the current state (or current `resumeState` while paused) is a no-op `200` with no event. Transaction: update (clears `lastError` on a successful transition) + event `integration_reported` actor `station`, state, reason. Returns the integration view (no `role`).
  - `changes(clientId, cursor) → { changes: [{ id, at, integrationId, kind, state, reason }], cursor, integrations?: [...] }` — `cursor` integer ≥ 0 (else 400); `changesSince(station, cursor, 500)`; returned `cursor` = last id, or the given cursor when empty. With `cursor = 0` the answer also includes `integrations`: the current state of every integration on the Station (`{ id, state, scopes, r9Svc, expiresAt, quotaPerSecond }`), so a Station starting fresh has a snapshot. Each change item also carries the integration's current `{ state, scopes, r9Svc, expiresAt, quotaPerSecond }` under `integration` when `integrationId` is set.
  - `notify(stationId)` — fire-and-forget: at most one push in flight per Station; a later notify while one is in flight sets a flag to push once more after it ends. POST `origin + "/agora-build/v1/changes"` with `{ cursor: latestCursor(stationId) }` through `stationFetch.post` (same SSRF rules, 3 s timeout). Result logged only on failure as `"Station change push failed: <reason>."`. Never throws. **The push carries no authority**: the Station must poll the feed with its own token to learn anything.
- Wire `notify` as the default for Task 7's injected option.
- [ ] **Step 1: Tests first** with `testDatabase(t)`: report from an unknown or removed Station's client → 403; about an integration on another Station → 404; `provisioning` → `waiting_for_host` → `ready`; `ready` directly from `awaiting_approval` → 409 (Portal never jumps approval); report while paused updates `pausedFrom`; repeat report is a no-op with no new event; `error` sets `lastError` and the next successful transition clears it; `revoked` from `revoking`; feed: events from Tasks 6–7 flows on Station A are listed for A's client only, cursor paging with limit, cursor 0 includes the snapshot, bad cursor 400; notify: posts to the right URL with the latest cursor, coalesces three rapid calls into at most two posts, a failing post is logged by reason and does not throw.
- [ ] **Step 2: Implement**; **Step 3: Run** → PASS; `npm test` → PASS. **Commit** `Accept Station reports and serve the Station change feed`.

---

### Task 9: HTTP routes and server wiring

**Files:**
- Create: `scripts/integrations/routes.mjs`, `tests/integrations-routes.test.mjs`
- Modify: `scripts/serve.mjs`

**Interfaces:**
- Consumes: the service (Tasks 6–8), `store.sessionIdToken`, existing serve.mjs helpers (`body`, `limit`, `accountUser`-style checks).
- Produces: `handleIntegrations({ path, method, url, read, service, caller, versioned, portalUser, idToken, limit }) → { status, body } | null` (null = not an integration route). `portalUser()` returns the browser account ID (throws 401). `caller` is the verified bearer (`{ sub, clientId, scopes }`) or null.
- Routes (browser cookie, `/api/...`; bearer tokens refused with the existing browser-only 403 unless listed for `/api/v1`):

| Route | Service call | Notes |
| --- | --- | --- |
| `GET /api/stations` | `stations(account)` | |
| `POST /api/stations/challenges` `{ origin }` | `createChallenge` | 201 |
| `POST /api/stations` `{ challengeId, reportKey }` | `registerStation` | 201; limit `stations:<account>` 10/min |
| `GET /api/stations/<id>/members` | `members` | |
| `PUT /api/stations/<id>/members/<account>` | `share` | 204 → `{ shared: true }` 200 |
| `DELETE /api/stations/<id>/members/<account>` | `unshare` | |
| `DELETE /api/stations/<id>` | `removeStation` | |
| `POST /api/stations/<id>/read-token` | `readToken(account, sessionIdToken, id)` | limit 30/min per account |
| `GET /api/integrations` | `integrations` | |
| `POST /api/integrations` | `createIntegration` | 201; limit 20/min |
| `POST /api/integrations/<id>/keys` | `rotateKey` | 201 |
| `POST /api/integrations/<id>/pause` · `/resume` · `/revoke` | | |
| `POST /api/integrations/<id>/renew` `{ expiresInDays }` | `renew` | |
| `POST /api/integrations/<id>/settings` `{ quotaPerSecond }` | `settings` | |
| `GET /api/integrations/<id>/events` | `history` | |
| `GET /api/v1/integrations` | `integrations(caller.sub)` | bearer, scope `integrations:read` |
| `POST /api/v1/integrations/<id>/approval` `{ r9Svc }` | `approve(caller.sub, …)` | bearer, scope `integrations:approve` |
| `POST /api/v1/stations/reports` | `report(caller.clientId, …)` | bearer, scope `station.report`, `clientId` starts with `s-`; limit `reports:<clientId>` 600/min |
| `GET /api/v1/stations/changes?cursor=<n>` | `changes(caller.clientId, n)` | same checks; limit 120/min |

  Path parameters: Station IDs and integration IDs match `/^[A-Za-z0-9_-]{1,64}$/` (else 404); member accounts match `ACCOUNT_ID`.
- serve.mjs changes:
  - Construct the integration stack only when `DATABASE_URL` is set (or `options.integrations` is given — tests pass a ready service): `createDatabase`, `await migrate()` and `ensureEventPartitions()` lazily before the first integration request (a memoised `ready()` promise; failure answers 503 and retries on the next request), an hourly `ensureEventPartitions` interval (`unref`), `createManageClient` from `AUTH_ISSUER`, `PORTAL_CLIENT_ID`, `PORTAL_CLIENT_SECRET` (missing → integrations unavailable, logged by setting name), `createStationFetch()`, `exchange` = `idp.exchangeForStation`. Close the pool on server `close`.
  - Without the stack every integration route answers 503 `"Stations and integrations need the Portal database."`.
  - Bearer gating: keep `bearerRoutes` for exact routes and add `bearerPatterns = [/^POST \/api\/integrations\/[A-Za-z0-9_-]{1,64}\/approval$/]`; add `GET /api/integrations`, `POST /api/stations/reports`, `GET /api/stations/changes` to `bearerRoutes`. A helper `isBearerRoute(route)` replaces both `bearerRoutes.has(...)` checks (versioned 404 gate, caller gate, the `ensureAccount` step). `GET /api/integrations` serves both the browser (cookie) and v1 (bearer) and must check the scope only for bearers.
  - Add the new browser routes to the browser-only set via a path prefix rule in `browserRoute` (`/api/stations` and `/api/integrations` prefixes, except the bearer routes above).
  - `GET /api/me` (browser) gains `integrationsAvailable: boolean` so the page knows whether to show the sections.
- [ ] **Step 1: Tests first** (`tests/integrations-routes.test.mjs`): build on the `start()` harness pattern of `tests/routes-idp.test.mjs` (copy what is needed into the new file or a helper; do not import from another test file), passing `integrations: <service built on testDatabase + fake manage + fake fetch + fake exchange>`. Cases: file mode (no `integrations` option and no `DATABASE_URL`) → 503 on `GET /api/stations` and `GET /api/v1/integrations`; browser register flow end to end; a guest → 401; cross-origin POST → 403 (existing check); bearer on a browser route → 403; v1 `GET /api/v1/integrations` with `integrations:read` → 200, without → 403 `insufficient_scope`; approval with `integrations:approve`; report with a `station.report` token from the Station's `s-` client → 200; the same token with another `client_id` → 403; a Portal token (scope `credits`) on reports → 403 `insufficient_scope`; changes feed; the unversioned `/api/stations/reports` with a bearer → 404 pointing to `/api/v1/`; `read-token` returns the fake exchange's token; `/api/me` `integrationsAvailable`.
- [ ] **Step 2: Implement**; **Step 3: Run** → PASS; `npm test` → PASS. **Commit** `Serve the Stations and integrations API`.

---

### Task 10: Account page sections

**Files:**
- Create: `integrations.js`, `tests/integrations-page.test.mjs`
- Modify: `account.html`, `styles.css`, `scripts/serve.mjs` (`publicFiles` gains `integrations.js`), `scripts/build.mjs` (add `integrations.js` to the copied files)

**Interfaces:**
- Consumes: the browser routes of Task 9; `/api/me` `integrationsAvailable`.

- [ ] **Step 1:** In `account.html`, after section 05 / CONNECTIONS, add `<section id="stations" class="membership-section" aria-labelledby="stations-title" hidden>` (kicker `06 / STATIONS`, heading "Your relays and Stations.") and `<section id="integrations" …>` (kicker `07 / INTEGRATIONS`, heading "Apps that act for you."); renumber the statement section to `08 / STATEMENT`. Load `<script type="module" src="/integrations.js"></script>`.
- [ ] **Step 2: `integrations.js`** (plain browser module, same style as `account.js`; read it first):
  - On load: `GET /api/me`; show the sections only when signed in with an account and `integrationsAvailable`.
  - Stations: list (origin, role, created); **Add Station** form: origin → `POST /api/stations/challenges` → shows the exact value, the URL to serve it at, a Copy button and the 10-minute expiry, plus a textarea for the Station's report public key (JWK JSON) → **Verify and register** → `POST /api/stations`; errors shown in a `role="status"` line. For owners: **Share** (account ID input → PUT), member list with **Remove**, **Remove Station** behind a native `<dialog>` confirmation. A member sees **Leave** (unshare self).
  - Integrations: list (name, Station, state label, scopes, quota, expiry, last error); **Create integration**: name, Station select, scope checkboxes (`agent.view` checked and disabled), quota (default 200), expiry days (default 30, max 90), and the key: either paste a public JWK, or **Generate a key pair in this browser** — WebCrypto `generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign","verify"])`, export both as JWK, offer the private JWK as a download `<integration-name>.private.jwk.json` (Blob + object URL, revoked after click) with the note "Agora.Build never receives this file. Keep it with your app.", send only the public JWK. Never put the private key in `localStorage`, logs or the DOM beyond the download link.
  - Per integration actions: Pause/Resume, Revoke (dialog confirm), Renew (days), Quota, Rotate key (paste or generate, same as create), History (events list).
  - State labels: `awaiting_approval` "Awaiting approval in Astation", `provisioning` "Provisioning", `waiting_for_host` "Waiting for host", `ready` "Ready", `paused` "Paused", `expired` "Expired", `revoking` "Revoking", `revoked` "Revoked". A `stale: true` answer shows "Showing saved details; Auth could not be reached."
  - Station details: a **Details** button calls `POST /api/stations/<id>/read-token` and then `GET <origin>/agora-build/v1/details` with `Authorization: Bearer <token>` directly from the browser, shows the JSON's `label` and `status` if present, or "This Station does not offer details yet." on any failure. The token is kept only in a local variable.
- [ ] **Step 3: Styles** in `styles.css` using existing variables and classes (`account-card`, `inline-link`, `button-secondary`); new classes kebab-case (`station-list`, `integration-list`, `state-badge`, `state-badge--ready` …). Respect `prefers-reduced-motion` (no new animations needed).
- [ ] **Step 4: Tests** (`tests/integrations-page.test.mjs`, static checks like the existing page tests — read `tests/server.test.mjs` / `tests/front-end-signin.test.mjs` for the style): `/account/` contains both sections hidden by default with accessible names; `/integrations.js` is served with `text/javascript`; the script never references `localStorage` together with `privateKey`/`d`; it uses `crypto.subtle.generateKey`; `npm run build` copies `integrations.js` into `dist/`.
- [ ] **Step 5:** `npm test` → PASS. Manually run the server against the test database (`DATABASE_URL=$PORTAL_TEST_DATABASE_URL node scripts/serve.mjs --port 3099` is not enough without Auth; skip a live check here — Task 11's smoke covers it). **Commit** `Add Stations and integrations to the account page`.

---

### Task 11: Documentation and Station-facing contract

**Files:**
- Modify: `docs/platform.md` (new section "Stations And Integrations" before "Vox, Atem And Astation"; update "Storage And Deployment" and "Apps: IdP Access Tokens And Scopes"; "Verification" lists the new tests), `README.md` if it lists env settings

- [ ] **Step 1:** Document, in the file's existing style:
  - What needs `DATABASE_URL`; migrations run automatically; the tables and that rows are kept forever; monthly partitions.
  - Browser routes and v1 routes with scopes (`integrations:read`, `integrations:approve`, `station.report`) — note that Auth's clients file must list `integrations:read` and `integrations:approve` on the `https://agora.build` resource and grant them to `astation`, and give the Portal client `manage: true`, `exchange: true`, `stationScopes: ["station.read"]` and its back-channel logout URI.
  - **For Station builders:** proof of control (exact rules from Global Constraints); the report key (the Station generates its key pair and gives the public JWK at registration; Auth creates the `s-` client); getting a `station.report` token (`resource=<Portal origin>`, private_key_jwt as in Auth `docs/integrating.md`); `POST /api/v1/stations/reports` body and the allowed transitions; `GET /api/v1/stations/changes?cursor=` (poll every minute; cursor 0 snapshot; at most 500 per page; follow `cursor`); the push nudge `POST <origin>/agora-build/v1/changes` `{ cursor }` that carries no authority — the Station only polls in response; the browser details call `GET <origin>/agora-build/v1/details` with a `station.read` token, which the Station must allow by CORS from the Portal origin only.
  - Lifecycle states and who moves them (table from Task 4).
- [ ] **Step 2:** `npm test` → PASS. **Commit** `Document Stations and integrations`.

---

## Not in this plan (later plans)

- Account deletion with the 14-day window (needs Auth endpoints to disable, restore and finally delete accounts).
- The official Discord app (needs the Station agent API) and bring-your-own Discord (Station/Astation).
- Astation's approval UI, the Station's report client and feed polling (Astation/Station owners; this plan documents the contract).
- The per-account JSON export of integrations, events and receipts (spec §3.6); deferred, with account deletion.
- ~~Auth keying its `/manage/v1` limit by client~~ — done in Auth `d7de441` (6,000 a minute per management client; failed authentications 60 a minute per address). The same commit makes Auth refuse integration tokens until approval (`unauthorized_client`).

---

### Task 12: End-to-end check against the real Auth (Portal ↔ Auth ↔ Station)

Added by the controller (Ruling P6): the owner stressed "validation/verification between auth and station.agora.build"; the unit tests use a fake Auth. This task proves the real contract.

**Files:**
- Modify: `tests/e2e/harness.mjs` (opt-in integrations stack), `scripts/integrations/routes.mjs` only if the stack needs an injectable `stationFetch`/`pushFetch` for tests (option on `createAppServer`, never an environment switch)
- Create: `tests/e2e/integrations.e2e.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–9; Auth's `startAuth` (via the harness `lib`), Auth's `scripts/verify-station-token.mjs` (or its exported verifier) for checking Station tokens exactly as a Station would.

- [ ] **Step 1:** Harness: `startStack(lib, { integrations: true })` gives the Portal client `manage: true`, `exchange: true`, `stationScopes: ["station.read"]` (it already has a back-channel logout URI) and the API resource the scopes `station.report`, `integrations:read`, `integrations:approve`; starts the Portal with `DATABASE_URL` = a fresh schema in `PORTAL_TEST_DATABASE_URL` (dropped at close; skip with a reason when unset), and a Station fetch that may reach `127.0.0.1` and trusts the test certificate in `tests/fixtures/tls/`.
- [ ] **Step 2:** A Station stub: a local HTTPS server (test certificate) at `https://station.localhost:<port>` (resolve to 127.0.0.1 through the injected lookup) serving `/.well-known/agora-build-station` with the value it is given, recording `POST /agora-build/v1/changes`, holding its own report key pair (ES256) and verifying tokens with Auth's Station verifier (issuer, JWKS from the real Auth, `aud` = its origin).
- [ ] **Step 3: Flows** (one test each, real HTTP everywhere):
  1. A person signs in (existing helpers), requests a challenge, the stub serves it, registration succeeds; the Station is listed; Auth's `GET /manage/v1/stations?account=` lists it.
  2. The stub gets a `station.report` token from Auth with `private_key_jwt` (client `s-…` from registration, `resource` = the Portal API audience); `GET /api/v1/stations/changes?cursor=0` answers with its snapshot; a token for another resource or a Portal user token is refused.
  3. The person creates an integration with a generated ES256 key; the integration gets a client-credentials token from Auth for the Station; the stub's verifier accepts it with `sub` = the person, `client_id` = the integration, scopes as created, and `aud` = the Station; the same token is refused by the Portal's `/api/v1/` routes (wrong audience).
  4. Approval: an `integrations:approve` token (from a native client registered in the harness with those scopes, via the device flow helpers if available) approves with an `r9Svc`; the next integration token carries `r9_svc`. If a native token cannot be obtained with the harness helpers, record the gap in the report and test approval through the service directly.
  5. The stub reports `ready`; the Portal shows Ready; a report about an unknown integration is 404.
  6. Pause and revoke from the browser: the stub receives a push nudge and sees the change in the feed; Auth refuses the next integration token (`invalid_client` or as Auth answers).
  7. The browser's `read-token` for the Station returns a `station.read` token that the stub's verifier accepts (`sub` = the person); an unshared second person gets 404.
  8. Sharing: the owner shares with a second signed-in person, who can then get a `read-token`; unsharing stops it.
- [ ] **Step 4:** Run with `npm run test:e2e` (Node 22, `TEST_DATABASE_URL` and `PORTAL_TEST_DATABASE_URL` set) → PASS; `npm test` unchanged and green. **Commit** `Check Stations and integrations end to end against Auth`.
