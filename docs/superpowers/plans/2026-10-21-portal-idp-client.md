# Portal IdP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the Portal signs people in only through auth.agora.build. It drops its own provider sign-in and its
`/oauth/*` server, and its APIs accept IdP access tokens. It is proven by unit tests and by practical end-to-end tests
against the real IdP.

**Architecture:**
- A confidential OIDC client (`scripts/idp.mjs`, using `openid-client` and `jose`) creates the Portal's own cookie
  session, keyed by the IdP `sub`.
- Bearer IdP JWTs are verified locally against the IdP's JWKS.
- Back-channel logout ends Portal sessions.
- Agora Console connect becomes a separate OAuth flow.

**Tech stack:** Node 20+ (the e2e suite uses Node 22, which the Auth checkout needs), the built-in test runner,
`openid-client` 6.8.8, `jose` 6.2.12, and the existing JSON or PostgreSQL store.

**Spec:** `docs/superpowers/specs/2026-10-21-portal-idp-client-design.md`. Read it before starting any task; it is
the authority.

## Global Constraints

**Code style:**
- JavaScript: two spaces, double quotes, semicolons.
- Node scripts are `.mjs` and use only built-in modules plus the existing dependencies. **No new npm dependencies.**
- Tests: `node --test`, files `tests/*.test.mjs`. `npm test` must pass at the end of every task.

**Secrets:**
- Never print or log a secret, token, cookie value or ID token. Log reasons only.
- Never put secrets on a command line.
- Never read or print `~/.config/agora-portal/local.env` or `~/.config/agora-auth/local.env`. Name settings only.

**Cookies:**
- `__Host-house_session` on https (`house_session` over plain http): HttpOnly; `SameSite=Lax`; `Path=/`; `Secure`
  on https; 30 days.
- `__Host-portal_auth` (`portal_auth` over plain http): HttpOnly; `SameSite=Lax`; `Path=/`; 600 s.

**Fixed values:**

| Item | Value |
| --- | --- |
| Account IDs | the IdP `sub`, which matches `^acct_[0-9A-HJKMNP-TV-Z]{26}$` |
| Access tokens | `typ` `at+jwt`, ES256, `aud` includes `https://api.agora.build` (`PORTAL_API_AUDIENCE`) |
| Bearer errors | 401 `WWW-Authenticate: Bearer error="invalid_token"`; 403 `error="insufficient_scope"`; 503 when JWKS is unreachable for an unknown key |

**Unchanged:** the existing same-origin checks on non-GET cookie requests. `/auth/backchannel-logout` is the only
exemption.

**Commits:** imperative subject; the body ends with `🤖 Built with SMT <smt@agora.build>`. No co-author trailers.
Never push.

**Machine safety:** never stop or modify the containers `portal-local`, `portal-postgres`, `auth-local` or
`witness-postgres`, or the dev server on port 3002. The e2e suite uses only its own temp data and its own test
databases.

---

### Task 1: The OIDC client module and a stand-in IdP for tests

**Files:**
- Create: `scripts/idp.mjs`, `tests/helpers/fake-idp.mjs`
- Test: `tests/idp.test.mjs`

**Produces:**

`createIdp({ issuer, clientId, clientSecret, siteUrl, audience, request?, now? })` returns:

| Member | Returns |
| --- | --- |
| `config` | `{ issuer, clientId, redirectUri, postLogoutRedirectUri, accountUrl }` |
| `available()` | `boolean`: discovery succeeded; a retry runs every 30 s at most |
| `beginLogin({ returnTo })` | `{ url, transaction: { id, state, nonce, verifier, returnTo, createdAt } }` |
| `completeLogin(callbackUrl, transaction)` | `{ sub, sid, name, picture, email (verified only), idToken }`; throws `LoginError(reason)` |
| `endSessionUrl({ idToken })` | a string |
| `verifyLogoutToken(token)` | `{ sub, sid }`; throws on any invalid token |
| `verifyAccessToken(token)` | `{ sub, clientId, scopes }`; throws `TokenError` with `status` 401 or 503 |

`tests/helpers/fake-idp.mjs` provides:

```js
createFakeIdp({ issuer, clientId })
  → { request, keys,
      issueIdToken(claims, opts), issueAccessToken(claims, opts), issueLogoutToken(claims, opts),
      rotate(), setDown(bool), tokenResponse(fn) }
```

- It serves discovery, JWKS and the token endpoint through the injectable `request`.
- Its keys are ES256, generated with `jose`.

