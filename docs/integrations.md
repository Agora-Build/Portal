# Unified Integrations: the Agora.Build design

> Status as of 2026-11-04. Production is not set up yet; everything tagged Built runs on dev from `main`.
> Tags: Built, Built (not deployed), Built (off), Partly built, Not built.

This is the single source of truth for Unified Integrations on the Agora.Build side, shared by Auth, the Portal, the
admin site, Astation and Atem. It says how integrations, Stations, the built-in Station and the admin site work, which
decisions hold them in place, and what is still to build. The D and Q numbers are the ones used in issues, pull
requests and commits; a number is never reused, and an answered question keeps its number.

The R9 wire and security contract belongs to Atem and Astation, and the system-wide architecture is described in
Astation's shared design,
[`designs/unified-integrations.md`](https://github.com/Agora-Build/Astation/blob/main/designs/unified-integrations.md).
Nothing here changes R9. The exact contracts live in the reference documents, which this design links to rather than
repeats:

- Auth's [`docs/integrating.md`](https://github.com/Agora-Build/Auth/blob/main/docs/integrating.md): tokens, the
  clients file, integrations, report clients, the management API, the change feed and passkeys.
- Auth's [`docs/station-tokens.md`](https://github.com/Agora-Build/Auth/blob/main/docs/station-tokens.md): what every
  Station checks on Auth's tokens, and how Auth and the Portal know a Station.
- The Portal's [`platform.md`](platform.md#stations-and-integrations): its tables, routes, lifecycle and the contract
  for Station builders.
- The admin site's [`docs/operations.md`](https://github.com/Agora-Build/Portal-Admin/blob/main/docs/operations.md)
  (a private repository): running the admin site.

Dev runs every repository's `main`: the Portal at https://dev.agora.build, Auth at https://auth.dev.agora.build (the
issuer), the admin site at https://admin.dev.agora.build and the built-in Station at https://station-dev.agora.build.
The production origins (`agora.build`, `auth.agora.build`, `admin.agora.build`, `station.agora.build`) are not set up.

## 1. Summary

Status: [Partly built] — Phase 1, registered Stations, the built-in Station, the admin site and the D28 scopes are
built; D27, the mobile app, Discord, the assistant, Station AI and account deletion are not, and production is not set
up.

Agora.Build is the control plane: accounts, sign-in, credentials, integration management and Stoa, and later the voice
assistant's pipeline. A Station is the data plane: encrypted storage, the R9 relay and the agent runtime, and later the
assistant's model with its context and tools. Signing in never grants device authority. An integration acts on a
person's agents only after that person approves it natively in Astation, which signs an R9 membership entry for the
integration's service identity.

- **Integrations** are Auth clients of one Station each: their own key pair, 5-minute client-credentials tokens whose
  `sub` is the owner, and no token before the native approval (§3.1).
- **Stations.** Any account can register its own Station with proof of control and share it (§3.3). Every account
  also has the **built-in Station**, which Agora.Build runs and Auth admits from its configuration (§3.3.2). On dev it
  hosts integrations through Astation's hosted agent API.
- **The admin site** holds Agora.Build's admin powers, with passkey sign-in and a reason on every change (§3.3.4). The
  Portal has no admin views. Plan roles, credits and signing keys still have command-line tools; moving them to the
  admin site is D27 (§3.3.5).
- **Launch, message and notify** (D28): Auth accepts the three scopes and the Portal offers them. The Station turns
  them into Atem's new signed operations only in builds with a feature that is off everywhere (§3.1.3).
