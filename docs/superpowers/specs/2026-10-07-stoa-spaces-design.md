# Spaces Foundation And Stoa: Design

Status: under review
Date: 2026-10-07

## Goal

Agora.build should feel like a walkable virtual world, not a meeting-room directory.
This spec delivers the shared Spaces foundation through its first consumer, Stoa:

`Space + World/Map + Presence + RTC + Permissions + Discovery + Invitations + Theme`

- The **space type** defines behavior.
- The **world/map** defines where people can move and interact.
- The **theme** defines how the world looks and feels.

Functionality, permissions, presence, and RTC never depend on the theme.

### Purpose

Agora.build's core is **resource discovery**: helping startups, teams, and individual
builders find the people, projects, offers, and events they need, through good
networking, meaningful connections, and impactful events. Stoa, Pnyx, and Odeon are
the presentation layer where discovery turns into real meetings. Every space feature
should lead toward finding someone or something useful.

### Product model

- **Agora**: the overall virtual world.
- **Stoa** (`/stoa/`): walkable spaces for meeting, talking, and social interaction. This spec.
- **Pnyx** (`/pnyx/`): stage and audience for talks, panels, town halls, and debates. Later spec.
- **Odeon** (`/odeon/`): premium produced experiences, which may include paid admission. Later spec.

### Out of scope

Pnyx, Odeon, uploaded user or community themes, proximity audio, plaza-wide calls,
and history for public or room messages. The design leaves room for the first five;
the portal never stores messages of any kind.

### Roadmap

1. **Spaces foundation and Stoa**, with discovery hooks (this spec)
2. **Discovery engine**: one search and matching layer across people, projects,
   offers, live rooms, and events, including a connection graph
3. **Events**: scheduling, venue partners, RSVPs, and hybrid events where an offline
   venue's live stream enters the virtual world. Free community events go to Pnyx;
   premium ticketed events go to Odeon.
4. **Pnyx**: stage and audience
5. **Odeon**: premium and ticketed experiences
6. **Custom themes**: user and community themes

### Agora services

- **RTC** (Agora Video/Voice SDK): voice, video, and screen sharing inside rooms.
- **Signaling** (Agora RTM 2.x, `agora-rtm-sdk`): movement, live presence, public
  plaza messages, and room messages. These are live only and never kept.
- **Chat** (Agora Chat, `agora-chat` Web SDK and REST API): team messages and direct
  messages (DMs). Agora Chat holds their history under the project's Chat retention
  settings; the portal never stores message content.
- The portal server never relays real-time traffic. It owns spaces, permissions,
  capacity, invitations, and token issuing.

## 1. Domain Model

### Space

```
Space {
  id                      // uuid
  slug?                   // lot rooms only, e.g. "ai-agents"
  type: "stoa"            // later "pnyx" | "odeon"
  worldId, themeId
  visibility: "listed" | "unlisted" | "private"
  access: "open" | "house" | "members"
  capacity                // whole number, enforced on entry
  ownerId?                // absent for system-owned plaza lots
  members[]               // member:<uuid> IDs
  invitations[]           // { tokenHash, expiresAt, usesLeft, createdBy }
  channelEpoch            // increases when someone is removed; renames channels
  lot?: { worldId, lotId }// set only for listed plaza lots
  topic?                  // set by the host
  hostId?                 // current host (section 1, Hosts)
  decor[]                 // { id, kind, x, y, rotation, variant? } placed by the host
  createdAt, updatedAt
}
```

Spaces are persisted in the existing store aggregate (`state.spaces`), so they work
with both `.data/community.json` and PostgreSQL. Entry leases (section 2) are stored
there too, for capacity. Positions and messages are never stored by the portal.

### Visibility and access are independent

Visibility answers "who can learn this space exists":

| Visibility | Plaza and discovery | Reachable by |
| --- | --- | --- |
| `listed` | Rendered on the plaza and returned by `GET /api/spaces` | Anyone |
| `unlisted` | Never rendered or returned | Its direct URL |
| `private` | Never rendered or returned | Members and valid invitation holders only |

Access answers "who can enter":

| Access | Who may enter |
| --- | --- |
| `open` | Any signed-in account |
| `house` | Accounts with a published `member:` profile |
| `members` | The owner, listed members, and valid invitation holders |