- [ ] **Step 1:** write `tests/idp.test.mjs` covering every bullet of spec §5 "Callback validation", "Back-channel
  logout" and "Bearer" that `idp.mjs` owns:
  - the wrong `typ`;
  - `alg` none or HS256;
  - the wrong `iss` or `aud`;
  - expiry;
  - key rotation refetch;
  - an unreachable JWKS gives 503;
  - the logout token checks;
  - an unverified email is dropped.

  Run it and see it fail.
- [ ] **Step 2:** implement `idp.mjs`. Use `openid-client` for discovery, the authorization URL (with PKCE S256, state
  and nonce), and the code exchange with ID token validation. Use `jose.createRemoteJWKSet` with a custom fetch
  through `request` for access and logout tokens.
- [ ] **Step 3:** run `npm test`; all pass.
- [ ] **Step 4:** commit with the subject `Add an OIDC client for auth.agora.build`.

### Task 2: Store: accounts keyed by `sub`, sessions with `sid`, transactions, and the one-time migration

**Files:**
- Modify: `scripts/store.mjs`, `scripts/persistence.mjs` (only if the version field needs it)
- Test: `tests/store-identity.test.mjs` (new); adjust any existing store test that relied on removed functions

**Produces** these store methods:
- `saveAuthTransaction(tx)`, `takeAuthTransaction(id)` (single use; expiry 600 s; capped at 1000);
- `signIn({ sub, sid, name, picture, email, idToken })` → `{ token }` (creates or refreshes the account; the session
  cap is 20);
- `ensureAccount(sub)`;
- `endSession(token)` → `{ idToken }`;
- `endSessionsBySid(sid)`, `endSessionsBySub(sub)`;
- `actor(token)` → `{ kind: "account" | "guest" | null, account?, profile? }`.

**Removed:** `login()`, `pendingLinks` and `resolvePendingLink`, `authorizationCodes`, grants, `access()`,
`sessionEpoch` and `logoutEverywhere`.

The migration is spec §3.2 exactly. Make it idempotent with `state.version = 2`.

- [ ] **Step 1:** write the tests: the migration (a v1 fixture keeps people, rooms and radar, and loses old accounts
  and their spaces, ledger, sessions, codes, grants and pending links), the session cap, the transaction's single use
  and expiry, `ensureAccount`, and ending by `sid` and by `sub`. Run them and see them fail.
- [ ] **Step 2:** implement. Update every caller of the removed functions so `npm test` passes; delete tests of
  removed behaviour (provider sign-in, pending links, `/oauth`) **only** where the spec removes that behaviour.
- [ ] **Step 3:** run `npm test`.
- [ ] **Step 4:** commit with the subject `Key Portal accounts by the IdP subject and start empty`.

### Task 3: Routes and authorisation

**Files:**
- Modify: `scripts/serve.mjs`, `scripts/spaces/routes.mjs`, `scripts/spaces/service.mjs`, `scripts/permissions.mjs`
  (only where actor or admin checks change)
- Delete: `scripts/auth.mjs`, `scripts/identity.mjs`, `integrations/agora-build-client.mjs`,
  `config/identity-clients.example.json`, and their tests
- Test: `tests/routes-idp.test.mjs` (new), using the fake IdP

**Requirements:**
- The routes in spec §3.1: `/auth/login`, `/auth/callback`, `POST /api/auth/logout`, `POST /auth/backchannel-logout`
  and `GET /api/auth/config`.
- Remove `/auth/<provider>`, `/api/auth/providers`, `/api/auth/pending-link`, `/api/auth/logout-all`, `/oauth/*` and
  `/api/identity/*`.
- The authorisation matrix in spec §3.3, exactly. Bearer tokens go through `idp.verifyAccessToken`, then
  `store.ensureAccount(sub)`.
- `PORTAL_BILLING_CLIENTS` is a comma-separated allowlist.
- When the IdP is unavailable, `/auth/login` redirects with `?signin=unavailable`.

- [ ] **Step 1:** write route tests for every row of the §3.3 matrix (browser account, guest and bearer, with and
  without the scope), the billing allowlist, the full login → callback → `/api/me` flow against the fake IdP, logout
  returning `endSessionUrl`, back-channel ending sessions, the same-origin check unchanged, and the back-channel
  exemption. Run them and see them fail.
- [ ] **Step 2:** implement and delete the old modules.
- [ ] **Step 3:** run `npm test`.
- [ ] **Step 4:** commit with the subject `Sign in through auth.agora.build and accept its access tokens`.

### Task 4: The Agora Console connect flow

**Files:**
- Modify: `scripts/connections.mjs`, `scripts/serve.mjs`
- Test: `tests/connections-connect.test.mjs` (new); update `tests/platform.test.mjs`'s Agora parts

**Requirements:** spec §3.4.
- The stand-in Agora OAuth in tests serves authorize, token and userinfo through the injectable `request`.
- Refresh uses the `AGORA_OAUTH_*` settings directly, with no dependency on the removed `auth.mjs`.

