# Agora.Build Identity, Credits And Membership

Sign-in for the Portal (agora.build, including Stoa) comes only from
`auth.agora.build`, over standard OpenID Connect. The Portal is a client of that
identity provider (IdP); it is not an identity provider or an OAuth server
itself. The Portal keeps everything that is not identity: profiles, plans,
credits, billing, Stoa spaces and the Agora Console connection.

Apps and servers that want to sign people in follow Auth's
[`docs/integrating.md`](https://github.com/Agora-Build/Auth/blob/main/docs/integrating.md).
This guide covers what the Portal adds: its accounts, sessions, and the API
contract for IdP access tokens, platform credits and Agora Console access.

## Signing In Through auth.agora.build

The Portal is the confidential OIDC client `portal`, using Authorization Code
with PKCE (S256), state and nonce. Google, GitHub and every other login live on
the IdP; linked logins, devices and "sign out everywhere" are managed at
`<AUTH_ISSUER>/account`, which the account page links to as "Manage sign-in".

| Setting | Meaning |
| --- | --- |
| `AUTH_ISSUER` | The IdP, `https://auth.agora.build` (locally `http://auth.localhost:3090`; plain http only on a local host) |
| `PORTAL_CLIENT_ID` | The Portal's client ID at the IdP (default `portal`) |
| `PORTAL_CLIENT_SECRET` | Its client secret, at least 32 characters; the same value the IdP reads through its clients file's `secretEnv` |
| `PORTAL_API_AUDIENCE` | The resource the Portal's APIs accept tokens for (default `https://api.agora.build`) |
| `SITE_URL` | The Portal's public origin; the redirect URIs below are built from it |

1. `GET /auth/login?returnTo=<path>` (every "Sign in" link on the site goes
   here directly) checks `returnTo` against the same-site path allowlist, stores the
   transaction (state, nonce, PKCE verifier, `returnTo`) in the store for ten
   minutes, and sets an HttpOnly `__Host-portal_auth` cookie (`portal_auth` over
   plain http) naming it. Because transactions live in the store, any Portal
   instance can finish a sign-in; no sticky routing is needed. Sign-in starts are
   limited to 20 a minute per address.
2. The browser signs in at the IdP and comes back to `GET /auth/callback`. The
   transaction is consumed once, the code exchanged and the ID token checked
   (issuer, audience, nonce, expiry, signature).
3. The Portal upserts the account and starts its own session, then redirects to
   `returnTo?signin=success`. Any failure (an IdP `error`, a missing or replayed
   transaction, a failed exchange, an invalid ID token) redirects with
   `?signin=failed` and creates no session. The log records the reason only,
   never a token.

If the IdP is unreachable when the Portal starts, the Portal still starts and
sign-in reports itself unavailable (`?signin=unavailable`, "Sign-in is
temporarily unavailable") until discovery succeeds; it retries at most every
30 seconds. When the Portal has not heard from the IdP for 30 seconds, a new
sign-in first re-checks that the IdP answers (a probe of up to about two
seconds). A sign-in can therefore still be sent to an IdP that stopped less than
30 seconds after the Portal last reached it; that person sees the IdP's own
error and can try again. Existing Portal sessions keep working while the IdP is
down, because the IdP is not called per request.

### IdP Registration

Register the Portal in the Auth deployment's clients file (`CLIENTS_FILE`), with
the API resource and its scopes. The secret is named, never written there:

```json
{
  "resources": [
    { "indicator": "https://api.agora.build", "name": "Agora Build API", "scopes": ["credits", "agora:projects", "agora:certificates"] }
  ],
  "clients": [
    {
      "id": "portal",
      "name": "Agora Build",
      "type": "web",
      "firstParty": true,
      "secretEnv": "PORTAL_CLIENT_SECRET",
      "redirectUris": ["https://agora.build/auth/callback"],
      "postLogoutRedirectUris": ["https://agora.build/"],
      "backchannelLogoutUri": "https://agora.build/auth/backchannel-logout",
      "homeUrl": "https://agora.build/",
      "grants": ["authorization_code"],
      "scopes": ["openid", "profile", "email"]
    }
  ]
}
```

The production IdP's `https://api.agora.build` resource must include
`agora:certificates` as well as `credits` and `agora:projects`; without it no
token can carry that scope, and `POST /api/connections/agora/certificate`
answers 403 to every app. Put the same `PORTAL_CLIENT_SECRET` value in the IdP's
environment and the Portal's. Locally the URIs are `http://localhost:3080/...` against
`http://auth.localhost:3090`; the IdP accepts plain http only on local host
names (`localhost`, `*.localhost`, `127.0.0.1`) and only with an http issuer.
Vox, Atem and other apps are registered with the `https://api.agora.build`
resource and only the scopes they need (see below).

## Accounts, Sessions And Guests

The IdP's `sub` (`ab` followed by 26 Crockford base32 characters, for example
`ab01M5KE40Z7VPK97NJS49W8QQSD`) is the
Portal account ID, so one person has the same ID in every Agora Build app.
`PLATFORM_ADMINS` and `platform-admin.mjs` take these `ab…` IDs (other
`PLATFORM_ADMINS` entries are ignored and counted in the log). At each
browser sign-in the account's name and picture are refreshed from the ID token;
the email is kept only when the IdP marks it verified. The email is shown only to
the owner's browser session (`/api/me`), never to bearer (app) callers. The first
access token for a `sub` that has no Portal account creates a minimal account
(`name: null`), so app users get a wallet; the name fills in at their first
browser sign-in.

A Portal session is an HttpOnly, `SameSite=Lax`, `Path=/` cookie named
`__Host-house_session` on https (`house_session` over plain http), with a 30-day
absolute lifetime and at most 20 sessions per account (the oldest are dropped).
The server keeps only a hash of the session token, the IdP session ID (`sid`) and
the ID token for `id_token_hint`; the ID token is not accepted as a credential by
any API and is deleted with its session. Moving production to the
`__Host-house_session` name doesn't strand guests: until 31 January 2027
(`LEGACY_GUEST_COOKIE_UNTIL` in `scripts/serve.mjs`), an https request without
`__Host-house_session` whose old `house_session` cookie is a guest profile's
session is accepted once, and the same token is re-issued as
`__Host-house_session` (Secure, HttpOnly, `SameSite=Lax`, `Path=/`) while the old
cookie is cleared (`Max-Age=0`). An old cookie for an account session is never
honoured (account sessions started empty with this change). After that date the
old cookie is ignored.

This change starts the Portal's identity data empty. At first load (state
version 2) the Portal deletes old sessions, OAuth codes and grants, pending
links, every account whose ID is not an IdP ID, and those accounts' ledger and
billing rows and spaces. Guest profiles, rooms and the radar are kept. Only
counts are logged.

