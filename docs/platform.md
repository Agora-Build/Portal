# Agora.Build Identity, Credits And Membership

The portal owns a private user with a permanent `account:<uuid>` ID, provider
identities, service connections, a subscription, and one credit wallet. Public
community profiles use separate `member:<uuid>` IDs. Signing in creates the
private user immediately; publishing a profile requires real intent.

Google, GitHub, Apple, and Agora identities are matched by verified issuer and
subject. Connecting another provider is an explicit operation on a signed-in
account. Agora callback `loginId` values never identify users, and an email
never signs anyone in on its own.

Each login keeps the provider's verified email privately, refreshed at every
sign-in (GitHub: primary and verified in `/user/emails`; Google and Apple:
`email_verified`; Agora OIDC: `email_verified`; Agora OAuth: none until its SSO returns a stable user ID). A new login
whose verified email already belongs to an account does not create a second
account. It is held for ten minutes in an HttpOnly `house_link` cookie in that
browser, and it is connected only when that browser then signs in with one of the
account's existing logins (`/auth/<provider>?confirmLink=1`). A sign-in to a
different account, an expired hold, or an account that already has a login from
the same provider connects nothing. Accounts that already share an email are not
merged. Emails appear only to the owner in a browser session (`/api/me`), never
to applications. Accounts and purchased credits survive public profile deletion.

## Storage And Deployment

Set `SITE_URL=https://agora.build` behind an HTTPS reverse proxy. Set `DATABASE_URL`
to a dedicated PostgreSQL database for production. The server creates
`agora_build_state`, a locked JSONB aggregate; identity, sessions, subscriptions,
payment receipts, and ledger mutations commit atomically. This initial storage
model prioritizes consistency and serializes writes; it can be split into
normalized tables as volume grows without changing the public user IDs.

Without PostgreSQL, local development uses `.data/community.json` and supports
one Node process. Back up the database or this private directory. Local admin
writes require stopping the portal and setting `PORTAL_OFFLINE_ADMIN=true`.
To move existing file data to an empty database, stop the old server, back up the
file, configure `DATABASE_URL`, then run:

```sh
node scripts/platform-admin.mjs import-json
```

Never run this import against Vox's database or overwrite an existing portal
database. The command refuses a nonempty destination. Provider OAuth transactions
remain in process memory for ten minutes; run one portal instance or use sticky
routing for `/auth/` until these transactions are moved to shared storage.

## Register Applications

`IDENTITY_CLIENTS_FILE` points to a private application registry. Start with
`config/identity-clients.example.json`; its sample rate is illustrative, not a
published price. Use `secretEnv` to refer to a server secret. Confidential web
clients need a secret of at least 32 characters, exact callback URLs, and explicit
scopes. There are no wildcard subdomains or shared domain cookies.

The `VOX_IDENTITY_CLIENT_SECRET` / `VOX_IDENTITY_REDIRECT_URI` shortcut registers
Vox. `ASTATION_IDENTITY_ENABLED=true` registers a public native client accepting
only `http://127.0.0.1:<port>/oauth/callback`. Use either the shortcut or a file
entry for an application, not both. Native clients have no secret and cannot
resolve other users or submit service charges.

| Scope | Access |
| --- | --- |
| `identity` | Own permanent user ID, display name, plan, and entitlements |
| `credits` | Own balance and statement; consent to registered service charging |
| `services` | Portal LLM and TTS endpoints |
| `agora:projects` | Own connected Agora projects and App IDs |
| `agora:certificates` | Explicit certificate retrieval for own Agora projects |

`identityLookup: true` permits a trusted application server to resolve provider
subjects at `GET /api/identity/accounts/<user-id>` for account migration. This is
a privileged server capability; it does not return provider tokens or certificates.

## Direct Login And SSO Contract

Use `integrations/agora-build-client.mjs` from a service's backend. The client
starts an Authorization Code flow with S256 PKCE and browser-bound random state:

```js
const started = client.begin(["identity", "credits", "services"]);
// Persist started.transaction in the application's private browser session.
// Redirect the browser to started.url.
const tokens = await client.complete(callbackUrl, savedTransaction);
const user = await client.user(tokens.access_token);
// user.sub is the portal ID in every app. Keep app-local ownership IDs mapped to it.
```

Clear the saved transaction before handling the callback. Regenerate the app's
local session after successful exchange. Store tokens server-side or in encrypted
native storage. Each application owns its HttpOnly cookie; only the portal sees
`house_session`. An existing portal session completes SSO without a provider
prompt. A fresh browser signs in centrally, creating the portal user before the
application receives tokens. This is OAuth, not an OIDC provider: there is no
ID token or discovery document.

| Endpoint | Purpose |
| --- | --- |
| `GET /oauth/authorize` | Registered callback, state, S256 challenge, scopes |
| `POST /oauth/token` | Form-encoded code exchange or refresh |
| `GET /oauth/userinfo` | Bearer token; stable `sub`, `plan`, `entitlements` |
| `POST /oauth/revoke` | Form-encoded app credentials and access/refresh token |
| `POST /api/auth/logout-all` | Portal browser session; revoke all app grants |

Codes expire after 60 seconds and redeem once. Access tokens expire after 15
minutes; refresh grants last 30 days. Refresh tokens rotate; clients must serialize
refreshes and save the new pair together. Reusing an old refresh token revokes its
grant. Logging out of a portal session also revokes grants created through it;
global logout invalidates every grant. Applications must consult the central
userinfo endpoint before relying on an existing local session; an app must not
keep granting access solely because its own cookie exists. Redact OAuth query
strings and credential headers in reverse-proxy logs.