- [ ] **Step 1:** write the tests: a connect stores sealed tokens; a guest is refused; another account's transaction
  fails; disconnect works; refresh works; projects are read with a bearer token carrying `agora:projects`. Run them and
  see them fail.
- [ ] **Step 2:** implement.
- [ ] **Step 3:** run `npm test`.
- [ ] **Step 4:** commit with the subject `Connect Agora Console separately from signing in`.

### Task 5: Front end

**Files:**
- Modify: `script.js`, `account.js`, `stoa.js`, `stoa/panel.js`, `services.js`, `index.html`, `account.html` (where
  the dialogs live), `styles.css` (only if needed)
- Test: extend `tests/server.test.mjs` or the existing page test so the pages contain no removed controls (provider
  buttons, pending-link dialogs) and the account page has the "Manage sign-in" link target from `/api/auth/config`.

**Requirements:** spec §3.5.
- Keep the paper, terracotta and charcoal styling and accessible names. Use native buttons.
- Respect reduced motion.
- Check desktop and mobile widths and keyboard use with the browser smoke in Task 7.

- [ ] **Step 1:** implement.
- [ ] **Step 2:** run `npm test`.
- [ ] **Step 3:** commit with the subject `Show one sign-in through auth.agora.build`.

### Task 6: Practical end-to-end tests against the real IdP

**Files:**
- Create: `tests/e2e/idp.e2e.mjs`, `tests/e2e/harness.mjs`
- Modify: `package.json` (add `"test:e2e": "node --test tests/e2e/*.e2e.mjs"`)

**Requirements:**
- Load `startAuth`, the flow helpers and the cookie-jar browser from `${AUTH_REPO:-../Auth}/tests/helpers/`, by
  dynamic import. If the checkout or `TEST_DATABASE_URL` is missing, skip with a clear message.
- Register the clients from spec §3.6:
  - `portal`, with its back-channel URI pointing at the test Portal;
  - a `vox`-like billing client;
  - an `atem`-like native client with device code;
  - a non-allowlisted web client;
  - the IdP's sample client.

  Use an http issuer (`http://auth.localhost:<port>`) as Auth's helper supports.
- Start the real Portal server, as `scripts/serve.mjs` starts in tests, on a free port with a temp data dir and the
  IdP settings.
- Implement spec §5 "Practical end-to-end" flows 1–10 as separate tests, with real HTTP throughout. For flow 8, use
  the IdP's own key rotation (its keys module or CLI function from the Auth checkout).
- Tear everything down in `after`.

- [ ] **Step 1:** implement the harness and the flows.
- [ ] **Step 2:** run `source ~/.nvm/nvm.sh && nvm use 22`, then `npm run test:e2e` with `TEST_DATABASE_URL` set as
  Auth's own tests use it. All 10 pass. Run the suite twice.
- [ ] **Step 3:** run `npm test`; it still passes and does not include the e2e suite.
- [ ] **Step 4:** commit with the subject `Test the Portal against the real auth.agora.build`.

### Task 7: Browser smoke, docs, settings, local deployment

**Files:**
- Create: `scripts/browser-smoke.mjs` (opt-in; playwright-core and Chromium paths from the environment, as in Auth's
  script)
- Modify: `README.md`, `docs/platform.md`, `.env.example`, `AGENTS.md` (only if commands change)
- Outside the repo, local only: `~/.config/agora-portal/start.sh` (setting names only) and the Auth local clients file
  `~/.config/agora-auth/clients.json` (a non-secret registry; the `portal` entry).

**Requirements:**
- **Browser smoke:** against the local deployment (`http://localhost:3080` and `http://auth.localhost:3090`), sign in
  with the IdP's dev upstream if one is configured locally, check `/api/me`, then sign out. At desktop and mobile
  viewports, the sign-in dialog and the account page are keyboard reachable.
- **Docs:** spec §4.
- **Local wiring:**
  - Add `AUTH_ISSUER`, `PORTAL_CLIENT_ID`, `PORTAL_CLIENT_SECRET` and `PORTAL_BILLING_CLIENTS` to
    `start.sh --check`'s list of names.
  - Register the `portal` client in the Auth local clients file with `secretEnv: "PORTAL_CLIENT_SECRET"`.
  - The owner puts the same secret value in both `local.env` files. **Do not write or print secret values.**
  - Report exactly which names the owner must fill.

- [ ] **Step 1:** implement.
- [ ] **Step 2:** run `npm test`, then `npm run build` and check `dist/`.
- [ ] **Step 3:** commit with the subject `Document signing in through auth.agora.build and add a browser smoke`.