Combinations are allowed except `private` + `open`/`house`, which the API rejects:
private means only members and invitations.

An unlisted or private space is not a hidden place on the public map. It is a
separate world. The plaza never renders it, and the plaza never receives its
presence or activity.

### Plaza and lots

The plaza is a system space with the route `/stoa/` and a capacity of **1000**
people walking at once. Guests who only watch do not count.

**When the plaza is full**, a signed-in person who opens `/stoa/` sees the plaza as a
watcher and is offered unlisted spaces instead:

- spaces they own or belong to, and invitations they hold
- **Start a space**: one step creates an unlisted space with the default room map and
  takes them into it, with a link to share. This counts against their space
  entitlement. If they have reached their limit, they are offered their existing
  spaces instead.

The offer stays visible while they watch, and a free place lets them walk in. Lot
rooms have their own capacities: a person inside a lot room does not count toward the
plaza's 1000, and someone with a lot room's URL can enter it while the plaza is full.
If the plaza is still full when they leave the room, they get the same offer.

Plaza walking uses an entry lease like any other space (section 2).

 Its world map defines **lots**:
tables, lounges, discussion areas, and buildings, each with a capacity, a door, and
an interior. Each lot is one standing `listed` + `open` Space, created from the map
at startup and reachable at `/stoa/room/<slug>`.

