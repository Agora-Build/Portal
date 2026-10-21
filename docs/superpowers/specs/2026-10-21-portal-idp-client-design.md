# The Portal signs in through auth.agora.build

**Status:** approved 2026-10-21, after design review in conversation. This is plan 2 of the auth.agora.build
rollout (Agora-Build/Auth, `docs/superpowers/specs/2026-10-12-auth-agora-build-design.md` §10). That spec's
decisions still stand: the Portal is a client; it starts empty; plans, credits, billing and the Agora Console
connection stay in the Portal.

## 1. Goal

Sign-in for the Portal (agora.build, including Stoa) comes only from `auth.agora.build`, over standard OIDC. The
Portal stops being an identity provider or an OAuth server. Its APIs accept the IdP's access tokens.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Client model | Confidential OIDC client `portal`: Authorization Code + PKCE (S256), state and nonce. The Portal keeps its own session cookie, keyed by the IdP `sub`. The IdP is not called per request. |
| Account ID | The IdP `sub` (`acct_…`) is the Portal account ID. `PLATFORM_ADMINS` lists `acct_…` IDs. |
| Provider sign-in in the Portal | Removed: Google, GitHub, Apple, the Agora OIDC and OAuth modes, and email linking with pending links. |
| Portal OAuth server (`/oauth/*`) | Removed in this change, along with its client registry, codes, grants and access/refresh tokens, and the identity lookup endpoint. |
| API callers | The browser uses the cookie session, with the same-origin checks unchanged. Apps and servers use `Authorization: Bearer <IdP access token>`. |
| Platform credits reserve/settle | An IdP access token with the `credits` scope, whose `client_id` is in `PORTAL_BILLING_CLIENTS` (e.g. `vox`). |
| Agora Console | A separate connect flow, `/connect/agora`: Agora OAuth used only to authorise Console access for the signed-in account. Tokens stay sealed with `AGORA_CONSOLE_ENCRYPTION_KEY`. |
| Guests | "Continue with this browser" stays for looking around: walking Stoa and appearing on the radar. Credits, services, billing, Agora Console and owning spaces need a signed-in account. |
| Login management | Linked logins, devices and sign-out everywhere live on `auth.agora.build/account`. The Portal links to it. |

## 3. Components

### 3.1 `scripts/idp.mjs`: the OIDC client

**Configuration:** `AUTH_ISSUER`, `PORTAL_CLIENT_ID` (default `portal`), `PORTAL_CLIENT_SECRET` (≥ 32 characters)
and `SITE_URL`.
- Discovery uses `openid-client` and is cached. If the IdP is unreachable at start, the Portal still starts, and
  sign-in reports itself unavailable until discovery succeeds. A retry is allowed every 30 s.
- Scopes requested: `openid profile email`.

**Login.** `GET /auth/login?returnTo=<path>`:
- `returnTo` must pass the existing same-site path allowlist.
- The transaction (state, nonce, PKCE verifier, returnTo, created) is stored in the store's `authTransactions`:
  10 minutes, at most 1000, keyed by a random ID.
- That ID goes in an HttpOnly cookie, `__Host-portal_auth` (`portal_auth` over plain HTTP), with
  `Path=/`, `SameSite=Lax` and `Max-Age=600`.
- Because the transaction is in the store, any instance can finish the sign-in, with no sticky routing.

**Callback.** `GET /auth/callback`:
- The cookie must match a live transaction, which is consumed once.
- The code is exchanged and the ID token validated (iss, aud, nonce, exp, signature).
- Then:
  - upsert the account `{id: sub, name, picture, email (only if email_verified), updatedAt}`;
  - create a Portal session `{hash, accountId, sid, expiresAt}` with the current 30-day absolute lifetime and the
    existing 20-sessions-per-account cap;
  - redirect to `returnTo` with `?signin=success`.
- Errors redirect with `?signin=failed`:
  - the IdP returned `error`;
  - the state or cookie doesn't match;
  - the token exchange failed;
  - the ID token is invalid.

  The log records the reason, never the token values.

**Logout.** `POST /api/auth/logout` (same-origin):
- deletes the Portal session;
- answers `{ endSessionUrl }`, the IdP's `end_session_endpoint` with `client_id`, `post_logout_redirect_uri`
  (`<SITE_URL>/`) and `id_token_hint`;
- the front end then navigates there.

The ID token is kept with the session for `id_token_hint`, and deleted with it.

**Back-channel logout.** `POST /auth/backchannel-logout`:
- Accepts form-encoded `logout_token`, verified against the IdP JWKS:
  - `iss` and `aud` (our client ID);
  - `iat`, and `exp` when present;
  - the back-channel `events` claim;
  - no `nonce`;
  - `sid` or `sub`.
- Deletes Portal sessions matching `sid`, or every session of `sub` when no `sid` is given.
- Answers 200 with `Cache-Control: no-store`, or 400 if the token is invalid.
- It is exempt from the same-origin check, because it is a server-to-server POST.