The IdP's account IDs then changed from `acct_<ULID>` to `ab<ULID>`, so state
version 3 starts empty again: every account whose ID is not `ab…` goes, with its
sessions, profile, owned spaces, orders and ledger rows, removed the same way as
in version 2. Accounts already in the `ab…` format keep their sessions. A
version 1 state goes through both steps at once. The step is idempotent and
logs counts only.

"Continue with this browser" stays for looking around: a browser-only profile
can walk the Stoa, appear on the radar and keep a public profile. Credits,
the marketplaces (chat and TTS), billing, Agora Console and owning spaces need a
signed-in account; guests see "Sign in to use credits" and similar prompts
instead. A guest who signs in keeps their profile when the account has none yet.

## Signing Out

"Sign out" (`POST /api/auth/logout`, same-origin) deletes the Portal session and
answers `{ endSessionUrl }`: the IdP's end-session endpoint with `client_id`,
`post_logout_redirect_uri` (`<SITE_URL>/`) and `id_token_hint`. The browser
follows it, confirms on the IdP's page, and returns to the Portal home signed
out of both.

`POST /auth/backchannel-logout` receives the IdP's back-channel logout (for
example "Sign out everywhere" on the IdP's account page). It is a form-encoded
`logout_token`, a `logout+jwt` signed by the IdP and checked for issuer,
audience (our client ID), `iat` (at most five minutes old), `jti`, the
back-channel `events` claim, no `nonce`, and a `sid` or `sub`. A `sid` ends that
IdP session's Portal sessions; a `sub` alone ends all of that account's sessions.
It is the one route exempt from the same-origin checks, because it is a
server-to-server POST. Answers carry `Cache-Control: no-store`:

| Status | When |
| --- | --- |
| 200 | Verified and applied |
| 400 | The token is missing or invalid |
| 503 | The IdP's keys can't be fetched (the IdP is unreachable, or sign-in isn't configured), so the token can't be checked yet |

Auth sends each back-channel logout once, as one POST with a 2.5 second timeout,
and never retries. A missed logout (any non-2xx answer, or a timeout) leaves the
Portal session in place until the person signs out of the Portal or the session
reaches its 30-day expiry. To make misses rarer, the Portal fetches the IdP's
discovery document and JWKS at startup, without blocking it (a failure is logged
by reason only), so the first logout token doesn't wait for a cold discovery
(10 seconds) or JWKS fetch (5 seconds).

The IdP must be able to reach the back-channel URI. Locally it posts across the
Docker network, so the Portal container needs a host name the IdP accepts for
plain http (see "Local deployment" in the README).

## Signing Keys And Rotation

The Portal checks access and logout tokens against the IdP's JWKS, cached for 60
seconds and refetched for an unknown key ID. The trade-offs:

- A new IdP key is picked up within about five seconds: a token signed with an
  unknown key refetches the JWKS, at most once every five seconds.
- After an emergency rotation that drops a key, tokens signed with the old key
  are still accepted for up to 60 seconds, until the cached JWKS expires.
- While the JWKS is unreachable, keys from the last good fetch stay accepted
  for up to one hour after that fetch (the network is retried at most every 30
  seconds). A rotation that drops a key during an IdP outage therefore takes up
  to an hour to reach the Portal.
- If the JWKS can't be fetched for an unknown key, bearer calls answer 503 and
  back-channel logouts answer 503; they are never treated as valid.
- A dead IdP is noticed by new sign-ins after at most 30 seconds without contact
  (see above).

## Apps: IdP Access Tokens And Scopes

Browsers use the session cookie, with the same-origin checks unchanged for
non-GET requests. Apps and servers send `Authorization: Bearer <access token>`,
an IdP access token for the resource `https://api.agora.build`. A request with a
bearer token never falls back to the cookie. The token must be a JWT with `typ`
`at+jwt` and `alg` ES256, issued by `AUTH_ISSUER`, with `aud` containing
`PORTAL_API_AUDIENCE`, an unexpired `exp` and a `sub`. Request the resource with
`resource=https://api.agora.build` and the scopes below; see Auth's
`docs/integrating.md` for the flows (web code + PKCE, native device code).

| Route | Browser (cookie) | Bearer scope |
| --- | --- | --- |
| `GET /api/me` | account or guest | any (an `openid`-only token is enough) |
| `GET /api/credits/balance`, `/api/credits/statement` | account | `credits` |
| `POST /api/marketplaces/chat`, `/api/marketplaces/tts` | account (no guests) | `credits` |
| `GET /api/connections`, `/api/connections/agora/projects`, `DELETE /api/connections/agora` | account | `agora:projects` |
| `POST /api/connections/agora/certificate` | account | `agora:certificates` |
| `POST /api/platform/credits/reserve`, `/settle` | not accepted | `credits`, from a client in `PORTAL_BILLING_FILE` |
| Billing account, checkout and manage | account | not accepted |
| Stoa spaces (create, own, admin), profile, radar, signaling | account (spaces) or guest | not accepted |

Bearer errors:

- missing, invalid or expired token: 401 with `WWW-Authenticate: Bearer error="invalid_token"`;
- missing scope: 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<scope>"`;
- a browser-only route (billing, profile, radar, Stoa spaces): 403, whatever the scopes;
- the IdP's keys unreachable for an unknown key ID: 503 (retry later).

A token for one account can only read and spend that account's data.

## Platform Credits For Billing Clients

Billing clients (such as Vox) hold and settle a person's credits with that
person's access token, issued to the billing client with the `credits` scope.
The client never sends a price: `PORTAL_BILLING_FILE` names a private JSON file of
server-side prices per client and service, shaped like
`config/billing-clients.example.json`:

```json
{ "vox": { "services": { "evaluation": { "credits": 4, "maxUnits": 100 } } } }
```

A client may charge only if its `client_id` is listed, and only for its listed
services. List only confidential clients (web or server clients that
authenticate to the IdP with a secret, such as Vox). A native client's ID (such
as Atem's) is public, so any program can obtain tokens under it; never list one. Each charge is `credits × units`, with whole `units` from 1 to
`maxUnits`. If the setting is unset, or the file is missing or invalid, platform
billing is off (503) and the log says why.

```http
POST /api/platform/credits/reserve
Authorization: Bearer <the person's access token for vox>
Content-Type: application/json

{ "service": "evaluation", "units": 2, "idempotencyKey": "eval-2026-10-21-0001" }
```

The answer is `{ id, status }`: `reserved` for a new hold, or, for a repeated
`idempotencyKey`, the existing hold's `pending`, `captured` or `released`; a
repeat never charges twice. Run the work only after `reserved`. Settle with
`POST /api/platform/credits/settle` and `{ service, reservationId, outcome }`,
where `outcome` is `capture` or `release`. `units` defaults to 1;
`idempotencyKey` is 16 to 120 characters of letters, digits, `:`, `_` and `-`.
Other answers: 403 for a client that isn't listed, 422 for an unknown service or
units out of range, 409 for insufficient credits, and 429 past the rate limit.

Caveats:

- The reserve rate limit is 60 a minute per account, and counts every attempt,
  including malformed requests and retries of the same key.
- Changing a service's price while holds are live makes a retry of one of those
  holds answer 409 ("Request price conflict"), because the repeated key now
  prices differently. Use a new key for a new request.
- Holds not settled within an hour are released by the five-minute expiry timer,
  including holds for a service later removed from the file (they can no longer
  be settled, because settling needs a listed service).

Portal chat and TTS prices are separate: `MARKETPLACE_CHAT_CREDITS` and
`MARKETPLACE_TTS_CREDITS` (zero means no charge). Paid requests need a signed-in
account (or a `credits` token) and an `Idempotency-Key` header; failed model
requests release their hold. No browser or native endpoint can grant credits.
The ledger uses whole credits and balanced entries across user, escrow and
platform accounts; concurrent spending cannot overdraw a wallet. Users start
with zero credits.

## Storage And Deployment

Set `SITE_URL=https://agora.build` behind an HTTPS reverse proxy, which must
preserve the public Host header. Set `DATABASE_URL` to a dedicated PostgreSQL
database for production. The server creates `agora_build_state`, a locked JSONB
aggregate; accounts, sessions, sign-in transactions, subscriptions, payment
receipts and ledger mutations commit atomically. This storage model prioritizes
consistency and serializes writes; it can be split into normalized tables as
volume grows without changing account IDs.

Rate limits keyed by client address (sign-in starts, joining, spaces, Signaling
tokens and model calls) use the socket address by default. Behind a reverse
proxy every request would share the proxy's address, so set `TRUST_PROXY=1`
only behind a proxy that appends `X-Forwarded-For`: the client address is then
the header's last hop, the one that proxy appended, and anything a client put
before it is ignored. Without the header the socket address is used. Logs never
include addresses.

Without PostgreSQL, local development uses `.data/community.json` and supports
one Node process. Back up the database or this private directory. Local admin
writes require stopping the Portal and setting `PORTAL_OFFLINE_ADMIN=true`.
To move existing file data to an empty database, stop the old server, back up the
file, configure `DATABASE_URL`, then run:

```sh
node scripts/platform-admin.mjs import-json
```

Never run this import against Vox's or Auth's database or overwrite an existing
Portal database. The command refuses a nonempty destination.

## Subscription Plans And Purchases

The account page supports Basic, Premium, Principal, and Fellow, matching Vox's
plan names and entitlement limits. Premium provides 20 projects, 20 console eval
flows per project, 200 API eval flows, private resources, and own storage.
Principal/Fellow also permit mainline publishing and are assigned roles rather
than purchasable products. Vox enforcement starts when Vox signs in through auth.agora.build;
buying a portal plan does not currently change an existing Vox account.

Configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and recurring Premium
prices with `STRIPE_PREMIUM_MONTHLY_PRICE_ID` / `STRIPE_PREMIUM_YEARLY_PRICE_ID`.
`BILLING_CREDIT_PACKS_FILE` points to a private pack catalog shaped like
`config/credit-packs.example.json`; replace its placeholder with real one-off
Stripe prices. Displayed prices come from Stripe. No payment credentials or card
details enter the browser app. Checkout and billing management are Stripe-hosted.
Configure the Stripe Customer Portal for the same Premium prices and cancellation.

Register `https://agora.build/api/billing/webhook` for:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.expired`
- `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`
- `invoice.paid` and `charge.refunded`

The webhook verifies the raw-body signature and checks customer, user, order,
price, quantity, and actual payment before granting credits. Redirects from
checkout never grant anything. Event IDs and payment references prevent duplicate
fulfillment. Subscription updates read current Stripe state to resist late events.
Cancellation at period end preserves Premium until expiry. Past-due, unpaid,
canceled, and expired subscriptions fall back to Basic; there is no grace period.
Assigned Principal/Fellow roles remain independent of paid subscription status.

Optional `PREMIUM_PERIOD_CREDITS` grants credits once per paid initial/cycle
invoice, never on prorations or unpaid invoices. It defaults to zero. Credit
refunds revoke a proportional number of purchased credits once; refunding spent
credits creates an adjustment, blocks new spending, and is repaid by returned or
new credits. Charge disputes require operator review; they are not auto-refunds.

Operators can record audited manual grants and community roles with:

```sh
node scripts/platform-admin.mjs grant-credits <ab…> <credits> <unique-key> <reason>
node scripts/platform-admin.mjs assign-role <ab…> <basic|principal|fellow>
```

`basic` removes an assigned role; it does not cancel a Stripe subscription.

## Agora Console Connections

Connecting Agora Console is separate from signing in: an Agora OAuth
authorization used only to let the signed-in account read its Console projects.
`GET /connect/agora` (signed-in accounts only; guests are sent to sign in)
stores a transaction bound to the account, like sign-in, in an HttpOnly
`__Host-portal_connect` cookie (`portal_connect` over http), and sends the
browser to Agora with scope `basic_info,console` and PKCE. The callback,
`/connect/agora/callback`, refuses a transaction that belongs to another account,
stores `{accessToken, refreshToken, expiresAt}` sealed, and redirects to
`/account/?connected=agora` (or `?connected=failed`).

Register a dedicated, confidential Portal client with Agora's OAuth service and
allow the redirect URI `<SITE_URL>/connect/agora/callback` (for production
`https://agora.build/connect/agora/callback`; locally
`http://localhost:3080/connect/agora/callback`). The old
`/auth/agora/callback` is gone. Settings:

| Setting | Meaning |
| --- | --- |
| `AGORA_OAUTH_BASE_URL` | Agora's OAuth service (default `https://sso2.agora.io`) |
| `AGORA_OAUTH_CLIENT_ID` | The Portal's Agora client ID |
| `AGORA_OAUTH_CLIENT_SECRET` | Its client secret; required, the client is confidential (the code exchange and refresh send it) |
| `AGORA_OAUTH_USERINFO_URL` | Optional; a Bearer userinfo endpoint used only to show the Agora account's display name ("Connected to your Agora account (name)") |
| `AGORA_BFF_URL` | The Console API (default `https://agora-cli.agora.io`, as Astation uses) |
| `AGORA_CONSOLE_ENCRYPTION_KEY` | A base64-encoded 32-byte server key (formerly `CONNECTION_ENCRYPTION_KEY`, still read as a fallback) |

Without all of the required ones, "Connect Agora" is hidden and the account page
says Console connections are not available yet. Agora access and refresh tokens
are encrypted with AES-256-GCM at rest, using only
`AGORA_CONSOLE_ENCRYPTION_KEY`; keep and back up that key separately from the
database and never change it once connections exist.

The owner can list projects and App IDs and explicitly reveal a project's
certificate. Lists omit certificates; credentials never appear in public
profiles. Certificates are fetched on demand and not cached in the Portal
database. The browser clears revealed certificates after 30 seconds or when its
tab is hidden. Disconnecting removes the stored Console connection; it does not
sign anyone out. Apps reach the same routes with `agora:projects` and
`agora:certificates` tokens.

