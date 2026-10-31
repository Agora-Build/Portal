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
`https://station-dev.agora.build`), which Agora.Build runs (spec D24). Auth admits it from the `stations` list in
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
| `integrations` | Auth's `i-` client ID, owner, Station, scopes, state, `resume_state`, `r9_svc`, quota, expiry, `last_error`, `paused_by` (who paused it, as Auth says: `owner`, `station` or `admin`), `owner_disabled_at` (while Agora.Build has the owner's account disabled) |
| `integration_events` | every change, kept forever; also the Stations' change feed |
| `auth_change_feed` | one row: where the Portal is in Auth's change feed (Auth's cursor) |

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
  `"stationScopes": ["station.read"]` and its `backchannelLogoutUri`.

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
- **Admins** are the accounts in `PLATFORM_ADMINS`, which must equal the Station's `admins` in Auth's clients file.
  In their browser session (never through an app's token acting for them) they see every other account's integration
  on it (`role` `station_admin`) and may read an integration and its history, pause it or revoke it, nothing else;
  the history records reason `station_admin`. Through `GET /api/v1/integrations` an admin's token lists only the
  admin's own integrations, like any account's; history, pause and revoke are browser routes only.
- **Reports and feed** use the same routes as any Station. Its report token's `sub` is its own `s-` client ID (it has
  no owner): the Portal accepts such a token only when `client_id` equals `sub`, `sub` is `s-` and 26 lower-case
  Crockford base32 characters, and the scope includes `station.report`. It reaches only the two report routes (403
  elsewhere) and is never a Portal account. Its feed lists every integration on it, each with `ownerAccount`, and
  nothing else; push hints go to its origin.
- **Sync.** The Portal learns of built-in Stations from Auth itself: when the Stations and integrations stack becomes
  ready (the first request to one of their routes, which waits for it) and then hourly, it lists Stations at Auth as
  the first account in `PLATFORM_ADMINS` (which must exist at Auth) and adds or updates the built-in ones, never
  removing one. Without `PLATFORM_ADMINS` the log says it is skipped and the next try is an hour later; with Auth
  unreachable the log says so by reason and the sync is tried again a minute later (hourly again once it succeeds);
  every account's own listing also syncs them. The first sync holds the first request for up to Auth's 10-second
  management timeout plus the database writes it makes. A report client the Portal does not know answers 403
  `station`.
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
| `POST /api/integrations/<id>/pause`, `resume`, `revoke` | browser | pause and revoke also by the Station's owner, or on a built-in Station by an Agora.Build admin |
| `POST /api/integrations/<id>/renew` `{ expiresInDays }` | browser | new expiry counted from now; an expired one on a built-in Station within the plan limit |
| `POST /api/integrations/<id>/settings` `{ quotaPerSecond }` | browser | change the quota |
| `GET /api/integrations/<id>/events` | browser | history (`actor` is `you` for your own changes) |
| `GET /api/integrations` | browser | the account's integrations, and others on Stations it owns; for an Agora.Build admin also others on built-in Stations |
| `GET /api/v1/integrations` | token, `integrations:read` | the same list, except that an admin's token never sees other accounts' built-in integrations |
| `POST /api/v1/integrations/<id>/approval` `{ r9Svc }` | token, `integrations:approve` | native approval; `r9Svc` is 64 lower-case hex characters |
| `POST /api/v1/stations/reports` | token, `station.report` | a Station's report |
| `GET /api/v1/stations/changes?cursor=` | token, `station.report` | the Station's change feed |

Apps and Stations that send an access token use `/api/v1/` only: a bearer
token on the unversioned `/api/...` path gets 404 naming the `/api/v1` path.
Browser routes use `/api/...` with the cookie and do not accept tokens, except
that the browser may also read `GET /api/v1/integrations`.