- **Delegated host work** (D29, agreed by Atem, Astation and Auth/Portal on 2026-11-08; Phase A built in Auth, the
  Portal and the admin site, and Phase B's revocation reports in the Portal, off by default): Atem owns the tasks it
  accepts, so they survive their sender going offline or its integration expiring, while revocation stays signed, durable
  and race-safe; host-to-host senders use the same lifecycle (§3.11).
- **Later:** the mobile app (§3.3.3), Discord (§3.8), the assistant (§3.9), Station AI (§3.10), account deletion and
  export (§3.6), and production.

The rest of this design takes for granted: account IDs are `ab` plus a 26-character ULID, Auth's `sub`. The Portal's
API audience is its own origin (`https://agora.build`, dev `https://dev.agora.build`), exact, with no trailing slash.
Apps call the Portal under `/api/v1/...` with an access token; the website calls `/api/...` with its cookie.

## 2. Status at a glance

Status: [Partly built] — each row has its own tags; the notes under the table say what is missing.

| Area | Decisions | Auth | Portal | Admin site | Station (Astation) | Atem |
|---|---|---|---|---|---|---|
| Phase 1 integrations (§3.1, §3.2, §3.5, §3.6) | D1, D2, D5, D6, D9, D15–D17 | [Built] | [Built] | n/a | [Built] | [Built] |
| Registered Stations (§3.3) | D3, D4 | [Built] | [Built] | [Partly built] | [Built] | [Built] |
| Sharing (§3.3.1) | D3 | [Built] | [Built] | n/a | n/a | n/a |
| The built-in Station (§3.3.2) | D24 | [Built] | [Built] | [Built] | [Built] | [Built] |
| Built-in apps (§3.3.3) | D25 | [Partly built] | [Built] | [Built] | [Partly built] | n/a |
| The admin site (§3.3.4) | D26 | [Built] | [Built] | [Built] | [Built] | n/a |
| Management through the admin site (§3.3.5) | D27 | [Not built] | [Not built] | [Not built] | n/a | n/a |
| Launch, message and notify (§3.1.3) | D28 | [Built] | [Built] | n/a | [Built, off] | [Built] |
| Delegated host work (§3.11) | D29 | [Built, off] | [Built, off] | [Built, off] | [Not built] | [Not built] |
| Hosted agent execution (§3.3.2) | D2, D24 | n/a | n/a | n/a | [Built] | [Built] |
| Discord (§3.8) | D18, D22 | n/a | [Not built] | n/a | [Not built] | n/a |
| The assistant (§3.9) | D8, D20 | [Not built] | [Not built] | n/a | [Not built] | n/a |
| Station AI (§3.10) | D11–D13, D21 | n/a | n/a | n/a | [Not built] | [Not built] |
| Production | — | [Built, not deployed] | [Built, not deployed] | [Not built] | [Built, not deployed] | n/a |

Notes:

- **Registered Stations, admin site:** it lists only the built-in Stations. Auth has no admin listing of custom
  Stations yet.
- **Built-in apps, Auth:** the Portal, Astation and the admin site are first-party clients, and so are Astation's
  phone apps, `astation-ios` and `astation-android`, with exact private-use redirects (live on dev since 2026-11-08).
- **Built-in apps, Station (Astation):** the Astation app is a built-in app; its phone apps are not finished.
- **Launch, message and notify, Station (Astation):** the Station maps the three scopes to Atem's operations only with
  the Cargo feature `host-work-api`, which is off on every Station. Astation's consent review, signing gate and native
  launch are merged; its message inbox is not built.
- **Delegated host work:** the design was agreed by Atem, Astation and Auth/Portal on 2026-11-08. Phase A is built in
  Auth, the Portal and the admin site, off by default (Auth's `AUTH_DELEGATED_HOST_WORK`, the Portal's
  `DELEGATED_HOST_WORK`, and the admin site's own `DELEGATED_HOST_WORK`, turned on in that order). Phase B, the Station's
  revocation reports and the per-host counts, is built in the Portal, off under the same `DELEGATED_HOST_WORK`; Phase C is
  not started (§3.11 says what the phases are). Atem has started its shared core, and nothing new is activated until the
  agreed schemas, compatible verifiers and end-to-end tests are in place.
- **Hosted agent execution:** the dev Station image is built with the Cargo feature `hosted-agent-api`; default and
  production builds keep it closed.
- **Production:** no production Auth, Portal or built-in Station is set up. The admin site's code accepts only its dev
  origin until passkeys are verified on dev and the owner approves production.

## 3. Design

Status: [Partly built] — each section has its own tag.

### 3.1 Integration credentials: each integration is an Auth client

Status: [Built]

When a person creates an integration in the Portal, the Portal asks Auth to create a **client** for it:

- `client_id` is the integration ID: `i-` plus 26 lower-case Crockford base32 characters. Its owner is the person's
  `ab…` account, and only the owner creates it (Auth checks that the acting account is the owner).
- Client authentication is **`private_key_jwt`** (RFC 7523): the integration signs a short assertion with its own
  private key, and Auth checks it against the integration's registered **public** key.
- Its allowed resource is exactly the Station the person chose, which must be one they may use. Its scopes are the
  operations they chose. `agent.view` is always included: the Portal adds it, and Auth refuses an integration without
  it.
- It expires after 30 days unless the person picks another expiry, at most 90 days (D9).

Every integration today is a **Custom App / API** (the Portal records the kind `custom_app`). Discord and the
assistant are later kinds (§3.8, §3.9).

**Who generates the key.** Whoever runs the integration, never Agora.Build:

| Integration | Key pair generated by | What Agora.Build stores |
|---|---|---|
| Custom App / API | The developer (any JOSE library), or the Portal **in the browser** with WebCrypto (P-256) on request: the private key is offered once as a download and never sent to the server | The public key (JWK) |
| Discord, assistant [Not built] | The Station agent module or Agora.Build service that runs it, in its own protected storage | The public key |

Keys are ES256, EdDSA (Ed25519) or RS256 (2048 to 4096 bits, exponent 65537). Auth names each key by its RFC 7638
thumbprint and refuses a JWK with private members. Only public keys reach Auth, so a leaked Auth or Portal database
reveals no integration secret.

The integration gets access tokens with the **client-credentials grant**:

```http
POST https://auth.agora.build/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
&client_assertion=<JWT signed with the integration's private key: iss = sub = client_id, aud = the token endpoint, jti, iat, exp at most 60 s later>
&resource=https://station.example
&scope=agent.view agent.prompt
```

On dev the issuer is `https://auth.dev.agora.build`. Assertions are single-use; the exact rules are in
[`docs/integrating.md`, "Integrations"](https://github.com/Agora-Build/Auth/blob/main/docs/integrating.md#integrations-discord-custom-app--api).
The token is a JWT access token (`at+jwt`, ES256): `iss` = Auth's issuer, `aud` = the Station's origin, `sub` = the
integration owner's account (`ab…`), `client_id` = the integration ID, `scope` = the granted operations (never more
than the integration was granted), `r9_svc` = the SHA-256 fingerprint of its R9 service public key (§3.1.1), and `exp`
**5 minutes** after issue. There are no refresh tokens.

**No token before approval.** Until the Portal has recorded the integration's R9 service fingerprint, which it does
when the owner approves the integration natively (§3.6), Auth answers a token request with `unauthorized_client`. Auth
also issues no token while the integration is paused, revoked or expired, its Station is removed, or its owner's
account is disabled.

**Local verification (D2).** A Station verifies tokens locally against Auth's published keys (JWKS), with no call to
Auth per request. The checks every Station runs are in
[`docs/station-tokens.md`, section A](https://github.com/Agora-Build/Auth/blob/main/docs/station-tokens.md#a-a-station-verifying-auths-tokens).

**Why a client per integration.** It settles the shared design's "service-to-account delegation" gap: Auth attests the
binding by issuing a token whose `sub` is the owner and whose client is the integration. No person's session is
impersonated, no refresh token is copied, and a Station never maps a service subject to a person by email.

#### 3.1.1 Binding the token to the R9 service identity

Status: [Built]

When the owner approves an integration, Astation reports the approval to the Portal with the fingerprint of the
integration's R9 service public key (`POST /api/v1/integrations/<id>/approval` with `r9Svc`, 64 lower-case hex
characters). The Portal stores it at Auth, and Auth puts it in every token as `r9_svc`. A Station refuses an
integration token whose `r9_svc` doesn't match the service identity it holds for that integration (station-tokens.md,
check 8).

The token is still **not** R9 authority. The agent module acts through its own R9 service identity, which a native
manager signed, and every request is limited by the token's scopes, the integration's policy on the Station and the
host-verified R9 grant. The R9 grant ends with the integration, at most 90 days after it is signed.

#### 3.1.2 Quotas

Status: [Built]

Each integration has a rate limit, **default 200 requests per second**, from 1 to 10,000 (Agora.Build's maximum).
Auth applies it to token requests, counted per minute (quota × 60 requests in each 60-second window). The Station
applies it per second to the integration's calls on its hosted agent API and answers 429 `integration_quota` [Built:
Astation]. The Portal shows and edits the quota per integration, and the Station's feed carries it.

#### 3.1.3 Launch, message and notify scopes (D28)

Status: [Partly built] — Auth, the Portal and Atem are built; the Station maps the new scopes only in builds with the
Cargo feature `host-work-api`, which is off on every Station; the joint check on a real host, mark delivery and
Astation's message inbox are not done.

D28 adds three host permissions, signed R9 operations that Atem shipped in v0.8.2 (Atem PR #114) [Built: Atem], and
one integration scope for each. Atem now has ten operations: `approval`, `interrupt`, `launch`, `message`, `notify`,
`prompt`, `rule_revoke`, `stop`, `terminal` and `view`.

- `launch` starts an agent session from a profile the owner approved on the host. A request can't supply commands,
  paths or credential values.
- `message` sends a message (text, an exact context snapshot, a Chisel mark or a PNG attachment) to the account's
  hosts or projects. The host stores it with a receipt. On its own it never reaches an agent: receiving a message
  never grants execution rights.
- `notify` lets a sent message go to one agent's queue. The host hands it to that agent as an ordinary prompt when the
  agent is free: not mid-turn and with no approval card waiting, no draft in its input and no one holding control, and
  the sender still authorized. Such messages go one at a time, in order. They never take control, and their result is
  tied back to the message. Atem also requires `prompt` and the owner's approval of that route and sender on the host.

Atem has no inbox yet: a message that is not notified stays a receipted record on the host.

| Token scope | Signed R9 operation | What the integration can do |
|---|---|---|
| `agent.launch` | `launch` | List the host's approved profiles, start a session from one, and query its own launches |
| `agent.message` | `message` | Send messages, context and attachments to the account's hosts and projects, and query their receipts. Never makes an agent act |
| `agent.notify` | `notify` | Let its messages go to an agent's queue and become work for that agent, with the task's result. Needs `agent.message` and `agent.prompt` too |

For comparison, the Station maps the older scopes as `agent.view` → `view`, `agent.prompt` → `prompt`,
`agent.approve` → `approval` and `rule_revoke`, `agent.interrupt` → `interrupt` and `stop`, and `agent.terminal` →
`terminal`.

**How they differ from `agent.prompt`.** `agent.prompt` types into one running session at once, and may take control.
A message with `agent.notify` waits its turn and is handed to the agent only when it is free, so it is a delayed
prompt. That is why it needs `agent.prompt` as well.

**Why three scopes.** CI and other systems can be given `agent.message` alone. They can then deliver messages to a
host or project but can never make an agent act; the owner decides what an agent works on. `agent.notify` is for
automation the owner trusts to queue work by itself. A stored message has nowhere to show today. An inbox in Astation
is requested follow-up work: it lists the messages on the account's hosts, with a "Start work on this" action that
sends one to an agent under the owner's own authority [Not built: Astation].

**Rules:**

- `agent.view` stays required.
- `agent.notify` requires both `agent.message` and `agent.prompt` in the same integration. The Portal checks it first
  (400, code `scopes`, "agent.notify needs agent.message and agent.prompt."), and Auth refuses it too (its management
  API answers 400 `scopes` with the same message).
- `agent.launch` and `agent.message` are independent of every other scope. `agent.prompt` never implies launch or
  notify.
- They work the same on the built-in and custom Stations, and plan limits don't change.
- An integration's scopes are fixed when it is created, so existing integrations gain nothing. The owner creates a new
  integration and approves it in Astation.
- Tokens are issued as for every integration (§3.1). The Station's policy feed gives each integration's scopes exactly
  as granted, and changes, pauses and revocations reach it through the same feed (§3.5).
- **Chisel marks** keep using `agent.view` and `agent.prompt` plus the owner's separately approved signed `message`
  and `notify` permissions, and no new token scope. On the Station they are behind `host-work-api` too.
- **Native members** (Astation and Atem devices) use their existing membership, control and local host consent, not
  these scopes.
- The Portal shows all three checkboxes (the owner chose no switch), with exactly these descriptions:
  - *agent.launch*: "Start new agent sessions on your hosts, only from profiles you approved there."
  - *agent.message*: "Send messages, context and attachments to your hosts and projects. On their own, messages never
    make an agent act."
  - *agent.notify*: "Let this app's messages become work for an agent, handed to it when the agent is free. Also needs
    agent.message and agent.prompt, and your approval of the route on the host."
  - and a closing sentence: "All three need an upgraded Atem on the host."
- Astation's native consent review shows the eight integration scopes and their prerequisites; existing grants gain
  nothing. Astation can also launch an agent natively (Connections → New Agent) from profiles approved on Atem [Built:
  Astation].

**The signing gate (the owner's decision).** An old host doesn't just ignore the new permissions:

- Atem's strict device-list check in v0.8.1 and earlier accepts only the seven older operations
  (`crates/atem-client/src/membership/entry.rs`).
- A signed entry with an unknown operation fails the whole chain check at that entry (`verify_chain`).
- So an old host stops at that entry, and no later entry reaches it, revocations included. Older native apps and
  bindings that check the account's device list refuse it the same way.

So:

1. **The Station** maps the three scopes (`relay-server/src/station_integrations.rs`) only in builds with
   `host-work-api`. Without it an unknown scope maps to no operation and grants nothing [Built, off: Astation].
2. **Astation** signs `launch`, `message` or `notify` for a host only once that host's Atem, and every other strict
   checker of the account's device list, supports them. It tells the owner to upgrade Atem on that host first [Built:
   Astation].

**Rollout** [Not built]. Auth and the Portal are live on dev, and nothing changes for hosts until a Station runs with
`host-work-api`. Before that, the public host-work rollout needs acceptance on a real host, in a joint check on dev
with an upgraded Atem on a test host, the Station's mapping and endpoints, and Astation's UI:

1. The owner creates one integration with `agent.message` only, and another with `agent.launch`, `agent.message`,
   `agent.notify` and `agent.prompt`. The owner approves both in Astation.
2. The message-only integration's message is stored and never reaches an agent.
3. The second integration launches a session, sends a notice, then sends a message that becomes the agent's work.
4. The Portal and Auth confirm the records, and a pause and a revoke still close everything.

Production follows the separate production rollout, with the owner's approval. The context and mark publisher
(Astation PR #71, a draft) and live mark delivery are follow-up work with Atem [Not built: Astation, Atem].

### 3.2 Revocation, rotation and outages

Status: [Built]

| Event | Behaviour |
|---|---|
| Pause or revoke an integration | Auth changes its status in the same transaction, so new tokens are refused at once (`invalid_client`). The Portal appends the change to the Station's feed and pushes the Station a nudge. The Station then refuses the integration's still-valid tokens and closes its open sessions and streams; without the push, its one-minute poll picks the change up. Tokens are never trusted past their 300 s lifetime anyway. A pause can be resumed; a revocation is final. R9 removal is a separate step signed by a native manager. |
| Expiry | Auth issues no token after the expiry. The Portal shows the integration as `expired`, and the Station treats it like a pause. Renewing sets a new expiry. |
| The owner's account is disabled | Auth issues none of the owner's integrations a token. The Portal shows them paused, and Stations see an Agora.Build pause (§3.3.4). |
| Rotate the key | The owner registers a new public key. Auth accepts assertions signed by **both** keys for a **10-minute overlap**, then drops the old one, which stays as history. Allowed while paused, refused once revoked. The R9 service key is unchanged. |
| Auth unavailable | Issued tokens keep working until they expire. New ones can't be issued, so integrations stop within 5 minutes. |
| Auth rotates its signing keys | A new key every 90 days; the old one stays published 30 more days, and an exposed key leaves the JWKS at once. A Station refetches the JWKS for an unknown key ID at most once every 5 seconds (across all key IDs), and while Auth is unreachable trusts its cached keys for at most 1 hour after the last successful fetch ([station-tokens.md](https://github.com/Agora-Build/Auth/blob/main/docs/station-tokens.md#a-a-station-verifying-auths-tokens), check 4). |

### 3.3 Registered Stations (custom relays)

Status: [Built]

Every Station is known to Auth. A custom Station, such as a self-hosted relay, is registered through the Portal:

1. Any signed-in account can register one: in the account page's Stations section, **Add Station**, then its origin
   (`https://host`, optionally a port, no path).
2. **Proof of control.** The Portal issues a random value, valid 10 minutes and once. The Station serves it at
   `/.well-known/agora-build-station`, and the Portal fetches it over HTTPS with no redirects, refusing private and
   loopback addresses ([platform.md, "For Station Builders"](platform.md#for-station-builders)). Only then does the
   Portal ask Auth to register the Station, with the public half of the Station's own report key.
3. Auth stores it in its **registered-Stations table**: origin, owner, status, report client, creation and
   verification times, and its members.
4. **By default only the registering account can use it.** Nobody else can sign in to it, relay through it or create
   integrations on it.
5. The owner shares it from the Portal (§3.3.1), and can remove it, which revokes every integration on it.

**Making sign-in work with a custom Station.** Registering a Station makes everything that works with the built-in
Station work with it:

- Auth resolves the Station's origin as a resource with the Station scopes (`astation.remote` for native clients, the
  integration scopes, `station.read` for the browser), so Astation and integrations get tokens whose `aud` is that
  Station.
- Auth creates the Station's own report client, `s-` plus 26 characters, for reporting to the Portal (§3.5). A custom
  Station's report key changes only by removing the Station and registering it again.
- Astation and Atem point at it with the same setting they use for the built-in Station (Atem's
  `astation_relay_url`); nothing else changes in the client.
- The Station checks that every token's `aud` is its own origin. Auth guarantees at issuance that `sub` is an account
  allowed on it, so a Station need not hold the member list (station-tokens.md, check 6).

Auth refuses a custom Station at Auth's own origin, and at a static resource's or a built-in Station's origin
(`origin_taken`).

**Shared or public relays**, a Station serving people who aren't its owner's invitees, are later work (owner decision)
[Not built]. Today only a built-in Station has the `any_account` access mode.

#### 3.3.1 Sharing a Station

Status: [Built]

From the Stations section the owner shares a Station with other Agora.Build accounts, by their `ab…` IDs. Auth adds
them to the Station's members, and each can then use the Station as their relay in their own Astation. Removing
someone, or a member leaving, stops new tokens for them at once and revokes their integrations on that Station; tokens
already issued expire within their lifetime. Sharing grants only the use of the relay and the Station's services under
each person's own account: accounts stay separate.

#### 3.3.2 The built-in Station

Status: [Built]

The built-in Station and custom Stations are the same kind of thing (D24). They share one protocol with Auth, the
Portal and Atem. A custom Station may add functions its owner wants, and the built-in Station functions Agora.Build
wants; both keep the shared protocol. Only how a Station is admitted, and who may use it, differ.

On dev the built-in Station is `https://station-dev.agora.build` (Station ID `st01M681Q0DZ7HS3PQV56115ZY6T`, report
client `s-01m681q0dz8b74nq8sdypjgrrp`), with integrations on. Dev never uses the production origin. The production
built-in Station, `https://station.agora.build`, waits for production Auth [Built, not deployed].

**1. The shared Station protocol.** Every Station implements it, whatever its kind:

| Direction | Contract |
|---|---|
| Native apps → Station | An `astation.remote` token from Auth with `resource` = the Station's exact origin: `aud` = the origin, `sub` = the person, 900 s, `auth_time` (§3.4) |
| Integrations → Station | An `i-…` client with `private_key_jwt` and client credentials: `aud` = the origin, `sub` = the integration owner, `r9_svc`, 300 s; no token before native approval (§3.1) |
| Station → Portal | Its report client `s-…` (`private_key_jwt`, scope `station.report`, resource = the Portal's origin): `POST /api/v1/stations/reports` and `GET /api/v1/stations/changes?cursor=`, with `ownerAccount` in snapshots and `409 cursor_ahead` recovery (§3.5) |
| Portal → Station | An unsigned push hint, `POST <origin>/agora-build/v1/changes` with `{ cursor }`: a reason to poll, never authority |
| Browser → Station | A 5-minute `station.read` token from token exchange; `GET <origin>/agora-build/v1/details`, with CORS from the Portal origin only |
| Station ↔ Atem, Astation | The R9 relay and service membership of the shared design; native approval binds `r9_svc` |

The report contract and the native token contract are the same for both kinds: the built-in Station has no special
token, claim or route.

**2. What differs:**

| | Built-in Station | Custom Station |
|---|---|---|
| Admission | **Configured** in Auth's clients file by Agora.Build; no proof of control | Registered in the Portal with proof of control (§3.3) |
| Report key | Configured by the operator: a public JWK; the private key stays on the Station | Given at registration |
| Who may use it | **Every signed-in account** that is not disabled (access mode `any_account`) | The owner and the accounts it is shared with (access mode `members`) |
| Owner | **No one.** It belongs to Agora.Build and is administered by its configured `admins` on the admin site (§3.3.4). **Nobody can unregister it** through any API or page, admins included; only Auth's configuration and a restart change it | The registering account, which can remove it |
| Integrations | Only while its `integrations` setting is on, which Agora.Build turns on once it supports hosted execution there (on for dev). Any account may then create them, each owned by its creator. Active integrations per account are limited by plan: **Basic 4, Premium 10, Principal and Fellow no cap** | The owner and members; **no cap on any plan** |
| Pausing or revoking other people's integrations | Its admins, on the admin site | The Station's owner, in the Portal |
| Default | **Every account's default Station.** Always there; a person can switch back to it at any time | Optional; a person chooses it in Astation |
| Extra functions | Agora.Build's choice, including Station AI once it supports it (D21) | The owner's choice, on the same protocol |

**3. Configuration.** Auth's clients file has a `stations` list:

```json
"stations": [
  { "origin": "https://station.agora.build", "name": "Agora Station", "access": "any_account", "integrations": false,
    "admins": ["ab<Agora.Build admin account>"],
    "reportKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } }
]
```

- `origin` follows the rules for registered Stations (https, lower case, no path). It can't also be a resource, nor
  Auth's own origin.
- `access` must be `any_account`; `integrations` defaults to `false`.
- `admins` lists at least one Agora.Build account. The union of every built-in Station's admins is Auth's set of
  configured admins, which the admin site's `ADMIN_ACCOUNTS` must equal (§3.3.4).
- `reportKey` is a public ES256, EdDSA or RS256 JWK; a private member is refused.
- `"retired": true` retires an entry (item 4).

Station scopes belong to Stations: a static resource in the clients file can't list them, and a client lists no
Station in its `resources`. A client's `stationScopes` say which Station scopes it may ask for on any Station it may
use. The full field list is in
[`docs/integrating.md`, "Clients-file fields"](https://github.com/Agora-Build/Auth/blob/main/docs/integrating.md#clients-file-fields).

**4. Auth.**

- **Seeding.** At startup, in one transaction under an advisory lock, Auth makes the built-in Stations match the file:
  a Station row flagged `built_in`, with its report client `s-…` created once and kept by origin across restarts and
  replicas. The name, the admins and the `integrations` setting follow the file. A changed `reportKey` becomes the
  current key, and the old one keeps working for 10 minutes. A retired key can never come back, on any client
  (`key_retired`).
- **Fail closed.** A seeded built-in Station missing from the file makes Auth refuse to start (`built_in_missing`), and
  nothing is revoked: an accidental edit must never revoke every integration on the shared Station. Retiring one needs
  an explicit entry with `"retired": true`, which revokes its report client and integrations as for a removed Station,
  and nudges the Portal. Adding the origin back later creates a new Station and report client; revoked integrations
  are never revived. A configured origin already held by a custom Station also stops the start (`origin_taken`).
- **Access modes.** Every check of "may this account use this Station" (native Station tokens, integration creation,
  the final check as a token is signed, the `station.read` exchange) asks: `members`, the owner or a member;
  `any_account`, any existing account that is not disabled.
- **Management API.** Built-in Stations are listed with `builtIn: true` and their `access` mode, and
  `GET /manage/v1/built-in-stations` lists them with no account (the Portal's sync, the admin site). Removing one, and
  every member route on it, answers `409 built_in` whoever asks; registering its origin, `409 origin_taken`; creating an
  integration while `integrations` is off, `409 not_supported`.
- **Admins.** The configured admins hold the Station-owner rights on it (pausing and revoking other accounts'
  integrations there, and lifting an admin pause), but only through the admin client with a step-up proof (§3.3.4).
  Through the Portal an admin is an ordinary account. Admins are not the Station's owner and cannot remove it.

**5. Portal** ([platform.md, "The Built-in Station"](platform.md#the-built-in-station)).

- Every signed-in account sees the built-in Station first, marked "Built in", with no Remove or Share; the Portal
  refuses those actions and registering its origin as Auth does, without asking Auth. The Station is offered for
  integrations only while Auth's `integrations` setting for it is on; everything else then works as on any Station.
- **Plan limits.** The Portal, not Auth, enforces them: Auth knows nothing of plans. It counts the account's
  integrations on the built-in Station in every state except `revoked`, and not expired, and at the plan's limit
  answers `403 plan_limit` ("Your plan allows N integrations on the built-in Station. Revoke one, upgrade, or use your
  own Station."). With `DELEGATED_HOST_WORK` on (D29), `revoking` doesn't count either: Auth has already revoked the
  integration, and its hosts may take up to 24 hours to confirm. Renewing an expired one counts as a creation. After a move to a plan with a lower limit, existing
  integrations keep working and new ones wait until the account is under its limit. The count is exact within one
  Portal process; several replicas could pass it by one (accepted).
- The feed and reports work as for any Station: its report client sees every integration on it, each with
  `ownerAccount`, and only those. Its report token's `sub` is its own client ID, which reaches only the two report
  routes.
- **Sync.** The Portal reads `GET /manage/v1/built-in-stations` when it starts and then hourly. Reconcile treats a
  built-in Station as present for every account: a listing without it never removes it or revokes anything.

**6. Station (Astation's server)** [Built: Astation]. It generates its report key pair, keeps the private key and
gives Agora.Build only the public JWK. It runs the same report and feed client as a custom Station, and serves
`/agora-build/v1/details` to `station.read` tokens with CORS from the Portal origin. Key thumbprints are RFC 7638
SHA-256 values; handoffs write them in base64url, as Auth does (a hex value is the same digest). Station AI is not
offered on it yet (§3.10).

**7. Choosing a Station.** The built-in Station is every account's default relay. A person who adds a custom Station
may switch Astation and Atem to it, and back to the built-in Station at any time. A selected custom Station stays
pinned: an outage never routes silently to the built-in Station, and switching back is an explicit choice. Switching
repeats the Atem and Astation verification for the new relay (the trust and pairing checks they already run for a
relay change). Device pairing and native approval of the exact R9 scope stay required on both kinds of Station, and
the relay is never authoritative for device trust. Auth and the Portal take no part beyond issuing `astation.remote`
for the chosen origin. Atem picks its relay with `astation_relay_url`, whose compiled default is the production origin
`https://station.agora.build`; dev hosts set `https://station-dev.agora.build` [Built: Atem]. Astation's own Station
picker is Astation's and is not tracked here.

**8. Security.**

- Agora.Build's admins administer the built-in Station but don't own other people's integrations on it: they can
  pause, revoke and lift an admin pause, never approve an integration or act as its owner.
- Every integration still needs its owner's native approval: `any_account` opens use of the Station, not anyone's
  agents.
- The built-in Station's operator sees the `ownerAccount` of the integrations it hosts, as any Station operator does.
- Load on the shared Station is bounded by the plan limits, each integration's quota and the Portal's per-account rate
  limits.
- Integrations or Station AI on the built-in Station mean Agora.Build's server processes the agent content of the
  accounts that use them there. Astation says so when a person approves such an integration ("Agora.Build can read
  and process the agent content permitted by this integration. This grants no access to your vault or saved
  credentials.") [Built: Astation], and must say so again when Station AI is turned on there (§3.10).

**9. Hosted agent execution** [Built: Astation]. Integrations act on hosts through the Station's hosted agent API,
`/api/agent/v1/integrations/:id/hosts/:host/...`, under the integration's token, scopes, quota and R9 grant. The dev
Station image is built with the Cargo feature `hosted-agent-api`, so https://station-dev.agora.build runs it. Default
and production builds keep it closed.

#### 3.3.3 Built-in apps (Portal, Astation, a mobile app)

Status: [Partly built] — the Portal, Astation, the admin site and Astation's two phone clients are first-party clients
at Auth; the phone apps themselves are Astation's and not finished.

Agora.Build's own apps (D25) are first-party clients of Auth. People sign in to them as themselves. They are neither
integrations (a person's own apps or bots acting on their agents, created at runtime and natively approved) nor
Stations.

| | Added how | Signs in as |
|---|---|---|
| Built-in apps | **Once**, in Auth's clients file (a new kind of app is a one-time configuration change) | The person (authorization code with PKCE, or device code) |
| Integrations | At runtime in the Portal, each natively approved | Its own `i-…` client, acting for its owner |
| Stations | Built-in by configuration; custom through the Portal | Its own `s-…` report client |

Today these are the `portal` web client, the `astation` native client (PKCE on a loopback redirect or device code,
with `integrations:read` and `integrations:approve` on the Portal and `astation.remote` as its Station scope), and the
admin site's `admin` client (§3.3.4), and Astation's phone apps `astation-ios` and `astation-android` (below).
First-party web apps see no consent page.

**The phone apps** [Not built: Astation] are Astation for iPhone and iPad (`astation-ios`) and Astation for Android
(`astation-android`) (Auth #18, Portal #30). At Auth they are public native clients [Built]: no secret, PKCE S256
required, refresh tokens with rotation, first party, and the browser asks the person to confirm each sign-in. They
request only what they use:

- `openid profile offline_access` for the person's sign-in;
- `astation.remote` on the person's chosen Station (built-in or custom, exact origin), to view and control their
  agents through the shared Station protocol, with the same token contract as the Mac's Astation.

They get no Portal resource or API scopes (no `integrations:read` or `integrations:approve` yet) and no device grant.
Signing in never makes the phone an R9 member: native membership and the encrypted channel stay separate
prerequisites (Q5).

**Mobile redirect URIs at Auth** [Built] (Auth PR #19). Besides `http://127.0.0.1/callback` (any port), a native
client may register exact **private-use redirects** under Agora Build's reverse domain (RFC 8252 §7.1):
`build.agora.<app>:/<path>`, lower case, one slash after the colon, no query or fragment. They are matched exactly, a
client uses loopback or private-use redirects but never both, and only `type: "native"` clients may use them. PKCE
S256 protects the code if another app claims the same scheme. Astation's apps use
`build.agora.astation.ios:/oauth/callback` and `build.agora.astation.android:/oauth/callback`. **Claimed https
redirects** (with Apple associated domains and Android app links, the Portal serving the association files) aren't
used yet [Not built].

**Push notifications** to the phone (an approval waiting, an agent asking a question) are later work with Astation's
mobile work [Not built: Astation].

Open: Q5 (approving integrations on the phone).

#### 3.3.4 The admin site (D26)

Status: [Built]

Agora.Build's administrative powers live on a **separate admin site**, not in the Portal. The Portal's account page
shows each person only their own things; admin work happens on a site built for it, with stronger sign-in and a full
audit trail. It runs on dev only, at https://admin.dev.agora.build, from the private repository
`Agora-Build/Portal-Admin` (Q7). Running it is described in
[`docs/operations.md`](https://github.com/Agora-Build/Portal-Admin/blob/main/docs/operations.md).

**Why.** Least privilege: the session people use every day (credits, profile, their own integrations) should not also
carry the power to revoke other people's integrations. A separate site can demand a recent, multi-factor sign-in for
privileged actions, and can add a network restriction later without slowing anyone else down.

**Shape.**

- A separate web app on its own origin (`https://admin.agora.build`, dev `https://admin.dev.agora.build`), never
  embedded in the Portal. Its own first-party Auth client, `admin` (web, confidential), with `manage: true`, so it calls
  Auth's management API itself. Auth accepts exactly one admin client: authorization code only, no refresh tokens, only
  the `openid` and `profile` scopes, no resources or Station scopes, and a back-channel logout address.
- **Who may sign in:** only accounts in its `ADMIN_ACCOUNTS`, which must equal Auth's configured admins (the built-in
  Station's `admins`, §3.3.2). Anyone else is refused after sign-in and shown nothing.
- **Sign-in:** authorization code with PKCE, always with `prompt=login`, `max_age=0` and `acr_values=urn:agora:mfa`. The
  ID token must be at the MFA level and at most 5 minutes old. Sessions are short (15 minutes idle, 8 hours at most),
  with host-only cookies, same-origin checks on every change, a strict Content-Security-Policy, and no bearer or API
  access: no third-party app can act as an admin.
- **Audit:** every admin action carries a reason the admin types. Auth records it with the admin as actor
  (`integration_audit` for integration changes; `admin_actions` and the account's `audit_log` for account changes),
  the Portal records integration changes in `integration_events`, and the admin site keeps its own append-only log of
  sign-ins, views and changes.

**Functions** (phase 1, as built):

| Function | How |
|---|---|
| Find integrations across the platform | By Station, owner account, client ID, name and state; newest first, paged |
| See one integration | Owner, Station, scopes, state, who paused it, expiry, quota, and whether `r9_svc` is set (never its value), with the admin site's own log of it |
| Pause, revoke, or lift an admin pause | With a required reason, through Auth's management API, actor = the admin. Auth allows it only on a built-in Station the admin administers |
| See one account; disable, enable, reset its passkeys | Name, disabled or not, number of passkeys; never email or logins. No change to the admin's own account (403) |
| List Stations | The built-in Stations, read-only (they change only through configuration) |

Not in phase 1 (owner decision): an integration's Auth audit history and the Portal's events for it, and the list of
custom Stations with their integration counts. Auth has no admin reads for them yet, so the site shows its own log
instead [Not built]. Later, as separate decisions: account deletion requests (D19) and abuse reports from people
[Not built].

**Owner requirements, and how the design meets them.**

1. **Auth enforces every admin permission server-side.** The admin site is not trusted to decide who is an admin.
   Every cross-account management call (searching other accounts' integrations, pausing or revoking one, account
   administration) must come from the `admin` client, authenticated with its own credentials, and carry the admin's
   **step-up proof** in the `agora-step-up` header: an ID token Auth itself issued to the `admin` client. Its `sub`
   must equal the `actor`, the actor must be a configured admin whose account is enabled, `acr` must be
   `urn:agora:mfa`, `amr` must include `hwk`, `auth_time` must be recent enough, and its `sid` must be a live session.
   A call missing any of these is refused and nothing changes: `400` for an unknown or disabled actor, `403 forbidden`
   for an actor who is not an admin or a proof of another account, and `401 mfa_required` when the proof is missing,
   stale or not at the MFA level. The Portal's own management calls cannot act across accounts, and the admin client can
   call only admin routes.
2. **Pause and revoke take effect immediately, including active sessions.** At Auth the status changes in the same
   transaction, so new tokens are refused at once. The Portal learns of it through Auth's change feed (below), appends
   it to the Station's feed and pushes the Station, which refuses still-valid tokens and closes open streams and
   sessions. Without the push, the Station's poll picks it up within a minute; issued tokens are never trusted past
   300 s anyway. A revoked integration's sessions on the Station end on revocation, not at token expiry.
3. **Every admin action has a reason and an auditable actor.** The reason (1 to 500 characters, one line) is sent with
   the call and stored by Auth with the admin as actor. Account changes are first recorded in `admin_actions`
   (`started`, then `done` or `failed`); if that record can't be written, nothing changes.
4. **Admin re-authentication never silently reuses an SSO session.** Because the admin site always asks for
   `prompt=login`, `max_age=0` and the MFA level, Auth runs its sign-in interaction even if the browser has an Auth
   session, and always asks for the passkey. That step is interactive, so even a silent upstream login (GitHub,
   Google) can't complete an admin sign-in on its own. Auth issues the `admin` client an ID token at the MFA level only
   if the passkey was used in that same interaction.

**How old a proof may be** (owner decision). Read-only admin calls (the search, one account) accept a proof up to
**15 minutes** old, the admin session's idle limit; every change needs one at most **5 minutes** old. Auth enforces
both. The site uses a proof for 14.5 and 4.5 minutes, then asks for the passkey again; a change waits in the session,
with its reason, until the admin confirms it.

**Admin changes reach the Station at once** (owner decisions after the Auth review).

Auth keeps an ordered, never-purged feed of the changes that affect integration access (pauses, resumes, revokes, and
an owner's account being disabled or enabled), read only by the Portal. Right after a change the Portal did not make,
Auth sends the Portal an empty nudge, which carries no data and no authority; the Portal then reads the feed over its
authenticated management connection, and also polls it every 30 seconds in case a nudge is lost. It records each
change in `integration_events` with the admin as actor and the reason, appends it to the Station's feed and pushes
the Station: the same push-plus-poll pattern it uses towards Stations. For least disclosure, the Station's feed and
the owner's history show an admin's change only as Agora.Build's (`agora_build`, no reason), and an owner's account
being disabled reaches Stations as an Agora.Build pause. See
[`docs/integrating.md`, "The change feed and the nudge"](https://github.com/Agora-Build/Auth/blob/main/docs/integrating.md#the-change-feed-and-the-nudge-portal)
and [platform.md, "Admin Changes From Auth"](platform.md#admin-changes-from-auth).

**An admin pause locks.** Neither the integration's owner nor a custom Station's owner can resume an integration an
admin paused (`409 admin_paused`). Only an admin lifts it, on the admin site, with a step-up proof and a reason,
recorded like pause and revoke. An admin pausing an integration its owner had already paused turns it into an admin
pause. The Portal shows "Paused by Agora.Build" and offers no Resume. While Agora.Build has the owner's account
disabled, a resume answers `409 owner_disabled`.

**No admin commands in the CLI** (Q9). Disabling and enabling an account and resetting a person's lost passkeys are
admin-site actions, under the same rules as pause and revoke. Disabling ends every session and grant of the account.
Auth has no command for account administration. If every admin is locked out, recovery is a direct database
operation by the operator ([Auth README, "Locked out of the admin site"](https://github.com/Agora-Build/Auth/blob/main/README.md#locked-out-of-the-admin-site)).

**Passkeys at Auth** (Q8: real multi-factor authentication from the start; the upstream IdPs give Auth no reliable
signal that the person used MFA there).

- An account registers one or more passkeys on Auth's account page, after a fresh sign-in (at most 5 minutes old).
  Registering or removing one ends the account's other sessions and is audited.
- At sign-in, only the `admin` client may ask for the MFA level; any other client asking for it is refused. The admin
  client's sign-in goes through the upstream login and then a passkey assertion: user-verifying, with Auth's origin as
  the relying party.
- The admin client's ID token then carries `acr` = `urn:agora:mfa` and `amr` = `["fed", "hwk"]`. Every other client
  is told `urn:agora:fed` and `["fed"]`, whatever the session's level.
- Losing every passkey is recovered **by another admin** ("Reset passkeys": deletes every passkey of the account and
  ends all its sessions and grants; reason required; audited with the admin as actor). An admin can't reset or disable
  their own account. Because recovery needs another admin, **at least two admins must have passkeys before the admin
  site goes live in production**. Dev runs with one admin who holds at least two passkeys (owner decision); a second
  admin is added as a change to Auth's clients file and `ADMIN_ACCOUNTS`
  ([operations.md, "Adding an admin later"](https://github.com/Agora-Build/Portal-Admin/blob/main/docs/operations.md#adding-an-admin-later)).

See [`docs/integrating.md`, "Passkeys and the admin client"](https://github.com/Agora-Build/Auth/blob/main/docs/integrating.md#passkeys-and-the-admin-client).

**The Portal's side.** The Portal has no admin role, admin notes or admin actions on other people's integrations; in
the Portal an admin is an ordinary account. It learns of built-in Stations from `GET /manage/v1/built-in-stations`,
not by listing as an admin. `PLATFORM_ADMINS` now names only Stoa's admins, until D27 replaces it.

**Production** [Not built]. The site's code accepts only its dev origin until passkeys are verified on dev and the
owner approves; the remaining hardening is listed in
[operations.md, "Before production"](https://github.com/Agora-Build/Portal-Admin/blob/main/docs/operations.md#before-production).

#### 3.3.5 All management through the admin site (D27)

Status: [Not built]

**Owner direction.** All system, account and user management goes through the admin site; there are no `npm` or
script tools for it. Command-line tools may come later, built on the admin site's API. Build, test and deploy commands
are not management and stay. The design below was approved as recommended (Q10 to Q14); it starts with Auth.

What is still a command or setting today:

| Tool today | Where it goes | Enforced by |
|---|---|---|
| Portal `scripts/platform-admin.mjs grant-credits` | Admin site, account page: "Grant credits" | The Portal admin API (1, 2) |
| Portal `scripts/platform-admin.mjs assign-role` | Admin site, account page: "Set plan role" (basic, principal, fellow) | The Portal admin API (1, 2) |
| Portal `PLATFORM_ADMINS` (every right in every Stoa space) | Taken from Auth's configured admins (3) | Auth's listing |
| Auth `npm run keys` and `deploy.sh keys` (`list`, `emergency <kid>`) | Admin site: "Signing keys" page (4) | Auth's admin routes |
| Auth `npm run keys -- rotate` | Dropped: every instance already rotates a key when it is due | — |
| Portal `scripts/platform-admin.mjs import-json` | Removed: no environment needs it (Q13) | — |
| `deploy.sh` up, upgrade, rollback, migrate, backup and the other deployment commands; tests; builds | Stay: deployment and infrastructure, not management | — |

1. **How the admin site calls the Portal: a 60-second token from Auth** (Q10).
   - For each Portal call the admin site exchanges the admin's step-up ID token at Auth (RFC 8693, as Auth already
     does for `station.read`) for a Portal access token: resource = the Portal's API audience, scope `portal.admin`,
     `sub` = the admin, `client_id` = the admin client, `acr` = `urn:agora:mfa` with the proof's `auth_time`, lifetime
     60 seconds.
   - Auth issues it only to the admin client, only for a configured admin whose account is enabled, and only for a
     proof whose session is live and which is at most 5 minutes old: the same checks as on `/manage/v1`, so one place
     decides who is an admin.
   - The Portal verifies it like every bearer token (issuer, audience, ES256, `at+jwt`), and also checks that
     `client_id` is the admin client, the scope is `portal.admin`, `acr` is the MFA level, `auth_time` is at most 300 s
     old for a change and 900 s for a read, and `sub` is one of Auth's admins (3).
   - The actor is the token's `sub`, never a field of the request body. After an admin is disabled, a token minted
     before lives at most 60 seconds. This works the way Stations already verify tokens, with no second Auth round
     trip per call.
2. **The Portal admin API** (`/api/admin/v1`), accepting only those tokens, and only in PostgreSQL mode.
   - `GET /accounts/:id` (read): name, effective plan, assigned role, subscription status, credit balance and the last
     20 ledger entries.
   - `PUT /accounts/:id/role` `{ role, reason }`: `role` is `basic`, `principal` or `fellow`; `premium` comes only from
     Stripe. Setting the role an account already has answers "no change".
   - `POST /accounts/:id/credits` `{ credits, key, reason }`: grants only, 1 to 1,000,000,000 credits (Q12). The
     existing idempotency rule applies to `key`; the admin site makes one key per form, so a retry never grants twice.
   - Every change needs a reason (1 to 500 characters on one line), is recorded first in a new Portal `admin_actions`
     table shaped like Auth's (actor, action, target, reason, outcome `started` then `done` or `failed`, and details),
     keeps the reason and key in the ledger entry, is refused on the admin's own account (403), and is rate limited.
3. **Stoa admins come from Auth** (Q11). `GET /manage/v1/built-in-stations` adds each built-in Station's `admins`. The
   Portal's built-in sync keeps that set and gives it the Stoa rights `PLATFORM_ADMINS` gives today, and
   `PLATFORM_ADMINS` is removed. Every admin power then follows one list, the built-in Station `admins` in Auth's
   clients file. Choosing the admins stays a configuration change, so an admin cannot make admins.
4. **Signing keys on the admin site** (Auth admin routes).
   - `GET /manage/v1/keys` (read): each key's kid, `active_from`, `retire_after`, `revoked_at`, and whether it is the
     active key.
   - `POST /manage/v1/keys/:kid/revoke` `{ reason, actor }` (change): today's emergency rotation. It revokes the key,
     makes a replacement if the key was active, drops every refresh token, and every instance reloads by `NOTIFY`. An
     `admin_actions` row (`key_revoked`) is written before the change.
   - The site's confirmation: the admin types the kid and ticks a box. The page says that revoking the active key ends
     every refresh token, so every app signs in again.
   - `npm run keys` and `deploy.sh keys` are removed once a key revoke from the admin site has been checked on dev
     (Q14). Recovery when the admin site or every admin is unavailable is the README's SQL procedure, not a tool.
5. **Admin site pages.** The account page gains "Plan and credits", read from the Portal, with "Set plan role" and
   "Grant credits", and there is a new "Signing keys" page. Every change follows the same rules: a reason, a passkey
   sign-in at most 4.5 minutes old, and the site's log before and after.
6. **Order:** Auth (the `portal.admin` exchange, admins in the listing, the key routes); then the Portal (the admin
   API, the `admin_actions` migration, Stoa admins from Auth; removing `PLATFORM_ADMINS`, `grant-credits`,
   `assign-role` and `import-json`); then the admin site's pages; then removing the key commands after the dev check.

### 3.4 Native access to a Station

Status: [Built]

- The native `astation` client gets `astation.remote` tokens for the built-in Station and for each registered Station
  the person may use, by asking with `resource` = the Station's origin. The built-in Station is a configured Station
  (§3.3.2), not a static resource, and the native contract is the same for both kinds: `aud` = the origin, `sub` = the
  person, 900 s.
- Access tokens carry `auth_time`, so a Station can require a fresh sign-in (`max_age=0`) for sensitive steps.
  `auth_time` is the time of the sign-in the grant came from; refreshing a token never changes it.
- A Portal token can never authorize a Station resource: its audience differs, and the Station checks it.

The details are in
[`docs/integrating.md`, "Station tokens for native apps"](https://github.com/Agora-Build/Auth/blob/main/docs/integrating.md#station-tokens-for-native-apps).

### 3.5 Station and Portal talking to each other

Status: [Built]

| Direction | How |
|---|---|
| Station reports to the Portal (an integration became Ready, its host is waiting, errors, revocation done) | The Station's own report client (`private_key_jwt`, client credentials) with scope `station.report` on the Portal resource: `POST /api/v1/stations/reports`. The token's `client_id` identifies the registered Station, and the Portal accepts reports only about integrations on that Station |
| The Portal tells the Station about revocations, pauses and policy changes | **Both push and poll.** The Portal pushes an unsigned nudge, `POST <origin>/agora-build/v1/changes` with `{ cursor }`, right after a change; it carries no authority, so the Station only polls in response. The Station also polls `GET /api/v1/stations/changes?cursor=` every minute with its own token, so a missed push is caught. Cursor 0 returns a snapshot of every integration on the Station, each with `ownerAccount`; a cursor beyond the Portal's history answers `409 cursor_ahead`. The token lifetime (5 minutes) bounds the worst case either way |
| The browser reads private details from the Station (labels, runtime status) | The Portal asks Auth for a **token exchange** (RFC 8693): the signed-in person's ID token, whose IdP session must still be live, for a 5-minute token with `aud` = that Station and scope `station.read`. The Portal hands it to the browser, which calls `GET <origin>/agora-build/v1/details` directly (the Station allows CORS from the Portal origin only). The Portal never sees the response |

The Station's feed tells it each integration's state, scopes, `r9Svc`, expiry and quota, but not who paused it. The
full contract is in [platform.md, "For Station Builders"](platform.md#for-station-builders).

### 3.6 Portal: Account > Integrations

Status: [Partly built] — the pages, approvals, lifecycle and append-only records are built; account deletion, the
per-account export and the assistant's history are not.

| Surface | Callers | Purpose |
|---|---|---|
| The account page's Stations and Integrations sections | The website | Register, verify, share and remove Stations; list, create, configure, rotate, pause, resume, revoke and renew integrations; see an integration's history |
| `/api/stations/...`, `/api/integrations/...` | The website (cookie) | The same operations |
| `/api/v1/integrations`, `/api/v1/integrations/<id>/approval` | Astation (access token with `integrations:read`, `integrations:approve`) | List the account's integrations waiting for approval, and report a signed approval |
| `/api/v1/stations/reports`, `/api/v1/stations/changes` | Stations (`station.report` token) | Reports and the change feed (§3.5) |

The routes, limits and error codes are in [platform.md, "Routes"](platform.md#routes). A custom Station's owner also
sees, and may pause or revoke, other accounts' integrations on that Station.

**Pending approvals.** The Portal keeps the **metadata** (integration, Station, requested operations, expiry, state,
who must approve); the **exact request body** a native manager signs lives on the Station. Astation fetches the body
from the Station, shows it, has the manager sign, and publishes through the shared core. It reports the approval and
the R9 service fingerprint to the Portal, and the Station reports the result.

**States** follow the shared design: Awaiting approval, Provisioning, Waiting for host, Ready, Paused, Expired,
Revoking, Revoked. **The Portal never sets Ready itself**; only an authenticated Station report does. Expired is shown
for anything not yet revoking once its expiry passes. Revoking lasts until the Station confirms. The table of states
and who moves them is in [platform.md, "Lifecycle"](platform.md#lifecycle).

**Expiry:** default **30 days**, maximum **90 days** (the R9 service contract). Renewing sets a new expiry counted from
now.

**Retention: kept forever (D19).** Integration metadata, the agent module's operational state and receipts are kept
indefinitely, in plain append-only PostgreSQL tables, not in the R9 log:

| Data | Database | Notes |
|---|---|---|
| Stations, members, integrations, pending-approval metadata, state changes | **The Portal's PostgreSQL** | Rows are never deleted; revoking sets a state. Every change is appended to `integration_events`, partitioned by month, with time, actor and reason [Built] |
| Integration clients, public keys, registered Stations, members, audit | **Auth's PostgreSQL** | Access tokens are **not** kept; they expire and are cleaned up. Kept forever: `integration_audit` (issuance, every change, partitioned by month), `admin_actions`, and key history (retired public keys marked, not deleted) [Built] |
| Agent module operational state and receipts | **The Station's PostgreSQL** | Receipts that reference private content stay encrypted. Redis holds only short-lived routing state, never history. Schema and encryption are the Station owner's design (Astation) |
| Assistant conversation history | **The Portal's PostgreSQL** | Kept on Agora.Build (D8). By plan (owner decision): **Basic 90 days, Premium forever**. A daily job deletes Basic accounts' conversations older than 90 days. When a paid plan ends, conversations older than 90 days are kept **30 more days**; the person is warned when the plan ends and again a week before, then they are deleted unless the person upgrades again [Not built] |
| R9 signed membership log | Not a database: Atem's signed log (at most 1,024 entries, 256 members and 64 hosts) | The Station archives each signed entry in its PostgreSQL when it is published, as an **availability backup, never a source of trust** (entries are signed); that part is Astation's and not confirmed here. **No compaction in R9** (D23): capacity isn't urgent (one entry per renewal or removal, about 40 a year for 10 integrations on 90-day renewals). Instead, Atem's client library reports a log as nearly full at 90% of a limit, and a signer doesn't widen or renew a service within 24 hours of its last grant [Built: Atem]. Checkpoints are a possible future revision (a new anchor confirmed in an owner ceremony with a safety code), only if a real account nears the cap |

What "forever" requires:

- **Append-only:** status columns and event tables; no `DELETE` in normal operation [Built].
- **Growth:** event and audit tables partitioned by month, so recent queries stay fast and old months stay cheap, at
  Auth and the Portal [Built].
- **Backups:** Auth and the Portal use their PostgreSQL backups; a Station needs its own.
- **Export:** a per-account JSON export of integrations, events and receipts from the Portal and the Station
  [Not built].

**Account deletion** [Not built] is the one exception (owner decision): all of the account's data is permanently
deleted 14 days after the person deletes the account.

- **At once:** the account is disabled: signing in leads only to a restore page, and no app or token can use it.
  Every integration is revoked and its client disabled (no new tokens; issued ones expire within their lifetime),
  assistant sessions end, the person's registered Stations are unregistered and their sharing removed, and the account
  is removed from other people's shared Stations. The Portal pushes the revocations to the affected Stations as usual.
- **After 14 days:** a deletion job removes every row for the account, with no anonymised copy and no audit trail
  kept: in the Portal (account, integrations, `integration_events`, Stations, sharing, assistant history, credits and
  the Agora Console connection), in Auth (account, linked logins, clients, keys, audit rows) and on Stations
  (receipts, operational state, the archive of R9 log entries, the custom LLM key). Each Station receives a deletion
  request and confirms it; the Portal retries until every Station has confirmed.
- **Cancelling** (owner decision): during the 14 days, the person can sign in again and confirm "Restore my account".
  The account is re-enabled with its data. Revocations already made stay revoked: integrations need new keys and a new
  native approval, Stations are registered again, and shared access is granted again by the owners. After the 14
  days, nothing can be restored.
- **Backups** (owner decision) are kept at most 30 days, so deleted data is gone from backups within 30 days of the
  final deletion. The deletion job also records the account ID in a deletion list that restores consult, so a restored
  backup can't bring the account back.

Disabling an account, which the admin site already does (§3.3.4), is not deletion: the data stays and the account can
be enabled again.

### 3.7 Credentials and custody

Status: [Partly built] — the Discord credentials and the custom LLM key belong to features that are not built.

| Class | Examples | Where it lives |
|---|---|---|
| Control-plane provider connections | The Agora Console connection [Built]; the official Discord app's bot credentials [Not built] | Agora.Build, sealed at rest (the Agora Console tokens with `AGORA_CONSOLE_ENCRYPTION_KEY`) |
| Agora.Build's own secrets | Auth's signing keys, the Portal's secrets, the admin client's secret | Agora.Build's server configuration and databases |
| Integration keys | Private keys for `private_key_jwt` | The integration's owner (custom apps) or the Station or service running it; Agora.Build stores public keys only |
| Agora certificates in Astation | App Certificates for local token generation | **On the device**, protected (owner decision: Astation keeps generating RTC and RTM tokens locally) [Built: Astation] |
| User vault secrets, memory, private agent content, the custom LLM key [Not built] | Anything in a person's vault or memory; the Station AI model key | **The Station only**; never on Agora.Build |

The Agora Console connection stays on Agora.Build (D7), and the server-side token endpoint
(`/api/v1/connections/agora/token`) stays for other apps
([platform.md, "Agora Console Connections"](platform.md#agora-console-connections)). Astation keeps generating tokens
locally with certificates on the device (D14).

### 3.8 Discord

Status: [Not built]

Discord runs on a Station that offers Station AI: a custom Station, or the built-in Station once it supports Station AI
(D21). There are two ways to connect it.

**The official Agora.Build Discord app** (the default; one app for every Station, D18):

- Agora.Build owns the install, consent, guild, channel and actor policy, and the bot credentials. **The bot secret
  never leaves Agora.Build**; no Station operator receives it.
- Discord sends interactions to Agora.Build's interactions endpoint. Agora.Build verifies Discord's signature,
  deduplicates by interaction ID, finds the integration from the guild and channel, and forwards the interaction to
  that integration's Station. The Station runs it through its agent module and returns the reply, which Agora.Build
  posts. Agora.Build keeps nothing beyond what's needed to deliver it (no stored transcripts).
- Installing the bot authorizes nobody by itself: each invocation must match an approved integration and an allowed
  Discord actor and channel.

**Bring your own Discord app** (D22), for people who want Discord traffic to skip Agora.Build entirely, comes after the
official app:

- The person creates their own Discord application and bot, and sets its Interactions Endpoint URL to their Station.
  Discord then talks to the Station directly; Agora.Build is not in the path.
- The bot token and the app's public key are entered in Astation's Station AI tab (Agent) and sent straight to the
  Station, stored there encrypted like the custom LLM key; they never go to Agora.Build.
- The Portal still manages the integration itself (name, allowed guild, channel and actors, expiry, revocation) and
  shows "Own Discord app" as its connection type. The Station verifies Discord's signature with the app's public key
  and applies the same actor and channel checks.

### 3.9 The assistant: voice pipeline on Agora.Build, intelligence on Station

Status: [Not built]

```
Voice / text UI (Stoa, Astation)
        | audio / text
        v
Agora.Build voice agent: ConvoAI pipeline (ASR -> LLM call -> TTS)
        | OpenAI-compatible  POST /v1/chat/completions  (HTTPS, session token)
        v
Station LLM endpoint: context retrieval (RAG), function calling, the configured model
        | tool calls over R9 (end-to-end encrypted), through the Station relay
        v
Atem -> coding agents
```

- **Agora.Build hosts the assistant experience** as one ConvoAI pipeline, reusing Stoa's voice, the marketplace models
  and credits. **Conversation history is kept on Agora.Build** (transcripts and replies), visible and deletable by the
  person: **90 days on Basic, forever on a paid plan** (§3.6).
- **The Station hosts the "LLM"**: an OpenAI-compatible `/v1/chat/completions` endpoint with context retrieval, the
  context store and function calling inside. ConvoAI sees a plain chat model and declares **no tools**, so retrieved
  context and tool results stay on the Station unless the reply contains them.
- **The assistant is an integration** (§3.1, §3.6): created on the Integrations page with explicit opt-in, and scoped
  by its credential, the Station's policy and the R9 grant.
- **Tokens** (owner decision, D20). The agent is started once and never leaves or rejoins; ConvoAI's update call
  changes the running agent in place (same `agentId`, UID and channel; status stays `RUNNING`)
  ([update](https://docs.agora.io/en/api-reference/api-ref/conversational-ai/update)).
  - **The LLM base URL and `api_key` are fixed for the whole conversation.** The `api_key` is a session token Auth
    issues when Agora.Build starts the voice agent: `aud` = the Station, scope `assistant.chat` for that one assistant
    integration, `sid` = the assistant session ID, valid for the conversation (at most ConvoAI's 72-hour agent
    maximum). The Station checks on every call that the `sid` is still active, so ending the session revokes it at
    once (the Portal pushes the session end, the Station polls). It can't reach any other Station API, integration or
    Station, and the integration's quota applies. Auth already reserves `assistant.chat` among the Station scopes but
    issues no assistant session token.
  - **Only the RTC and RTM token changes:** 30 minutes, refreshed in place every **20 minutes**, or at once on
    `104 agent expire`, with ConvoAI's update call (`properties.token`).
- **What leaves the person's machines:** audio, transcripts, replies and TTS text go through Agora's ConvoAI pipeline
  and are kept in Agora.Build's conversation history; each turn's `messages` array reaches Agora.Build and the Station;
  the Station's model call sends retrieved context to the configured provider (none, with a local model).
- **Reachability.** ConvoAI runs in Agora's cloud, so the Station's LLM endpoint must be reachable over HTTPS. For a
  self-hosted Station behind NAT, the person exposes it themselves for now (cloudflared or ngrok); R9 and storage can
  stay private.

**Transport** [Built: Atem, Astation]. Atem opens an **outbound** WebSocket to its Station relay
(`astation_relay_url`: the built-in Station, or the person's registered Station). Remote Astation, browser companions
and the Station's agent module connect to the same relay, which routes by `atem_id` and `connection_id`. R9 is
end-to-end encrypted between each client and Atem, so the relay forwards ciphertext and sees only routing metadata,
sizes and timing; the agent module is itself an R9 endpoint and reads what its integration permits. The assistant will
always reach Atem through the Station relay (in-process when the Station and Atem share a machine).

### 3.10 Astation settings tab: "Station AI"

Status: [Not built: Astation, Atem]

A new tab in Astation's Settings, **Station AI** (D11), with three switches, all off by default:

| Switch | What it enables on the account's Station |
|---|---|
| **MCP** | The Station exposes an **MCP server** that outside AI clients (Claude Desktop, Cursor, other agents) can call, offering the same typed agent tools: list sessions, read status and history, send prompts, answer permitted approvals |
| **LLM** | The Station's OpenAI-compatible `/v1/chat/completions` with context retrieval and function calling; the assistant (§3.9) calls it |
| **Agent** | The Station's agent module and its integrations: Discord, custom apps, the assistant |

**No local transport while any switch is on** (D12). "Relay only" means Astation and Atem **do not use the direct
local WebSocket (`ws://*:8080/ws`)**; they connect through **the account's own Station relay**: the built-in Station,
or a registered custom Station for an account that uses one (never a fallback to the built-in Station). Everything else
stays as it is: `cred unlock` and credential sync keep working the same way. When all three switches are off, the
direct transport may be used again.

- **Where Station AI runs** (D21, revised by the owner). Station AI runs on a Station that supports it: any custom
  Station that offers it, and the built-in Station once Agora.Build supports it there. Until a Station supports it,
  turning on a switch for an account whose relay is that Station is refused, and the Station rejects MCP, LLM and agent
  requests with: "Station AI is not available on this Station yet. Use a Station that offers it (Portal: Stations >
  Add Station) and select it in Astation." **Trust consequence:** Station AI decrypts the account's agent content on the
  Station that runs it. On a custom Station that is the owner's own server; on the built-in Station it means
  Agora.Build's server processes that content for the accounts that turn Station AI on there, and Astation must say so
  when a person turns it on with the built-in Station as their relay. The voice assistant (§3.9) and Discord (§3.8)
  need a Station that offers Station AI.
- **What the Station does today** [Built: Astation]. It answers its Station AI routes (`/api/agent/v1` apart from the
  hosted agent API, `/mcp`, `/v1/chat/completions`, the voice-session routes) with 503 `station_ai_unavailable`. On
  the built-in Station the routes outside `/api/agent/v1` still answer 403 `custom_station_required`, with the message
  from before D21 was revised ("Station AI needs your own Station…"); aligning it is Astation's.
- **How relay only works: exactly like reaching Astation through the relay today** (owner decision). Atem's connect
  loop tries the **local** link first (`astation_ws`, default `ws://127.0.0.1:8080/ws`), and if that fails connects to
  the **relay** (`astation_relay_url`), joining the paired Astation's identity room by the `astation_id` in its pairing
  record; Astation is in the same room, and both dial out. With Station AI on, Atem **skips the local step** and always
  uses the relay, as an Atem on a remote machine already does. No R9 change:
  - Astation sends each of the account's Atem hosts **"relay only"** in a field of a message it already sends on the
    link; Atem saves it in its config, as it already saves the relay identity.
  - When "relay only" is set, Atem's connect loop doesn't try `astation_ws`; it connects straight to the relay room.
  - Astation also refuses Atem connections on its local `:8080` listener while a switch is on, so a host that hasn't
    received the setting yet ends up on the relay and receives it there.
  - Switching on while Atem is connected locally: Astation sends the setting, closes the local link, and Atem
    reconnects through the relay. Switching off: Astation sends "relay only = off" and Atem tries local first again.
  - Everything on the link, including `cred unlock` and credential sync, keeps working over the relay.
- **Scope:** the switches apply to the **whole account** (every Atem host and Astation device).
- While the policy is on, the tab shows a banner: "Station AI is on: Astation and Atem connect through <Station>, not
  the local connection." It shows the account's Station and each feature's status (Off, Starting, On, Error). Turning a
  switch on shows what it does, which Station receives data and, for LLM, which model provider.

**LLM settings** (D13, when LLM is on):

| Field | Notes |
|---|---|
| Provider | Station default, or **Custom (OpenAI-compatible)** |
| Base URL | For example `https://api.openai.com/v1`, or a self-hosted vLLM or Ollama URL; https except for a Station-local address |
| Model | Free text (for example `gpt-4.1`, `qwen2.5-coder`) |
| API key | Write-only: entered once, never shown again (only "set, ending in …abcd"); Replace and Remove |
| Test | A minimal request through the Station; shows success or the provider's error, never the key |

The custom key is **one key for the whole account**. Set from any of the account's Astation devices, it goes straight
to the account's Station over its authenticated API, is stored there encrypted, and is used for all of the account's
devices. It never goes to Agora.Build, context or logs, and Astation keeps no copy after saving. The consent text says
the Station (and its operator) can use it, and that prompts with retrieved context go to that provider.

### 3.11 Delegated host work (D29)

Status: [Partly built] — Phase A built in Auth, the Portal and the admin site, and Phase B (the Station's revocation reports
and the per-host counts) built in the Portal, all off by default (DELEGATED_HOST_WORK); Phase C not started. Agreed by Atem,
Astation and Auth/Portal on 2026-11-08; Atem's build has started.

**Phases.** Phase A is the first slice of Auth/Portal's part (below), built behind the settings. `interruptRunning` on
revocations, the later interrupt, the native revoke and the page copy belong to step 6 of the design's order of work (V.2
in the design below). The account-level feed entries (`account_disabled`, `account_enabled`) belong to its step 10 (III.5,
disabled accounts): they are built ahead of it, behind the setting, and their shape is provisional until Auth/Portal and
Astation define III.5 jointly. Phase B is the next slice, built in the Portal behind the same setting: the Station's
`revocation_applied` and final `revoked` reports and the counts of hosts that applied a revocation (platform.md, "For
Station Builders"). Phase C is a later slice, not started.

**The decision.** Atem owns accepted tasks of delegated senders: integrations a Station's control feed covers, native members, and host senders with project grants. Natural expiry and renewal don't touch accepted tasks, and each task's deadline (at most 24 h) bounds it, running turns included. A revocation cancels unstarted tasks and interrupts running ones only when the owner chooses it. An integration's pause holds its unstarted tasks; host senders have no pause, only revoke and readmit. Stops reach hosts as signed control records (from the Station for integrations, from native managers for host senders) or as device-list entries, and a host reconciles its feeds and mailbox before it starts queued remote work. R9 authorization stays with native managers, outside Agora.Build's kill switch. Agora.Build's service availability is separate: disabling an Agora.Build account suspends the built-in Station's relay and mailbox service for that account's hosts, and revokes nothing.

**The design** is *Delegated host work and host-to-host senders: one design*, in the Atem repository:
[`designs/delegated-host-work.md`](https://github.com/Agora-Build/Atem/blob/main/designs/delegated-host-work.md) and its diagram
[`designs/delegated-host-work-flows.html`](https://github.com/Agora-Build/Atem/blob/main/designs/delegated-host-work-flows.html), on Atem's `main` since
2026-11-08 (commit `dda889c`, [Atem PR #137](https://github.com/Agora-Build/Atem/pull/137)), as planned work.

The text all three teams agreed is its revision 6b, recorded by SHA-256: the design
`cc180912cd8d3afc11c20f77a3ebc4e8a81989ede1327afc90df52d09c39eb83` and the diagram
`587a4c74ca9c2645dd3a2c79908813da573451479c0a0a846896fd3ff909cf6a`. The repository copy differs from it only by
updates made after agreement:

- its status block;
- the diagram link;
- two Astation file references;
- III.4, which now says the phone sign-in is live on dev (Auth #19);
- a new Appendix B quoting the agent-collaboration passages it cites, since that file arrives only with Atem PR #124.

Reviews and sign-offs are on [Atem #120](https://github.com/Agora-Build/Atem/issues/120), Astation's final
confirmation in [comment 6715069931](https://github.com/Agora-Build/Atem/issues/120#issuecomment-6715069931). The
owner's decisions are in its Appendix A.

**What it changes for integrations** (delegated senders only; others keep today's rules):

- Accepted tasks keep running when the integration disconnects or expires, within their own deadline. A renewal
  makes their status and replies readable again and replays nothing.
- Revoking cancels unstarted tasks at once. The revoke dialog asks whether to also interrupt the tasks running now
  (unticked by default), and "interrupt running tasks" stays available for 24 hours afterwards.
- A pause, an admin pause or a disabled owner holds unstarted tasks until a resume or their deadline.
- Stops reach the host as control records the Station signs with the integration's own service key; a native revoke
  in Astation is always mirrored to the Portal, so the Station's record backs it.
- The Portal shows Revoking until every covered host has applied the revocation, or 24 hours have passed.

**Auth/Portal's part** (the design's I.9 and IV rows 6, 7 and 16; built after the shared contract and Atem's host
work, nothing before the owner approves):

- **Auth:** `interruptRunning` on a revocation (owner and admin, default false) and an admin "interrupt running
  tasks" change, both in the change feed; account-level `account_disabled` and `account_enabled` feed entries,
  written in the same transaction ahead of the per-integration ones.
- **Portal:** the revoke dialog's question; `interruptRunning` required on `POST /api/integrations/<id>/revoke`;
  `POST /api/integrations/<id>/interrupt`; a native-app route `POST /api/v1/integrations/<id>/revoke` (scope
  `integrations:approve`); the Station feed's `interruptRunning`, `interrupt_requested`, account events (built-in
  Station only) and `binding_released`; the report kinds `revocation_applied{host, record_id}`,
  `revoked{outcome, pending_hosts}`, `binding_changed` and `binding_attempt`; the expiry, pause, host-sender and
  mailbox copy; and the Station Builders contract in [platform.md](platform.md#for-station-builders).
- **Admin site:** the revoke form's question, an "Interrupt running tasks" action, the disable confirmation ("This
  also suspends the built-in Station's relay and mailbox service for this account's hosts. It revokes nothing on the
  account's devices."), and "Release R9 binding", which needs D27's Portal admin API.

**Not ready yet:** disabled-account enforcement waits for Astation's durable room-ownership lookup, and "Release R9
binding" waits for D27 (§3.3.5).

## 4. Decisions

Status: [Partly built] — each row has its own tag.

| # | Decision | Status | Owner |
|---|---|---|---|
| D1 | Integrations are Auth clients; client credentials with `private_key_jwt`; tokens with the owner's `sub`, `r9_svc` and a 5-minute lifetime (§3.1) | [Built] | Auth |
| D2 | A Station verifies integration tokens locally (JWKS) (§3.1) | [Built] | Station, Auth |
| D3 | Any account can register a Station with proof of control; only the owner uses it by default; sharing from the Portal (§3.3) | [Built] | Auth, Portal |
| D4 | `astation.remote` for `astation` on the built-in Station and every registered Station; `auth_time` in access tokens (§3.4) | [Built] | Auth |
| D5 | Stations and Integrations pages and APIs (`/api/...`, and `/api/v1/integrations` with the scopes `integrations:read` and `integrations:approve`) (§3.6) | [Built] | Portal |
| D6 | Ready only on a Station's authenticated report; pending metadata in the Portal, the exact body on the Station (§3.6) | [Built] | Portal, Station |
| D7 | The Agora Console connection stays on Agora.Build (a control-plane provider connection) (§3.7) | [Built] | Portal |
| D8 | The assistant on Agora.Build (ConvoAI pipeline, history kept on Agora.Build); the Station exposes an OpenAI-compatible LLM with RAG and function calling (§3.9) | [Not built] | Agora.Build, Station |
| D9 | Integration expiry: default 30 days, at most 90 (§3.6) | [Built] | All |
| D10 | The Portal's API audience is the Portal's origin; the app API is under `/api/v1` (§1) | [Built] | Portal, Auth |
| D11 | Astation "Station AI" tab: MCP server, LLM, Agent; off by default; whole account (§3.10) | [Not built: Astation] | Astation |
| D12 | Any Station AI switch on: no local transport. Atem always connects through the relay, skipping the local step of its connect loop; Astation sends "relay only" on the existing link, Atem saves it like the relay identity, and Astation's `:8080` listener refuses Atem while it is on; `cred unlock` and sync unchanged, over the relay (§3.10) | [Not built: Atem, Astation] | Atem, Astation |
| D13 | Custom LLM (OpenAI-compatible URL, model, write-only key), one key per account, stored encrypted on the Station only (§3.10) | [Not built: Astation] | Astation, Station |
| D14 | Astation keeps generating RTC and RTM tokens locally with certificates on the device (§3.7) | [Built: Astation] | Astation |
| D15 | Key rotation with a 10-minute overlap; a quota per integration, default 200 requests a second, configurable (§3.1.2, §3.2) | [Built] | Auth, Station |
| D16 | Station → Portal reports through the Station's own Auth client (`station.report`); Portal → Station changes by push and poll (§3.5) | [Built] | Portal, Station |
| D17 | The browser reads Station details with a token-exchanged 5-minute `station.read` token, calling the Station directly (§3.5) | [Built] | Auth, Portal, Station |
| D18 | One official Agora.Build Discord app for all Stations; Agora.Build forwards interactions, keeps the bot secret and stores nothing (§3.8) | [Not built] | Portal, Station |
| D19 | Integration metadata, operational state and receipts are kept forever in append-only PostgreSQL tables: the Portal (metadata, events, assistant history), Auth (clients, keys, Stations, audit; not tokens), the Station (receipts; an archive of the signed R9 log). Account deletion: everything revoked at once and permanently deleted after 14 days, across the Portal, Auth and Stations; restorable by signing in and confirming within the 14 days; backups kept at most 30 days (§3.6) | [Partly built] — the append-only records at Auth and the Portal are built; account deletion, the export and the assistant's history are not | Portal, Auth, Station |
| D20 | The ConvoAI agent is never replaced. The LLM base URL and `api_key` are fixed for the conversation: the `api_key` is a session token (`assistant.chat`, `sid`, valid for the conversation, at most 72 h), revoked when the session ends (the Station checks the `sid` is active). Only the RTC and RTM token changes: 30 minutes, refreshed in place every 20 minutes or on `104 agent expire`. Self-hosted reachability is the person's (cloudflared, ngrok) (§3.9) | [Not built] | Auth, Agora.Build, Station |
| D21 | Revised by the owner: Station AI (MCP, LLM, Agent) runs on any Station that supports it: custom Stations, and the built-in Station once Agora.Build supports it there. A Station that doesn't support it yet refuses those requests with a clear message. On the built-in Station, Station AI means Agora.Build's server processes that account's decrypted agent content, and Astation says so when it is turned on there (§3.10) | [Partly built] — Stations refuse Station AI requests; Station AI itself is not built, and the built-in Station still answers some routes with the pre-revision message | Station, Astation |
| D22 | Bring-your-own Discord app supported: the person's own Discord application points at their Station; bot token and public key stored on the Station only; the Portal still manages the integration (§3.8) | [Not built] | Station, Astation, Portal |
| D23 | No live R9 log compaction (Atem owner; the owner allowed it in principle). The Station's archive is an availability backup, not a trust source. A renewal rate limit and a "device list nearly full" warning; checkpoints only as a future revision with an owner-ceremony anchor, if an account nears the cap (§3.6) | [Partly built] — Atem's nearly-full levels and renewal guard are built; the Station's archive of signed entries is Astation's and not confirmed here | Atem, Station, Astation |
| D24 | The built-in Station is a full Station on the same protocol as custom Stations, admitted by configuration instead of proof of control, open to every signed-in account and every account's default relay. Integrations and Station AI on it only once Agora.Build supports them there, with active integrations per account limited by plan (Basic 4, Premium 10, Principal and Fellow no cap; custom Stations never capped). Dev uses its own built-in Station, `https://station-dev.agora.build`. No user owns it, Agora.Build's admins administer it (on the admin site, D26), and nobody can unregister it. A person may switch to a custom Station and back at any time, with re-verification on each switch. Each kind may add functions on top of the shared protocol (§3.3.2) | [Built] | Auth, Portal, Station |
| D25 | Built-in apps (the Portal, Astation, a planned mobile app) are first-party Auth clients added once in the clients file, separate from integrations and Stations. The phone apps are public native clients (`astation-ios`, `astation-android`) with PKCE and refresh tokens, requesting `astation.remote` on the chosen Station and no Portal scopes yet; Auth accepts exact private-use redirects under `build.agora.` for native clients (§3.3.3). Q5 is open | [Partly built] — the first-party clients and the phone apps' clients and redirects are built (live on dev); the phone apps themselves are not finished (Astation) | Auth, Astation |
| D26 | A separate admin site (the private `Agora-Build/Portal-Admin`; `admin.agora.build`, dev `admin.dev.agora.build`) holds Agora.Build's admin powers. Admins sign in with a passkey at Auth, never by silent SSO reuse. Auth enforces every admin permission server-side, with a step-up ID token on each cross-account call. Pause and revoke take effect at once, including the Station's open sessions. Every action has a required reason and an audited actor. Account disabling, enabling and passkey resets are admin-site actions, not CLI commands. The Portal has no admin views. Dev only until passkeys are verified and the owner approves production (§3.3.4) | [Built] | Auth, Portal, admin site |
| D27 | All system, account and user management goes through the admin site; no `npm` or script tools: a Portal admin API for plan roles and credit grants, called with a 60-second `portal.admin` token exchanged from the admin's step-up proof; Stoa admins taken from Auth's configured admins; signing keys listed and emergency-revoked on the admin site; `import-json` removed (§3.3.5) | [Not built] | Auth, Portal, admin site |
| D28 | Three integration scopes for Atem's new signed operations: `agent.launch` → `launch`, `agent.message` → `message` (never makes an agent act), `agent.notify` → `notify` (needs `agent.message` and `agent.prompt`, which Auth enforces). `agent.view` stays required; existing integrations gain nothing; the Portal shows all three checkboxes. Signing gate: the Station maps the scopes only in builds with `host-work-api` (Atem supports them from v0.8.2), and Astation signs the new operations only for hosts and checkers that support them. An Astation inbox with "Start work on this" is follow-up (§3.1.3) | [Partly built] — the Station's mapping is off (`host-work-api`), the joint check on a real host has not run, and the inbox is not built | Auth, Portal, Station, Astation, Atem |
| D29 | Atem owns accepted tasks of delegated senders: integrations a Station's control feed covers, native members, and host senders with project grants. Natural expiry and renewal don't touch accepted tasks, and each task's deadline (at most 24 h) bounds it, running turns included. A revocation cancels unstarted tasks and interrupts running ones only when the owner chooses it. An integration's pause holds its unstarted tasks; host senders have no pause, only revoke and readmit. Stops reach hosts as signed control records (from the Station for integrations, from native managers for host senders) or as device-list entries, and a host reconciles its feeds and mailbox before it starts queued remote work. R9 authorization stays with native managers, outside Agora.Build's kill switch. Agora.Build's service availability is separate: disabling an Agora.Build account suspends the built-in Station's relay and mailbox service for that account's hosts, and revokes nothing. (§3.11) | [Partly built] — agreed by Atem, Astation and Auth/Portal on 2026-11-08; Phase A is built in Auth, the Portal and the admin site, and Phase B's revocation reports in the Portal, off by default (§2, §3.11); Phase C is not started | Atem, Astation, Auth, Portal, admin site |

No decision has been replaced by a later one. D21 was revised in place, and D24's rule that admins hold the
Station-owner rights on the built-in Station now works through the admin site (D26).

## 5. Open questions

Status: [Not built] — the open question below is undecided.

| # | Question | Owner |
|---|---|---|
| Q5 | Can the built-in mobile app approve integrations? Approval is not only an API call: the device signs an R9 membership entry, so the phone would become an R9 manager device with its own protected keys (like Astation on the Mac). If yes, it also gets `integrations:approve`; if no, it can only list integrations and approval stays on Astation desktop. Astation's recommendation: a phone may approve only after explicit R9 manager enrolment with its own protected keys and fresh local owner confirmation; an OAuth login or scope alone never grants manager status. Awaiting Atem's confirmation | Astation, Atem |

**Answered:**

- Q1 to Q4, the built-in Station's questions (Station AI there, ownership, integration limits, the dev origin):
  answered by D21 (revised) and D24.
- Q6, the dev built-in Station's origin: answered by D24 (`https://station-dev.agora.build`).
- Q7, where the admin site's code lives: answered by D26 (the private `Agora-Build/Portal-Admin`).
- Q8, MFA for admins from the start: answered by D26 (passkeys at Auth).
- Q9, account disabling: answered by D26 (admin-site actions, no CLI commands).
- Q10, how the admin site calls the Portal: answered by D27 (a 60-second `portal.admin` token).
- Q11, Stoa admin rights: answered by D27 (exactly Auth's configured admins).
- Q12, credits: answered by D27 (grants only in the first step).
- Q13, whether `import-json` is still needed: answered by D27 (no environment needs it; removed).
- Q14, the key commands: answered by D27 (removed once the admin site's key revoke is checked on dev).

## Roadmap

Status: [Not built] — everything listed here is not built or only partly built.

Grouped by area. Nothing goes to production without the owner's approval.

**Launch, message and notify** ([§3.1.3](#313-launch-message-and-notify-scopes-d28))

- Astation, Atem, Auth, Portal, the owner: the joint check on dev with an upgraded Atem on a test host, then acceptance
  of host work on a real host.
- Astation: turn on `host-work-api` on a Station after that acceptance, then the production rollout with the owner's
  approval.
- Astation, Atem: the context and mark publisher (Astation PR #71) and live mark delivery.
- Astation: the inbox of messages on the account's hosts, with "Start work on this" under the owner's authority.

**Stations and the built-in Station** ([§3.3](#33-registered-stations-custom-relays),
[§3.3.2](#332-the-built-in-station))

- Portal: clean up the retired custom test Station `st01M5Z992VWBKV3E989CRBD0CEQ` (Portal issue #24), with a dry run
  first.
- Auth, Portal, Astation, the owner: the production built-in Station `https://station.agora.build`, with its own report
  key, after production Auth.
- The owner: shared or public relays (a later decision; not designed).

**The admin site** ([§3.3.4](#334-the-admin-site-d26))

- The owner, Auth: a second dev admin with passkeys; at least two admins with passkeys before production.
- Admin site: the "Before production" list in its `docs/operations.md`, then production with the owner's approval.
- Auth, admin site: admin reads of an integration's audit history and of custom Stations with their integration counts.
- The owner: later decisions on account deletion requests (D19) and abuse reports from people.

**All management through the admin site** ([§3.3.5](#335-all-management-through-the-admin-site-d27))

- Auth: the `portal.admin` token exchange; `admins` in `GET /manage/v1/built-in-stations`; `GET /manage/v1/keys` and
  `POST /manage/v1/keys/:kid/revoke`; then remove `npm run keys` and `deploy.sh keys` after the dev check.
- Portal: `/api/admin/v1` (account read, set plan role, grant credits) and its `admin_actions` migration; Stoa admins
  from Auth's listing; remove `PLATFORM_ADMINS`, `grant-credits`, `assign-role` and `import-json`.
- Admin site: "Plan and credits" on the account page and the "Signing keys" page.

**Built-in apps** ([§3.3.3](#333-built-in-apps-portal-astation-a-mobile-app))

- Auth and the owner: the phone clients in production, after Astation's apps are checked on dev.
- Auth, Portal: claimed https redirects and the app association files (`apple-app-site-association`,
  `assetlinks.json`), only if a phone app ever needs them.
- Astation, Atem: Q5, the mobile app itself, and push notifications.

**Retention and account deletion** ([§3.6](#36-portal-account--integrations))

- Portal, Auth, Astation: account deletion with the 14-day restore window, deletion requests confirmed by every
  Station, backups kept at most 30 days and a deletion list that restores consult.
- Portal, Astation: the per-account JSON export of integrations, events and receipts.
- Astation: confirm the Station's archive of signed R9 membership entries (D23).

**Discord** ([§3.8](#38-discord))

- Portal, Astation: the official Discord app (install and consent, an interactions endpoint with signature check and
  deduplication, forwarding to Stations), once the Station's agent module can run it.
- Astation: bring-your-own Discord app (an interactions endpoint on the Station, the bot token and public key entered in
  Astation and stored on the Station), after the official app.

**The assistant** ([§3.9](#39-the-assistant-voice-pipeline-on-agorabuild-intelligence-on-station))

- Auth: the assistant session token (`assistant.chat`, the Station as audience, `sid`, valid for the conversation up to
  72 hours, revocable on session end).
- Astation: the Station's OpenAI-compatible `/v1/chat/completions` with RAG and function calling; the `sid` check on
  every call and session-end notices (push and poll).
- Portal: the ConvoAI voice pipeline calling the Station's LLM, the RTC and RTM token refresh, the conversation history
  with its plan-based retention, and the assistant as an integration.

**Station AI** ([§3.10](#310-astation-settings-tab-station-ai))

- Astation: the Settings tab "Station AI" (MCP, LLM, Agent; custom LLM fields; banner), sending "relay only" to every
  Atem host of the account, refusing Atem on the local `:8080` listener while a switch is on, and closing an existing
  local link.
- Atem: save the "relay only" setting and skip the local step of the connect loop while it is set.
- Astation: the Station's MCP server, LLM endpoint and encrypted account key; Station AI on the built-in Station once
  Agora.Build supports it there, with the notice that Agora.Build's server processes the content; until then, the D21
  refusal message on every Station AI route of the built-in Station.

**Delegated host work** ([§3.11](#311-delegated-host-work-d29))

- Atem: the shared core (signed objects, the new device-list actions, vectors) and the host side, behind `host.delegated`.
- Astation: the control feed, heads and acknowledgments, native records, the mailbox, the durable room-ownership
  lookup and the app.
- Auth: `interruptRunning` and the admin interrupt change; account-level feed entries.
- Portal: the revoke question and routes, the native-app revoke route, the Station feed and report additions, the
  copy and the Station Builders contract.
- Admin site: the revoke question, "Interrupt running tasks", the disable copy, and "Release R9 binding" (after D27).
- All teams: the joint dev checks of the design's section VII, then the owner's approval.

**Production**

- The owner, with every team: production Auth, the Portal, the admin site and the built-in Station, each after its
  dev verification.
