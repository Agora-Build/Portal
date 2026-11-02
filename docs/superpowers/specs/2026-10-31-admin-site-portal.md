# Admin site (D26), Portal side: spec copy

Verbatim copy, taken on 2026-10-31, of the binding parts of the Agora.Build integrations design
(`~/Dev/Agora.Build/reviews/agora-build-integrations/AGORA-BUILD-INTEGRATIONS.md`) for
`docs/superpowers/plans/2026-10-31-admin-site-portal.md`:

- §3.3.4 "The admin site (D26)" in full, with its "Owner decisions (2026-10-31)", "Owner requirements (2026-10-31)"
  and "Owner decisions after the Auth review (2026-10-31)";
- §3.3.2 "The built-in Station" (D24), for context: the shared Station protocol the Portal implements and the
  Portal's part (item 5);
- §3.5 "Station and Portal talking to each other" (push and poll);
- §4 decisions D16, D24 and D26;
- §6 work tables "Built-in Station (D24)" and "Admin site (D26)".

The Auth side contract is `~/Dev/Agora.Build/Auth/docs/superpowers/plans/2026-10-31-admin-mfa-auth.md` (rulings
R1–R30, notes C1–C13; Tasks 9, 10, 13 and 14) on Auth branch `feat/admin-mfa`. If this copy and the source disagree,
the source wins and this copy is refreshed.

---

#### 3.3.4 The admin site (D26)

**Owner direction (2026-10-31, D26); for review by Astation and Atem.** Agora.Build's administrative powers move out of
the Portal's account page into a **separate admin site**. The account page shows each person only their own things;
admin work (abusive integrations first) happens on a site built for it, with stronger sign-in and a full audit trail.

**Why.** Least privilege: the session people use every day (credits, profile, their own integrations) should not also
carry the power to revoke other people's integrations. A separate site can demand a fresh sign-in for every
privileged action, can add a second factor or a network restriction later without slowing normal users down, and
removes the need for "admin views" inside user pages (the D24 review had to restrict them to the browser session for
that reason).

**Shape.**

- A separate web app on its own origin: **`https://admin.agora.build`** (dev **`https://admin.dev.agora.build`**),
  never embedded in the Portal. Its own first-party Auth client `admin` (web, confidential), added once to Auth's
  clients file (a new kind of app, §3.3.3), with `manage: true` so it calls Auth's management API itself.
- **Who may sign in:** only accounts in its configured `ADMIN_ACCOUNTS` list, which must equal Auth's built-in Station
  `admins` (§3.3.2). Anyone else is refused after sign-in and nothing is shown.
- **Sign-in:** authorization code + PKCE like the Portal; **every change requires a fresh sign-in** (`max_age=0`,
  checked through the ID token's `auth_time`, at most 5 minutes old); sessions are short (15 minutes idle,
  8 hours absolute), host-only cookies, same-origin checks on every change, a strict Content-Security-Policy, and no
  bearer/API access (no third-party app can act as an admin).
- **Audit:** every admin action carries a reason the admin types; Auth records it with the admin as actor
  (`integration_audit`), and the admin site keeps its own append-only log of views and actions.

**First functions (phase 1):**

| Function | How |
|---|---|
| Find integrations across the platform | by Station, owner account, client ID, name, state; newest first, paged |
| See one integration | owner, Station, scopes, state, expiry, quota, `r9_svc` set or not, and its history (Portal events and Auth audit) |
| Pause / revoke an integration | with a required reason; through Auth's management API, actor = the admin, as D24 already allows on the built-in Station |
| List Stations | built-in and custom: origin, owner, status, number of integrations; read-only (the built-in Station changes only through configuration) |

Later (separate decisions): disabling an account, account deletion requests (D19), plan grants, abuse reports from
people, a second factor for admins.

**Changes this needs.**

- **Auth:** (1) the `admin` client and its `ADMIN` role check: management calls that act across accounts accept an
  `actor` only if it is a configured admin; (2) `GET /manage/v1/integrations?station=<id>&state=&cursor=` and a search
  by owner or client ID, for admins; (3) an optional `reason` on status changes, stored in the audit row;
  (4) **`GET /manage/v1/built-in-stations`**, listing built-in Stations with no account, for the Portal's sync.
- **Portal:** the startup/hourly sync uses `/manage/v1/built-in-stations` instead of listing as the first
  `PLATFORM_ADMINS` account (so `PLATFORM_ADMINS` is no longer needed for the sync); the `station_admin` role, admin
  notes and admin pause/revoke on others' integrations are removed from the account page and the Portal API. Auth's
  rule that admins may pause/revoke on the built-in Station stays (now used by the admin site).
