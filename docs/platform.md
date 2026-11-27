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

**Signed in elsewhere, signed in here.** Once per browser session, a page that
has no account session asks the IdP quietly whether the person is already
signed in there, for example through Astation or another Agora Build app:
`/auth/login?prompt=none&returnTo=<page>`. If they are, they come back to the
same page signed in, without a click or a message; if not (`login_required` and
the other OIDC "not signed in" answers), they come back to the same page
unchanged. A session cookie, `ab_sso_checked`, keeps it to one check per browser
session across tabs, and "Sign out" sets it so the person isn't signed straight
back in. Other failures of a quiet check are logged by reason and also leave the
page as it was; the explicit "Sign in" still reports failures. Desktop apps that
requested `offline_access` (Astation) keep their own sign-in when the browser
signs out; "sign out everywhere" on the IdP ends those too.

| Setting | Meaning |
| --- | --- |
| `AUTH_ISSUER` | The IdP, `https://auth.agora.build` (locally `http://auth.localhost:3090`; plain http only on a local host) |
| `PORTAL_CLIENT_ID` | The Portal's client ID at the IdP (default `portal`) |
| `PORTAL_CLIENT_SECRET` | Its client secret, at least 32 characters; the same value the IdP reads through its clients file's `secretEnv` |
| `PORTAL_API_AUDIENCE` | The resource the Portal's APIs accept tokens for (default: the `SITE_URL` origin, `https://agora.build` in production and `https://dev.agora.build` on dev) |
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
    { "indicator": "https://agora.build", "name": "Agora Build API", "scopes": ["credits", "agora:projects", "agora:certificates", "agora:tokens"] }
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

The production IdP's `https://agora.build` resource (the Portal's own origin;
`https://dev.agora.build` on dev) must include
`agora:certificates` and `agora:tokens` as well as `credits` and
`agora:projects`; without them no token can carry those scopes, and
`POST /api/connections/agora/certificate` and `/token` answer 403 to every app. Put the same `PORTAL_CLIENT_SECRET` value in the IdP's
environment and the Portal's. Locally the URIs are `http://localhost:3080/...` against
`http://auth.localhost:3090`; the IdP accepts plain http only on local host
names (`localhost`, `*.localhost`, `127.0.0.1`) and only with an http issuer.
Vox, Atem and other apps are registered with the Portal's origin as their
resource and only the scopes they need (see below).

## Accounts, Sessions And Guests

The IdP's `sub` (`ab` followed by 26 Crockford base32 characters, for example
`ab01M5KE40Z7VPK97NJS49W8QQSD`) is the
Portal account ID, so one person has the same ID in every Agora Build app.
`PLATFORM_ADMINS` and `platform-admin.mjs` take these `ab…` IDs (other
`PLATFORM_ADMINS` entries are ignored and counted in the log). `PLATFORM_ADMINS` now only gives admin rights in Stoa
spaces; Agora.Build's admin powers over Stations and integrations are on the admin site. At each
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
an IdP access token whose resource is the Portal's own origin (`https://agora.build`;
`https://dev.agora.build` on dev), the same host the app calls. A request with a
bearer token never falls back to the cookie. The token must be a JWT with `typ`
`at+jwt` and `alg` ES256, issued by `AUTH_ISSUER`, with `aud` containing
`PORTAL_API_AUDIENCE`, an unexpired `exp` and a `sub`. Request the resource with
`resource=<the Portal origin>` and the scopes below; see Auth's
`docs/integrating.md` for the flows (web code + PKCE, native device code).

**Apps call the versioned API, `<origin>/api/v1/...`** (for example
`https://agora.build/api/v1/connections/agora/projects`), so an app needs only
one base URL, the same one it requests tokens for. `/api/v1` holds exactly the
routes in the table below, served by the same handlers as the browser's
`/api/...`; any other `/api/v1` path is 404. An access token sent to an
unversioned `/api/...` route in the table gets 404 naming its `/api/v1` path;
the browser keeps using `/api/...` with its cookie (it may also use `/api/v1`).
`v1` may gain routes and fields but never loses or renames any; a breaking
change becomes `/api/v2`, with `v1` kept through a deprecation period.

The table names each route by its path after `/api/v1` for apps and `/api` for
the browser:

| Route | Browser (cookie) | Bearer scope |
| --- | --- | --- |
| `GET /me` | account or guest | any (an `openid`-only token is enough) |
| `GET /credits/balance`, `/credits/statement` | account | `credits` |
| `POST /marketplaces/chat`, `/marketplaces/tts` | account (no guests) | `credits` |
| `GET /connections`, `/connections/agora/projects`, `DELETE /connections/agora` | account | `agora:projects` |
| `POST /connections/agora/certificate` | account | `agora:certificates` |
| `POST /connections/agora/token` | account | `agora:tokens` |
| `POST /platform/credits/reserve`, `/settle` | not accepted | `credits`, from a client in `PORTAL_BILLING_FILE` |
| `GET /integrations` | account | `integrations:read` |
| `POST /integrations/<id>/approval` | not accepted | `integrations:approve` |
| `POST /stations/reports`, `GET /stations/changes` | not accepted | `station.report`, from a Station's `s-` client (`sub` is the Station's owner, or for the built-in Station the `s-` client itself) |
| Billing account, checkout and manage | account | not accepted |
| Stoa spaces (create, own, admin), profile, radar, signaling | account (spaces) or guest | not accepted |

Bearer errors:

- missing, invalid or expired token: 401 with `WWW-Authenticate: Bearer error="invalid_token"`;
- missing scope: 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<scope>"`;
- a browser-only route (billing, profile, radar, Stoa spaces): 403, whatever the scopes;
- a built-in Station's own report token (`sub` = its `s-` client) on any other route: 403;
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
POST /api/v1/platform/credits/reserve
Authorization: Bearer <the person's access token for vox>
Content-Type: application/json

{ "service": "evaluation", "units": 2, "idempotencyKey": "eval-2026-10-21-0001" }
```

The answer is `{ id, status }`: `reserved` for a new hold, or, for a repeated
`idempotencyKey`, the existing hold's `pending`, `captured` or `released`; a
repeat never charges twice. Run the work only after `reserved`. Settle with
`POST /api/v1/platform/credits/settle` and `{ service, reservationId, outcome }`,
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

Stations and integrations also need `DATABASE_URL`: they keep their own tables
(created by migrations that run at startup) beside `agora_build_state`, and
their rows are kept forever. See "Stations And Integrations".

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

Connecting Agora Console is separate from signing in: an Agora SSO
authorization used only to let the signed-in account read its Console projects.
The Portal is a confidential client of Agora SSO (`https://sso2.agora.io`).
`GET /connect/agora` (signed-in accounts only; guests are sent to sign in)
stores a single-use transaction bound to the account, like sign-in, in an
HttpOnly `__Host-portal_connect` cookie (`portal_connect` over http), and sends
the browser to `GET /api/v0/oauth/authorize` with `response_type=code`,
`client_id`, `redirect_uri`, `scope` and `state`, and no PKCE: Agora refuses it
for confidential clients ("PKCE is not supported for confidential client"); the
client secret and the single-use, account-bound state protect the code. The callback, `/connect/agora/callback`, refuses a
transaction that belongs to another account or a state that does not match,
redeems the code and redirects to `/account/?connected=agora` (or
`?connected=failed`).

Register the Portal's client with Agora SSO and allow exactly the redirect URI
`<SITE_URL>/connect/agora/callback` (for production
`https://agora.build/connect/agora/callback`; locally
`http://localhost:3080/connect/agora/callback`). Do not reuse Astation's atem
loopback client. Settings:

| Setting | Meaning |
| --- | --- |
| `AGORA_SSO_BASE_URL` | Agora SSO, https only (default `https://sso2.agora.io`) |
| `AGORA_SSO_CLIENT_ID` | The Portal's Agora SSO client ID |
| `AGORA_SSO_CLIENT_SECRET` | Its client secret; the client is confidential |
| `AGORA_SSO_SCOPE` | Comma-separated scopes requested at authorize (default `basic_info,console`, what the Portal has always sent; `basic_info` alone may not cover the Console APIs) |
| `AGORA_BFF_URL` | The Agora CLI BFF that lists projects, https only (default `https://agora-cli.agora.io`, the BFF Atem uses) |
| `AGORA_CONSOLE_ENCRYPTION_KEY` | A base64-encoded 32-byte server key that seals stored connections |

Connect is available only when `AGORA_SSO_BASE_URL`, `AGORA_SSO_CLIENT_ID`,
`AGORA_SSO_CLIENT_SECRET`, a 32-byte `AGORA_CONSOLE_ENCRYPTION_KEY` and
`SITE_URL` are all set; otherwise "Connect Agora Console" is hidden, the account
page says Console connections are not available yet, and the server logs the
missing setting names (never values). There are no other names for these
settings.

Endpoints used, on `AGORA_SSO_BASE_URL` unless marked BFF (`AGORA_BFF_URL`):

| Call | Use |
| --- | --- |
| `POST /api/v0/oauth/token` `grant_type=authorization_code` | Redeems the code with `client_id`, `client_secret`, `code`, `redirect_uri` in the form body (no `code_verifier`) |
| `POST /api/v0/oauth/token` `grant_type=refresh_token` | Renews the access token with `client_id`, `client_secret`, `refresh_token`: a minute before it expires, and once after a 401 |
| `GET /api/v0/customer/company/basic-info`, then `GET /api/v0/customer/user-auth` | The display name shown on the account page (company name, else the user's name), read once at connect |
| BFF `GET /api/cli/v1/projects` | The project list, `{ items: [{ projectId, name, appId, signKey, status, createdAt, vid }] }`. The Portal answers the list without certificates, and reveals one project's `signKey` only when the owner asks |
| `DELETE /api/v0/customer/user-auth` | Removes the authorization at Agora when the owner disconnects (best effort) |

sso2's own `GET /api/v0/customer/project` and `GET /api/v0/project` answer these
tokens with its login-page 401 (`redirectToLoginPage`), so the Portal doesn't use
them. Every data call sends `Authorization: Bearer <access token>`. A 401 renews the
token once and retries; if Agora refuses the renewal the connection is marked
as needing a reconnect, the account page shows "Reconnect Agora Console", and no
further calls are made until the owner connects again.

Agora has not documented its response shapes, so one tolerant mapper in
`scripts/connections.mjs` reads them: a project array at the top level or under
`data`, `list`, `items` or `projects`; fields such as `name`/`projectName`,
`vendorId`/`vid`/`id`, `appId`/`key`/`vendorKey`,
`certificate`/`signKey`/`appCertificate`, `status` and `createdAt`. When a
response does not match, the server logs only its status code and key names.
To adapt the mapper, the owner can run the temporary probe
`node scripts/agora-shapes.mjs <account-id>` with the server's settings (the
same `DATABASE_URL` and key; a local file store needs the Portal stopped and
`PORTAL_OFFLINE_ADMIN=true`) after connecting that account. It opens the
stored token in-process, calls each GET endpoint above plus
`GET /api/v0/account/companies`, and prints only key names and value types,
never values.

What is stored: per account, `{accessToken, refreshToken, expiresAt, name,
reconnect}` sealed with AES-256-GCM under `AGORA_CONSOLE_ENCRYPTION_KEY`, bound
to the account ID. Keep and back up that key separately from the database and
never change it once connections exist. Project lists, App IDs and certificates
are fetched from Agora on demand and never stored.

The owner can list projects and App IDs and explicitly reveal a project's
certificate. Lists omit certificates; credentials never appear in public
profiles or logs. The browser clears revealed certificates after 30 seconds or
when its tab is hidden. Disconnecting removes the authorization at Agora when it
can and always removes the stored connection; it does not sign anyone out. Apps
reach the same routes with `agora:projects`, `agora:certificates` and
`agora:tokens` tokens.

### Agora Tokens

`POST /api/v1/connections/agora/token` (apps; the browser uses `/api/...`) signs an Agora RTC or RTM token for one of
the account's projects on agora.build, so an app never needs the App
Certificate. The certificate comes from the BFF project list for this request
and is neither cached nor returned. Rate limit: 60 a minute per account.

| Field | Meaning |
| --- | --- |
| `projectId` | A `projectId` from `GET /api/v1/connections/agora/projects` |
| `type` | `rtc` or `rtm` |
| `channel` | RTC: 1 to 64 bytes |
| `uid` or `account` | RTC: a number 0 to 4294967295 (0 means any user, the default) or a 1 to 255 byte string account, not both |
| `role` | RTC: `publisher` (default: join and publish audio, video and data), `subscriber` (join only) or `explicit` |
| `tokenExpire`, `privilegeExpire` | RTC: seconds after issue, 1 to 86400, default 3600 |
| `privileges` | RTC `explicit`: `{ join, audio, video, data }` expiries, each 1 to 86400, default 3600 |
| `rtm` | RTC: `{ userId?, expire? }` adds an RTM login; `userId` defaults to `account` and is required with a numeric `uid` |
| `userId`, `expire` | RTM: a 1 to 64 byte user ID and its expiry, default 3600 |

The reply is `{ projectId, appId, type, token, issuedAt, expiresAt }`, plus for
RTC `channel`, `uid` or `account`, `role`, `privileges` (expiry times) and
`rtm`, and for RTM `userId`. Errors: 404 for a project not in the account, 409
for a project without an App Certificate, 422 for invalid fields (with the same
wording Astation shows), and the connection errors above.

Tokens are signed with Atem's `atem-core`, the library Astation uses, so
agora.build and Astation produce identical tokens. `native/atem-core-wasm` links
`atem-core-ffi` at the Atem revision Astation pins (`Config/atem-core.json`)
with real zlib, as Astation builds it, and compiles to WebAssembly;
`scripts/atem-core.mjs` calls its C ABI 1 exactly as Astation's Swift does. The
committed module is `scripts/vendor/atem-core.wasm`, with its checksum, Atem
revision and compilers in `scripts/vendor/atem-core.json`; the server and
Docker image need no Rust. Rebuild it with `npm run build:atem-core` (Rust with
the `wasm32-unknown-unknown` target, and clang with `llvm-ar` for zlib). The
tests rebuild Astation's eight captured tokens byte for byte. Stoa's call and
signaling tokens use the same module; only the opt-in RTM channel permissions
(`AGORA_RTM_PERMISSIONS`) still use `agora-token`, which atem-core doesn't cover.

## Stations And Integrations

A Station is a server an account runs and registers with the Portal, for
example the Astation host. An integration is a custom app (the only kind in
phase 1) that an account lets use one Station with the `agent.*` scopes. Auth
decides who can get tokens; the Portal keeps the accounts' view, the history and
the change feed the Stations read. Account deletion (with its waiting period)
and the Discord apps come later and are not covered here.