## Shared Credits And Service Charging

`GET /api/credits/balance` and `/api/credits/statement` accept a portal browser
session or an app token with `credits`. No browser or native endpoint can grant
credits. The ledger uses whole credit units and balanced entries across user,
external, escrow, and platform accounts. Users start with zero credits.

Register paid operations in the client's `rates`, such as `evaluation`. The
service uses its own secret plus a user token issued to that same client:

```js
const hold = await client.reserve(userToken, "evaluation", requestKey);
// Run work only if hold.status === "reserved". Never repeat a pending request.
let result;
try {
  result = await runEvaluation();
} catch (error) {
  await client.settle(userToken, "evaluation", hold.id, "release");
  throw error;
}
await client.settle(userToken, "evaluation", hold.id, "capture");
return result;
```

`POST /api/platform/credits/reserve` uses `Authorization: Bearer <app-secret>`,
`X-Agora-Client-Id`, and `X-Agora-User-Token`. Its JSON body is
`{service, idempotencyKey}`; the registered server rate determines the charge.
Settlement uses the same headers and `{service, reservationId, outcome}`.
Reservations bind to the user and service; concurrent spending cannot overdraw
the wallet. Repeated keys never repeat work or charges. Complete operations within
one hour; stale holds are refunded by the five-minute reconciliation timer.

Portal LLM/TTS prices use `SERVICE_CHAT_CREDITS` and `SERVICE_TTS_CREDITS`.
Zero means no charge. Paid requests require a signed-in account and an
`Idempotency-Key` header. Failed model requests release their reservation.
People discovery and radar retain their existing shared service allowances.

## Subscription Plans And Purchases

The account page supports Basic, Premium, Principal, and Fellow, matching Vox's
plan names and entitlement limits. Premium provides 20 projects, 20 console eval
flows per project, 200 API eval flows, private resources, and own storage.
Principal/Fellow also permit mainline publishing and are assigned roles rather
than purchasable products. Vox enforcement starts with its later auth refactor;
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
node scripts/platform-admin.mjs grant-credits <user-id> <credits> <unique-key> <reason>
node scripts/platform-admin.mjs assign-role <user-id> <basic|principal|fellow>
```

`basic` removes an assigned role; it does not cancel a Stripe subscription.

## Agora Console Connections

Configure either an Agora OIDC identity service or Agora's existing OAuth service.
For existing OAuth, register a dedicated portal client with
`https://agora.build/auth/agora/callback`. Set `AGORA_OAUTH_BASE_URL`,
`AGORA_OAUTH_CLIENT_ID`, optional client secret, `AGORA_OAUTH_USERINFO_URL`, and
`AGORA_OAUTH_SUBJECT_FIELD` (`sub`, `user_id`, or `uid`). The identity endpoint must
accept Bearer tokens and return an immutable user ID. The current Astation
integration uses `sso2.agora.io`; `sso.agora.io` can be configured explicitly when
that is the registered issuer. The documented upstream userinfo 401 / changing
callback `loginId` issue must be resolved before existing Agora tokens can identify
portal users. The portal refuses to substitute email or the callback login ID.

Set `CONNECTION_ENCRYPTION_KEY` to a base64-encoded 32-byte server key. Agora OAuth
access/refresh tokens are encrypted with AES-256-GCM at rest. Keep and back up this
key separately from the database. `AGORA_BFF_URL` defaults to the existing
`https://agora-cli.agora.io` service used by Astation. OIDC sign-in alone does not
imply that its token is valid for this BFF; Console binding currently uses the
existing Agora OAuth flow.

The owner can list projects/App IDs and explicitly reveal a project's certificate.
Lists omit certificates; credentials never appear in userinfo or public profiles.
Certificates are fetched on demand and not cached in the portal database. The
browser clears revealed certificates after 30 seconds or when its tab is hidden.
Disconnecting removes the stored Console connection while keeping login identity.

Native clients can exchange an existing Agora token through `/oauth/token` using
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
`subject_token_type=urn:ietf:params:oauth:token-type:access_token`, `subject_token`,
and their public `client_id`. Identity verification uses the same permanent-ID
endpoint. The portal issues separate tokens; Agora tokens never become portal
sessions. An exchanged connection without a refresh token must be reconnected
for long-lived Console access.

## Vox And Astation Follow-up

Both repositories remain unchanged in this phase. Their next refactor should use
the central login flow, persist the global user ID, and check current central
entitlements. Preserve local ownership IDs while mapping them to the portal ID.
Map existing Vox identities using exact verified provider subjects, never email;
Apple subjects require compatible client/team grouping and must not be assumed
equal across different registrations. Existing Vox balances/history require an
explicit, backed-up migration with idempotent opening balances before moving
spending to this ledger. They have not been imported or combined here.

Astation should keep separate encrypted Agora BFF and Agora.Build sessions, so
portal LLM/TTS and credits can coexist with Agora Console access. Use loopback
PKCE for its central login and serialize rotating refresh-token requests.

## Verification

`npm test` covers identity/PKCE/revocation, ledger concurrency and refunds,
payment authenticity/idempotency, subscription lifecycle, resource ownership,
and public-file restrictions. PostgreSQL integration is optional in the default
suite: set `PORTAL_TEST_DATABASE_URL` to a dedicated database named
`agora_portal_test` and run `node --test tests/persistence.test.mjs`. That test
rebuilds its own table; never point it at production. Live provider sign-in,
Stripe checkout, refunds, and webhook delivery still require registered
credentials and HTTPS deployment to verify end to end.