Create takes a name of 1 to 80 characters, scopes from `agent.view`,
`agent.prompt`, `agent.approve`, `agent.interrupt` and `agent.terminal` (each at
most once; `agent.view` is always added), a public JWK (a private member is
refused), a quota of 1 to 10000 token requests per second (default 200) and an
expiry of 1 to 90 days (default 30). A new integration waits for approval, and
Auth issues it no token until then; the owner approves it in Astation, which sends the approval with an
`integrations:approve` token for the owner. An account that is neither an
integration's owner nor its Station's owner gets 404 for it; likewise an account
that neither owns a Station nor is a current member of it gets 404 for every
Station route, and a member gets 403 for the owner's changes (sharing, removing,
unsharing someone else), all without the Portal asking Auth. Limits per minute
per account: each list (`GET /api/stations`, `GET /api/integrations` and
`/api/v1/integrations` together, and a Station's members) 60; all other changes
that call Auth (share, unshare, remove, pause, resume, revoke, renew, settings,
keys, approval) 30 together; Station registration 10; integration creation 20;
read tokens 30. Sharing with an `ab…` account Auth does not know (or has
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
used), `proof` (422), `station` (403, the report client is not a registered Station), `exchange` (403, Auth refused the read token), `unavailable` (503, Auth unreachable), `built_in` (409, the built-in Station can't be removed, shared or left), `not_supported` (409, integrations are off on the built-in Station), `plan_limit` (403, the plan's limit on the built-in Station); too many challenges or requests are 429. Field mistakes are
400 with `name`, `scopes`, `quota`, `expiry`, `jwk`, `private_key`, `account`,
`report_key`, `r9_svc`, `reason`, `state`, `report` or `cursor`.

### Lifecycle

| State | Meaning | Moved by |
| --- | --- | --- |
| `awaiting_approval` | created, not approved | approval moves it on; revoke ends it directly |
| `provisioning` | approved; the Station has not taken it up | the Station's report |
| `waiting_for_host` | the Station is up but its host is not | the Station's report |
| `ready` | usable | the Station's report only |
| `paused` | stopped by the owner or Station owner; remembers where it was | resume returns it there |
| `revoking` | revoked at Auth; the Station has not confirmed | the Station reports `revoked` |
| `revoked` | final | nothing |

The Portal never sets `ready` itself. Pause is allowed from `awaiting_approval`, `provisioning`,
`waiting_for_host` and `ready` (not when expired); a report received while paused updates the state to return to.
Revoking, removing a Station and unsharing a Station all set the affected
integrations to `revoking` (an integration still awaiting approval goes straight
to `revoked`; so do the integrations of a Station that a listing finds Auth no
longer has). Expiry
is shown as the state `expired` for anything not yet revoking; expired
integrations cannot be approved, paused or resumed, but can be renewed, rotated
or have their quota changed.

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
otherwise. The answer is the integration (without `role`).

| Report | Accepted when the integration is | Effect |
| --- | --- | --- |
| `waiting_for_host` | `provisioning` or `ready` | moves it; clears `lastError` |
| `ready` | `provisioning` or `waiting_for_host` | moves it; clears `lastError` |
| `revoked` | `revoking` | moves it to `revoked` |
| `error` | any state except `revoked` | records `lastError`, keeps the state |

Repeating the current state changes nothing and succeeds. Any other report is
409 `invalid_state`. An integration of another Station is 404, as if unknown.

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
current state, including pauses and revocations, and continue from there. The
cursor in a push nudge is only a hint; never store it. `kind` is one of `integration_created`,
`integration_approved`, `integration_paused`, `integration_resumed`,
`integration_revoked`, `integration_renewed`, `integration_settings_changed`,
`integration_key_added`, `integration_reported` (the Station's own reports),
`integration_reconciled` (the Portal caught up with a change made at Auth,
such as a new expiry, quota or R9 binding, or an integration it had missed),
and for the Station itself `station_registered`, `station_reconciled`,
`member_added` and `member_removed`, which have no integration. New kinds may
be added; treat an unknown one as a reason to act on the `integration` it
carries. A removed Station cannot read its feed any more (its report client is
gone at Auth), so it never sees its own `station_removed`.

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
reports, the change feed and push, the routes and the account page; the ones that
need PostgreSQL use the same variable and run in throwaway schemas.

`npm run test:e2e` runs the real Portal against the real auth.agora.build, loaded
from an Agora-Build/Auth checkout (`AUTH_REPO`, default `../Auth`, with
`npm ci` done) with Auth's stand-in GitHub and Google. It needs Node 22 (at least
20.18) and `TEST_DATABASE_URL`, a throwaway PostgreSQL database in which Auth's
helpers create and drop their own schemas. It drives sign-in, SSO, sign-out,
back-channel logout, a billing client, a native app, the billing allowlist, key
rotation, the IdP going down and cross-account isolation over real HTTP.
`tests/e2e/built-in-station.e2e.mjs` runs the built-in Station: two accounts listing it, the refused actions, its
`s-` report token, its feed, integrations off then on, the plan limit and admin pause and revoke.
`scripts/browser-smoke-integrations.mjs` also checks its row and the Station selector.

`node scripts/browser-smoke.mjs` drives a real headless Chromium through the same
stack at desktop and mobile sizes: the keyboard-reachable "Sign in", the IdP page
and back, the account page, guest prompts, the account page when
`/api/auth/config` fails, and signing out of both. It needs the e2e settings plus
`PLAYWRIGHT_CORE` (a playwright-core directory) and `CHROMIUM_PATH`; nothing is
installed into this package. Real GitHub/Google sign-in, Agora Console, Stripe
checkout, refunds and webhook delivery still need registered credentials and an
HTTPS deployment to verify end to end.