A lot room is first come, first served. The first person to enter an empty lot
becomes its **host** and is asked for a topic (or may keep the lot's default name).
The topic, the host, the occupant count, and the occupant names are visible from the
plaza. When the last person leaves, the topic, host, and decorations clear and the
lot is free.

### Hosts

Every room and place has one host at a time:

- **Lot rooms**: the first person in becomes the host. When the host leaves, the
  person present longest becomes host, and everyone is told who it is.
- **User-created spaces**: the owner is host whenever present. When the owner is
  absent, the first person present is host until the owner returns.
- The host can pass the role to anyone present. The space owner and platform admins
  can always take it back.
- The current host is recorded with the entry leases (section 2) and changes in the
  same atomic store operation as entries and departures, so there is never more than
  one host.

The host can:

- set and change the topic
- **decorate** the room or place (below)
- remove a disruptive person for the rest of the session. In a lot room the person
  cannot come back until the room empties. In a user-created space removal lasts
  until the owner allows them back; only the owner can change the member list.

### Decorating

The host arranges decorations in the room's interior, or anywhere in a
user-created world.

- Decorations are **semantic kinds**, never artwork: `plant`, `lamp`, `rug`, `sofa`,
  `chair`, `table`, `whiteboard`, `bookshelf`, `screen`, `banner`, `poster`,
  `statue`, `fountain`. The active theme draws each kind, so the same arrangement
  looks Greek in Agora and neon in Cyberpunk. `variant` chooses one of the theme's
  styles for that kind, and themes must map every kind.
- A decor mode turns on for the host. They drag items from a palette, move them,
  rotate them, and remove them, by pointer or keyboard (select an item, arrow keys to
  move, `R` to rotate, `Delete` to remove). The panel lists the placed items for
  screen readers.
- The server checks every change (`PUT /api/spaces/<id>/decor` with the whole
  arrangement):
  - the caller is the host, owner, or an admin
  - each item is a known kind, lies inside the room's area, and does not cover a
    door or spawn tile
  - every door, spawn, and seat stays reachable once items that block movement are
    in place
  - there are at most 60 items
- After a change is saved, the host's client publishes `{ t: "decor", version }` on
  the space's Signaling channel. Other clients then fetch the arrangement from
  `GET /api/spaces/<id>`, so the server's saved copy stays the source of truth.
- Lot room decorations are temporary and clear when the room empties. Decorations in
  user-created spaces are saved and stay until the host changes them.

### User-created spaces

Every user-created Stoa space is its own world at `/stoa/s/<id>`, with visibility
`unlisted` or `private`. It persists until its owner deletes it. Plan entitlements
cap how many spaces an account owns. The default is 3 on Basic and 20 on Premium
(`entitlements(plan).spaces`).

### Worlds and themes

- **World**: a Tiled-compatible JSON map with semantic tile roles and object
  layers. It holds no artwork. See section 4.
- **Theme**: a data-only manifest and assets that give the roles their artwork
  and style the page around the world. It holds no behavior. See section 4.

### Permissions

All authorization flows through one pure function:

```
can(person, action, space, context) -> boolean
actions: see | enter | chat | speak | host | decorate | moderate | edit | invite
context: { invitation?, presence?, hostId? }
```

Every REST handler and every RTC or Signaling token request calls it. Signaling
tokens carry the result as channel permissions (section 2). For Stoa, `speak` is granted to everyone present. The current host holds
`host`, `decorate`, and `moderate` for the session. The owner holds `edit` and `invite`
and can always take the host role back. Platform admins hold everything. Pnyx and Odeon
will add rules for their types without changing callers.

### Migrating existing rooms

Each existing `/meet/<id>` room becomes a Stoa space with the same ID. It is
`unlisted` with access `members`, its owner stays the same, and its current roster
becomes its member list. It uses the default world and theme. `/meet/<id>` answers
with a 308 redirect to `/stoa/s/<id>`. The migration runs once at startup and is
idempotent.

## 2. Real-Time Presence, Movement, And Messages (Agora Signaling)

### Channels

Each space has Signaling message channels. Their names are derived on the server,
and the server only gives them to people allowed to use them:

```
channel(space) = "ab-" + space.type + "-" + hmac(SPACE_CHANNEL_SECRET, space.id + ":" + space.channelEpoch)[0..24]
```

- The plaza has one channel. It carries plaza movement, presence, and public
  messages.
- Each lot room and each user-created space has its own channel.
- Listed lot rooms use a name that anyone may learn. Unlisted and private spaces use
  names that cannot be guessed and are revealed only by the enter response.

### Signaling tokens and protection

Agora Signaling tokens grant **login only**. Any logged-in client can subscribe or
publish to a message channel whose name it knows ([Agora: authentication
workflow](https://docs.agora.io/en/signaling/get-started/authentication-workflow)).
Agora's per-channel permission tokens (`Rtm2Permissions`) are undocumented in the
Signaling guides and "require Agora assistance". This design therefore does not depend
on them. Protection comes from these layers:

1. **Login identity.** `POST /api/signaling/token` returns `{ appId, userId, token,
   expiresAt, channels }`. Signed-in people log in as `a-<uuid>` (their permanent account
   ID; older profile-only sessions use `m-<uuid>`), and guests as a random `g-<id>`. Agora authenticates every publisher's user ID, so
   receivers know who really sent each message.
2. **Channel names that cannot be guessed.** Unlisted and private channel names are
   HMACs of a server secret, the space ID, and `channelEpoch`, with 96 bits of
   randomness. Only the response to a successful entry contains them, and nothing on
   the plaza or in discovery does. Removing someone increases `channelEpoch`, so the
   room moves to a new channel and the removed person cannot follow.
3. **End-to-end payload encryption for unlisted and private spaces.**
   - Every message and every presence state value on these channels is encrypted on
     the client with AES-GCM (WebCrypto).
   - The key is derived on the server per space and per `channelEpoch`, and given only
     to entry-lease holders.
   - Someone who learns a channel name without a lease therefore cannot read
     messages, positions, or names, and their own messages fail to decrypt and are
     dropped.
   - A known remaining exposure: Agora presence can reveal the member IDs subscribed
     to a channel to anyone who knows its name. Only names from the current epoch
     work, and only people who were inside have ever had them.
   - Encryption is done in the portal's own code rather than with the SDK's encryption
     setting. The SDK applies one key to every channel a client uses, but the plaza and
     each room need different keys.
4. **Receiver rules on every channel.** Clients drop messages and ignore presence state
   from `g-` users, from users without presence on that channel, and from people on the
   space's block list. The plaza block list comes with the lot summaries every 10
   seconds (below), and a room's block list comes with its entry response and token
   renewals.
5. **Short tokens.** Tokens last 15 minutes. Renewal re-checks `can()`, the entry
   lease, and account bans, so a banned or removed person's login ends within one
   renewal period.

Guests can therefore watch the plaza, but anything they publish is ignored. If Agora
later confirms per-channel permissions for this project, `AGORA_RTM_PERMISSIONS=true`
adds read and write restrictions to tokens as extra protection. It is off by default,
and nothing above depends on it.

### Presence and movement

- Clients use Signaling **Presence** on each subscribed channel. A person's presence
  state holds `{ x, y, dir, name, avatar }`; `whoNow` gives the initial snapshot,
  and presence events report joins, leaves, and state changes.
- Moving: click or tap chooses a target tile. The client finds a path with A* on the
  map's grid, where decor items that block movement count as blocked tiles and publishes `{ t: "move", path, startedAt }` on the space's channel.
  Every client animates the walk at a fixed speed, and the final tile goes into
  presence state, so late joiners see where people stand.
- Keyboard movement (arrows and WASD) publishes only when a key is pressed or
  released: `{ t: "walk", from, dir, startedAt }` and `{ t: "stop", at }`. Other
  clients work out the steps in between, so holding a key sends no extra messages.
- Message budget: Signaling allows 60 messages per second per client in a message
  channel. Clients publish movement at most 4 times per second and update presence
  state only when someone stops. With 1000 people on the plaza, the expected total is
  well under that. Clients draw and animate only avatars within about two screens of
  their own view, and still list everyone in the panel.
- Large channels: `whoNow` results are read page by page. Clients handle presence
  events arriving one at a time or batched together, since Agora batches them for
  large channels.
- The portal does not validate movement. Receivers drop paths that cross blocked
  tiles or jump too far and use the sender's last presence state instead. Movement is
  cosmetic; access, capacity, and calls are enforced by the server.
- Guests subscribe to the plaza channel only. They have no presence state and are
  never shown.

### Entering and leaving rooms

- Walking onto a lot's door tile in the plaza calls `POST /api/spaces/<lot>/enter`.
  For a user-created world, opening its URL does the same.
- The server checks `can(enter)` and capacity in one atomic store operation and
  records an **entry lease** for the person. The response contains the space's
  channel name, a renewed Signaling token that includes it, and whether the person
  is the host and should set a topic (the first person in a lot room).
- The client unsubscribes from the plaza channel, subscribes to the room channel, and
  switches the camera to the lot's interior, which is part of the same world map.
  Leaving through the door calls `/leave` and returns them to the plaza at the door
  tile.
- Leases last 60 seconds and are renewed by `POST /heartbeat` every 20 seconds while
  the room is open. `navigator.sendBeacon` sends `/leave` when the page closes. An
  expired lease frees the seat. The same account in two tabs holds one lease.
- If the room is full or access is refused, the person stays at the door and sees a
  message.
- When the host's lease ends, the host role passes as described in section 1. When a
  lot room's last lease ends, its topic, host, and decorations clear.

### Plaza view of lot rooms

Plaza clients read lot summaries (topic, host, occupancy, occupant names) from
`GET /api/spaces`. They refresh every 10 seconds and immediately after their own
enter or leave. Summaries come only from listed lots' leases. Nothing about unlisted
or private spaces is ever included.

### Messages

- **Public messages**: published on the plaza channel. They appear as speech bubbles
  above avatars for 8 seconds and in the panel's message list.
- **Room messages**: published on the room's channel and shown in its panel.
- **No history.** Messages exist only for people subscribed when they are sent. The
  portal never stores them, and nothing replays them to late joiners.
- Clients limit messages to 500 characters and 1 per second, with a short burst. They
  also ignore messages over the limit, from `g-` users, or from people without
  presence on the channel.
- Owners and admins can remove a person from a space (`POST .../members` or
  `.../remove`). Removal ends the lease, refuses token renewal, increases
  `channelEpoch`, and makes the client leave the RTC call and Signaling channel.

### Team messages and DMs (Agora Chat)

Signaling covers live, place-based talk. Agora Chat covers conversations that last
beyond a visit.

- **Team**: the people who share a room or group, in listed lot rooms and in
  unlisted or private spaces alike. Each room or space has one Agora Chat group:
  - **Lot rooms (listed)**: the team is whoever is in the room now. The first entry
    creates the group, and people are added when they enter and removed when they
    leave or their lease expires. When the room empties, the group is dissolved and
    its history goes with it, matching the topic, host, and decorations.
  - **User-created spaces (unlisted or private)**: the team is the space's members
    plus anyone currently inside. Members stay in the group whether present or not,
    so the conversation continues between visits. Visitors who are not members are
    added on entry and removed when they leave. The group lasts until the space is
    deleted.
  - The space's owner owns the group. For lot rooms the portal's system account owns
    it, and the current host is made a group admin.
- **DM**: a one-to-one Chat conversation between two signed-in people who have
  published profiles. Profiles and the panel's people list offer **Message**.
- **Identity**: the Chat username is the member ID in lowercase (`m-<uuid>`). The
  server registers it through the Chat REST API the first time the person needs Chat.
  It stores only the returned Chat user UUID on the private account; no password is
  kept.
- **Tokens**: `POST /api/chat/token` returns a short-lived user token
  (`ChatTokenBuilder.buildUserToken`, 1 hour) for the signed-in person. Server REST
  calls use an app token (`ChatTokenBuilder.buildAppToken`), cached until shortly
  before it expires.
- **Membership sync**: the server is the source of truth for every team.
  - Changes to the member list (adding, removing, accepting an invitation, deleting a
    space) call the Chat group APIs in the same request. The change is kept only if
    the Chat call succeeds or Chat is not configured, so a failed sync leaves both
    sides as they were.
  - Entering, leaving, and lease expiry update the group too, but these never block
    entry. Failed calls go into a retry queue in the store, retried every 15 seconds.
    The same 15-second sweeper ends expired leases, hands over the host role, and
    clears empty lot rooms.
  - Groups are private and members cannot invite through Chat. Invitations always go
    through the portal and `can(invite)`.
- **Blocking**: a person can block another person in Chat, which stops DMs from them.
  Deleting a profile removes the Chat user, which deletes their DMs and group
  memberships at Agora.
- **Interface**: a Messages drawer, available on every Stoa page and from the account
  page. It lists the person's DMs and their spaces' team conversations, with unread
  counts. It is plain HTML outside the canvas and does not depend on the theme.
- **Configuration**: `AGORA_CHAT_APP_KEY` (`org#app`) and `AGORA_CHAT_REST_HOST`.
  Chat reuses `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE` for tokens. If these are not
  set, Messages is hidden and team membership still works without a Chat group.

### Scaling

The server holds no real-time state: leases live in the store, and Signaling carries
all live traffic. More than one portal instance can therefore run behind a load
balancer once OAuth transactions move out of memory, which is unrelated to this spec.
Presence state already includes position, so proximity audio can later choose which
nearby people's RTC streams each client receives.

## 3. RTC

- Calls use Agora RTC. `calls.issue(room, person)` becomes `rtc.issue(space, person, role)`,
  used by `POST /api/spaces/<id>/rtc-token`.
- The server issues a token only to a person who holds a current entry lease for the
  space. Being on a roster or member list is not enough.
- The role comes from `can()`. In Stoa everyone present publishes. Pnyx will issue
  subscriber-only tokens to its audience.
- The channel name is `agora-build-space-<id>`. Existing user IDs, screen-share IDs,
  and the per-tab identity scheme stay as they are.
- After someone leaves or is removed, renewal is refused. Tokens stay short-lived
  (one hour at most), so access ends when the token expires. When the client learns it
  was removed (a refused heartbeat or renewal), it leaves the channel at once.
- The plaza has no call in v1. Calls happen inside rooms.
- `call.js` is split into `rtc-client.js` (joining, devices, publishing, screen
  share, and token renewal, with no UI) and a presentation layer. The theme decides
  where video appears: over avatars or seats, in a strip, or in a grid.
- Call controls (microphone, camera, screen share, leave, chat) are native buttons
  outside the canvas and look the same whatever the theme. Devices stay off until
  the person chooses to join; joining to listen remains possible.

## 4. World Engine And Themes

```
Map (worlds/<id>/map.json) -> Engine (world/*.js) -> Theme (themes/<id>/theme.json + assets)
semantic layout               movement, camera, input  art and styling only
```

### Maps

Maps use a subset of Tiled JSON: orthogonal, fixed tile size, uncompressed tile
layers, and object layers.

- The tile layers `ground` and `structure` use tiles whose `role` property is one of
  the core roles: `floor`, `path`, `grass`, `water`, `wall`, `column`, `door`,
  `table`, `seat`, `plant`, `decor`. Walkability comes from the role (`wall`,
  `column`, `water`, `table`, `plant` block movement); a tile may override it.
- Object layers:
  - `lot`: a rectangle with `lotId`, `slug`, `title`, `capacity`, `door` (tile), and
    `interior` (a rectangle in the same map)
  - `spawn`: where people appear
  - `zone`: a named area, kept for future proximity features
  - `interactable`: an object with a kind and a label
- The server loads the same file to know lots, doors, and capacities. The client
  receives it from `GET /api/worlds/<id>` and uses it for walkability and paths.
- v1 ships two maps:
  - `plaza`: the public plaza, with about six lots of varied sizes
  - `room`: the default map for user-created spaces, a single interior with seating

### Themes

A theme is data only and never contains code, so community themes can be added later
without running their authors' scripts.

```
themes/<id>/theme.json
{
  id, name, version,
  roles: { floor: {...}, wall: {...}, ... },   // image or primitive per core role
  avatar: { style, palette },                  // how people are drawn
  decor: { plant: { variants: [...] }, lamp: {...}, ... },  // art for every decor kind
  ui: { "--paper": "...", "--ink": "...", "--font-display": "..." },  // CSS tokens
  lighting: { ambient, tint },
  effects: ["dust" | "rain" | "leaves" | "neon-glow" ...],  // fixed safe catalog
  video: "over-avatar" | "strip" | "grid"
}
```

- `validateTheme()` runs at startup and in tests. Every core role and decor kind must be mapped,
  asset paths must stay inside the theme's folder, only `png`, `webp`, and `svg` files
  are allowed, the bundle has a size limit, and `ui` accepts only CSS tokens from an
  allowlist.
- Built-in themes are reviewed source files. Before uploaded themes are allowed, SVG
  needs sanitizing or rasterizing; that belongs to the later custom-themes spec.
- An owner chooses a theme for their space, and admins choose the plaza theme. A
  viewer can switch their own display to Minimal for accessibility or performance;
  this changes nothing for anyone else.
- v1 ships three built-in themes, with art drawn in code or as local SVG and no
  external assets:
  - **Agora** (default): marble, colonnades, and terracotta, matching the current
    palette
  - **Minimal**: flat and high contrast
  - **Cyberpunk**: dark, neon, rain

### Engine

- Uses Canvas 2D, scaled for high-resolution screens, with a camera that follows the
  person's own avatar.
- Supports click or tap to move and arrow/WASD keys. It draws a frame only while
  something is moving or animating.
- Under `prefers-reduced-motion`, ambient effects are off and walks still move
  without decorative motion.
- Rendering goes through a `Renderer` interface, so a WebGL renderer for Odeon can
  replace it later without changing spaces, presence, or RTC.
- Files: `world/engine.js` (loop, camera, input), `world/map.js` (parsing, walkability,
  A*), `world/renderer-canvas.js`, `world/themes.js` (loading and applying themes), and
  `world/signaling.js` (Signaling login, channels, presence, renewal). `map.js` is
  shared with the server.

### Accessibility layer

A DOM panel beside the canvas lists:

- rooms (topic, occupancy, and a **Go to** button that walks there and enters)
- people present
- chat, with a form

A live region announces arrivals, departures, and entry errors. Everything the canvas
offers is available through the panel with keyboard and screen readers. If the canvas
fails, the panel still works.

## 4a. Discovery Hooks

Stoa v1 connects the world to the discovery that already exists (people search with
intent, projects, offers, Radar). The full discovery engine has its own spec.

- **Profile cards.** Selecting an avatar, on the canvas or in the panel's people list,
  opens a card from the person's published profile: name, intent ("building"),
  `lookingFor` ("needs"), skills, and projects. The card offers:
  - **Message**: an Agora Chat DM
  - **View profile**
  - **Invite to my space**: an invitation to one of the person's own spaces

  Guests see the card without these actions. People without a published profile
  appear by display name only, with no card.
- **Topic tags.** When a host sets a topic, they can add up to 5 tags (skills,
  needs, or a project), chosen from the profile skill vocabulary or typed freely and
  normalized. Tags appear on the room's plaza sign and in its lot summary.
- **Noticeboards.** `interactable` objects of kind `noticeboard` on the plaza open a
  panel of discovery results. Each board has a fixed query in the map, such as
  "Looking for collaborators", "Voice AI", or "Offers".
  - Results come from the existing people, project, and offer data, ranked by match
    with the viewer's own skills and needs when they have a profile.
  - A result's **Go to** button walks to a live room when one matches.
  - The themes draw the boards, which are a decor-style kind (`noticeboard`) that
    every theme must map.
- **Live rooms in search.** `GET /api/spaces?q=` matches listed lot rooms by topic and
  tags. The people search page shows "Live now" rooms next to people results, with a
  link to `/stoa/room/<slug>`. Unlisted and private spaces are never searchable.
- **Activity.** "Opened a room about <topic>" and "joined <topic>" appear in the
  existing activity feed for listed rooms only, using the existing privacy cleanup.

## 5. Routes, API, Errors, And Testing

### Pages

| Route | Behavior |
| --- | --- |
| `/stoa/` | Plaza. Guests watch; signed-in people walk. |
| `/stoa/room/<slug>` | Plaza, starting at that lot's door |
| `/stoa/s/<id>` | User-created world; `?invite=<token>` accepts an invitation |
| `/meet/<id>` | 308 redirect to `/stoa/s/<id>` |

All Stoa pages are served by `stoa.html`. When a person may not see a private space,
the server returns the same 404 as for a space that does not exist, and never reveals
its title. The site navigation's "Rooms" link becomes "Stoa".

### API

| Method and path | Purpose |
| --- | --- |
| `GET /api/spaces` | Listed spaces only, with topic, tags, and occupancy; `?q=` searches topic and tags |
| `GET /api/noticeboards/<id>` | Results for a plaza noticeboard's query |
| `POST /api/spaces` | Create an unlisted or private space (subject to entitlement) |
| `GET/PATCH/DELETE /api/spaces/<id>` | Read (`see`), edit (`edit`), delete (owner) |
| `POST /api/signaling/token` | Signaling token and channel names (guest or member) |
| `POST /api/chat/token` | Agora Chat user token (registers the Chat user on first use) |
| `POST /api/spaces/<id>/enter`, `/leave`, `/heartbeat` | Entry lease, with an atomic capacity check |
| `POST /api/spaces/<id>/topic` | Set the topic (`host`) |
| `POST /api/spaces/<id>/host` | Hand the host role to someone present (`host`), or take it back (owner) |
| `PUT /api/spaces/<id>/decor` | Replace the decoration arrangement (`decorate`) |
| `POST /api/spaces/<id>/remove` | Remove a person for the session (`moderate`) |
| `POST /api/spaces/<id>/rtc-token` | RTC token for a lease holder |
| `POST /api/spaces/<id>/invitations` | Expiring invitation with limited uses (`invite`) |
| `POST /api/spaces/<id>/members`, `DELETE .../members/<memberId>` | Membership (`moderate`) |
| `GET /api/worlds/<id>` | Map JSON |
| `GET /api/themes` | Built-in theme manifests |

Invitation tokens are random, shown once, and stored only as hashes.

### Errors

Errors use the existing `AppError` and keep the friendly tone:

| Situation | Status |
| --- | --- |
| Room is full | 409 |
| No access to a space the person may see | 403 |
| Space does not exist, or the person may not see it | 404 |
| Too many requests | 429 |
| RTC, Signaling, or Chat not configured | 503 |

When Signaling reconnects, the client calls `whoNow` again and redraws from that
snapshot. If Signaling is unavailable, the panel still lets people enter rooms and
join calls; movement and messages pause with a visible notice.

### Testing (Node test runner)

- Permissions: `can()` across every visibility, access, and person type (guest,
  account, published profile, member, invitation holder, owner, admin), including
  the rejected `private` + `open`/`house` combination.
- Private isolation: `GET /api/spaces`, lot summaries, and guest or plaza tokens
  never contain unlisted or private IDs, titles, occupants, or channel names. A
  private space returns the same 404 as a missing one.
- Signaling protection: channel names and encryption keys for unlisted and private
  spaces appear only in entry responses for lease holders. Both change when
  `channelEpoch` increases and cannot be derived without the server secret. Renewal is
  refused after leaving, removal, or a ban.
- Receiver rules (client module): drops messages that are from `g-` users, from
  publishers without presence, or from blocked people, and messages that do not
  decrypt. Encrypted payloads round-trip, and the wrong epoch's key fails.
- Plaza capacity: the 1001st walker is refused and offered their spaces,
  invitations, and Start a space, which honors the space entitlement. People in lot
  rooms do not count toward the plaza, and a lot room's URL still works while the
  plaza is full.
- Capacity: concurrent `enter` requests never exceed capacity. Expired leases free
  seats, and a lot room's topic, host, and decorations clear when it empties.
- Hosts: the first person into a lot becomes host. When the host leaves, the person
  present longest becomes host. Concurrent entries produce exactly one host. The
  owner is host whenever present and can take the role back. Only the host, owner, or
  an admin can set the topic, decorate, or remove people.
- Decor: unknown kinds, items outside the room, items covering doors or spawn tiles,
  arrangements that cut off a door, spawn, or seat, and more than 60 items are all
  rejected. Lot decorations clear when the room empties; user-space decorations are
  saved.
- Movement (client modules): A* avoids blocked tiles, and receivers reject paths
  that cross blocked tiles or jump too far.
- Themes: every built-in theme passes `validateTheme()` and maps every core role and decor kind. A
  bad path (`../`), a forbidden file type, a missing role, or a CSS token outside the
  allowlist is rejected.
- Maps: the plaza's lots have reachable doors and interiors, and the spawn point is
  walkable.
- RTC: a token is issued only to a lease holder, and renewal fails after leaving or
  removal.
- Invitations: tokens expire, uses are counted, and tokens are stored hashed.
- Messages: the server has no endpoint or storage for message content.
- Discovery hooks: profile cards expose only published profile fields. Topic tags are
  limited to 5 and normalized. Noticeboard results rank by viewer match and never
  include unlisted or private spaces. `GET /api/spaces?q=` matches topics and tags of
  listed rooms only. Activity entries are created only for listed rooms.
- Chat teams (with a fake Chat REST client):
  - Lot rooms: the first entry creates the group, people are added on entry and
    removed on leave or expiry, the room emptying dissolves the group, and the host
    becomes group admin.
  - User-created spaces: members stay in the group while away, and visitors are added
    on entry and removed on leave.
  - A failed member-list sync leaves portal membership unchanged. A failed sync on
    entry or leave is queued and retried without blocking entry. Chat usernames are lowercase member IDs, and Chat tokens go only to the
  signed-in person.
- Migration: meeting rooms become `unlisted`/`members` spaces with their rosters, the
  migration is idempotent, and `/meet/<id>` redirects.
- Manual checks: desktop and mobile widths, keyboard-only use, screen reader through
  the panel, reduced motion, theme switching, two browsers walking the plaza, and
  entering a lot from both sides. Repeat with real Agora RTC, Signaling, and Chat credentials, including a DM and a
team conversation between two accounts.

## Decisions And Open Questions

Decided:

- Plaza capacity is 1000 people walking at once. When it is full, people are offered
  unlisted spaces (section 1).
- A team is everyone who shares a room or group, in listed and unlisted spaces alike
  (section 2, Agora Chat).
- The first person in a room becomes host and can decorate it (section 1).
- Live movement, presence, and public and room messages use Signaling and are never
  stored. Team messages and DMs use Agora Chat.
- A lot host's removal lasts until the room empties.
- 13 decor kinds, with at most 60 items per space.
- User-created spaces: 3 on Basic and 20 on Premium.
- Resource discovery is the core purpose. Stoa v1 includes discovery hooks (section
  4a). The discovery engine and Events come next, before Pnyx and Odeon.
- Avatars: a theme-drawn character in the person's own color, showing their profile
  photo or initials. A character editor comes later.

Open:

1. Optional: ask Agora whether per-channel Signaling permissions (`Rtm2Permissions`)
   can be enabled for the project. Nothing depends on the answer. If yes,
   `AGORA_RTM_PERMISSIONS=true` adds extra protection.
