# Agora.Build Portal: design

> Status as of 2026-11-04. Production is not set up yet; everything tagged Built runs on dev (https://dev.agora.build)
> from `main`.
> Tags: Built, Built (not deployed), Built (off), Partly built, Not built.

This is the Portal repository's design: what the Portal is for, how it signs people in through Auth, and how Spaces and
the Stoa work. It describes what `main` does today and tags what is still planned. Settings, routes and procedures are
in the [README](../README.md) and the [platform guide](platform.md). Stations, integrations and the admin site, which the
Portal shares with Auth, Astation and Atem, are designed in [integrations.md](integrations.md).

## 1. Purpose and product model

Status: [Partly built] — the people directory, projects, the Stoa, the radar and the marketplaces are built; the
discovery engine, events, Pnyx and Odeon are not.

Agora.Build's core is **resource discovery**: helping startups, teams and individual builders find the people,
projects, offers and events they need, through good networking, meaningful connections and useful events. Spaces are
where discovery turns into real meetings, so every space feature should lead towards finding someone or something
useful. The Portal (https://agora.build, dev https://dev.agora.build) is the community's home.

### 1.1 Pages

Status: [Built]

| Page | What it does |
| --- | --- |
| The floor, `/` | People directory: public profiles with real intent, skills, what they are looking for and a contact link. Natural-language people search through the configured language model, or keyword matching without one. A sourced public activity feed (Agora-Build GitHub events and community actions). |
| Projects, `/explore/` | Verified Agora-Build GitHub projects with categories, search and sorting. |
| Stoa, `/stoa/` | The walkable plaza, its rooms and people's own spaces (§3). |
| Radar, `/radar/` | Web research for a member's stated intent, with source links, run by hand or on a schedule the member turns on. |
| Marketplaces, `/marketplaces/` | Language-model and text-to-speech playgrounds paid with credits, and confirmed community offers. |
| Account, `/account/` | Identity, credits, plans and purchases, the Agora Console connection, Stations and integrations. |

Pages, data files, model providers and offers are described in the README: [Pages and data](../README.md#pages-and-data),
[Public activity](../README.md#public-activity), [Connect models and web research](../README.md#connect-models-and-web-research)
and [Community offers](../README.md#community-offers).

### 1.2 Spaces: type, world and theme

Status: [Partly built] — the Stoa is the only space type; Pnyx and Odeon are not built.

A space combines a type, a world, presence, calls, permissions, discovery, invitations and a theme:

- the **type** defines behaviour;
- the **world** (map) defines where people can move and interact;
- the **theme** defines how the world looks and feels.

Functionality, permissions, presence and calls never depend on the theme.

| Name | Meaning | Status |
| --- | --- | --- |
| Agora | The overall virtual world | |
| Stoa, `/stoa/` | Walkable spaces for meeting, talking and social interaction (§3) | [Built] |
| Pnyx, `/pnyx/` | Stage and audience for talks, panels, town halls and debates | [Not built] |
| Odeon, `/odeon/` | Premium produced experiences, which may include paid admission | [Not built] |

The model leaves room for the later types. A space's `type` is `"stoa"` today. The permission function (§3.7) gains rules
for new types without changing its callers. Pnyx would issue subscriber-only call tokens to its audience. The world
engine draws through a renderer interface, so a WebGL renderer for Odeon could replace Canvas 2D without changing
spaces, presence or calls.

### 1.3 What the Portal owns

Status: [Built]

- **Identity belongs to Auth** (§2). The Portal keeps everything else about a person: the public profile, plan, credits
  and ledger, billing, Stoa spaces, the Agora Console connection, and the account's view of its Stations and
  integrations.
- **The Portal never relays real-time traffic.** Agora Signaling carries movement, presence and live messages; Agora
  RTC carries calls. The Portal owns spaces, permissions, capacity, invitations and token issuing.
- **The Portal never stores message content** of any kind. It has no endpoint or storage for it.
- **One state aggregate.** Profiles, accounts, sessions, sign-in transactions, spaces, entry leases, credits and billing
  live in one document: a locked JSONB row (`agora_build_state`) in PostgreSQL when `DATABASE_URL` is set, or
  `.data/community.json` for one local process. Every change runs in one atomic transaction, which favours consistency
  over write throughput. Stations and integrations keep their own tables beside it (`migrations/`). See
  [Storage and deployment](platform.md#storage-and-deployment).

## 2. Accounts and sign-in through Auth

Status: [Built]

Sign-in comes only from Auth (https://auth.agora.build; dev https://auth.dev.agora.build) over standard OpenID Connect.
The Portal is neither an identity provider nor an OAuth server: its own provider sign-in (Google, GitHub, Apple, the
Agora OIDC and OAuth modes), email linking, the `/oauth/*` server with its client registry, codes and grants, and the
identity lookup endpoint were all removed. Apps that sign people in follow Auth's
[`docs/integrating.md`](https://github.com/Agora-Build/Auth/blob/main/docs/integrating.md). The Portal's registration at
Auth, its settings and every flow step by step are in the platform guide, from
[Signing in through auth.agora.build](platform.md#signing-in-through-authagorabuild) to
[Signing keys and rotation](platform.md#signing-keys-and-rotation).

### 2.1 Decisions

Status: [Built]

| Question | Decision |
| --- | --- |
| Client model | The confidential, first-party OIDC web client `portal`: authorization code with PKCE (S256), state and nonce, scopes `openid profile email`. The Portal keeps its own session, keyed by Auth's `sub`; Auth is not called per request. |
| Account ID | Auth's `sub`: `ab` and 26 Crockford base32 characters (`^ab[0-9A-HJKMNP-TV-Z]{26}$`), the same in every Agora.Build app. |
| Browser callers | The session cookie, with same-origin checks on every non-GET cookie request. |
| App callers | `Authorization: Bearer <Auth access token>` on the versioned API, `/api/v1/...`. A request with a bearer token never falls back to the cookie. |
| Login management | Linked logins, devices and "sign out everywhere" live on Auth's account page; the Portal links to it as "Manage sign-in". |
| Agora Console | A separate connect flow (§4), never a way to sign in. |
| People without an account | "Continue with this browser" stays for looking around (§2.4). |

### 2.2 Sign-in, sessions and sign-out

Status: [Built]

- **Sign-in.** `GET /auth/login?returnTo=<path>` accepts only same-site return paths. The transaction (state, nonce,
  PKCE verifier, return path) is kept in the store for ten minutes (at most 1000 at once) and named by an HttpOnly
  `__Host-portal_auth` cookie, so any Portal instance can finish a sign-in without sticky routing. The callback
  consumes the transaction once, exchanges the code and checks the ID token (issuer, audience, nonce, expiry, ES256
  signature). It refreshes the account's name and picture, and keeps the email only when Auth marks it verified. Any
  failure redirects with `?signin=failed` and creates no session; logs carry the reason, never a token.
- **Sessions.** An HttpOnly `__Host-house_session` cookie (`house_session` over plain http) with a 30-day absolute
  lifetime and at most 20 sessions per account. The server keeps only a hash of the session token, Auth's session ID
  (`sid`) and the ID token. The ID token is kept only for `id_token_hint`, is never accepted as a credential and goes
  with its session.
- **Already signed in elsewhere.** Once per browser session, a page without an account session asks Auth quietly
  (`prompt=none`) whether the person is signed in there, for example through Astation. The `ab_sso_checked` cookie keeps
  it to one check; "Sign out" sets it so the person isn't signed straight back in.
- **Sign-out.** "Sign out" ends the Portal session and sends the browser to Auth's end-session endpoint, ending both.
  Auth's back-channel logout (`POST /auth/backchannel-logout`, a `logout+jwt` checked against Auth's keys) ends the
  sessions of one `sid`, or of every session of a `sub`. Auth sends it once with a short timeout and never retries, so
  the Portal fetches discovery and keys at startup to make misses rarer; a missed logout leaves the Portal session until
  local sign-out or expiry. It answers 503 while the keys can't be fetched, so a token is never treated as valid
  unchecked.
- **Auth unavailable.** The Portal still starts; sign-in says it is temporarily unavailable and retries discovery at most
  every 30 seconds. Existing sessions keep working.

### 2.3 Access tokens for apps

Status: [Built]

- Tokens are verified locally against Auth's keys: `typ` `at+jwt`, ES256, issuer `AUTH_ISSUER`, audience
  `PORTAL_API_AUDIENCE` (by default the Portal's own origin, `https://dev.agora.build` on dev), an unexpired `exp` and an
  `ab…` `sub`. The audience is the same host the app calls, so an app needs one base URL for both.
- Apps call `/api/v1/...` only. `v1` may gain routes and fields but never loses or renames any; a breaking change becomes
  `/api/v2/`. Each route checks its own scope: `credits`, `agora:projects`, `agora:certificates`, `agora:tokens`,
  `integrations:read`, `integrations:approve`, and `station.report` for a Station's own `s-` client.
- Browser-only routes (billing, profile, radar, Stoa spaces and Signaling) answer 403 to any token.
- The first token for a `sub` with no Portal account creates a minimal account (`name: null`), so app users get a
  wallet. It happens only after the route check, so a token that reaches a missing, public or browser-only route
  creates nothing, and a Station's report token never makes an account.
- A token for one account can only read and spend that account's data.

The route and scope table is in [Apps: IdP access tokens and scopes](platform.md#apps-idp-access-tokens-and-scopes).

### 2.4 Who can do what

Status: [Built]

| | Visitor (no session) | Browser-only profile ("Continue with this browser") | Account (signed in) |
| --- | --- | --- | --- |
| Public pages, people, projects, activity | Yes | Yes | Yes |
| Watch the plaza | Yes, never shown | Yes | Yes |
| Walk the plaza, enter rooms and spaces they may enter, talk, join calls | No | Yes | Yes |
| A public profile and the radar | No | Yes; editing belongs to that browser | Yes |
| Own spaces, credits, marketplaces, billing, Agora Console, Stations and integrations | No | No | Yes |

The code calls a browser-only profile a guest. A guest profile that signs in is kept by the account when the account
has none yet. See [Accounts, sessions and guests](platform.md#accounts-sessions-and-guests) and
[Profiles and ownership](../README.md#profiles-and-ownership).

### 2.5 Starting empty

Status: [Built]

When sign-in moved to Auth, the Portal's identity data started empty (state version 2): old sessions, OAuth codes and
grants, pending links and every account whose ID isn't an Auth ID went, with their ledger and billing rows and their
spaces. Guest profiles, rooms and the radar stayed. Version 3 did the same again when Auth's IDs changed from
`acct_<ULID>` to `ab<ULID>`. Both steps run once at load, are idempotent and log counts only. There were no production
users.

### 2.6 Platform admins in the Portal

Status: [Partly built] — `PLATFORM_ADMINS` still exists; moving it behind the admin site (D27) is not built.

- `PLATFORM_ADMINS` lists `ab…` IDs; other entries are ignored and counted in the log, never echoed. It now gives admin
  rights in Stoa spaces only: an admin passes every permission check (§3.7), so they can see and enter private spaces
  and, while present, host, decorate and remove people. Capacity still applies.
- Agora.Build's admin powers over Stations and integrations left the Portal for the admin site (D26)
  [Built: Portal-Admin]. In the Portal an admin is just another account there; see
  [the admin site](integrations.md#334-the-admin-site-d26).
- **D27, all management through the admin site** [Not built]: `PLATFORM_ADMINS` and the operator commands
  `platform-admin.mjs grant-credits` and `assign-role` (§5.3) move behind the admin site's audited API. `import-json` is a
  one-off migration, to be removed once it has run everywhere.

## 3. Spaces and the Stoa

Status: [Partly built] — the plaza, lot rooms, people's own spaces, live presence and messages, calls, hosting,
decorating and themes are built; team messages and DMs over Agora Chat, most discovery hooks and the work for larger
crowds are not.

The Stoa is the first space type: a walkable plaza with first-come rooms, plus worlds that people create for
themselves. How to configure and run it is in the README: [Stoa spaces](../README.md#stoa-spaces) and
[Agora group calls](../README.md#agora-group-calls).

### 3.1 The space record

Status: [Built]

```
Space {
  id                  // "plaza", "lot-<slug>", or a UUID for people's own spaces
  type: "stoa"
  worldId, themeId    // "plaza" or "room"; "agora", "minimal" or "cyberpunk"
  title, purpose      // 2 to 80 characters; up to 300
  visibility          // "listed" (the plaza and lots only), "unlisted" or "private"
  access              // "open", "house" or "members"
  capacity            // enforced on entry
  ownerId             // null for the plaza and lots
  members[]           // account (ab…) or profile (member:<uuid>) IDs
  blocked[]           // people removed by a host
  invitations[]       // { id, tokenHash, usesLeft, expiresAt, createdBy, createdAt }
  channelEpoch        // raised to move the space to a new channel and key
  hostId, topic, tags[]
  decor[], decorVersion
  slug, lot           // lots only; lot is { worldId, lotId }
  createdAt, updatedAt
}
```

Spaces and entry leases (`state.spaces`, `state.spaceLeases`) live in the state aggregate (§1.3). Positions and messages
are never stored. A person acts with up to two IDs, their account (`ab…`) and their profile (`member:<uuid>`);
ownership, membership, blocking and leases match either.

### 3.2 Visibility and access

Status: [Built]

Visibility answers "who can learn this space exists":

| Visibility | On the plaza and in listings | Reachable by |
| --- | --- | --- |
| `listed` | Drawn on the plaza and returned by `GET /api/spaces` | Anyone |
| `unlisted` | Never | Its direct URL |
| `private` | Never | Members, invitation holders and people already inside |

Access answers "who can enter":

| Access | Who may enter |
| --- | --- |
| `open` | Anyone signed in (an account or a browser-only profile) |
| `house` | People with a public profile, and members |
| `members` | The owner, members and invitation holders |

Private spaces admit members and invitations only, so `private` with `open` or `house` is refused. An unlisted or
private space is not a hidden place on the public map: it is a separate world. The plaza never draws it, and no plaza
data, listing, search or visitor token names it. When someone may not see a private space, the page and the API give
exactly the answer for a space that doesn't exist (404, "This space was not found."), so its title never leaks.

### 3.3 The plaza and lot rooms

Status: [Built]

- **The plaza** is the system space `plaza` at `/stoa/`, with room for **200 people walking at once**. Watchers hold no
  lease and don't count. The number was lowered from 1000: the 44 × 34 plaza and a single Signaling channel suit a few
  hundred people, and a larger crowd needs the work in §3.16.
- **Lots.** The plaza map defines six lots, each a standing `listed` and `open` space `lot-<slug>` at
  `/stoa/room/<slug>`: AI agents (8 people), Voice AI (8), RTC lab (6), Founders' table (6), Open source (10) and The
  lounge (12). They are created from the map the first time the spaces service runs, and their titles and capacities
  follow the map on every start. A lot's interior is part of the same map; stepping through the door switches the
  camera to it.
- **Lot rooms don't count toward the plaza.** Entering a lot gives up the plaza lease, and a lot's URL works while the
  plaza is full.
- **A full plaza.** A signed-in person who opens a full plaza watches it and is offered the spaces they belong to, and
  "Start a space" while their plan allows (a 409 carrying the offer). The offer stays while they watch; a free place
  lets them walk in.
- **First come, first served.** The first person into an empty lot becomes its host and is asked for a topic.
  `GET /api/spaces` gives each lot's topic, tags, host name, occupancy and occupants; plaza clients read it every 10
  seconds, and the door signs show the topic. When the last person
  leaves, the topic, tags, host, decorations and removals clear and the lot is free again.
- **Lot rooms are public places.** Their Signaling channel name is public (§3.9), so talk in a lot room is not private.

### 3.4 Hosts and moderation

Status: [Built]

Every room and space has at most one host:

- **Lot rooms:** the first person in hosts. When the host leaves, the person present longest takes over.
- **People's own spaces:** the owner hosts whenever present. Otherwise the person present longest hosts until the owner
  returns.
- The host can hand the role to anyone present (`POST .../host`). The owner takes it back by entering, or by handing it
  to themselves while present. The plaza never has a host.
- Host changes happen in the same atomic transaction as entries, departures and the expiry sweep (§3.8), so there is
  never more than one host. Clients learn about a new host from heartbeats and from `refresh` notices (§3.9).

The host, or the owner, while present can set the topic and tags, decorate (§3.6) and remove a disruptive person for the
session. Host powers always need a lease: owners and admins must be inside to use them.

**Removal** puts the person's IDs on the space's block list and ends their lease. In unlisted and private spaces it also
raises `channelEpoch`, which moves everyone else to a new channel and key that the removed person never receives. Their
next heartbeat is refused and their page leaves the room and the call. Nobody can remove the owner or themselves. In a
lot room a removal lasts until the room empties. In a person's own space it lasts until the owner lets them back from
the manage dialog; only the owner changes the member list. An admin can also remove someone from the plaza, and there
the block has no end, because the plaza has no owner and never empties.

### 3.5 People's own spaces, members and invitations

Status: [Built]

- Every space a person creates is its own world at `/stoa/s/<id>`, on the `room` map (a single room with seating),
  `unlisted` or `private`, with a capacity of 2 to 50 (default 12) and the theme its owner picks. It lasts until the
  owner deletes it.
- Owning needs an account; browser-only profiles can visit but not own. Plans cap how many spaces an account owns: 3 on
  Basic and 20 on every other plan (`entitlements(plan).spaces`). At the cap, creating answers 409 with the same offer
  as a full plaza.
- Spaces are created from the Stoa's dialog, which `/stoa/?start=<title>` opens pre-filled (the home page's session
  planning and a profile's "Start a space" use it). The creator lands in the new space.
- The owner edits the settings, deletes the space, creates invitation links, removes members and lets removed people
  back. Tightening visibility or access removes the people who may no longer enter and moves the space to a new channel
  and key. Only the owner's view of a space carries its member and blocked lists, with names.
- **Invitations** are random (24 bytes), shown once and stored only as SHA-256 hashes. Each has 1 to 100 uses
  (default 10) and lasts 1 to 720 hours (default 72); a space keeps at most 50 live ones. Opening
  `/stoa/s/<id>?invite=<token>` lets the holder see the space, and entering with it uses it once and makes them a
  member.
- `GET /api/spaces/mine` lists the spaces a person owns or belongs to, newest first, with their allowance.

### 3.6 Decorating

Status: [Built]

- Decorations are **semantic kinds**, never artwork: `plant`, `lamp`, `rug`, `sofa`, `chair`, `table`, `whiteboard`,
  `bookshelf`, `screen`, `banner`, `poster`, `statue`, `fountain`. The theme draws each kind, so the same arrangement
  looks Greek in Agora and neon in Cyberpunk. An item has a rotation (0, 90, 180 or 270) and a variant (0 to 7) that
  picks one of the theme's styles. Sofas, tables, whiteboards, bookshelves, statues and fountains block movement.
- In decor mode the host picks a kind from a palette and clicks a tile or uses "Place in front of me"; arrow keys move
  the selected item, `R` turns it and `Delete` removes it. The panel lists the placed items for screen readers.
- The server checks the whole arrangement on `PUT /api/spaces/<id>/decor`: the caller is the host, owner or an admin and
  is present; there are at most 60 items; each is a known kind on open floor inside the room (a lot's interior, or
  anywhere in a person's own world), one per tile, off doors, spawns and entrances; and every door, entrance and seat
  stays reachable with the blocking items in place. The editor mirrors these checks.
- After saving, the host's client publishes `{ t: "decor", version }`. Other clients then fetch the space, so the
  server's saved copy stays the source of truth.
- Lot decorations clear when the room empties. Decorations in people's own spaces are saved.

### 3.7 Permissions

Status: [Built]

All authorisation goes through one pure function, `can(actor, action, space, context)` in
`scripts/spaces/permissions.mjs`. Every REST handler and every Signaling or call token request uses it.

| Action | Allowed when |
| --- | --- |
| `see` | The space isn't private, or the person is a member, holds a valid invitation, or is present |
| `enter` | They can see it and aren't blocked, and the access rule (§3.2) admits them |
| `chat`, `speak` | They are present and not blocked; in the Stoa everyone present may speak |
| `host`, `decorate`, `moderate` | They are present and are the current host or the owner |
| `edit`, `invite`, `delete` | They are the owner |

Platform admins pass every check (§2.6). The plaza and lots come from the map and can't be edited, invited to or deleted
by anyone.

### 3.8 Entry leases

Status: [Built]

- Entering (`POST /api/spaces/<id>/enter`) checks `enter` and capacity in one atomic transaction and records a
  60-second **entry lease**. The answer carries the space, whether the person is the first one in, the channel name, the
  key (unlisted and private spaces), the block list and the host.
- The page renews the lease with a heartbeat every 20 seconds. Each heartbeat answers with the current channel, key,
  block list and host, so a moved channel reaches everyone. It answers 410 when the lease is gone or the person may no
  longer enter; the page then re-enters once, and otherwise leaves.
- Leaving through the door, or closing the page (`navigator.sendBeacon` to `/leave`), ends the lease. A sweep every 15
  seconds ends expired leases, hands hosting on and clears empty lots, so after an abrupt exit a seat can stay taken for
  up to about 75 seconds.
- The same person in two tabs holds one lease. A page restored from the back/forward cache reloads, because its lease
  and channel are stale.

### 3.9 Live presence, movement and messages (Agora Signaling)

Status: [Built]

**Channels.** Each space has one Signaling message channel, named by the server:

- the plaza is `ab-stoa-plaza` and each lot `ab-stoa-<slug>`: names anyone may learn;
- an unlisted or private space is `ab-stoa-` and the first 24 hex characters (96 bits) of
  HMAC-SHA256(`SPACES_SIGNALING_SECRET`, `"channel:" + id + ":" + channelEpoch`), revealed only to lease holders by the
  enter, heartbeat and Signaling token answers.

A browser keeps one Signaling login and is on one space channel at a time: the plaza, or the room it is in.

**Tokens.** Agora Signaling tokens grant login only: any logged-in client can subscribe or publish to a channel whose name
it knows. Agora's per-channel permission tokens (`Rtm2Permissions`) are not documented in the Signaling guides and need
Agora's assistance, so the design doesn't depend on them. `POST /api/signaling/token` returns
`{ appId, userId, token, expiresAt, channels }`: a 15-minute login token signed with atem-core (§4), and the channels the
person may use. The user ID is the account ID (`ab…`), `m-<uuid>` for a browser-only profile, or a random `g-…` for a
visitor. Agora authenticates every publisher's user ID, so receivers know who really sent each message. The page renews
the token when Agora warns that it will expire.

`AGORA_RTM_PERMISSIONS=true` [Built, off] adds Agora's read permission for the person's channels and write permission
for the ones they may publish to (those tokens are built with `agora-token`, because atem-core doesn't build them). It is
off by default and nothing depends on it.

**Protection** comes from these layers:

1. **Login identity.** Every publisher's user ID is authenticated by Agora.
2. **Unguessable names** for unlisted and private channels. `channelEpoch` rises when someone is removed, a member is
   removed, the visibility changes, or tighter access turns people out, so the space moves to a new channel and those
   who left cannot follow.
3. **End-to-end payload encryption** for unlisted and private spaces. Every message and every presence state is sealed
   in the browser with AES-256-GCM (WebCrypto), as `e1.` and base64 of a 12-byte IV and the ciphertext. The key is
   HMAC-SHA256(`SPACES_SIGNALING_SECRET`, `"key:" + id + ":" + channelEpoch`), given only to lease holders. Someone who
   learns a channel name without a lease cannot read messages, positions or names, and their own messages fail to
   decrypt and are dropped. The Portal encrypts in its own code rather than with the SDK's encryption setting, because
   the SDK applies one key to every channel a client uses and the plaza and each room need different keys. A known
   remaining exposure: Agora presence can reveal the user IDs on a channel to anyone who knows its name; only
   current-epoch names work, and only people who were inside have had them.
4. **Receiver rules on every channel.** Clients drop messages and presence state from `g-` users, from publishers with
   no presence on that channel, from people on the block list (the plaza's comes with `GET /api/spaces`, a room's with
   entering and heartbeats), and anything that fails validation or decryption. Room notices count only from the host or
   owner.
5. **Short tokens.** Login tokens last 15 minutes, and a renewal lists channels only for current leases.

Visitors watch the plaza quietly, without presence, and anything they publish is ignored. Lot rooms are listed, so their
channels are plaintext and anyone with a Signaling login can read them.

**Presence and movement.**

- A person's presence state is `{ x, y, dir, name }` (the name up to 60 characters), set when they stop. The page reads
  the current people (`whoNow`) page by page and handles presence events, single or batched, one at a time so
  decryption never reorders them. People who drop off time out after 30 seconds.
- Click or tap picks a target tile; the client finds a path with A* on the map grid, counting blocking decorations, and
  publishes `{ t: "move", path, startedAt }`. Arrow keys and WASD publish only on press and release
  (`{ t: "walk", from, dir, startedAt }`, `{ t: "stop", at }`, and `{ t: "face", dir, at }` for a turn), and other
  clients work out the steps in between.
- Budget: Signaling allows 60 messages a second per client in a channel. Clients publish movement at most 4 times a
  second, keeping only the latest pending move, and update presence state only when someone stops.
- The Portal doesn't validate movement. Receivers drop paths that cross blocked tiles, skip tiles, run over 400 steps or
  start more than 2 tiles from where they last saw the person, and use their own clock when a start time is more than 2
  seconds off. Movement is cosmetic; access, capacity and calls are enforced by the server.
- Only avatars within about one screen of the view's centre in each direction are drawn; the panel still lists
  everyone.
- Names on the live layer are what each sender's client says; only the user ID behind them is authenticated.

**Messages.**

- Public messages go on the plaza channel and room messages on the room's channel. They show as speech bubbles for 8
  seconds and in the panel's message log.
- **No history.** A message reaches only the people subscribed when it is sent. The Portal never stores or replays it.
- Clients limit messages to 500 characters and one a second, with a burst of three. Receivers ignore payloads over 8 KB.
- The same channel carries three notices: `refresh` (the topic or host changed, so fetch the room), `decor` (a new
  arrangement) and `rekey` (access changed, so send a heartbeat now and pick up the new channel and key).

**Without Signaling.** If Signaling isn't configured (503) or doesn't connect within 10 seconds, people can still walk,
enter rooms, set topics and join calls, and the page says live movement isn't connected. If the connection fails for
good, the page asks for a reload. A second login with the same user ID (another tab) takes over, and the older tab says
so.

### 3.10 Team messages and DMs (Agora Chat)

Status: [Not built]

Signaling covers live, place-based talk. Agora Chat would cover conversations that last beyond a visit; Chat would hold
their history under the project's Chat retention settings, and the Portal would still store no message content. The
design to build:

- **Teams.** One Chat group per room or space. In a lot room the team is whoever is inside now: the first entry creates
  the group, people are added on entry and removed on leaving or lease expiry, and the group is dissolved, with its
  history, when the room empties. The Portal's system account owns it and the host is a group admin. In a person's own
  space the team is its members plus anyone inside: members stay in the group while away, visitors are added on entry
  and removed on leaving, and the group lasts until the space is deleted; the owner owns it. Groups are private, and
  invitations always go through the Portal and `invite`.
- **DMs.** One-to-one conversations between two signed-in people with published profiles, started with "Message" on
  profiles and in the people list.
- **Identity.** The Portal registers a Chat user through the Chat REST API the first time someone needs Chat, and keeps
  only the returned Chat user UUID on the private account, never a password. The old design used lowercase member IDs
  as Chat usernames; that predates `ab…` account IDs, so the username scheme needs choosing again.
- **Tokens.** `POST /api/chat/token` returns a one-hour Chat user token for the signed-in person. Server calls use an app
  token, cached until shortly before it expires.
- **Membership sync.** The Portal is the source of truth. Member-list changes (adding, removing, accepting an invitation,
  deleting a space) call Chat in the same request and are kept only if Chat succeeds or isn't configured. Entering,
  leaving and lease expiry update the group too but never block entry; failed calls go into a retry queue in the store,
  retried by the 15-second sweep.
- **Blocking.** Blocking someone in Chat stops their DMs. Deleting a profile removes the Chat user, with its DMs and
  group memberships.
- **Interface.** A Messages drawer on every Stoa page and the account page lists DMs and team conversations with unread
  counts. It is plain HTML outside the canvas and doesn't depend on the theme. The call controls' chat button opens the
  room's group.
- **Settings.** `AGORA_CHAT_APP_KEY` (`org#app`) and `AGORA_CHAT_REST_HOST`, reusing `AGORA_APP_ID` and
  `AGORA_APP_CERTIFICATE`. Without them Messages is hidden and spaces work without Chat groups.
- **What the code needs first.** `spaces.onEvents()` already delivers each committed batch of events (`entered`, `left`,
  `host`, `emptied`, `member-added`, `member-removed`, `removed`, `deleted`), but it runs after the commit and can't
  refuse a change. Keeping member-list changes only when Chat succeeds needs a hook before the commit, or a compensating
  transaction. Events also need both of a person's IDs, a `created` event, and plaza entries and departures left out.
  Invitations are accepted inside `enter`, which must never block on Chat.

### 3.11 Calls (Agora RTC)

Status: [Built]

- Calls happen inside lot rooms and people's own spaces. The plaza has no call.
- `POST /api/spaces/<id>/rtc-token` issues Agora AccessToken2 credentials only to someone holding a current lease for
  that space; being on a member list is not enough. Everyone present publishes. Tokens are signed with atem-core (§4).
- The channel is `agora-build-space-<id>`. Each tab has its own identity, the person's key (their `ab…` ID or profile
  UUID), `_` and 12 hex characters, plus `<uid>_screen` for a screen share, which uses a separate publisher so it runs
  alongside the camera. A renewal must reuse one of the person's own identities and still needs the lease.
- Tokens last `AGORA_TOKEN_TTL_SECONDS` (60 to 3600, default 3600). After leaving or removal, renewal is refused, and the
  page leaves the call as soon as a heartbeat or renewal is refused; a token already issued stays valid until it
  expires. Unlike Signaling, an RTC token is bound to its channel, so the predictable channel name doesn't matter.
- `world/rtc-client.js` handles joining, devices, publishing, screen sharing and renewal with no UI; `stoa/call.js` draws
  the controls and video tiles. The controls are native buttons that look the same in every theme. Devices stay off
  until the person chooses to join, and joining only to listen works. The theme picks the layout: over avatars
  (Agora), a strip (Cyberpunk) or a grid (Minimal).
- Without the Agora settings, rooms stay usable and calls show as unavailable (503).

### 3.12 World engine, maps and themes

Status: [Built]

```
Map (worlds/<id>/map.json) -> Engine (world/*.js)          -> Theme (themes/<id>/theme.json)
semantic layout               movement, camera, input, drawing  art and styling only
```

**Maps** use a subset of Tiled JSON: orthogonal, square tiles, uncompressed `ground` and `structure` tile layers, and
object layers.

- Tiles carry a role: `floor`, `path`, `grass`, `water`, `wall`, `column`, `door`, `table`, `seat`, `plant` or `decor`.
  Walls, columns, water, tables and plants block movement; a tile may override that.
- Object layers: `lot` (a rectangle with `lotId`, `slug`, `title`, `capacity`, a door tile on the plaza and an entry
  tile inside), `spawn`, `zone` (named areas, kept for proximity features) and `interactable` (a kind, a label and, for
  noticeboards, a query).
- `world/map.js` (parsing, walkability, A*, reachability and path checks) is shared by the server and the browser. The
  server loads the same files for lots, doors and capacities; the browser gets them from `GET /api/worlds/<id>`.
- `npm run maps` generates the two built-in maps: `plaza` (44 × 34, six lots whose interiors sit below the plaza in the
  same map, and three noticeboards) and `room` (a single room with a table and seats). Designers may replace them with
  maps edited in Tiled.

**Themes** are data only and never contain code, so community themes could later be added without running their
authors' scripts. A theme chooses from fixed catalogues that the renderer implements: a pattern and colours for every
core role, colours and up to 8 variants for every decor kind and `noticeboard`, an avatar style (`token` or `pawn`) with
a palette, page colours from an allowlist of CSS tokens (`--paper`, `--surface`, `--ink`, `--muted`, `--line`,
`--accent`, `--accent-dark`, `--green`), a font from an allowlist, lighting, effects (`dust`, `rain`, `leaves`,
`neon-glow`) and a video layout. `validateTheme()` runs at startup and in tests: only known fields, hex colours only,
every role and kind drawn, and at most 64 KB. Themes carry no image files.

- The three built-in themes are Agora (the default: marble, colonnades and terracotta, matching the site's palette),
  Minimal (flat and high contrast) and Cyberpunk (dark and neon, with rain).
- An owner picks their space's theme; a change shows after a reload. The plaza and lots use Agora. Theme tokens restyle
  only the Stoa section; the site header and footer keep the Portal's look.
- A viewer can switch their own display to Minimal for accessibility or performance (remembered in the browser), and
  `/stoa/?theme=<id>` previews a theme. Neither changes anything for anyone else.
- Avatars are drawn by the theme as a token or pawn in a palette colour chosen from the person's ID, with their initials
  on tokens and their name below.

**The engine** draws with Canvas 2D, scaled for high-resolution screens, with a camera that follows the person's own
avatar. It supports click or tap to walk and the arrow keys or WASD, and draws frames only while something moves or
animates. Under `prefers-reduced-motion`, effects and water motion are off and walks still move. Drawing goes through a
renderer object passed to the engine (`world/renderer-canvas.js` today). The Stoa page is `stoa.js` with `stoa/`
(stage, place, lease, panel, call, decor and spaces modules); the world modules in `world/` are the engine, map, camera,
motion, renderer, themes, protocol, presence, crypto, Signaling and RTC clients.

### 3.13 Accessibility

Status: [Built]

A DOM panel beside the canvas offers everything the canvas does: the rooms with their topics, occupancy and a **Go to**
button that walks there and steps in; the people present, with host tools for the host; the message log
(`role="log"`) and its form; the topic form for hosts; the decoration list; the call controls; and the person's own
spaces. A polite live region carries the status notices: entering, leaving, hosting and errors. If the canvas can't
start, the panel still lists rooms and spaces, says where each door is, and lets people sign in and start a space;
walking and entering need the canvas. All panel text is set as text, never as HTML.

### 3.14 Discovery hooks

Status: [Partly built] — topic tags and room search are built; profile cards in the Stoa, noticeboard results, "Live
now" rooms on the people page and Stoa activity are not.

The Stoa connects the world to the discovery that already exists (people search with intent, projects, offers and the
radar). The full discovery engine is later work (Roadmap).

- **Topic tags** [Built]. A host adds up to 5 tags with the topic. They are free text, normalised (lower case, single
  spaces, at most 30 characters, no duplicates), shown with the topic in the room panel and returned in lot summaries.
  Choosing tags from the profile skill vocabulary, and showing them on the plaza door sign (which shows the topic), are
  [Not built].
- **Room search** [Partly built]. `GET /api/spaces?q=` matches listed lot rooms by title, topic and tags; unlisted and
  private spaces are never searchable. The people search page doesn't yet show "Live now" rooms next to people results,
  linking to `/stoa/room/<slug>`.
- **Profile cards in the Stoa** [Not built]. Selecting an avatar on the canvas or in the panel's people list would open a
  card from the person's published profile (name, intent, what they are looking for, skills, projects) with
  **Message** (a Chat DM, §3.10), **View profile** and **Invite to my space**. Visitors would see the card without these
  actions, and people without a published profile would show by name only. Lot occupants carry only `{ id, name }`, so
  the profile ID has to be added, and the space view (`publicSpace`) should become an allowlist of fields first. The
  cards would also replace the self-asserted names on the live layer (§3.9) with the server's. The people directory
  already has profile cards, whose "Start a space" opens the Stoa's create dialog named "Connect with <name>" [Built].
- **Noticeboards** [Partly built]. The plaza map places three `noticeboard` objects, "Looking for collaborators", "Voice
  AI" and "Offers", each with a fixed query, and every theme must draw them. Opening a board is not built: it would show
  people, projects and offers ranked by match with the viewer's own skills and needs (`GET /api/noticeboards/<id>`),
  with a **Go to** for a matching live room, and never unlisted or private spaces.
- **Activity** [Not built]. "Opened a room about <topic>" and "joined <topic>" would appear in the public activity feed,
  for listed rooms only and with the existing privacy cleanup. The server registers no listener on `spaces.onEvents()`
  yet.

### 3.15 Old meeting rooms

Status: [Built]

Each old meeting room became a Stoa space with the same ID: `unlisted`, access `members`, the same owner, its roster as
the member list, the `room` map, the Agora theme and a capacity of 12. This happens when the spaces service first runs
after a start and is idempotent; migrated rooms count toward the owner's allowance. `/meet/<id>` and
`/meetings.html?room=<id>` answer 308 to `/stoa/s/<id>`, and the `/api/rooms` routes answer 410, so no new rooms appear.

### 3.16 Scale

Status: [Partly built] — the plaza fits about 200 people on one channel; moving leases out of the state document, cell
channels, per-person rate limits and proximity audio are not built.

- Nothing needs sticky routing: sign-in transactions and leases live in the store, and Signaling carries the live
  traffic. Rate limits are counted per process.
- Every entry, heartbeat and departure rewrites the single state document. Before real plaza load, leases should move
  out of the aggregate, or heartbeats be batched [Not built].
- Each space has one channel. The client already merges people from several channels by ID, so a larger crowd could use
  area cells on separate channels with a bigger map, or copies of the plaza [Not built].
- The spaces routes are limited per client address (240 a minute), so many people behind one shared address can exhaust
  the limit with heartbeats. Key the limits by person [Not built].
- **Proximity audio** [Not built]. Presence already includes position, so a client could choose which nearby people's
  streams to receive; the call view's matching of video tiles to avatars can drive it.
- **Draw cost** [Not built]. Cyberpunk's neon glow draws many blurred shapes each frame; cache the static tile layer per
  theme, bounds and zoom before crowds arrive.

## 4. Agora Console connection and Agora tokens

Status: [Built]

- **Connecting Agora Console is separate from signing in.** `GET /connect/agora`, for a signed-in account only, uses
  Agora SSO as a confidential client (`AGORA_SSO_*`). The transaction is single-use, bound to the account and kept in the
  store with its own cookie. There is no PKCE, because Agora refuses it for confidential clients; the client secret and
  the account-bound state protect the code.
- **What is stored:** per account, the Agora tokens and display name, sealed with AES-256-GCM under
  `AGORA_CONSOLE_ENCRYPTION_KEY` and bound to the account ID. Project lists, App IDs and certificates are fetched from
  the Agora CLI BFF on demand and never stored. A certificate is revealed only when the owner asks, and the browser
  clears it after 30 seconds or when the tab is hidden. A refused token renewal marks the connection as needing a
  reconnect.
- **Agora tokens.** `POST /api/v1/connections/agora/token` signs RTC or RTM tokens for one of the account's projects, so
  an app never needs the App Certificate. Signing uses Atem's `atem-core`, compiled to WebAssembly
  (`native/atem-core-wasm`, committed as `scripts/vendor/atem-core.wasm`) at the Atem revision Astation pins, so
  agora.build and Astation produce identical tokens. The Stoa's call and Signaling tokens use the same module.
- Apps use the `agora:projects`, `agora:certificates` and `agora:tokens` scopes; Astation reads projects and tokens from
  these routes.

The flow, the Agora endpoints, the tolerant response mapper and the token fields are in
[Agora Console connections](platform.md#agora-console-connections) and [Agora tokens](platform.md#agora-tokens).

## 5. Credits, plans and billing

Status: [Built]

### 5.1 Plans and entitlements

Status: [Built]

| Plan | How an account gets it |
| --- | --- |
| Basic | The default |
| Premium | An active or trialing Stripe subscription, within its paid period |
| Principal, Fellow | Assigned community roles, never sold; they include Premium's entitlements |

Entitlements match Vox's plan names and limits (projects, evaluation flows, private resources, own storage, mainline
publishing for Principal and Fellow); Vox enforces them once Vox signs in through Auth. The Portal's own entitlements are
the Stoa space allowance (3 on Basic, 20 otherwise, §3.5) and the cap on integrations on the built-in Station (4 on
Basic, 10 on Premium, none for Principal and Fellow; see [integrations.md](integrations.md#332-the-built-in-station)).

### 5.2 Credits and the ledger

Status: [Built]

- Credits are whole numbers in a balanced ledger with user, escrow and platform accounts. Spending first reserves
  credits into escrow and then captures or releases them; idempotency keys make retries safe, and concurrent spending
  can't overdraw a wallet. Holds not settled within an hour are released. Users start with zero credits, and no browser
  or native endpoint can grant them.
- The marketplaces charge per request (`MARKETPLACE_CHAT_CREDITS`, `MARKETPLACE_TTS_CREDITS`); a failed model request
  releases its hold.
- **Billing clients** such as Vox reserve and settle a person's credits with that person's access token. The client never
  sends a price: `PORTAL_BILLING_FILE` holds server-side prices per client and service, so a stolen token can't set its
  own price. Only confidential clients may be listed, never a native client, whose ID is public.
- **Stripe** sells Premium (monthly or yearly) and credit packs through Stripe-hosted checkout and billing management.
  Only the verified webhook grants anything, after checking the customer, order, price and actual payment; redirects
  never grant credits.

Details: [Platform credits for billing clients](platform.md#platform-credits-for-billing-clients) and
[Subscription plans and purchases](platform.md#subscription-plans-and-purchases).

### 5.3 Operator commands

Status: [Partly built] — the commands exist; moving them behind the admin site (D27) is not built.

`node scripts/platform-admin.mjs` records audited manual credit grants (`grant-credits`), assigns community roles
(`assign-role`) and imports a JSON state file into an empty database once (`import-json`). It works online against
PostgreSQL, or offline with the Portal stopped and `PORTAL_OFFLINE_ADMIN=true`. D27 moves these powers to the admin site
(§2.6).

## 6. Stations and integrations

Status: [Built] — the Station side of the launch, message and notify scopes is [Built, off: Astation].

The Portal is one part of Agora.Build's Unified Integrations. It keeps the account's view: the account page's Stations
and Integrations sections, registering custom Stations with proof of control, the built-in Station that every account
has (dev https://station-dev.agora.build), the integration lifecycle and its history, the reports and change feed that
Stations use, and reading Auth's change feed so that admin changes reach Stations at once. It needs `DATABASE_URL` for
its own tables (`migrations/`), as well as `AUTH_ISSUER` and `PORTAL_CLIENT_SECRET`; without the database every
integration route answers 503.

- Phase 1 (D1 to D23) [Built]. The joint live tests with Astation (pause and resume, revoke, reconnect) passed on dev.
- The built-in Station (D24) [Built], with integrations turned on.
- The admin site (D26) [Built: Portal-Admin]; the Portal has no admin views (§2.6).
- The `agent.launch`, `agent.message` and `agent.notify` scopes (D28) [Built] on the integration form; `agent.notify`
  needs `agent.message` and `agent.prompt`. The Station maps them to Atem's signed operations only in builds with a
  feature that is off on every Station [Built, off: Astation].
- All management through the admin site (D27) [Not built].
- Discord, the assistant voice pipeline and Station AI [Not built].

The design, with every decision and its status, is in [integrations.md](integrations.md) (registered Stations in §3.3,
the built-in Station in §3.3.2, the admin site in §3.3.4, the Station and Portal feeds in §3.5 and the account page in
§3.6). Settings, routes and the lifecycle are in [Stations and integrations](platform.md#stations-and-integrations).

## 7. Routes, API and errors

Status: [Built]

### 7.1 Pages

Status: [Built]

Pages are served at clean addresses ending in `/`; `/<name>` and `/<name>.html` answer 308 there
([Pages and data](../README.md#pages-and-data)). The Stoa's pages are all served by `stoa.html`:

| Route | Behaviour |
| --- | --- |
| `/stoa/` | The plaza. Visitors watch; signed-in people walk. `?start=<title>` opens the create dialog; `?theme=<id>` previews a theme. |
| `/stoa/room/<slug>` | The plaza, starting at that lot's door; 404 for an unknown slug |
| `/stoa/s/<id>` | A person's own world; `?invite=<token>` carries an invitation; a space the person may not see is 404, like a missing one |
| `/meet/<id>`, `/meetings.html?room=<id>` | 308 to `/stoa/s/<id>` |

### 7.2 The Stoa API

Status: [Built]

These routes take the browser session only; an access token gets 403. Space IDs are `plaza`, `lot-<slug>` or a UUID.

| Method and path | Who | Purpose |
| --- | --- | --- |
| `GET /api/spaces` | Anyone | The plaza's occupancy and block list, and the lot rooms with topic, tags, host, occupancy and occupants; `?q=` searches them |
| `POST /api/spaces` | Account | Create an unlisted or private space, within the plan's allowance |
| `GET /api/spaces/mine` | Signed in | The spaces you own or belong to, with your allowance |
| `GET /api/spaces/<id>` | `see` | A space (`?invite=` for a private one); the owner's view adds members, removed people and invitations without their hashes |
| `PUT /api/spaces/<id>` | `edit` | Change the settings |
| `DELETE /api/spaces/<id>` | `delete` | Delete the space |
| `POST /api/spaces/<id>/enter` | `enter` | Take a lease, with the atomic capacity check; `{ invite }` accepts an invitation |
| `POST /api/spaces/<id>/heartbeat`, `/leave` | Lease holder | Renew the lease (answers with the channel, key, block list and host) or leave; no body, so `sendBeacon` works |
| `POST /api/spaces/<id>/topic` | `host` | `{ topic, tags }` |
| `POST /api/spaces/<id>/host` | `host` | `{ actorId }`: hand hosting to someone present |
| `PUT /api/spaces/<id>/decor` | `decorate` | `{ items }`: replace the whole arrangement |
| `POST /api/spaces/<id>/remove` | `moderate` | `{ actorId }`: remove someone for the session |
| `POST /api/spaces/<id>/invitations` | `invite` | `{ uses, hours }`: a new invitation, whose token is shown once |
| `POST /api/spaces/<id>/members`, `DELETE /api/spaces/<id>/members/<id>` | Owner | Add a member or let a removed person back; remove a member (`ab…` or `member:` IDs) |
| `POST /api/spaces/<id>/rtc-token` | Lease holder | Call credentials; `{ uid }` renews |
| `POST /api/signaling/token` | Anyone with a browser | A Signaling login token and channels (visitors get the plaza only) |
| `GET /api/worlds/<id>` | Anyone | Map JSON (`plaza` or `room`) |
| `GET /api/themes` | Anyone | The built-in theme manifests |

Rate limits, per client address: creating spaces 20 an hour, Signaling tokens 30 a minute, other space routes 240 a
minute.

### 7.3 Other routes

Status: [Built]

Sign-in and session routes (`/auth/login`, `/auth/callback`, `/auth/backchannel-logout`, `POST /api/auth/logout`,
`GET /api/auth/config`, `GET /api/me`) are in the platform guide's sign-in sections. The app API under `/api/v1` is in
[Apps: IdP access tokens and scopes](platform.md#apps-idp-access-tokens-and-scopes), and the Stations and integrations
routes in [Routes](platform.md#routes).

### 7.4 Errors

Status: [Built]

Errors are JSON, `{ error: "<a friendly sentence>" }` plus any details, from the shared `AppError`:

| Status | When |
| --- | --- |
| 400, 413, 415 | The body isn't valid JSON, is over 16 KB, or isn't JSON at all |
| 401 | Signing in is needed |
| 403 | Not allowed: not a member, removed, not inside, not the host or owner, a room the map defines, or an access token on a browser-only route |
| 404 | The space doesn't exist, or the person may not see it (the same answer for both) |
| 409 | The room or plaza is full (the plaza adds `{ full, offer }`), or the plan's space allowance is used up (`{ offer }`) |
| 410 | The lease is gone or access was lost (heartbeat); the old `/api/rooms` routes |
| 422 | Invalid input |
| 429 | Too many requests |
| 503 | Signaling or calls aren't configured |

Bearer errors (401 `invalid_token`, 403 `insufficient_scope`, 503 when Auth's keys are unreachable) are in the platform
guide.

## 8. Testing approach

Status: [Built]

- `npm test` runs the Node test runner with isolated temporary data, stand-ins for Auth (with `jose` keys), Agora SSO and
  the BFF, and Auth's management API, and mocked model providers. The Stations and integrations tests that need
  PostgreSQL run in throwaway schemas of `PORTAL_TEST_DATABASE_URL` and are skipped without it.
- **Stoa rules** are pure modules tested on their own: `can()` across every visibility, access and kind of person,
  including the refused `private` combinations; leases and hosts, including concurrent entries that must never exceed
  capacity and must produce exactly one host; decoration rules; channel names and keys, which change with the epoch and
  can't be derived without the secret; map parsing and paths; and theme validation.
- **The spaces service and HTTP routes** are tested on a real store with a controlled clock: hidden private spaces answer
  every operation exactly like missing ones, Signaling tokens list only the channels a person may use, call tokens need a
  lease, removal blocks the person and renames hidden channels, a full plaza answers with an offer, and missing
  Signaling or call settings are reported plainly.
- **Browser modules** are tested with stand-ins for the Agora SDKs: encryption round trips, presence handling, the
  receiver rules, message limits, stage transitions, the panel, the decor editor, the RTC client and the call tiles.
- **Opt-in suites** run against the real Auth: `npm run test:e2e`, and real Chromium through `scripts/browser-smoke.mjs`
  (sign-in, including the quiet check on Stoa pages) and `scripts/browser-smoke-integrations.mjs`.
- **Manual checks** cover what the suites can't: real Agora Signaling and RTC with two signed-in browsers and a visitor
  (the plaza, a lot entered from both sides, a private space with an invitation, a call, decorating, hand-over and
  removal, a closed tab and a duplicate tab), desktop and mobile widths, keyboard-only use, a screen reader through the
  panel, reduced motion and theme switching.

How to run them: [Verification](../README.md#verification) and [Verification](platform.md#verification).

## Roadmap

Planned work, grouped by area. Integrations work (Discord, the assistant voice pipeline, Station AI, the Station side of
D28, the Astation inbox) is listed in [integrations.md](integrations.md).

**The Stoa**

- [Not built] Team messages and DMs over Agora Chat, with the Messages drawer and the call's chat button; choose the
  Chat username scheme for `ab…` IDs and add the pre-commit hook it needs ([§3.10](#310-team-messages-and-dms-agora-chat)).
- [Not built] Profile cards in the Stoa, with Message, View profile and Invite to my space, and server-checked names on
  the live layer ([§3.14](#314-discovery-hooks)).
- [Partly built] Noticeboard results ([§3.14](#314-discovery-hooks)).
- [Partly built] "Live now" rooms on the people search page ([§3.14](#314-discovery-hooks)).
- [Not built] Stoa entries in the public activity feed ([§3.14](#314-discovery-hooks)).
- [Not built] Topic tags chosen from the profile skill vocabulary, and tags on the plaza door signs
  ([§3.14](#314-discovery-hooks)).
- [Not built] Admins choosing the plaza's theme ([§3.12](#312-world-engine-maps-and-themes)).
- [Not built] An avatar character editor and profile photos on avatars ([§3.12](#312-world-engine-maps-and-themes)).

**Scale** ([§3.16](#316-scale))

- [Not built] Leases out of the single state document, or batched heartbeats.
- [Not built] Area cells on separate channels with a bigger map, or plaza copies, for crowds over a few hundred.
- [Not built] Spaces rate limits keyed by person rather than address.
- [Not built] Proximity audio.
- [Not built] A cached static tile layer to cut the draw cost.

**Agora**

- Open: ask Agora whether per-channel Signaling permissions (`Rtm2Permissions`) can be enabled for the project; if so,
  `AGORA_RTM_PERMISSIONS=true` [Built, off] adds them as extra protection ([§3.9](#39-live-presence-movement-and-messages-agora-signaling)).

**Product**

- [Not built] The discovery engine: one search and matching layer across people, projects, offers, live rooms and
  events, with a connection graph. It comes before Pnyx and Odeon ([§1](#1-purpose-and-product-model)).
- [Not built] Events: scheduling, venue partners, RSVPs, and hybrid events where an offline venue's live stream enters
  the virtual world. Free community events go to Pnyx, premium ticketed ones to Odeon.
- [Not built] Pnyx, stage and audience, with subscriber-only call tokens for the audience
  ([§1.2](#12-spaces-type-world-and-theme)).
- [Not built] Odeon, premium and ticketed experiences, possibly with a WebGL renderer
  ([§1.2](#12-spaces-type-world-and-theme)).
- [Not built] Custom themes from users and communities: image roles, sanitising or rasterising SVG before any upload is
  allowed, and clearing the previous theme's page tokens when switching ([§3.12](#312-world-engine-maps-and-themes)).
- Not designed yet: plaza-wide calls and history for public or room messages were left out of the Stoa on purpose.

**Accounts and administration**

- [Not built] D27: `PLATFORM_ADMINS`, `grant-credits` and `assign-role` move behind the admin site's audited API, and
  `import-json` goes once it has run everywhere ([§2.6](#26-platform-admins-in-the-portal),
  [§5.3](#53-operator-commands)).
- Other teams' work the Portal is ready for: Vox signing in through Auth and charging through the billing API
  ([§5.2](#52-credits-and-the-ledger)), and Apple and Agora sign-in on Auth's roadmap.