- **Admin site:** new app (Q7: where its code lives).

**Until it exists,** the D24 behaviour stays as deployed: admins act from their own Portal browser session only.

**Owner decisions (2026-10-31).**

- **Q7, the repository:** a separate, **private** repository, **`Agora-Build/Portal-Admin`**, for now.
- **Q8, MFA from the start:** admin access requires real multi-factor authentication. A fresh sign-in alone is not
  MFA. Auth has no MFA today, and the upstream IdPs (GitHub, Google) give Auth no reliable signal that the person
  used MFA there, so **Auth adds passkeys (WebAuthn) as a second factor**. Until that exists and is verified, the
  admin site runs on dev only.
- **Q9, account disabling:** first answered "stays in the operator CLI"; **revised the same day: no CLI commands for
  admin management, everything from the admin site.** Disabling and enabling an account and resetting a person's
  lost passkeys are admin-site actions, held to the same rules as pause and revoke: the admin client, a step-up
  proof, a required reason and the admin as the audited actor.

**Owner requirements (2026-10-31), and how the design meets them.**

1. **Auth enforces every admin permission server-side.** The admin site is not trusted to decide who is an admin.
   Every cross-account management call (listing or searching other accounts' integrations, pausing or revoking one)
   must:
   - come from the `admin` client, authenticated with its own credentials; and
   - carry the admin's **step-up proof**: an ID token that Auth itself issued to the `admin` client, which Auth
     verifies on the call. Its `sub` must equal the `actor`, the actor must be a configured admin, `acr` must be the
     MFA level, `amr` must include the passkey method, `auth_time` must be at most 5 minutes old, and its `sid`
     must be a live session.

   A call missing any of these is refused (`403 forbidden`, or `401 mfa_required` when only the MFA proof is
   missing) and nothing changes. The Portal's own management calls cannot act across accounts.
2. **Pause and revoke take effect immediately, including active sessions.**
   - At Auth, the integration's status changes in the same transaction, so new tokens are refused at once
     (`401 invalid_client`).
   - The Portal appends the change to the Station's feed and pushes the Station a nudge at once.
   - The Station, on that change, denies the integration's still-valid tokens and closes its open streams and
     sessions. Astation verified this for pause on 2026-10-30, and the revoke checks are pending.
   - Worst case without the push, the Station's poll picks it up within a minute. Issued JWTs are never trusted
     past their 300 s lifetime anyway.
   - A revoked integration's Station-side sessions end on revocation, not at token expiry. This is part of the
     Station contract and of the revoke checks still to run.
3. **Every admin action has a reason and an auditable actor.** The reason (required, 1–500 characters) is sent with
   the call and stored by Auth in `integration_audit` with `actor_account_id` = the admin. The Portal records it in
   `integration_events` (reason, actor), and the admin site keeps its own append-only log, including views.
4. **Admin re-authentication never silently reuses an SSO session.**
   - The admin site always starts sign-in with `prompt=login`, `max_age=0` and `acr_values` = the MFA level.
   - Auth therefore runs its sign-in interaction even if the browser already has an Auth session.
   - Auth then always asks for the passkey. That step is interactive by nature, so even a silent upstream login
     (GitHub, Google) cannot complete an admin sign-in on its own.
   - Auth refuses to issue the `admin` client an ID token at the MFA level unless the passkey was used in that same
     interaction.

**Owner decisions after the Auth review (2026-10-31).**

- **Admin changes reach the Station at once, through an Auth change feed.**
  - Auth keeps an ordered, never-purged feed of the changes that affect integration access, read only by the Portal:
    pauses, resumes and revokes, and an owner account being disabled or enabled.
  - Right after a change the Portal did not make (an admin's), Auth sends the Portal a nudge. The nudge carries no
    data; the Portal then reads the feed over its authenticated management connection.
  - The Portal records each change in `integration_events` with the admin as actor and the reason. It then appends
    the change to the Station's feed and pushes the Station, which denies still-valid tokens and closes open sessions.
  - The Portal also polls the feed about every 30 seconds, in case a nudge is lost.
  - This is the same push-plus-poll pattern the Portal already uses towards the Station.
- **An admin pause locks.**
  - The integration's owner, and a custom Station's owner, cannot resume an integration an admin paused:
    `409 admin_paused`.
  - Only an admin can lift it, from the admin site, with the step-up proof and a required reason, recorded like pause
    and revoke.
  - An admin pausing an integration its owner had already paused turns it into an admin pause.
  - The Portal shows "Paused by Agora.Build" and offers no Resume.
- **No admin commands remain in the CLI.** The pre-D26 `accounts disable` and `enable` commands are removed too. If
  every admin is locked out, recovery is a direct database operation by the operator.

**Passkeys at Auth (part of D26):**

- An account registers one or more passkeys on Auth's account page, after a fresh sign-in.
- At sign-in, a client asking for the MFA level (only the `admin` client in phase 1) goes through the upstream login
  and then a passkey assertion. The passkey is user-verifying, with Auth's origin as the relying party.
- The ID token then carries `acr` = `urn:agora:mfa` and `amr` = `["fed", "hwk"]` (upstream federation plus a hardware
  or platform key).
- Losing every passkey is recovered **by another admin on the admin site** ("Reset passkeys": deletes every passkey
  of the account and ends all its sessions; reason required; audited with the admin as actor). An admin cannot reset
  or disable their own account there. Because recovery needs another admin, **at least two admins must have passkeys
  before the admin site goes live**; with one admin, losing every passkey leaves only a database operation by the
  operator.
- Registering or removing a passkey ends the account's other sessions and is audited.


---

#### 3.3.2 The built-in Station (`station.agora.build`)

**Owner decision (2026-10-30, D24); for review by Astation and Atem.** The built-in Station and custom Stations are
the same kind of thing. They share one protocol with Auth, Portal and Atem. A custom Station may add functions its owner
wants; the built-in Station may add functions Agora.Build wants; both keep the shared protocol. What differs is only how
a Station is admitted and who may use it.

**1. The shared Station protocol** (every Station implements it; nothing in it depends on the kind of Station):

| Direction | Contract |
|---|---|
| Native apps → Station | `astation.remote` token from Auth with `resource` = the Station's exact origin; `aud` = origin, `sub` = the person (`docs/station-tokens.md`, rules A1–A9) |
| Integrations → Station | `i-…` client, `private_key_jwt` + client credentials, `aud` = origin, `sub` = integration owner, `r9_svc`, ≤ 300 s; no token before native approval |
| Station → Portal | Report client `s-…` (`private_key_jwt`, `station.report`, resource = Portal origin): `POST /api/v1/stations/reports`, `GET /api/v1/stations/changes?cursor=` with `ownerAccount` in snapshots and `409 cursor_ahead` recovery |
| Portal → Station | Unsigned push hint `POST <origin>/agora-build/v1/changes {cursor}` (poll only, no authority) |
| Browser → Station | 5-minute `station.read` token by token exchange; `GET <origin>/agora-build/v1/details`, CORS from the Portal origin only |
| Station ↔ Atem/Astation | R9 relay and service membership as in the shared design; native approval binds `r9_svc` |

**2. What differs:**

| | Built-in Station | Custom Station |
|---|---|---|
| Admission | **Configured** in Auth's settings by Agora.Build; no proof of control | Registered in Portal with proof of control (§3.3) |
| Report key | Configured by the operator (public JWK only; the private key stays on the Station) | Given at registration |
| Who may use it | **Every signed-in account** that is not disabled (access mode `any_account`) | The owner and the accounts it is shared with (access mode `members`) |
| Owner | **No user owns it.** It belongs to Agora.Build, administered by Agora.Build admin accounts (configured, the same accounts as the Portal's `PLATFORM_ADMINS`). **Nobody can unregister it** through any API or page, admins included; only Agora.Build's configuration and a deploy can change it | The registering account; it can remove the Station |
| Integrations | **Only once Agora.Build supports hosted execution there** (like Station AI): then any account may create them on it, each owned by its creator; until then creating one is refused. Active integrations per account by plan (owner decision): **Basic 4, Premium 10, Principal and Fellow no cap** | The owner and members; **no cap on any plan** |
| Station-owner actions on others' integrations (pause, revoke) | Agora.Build admin accounts | The Station's owner |
| Default | **Every account's default Station.** Always available; a person can switch back to it at any time | Optional; a person chooses it in Astation |
| Extra functions | Agora.Build's choice, including Station AI once it supports it (D21 revised) | The owner's choice, on the same protocol |

**3. Configuration.** Auth's clients file gets a `stations` list; the static `station.agora.build` resource is removed
from `resources` (Auth refuses to start if an origin appears in both):

```json
"stations": [
  { "origin": "https://station.agora.build", "name": "Agora Station", "access": "any_account", "integrations": false,
    "admins": ["ab<Agora.Build admin account>"],
    "reportKey": { "kty": "EC", "crv": "P-256", "alg": "ES256", "x": "…", "y": "…" } }
]
```

`origin` follows the same rules as registered Stations (https, no path); `reportKey` is a public JWK (a private member
is refused); `integrations` (default `false` for a built-in Station) says whether integrations may be created on it;
`admins` lists existing Agora.Build admin accounts (the Portal's `PLATFORM_ADMINS`), at least one. There is no owner. Dev uses its own built-in Station at **`https://station-dev.agora.build`** (owner decision), never the production
origin.

**4. Auth.**
- **Seeding.** At startup, under an advisory lock, Auth upserts each configured Station as a registered Station row
  flagged `built_in` with its `access` mode and creates its report client `s-…` once (kept by origin across restarts).
  A changed `reportKey` is added as a new key with the usual 10-minute overlap, then the old key is dropped. **A seeded
  built-in Station missing from the file makes Auth refuse to start** (nothing is revoked); retiring one needs an
  explicit entry with `"retired": true`, which revokes its report client and integrations as for a removed Station
  (2026-10-30 ruling: an accidental edit must never revoke every integration on the shared Station).
- **Access modes.** Every place that asks "may this account use this Station" (native Station tokens, integration
  creation, the final token gate, token exchange for `station.read`) checks: `members` → owner or member;
  `any_account` → any account that is not disabled.
- **Admins.** On a built-in Station the configured admins hold the Station-owner rights (pausing or revoking other
  people's integrations on it, listing its integrations). They are not its owner and cannot remove it.
- **Management API.** `GET /manage/v1/stations?account=` also lists built-in Stations, with `builtIn: true` and the
  `access` mode. Removing a built-in Station or adding/removing its members answers `409 built_in`; registering its
  origin answers `409 origin_taken`. No API removes it, whoever asks; dropping it from the configuration is the only way. Integration creation on it answers `409 not_supported` while
  its `integrations` setting is `false`; when `true`, any account may create one (the actor must equal the owner of the
  new integration, as now).
- **Static resource retired.** `station.agora.build` goes through the registered-Station code paths; the special case
  for static Station resources is removed once no clients file uses it.

**5. Portal.**
- The Stations list shows the built-in Station for every signed-in account, marked "Built in", with Details and
  without Remove or Share; registering its origin is refused. Agora.Build admins see admin controls for its integrations
  (pause, revoke); nobody sees Remove.
- Integrations: the Station selector offers the built-in Station only while integrations are enabled on it (Auth's
  `integrations` setting, reported in its Station listing); then creation, approval, pause, resume, revoke, renew, quota
  and keys work as for any Station, and Agora.Build admins hold its Station-owner rights.
- **Plan limits on the built-in Station.** Before asking Auth to create an integration on a built-in Station, Portal
  counts the account's active integrations there (every state except `revoked`, and not expired) and refuses at the
  plan's limit: **Basic 4, Premium 10, Principal and Fellow no cap**, with `403`, code
  `plan_limit`, and the message "Your plan allows N integrations on the built-in Station. Revoke one, upgrade, or use
  your own Station." Custom Stations have no cap on any plan. The plan is Portal's (the same plans as membership and
  billing); Auth does not know plans and does not count. If an account moves to a plan with a lower limit, its existing
  integrations keep working until they are revoked or expire; new ones are refused until it is under the limit.
- The change feed and reports for the built-in Station work as for any Station: its report client sees every
  integration on it (each with `ownerAccount`), and only those. Push hints go to its origin.
- Reconcile treats `builtIn` Stations as present for every account and never revokes integrations because a
  built-in Station is "missing" from one account's list.

**6. Station (`station.agora.build`, Astation's server).** Generates its report key pair (the private key stays on the
Station) and hands Agora.Build the public JWK and its RFC 7638 thumbprint; runs the same report/feed client as a
custom Station (no proof-of-control endpoint needed); serves `/agora-build/v1/details` with `station.read` and CORS
from the Portal origin. Station AI (MCP, LLM, Agent) may be offered once it is supported (D21 revised); until then it
refuses those requests with a clear "not available on this Station yet" message.

**7. Choosing a Station (Astation, Atem).** The built-in Station is every account's default relay. A person who adds a
custom Station may switch Astation and Atem to it, and may switch back to the built-in Station at any time; the
built-in Station is always there to return to. Switching relays repeats the Atem/Astation verification for the new
relay (the trust and pairing checks Astation and Atem already run for a relay change); Auth and Portal are not
involved beyond issuing `astation.remote` for the chosen origin. Otherwise Atem does not change: the built-in relay
keeps its origin and `astation.remote`.

**8. Security.**
- Agora.Build admins administer the built-in Station but do not own other people's integrations on it: they can pause
  or revoke them (Station-owner rights), never approve them or act as their owner.
- Every integration still needs its owner's native approval; `any_account` opens use of the Station, not anyone's
  agents.
- The built-in Station's operator sees the `ownerAccount` of integrations hosted on it, as any Station operator does.
- Load on the shared Station: the plan limits above, each integration's token quota and the Portal's per-account rate
  limits.
- Enabling integrations or Station AI on the built-in Station means Agora.Build's server processes the agent content
  of the accounts that use them there; Astation tells the person so when they approve such an integration or turn
  Station AI on there.

**9. Migration and rollout** (after the Phase 1 live tests):
1. Station: generate the report key pair; send the public JWK and thumbprint.
2. Auth: release seeding and access modes; add the `stations` entry and remove the static resource in the dev clients
   file; verify `astation.remote` tokens for the same origin still verify at the Station (tokens issued under the
   static resource expire within 15 minutes).
3. Portal: release the built-in listing; verify on dev with two accounts (creation, approval, reports, feed,
   details, refusal of remove/share/re-register).
4. Production: the same, with the production origin and keys, on the owner's approval.

**10. Tests.** Seeding is idempotent across restarts and Auth instances; key rotation overlap; removal revokes;
`any_account` allows any non-disabled account and refuses a disabled one; `members` unchanged; `409 built_in` and
`origin_taken`; `409 not_supported` for integration creation while disabled; plan limits on the built-in Station (Basic 4, Premium 10,
Principal/Fellow none; revoked and expired ones not counted; custom Stations never capped; a downgrade keeps existing
integrations); the static-resource path retired without
breaking `astation.remote`; Portal listing, refused actions
and reconcile; the feed of the built-in Station lists only its own integrations; an end-to-end run against the real
Auth with two accounts on the built-in Station.

**11. Asks for review.**
- **Astation:** item 6 (Station duties and timing of the report key), the `409 built_in` refusals, the revised D21, integrations on the built-in Station only once supported.
- **Atem and Astation:** item 7, switching between the built-in and a custom Station and the re-verification it
  needs on each switch; confirm nothing else in Atem changes.


---

### 3.5 Station and Portal talking to each other

| Direction | How |
|---|---|
| Station reports to Portal (integration became Ready, host accepted, errors) | The Station's own Auth client (`private_key_jwt`, client-credentials) with scope `station.report` on the Portal resource; the token's `client_id` identifies the registered Station, and Portal accepts reports only for integrations on that Station |
| Portal tells Station about revocations, pauses and policy changes | **Both push and poll.** Portal pushes a signed change notice to the Station right away; Station also polls Portal every minute for changes since its last cursor, so a missed push is caught. The token lifetime (5 minutes) bounds the worst case either way. |
| The browser reads private details from Station (labels, runtime status) | Portal asks Auth for a **token exchange** (RFC 8693): the signed-in person's session is exchanged for a 5-minute token with `aud` = that Station, scope `station.read`. Portal hands it to the browser, which calls Station directly (Station allows CORS from the Portal origin). Portal never sees the response. |


---

## 4. Decisions (rows D16, D24, D26)

| # | Decision | Status | Owner | Blocks |
|---|---|---|---|---|
| D16 | Station → Portal reports via the Station's own Auth client (`station.report`); Portal → Station changes by push and poll | Decided | Portal, Station | Phase 1 |
| D24 | The built-in Station (`station.agora.build`) is a full Station on the same protocol as custom Stations (integrations, reports, feed, `station.read`, Atem), admitted by configuration instead of proof of control, open to every signed-in account and every account's default relay; integrations and Station AI on it only once Agora.Build supports them there, with active integrations per account limited by plan on it (Basic 4, Premium 10, Principal and Fellow no cap; custom Stations never capped; dev uses its own built-in Station `https://station-dev.agora.build`, never the production origin); no user owns it, Agora.Build admin accounts administer it, and nobody can unregister it; a person may switch to a custom Station and back at any time (re-verification on Atem/Astation for each switch); custom Stations keep proof of control and owner/member access. Each kind may add functions on top of the shared protocol (§3.3.2) | Decided | Auth, Portal, Station | After Phase 1 tests |
| D26 | A separate admin site (private `Agora-Build/Portal-Admin`; `admin.agora.build`, dev `admin.dev.agora.build`) holds Agora.Build's admin powers, starting with finding, pausing and revoking abusive integrations. Admins sign in with MFA: Auth adds passkeys, and sign-in is never a silent SSO reuse. Auth enforces every admin permission server-side, using a step-up ID token on each cross-account call. Pause and revoke take effect at once, including the Station's open sessions. Every action has a required reason and an audited actor. Account disabling, enabling and passkey resets are admin-site actions, not CLI commands. The Portal drops its admin views and syncs built-in Stations through a new account-less Auth listing (§3.3.4) | Decided (Q7–Q9 answered 2026-10-31); dev only until passkeys are verified | Auth, Portal, new admin site | After D24 on dev |

---

## 6. Work (D24 and D26 tables)

**Built-in Station (D24): good to build (contract accepted by Astation 2026-10-30)**

| Owner | Work | Status |
|---|---|---|
| Auth | `stations` list in the clients file (origin, `access`, `admins`, `integrations`, public `reportKey`); idempotent seeding at startup with a stable `s-` report client and key-rotation overlap; access modes `members` / `any_account` in every membership check; retire the static `station.agora.build` resource; `409 built_in` (remove/share), `409 origin_taken` (re-register), `409 not_supported` (integrations off); management API lists built-in Stations with `builtIn` and `access` | To build |
| Auth (dev configuration) | Built-in Station `https://station-dev.agora.build`, `access: any_account`, `admins` = the Portal's `PLATFORM_ADMINS`, `integrations: false` until Astation's runtime checks pass, report key = vault e96 (thumbprint `caIk-O1RarbiQ6_XTCJ36dgiFm_HfG6JvCQfUgMF2RA`); remove the static `https://station.agora.build` resource and its `astation` `resources` entry | After Auth is built |
| Portal | Show the built-in Station to every account (marked built-in, no Remove/Share); offer it for integrations while enabled; plan limits on it (Basic 4, Premium 10, Principal and Fellow no cap; `403 plan_limit`); admins hold its Station-owner rights; reconcile never treats it as missing | To build |
| Auth/Portal | Return the stable `s-` report client ID and configuration to Astation (#21); later a new disposable integration on the built-in Station for the full revoke and default-origin checks | After deploy to dev |
| Station (Astation) | Dev report key pair prepared (e96); dev Station live at `https://station-dev.agora.build` (TLS/WSS verified 2026-10-30); mount reporting once the `s-` client exists; Agora.Build content disclosure; full hosted checks | In progress |
| Production | Production Auth, the production built-in Station `https://station.agora.build` with its own key, after verification and the owner's approval | Later |

**Admin site (D26), after D24 on dev**

| Owner | Work |
|---|---|
| Auth | **Passkeys (WebAuthn)**: registration and removal on the account page, the assertion step at sign-in, `acr`/`amr` in ID tokens, `prompt=login` and `max_age=0` always interactive for the MFA level. **Admin enforcement**: the `admin` client; cross-account management calls require the admin client plus a step-up ID token (sub = actor, configured admin, `acr` MFA, `amr` includes `hwk`, `auth_time` within 5 min, live `sid`); admin listing and search of integrations; a required `reason` stored in the audit; **account administration for the admin client** (account summary, disable/enable, reset passkeys; never on the admin's own account; each action durably recorded with actor and reason before it takes effect); `GET /manage/v1/built-in-stations` (account-less) |
| Portal | Sync through `/manage/v1/built-in-stations`; remove `station_admin` views and admin actions from the account page and API |
| Admin site (new, private `Agora-Build/Portal-Admin`) | Sign-in with `prompt=login`, `max_age=0` and the MFA `acr` for configured admins; a step-up ID token passed to Auth on every change; find, see, pause and revoke integrations with required reasons; a read-only Stations list; its own append-only log of views and actions; dev at `admin.dev.agora.build` only until passkeys are verified |
| Station (Astation) | On a pause or revoke in the feed (pushed or polled), deny the integration's still-valid tokens and close its open sessions and streams at once (verified for pause; revoke pending) |