## Vox, Atem And Astation

Moving Vox, Astation and Atem onto the IdP is their teams' work; the Portal side
is ready. Each app registers with the IdP, signs people in there, and uses the
`ab…` `sub` as the global account ID. Vox becomes a billing client: register
it with the `credits` scope for `https://api.agora.build` and list its services
in `PORTAL_BILLING_FILE`. Native apps such as Atem use the device-code flow with
the scopes they need. Map existing Vox identities by exact verified provider
subjects, never email; existing Vox balances and history need an explicit,
backed-up migration with idempotent opening balances before spending moves to
this ledger. Astation keeps its Agora BFF session separate from its Agora Build
token, so Portal marketplaces and credits coexist with Agora Console access.

## Verification

`npm test` covers the OIDC client (callback validation, sessions, back-channel
logout, bearer tokens, key rotation and an unreachable JWKS) against a stand-in
IdP, plus the ledger, payments, subscriptions, ownership and public-file
restrictions. PostgreSQL integration is optional in the default suite: set
`PORTAL_TEST_DATABASE_URL` to a dedicated database named `agora_portal_test` and
run `node --test tests/persistence.test.mjs`. That test rebuilds its own table;
never point it at production.

`npm run test:e2e` runs the real Portal against the real auth.agora.build, loaded
from an Agora-Build/Auth checkout (`AUTH_REPO`, default `../Auth`, with
`npm ci` done) with Auth's stand-in GitHub and Google. It needs Node 22 (at least
20.18) and `TEST_DATABASE_URL`, a throwaway PostgreSQL database in which Auth's
helpers create and drop their own schemas. It drives sign-in, SSO, sign-out,
back-channel logout, a billing client, a native app, the billing allowlist, key
rotation, the IdP going down and cross-account isolation over real HTTP.

`node scripts/browser-smoke.mjs` drives a real headless Chromium through the same
stack at desktop and mobile sizes: the keyboard-reachable "Sign in", the IdP page
and back, the account page, guest prompts, the account page when
`/api/auth/config` fails, and signing out of both. It needs the e2e settings plus
`PLAYWRIGHT_CORE` (a playwright-core directory) and `CHROMIUM_PATH`; nothing is
installed into this package. Real GitHub/Google sign-in, Agora Console, Stripe
checkout, refunds and webhook delivery still need registered credentials and an
HTTPS deployment to verify end to end.