Every account also has the **built-in Station** (`https://station.agora.build`; on dev
`https://station-dev.agora.build`), which Agora.Build runs ([D24](integrations.md#332-the-built-in-station)). Auth admits it from the `stations` list in
its clients file instead of proof of control; nobody owns it, every signed-in account may use it, and nobody can
remove it through any page or API.

### Database And Settings

Stations and integrations need PostgreSQL (`DATABASE_URL`). Without it every
`/api/stations...`, `/api/integrations...` and the matching `/api/v1` route
answers 503 `{ "error": "Stations and integrations need the Portal database." }`,
and the account page hides the section. They also need the Auth settings
`AUTH_ISSUER`, `PORTAL_CLIENT_ID` (default `portal`) and `PORTAL_CLIENT_SECRET`,
used to call Auth's management API; if `AUTH_ISSUER` or `PORTAL_CLIENT_SECRET`
is missing the feature is off and the log names the missing setting.

Migrations (`migrations/*.sql`) run automatically before the first request;
if the database is not ready that request gets 503 and the next one tries again.
The tables:

| Table | Holds |
| --- | --- |
| `stations` | Auth's Station ID, origin, owner (none for a built-in Station), report client ID, `active` or `removed`, `built_in`, `access` (`members` or `any_account`), `integrations_enabled`, `name` |
| `station_members` | accounts a Station is shared with, with who added or removed them and when |
| `station_challenges` | issued proof values, valid 10 minutes, single use |
| `integrations` | Auth's `i-` client ID, owner, Station, scopes, state, `resume_state`, `r9_svc`, quota, expiry, `last_error`, `paused_by` (who paused it, as Auth says: `owner`, `station` or `admin`), `owner_disabled_at` (while Agora.Build has the owner's account disabled), `revoked_at` (when it was revoked; empty for one revoked before migration 004), `interrupt_running` (whether its revocation interrupts the tasks running on the owner's hosts; see below), `revocation_outcome` and `revocation_pending_hosts` (how its revocation ended, from the Station's final report: `all_applied` or `deadline_passed`, and the host ids that didn't confirm; empty until then and without the setting; migration 005) |
| `integration_events` | every change, kept forever; also the Stations' change feed |
| `station_reports` | a Station's reports that carry a `reportId` (migration 005, with `DELEGATED_HOST_WORK=1` only): the id, the integration (none for a binding report), the body and the answer it got, kept forever so a retry gets the same answer; the key is the Station and the id |
| `revocation_hosts` | the hosts that applied an integration's revocation (migration 005, with `DELEGATED_HOST_WORK=1` only): the host id, the record's id and the report's id, one row per host |
| `auth_change_feed` | one row: where the Portal is in Auth's change feed (Auth's cursor) and, since migration 006, how it follows Auth's account entries: `accounts_mode` (`rebuilding`, `live` or `waiting`), `accounts_epoch`, `accounts_cursor` (a copy of the cursor, written with it, which an image from before 006 leaves alone), the baseline the current rebuild has seen and whether the Stations are owed an `accounts_incomplete` change |
| `account_availability` | migration 006, with `DELEGATED_HOST_WORK=1` only: each account Auth's feed has disabled or enabled, and the feed entry that said so; an account with no row is enabled (or doesn't exist) |
| `auth_account_entries` | migration 006, with the setting on only: the account-level entries of Auth's feed the Portal has applied, once each |
| `account_availability_rebuild`, `auth_account_entries_rebuild` | migration 006, with the setting on only: a rebuild's own copy of the two tables above, kept until the rebuild catches up with the end of Auth's feed |
| `account_baseline` | migration 006, with the setting on only: one row, the last `accounts_baseline` applied and whether the Portal's view of the accounts is complete |
| `station_bindings` | migration 006, with the setting on only: the built-in Station's last reported binding for each R9 account and genesis hash: the Agora.Build account, the binding id, the version and the state |
| `binding_attempts` | migration 006, with the setting on only: the built-in Station's refused binding attempts, kept forever; the account page shows the last 30 days |

Rows are never deleted: Stations get `removed_at`, members get `removed_at`,
integrations end in `revoked`, and the event log only grows. `integration_events`
is partitioned by month on `at` (UTC, named `integration_events_yYYYYmMM`, with
a default partition); partitions for this month and next are created at startup
and hourly. Events are appended under one lock, so event IDs follow commit
order and a cursor never skips a change.

Auth is always called first, and the Portal writes its rows only after Auth
answers success. Every change Auth is asked to make names the signed-in account
as `actor`. If Auth is unreachable while listing, the lists are served from the
Portal's rows with `"stale": true`; otherwise the Portal brings its rows in
line with Auth's, which is authoritative.

Auth's clients file must be set up for this:

- the `https://agora.build` resource lists `integrations:read` and
  `integrations:approve`, and `astation` is granted both (see "Portal scopes for
  approvals" in Auth's `docs/integrating.md` and `config/clients.example.json`);
- exactly one resource lists `station.report`, the Portal's;
- the `portal` client has `"manage": true`, `"exchange": true`,
  `"stationScopes": ["station.read"]`, its `backchannelLogoutUri`, and
  `"changesNudgeUri": "<SITE_URL>/auth/integration-changes"` (see "Admin Changes From Auth").

Migration `004_delegated_host_work.sql` adds `integrations.revoked_at` and `integrations.interrupt_running`. `revoked_at`
is recorded for every revocation, whatever the setting (one from Auth's feed takes Auth's time); `interrupt_running` is set
only with `DELEGATED_HOST_WORK=1`, below.

Migration `005_station_reports.sql` adds the tables `station_reports` and `revocation_hosts` and the columns
`integrations.revocation_outcome` and `integrations.revocation_pending_hosts`, for the Station's revocation reports of
D29's Phase B (below). It runs when the server starts, whatever the setting. The Portal writes to them only with
`DELEGATED_HOST_WORK=1`, so with it off they stay empty. Like the other rows, they are never deleted.

Migration `006_availability_bindings.sql` adds the tables `account_availability`, `auth_account_entries`,
`account_availability_rebuild`, `auth_account_entries_rebuild`, `account_baseline`, `station_bindings` and
`binding_attempts`, and, on `auth_change_feed`, the columns `accounts_mode`, `accounts_epoch`, `accounts_cursor`,
`rebuild_baseline_cursor`, `rebuild_baseline_at` and `accounts_incomplete_owed` (see "Account Availability" under "Admin
Changes From Auth"; `accounts_cursor` starts as the cursor, and is the older-image guard's). It also
lets `integration_events.account_id` and `station_reports.integration_id` be empty (a baseline names no account, and a
binding report no integration) and indexes `station_members` by account, for the Station directory. It runs when the server
starts, whatever the setting, and waits for any change in the middle of being recorded. A Portal that has already read
some of Auth's feed (its cursor is set) starts in `accounts_mode` `waiting`, since no earlier Portal applied Auth's account
entries; a new one starts in `rebuilding`. The Portal writes to the new tables only with `DELEGATED_HOST_WORK=1`, so with
it off they stay empty; the one exception is the setting-off rule in "Account Availability". Like the other rows, they are
never deleted: a rebuild empties only its own two copies.

**With `DELEGATED_HOST_WORK=1` (off by default):** the Portal offers delegated host work, Phase A of
[D29](integrations.md#311-delegated-host-work-d29): a revocation says whether to interrupt the tasks running on the
owner's hosts, those tasks can be interrupted later within 24 hours, and the built-in Station hears when an admin
disables or enables an account. Phase B adds the Station's two revocation reports and, on a stopped integration, how many
hosts applied the revocation ("Routes", "For Station Builders"). The third slice adds the native Station directory
(`GET /api/v1/stations`), the exact-cursor checkpoint (`?checkpoint=1`), account availability with its completeness mark
and the built-in Station's two binding reports (`binding_changed` and `binding_attempt`). Releasing a binding
(`binding_released`, and the admin site's release) waits for D27 and is not built. The Portal reads the one variable when it
starts; only `1` turns it on, and any other value or none is off. Off is today's behaviour exactly: the routes, bodies,
views and feed entries below do not exist and the account page shows nothing new (the one internal exception is the
setting-off rule in "Account Availability"). On, `GET /api/me` also answers
`"delegatedHostWork": true`, for the browser session only (the page reads it); the token route `GET /api/v1/me` is
unchanged. Turn it on in the order, and with the precondition, in "Turning On Delegated Host Work".

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
  downgrade existing integrations keep working; new ones wait until the account is under its limit. Renewing an
  expired integration on a built-in Station counts as a creation (same check, same 403; the expired one is not
  counted yet); renewing a live one is always allowed. Custom Stations have no cap.
- **With `DELEGATED_HOST_WORK=1` (off by default):** a `revoking` integration no longer counts against the plan limit.
  Auth has revoked it and issues it no token, but with the Station's revocation reports (Phase B) it can stay `revoking`
  for 24 hours or more, until its Station sends the final report, so its place is free from the moment of the revoke, for
  a creation and for renewing an expired integration alike. With the setting off a `revoking` integration holds its place
  until the Station reports `revoked`, as before; turning the setting off again counts the ones still `revoking` once more.
- **Admins.** Agora.Build admins act on the admin site (`https://admin.agora.build`, dev
  `https://admin.dev.agora.build`; [D26](integrations.md#334-the-admin-site-d26)), which calls Auth, never in the Portal. In the Portal an admin is just
  another account: every listing shows an account its own integrations and those on custom Stations it owns, another
  account's integration on the built-in Station is 404 for everyone but its owner, and Auth refuses the Portal's
  management calls that act across accounts. Their changes reach the Portal through Auth's change feed (see "Admin
  Changes From Auth").
- **With `DELEGATED_HOST_WORK=1` (off by default):** the mailbox notice. Where Astation shows the built-in Station's trust
  notice, it adds: "On the built-in Station, Agora.Build's server stores the sealed messages your hosts send each other for
  up to 24 hours. It can't read or change them. It can see which of your hosts exchange messages, and when, but not what
  they say." It describes the built-in Station's host-to-host mailbox ([D29](integrations.md#311-delegated-host-work-d29),
  Atem's design II.4.3), which arrives with Astation's build, so until then it describes behaviour nothing has yet. The
  Portal stores no mailbox message and shows this text nowhere itself. It is about the built-in Station only.
- **Reports and feed** use the same routes as any Station. Its report token's `sub` is its own `s-` client ID (it has
  no owner): the Portal accepts such a token only when `client_id` equals `sub`, `sub` is `s-` and 26 lower-case
  Crockford base32 characters, and the scope includes `station.report`. It reaches only the two report routes (403
  elsewhere) and is never a Portal account. Its feed lists every integration on it, each with `ownerAccount`, and
  nothing else; push hints go to its origin. With `DELEGATED_HOST_WORK=1` (off by default) its feed also carries the
  account changes, its checkpoint the accounts and its bindings, and it may send the two binding reports; a custom Station
  gets none of these ("For Station Builders").
- **Sync.** The Portal learns of built-in Stations from Auth itself: when the Stations and integrations stack becomes
  ready (the server prepares it in the background as soon as it listens; a request to one of their routes waits for
  it) and then hourly, it reads Auth's listing of
  built-in Stations, which names no account (`GET /manage/v1/built-in-stations`), and adds or updates them, never
  removing one. With Auth unreachable, or an Auth without that listing (404), the log says so by reason and the sync
  is tried again a minute later (hourly again once it succeeds); every account's own listing also syncs them. The
  first sync holds the first request for up to Auth's 10-second management timeout plus the database writes it makes.
  A report client the Portal does not know answers 403 `station`.
- **Retiring it.** A built-in Station Auth retires (`"retired": true`) without another Station at its origin stays
  listed in the Portal, since absence or retirement never removes one here. After Auth has retired it (which revokes
  its report client and integrations there), an operator marks it removed in the Portal database:
  `UPDATE stations SET status = 'removed', removed_at = now() WHERE id = '<station id>' AND built_in AND status = 'active';`
  It then leaves every listing, is no longer offered for integrations and its report token is refused; each owner's
  next integration listing follows Auth's revocations. A later listing from Auth never restores it (logged).
- **Limits across replicas.** The plan limit is checked one creation at a time per account in each Portal process;
  with several Portal instances two simultaneous creations could pass it by one (accepted, bounded by the creation
  rate limit). A creation Auth accepted but the Portal failed to record is not counted until an integration listing
  reconciles it, so the limit can also be passed by one for that time.

### Admin Changes From Auth

Agora.Build admins work on the admin site, which calls Auth directly. When an admin pauses, resumes or revokes an
integration, or disables or enables an account that owns integrations, the change happens at Auth first: from then on
Auth issues those integrations no token. The Portal then follows it, so that its history records it and the
integration's Station refuses still-valid tokens and closes open sessions at once.

- **The nudge.** Right after a change the Portal did not make (an admin's, or Auth's own, such as a built-in Station
  retired by its configuration), Auth sends `POST /auth/integration-changes` with no body and no credentials. The
  Portal answers 204 and reads Auth's change feed soon; it trusts nothing in the request. Like
  `/auth/backchannel-logout` it is server to server, so the same-origin checks of the `/api/` routes don't apply, and
  it is answered before any session lookup. Any other method answers 405, a request with a body 413 (the body is never
  read and the connection closes), more than 60 a minute from one address 429 (it still asks for a read, so Auth's
  real nudge is never lost to a forger who spends the allowance), and a Portal without Stations and integrations 404.
  Register it as the `portal` client's `changesNudgeUri` in Auth's clients file:
  `https://agora.build/auth/integration-changes` (dev `https://dev.agora.build/auth/integration-changes`). A nudge
  never starts the Stations and integrations stack: before it is ready the nudge does nothing, and the reader reads at
  once when it starts. Behind a proxy set `TRUST_PROXY=1` (see "Storage And Deployment"). Without it every nudge shares
  the proxy's address and its limit of 60 a minute, so a flood of forged nudges could make Auth's real ones answer 429
  and Auth log them as not accepted. Each of them still asks for a read, and the 30-second poll is there besides.
- **The feed.** The Portal reads `GET /manage/v1/integration-changes` over its management connection after each
  nudge, every 30 seconds in case a nudge is lost, and whenever it answers a resume with `admin_paused`. One read runs
  at a time, and reads start at least a second apart however many nudges arrive, so a forged nudge costs no more than
  an early poll. A read takes up to 10 pages of 100 changes and saves Auth's cursor after each page in
  `auth_change_feed`, so a restart continues where it stopped; when every page was full, another read follows. The
  server starts the reader in the background as soon as it listens (the stack is prepared then, and tried again after 5
  s, 10 s, 20 s and so on up to a minute while that fails). Its first read ever goes through Auth's whole feed once.
- **When a read fails** the cursor stays where it was and the next poll tries again, however long it lasts. The log
  names the reason once when it starts, then at most once an hour, and says once when reads work again:
  `Auth change feed read failed: <code>.` (Auth refused or was unreachable), `Auth change feed not available yet:
  <code>.` (Auth answered 404: this Auth has no feed yet, as when the Portal was deployed first),
  `Auth change not applied: <code>.` (a Portal database failure while following a change) and `Auth change feed failed:
  <code>.`. No cursor, admin or reason is logged. A read that began before a start-over (a reset, another replica's first
  start, a `cursor_ahead` or the older-image guard: "Account Availability") stops without applying or saving anything,
  and logs `Auth change pass superseded by a reset: read again.` each time. It can appear with `DELEGATED_HOST_WORK` off
  too, since the cursor's epoch fence doesn't depend on the setting. That is no failure, and no line says that reads work
  again after it.
- **Following a change.** Changes the Portal made itself (an account's pause, resume or revoke through the routes
  below) are in the feed too; they are already recorded and are skipped. For each other change the Portal updates its
  row, records an `integration_events` row with the admin as `actor` (`system` when Auth acted itself) and the reason
  given (or Auth's code, such as `configuration`), appends it to the Station's feed and pushes the Station. A pause
  pauses the integration and records who paused it (`paused_by`); a resume returns it to where it was; a revocation
  sets it to `revoking` (or `revoked` before approval), as an owner's does. An owner's account being disabled sets
  `owner_disabled_at` on each of its integrations that is not revoked and records `integration_owner_disabled`: the
  account page and the Station's feed show them `paused` until the account is enabled again
  (`integration_owner_enabled`), when each is back as it was (one its owner had paused stays paused). Each change is
  applied once: its Auth cursor and time are kept in the event's details. An integration that is already revoking or
  revoked is only recorded. A change for an integration the Portal does not know yet is dropped
  (the log says so); the owner's next listing brings the integration in, and the admin and the reason stay only in
  Auth's audit.
- **An admin's pause locks.** An integration Agora.Build paused shows "Paused by Agora.Build" (`pausedBy` `admin`, also
  while its owner's account is disabled) and offers no Resume. `POST /api/integrations/<id>/resume` answers 409
  `{ "error": "Agora.Build paused this integration. Only Agora.Build can resume it.", "code": "admin_paused" }` without
  asking Auth, and Auth answers the same when the Portal has not heard yet. Either way the Portal then reads the feed
  at once, so a lift it missed heals. A resume Auth accepted just before an admin paused the integration, whose pause
  the feed brought before the Portal recorded the resume, also answers 409 `admin_paused`: the integration stays
  paused, as Auth has it.
  While Agora.Build has the owner's account disabled, a resume answers 409 `owner_disabled`. Revoking, renewing, the
  quota and keys stay the owner's. Only an admin lifts the pause, on the admin site; the Portal follows the resume
  from the feed.
- **What people and Stations see.** The admin's account and the reason they typed stay in the Portal's events and in
  Auth's audit. An integration's history shows such a change as by `agora_build` (Agora.Build) without a reason, and
  the Station's feed gives it the `reason` `agora_build`. An owner's account being disabled reaches Stations as an
  Agora.Build pause, and its enabling as Agora.Build's lift: the Station's feed has `integration_paused` and
  `integration_resumed` with the `reason` `agora_build`, and a custom Station owner's history shows the same kinds by
  `agora_build`. Only the Portal's `integration_events` and the integration owner's own history name
  `integration_owner_disabled` and `integration_owner_enabled`.
- **Clocks.** A resume from the feed is recorded but not applied when the Portal already has a newer pause, resume or
  revocation of that integration (a pause or revocation always applies). That compares the change time Auth gives
  with times from the Portal's own clock, so keep Auth's and the Portal's clocks in sync (NTP). Skewed clocks could
  hold a resume back or let a late one through; the owner's next listing follows Auth again.
- **A stale owner-disabled flag.** The flag clears when Auth enables the account (the feed's `owner_enabled`), and
  also when Auth accepts a management call naming that owner as `actor` (Auth refuses a disabled account's calls, so
  an accepted one proves it is enabled). That heals a missed `owner_enabled`: the Portal records
  `integration_owner_enabled` (actor `system`, reason `reconciled`) and tells the Station, which sees Agora.Build's
  lift. To check by hand, compare the Portal's
  `SELECT id, owner_account, owner_disabled_at FROM integrations WHERE owner_disabled_at IS NOT NULL;` with Auth's
  `accounts.disabled_at` for those owners. A flag on an account Auth shows enabled is stale.
- **With `DELEGATED_HOST_WORK=1` (off by default):** the Portal follows four more kinds of Auth's feed, which Auth
  writes only with its own `AUTH_DELEGATED_HOST_WORK` on.
  - `interrupt_requested`: an admin asked to interrupt the running tasks of a revoked integration. The Portal sets the
    integration's `interruptRunning`, records `integration_interrupt_requested` with the admin as `actor`, appends it to
    the Station's feed and pushes the Station. A `revoked` entry now also carries `interruptRunning`: when it is true the
    Portal sets the choice too, also on an integration its owner revoked first (the revocation keeps its first time). The
    choice only ever goes from false to true.
  - `account_disabled` and `account_enabled`: an admin disabled or enabled an account. They name the account (`owner`)
    and no integration, and come ahead of the per-integration owner-disabled entries, which are followed as above. Auth
    also writes them, with no actor, as the corrections of its baseline (below). The Portal keeps each account's
    availability and, while it is live, each active built-in Station records one, once (an event with no integration), and
    is pushed; a custom Station never gets one, since an admin's action against a person is not disclosed to a Station's
    operator. With no built-in Station the log says `Auth account change skipped: no built-in Station.` and the
    availability is still kept.
  - `accounts_baseline`: each time Auth starts with its setting on, it writes a correction (an `account_disabled` or
    `account_enabled` with no actor) for every account whose state differs from its latest account entry, accounts
    disabled before the setting included, and then one baseline, if it wrote any correction or had never written one. It
    names no account and no integration. From a baseline on, Auth's feed alone says every account's state, and an account
    with no entry is enabled.
  - The three account-level kinds (`account_disabled`, `account_enabled` and `accounts_baseline`) are applied as the
    Portal's mode says: see "Account Availability" below. With the setting off the Portal skips `interrupt_requested`
    like any entry it does not know (`Auth change skipped: not a change entry.`) and its cursor moves past it. It skips the
    account-level kinds the same way, and also moves account availability to `waiting` (below).

#### Account Availability

**With `DELEGATED_HOST_WORK=1` (off by default):** the Portal applies Auth's account-level entries in Auth's order, never
by the entries' times (Auth's nodes' clocks may disagree). It keeps each account's availability in `account_availability`
(an account with no row is enabled, or doesn't exist), tells each active built-in Station, and says on the Station's
checkpoint whether its view is complete. The one row of `auth_change_feed` says how it follows them:

| `accounts_mode` | When | An account-level entry |
| --- | --- | --- |
| `rebuilding` | The Portal is reading Auth's feed from its first entry. A new Portal with the setting on starts here, and every start-over (below) returns here. | Applied to the rebuild's own tables only, once each. No Station is told, and the live table is left alone. |
| `live` | The rebuild has caught up with the end of Auth's feed. | Applied once, in one transaction with the changes of each active built-in Station, which are pushed after the commit. A failure rolls it all back, and the next read applies it. |
| `waiting` | The Portal skipped an account-level entry, so what it holds can't be trusted to be all of Auth's feed. A Portal that had already read Auth's feed when migration 006 ran starts here, and so does one whose cursor an older image moved while the setting was off (the older-image guard, below). | Skipped and not recorded. The log has the WAITING line (below) once for each read that skips one, and otherwise about once an hour. |

- **A start-over** happens on the first read (the Portal has no saved cursor), after a reset (below), when Auth answers
  409 `cursor_ahead`, and when the older-image guard (below) finds the cursor moved by an image from before migration 006.
  In one transaction it raises `accounts_epoch`, empties the cursor (and its copy) and the rebuild's tables, sets
  `rebuilding` and makes the view incomplete. The live table is not touched, so the Stations see no superseded state.
  Each start-over reads the whole feed again, in pages of 100 with at most 10 pages a read, so a long feed takes several
  reads, a second or more apart. A read with no saved cursor starts over each time, so while Auth's feed is empty, or
  while a first page keeps failing, every read starts over. That is harmless: the view is already incomplete, and the
  Stations are told nothing more.
- **Catching up.** When a read reaches the end of Auth's feed while `rebuilding`, in one transaction the Portal:
  1. compares the rebuild with the live table, and for each account whose state differs (an account missing from the
     rebuild counts as enabled) updates the live table and gives each active built-in Station one `account_disabled` or
     `account_enabled` change. The Stations hear only the differences, never the feed's history again;
  2. replaces the applied entries with the rebuild's, so that `live` skips exactly what the rebuild applied;
  3. if the rebuild applied an `accounts_baseline`, records it, makes the view complete and gives each Station one
     `accounts_baseline` change. Without a baseline (Auth's setting is off, or Auth has not written one) the view stays
     incomplete until a baseline is applied live;
  4. sets `live`.

  A failure rolls it all back and the next read does it. Several replicas may do it at once: the event lock lets the
  first one in and the others find nothing to do.
- **Live baseline.** In `live` a baseline that arrives while the view is not complete completes it and gives each Station
  one `accounts_baseline` change. One that arrives while it is complete is recorded and tells nobody.
- **Complete** means `account_baseline.complete`, which is the checkpoint's `accounts.complete`: the Portal is `live` and
  has applied an `accounts_baseline` in order, so an account missing from the disabled list is enabled. Every start-over
  and every move to `waiting` makes it false again, and the recorded baseline stays.
- **`accounts_incomplete`.** Each time the view goes from complete to not complete with the setting on (a start-over or a
  move to `waiting`) each active built-in Station gets one `accounts_incomplete` change, in the same transaction. It
  means: from here the Portal's view is not complete; the next `accounts_baseline` change says it is again.
- **The epoch fence.** A read pass applies account-level entries, and saves Auth's cursor, only in the epoch it began in.
  A pass still running when a start-over raises the epoch (a reset, another replica's first start, a `cursor_ahead` or
  the older-image guard) stops with `Auth change pass superseded by a reset: read again.` without applying or saving
  anything, and the next read goes on from the saved cursor in the new epoch. The line can follow any start-over, not only
  a reset, and can appear with the setting off too, since the cursor's epoch fence doesn't depend on the setting; don't
  alert on it. Integration entries are not fenced: each is applied once whatever the epoch. So a reset needs no replica
  stopped (below).
- **`waiting`** is where a skipped account-level entry leaves the Portal, and it stays there until the cursor is reset. An
  entry is skipped when its kind is not one the Portal follows (the setting is off), when it is not the shape Auth writes,
  or when it names a person as its actor without being an admin's (Auth never writes one). Nothing is forgotten and no
  availability changes, but the view is no longer complete, and if it had been, the Stations get `accounts_incomplete`
  once. A rebuild that meets the same entry again moves to `waiting` again, so the Portal fails closed until Auth's feed is
  fixed. **The WAITING line** is logged once for each read that skips an account-level entry while it waits, and at the
  end of a read that skips none at most once an hour in each Portal process, so a Portal that waits says so however quiet
  Auth's feed is:
  `Account availability waits for Auth's change feed to be read again from the start: reset the Portal's Auth cursor
  (docs/platform.md, "Resetting The Portal's Auth Cursor").`
- **The setting-off rule.** With the setting off the hooks do nothing, so the Portal neither rebuilds nor applies an
  entry. It still moves to `waiting` and clears the complete mark the first time it skips an account-level entry (and a
  Portal that has no row yet creates it in `waiting` when it first saves Auth's cursor). That, with the owed flag below,
  is all it records about accounts while the setting is off. Nothing is written to a Station then, so if the Stations had
  been told the view was complete, the Portal remembers it (`accounts_incomplete_owed`) and, the next time it runs with the
  setting on and is `waiting`, gives each of them one `accounts_incomplete` change at the end of a read. Turning the
  setting off while the Portal is `live` and complete changes nothing by itself: the entries Auth writes meanwhile are the
  ones that move it to `waiting`.
- **Auth restored from a backup.** A restore that leaves the Portal's cursor beyond Auth's newest entry answers 409
  `cursor_ahead`, and the Portal logs `Auth change feed cursor is ahead of Auth (restored from a backup?): reading the
  feed again from the start.` and starts over. The rebuild comes from the restored feed, so an entry the restore lost no
  longer has its effect: if it had disabled an account the Stations get an `account_enabled` for it, and if it had enabled
  one an `account_disabled`, then `accounts_baseline` once the rebuild has caught up. A restore the Portal cannot see
  (Auth wrote entries past the Portal's cursor before the Portal read again, so the cursor looks valid and the lost
  entries keep their effect) needs the reset below, as Auth's restore runbook says.
- **The older-image guard.** A Portal image from before migration 006 reads Auth's feed too, skips the account-level
  entries without applying them, and saves its cursor past them; it writes `auth_change_feed.cursor` alone. This image
  writes the same value to `accounts_cursor` every time it writes the cursor, so a cursor that differs from its copy was
  moved by an older image. With the setting on, the next read logs `Auth change feed cursor was moved by an older Portal
  image: account availability rebuilds.` and starts over, so the built-in Stations get `accounts_incomplete` if the view
  was complete, and the rebuild ends as Auth's feed says. With the setting off, the Portal moves to `waiting` as a skipped
  entry makes it (the setting-off rule, above), takes the cursor as it is and logs nothing new; it then needs the reset
  below. Never run such an image next to this one while the setting is on ("Rolling Back, And After Restoring Auth").
- **Log lines.** Besides the WAITING line, the older-image line and the superseded line, the Portal says how its view
  changes in counts only, never naming an account: `Account availability rebuilt: <n> accounts changed.` (`1 account`
  for one) when it adopts a rebuild that changed an account (`Account availability rebuilt: <n> accounts changed;
  complete.` when it completes the view, whatever the count; a rebuild that does neither, such as an empty feed's, says
  nothing), `Account availability complete.` when a baseline applied live completes it, and `Account availability
  incomplete: rebuilding.` or `Account availability incomplete: waiting.` when the built-in Stations are told the view is
  no longer complete.
- **Auth's setting off, the Portal's on.** The Portal can't tell that Auth's own `AUTH_DELEGATED_HOST_WORK` is off. Auth
  then writes no account entry when an admin disables an account (only the per-integration entries, which the Portal
  follows as pauses), so the Portal stays complete with that account missing from the disabled list, and a Station
  treats it as enabled. That happens when the settings are turned off in the wrong order, or when Auth is rolled back to
  an image without the setting. That is why Auth's setting goes on first and off last ("Turning On Delegated Host Work").

#### Resetting The Portal's Auth Cursor

A reset makes the Portal read Auth's whole feed again from its first entry. Changes it already applied are recognised and
skipped, so reading again is safe. With the setting on it also starts account availability over (a rebuild, above). Run
this on the Portal's database:

```sql
UPDATE auth_change_feed SET cursor = NULL, accounts_cursor = NULL, accounts_epoch = accounts_epoch + 1;
```

- **No replica needs stopping.** Raising the epoch fences any read that began before it: it applies no account entry and
  saves no cursor (`Auth change pass superseded by a reset: read again.`), and the next read starts over. Emptying
  `accounts_cursor` with the cursor keeps the reset from being taken for an older image's write (the older-image guard).
  It works whatever the setting. The older plain forms (`UPDATE auth_change_feed SET cursor = NULL;`, and the same with
  the epoch raised but `accounts_cursor` left alone) still work, but a read already in flight can undo the cursor-only
  form by saving its cursor again, and with the setting on either old form logs the older-image line once (with it off,
  the guard moves the Portal to `waiting`).
- **The setting must be on for accounts.** A reset made while the setting is off re-reads the feed and does nothing for
  account availability: the hooks do nothing then, so a Portal in `waiting` stays there. Reset once every replica runs
  with the setting on: a replica still running with it off skips the account entries again and moves the Portal back to
  `waiting`.
- **When it is needed.**
  - The log has the WAITING line.
  - The first time the setting is turned on after migration 006: every Portal that had read Auth's feed before it starts
    in `waiting` ("Turning On Delegated Host Work").
  - After the setting has been off while Auth's was on, if the Portal then is in `waiting`.
  - After any window with mixed Auth versions, and after a restore of Auth the Portal could not detect (above).
- **To check it,** once the reader has caught up (the log has no `Auth change feed read failed` line):
  `SELECT accounts_mode, accounts_epoch, accounts_incomplete_owed FROM auth_change_feed;` says `live`, a new epoch and `f`,
  and `SELECT complete FROM account_baseline;` says `t` once the Portal has applied an Auth baseline. `f`, or no row, means
  the view is incomplete (Auth's setting is off, or it has not started since): the right answer until Auth writes one.

#### Rolling Out Admin Changes (Dev First)

Dev Auth is one node. Production follows only after the admin site and passkeys are verified on dev, with the owner's
approval.

1. **Owner sign-off.** From step 3 until the admin site is live (step 7), admins cannot pause or revoke others'
   integrations anywhere: Auth refuses the D24 Portal's admin calls (403), the D26 Portal does not offer them, and the
   admin site does not exist yet.
2. **Keep the way back.** Tag the running images (`portal:pre-d26`, `auth:pre-d26`), copy Auth's current clients file,
   and dump the Portal's and Auth's databases.
3. **Deploy Auth D26** (`feat/admin-mfa`) with the D24 clients file unchanged. Check that Auth starts and signs people
   in, and that the Portal still lists Stations and integrations for an ordinary account.
4. **Passkeys.** At least two of the built-in Station's admins add passkeys at Auth. A lost passkey can only be reset by
   another admin on the admin site, so a single admin who loses theirs is locked out.
5. **Deploy the Portal D26.** Migration 003 runs when the server starts. Set `TRUST_PROXY=1` behind the proxy. The
   reader starts with an empty cursor and reads Auth's whole feed once. Check that the log has no `Auth change feed
   read failed`, `Auth change feed not available yet` or `Built-in Station sync failed` line, and that
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dev.agora.build/auth/integration-changes` prints 204 and
   the same without `-X POST` prints 405. On the Portal's database `SELECT version FROM portal_migrations;` lists
   `003_auth_changes.sql`, and after the first read `SELECT cursor IS NOT NULL, updated_at FROM auth_change_feed;`
   shows `t` and the time of that read (`f` while Auth's feed has no change yet). `PLATFORM_ADMINS` may stay set: it
   now only affects Stoa spaces.
6. **Register the nudge and the admin client.** Back up Auth's clients file, add `changesNudgeUri`
   (`https://dev.agora.build/auth/integration-changes`) to the `portal` client and the `admin` client entry with its
   secret setting `ADMIN_CLIENT_SECRET` (the name only; the value goes into Auth's settings file, never into a
   document), and restart Auth. Add `changesNudgeUri` only once the Portal serves its nudge (step 5) and the `admin`
   entry only once the reader runs. Auth logs no "the Portal did not accept a change nudge" or "a change nudge did not
   reach the Portal". From Auth's host, over the public path its nudge takes,
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dev.agora.build/auth/integration-changes` prints 204.
   Confirm that the last `X-Forwarded-For` hop the Portal gets (the one `TRUST_PROXY=1` uses) is the one its proxy
   appends, the address that connected to the proxy, so Auth's host has its own nudge allowance.
7. **Deploy the admin site.**
8. **Live checks with Astation.** With integrations on for the dev built-in Station and a disposable integration, an
   admin's pause on the admin site shows in the Station's feed within seconds, the owner sees "Paused by Agora.Build"
   with no Resume, the admin's lift and revocation follow, and so do disabling and enabling the owner's account.

Alert on the reader's log lines `Auth change feed read failed`, `Auth change not applied` and, once Auth D26 runs,
`Auth change feed not available yet`. While the reader is stalled an admin's change holds at Auth, which issues the
integration no new token, but the Station is not told: an admin's pause is then enforced only by token expiry (at most
300 seconds). With `DELEGATED_HOST_WORK=1` also alert on `Account availability waits for Auth's change feed…`: until an
operator resets the cursor, the Portal follows no account change and the built-in Station's view is incomplete. While it
waits the line comes with every read that skips an account entry and otherwise about once an hour, so an alert that looks
back over more than an hour (65 minutes, say) always finds it. Alert as well on `Auth change feed cursor was moved by an
older Portal image` (an image from before migration 006 is running: "Rolling Back, And After Restoring Auth"). `Auth change
pass superseded by a reset: read again.` can follow any start-over, not only a reset, with the setting on or off, and is
not a failure: don't alert on it.

Pauses an admin made through the D24 Portal's admin views, before Auth's migration 009, are not locks in the Portal
either: Auth recorded nobody as their pauser, so `paused_by` is NULL and the owner may resume them. Pause again on the
admin site any that should stay locked (`SELECT id, owner_account FROM integrations WHERE state = 'paused' AND paused_by
IS NULL;` on the Portal lists them, with owners' pauses from before Auth recorded who paused).

If Auth ever runs more than one node, upgrade all of them before the Portal's reader reads from it: an older node
writes pause and revoke rows without the feed lock, so a reader could skip one. Then set the Portal's cursor back once (the
statement in "Resetting The Portal's Auth Cursor"); changes it already applied are recognised and skipped, so reading
again is safe. Do not use the admin site while any Auth node runs an image from before the change
feed. If the Portal is deployed before Auth, its reader logs `Auth change feed not available yet: not_found.` and the
built-in sync `Built-in Station sync failed: not_found.` each minute until Auth has both; Stations already in the
Portal keep working.

#### Rolling Back, And After Restoring Auth

- **Rolling back only the Portal.** First take the admin site down, or remove the `admin` client from Auth's clients
  file and restart Auth. A Portal without the feed reader never hears of an admin's change: it stops at Auth's refusal
  of the integration's tokens, and the Station is not told.
- **Roll Auth and the Portal back together.** Run `portal:pre-d26` (D24, commit `02e52ca`; it needs `PLATFORM_ADMINS`
  set, since it syncs built-in Stations by listing as the first admin) and `auth:pre-d26` with the clients file Auth ran
  before. Mixed versions break things:
  - The D24 Portal has no feed reader and answers Auth's nudge with 405; Auth logs that it was not accepted. Migration
    003 only added columns and a table, which that image ignores, so on D24 owner-disabled flags and admin pause marks
    are invisible. Back on D26 the Portal continues from its saved cursor and catches up, and an owner's listing
    corrects a `paused_by` that is out of date; then run the stale-flag check by hand ("A stale owner-disabled
    flag").
  - The D24 Auth has no `/manage/v1/built-in-stations` or feed (404), so a D26 Portal on it logs the two `not_found`
    lines above and syncs nothing new.
  - The D24 Auth refuses a clients file that contains the `admin` client or `changesNudgeUri`, so restore the previous
    file together with the image.
- **After Auth's migration 009** an older Auth image cannot resume an integration an admin paused: it answers 500 and
  the Portal shows "Auth is unavailable". Until Auth rolls forward again an admin's pause cannot be lifted (revoking
  and the settings still work, and so does resuming any other pause). Auth's rollback does not undo that migration.
- **After any window with mixed Auth versions, and after restoring Auth's database** from a backup, set the Portal's
  cursor back with the statement in "Resetting The Portal's Auth Cursor". Auth hands out cursors again from the backup's
  point. A cursor beyond Auth's newest change answers 409 `cursor_ahead`, and the Portal then logs a warning, forgets its
  cursor and reads the feed from the start by itself (with the setting on it rebuilds account availability too, and the
  built-in Stations hear only what changed: "Account Availability"). A cursor that new changes have since passed looks
  valid and would skip changes, so reset it by hand after every restore.
- **After restoring the Portal's database** the Stations' own feed refuses an old cursor (see "Cursors"). The reader
  continues from the backup's cursor and applies again, by itself, the admin changes Auth made since the backup.
- **Never run a Portal image from before migration 006 next to this one while `DELEGATED_HOST_WORK=1` is on**, in a
  rolling deploy or a rollback. The older image reads Auth's feed too, skips the account-level entries unrecorded and
  saves its cursor past them, so this image's view of the accounts could say complete with an admin's disable missing.
  The older-image guard ("Account Availability") catches it: this image writes a copy of the cursor in `accounts_cursor`,
  and a cursor that differs from it was moved by an older image. An operator then sees `Auth change feed cursor was moved
  by an older Portal image: account availability rebuilds.` on this image's next read, which starts account availability
  over (the built-in Stations get `accounts_incomplete`, then `accounts_baseline` once the rebuild has caught up). While
  both images run the line comes back after each of the older image's saves and the view keeps rebuilding, so finish the
  deploy or the rollback first. After a rollback to such an image and forward again, the line shows once and nothing else
  is needed. With the setting off the guard moves the Portal to `waiting` instead, silently, and the cursor needs the
  reset once every replica runs with the setting on.

#### Turning On Delegated Host Work

**With `DELEGATED_HOST_WORK=1` (off by default):** turn the setting on only for the joint dev check. The account page's
pause and expiry copy describes how hosts treat accepted work, which arrives with the hosts' and the Station's builds, so
until then it describes behaviour nothing has yet. Turn the three settings on in this order:

1. **Auth first.** Turn on Auth's `AUTH_DELEGATED_HOST_WORK`. The Portal sends `interruptRunning` to Auth only when it is
   `true` (an unticked revoke sends exactly what it sent before the setting, and Auth records a missing choice as
   `false`), and an Auth with its setting off refuses that unknown field with 400. So with the Portal's setting on and
   Auth's off, only a revoke that asks to interrupt fails, with Auth's 400; every other call works.
2. **Then the Portal.** Set `DELEGATED_HOST_WORK=1` and restart it, every replica on an image with migration 006: never
   leave one from before it running next to them while the setting is on (the older-image guard logs `Auth change feed
   cursor was moved by an older Portal image: account availability rebuilds.` and keeps starting account availability
   over; "Rolling Back, And After Restoring Auth"). Migrations 004 and 006 run when the server starts, whatever the
   setting. While the setting was off the reader skipped Auth's new entries (an admin's interrupt requests and account
   changes) and moved past them, and migration 006 put the Portal's account availability in `waiting` (it had read
   Auth's feed already), so with the setting on it follows no account entry yet and logs the WAITING line, with its first
   read and then about once an hour. Reset the cursor once every replica runs with the setting on (the statement, and
   what it does, are in "Resetting The Portal's Auth Cursor"):
   `UPDATE auth_change_feed SET cursor = NULL, accounts_cursor = NULL, accounts_epoch = accounts_epoch + 1;` on the
   Portal database. Reading again is safe, since changes it applied are recognised and skipped, and no replica needs
   stopping. The Portal then rebuilds account availability from Auth's first entry, and each built-in Station hears only
   the differences from what it was told before, then `accounts_baseline` once the rebuild has caught up with Auth's feed;
   the interrupt requests skipped while the setting was off come in too. To check it, once the reader has caught up, read
   `SELECT accounts_mode FROM auth_change_feed;` (`live`) and `SELECT complete FROM account_baseline;` (`t`, once Auth's
   baseline has been applied), and count what each built-in Station holds:
   `SELECT station_id, kind, count(*) FROM integration_events WHERE kind IN ('account_disabled', 'account_enabled', 'accounts_baseline', 'accounts_incomplete') GROUP BY station_id, kind;`
   On the first turn-on that is, on each built-in Station, one `account_disabled` for each account that
   `SELECT count(*) FROM account_availability WHERE disabled;` counts, and one `accounts_baseline` (no `account_disabled`
   rows, if Auth has disabled none; no baseline, if Auth has written none).
3. **Then the admin site's** `DELEGATED_HOST_WORK`.

Turn them off in the reverse order, the admin site's first and Auth's last: the admin site's setting must be off
whenever the Portal's is. After every change of the Portal's setting from off to on while Auth's stays on, read
`accounts_mode` as in step 2 and, if it says `waiting`, repeat step 2's reset: while the Portal's setting is off and
Auth's is on, the Portal skips the account entries and moves to `waiting`, and the built-in Station's view of disabled
accounts goes stale ("Account Availability").

Phase B's revocation reports ("For Station Builders") need nothing beyond the Portal's own setting: it takes them whenever
it is on, whatever Auth's and the admin site's are. Turn it on before a Station sends them. With the setting off the
Portal refuses a body with a `reportId` as 400 `report`, which a Station treats as final: it alerts and never sends that
report again. A final report refused that way leaves its integration `revoking`, because the Portal runs no clock; a
legacy `revoked` report with no `reportId` ends it. The same holds for the Station directory, the checkpoint and the two
binding reports: they need the Portal's own setting only. Account availability also needs Auth's baseline; without it the
checkpoint says `accounts.complete` is `false` and a Station fails closed.

Known Phase A limits:

- The cursor-0 `disabledAccounts` (see "For Station Builders") lists the accounts disabled now, as the Portal's
  availability table has them, but carries no completeness mark: a Station that has to know whether an account missing
  from it is enabled reads the checkpoint, whose `accounts.complete` says so. Accounts disabled before Auth recorded
  account entries are covered by Auth's baseline, once the Portal has applied it ("Account Availability").
- A `revoked` entry the Portal followed while its setting was off is not applied again, so an admin's revocation that
  asked to interrupt running tasks stays recorded in the Portal as not interrupting. This happens only if the order above
  is broken (the admin site's setting on while the Portal's is off). An admin's later Interrupt running tasks is no
  remedy: Auth already holds the revocation's `interrupt_running: true` as asked, so it answers `changed: false` and writes
  no feed entry, and the Portal never hears of it. The remedy is within 24 hours of the revocation: the integration's
  owner (or the owner of its custom Station) uses Interrupt running tasks on the account page, since the Portal's row
  still says `false`. The Portal records it and pushes the Station; after 24 hours it refuses (409 `too_late`).

If the setting is turned off again, what was recorded while it was on stays, and is served as recorded: the Station feed
keeps its entries, but `interruptRunning` is no longer carried, neither on changes nor on `integration` objects, and
`disabledAccounts` is not served. Account events (the baseline and incomplete changes too) and the
`integration_interrupt_requested` kind are still served, since the feed reports what was recorded, as Auth's does. Readers
skip kinds they don't know. The hosts, final outcomes and report ids recorded stay in the database, but no view shows
`revocation` any more, and a body with a `reportId` is 400 `report` again, a retry of a report already recorded included:
the setting is read before the id is looked up. A final report refused then leaves its integration `revoking`, because the
Portal runs no clock; a legacy `revoked` report with no `reportId` ends it. The account availability, bindings and binding
attempts recorded stay in the database too, but nothing serves them: `?checkpoint=1` is ignored, `GET /api/v1/stations`
answers 404, a binding report is 400 `report`, and the account page has no notices. While the setting is off, the first
account-level entry the Portal reads moves it to `waiting` ("Account Availability").

### Routes

Browser routes use the session cookie and are not accepted with tokens. Request
bodies are JSON of at most 16 KB. Errors are `{ "error": "<message>" }` and, where
the Portal has one, `"code"` (and for a failed proof, `"reason"`).

| Route | Who | What |
| --- | --- | --- |
| `GET /api/stations` | browser | the account's Stations (`role` `built_in`, `owner` or `member`) |
| `POST /api/stations/challenges` `{ origin }` | browser | issue a proof value; 201 `{ challengeId, origin, value, url, expiresAt }`; 10 per hour |
| `POST /api/stations` `{ challengeId, reportKey }` | browser | check the proof, register with Auth; 201 with the Station |
| `DELETE /api/stations/<id>` | browser | remove (owner only); revokes its integrations |
| `GET /api/stations/<id>/members` | browser | owner and members |
| `PUT`, `DELETE /api/stations/<id>/members/<ab...>` | browser | share (owner only) and unshare (the owner, or a member removing themself); unsharing revokes that member's integrations there |
| `POST /api/stations/<id>/read-token` | browser | a 5-minute `station.read` token for that Station: `{ accessToken, expiresIn, origin }` |
| `POST /api/integrations` `{ stationId, name, scopes, publicJwk, quotaPerSecond, expiresInDays }` | browser | create; 201; on a built-in Station: only while its integrations are on, within the plan limit |
| `POST /api/integrations/<id>/keys` `{ publicJwk }` | browser | add a key; 201 `{ kid, overlapEndsAt }` |
| `POST /api/integrations/<id>/pause`, `resume`, `revoke` | browser | pause and revoke also by the owner of the integration's custom Station |
| `POST /api/integrations/<id>/renew` `{ expiresInDays }` | browser | new expiry counted from now; an expired one on a built-in Station within the plan limit |
| `POST /api/integrations/<id>/settings` `{ quotaPerSecond }` | browser | change the quota |
| `GET /api/integrations/<id>/events` | browser | history (`actor` is `you` for your own changes) |
| `GET /api/integrations` | browser | the account's integrations, and others on custom Stations it owns |
| `GET /api/v1/integrations` | token, `integrations:read` | the same list |
| `POST /api/v1/integrations/<id>/approval` `{ r9Svc }` | token, `integrations:approve` | native approval; `r9Svc` is 64 lower-case hex characters |
| `POST /api/v1/stations/reports` | token, `station.report` | a Station's report |
| `GET /api/v1/stations/changes?cursor=` | token, `station.report` | the Station's change feed |

**With `DELEGATED_HOST_WORK=1` (off by default):**

| Route | Who | What |
| --- | --- | --- |
| `POST /api/integrations/<id>/revoke` `{ interruptRunning }` | browser | revoke, saying whether to also interrupt the tasks running on the owner's hosts now (true or false); the body is required. On an integration that is already revoking or revoked, `true` adds the interrupt as `interrupt` does and `false` changes nothing (see the native revoke below) |
| `POST /api/integrations/<id>/interrupt` | browser | interrupt those tasks later, within 24 hours of the revocation; by the integration's owner or the owner of its custom Station |
| `POST /api/v1/integrations/<id>/revoke` `{ interruptRunning }` | token, `integrations:approve` | Astation revokes the token's account's own integration, with the same body |
| `POST /api/v1/stations/reports` `{ integrationId, state: "revocation_applied", reportId, host, recordId }` or `{ integrationId, state: "revoked", reportId, outcome, pendingHosts }` | token, `station.report` | the Station's two revocation reports: one for each host that applied a revocation, and the final one (the forms below); with a `reportId` only |
| `GET /api/v1/stations?limit=&cursor=` | token, `integrations:read` | the Station directory: the Stations the account can use and those it lost in the last 30 days, in pages (below) |
| `GET /api/v1/stations/changes?checkpoint=1` | token, `station.report` | the Station's whole state at one exact cursor (below, and "For Station Builders") |
| `POST /api/v1/stations/reports` `{ state: "binding_changed", reportId, account, accountId, genesisHash, bindingId, version, bindingState }` or `{ state: "binding_attempt", reportId, account, accountId, genesisHash, reason, attemptedAt }` | token, `station.report`, the built-in Station only | the built-in Station's two binding reports (below) |

- The choice is kept on the integration and in the revoke event. It goes to Auth only when it is `true`: an unticked
  revoke sends Auth what it sent before the setting, and Auth, with its own setting on, records a missing choice as
  `false`. So an unticked revoke works even while Auth's setting is still off, and only a ticked one fails then, with
  Auth's 400. The routes still require the boolean: a request whose Content-Type is missing or not JSON is 415, one with
  a JSON content type and an empty body (or a body that is not a JSON object) is 400 ("This request is not valid JSON."),
  and a missing or non-boolean `interruptRunning` is 400 `interrupt_running` ("Say whether to interrupt running tasks:
  send interruptRunning as true or false."), answered before the integration is looked up and before Auth is asked.
  Pause and resume still take no body. Revocations the Portal makes for someone else (a member removed, a Station
  removed, an integration Auth no longer lists) never interrupt: they record `false`. A revocation the Portal first saw
  in Auth's listing records `false` too, but Auth's own entry for it may later raise it to `true`; the choice only ever
  goes from `false` to `true`, and `integration.interruptRunning` is the current one.
- `interrupt` takes no body and answers the integration. It needs a revoking or revoked integration (else 409
  `invalid_state`: "Only a revoked integration's running tasks can be interrupted.") and at most 24 hours since
  `revokedAt`, 24 hours exactly included (else 409 `too_late`: "Running tasks can be interrupted only within 24 hours of
  the revocation."). An integration revoked before migration 004 has no `revokedAt` and is too late. An account that
  may not see the integration gets 404. Asking again once it is interrupted, even after the 24 hours, answers the same
  and changes nothing. Auth is not asked: the Portal records it (`integration_interrupt_requested`, with `owner` or
  `station_owner` as the reason, and, when Astation's native revoke added it, the app's `clientId` in its details) and
  pushes the Station. It shares the limit of 30 changes a minute given below. An owner's interrupt is recorded only in
  the Portal, so an admin may interrupt again on the admin site, and the Station may get a second
  `integration_interrupt_requested`. That is harmless, because the choice only goes from `false` to `true`.
- An integration whose Station has been removed can't be interrupted: 409 `station_removed` ("This integration's Station
  has been removed, so its running tasks can't be interrupted here."). A removed Station never reads its feed again, so
  the request would reach no host. One that was already interrupted still answers 200 and changes nothing, so a retried
  request is harmless; only a request that would change something is refused, and the 24-hour check follows. Atem's design (I.8) describes a native path for removed Stations: the Station issues
  and serves its revocation records before the removal completes, or, if it can't, the Portal marks the integrations
  "pending host revocation" and Astation offers the owner native `revoke` records. That path is not built in Phase A:
  removing a Station records its integrations' revocations as indirect ones, with no interrupt, and the account page's
  confirmation says only that tasks already running on hosts continue.
- The native revoke is for the integration's owner only: any other account, the custom Station's owner included, gets 404.
  Errors, answer and limit are the browser's; the event records the app's client ID. A token on the unversioned path gets
  the usual `/api/v1` 404, and a token without `integrations:approve` 403 `insufficient_scope`.
- **A revoke of an integration that is already revoking or revoked**, from either route, answers as below and revokes
  nothing again, but its choice is not lost, so Astation's mirror of a manager's "revoke and interrupt" converges even
  when another actor's revoke without the interrupt reached the Portal first. A 409 `too_late` or `station_removed` from
  such a revoke still means the integration is revoked:
  - with `interruptRunning: true`, it adds the interrupt as `interrupt` does, once, with the same rules: the answer's
    `interruptRunning` is `true`, `integration_interrupt_requested` is recorded (for the native route with the app's
    `clientId` in its details), the Station is pushed, and Auth is not asked for it. It is refused as `interrupt` is,
    and the Portal's record stays as it was: 409 `too_late` after the 24 hours, 409 `station_removed` for a removed
    Station's integration. This also holds when the other revocation commits while this call is at Auth, after Auth
    accepted it; there Auth may already hold this call's own `interrupt_running: true` when the Portal answers 409
    `station_removed`, which is harmless, because a removed Station reads no feed;
  - with `interruptRunning: false`, it changes nothing and never undoes a `true`;
  - the answer's `interruptRunning` says what is recorded, so a retry after a lost reply or a restart answers the same
    and writes nothing more;
  - no new authority: the native route stays the integration owner's alone, and the browser's stays the owner's and the
    custom Station's owner's, the accounts that may call `interrupt`;
  - **the 24 hours** count from the first revocation (`revokedAt`), whoever made it, as `interrupt`'s do, and exactly 24
    hours is allowed. For a mirror that arrives late, 409 `too_late` is final: the mirror can treat it as settled. By
    then every task of the integration has passed its deadline (Atem's design, I.4.4), and the native signed stop
    carries its own choice to the hosts. 409 `station_removed` is final too: a removed Station reads its feed no more,
    so the record could reach no host.
- A revoking or revoked integration's view (the lists, and the answers above) also has `revokedAt` (its time, or null) and
  `interruptRunning`, and `stationRemoved: true` when its Station has been removed (the account page then offers no
  Interrupt running tasks).
- **The Station's two revocation reports** (D29 Phase B). With the setting on, `POST /api/v1/stations/reports` also takes
  these, each with a `reportId`; when to send them is in "For Station Builders":
  - `{ "integrationId", "state": "revocation_applied", "reportId", "host", "recordId" }`: the host `host` has applied the
    revocation, as the record `recordId` says;
  - `{ "integrationId", "state": "revoked", "reportId", "outcome", "pendingHosts" }`: the final report. `outcome` is
    `all_applied` with `pendingHosts` `[]`, or `deadline_passed` with the hosts that didn't confirm.

  A `revoked` report with no `reportId` is today's report, unchanged. One with a `reportId` must carry `outcome` and
  `pendingHosts`. `reason` is not allowed with the new fields. With the setting off every new field is an unknown field
  (400 `report`, with today's message). With it on, `state` also accepts `revocation_applied` (and its 400 message lists
  it). The report is validated in this order (400, with the code): its shape, `state`, `reportId`, then the kind's fields.

  | Code | Refused when | Message |
  | --- | --- | --- |
  | `report` | a field outside `integrationId`, `state`, `reason`, `reportId`, `host`, `recordId`, `outcome` and `pendingHosts`; the new fields with no `reportId`; a `reason` with a `reportId`; the fields of both forms together; fields that don't fit the state: `outcome` or `pendingHosts` with `revocation_applied`, `host` or `recordId` with `revoked`, a `reportId` with any other state | "Send a report as { integrationId, state, reason }, { integrationId, state: "revocation_applied", reportId, host, recordId } or { integrationId, state: "revoked", reportId, outcome, pendingHosts }." |
  | `report_id` | `reportId` missing (with `revocation_applied`), or not 1 to 128 characters of `[A-Za-z0-9._:-]` | "Send the reportId as 1 to 128 characters of letters, digits, '.', '_', ':' or '-'." |
  | `host` | `host`, or an entry of `pendingHosts`, missing or not a host id: 1 to 128 characters of `[A-Za-z0-9._:-]`, the grammar of the device list's host ids | "Name the host by its id: 1 to 128 characters of letters, digits, '.', '_', ':' or '-'." |
  | `record_id` | `recordId` missing or not a lowercase UUID v4 | "Send the recordId as the record's lowercase UUID." |
  | `outcome` | `outcome` or `pendingHosts` missing, or neither `all_applied` with `[]` nor `deadline_passed` with 1 to 100 distinct hosts | "Send all_applied with no pendingHosts, or deadline_passed with the hosts that didn't confirm." |

  `pendingHosts` holds at most 100 hosts, since a device list holds at most 64; 100 hosts of 128 characters still fit in the
  16 KB body. The entries are checked against the host grammar (`host`) before the combination (`outcome`). The Portal
  checks only the characters and length of `reportId`; it is opaque to it.
- **What each report does.** The answer to every accepted report is the integration as its Station sees it, as for today's
  reports, without `role`, `pausedBy`, `revokedAt`, `interruptRunning`, `stationRemoved` or `revocation`. A refusal because of
  the integration's state is 409 `invalid_state`.
  - `revocation_applied` needs the integration to be `revoking` or `revoked` ("This integration isn't revoked."). Each host
    is counted once: the first report for a host records it with its `recordId` and `reportId`; a later report for it,
    under another `reportId`, is 200, counts nothing again and is kept under its own id. One that comes after a
    `deadline_passed` final records the host too, so that host no longer counts as unconfirmed; the integration stays
    revoked. It records no event and pushes nothing to the Station.
  - The final `revoked` moves a `revoking` integration to `revoked`, as today's report does (it also clears `lastError`),
    records `outcome` and `pendingHosts`, and records an `integration_reported` event (actor `station`; its details name
    the outcome and how many hosts the report listed, never a host). On a `revoked` integration with no final outcome yet
    (a legacy `revoked` came first) it records the outcome and no event. Once a final outcome is recorded under another
    `reportId` it is refused: "This integration's revocation already has its final report." On a live, paused, waiting or
    expired integration it is refused as today's `revoked` report is.
  - An integration of another Station, or an unknown one, is 404, as for any report. A refused report records no id.
  - The `reportId` is looked up before the integration, so an id already used for another integration is 409
    `report_id_reused`, not 404.
- **The counts the views show.** With the setting on, a revoking or revoked integration's view has, wherever it has
  `revokedAt`, `revocation: { appliedHosts, outcome, unconfirmedHosts }`.
  - `appliedHosts` is the number of hosts recorded;
  - `outcome` is the final outcome, or `null` until there is one;
  - `unconfirmedHosts` is, with `deadline_passed`, the number of `pendingHosts` not recorded since, else `null`.

  A revoking integration nobody has reported on shows `{ appliedHosts: 0, outcome: null, unconfirmedHosts: null }`. Host
  names are never shown, in a view, the history or the Station's feed. The Station's feed and a report's answer carry no
  `revocation`.

- **The Station directory** (D29, [issue 40](https://github.com/Agora-Build/Portal/issues/40)): `GET /api/v1/stations`, for
  Astation's apps. A bearer access token whose audience is the Portal and whose scope includes `integrations:read`; the
  account is its `sub`. A token without the scope is 403 `insufficient_scope`, and a Station's own report token is refused.
  The cookie route is never needed: a token on the unversioned `/api/stations` is 404 "Access tokens use the versioned API:
  /api/v1/stations.", and a cookie with no token on `/api/v1/stations` is answered with the browser's list, as it is on
  `/api/v1/integrations`, so the directory needs a token. It is `GET` only.
  - **Query.** `limit` is a whole number from 1 to 100, and 100 when it is not sent. `cursor` is the opaque `nextCursor` of
    the page before. An empty `limit=` or `cursor=` is a mistake (400), not a missing parameter. Any other parameter is
    ignored. Both are checked before Auth is asked, the limit first:

    | Code | Refused when | Message |
    | --- | --- | --- |
    | `limit` | not a whole number from 1 to 100: `0`, `101`, `1.5`, `abc`, empty | "Choose a limit of 1 to 100." |
    | `cursor` | not a cursor this list gave: any other text, or one that was changed | "Send the cursor this list gave you." |

  - **The answer.** Each page asks Auth for the account's Stations first, as the browser's list does, so use the default
    limit and page only when the list is longer than 100. The limit is 60 lists a minute for an account, shared with
    `GET /api/stations`.

    ```json example:directory
    {
      "stations": [
        {
          "id": "st01KB4K8W3Z5Q7R2T9X1C6D4FGH",
          "origin": "https://station-dev.agora.build",
          "name": "Agora Station",
          "builtIn": true,
          "access": "any_account",
          "role": "built_in",
          "status": "active",
          "removedAt": null,
          "membership": null,
          "membershipEndedAt": null,
          "integrationsEnabled": true,
          "createdAt": "2026-10-31T18:20:41.512Z"
        },
        {
          "id": "st01KB4MR0E2S8V3N6P5J7A1BDXZ",
          "origin": "https://station.example.net",
          "name": null,
          "builtIn": false,
          "access": "members",
          "role": "owner",
          "status": "active",
          "removedAt": null,
          "membership": null,
          "membershipEndedAt": null,
          "integrationsEnabled": true,
          "createdAt": "2026-11-01T08:00:00.000Z"
        },
        {
          "id": "st01KB4NS6F4T9W2Y8Z1B3C5DGJ7",
          "origin": "https://shared.example.org",
          "name": null,
          "builtIn": false,
          "access": "members",
          "role": "member",
          "status": "active",
          "removedAt": null,
          "membership": "ended",
          "membershipEndedAt": "2026-11-20T09:15:00.000Z",
          "integrationsEnabled": false,
          "createdAt": "2026-11-02T08:00:00.000Z"
        },
        {
          "id": "st01KB4P1H7V3X9C5M2R8T6Z4YQ0",
          "origin": "https://old.example.net",
          "name": null,
          "builtIn": false,
          "access": "members",
          "role": "owner",
          "status": "removed",
          "removedAt": "2026-11-21T14:30:12.044Z",
          "membership": null,
          "membershipEndedAt": null,
          "integrationsEnabled": false,
          "createdAt": "2026-11-03T08:00:00.000Z"
        }
      ],
      "nextCursor": null,
      "stale": false,
      "complete": true
    }
    ```

    The same list with `?limit=1`, the first page (the cursor is the base64url of `[builtIn, createdAt, id]` of its
    last Station, and means nothing else; send it back as it came):

    ```json example:directory-page
    {
      "stations": [
        {
          "id": "st01KB4K8W3Z5Q7R2T9X1C6D4FGH",
          "origin": "https://station-dev.agora.build",
          "name": "Agora Station",
          "builtIn": true,
          "access": "any_account",
          "role": "built_in",
          "status": "active",
          "removedAt": null,
          "membership": null,
          "membershipEndedAt": null,
          "integrationsEnabled": true,
          "createdAt": "2026-10-31T18:20:41.512Z"
        }
      ],
      "nextCursor": "W3RydWUsIjIwMjYtMTAtMzFUMTg6MjA6NDEuNTEyWiIsInN0MDFLQjRLOFczWjVRN1IyVDlYMUM2RDRGR0giXQ",
      "stale": false,
      "complete": false
    }
    ```

  - **Fields.**
    - `id` is the Station's stable identity, and `origin` the normalized origin, the one Auth and the Portal compare.
    - `name` is `null` for a custom Station. `access` is `any_account` (the built-in Station) or `members`.
    - `role` is `built_in`, `owner` or `member`. `status` is `active` or `removed`, and `removedAt` is set when it is
      `removed`.
    - `membership` is `current` or `ended` for a member, and `null` for the owner and the built-in Station.
      `membershipEndedAt` is set when it is `ended`.
    - `integrationsEnabled` says whether an integration can be created there now. It is `false` on a removed Station and
      for a member whose membership ended.
    - It never carries the Station's report client, its owner, its members or anything of R9. There is no `suspended`
      status: Agora.Build disabling an account is account-level, and such an account gets no token.
  - **Which Stations.** Every Station the account can use now (the built-in Station, those it owns and those it is a
    member of) and every one it lost in the last 30 days, the Station records' own retention, with the loss stated: a
    Station it owned or belonged to that was removed is `status: "removed"` with `removedAt`, and one whose membership
    ended (it was removed, or it left) is `membership: "ended"` with `membershipEndedAt`. A removed built-in Station is
    listed the same way. The loss is dated when the account lost it: for a member, the earlier of its leaving and the
    Station's removal. After the 30 days a Station may be omitted, and an omission never means "remove".
  - **Order and pages.** Built-in Stations first, then `createdAt`, then `id`. `nextCursor` is `null` on the last page.
  - **`stale` and `complete`.** `stale: true` means Auth was unreachable (503), so the list is the Portal's last copy.
    `complete` is `true` only on the last page of a list that is not stale. Anything else, a failed page too, is
    incomplete and must not remove a destination or a verifier you already reviewed. Any other refusal from Auth is the
    error the browser's list gives.
  - With the setting off the route is 404, as any `/api/v1` route that does not exist, and a token on `/api/stations` is
    403, as before.
- **The browser's list** `GET /api/stations` also answers `notices` with the setting on: the account's refused binding
  attempts of the last 30 days, the 50 newest, newest first, each `{ kind: "binding_attempt", accountId, genesisHash,
  reason, attemptedAt }` with `accountId` the R9 account, never the other Agora.Build account. The page shows each as a
  line above the Stations. It ignores `limit` and `cursor`, which are the directory's.

  ```json example:notices
  {
    "stations": [
      {
        "id": "st01KB4K8W3Z5Q7R2T9X1C6D4FGH",
        "origin": "https://station-dev.agora.build",
        "role": "built_in",
        "ownerAccount": null,
        "status": "active",
        "createdAt": "2026-10-31T18:20:41.512Z",
        "builtIn": true,
        "name": "Agora Station",
        "integrationsEnabled": true
      }
    ],
    "stale": false,
    "notices": [
      {
        "kind": "binding_attempt",
        "accountId": "acct-7f3a2c91",
        "genesisHash": "3c9a5e81b07d24f6c1a8e5d3b9f20476a1c8d5e29b3f7061c4a8e2d5b9f1037a",
        "reason": "bound_elsewhere",
        "attemptedAt": "2026-11-21T09:59:00.000Z"
      }
    ]
  }
  ```

- **The checkpoint.** `GET /api/v1/stations/changes?checkpoint=1` with the Station's `station.report` token answers the
  Station's whole state at one exact cursor, under the feed's own limit of 120 a minute. The answer and what it promises
  are in "For Station Builders". A `cursor` sent beside it is checked and then ignored: a malformed one is still 400
  `cursor` ("Send the cursor as a whole number of at least 0."), and 409 `cursor_ahead` does not apply, since a
  checkpoint is at the Station's own newest change. With the setting off the parameter is ignored and the answer is
  today's.
- **The built-in Station's two binding reports.** With the setting on, `POST /api/v1/stations/reports` also takes these,
  each with a `reportId`; what they mean and when to send them is in "For Station Builders". Neither names an
  integration:
  - `{ "state": "binding_changed", "reportId", "account", "accountId", "genesisHash", "bindingId", "version",
    "bindingState" }`, with `bindingState` `bound`, `unbound` or `released`;
  - `{ "state": "binding_attempt", "reportId", "account", "accountId", "genesisHash", "reason", "attemptedAt" }`, with
    `reason` `bound_elsewhere` or `owner_disabled`.

  Only the built-in Station may send them. A custom Station's well-formed binding report is 403 `forbidden`: "Only the
  built-in Station reports bindings.", and nothing is recorded. The body is validated first, so a malformed one from
  a custom Station is the 400 below, not the 403. With the setting off every binding field is an unknown field: 400
  `report`, with today's message (and a `state` of `binding_changed` or `binding_attempt` with today's fields only is 400
  `state`). Each report is validated in this order (400, with the code): its shape, `reportId`,
  `account`, `accountId`, `genesisHash`, then the form's own fields in the order the form lists them.

  | Code | Refused when | Message |
  | --- | --- | --- |
  | `report` | a field outside the form's own, so an `integrationId`, a field of the other binding form or of a revocation report | "Send a binding report as { state: "binding_changed", reportId, account, accountId, genesisHash, bindingId, version, bindingState } or { state: "binding_attempt", reportId, account, accountId, genesisHash, reason, attemptedAt }." |
  | `report_id` | missing, or not 1 to 128 characters of `[A-Za-z0-9._:-]` | "Send the reportId as 1 to 128 characters of letters, digits, '.', '_', ':' or '-'." |
  | `account` | missing, or not an Agora.Build account ID: `ab` and 26 upper-case Crockford base32 characters | "Name the account as ab and 26 letters or digits." |
  | `account_id` | missing, or not 1 to 128 characters of `[A-Za-z0-9._:-]` | "Send the accountId as 1 to 128 characters of letters, digits, '.', '_', ':' or '-'." |
  | `genesis_hash` | missing, or not 64 lowercase hex characters | "Send the genesisHash as 64 lowercase hex characters." |
  | `binding_id` | missing, or not 1 to 128 characters of `[A-Za-z0-9._:-]` | "Send the bindingId as 1 to 128 characters of letters, digits, '.', '_', ':' or '-'." |
  | `version` | not a positive whole number of at most 9007199254740991 (a JSON number) | "Send the version as a positive whole number." |
  | `binding_state` | not `bound`, `unbound` or `released` | "Send the bindingState as bound, unbound or released." |
  | `reason` | not exactly `bound_elsewhere` or `owner_disabled`. This is an exact code, not the free text of an `error` report's `reason` | "Send the reason as bound_elsewhere or owner_disabled." |
  | `attempted_at` | not an ISO time as `toISOString` writes it (`2026-11-21T09:59:00.000Z`: a four-digit year, milliseconds and `Z`), or more than an hour after the Portal's clock | "Send attemptedAt as an ISO time." |

  The other refusals are 409 `report_id_reused` ("This reportId was already used for another report.") and 409
  `binding_version` ("This binding's version is not newer than the one recorded."), below.

Apps and Stations that send an access token use `/api/v1/` only: a bearer
token on the unversioned `/api/...` path gets 404 naming the `/api/v1` path.
Browser routes use `/api/...` with the cookie and do not accept tokens, except
that the browser may also read `GET /api/v1/integrations` (and, with `DELEGATED_HOST_WORK=1`, `GET /api/v1/stations`,
which with a cookie and no token answers the browser's list, not the directory).

Create takes a name of 1 to 80 characters, scopes from `agent.view`,
`agent.prompt`, `agent.approve`, `agent.interrupt`, `agent.terminal`,
`agent.launch`, `agent.message` and `agent.notify` (each at most once; `agent.view` is always
added), a public JWK (a private member is refused), a quota of 1 to 10000 token
requests per second (default 200) and an expiry of 1 to 90 days (default 30).
`agent.notify` needs `agent.message` and `agent.prompt`. `agent.launch`, `agent.message` and `agent.notify` take
effect only on a Station and host that
support them (an upgraded Atem); see [D28](integrations.md#313-launch-message-and-notify-scopes-d28) in the integrations design. A new integration waits for approval, and
Auth issues it no token until then; the owner approves it in Astation, which sends the approval with an
`integrations:approve` token for the owner. An account that is neither an
integration's owner nor its Station's owner gets 404 for it; likewise an account
that neither owns a Station nor is a current member of it gets 404 for every
Station route, and a member gets 403 for the owner's changes (sharing, removing,
unsharing someone else), all without the Portal asking Auth. Limits per minute
per account: each list (`GET /api/stations` and, with `DELEGATED_HOST_WORK=1`, `GET /api/v1/stations` together,
`GET /api/integrations` and `/api/v1/integrations` together, and a Station's members) 60; all other changes
that call Auth (share, unshare, remove, pause, resume, revoke, renew, settings,
keys, approval) 30 together (with `DELEGATED_HOST_WORK=1` the native revoke is
one of them, and so is the interrupt, which calls no Auth but uses the same
budget); Station registration 10; integration creation 20; read tokens 30. Sharing with an `ab…` account Auth does not know (or has
disabled) is refused as 400 from Auth, so a Station owner can tell whether an
account ID exists; account IDs are random ULIDs, so this is accepted rather
than guessed at. Station challenges are 10 per hour per account; Station reports
600 and feed reads 120 per minute per Station.

Auth limits its management API per management client (6,000 calls a minute
for the Portal's `manage` client), not per address, so the Portal's own
address is not a shared bottleneck; the per-account limits above keep one
account from using a large share of it. If Auth answers 429, it shows as 503
`unavailable` (lists are served stale).

Common error codes: `not_found` (404), `forbidden` (403), `invalid_state` and
`expired` (409, the action does not fit the current state), `revoked` (409),
`origin_taken` and `duplicate_key` (409, from Auth), `challenge` (400, expired or
used), `proof` (422), `station` (403, the report client is not a registered Station), `exchange` (403, Auth refused the read token), `unavailable` (503, Auth unreachable), `built_in` (409, the built-in Station can't be removed, shared or left), `not_supported` (409, integrations are off on the built-in Station), `plan_limit` (403, the plan's limit on the built-in Station), `admin_paused` (409, Agora.Build paused the integration; only Agora.Build resumes it), `owner_disabled` (409, Agora.Build disabled the owner's account; the integration resumes when it is enabled again); with `DELEGATED_HOST_WORK=1`, `interrupt_running` (400, a revoke without a true or false `interruptRunning`), `too_late` (409, more than 24 hours since the revocation), `station_removed` (409, the integration's Station has been removed), `report_id_reused` (409, a Station's `reportId` already used for another report) and `binding_version` (409, a binding report's version is not newer than the one recorded; `forbidden` is also 403 for a binding report from a custom Station); too many challenges or requests are 429. Field mistakes are
400 with `name`, `scopes`, `quota`, `expiry`, `jwk`, `private_key`, `account`,
`report_key`, `r9_svc`, `reason`, `state`, `report` or `cursor`; with `DELEGATED_HOST_WORK=1` also `report_id`, `host`,
`record_id` and `outcome` (a Station's revocation reports, in "Routes"), `limit` (the Station directory), and
`account_id`, `genesis_hash`, `binding_id`, `version`, `binding_state` and `attempted_at` (the binding reports, in
"Routes"; their `account`, `reason` and `report_id` are the codes above).

### Lifecycle

| State | Meaning | Moved by |
| --- | --- | --- |
| `awaiting_approval` | created, not approved | approval moves it on; revoke ends it directly |
| `provisioning` | approved; the Station has not taken it up | the Station's report |
| `waiting_for_host` | the Station is up but its host is not | the Station's report |
| `ready` | usable | the Station's report only |
| `paused` | stopped by the owner, the Station's owner or Agora.Build; remembers where it was | resume returns it there; after Agora.Build's pause only Agora.Build resumes it (409 `admin_paused`) |
| `revoking` | revoked at Auth; the Station has not confirmed | the Station reports `revoked` |
| `revoked` | final | nothing |

**With `DELEGATED_HOST_WORK=1` (off by default):** a `revoking` integration stays `revoking` while its hosts report
`revocation_applied`. The Station's final `revoked` report, one with a `reportId`, moves it to `revoked` and records how it
ended; a legacy `revoked` report still moves it at once, and a final may follow it. The Portal runs no 24-hour clock of its
own: only a Station's report ends `revoking`, so an integration whose Station never sends a final stays `revoking`.

The Portal never sets `ready` itself. Pause is allowed from `awaiting_approval`, `provisioning`,
`waiting_for_host` and `ready` (not when expired); a report received while paused updates the state to return to.
Revoking, removing a Station and unsharing a Station all set the affected
integrations to `revoking` (an integration still awaiting approval goes straight
to `revoked`; so do the integrations of a Station that a listing finds Auth no
longer has). Expiry
is shown as the state `expired` for anything not yet revoking; expired
integrations cannot be approved, paused or resumed, but can be renewed, rotated
or have their quota changed.

A paused integration also says who paused it, `pausedBy`: `owner`, `station` (the custom Station's owner) or `admin`
(Agora.Build), as Auth recorded it, and `null` for a pause from before Auth recorded it. `pausedBy` is also `admin`,
and the state `paused`, while Agora.Build has the owner's account disabled; resuming then is 409 `owner_disabled`, and
the integration resumes by itself when the account is enabled again.

### For Station Builders

**Proof of control.** To register, the Station's owner asks for a check on the
Station's origin: `https://host` with a dotted host name, optionally a port (not 0), and no path, user name, query, fragment or IP address. The Portal issues
a random value valid 10 minutes, once. The Station must serve exactly that value
at `<origin>/.well-known/agora-build-station`. The Portal fetches it over HTTPS
only: no redirects, a 5-second timeout, a body of at most 1024 bytes, status 200,
and a body equal to the value, optionally followed by one `\n`. It refuses
loopback, private, link-local, CGNAT, multicast and unspecified addresses
(IPv4 and IPv6, including such IPv4 addresses carried in IPv4-mapped, NAT64
and 6to4 IPv6 addresses, and all Teredo addresses), checking the address
actually connected to. A failed check
answers 422 `proof` with `reason` (`status_<code>`, `mismatch`, `timeout`,
`too_large`, `blocked_address` or `network`), and the value is spent.

**The report key.** The Station generates its own key pair and gives only the
public JWK as `reportKey` (a JSON object of at most 4 KB) when it is registered.
Auth creates the Station's report client, `s-` plus 26 characters, which the
owner sees as `reportClientId`.

**Getting a token.** The Station signs in as that client with `private_key_jwt`
(the assertion rules and the 60-second limit are in Auth's `docs/integrating.md`)
and asks for `scope=station.report` with `resource=<the Portal origin>`. The
Portal accepts only that scope from a client whose ID starts with `s-` and
belongs to an active Station.

**Reports.** `POST /api/v1/stations/reports` with
`{ "integrationId", "state", "reason" }` and no other field. `state` is
`waiting_for_host`, `ready`, `revoked` or `error`; `reason` is 1 to 200
characters without control characters, required for `error` and optional
otherwise. The answer is the integration (without `role` or `pausedBy`: as in
the change feed, the Station is not told who paused it).

| Report | Accepted when the integration is | Effect |
| --- | --- | --- |
| `waiting_for_host` | `provisioning` or `ready` | moves it; clears `lastError` |
| `ready` | `provisioning` or `waiting_for_host` | moves it; clears `lastError` |
| `revoked` | `revoking` | moves it to `revoked` |
| `error` | any state except `revoked` | records `lastError`, keeps the state |

Repeating the current state changes nothing and succeeds. Any other report is
409 `invalid_state`. An integration of another Station is 404, as if unknown.

**With `DELEGATED_HOST_WORK=1` (off by default):** the Station also reports how a revocation went, host by host
([D29](integrations.md#311-delegated-host-work-d29), Phase B), so that the Portal can show how many hosts applied it. The
two forms, their validation and the error codes are under "Routes"; this is when to send them and what to do with each
answer, as agreed with Atem ([Atem PR #148](https://github.com/Agora-Build/Atem/pull/148), the acknowledgment ledger).
With the setting off a body with a `reportId` is 400 `report`. The built-in Station also sends two binding reports,
which are described after the change feed ("The built-in Station's binding reports").

- **When to send each.**
  - `revocation_applied`: once for each covered host and revoked integration, when that host first has the revocation in
    force, naming the record whose result said so. The Portal takes it only for an integration it holds as `revoking` or
    `revoked`.
  - The final `revoked`: once for each revocation. `all_applied` with `pendingHosts` `[]` once every covered host has the
    revocation in force; else `deadline_passed` with the hosts that didn't confirm (never none), 24 hours after the
    revocation's start (the clock, below).
- **`reportId` is opaque to the Portal.** It checks only that it is 1 to 128 characters of `[A-Za-z0-9._:-]` and never
  recomputes it. Atem's reference derivation is in its bindings' "For Station builders"
  ([Atem PR #148](https://github.com/Agora-Build/Atem/pull/148), `designs/protocol/atem-client-bindings.md` §9, not yet
  merged): `<kind>:` and a SHA-256 over the report's identity, never over time, order or a counter. Whatever a Station
  uses must give a retry the same id.
- **Idempotency.** Report ids are per Station and kept forever, with the body and the answer they got.
  - The same `reportId` with the same body gets the recorded answer (200) and changes nothing. The body is compared by
    its fields, whatever their order, with `pendingHosts` in the order sent, so a retry sends the same list in the same
    order (Atem sends it sorted).
  - The same `reportId` with another body is 409 `report_id_reused`: "This reportId was already used for another report."
    The first report stands.
  - The id is looked up before the integration, so an id used for one integration and sent again for another is 409
    `report_id_reused`.
  - A report the Portal refuses records no id.
- **Order.** Send one report at a time for an integration, in the order they were made: the next only once the last is
  settled (done, final or dropped). Then a final never reaches the Portal ahead of the per-host reports made before it. The
  Portal doesn't check the order.
- **A late per-host report is welcome.** Keep sending `revocation_applied` for a host that applies the revocation after a
  `deadline_passed` final. The Portal records the host and the "n hosts didn't confirm" count falls; the integration stays
  revoked. `revoked` is never sent again: a second final under another id is 409 `invalid_state`. A host counts once: a
  second report for a host already recorded is 200 and counts nothing again.
- **Finals that come at once.** The Station's own `revoke` is the record it signs with the integration's service key when
  the Portal revokes the integration.
  - An own revoke whose grant covered no host is final at once: `revoked` with `all_applied` and `pendingHosts` `[]`, and
    no per-host report. Nothing could apply it.
  - An own revoke recorded after its own deadline is final at once: `all_applied` when every covered host already has the
    revocation in force (through a native revoke), else `deadline_passed`.
- **The 24-hour clock** starts at `min(revoked_at_ms, issued_at + 1 h)`: `revoked_at_ms` is when the Portal revoked the
  integration and `issued_at` is the own revoke's. The Station reads `revoked_at_ms` from the `at` of its feed's
  `integration_revoked` change for the integration: neither the answer to a report nor the feed's `integration` objects
  carry `revokedAt`. Keep the start, so that a restart doesn't move the deadline. The Portal runs no clock of its own and
  takes the report when it comes.
- **The answers.** The Portal itself answers 200, 400, 401, 403, 404, 409, 413, 415, 429, 500 (any unexpected error, such
  as a database statement timeout) and 503 here; the other rows are for a proxy in between, or a mistake. A 500 is in the
  retry class.

  | Answer | Class | What the Station does |
  | --- | --- | --- |
  | 200, the recorded 200 of a repeated `reportId` included | done | the report is settled |
  | a network error or timeout, any 5xx (503 and unknown ones too), 408 | retry | send the same report again later, with backoff: the same `reportId` and body |
  | 429 | retry | the same, after its `Retry-After`. The Portal limits a Station to 600 reports a minute and its own 429 carries no `Retry-After` today, so back off when there is none |
  | 401 | retry | refresh the `station.report` token, then send the same report |
  | 409 `report_id_reused`, 400, 404, 409 `invalid_state`, 413, 415, any other 4xx | final | never send it again; raise an operator alert |
  | 1xx, 3xx, any 2xx but 200 | final | the same. Never follow a 3xx: it would carry the `station.report` bearer wherever it points |
  | 403 | stop | stop reporting under this report client ID (below) |

  A network error or timeout has no status: it is a retry, so never pass a stand-in such as `0` as one.
- **The 403 stop.** A 403 refuses the report client (the Station's `station.report` client at Auth), not one report.
  - Stop reporting under that report client ID: hold every pending report (none sent, none dropped), go on counting and
    making reports, and raise one operator alert.
  - When the Station reports again, resume under the same ID: every held report goes, in order. Resume under another ID
    (another Station at Auth, say a removed one registered again) the same way: every revocation goes on reporting under
    the new ID, including its later per-host reports and its final, as Atem's §11.4 has it. The old Station's integrations
    then get 404, which is final.

**The change feed.** `GET /api/v1/stations/changes?cursor=<n>` returns
`{ changes, cursor }` and, only for `cursor=0`, `integrations`, a snapshot of
every integration on the Station. Start at 0, then poll every minute with the
returned `cursor` (it stays the same when nothing changed). A page holds at most
500 changes, oldest first; if it is full, ask again at once. Each change is
`{ id, at, integrationId, kind, state, reason }` plus, for integration changes,
`integration`: `{ ownerAccount, state, scopes, r9Svc, expiresAt, quotaPerSecond }`
as they stand now (state may be `expired`); each entry of the `integrations`
snapshot is the same object with its `id`. `ownerAccount` (`ab…`) is how a
Station binds a pending integration to its owner before approval, when the
integration has no token yet; trust it only from this authenticated feed.
The current values in `integration` and `integrations` take precedence over a
change's historical `state`.

**Cursors.** A cursor is a whole number (send it as given). Event IDs are
global and increase in commit order, so one Station's IDs have gaps; never
treat them as a count. A cursor beyond this Station's latest event (for example
after the Portal's database was restored from an older backup) is refused with
409 `cursor_ahead`: read the feed again from `cursor=0`, whose snapshot is the
current state, including pauses and revocations, and continue from there (with `DELEGATED_HOST_WORK=1`, read the checkpoint
instead: "The checkpoint", below). The
cursor in a push nudge is only a hint; never store it. `kind` is one of `integration_created`,
`integration_approved`, `integration_paused`, `integration_resumed`,
`integration_revoked`, `integration_renewed`, `integration_settings_changed`,
`integration_key_added`, `integration_reported` (the Station's own reports),
`integration_reconciled` (the Portal caught up with a change made at Auth,
such as a new expiry, quota or R9 binding, or an integration it had missed),
and for the Station itself `station_registered`, `station_reconciled`,
`member_added` and `member_removed`, which have no integration. New kinds may
be added; a reader skips a kind it doesn't know, still acts on the `integration`
it carries, if any, and moves the cursor on. Act on `state` and
`integration.state`, never on `kind` alone: some changes are only recorded and change nothing, such as an older
`integration_resumed` that reaches the Portal after a newer pause: it comes with
the integration's actual state, `paused`. A change Agora.Build made (an admin's, on the admin site) has the
`reason` `agora_build`. Agora.Build disabling an integration's owner account reaches the Station as an Agora.Build
pause (`integration_paused`, `state` `paused`; Auth issues the integration no token meanwhile), and enabling it again
as Agora.Build's `integration_resumed`, after which `integration.state` is what it was before (still `paused` if its
owner had paused it). As soon as an integration's `state` is `paused`,
`revoking`, `revoked` or `expired`, refuse its still-valid tokens and close its
open sessions and streams (that is API access only: for `expired`, see the notes
on delegated host work below, where expiry doesn't stop work a host has already
accepted); its tokens are never trusted past their 300-second lifetime anyway. A
removed Station cannot read its feed any more (its report client is gone at
Auth), so it never sees its own `station_removed`.

**With `DELEGATED_HOST_WORK=1` (off by default):** the feed also says what to do about tasks already running on the
Station's hosts ([D29](integrations.md#311-delegated-host-work-d29)). With the setting off, what was recorded while it
was on stays in the feed, but `interruptRunning` is no longer carried (neither on changes nor on `integration` objects)
and `disabledAccounts` is not served; the account changes and the `integration_interrupt_requested` kind are still served
as recorded.

- `integration.interruptRunning` is the integration's current choice: whether to interrupt the tasks running on the
  owner's hosts. It is on the `integration` of a change and on each `integrations` snapshot entry, for integrations whose
  `state` is `revoking` or `revoked` only. It only ever goes from `false` to `true`; act on it as you do on `state`.
- A revoked change's own `interruptRunning`, on `integration_revoked`, is what that change stated: `true` when the
  revocation asked to interrupt, and `false` when it did not, for an indirect revocation (a member removed, an
  integration Auth no longer lists) and for one recorded before the setting was on. A revocation the Portal first saw in
  Auth's listing records `false` too, but Auth's own entry for it may later raise the choice to `true`, in a further
  `integration_revoked` change. The choice only ever goes from `false` to `true`, and `integration.interruptRunning` is
  the current one: act on that, not on an earlier change's.
- `integration_interrupt_requested` is a new kind: after the revocation, the integration's owner (`reason` `owner`) or
  its custom Station's owner (`station_owner`), within 24 hours of it, or an Agora.Build admin (`agora_build`), asked to
  interrupt the running tasks. The change has `interruptRunning: true` and an `integration` with its `state` (`revoking`
  or `revoked`) and `interruptRunning: true`. It can arrive more than once for one integration (an owner's interrupt is
  recorded only in the Portal, so an admin's later one is a second); the choice stays true.
- `account_disabled` and `account_enabled` are for the built-in Station only: an Agora.Build admin disabled or enabled an
  account. The change is `{ id, at, integrationId: null, kind, state: null, reason: "agora_build", account }` with
  `account` the `ab…` account ID, and has no `integration`. It comes with the `integration_paused` and
  `integration_resumed` changes for that account's integrations. A cursor-0 read of the built-in Station also has
  `disabledAccounts`, the account IDs disabled now, as the Portal's availability table has them. A custom Station gets
  neither the changes nor `disabledAccounts`. `disabledAccounts` has no completeness mark: to know whether an account
  missing from it is enabled, read the checkpoint and its `accounts.complete`. The built-in Station's feed has two more
  account-level changes, `accounts_baseline` and `accounts_incomplete`, and the checkpoint gives its whole state at one
  cursor: "The checkpoint" and "Account availability", below. The account changes and `disabledAccounts` are final from
  Auth's and the Portal's side.
- **Expiry never produces a control record.** Each integration's effective state counts only a pause (by the owner, a
  Station owner or an admin) and a disabled owner account. Expiry never produces a control record: the Station's current
  rule that "an expired integration is treated like a pause" applies to API access only. For delegated senders, work
  already accepted runs until its deadline (at most 24 hours); revoke to cancel work that hasn't started (Atem's design,
  I.8).
- A report's answer carries neither `revokedAt` nor `interruptRunning`: the Station learns the choice from the feed.
- A reader skips a kind it doesn't know, still acts on the `integration` it carries, if any, and moves the cursor on. The
  account changes carry none, so a reader that ignores them has nothing to act on.

**With `DELEGATED_HOST_WORK=1` (off by default):** a Station that has to recover, or start from a whole and exact picture,
reads the checkpoint, and the built-in Station also gets account availability and reports its bindings
([D29](integrations.md#311-delegated-host-work-d29); Portal issues
[40](https://github.com/Agora-Build/Portal/issues/40) and [41](https://github.com/Agora-Build/Portal/issues/41)). They use
the same authenticated feed and report route, the same scopes and the same limits; there is no other API. With the setting
off none of this exists: `?checkpoint=1` is ignored and a binding report is 400 `report`.

**The checkpoint.** `GET /api/v1/stations/changes?checkpoint=1` answers the Station's whole state at one exact cursor:

```json example:checkpoint
{
  "changes": [],
  "cursor": 4812,
  "checkpoint": {
    "at": "2026-11-22T10:00:00.000Z",
    "integrations": [
      {
        "id": "i-01kb4t2m8x5q7r3w9z1c6d4fgh",
        "ownerAccount": "ab01KB4M7Q2X9R5T3WJ8V6C0YNDA",
        "state": "ready",
        "scopes": ["agent.view", "agent.prompt"],
        "r9Svc": "9d41c7a2e08b5f36d1a4c9e72b085f3ad6c1e49b7a02d8f5c3e61b9a4d70f2c8",
        "expiresAt": "2026-12-21T10:00:00.000Z",
        "quotaPerSecond": 200
      },
      {
        "id": "i-01kb4t3n9y6r8s4x0a2d7e5gjk",
        "ownerAccount": "ab01KB4N2F8D6H1G5Z3P7S9QAXEB",
        "state": "revoking",
        "scopes": ["agent.view"],
        "r9Svc": "5b8e2d94a1c07f63e9d2b4a8c51f07e3d96a4b2c8e150f7a3d9c64b1e8a2f057",
        "expiresAt": "2026-12-01T10:00:00.000Z",
        "quotaPerSecond": 200,
        "interruptRunning": true,
        "revokedAt": "2026-11-22T09:30:00.000Z"
      }
    ],
    "accounts": {
      "complete": true,
      "disabled": ["ab01KB4P9C3E7M2V5T8R1W6XBJFC"]
    },
    "bindings": [
      {
        "account": "ab01KB4M7Q2X9R5T3WJ8V6C0YNDA",
        "accountId": "acct-7f3a2c91",
        "genesisHash": "3c9a5e81b07d24f6c1a8e5d3b9f20476a1c8d5e29b3f7061c4a8e2d5b9f1037a",
        "bindingId": "bind-5d1e",
        "version": 3,
        "bindingState": "bound"
      }
    ],
    "pendingReleases": []
  }
}
```

A custom Station's checkpoint has `at` and `integrations` only:

```json example:checkpoint-custom
{
  "changes": [],
  "cursor": 37,
  "checkpoint": {
    "at": "2026-11-22T10:00:00.000Z",
    "integrations": [
      {
        "id": "i-01kb4t4p0z7s9t5y1b3e8f6hkm",
        "ownerAccount": "ab01KB4M7Q2X9R5T3WJ8V6C0YNDA",
        "state": "paused",
        "scopes": ["agent.view"],
        "r9Svc": "e3a96d0b52c8f147a9d3e6b0c25f8a71d4e90b36c7a5f218e0d94b3a6c15f7e2",
        "expiresAt": "2026-12-10T10:00:00.000Z",
        "quotaPerSecond": 200
      }
    ]
  }
}
```

- **`cursor` is exact.** It is this Station's newest change in the same snapshot as everything else in the answer, and
  every change committed later has a larger id. That holds because the Portal appends a Station's changes under one lock,
  takes their ids in commit order, and commits a change together with the rows it changed. The checkpoint is the state
  after applying every change up to `cursor`, and no later one. Resume with `?cursor=<cursor>`: the feed then delivers
  every later change and no earlier one.
- **One snapshot.** The Portal reads the whole answer in one `REPEATABLE READ`, read-only transaction. It takes no lock, so
  it never waits for a writer, and `cursor`, `integrations`, `accounts` and `bindings` are as of one moment: a change is
  in the answer with its event or in neither. `at` is the Portal's clock when it answered, and each `state` is the
  effective one as of `at`, so an integration past its expiry reads `expired`.
- **`integrations`** lists every integration on the Station in any state, revoked and stopped ones included, oldest
  first, in the feed's integration shape (`ownerAccount`, `state`, `scopes`, `r9Svc`, `expiresAt`, `quotaPerSecond`) plus
  its `id`. A stopped one (`revoking` or `revoked`) also has `interruptRunning` and `revokedAt`. `revokedAt` is `null` for
  a revocation from before migration 004, which did not record when.
- **`accounts` and `bindings` appear on the built-in Station only.** A custom Station gets neither, ever.
  - `accounts.disabled` lists the Agora.Build account IDs disabled now, in account order. What it means depends on
    `accounts.complete` (below).
  - `bindings` is the built-in Station's own last reported binding for each R9 account and genesis hash, ordered by
    `accountId` and then `genesisHash`, and empty until it reports some. A binding report writes no change to the feed,
    so a Station reads its bindings here. A pending release is not carried: the release waits for D27 (below).
- **No pages.** It is one answer, because pages could not share one exact snapshot. If sizes ever call for it, there will
  be a snapshot export, not pages that can't agree.
- **A cursor beside it.** The parameter is checked (a malformed one is still 400 `cursor`) and ignored, and 409
  `cursor_ahead` does not apply.
- **With the setting off** the parameter is ignored and the answer is today's, with no `checkpoint` key. Check for the
  key; don't infer a checkpoint from its absence.
- **When to read it.** To start, after 409 `cursor_ahead`, after a restore, and in any doubt. Your enforcement state
  stays durable meanwhile.

**Account availability.** The built-in Station learns which Agora.Build accounts are disabled, by the account IDs Auth
uses as `sub`, never by a stored user field. The Portal gets them from Auth's feed ("Account Availability", under "Admin
Changes From Auth") and keeps them in one durable table.

- **`accounts.complete`** is `true` only while the Portal's view is complete: it has applied an Auth `accounts_baseline`
  in order and has not started over, or moved to `waiting`, since. Then an account missing from `disabled` is enabled as of
  `cursor`, or doesn't exist.
- **`complete: false` means unknown.** An account missing from `disabled` must not count as enabled: fail closed, and read
  the checkpoint again later. While it is `false`, `disabled` is what the Portal last applied. A disabled account is
  listed, and an unknown one is not complete; never mix them up.
- **It is `false`** on a Portal that has not caught up yet (a first start, a reset, or after Auth was restored: the
  Portal rebuilds from Auth's first entry), while it waits for an operator's reset, and with Auth's setting off or a
  baseline not yet written (Auth writes it when it starts with its setting on).
- **Four changes on the built-in Station's feed.** Each is
  `{ id, at, integrationId: null, kind, state: null, reason: "agora_build", account }`, has no `integration`, and a custom
  Station never gets one:

  | `kind` | `account` | Meaning |
  | --- | --- | --- |
  | `account_disabled` | the account | Agora.Build disabled it. Apply the latest change for each account. Live, it comes with the `integration_paused` changes for that account's integrations. |
  | `account_enabled` | the account | Agora.Build enabled it again. Live, it comes with the `integration_resumed` changes. |
  | `accounts_baseline` | `null` | The Portal's view became complete. From here an account missing from your disabled list is enabled. |
  | `accounts_incomplete` | `null` | From here the Portal's view is not complete. Treat an account missing from your disabled list as unknown, and fail closed, until the next `accounts_baseline`. |

  ```json example:account-changes
  {
    "changes": [
      { "id": 4813, "at": "2026-11-22T10:01:00.000Z", "integrationId": null, "kind": "account_disabled", "state": null, "reason": "agora_build", "account": "ab01KB4Q5H1G9K3M7N2P4S6TCRGD" },
      { "id": 4814, "at": "2026-11-22T10:02:30.000Z", "integrationId": null, "kind": "account_enabled", "state": null, "reason": "agora_build", "account": "ab01KB4P9C3E7M2V5T8R1W6XBJFC" },
      { "id": 4815, "at": "2026-11-22T10:05:00.000Z", "integrationId": null, "kind": "accounts_incomplete", "state": null, "reason": "agora_build", "account": null },
      { "id": 4816, "at": "2026-11-22T10:09:12.000Z", "integrationId": null, "kind": "account_disabled", "state": null, "reason": "agora_build", "account": "ab01KB4N2F8D6H1G5Z3P7S9QAXEB" },
      { "id": 4817, "at": "2026-11-22T10:09:12.000Z", "integrationId": null, "kind": "accounts_baseline", "state": null, "reason": "agora_build", "account": null }
    ],
    "cursor": 4817
  }
  ```

  That is a start-over and its rebuild: `accounts_incomplete` when the Portal started over, then the account whose state
  differs from what it had told the Station, then `accounts_baseline` once the rebuild caught up.
- **When they are sent.**
  - `account_disabled` and `account_enabled`: once for each account entry the Portal applies live, in Auth's order. After
    a rebuild they are sent for the accounts whose state differs from what the Portal held before, so a Station never
    sees a state Auth has since replaced, and never sees the feed's history again.
  - `accounts_baseline`: once each time the view becomes complete: at the end of a rebuild that applied an Auth baseline,
    and when a baseline is applied live while the view is not complete. A baseline that arrives while the view is
    complete changes nothing and tells nobody.
  - `accounts_incomplete`: once each time the view goes from complete to not complete while the Portal's setting is on.
    If that happened while the setting was off, it is sent once, when the Portal next runs with the setting on.
- **Reconnect or reset.** After 409 `cursor_ahead`, a restore, or any doubt, read the checkpoint again.
- **Turning the setting off.** If Auth's setting is turned off, Auth writes no account entries meanwhile. The next start
  with it on writes the corrections and a new baseline. For the Portal's own setting, see "Account Availability".
- These account changes are final from Auth's and the Portal's side. Only the grammar of the binding reports' fields
  stays provisional (below).

**The built-in Station's binding reports.** The ownership rules stay the Station's, as Atem's design (III.5) says: the
native-manager proof and challenge bytes, consent for transfers, refusals, and closing routes and channels. The Portal
records and shows what the built-in Station reports. `POST /api/v1/stations/reports` takes two more forms from it, in the
same `reportId` idempotency and answer classes as the revocation reports; the forms and their errors are under "Routes".

`binding_changed`: a binding for an R9 account at a genesis changed.

```json example:binding-changed-request
{
  "state": "binding_changed",
  "reportId": "binding_changed:5e0c8a3f9d1b47264a8c0e5f3d91b72a64c80e5f1d3b9a7246c08e5f3d91b72a",
  "account": "ab01KB4M7Q2X9R5T3WJ8V6C0YNDA",
  "accountId": "acct-7f3a2c91",
  "genesisHash": "3c9a5e81b07d24f6c1a8e5d3b9f20476a1c8d5e29b3f7061c4a8e2d5b9f1037a",
  "bindingId": "bind-5d1e",
  "version": 3,
  "bindingState": "bound"
}
```

The answer is the recorded binding:

```json example:binding-changed-answer
{
  "accountId": "acct-7f3a2c91",
  "genesisHash": "3c9a5e81b07d24f6c1a8e5d3b9f20476a1c8d5e29b3f7061c4a8e2d5b9f1037a",
  "bindingId": "bind-5d1e",
  "version": 3,
  "bindingState": "bound"
}
```

- `account` is the Agora.Build owner after the change. On `unbound` or `released` it is the owner that was let go.
- `accountId` is the R9 account, `genesisHash` the 32 bytes as 64 lowercase hex characters, and `bindingId` and
  `accountId` are opaque to the Portal: 1 to 128 characters of `[A-Za-z0-9._:-]`.
- **Versions.** They are kept for each `(accountId, genesisHash)` of the Station:
  - a higher `version` replaces the recorded binding, whatever the gap: the account, binding id and state are replaced;
  - the same `version` with an identical binding (`account`, `bindingId` and `bindingState`) is 200 with the recorded
    answer and changes nothing (the report is kept under its own `reportId`);
  - a lower `version`, or the same one with a different binding, is 409 `binding_version` ("This binding's version is
    not newer than the one recorded."), final with an alert:

  ```json example:binding-version-error
  {
    "error": "This binding's version is not newer than the one recorded.",
    "code": "binding_version"
  }
  ```

  A refused report records nothing, not even its `reportId`.
- **Order.** Send the reports for one `(accountId, genesisHash)` one at a time, in the order they were made, the next once
  the last is settled. A report that arrives after a newer one is 409 `binding_version`, and the Portal does not reorder.
- **Transfers.** The Portal learns of a transfer from A to B only through `binding_changed`, and shows the new owner.
  Consent, and refusal (of a resolved owner C who is disabled, say), stay at the Station.

`binding_attempt`: the Station refused a binding. It is reported to the Agora.Build account it protects.

```json example:binding-attempt-request
{
  "state": "binding_attempt",
  "reportId": "binding_attempt:a1d47c90e3b52f68d0a9c4e71b3f5826e0d94a7c15b3f860d2e9a4c7513b8f06",
  "account": "ab01KB4M7Q2X9R5T3WJ8V6C0YNDA",
  "accountId": "acct-7f3a2c91",
  "genesisHash": "3c9a5e81b07d24f6c1a8e5d3b9f20476a1c8d5e29b3f7061c4a8e2d5b9f1037a",
  "reason": "bound_elsewhere",
  "attemptedAt": "2026-11-21T09:59:00.000Z"
}
```

The answer:

```json example:binding-attempt-answer
{
  "recorded": true
}
```

- `account` is the Agora.Build account to alert, `accountId` its R9 account that was refused. `reason` is
  `bound_elsewhere` (another Agora.Build account holds the binding) or `owner_disabled` (an owner account was disabled).
- `attemptedAt` is when the Station made the attempt, as `toISOString` writes it. The Portal takes a Station's clock to
  run ahead, but only by an hour: a later time is 400 `attempted_at`, so a far-future time can't keep a notice first on
  the page.
- **What the account sees.** The attempt is on `account`'s page for 30 days, among the 50 newest, in the browser list's
  `notices` ("Routes"). It never names the other account. Every attempt is kept; the page shows 30 days.
- It writes no change to the Station's feed and pushes nothing.

Both reports have a `reportId` with the rules of Phase B's: the same id with the same body gets the recorded answer (200)
and changes nothing, and with another body it is 409 `report_id_reused`. Ids are kept for each Station forever, with the
body and the answer. The answers are classed as in the table above: 200 is done; a network error, a 5xx, 408, 429 and 401
are retried (with a fresh token for a 401); 409 `binding_version`, 409 `report_id_reused`, 400 and any other 4xx are final,
with an operator alert. A 403 is the stop class; for a binding report it can also mean that the sender is not the
built-in Station (403 `forbidden`).

**Releasing a binding is not built.** `binding_released` (the Portal telling the built-in Station to release a binding,
which the Station applies only when `bindingId` and `version` match its record, so a delayed release can't remove a later
binding) and the admin site's "Release R9 binding" wait for D27's Portal admin API, which is not built. Until then the
Portal sends no `binding_released`, and the checkpoint carries no pending release. The two reports above do not wait for
it.

Provisional until Astation and Atem confirm: the grammar of `genesisHash`, `accountId`, `bindingId` and `version` above.

**The push nudge.** After a committed change the Portal sends
`POST <origin>/agora-build/v1/changes` with `{ "cursor": <n> }` to the Station,
over the same guarded HTTPS fetch with a 3-second timeout; one push per Station
is in flight, and changes meanwhile collapse into one more. The nudge is unsigned
by design: it carries only a cursor and no authority, so the Station treats it
only as a reason to poll the feed with its own token, and never acts on its
content. A failed nudge never fails the change; polling covers it. A removed
Station is nudged once more; the feed then refuses its token (401 or 403),
which is how it learns to stop.

**Browser details.** The browser asks the Portal for
`POST /api/stations/<id>/read-token`, then calls
`GET <origin>/agora-build/v1/details` on the Station with that `station.read`
token (valid 5 minutes). The Station must allow that request by
CORS from the Portal's origin only.

## Vox, Atem And Astation

Moving Vox, Astation and Atem onto the IdP is their teams' work; the Portal side
is ready. Each app registers with the IdP, signs people in there, and uses the
`ab…` `sub` as the global account ID. Vox becomes a billing client: register
it with the `credits` scope for the Portal's origin and list its services
in `PORTAL_BILLING_FILE`. Native apps such as Atem use the device-code flow with
the scopes they need. Map existing Vox identities by exact verified provider
subjects, never email; existing Vox balances and history need an explicit,
backed-up migration with idempotent opening balances before spending moves to
this ledger. Astation signs in with the IdP (the `astation` native client, with
`agora:projects`, `agora:certificates` and `agora:tokens`) and reads projects
and tokens from the routes above instead of its own Agora SSO session.

## Verification

`npm test` covers the OIDC client (callback validation, sessions, back-channel
logout, bearer tokens, key rotation and an unreachable JWKS) against a stand-in
IdP, plus the ledger, payments, subscriptions, ownership and public-file
restrictions. PostgreSQL integration is optional in the default suite: set
`PORTAL_TEST_DATABASE_URL` to a dedicated database named `agora_portal_test` and
run `node --test tests/persistence.test.mjs`. That test rebuilds its own table;
never point it at production. The Stations and integrations tests
(`tests/integrations-*.test.mjs`) cover the migrations and event partitions,
the lifecycle states, proof of control and its address checks, the Auth
management client, Station registration and sharing, integration changes,
reports, the change feed and push, the reader of Auth's change feed, the nudge route and applying admin changes, the
routes and the account page; with `DELEGATED_HOST_WORK=1` also the Station directory, the exact-cursor checkpoint, account
availability and its rebuild, and the binding reports. `tests/platform-docs.test.mjs` checks that the example answers in
this document are what the Portal gives. The ones that need PostgreSQL use the same variable and run in throwaway schemas.

`npm run test:e2e` runs the real Portal against the real auth.agora.build, loaded
from an Agora-Build/Auth checkout (`AUTH_REPO`, default `../Auth`, with
`npm ci` done) with Auth's stand-in GitHub and Google. It needs Node 22 (at least
20.18) and `TEST_DATABASE_URL`, a throwaway PostgreSQL database in which Auth's
helpers create and drop their own schemas. It drives sign-in, SSO, sign-out,
back-channel logout, a billing client, a native app, the billing allowlist, key
rotation, the IdP going down and cross-account isolation over real HTTP.
`tests/e2e/built-in-station.e2e.mjs` runs the built-in Station: two accounts listing it, the refused actions, its
`s-` report token, its feed, integrations off then on, the plan limit, and that an Agora.Build admin has no admin views or rights in the Portal.
It also makes admin changes at Auth (Auth's integration store with `admin: true`, the call the admin site's request
makes once Auth's step-up gate has passed): a pause reaches the Portal's events and the Station's feed through Auth's
nudge, the owner cannot resume it in the Portal or at Auth, the admin's lift and revocation follow, and with the nudge
lost the Portal's poll still brings a pause. It checks that the Station's feed, the owner's history and the Portal's
log name neither the admin nor the reasons, and that an admin disabling and enabling an owner at Auth pauses and
restores that owner's integrations, which the Station sees as Agora.Build's pause and lift. Those need an Auth
checkout with the change feed and the admin pause lock (Auth `feat/admin-mfa`, Tasks 13 and 14) and are skipped
otherwise.
`scripts/browser-smoke-integrations.mjs` also checks its row and the Station selector, and the row of an integration
an admin paused at Auth ("Paused by Agora.Build", no Resume).

`node scripts/browser-smoke.mjs` drives a real headless Chromium through the same
stack at desktop and mobile sizes: the keyboard-reachable "Sign in", the IdP page
and back, the account page, guest prompts, the account page when
`/api/auth/config` fails, and signing out of both. It needs the e2e settings plus
`PLAYWRIGHT_CORE` (a playwright-core directory) and `CHROMIUM_PATH`; nothing is
installed into this package. Real GitHub/Google sign-in, Agora Console, Stripe
checkout, refunds and webhook delivery still need registered credentials and an
HTTPS deployment to verify end to end.