**Access tokens.** `verifyAccessToken(token)` uses `jose.createRemoteJWKSet(jwks_uri)`, which caches keys and
refetches on an unknown `kid`. It requires:
- `typ` `at+jwt`;
- `alg` ES256;
- `iss` = `AUTH_ISSUER`;
- `aud` containing `https://api.agora.build` (`PORTAL_API_AUDIENCE`);
- an unexpired `exp`;
- `sub`.

It returns `{ sub, clientId, scopes }`.

### 3.2 Store (`scripts/store.mjs`)

- **New:** `authTransactions`.
- **Sessions** gain `sid` and `idToken`. The ID token is not a credential that any API accepts, and it holds only what
  the account record already has. It is kept for `id_token_hint` and deleted with the session.
- **Accounts** are `{id: "acct_…", name, avatar, email, profileId, createdAt, updatedAt, …}`. Billing, ledger and
  connection fields are unchanged.
- **Removed:** `identities`, `pendingLinks`, `authorizationCodes`, `grants` and `sessionEpoch`.
- **API callers get an account automatically.** The first access token for a `sub` that has no Portal account
  creates a minimal one, `{id: sub, name: null}`, so app users get a wallet. Its name and picture fill in at their
  first browser sign-in.
- **One-time migration at load** (state version 2):
  - delete `sessions`, `authorizationCodes`, `grants`, `pendingLinks` and every account whose ID isn't `acct_…`,
    together with their ledger/billing rows and the spaces they own;
  - keep `people` (guests), `rooms` and the radar;
  - log counts only.
  - This is the spec's "starts empty". There are no production users.
- **`actor()`** resolves a Portal session to an account, or a guest profile session to a guest.

### 3.3 Routes and authorisation (`scripts/serve.mjs`)

| Route group | Browser (cookie) | Bearer IdP token |
| --- | --- | --- |
| `/api/me` | account or guest | account (`openid`-only tokens allowed) |
| credits balance and statement | account | `credits` |
| services chat and TTS | account (no guests) | `credits` |
| billing account, checkout, manage | account | not accepted |
| `/api/connections*`, Agora projects and certificates | account | `agora:projects` (certificates: `agora:certificates`) |
| platform credits reserve/settle | not accepted | `credits`, and `client_id` in `PORTAL_BILLING_CLIENTS` |
| Stoa spaces: create, own, admin | account | not accepted |
| Stoa: walk, presence, radar | account or guest | not accepted |

Bearer responses:
- missing, invalid or expired token: 401 with `WWW-Authenticate: Bearer error="invalid_token"`;
- missing scope: 403 with `error="insufficient_scope"`;
- IdP keys unreachable with an unknown `kid`: 503.

The existing same-origin checks on non-GET cookie requests are unchanged.

### 3.4 Agora Console connect (`scripts/connections.mjs`)

**Routes.** `GET /connect/agora` (signed-in account only) and `/connect/agora/callback` use Agora's OAuth (the
existing `AGORA_OAUTH_*` settings, scope `basic_info,console`):
- the transaction is stored in the store, as for sign-in, and bound to the account;
- the callback stores `{accessToken, refreshToken, expiresAt}` sealed, as today;
- it then redirects to `/account.html?connected=agora` (or `?connected=failed`).

**Other operations.** Disconnect, refresh, projects and certificates are unchanged, except that they no longer
require an Agora identity on the account.

### 3.5 Front end

**Sign-in:**
- The sign-in dialog shows one "Sign in" button (→ `/auth/login?returnTo=…`) and "Continue with this browser"
  (guest).
- The provider list and the pending-link dialogs are removed.
- `?signin=failed` shows "Sign-in didn't complete. Try again."

**Account page:**
- Shows name, picture and account ID, and a "Manage sign-in" link to `<AUTH_ISSUER>/account`.
- Keeps credits, billing, the Agora Console connect/disconnect and projects.
- "Sign out" calls logout, then follows `endSessionUrl`.
- `/api/auth/config` gives the front end `{ issuer, accountUrl }`.

**Guests** see "Sign in to use credits" where account-only features were.

### 3.6 IdP registration (in the Auth deployment's clients file; documented, not code)

The `https://api.agora.build` resource has scopes `credits`, `agora:projects` and `agora:certificates`. The
`portal` client is a first-party web client:
- redirect `https://agora.build/auth/callback`;
- post-logout `https://agora.build/`;
- back-channel `https://agora.build/auth/backchannel-logout`;
- grants `authorization_code`;
- scopes `openid profile email`.

Locally, `http://localhost:3080/...` against `http://auth.localhost:3090`. Vox and others are registered with the
resource scopes they need.

## 4. Removed settings and docs

**Removed settings:**
- `GOOGLE_*`, `GITHUB_*`, `APPLE_*`;
- `AGORA_OIDC_*`;
- `IDENTITY_CLIENTS_FILE`, `VOX_IDENTITY_*`, `ASTATION_IDENTITY_ENABLED`.

`AGORA_OAUTH_*` stays, for Console connect only.

**Added settings:**
- `AUTH_ISSUER`, `PORTAL_CLIENT_ID`, `PORTAL_CLIENT_SECRET`;
- `PORTAL_API_AUDIENCE` (default `https://api.agora.build`);
- `PORTAL_BILLING_CLIENTS`.

**Docs:**
- `docs/platform.md` is rewritten: identity → the IdP; the contract for apps (IdP tokens, scopes, billing clients).
- README and `.env.example` are updated.
- `integrations/agora-build-client.mjs` (the SDK for the old `/oauth`) is removed.
- Integrators follow Auth's `docs/integrating.md`.

## 5. Testing

**Unit and integration** (`npm test`; a stand-in IdP built with `jose` keys, discovery, token and JWKS):
- **Callback validation:** state/cookie mismatch, replayed transaction, wrong nonce/iss/aud, expired ID token, IdP
  `error`. Each gives `?signin=failed`, and no session.
- **Account upsert:** an unverified email is not stored.
- **Sessions:** the 20-per-account cap; logout returns the `end_session` URL.
- **Back-channel logout:**
  - a `sid` ends only that session; a `sub` ends all of them;
  - rejected: a forged signature, the wrong `aud`, a missing events claim, a `nonce` present.
- **Bearer:**
  - rejected: wrong `typ`, `alg` none or HS256, wrong `iss`, wrong `aud`, expired;
  - a missing scope gives 403;
  - key rotation (unknown `kid` refetches JWKS);
  - JWKS unreachable gives 503;
  - the first token for a new `sub` creates an account.
- **Billing allowlist:** a credits token from a non-allowlisted client is refused for reserve/settle.
- **Guests:** refused for credits, services, billing and connections, and owning spaces; allowed to walk Stoa and
  use the radar.
- **Agora connect** (stand-in Agora OAuth): stores sealed tokens; refuses a guest; a callback for another account's
  transaction fails.
- **Migration:** a v1 state file loses its old accounts, sessions, grants, codes and pending links, and keeps guests,
  rooms and the radar.
- **Same-origin checks:** unchanged for cookie POSTs; back-channel logout exempt.

**Practical end-to-end against the real IdP** (`npm run test:e2e`, not part of `npm test`):
- **What runs:**
  - The real auth.agora.build is loaded from a checkout of Agora-Build/Auth (`AUTH_REPO`, default `../Auth`) through
    its own test helper `startAuth()`, which uses stand-in GitHub/Google upstreams and a real PostgreSQL
    (`TEST_DATABASE_URL`).
  - The real Portal server runs on a free port, with a temp data file.
  - Clients are registered as in §3.6, plus a `vox`-like billing client, an `atem`-like native client and a
    non-allowlisted web client.
- **Flows, driven over real HTTP with a cookie-jar browser:**
  1. **Sign in:** a fresh browser on the Portal goes to the IdP sign-in with a stand-in GitHub user, back to the
     Portal, and `/api/me` shows the account `acct_…` with name and email.
  2. **SSO:** a second app (the sample client) in the same browser signs in without a login page, with the same `sub`.
  3. **Sign out:** RP-initiated logout ends the Portal session and the IdP session (the IdP account page then needs
     sign-in).
  4. **Back-channel:** "Sign out everywhere" on the IdP account page ends the Portal session through back-channel
     logout. The Portal's `/api/me` becomes a guest or 401 within the request.
  5. **Billing client:** the `vox`-like client gets a user's access token (`resource=https://api.agora.build`,
     `credits`) and reserves and settles credits at the Portal. An admin grants credits first, through the offline
     admin path.
  6. **Native app:** an `atem`-like device-code token reads `/api/me` and the credits balance; without `credits` it
     gets 403.
  7. **Billing allowlist:** a non-allowlisted client's credits token is refused for reserve/settle.
  8. **Key rotation:** after an IdP emergency rotation, the old access token is refused (unknown key after the IdP's
     JWKS drops it) and a fresh one works.
  9. **IdP down:** stopping the IdP keeps existing Portal sessions working, while a new sign-in shows the
     unavailable message.
  10. **Wrong account:** a token for account X can't read account Y's data.

**Browser smoke** (`scripts/browser-smoke.mjs`, opt-in, playwright-core like Auth's): a real Chromium clicks "Sign
in" on the local deployment, completes the IdP page with the dev upstream, returns to the Portal signed in, then
signs out.

**Local deployment check:** `portal-local` against `auth-local` (the existing local containers), with the Portal
client registered in the local clients file. The secret values are filled in by the owner.

## 6. Out of scope

- Moving Vox, Astation or Atem onto the IdP. Their teams do this; this change provides the Portal side.
- Migrating existing Portal accounts (there are none).
- Apple and Agora sign-in, which belong to the IdP's roadmap.
