# Agora Build: The Builder's Foundry

A boundaryless community workspace for builders of real-time communication, voice AI, and developer tools. Build together in a persistent digital foundry; meet in person for demo days, hackathons, and whiteboard sessions, then bring the work back online. A floating navigation bar opens onto a warm canvas with a terminal search, tactile project and profile cards, and a sourced public activity log. Discover people through their work and real intent, explore projects, meet in groups, and use shared services.

## Run the house

Requires Node.js 20.12 or newer. Install the pinned Agora SDK, OAuth, PostgreSQL, and Stripe dependencies first.

```sh
npm ci
npm run dev
# Listens on 0.0.0.0:3002. BoTUBE can continue using port 3000.
npm run dev -- --port 4173
npm test
npm run build
npm run preview
```

To deploy, copy `dist/` to a Node host, run `npm ci --omit=dev`, and run `node scripts/serve.mjs` inside it. Configure `HOST` and `PORT` as needed. The app requires its Node API server; static hosting cannot provide profiles, rooms, or model services. Google Fonts are optional; fallback fonts work offline.

### Docker

Every push to `main` publishes `ghcr.io/agora-build/portal:latest` and `:<sha>`. A `v*` tag (such as `v1.2.0`) publishes `:1.2.0` and `:1.2` too. Pull requests run the tests and build and smoke-test the image without publishing it.

```sh
docker build -t portal .
docker run -p 3002:3002 --env-file .env -v portal-data:/app/.data portal
```

Without `DATABASE_URL`, state is stored in `/app/.data`. Mount a volume there so it survives restarts.

## Pages and data

- `index.html` / `people.js`: people discovery, skills, natural-language search, and public profiles.
- `activity.js` / `scripts/activity.mjs`: public GitHub events and actual community actions, with timestamps and source links.
- `explore.html` / `explore.js`: 16 verified GitHub projects, categories, search, and sorting.
- `stoa.html` / `stoa.js` / `stoa/` / `world/`: the Stoa — a walkable plaza with first-come rooms and your own spaces, live presence and messages over Agora Signaling, and calls over Agora RTC.
- `radar.html` / `radar.js`: intent-driven web research with source links and reasons.
- `services.html` / `services.js`: language-model and text-to-speech playgrounds, plus verified offers.
- `account.html` / `account.js`: shared identity, credits, membership plans, purchases, and Agora Console connections.

The portal now owns the shared account, credit ledger, and subscription platform.
See [platform setup and integration](docs/platform.md) for application registration,
the server-side client, PostgreSQL storage, Stripe subscription/credit purchases,
and encrypted Agora resources. Vox and Astation integration is the next phase;
their current accounts, balances, and subscription state are not changed here.

Shared navigation, dialogs, sign-in, and browser sessions live in `script.js`; styling lives in `styles.css`. The backend uses built-in Node modules in `scripts/serve.mjs`, `store.mjs`, `models.mjs`, and `activity.mjs`; `calls.mjs` uses the official Agora token builder, and `auth.mjs` uses `openid-client` and `jose`. The browser SDK is served locally at `/assets/agora-rtc.js` and loaded only when someone joins a call.

`data/people.json` contains a public GitHub contributor snapshot. GitHub checks on October 4, 2026 found one human contributor across all 16 public Agora-Build repositories. Public contributors are labeled separately from people who join the house; their intent and willingness to collaborate are not inferred. Project facts live in `data/projects.json`; refresh descriptions, activity, and directory markup together.

## Public activity

The homepage polls `/api/activity` every minute while visible. The server reads public Agora-Build GitHub events at most once every two minutes, shares concurrent requests, uses ETags, and backs off on rate limits. The feed includes real pushes, pull requests, issues, and releases from repositories in the project directory. GitHub can delay event delivery; timestamps show when actions happened, not when they were fetched. `data/activity.json` is a dated GitHub snapshot used when live sync is unavailable, with that state labeled explicitly.

Joining the foundry and changing an intent also produce public activity entries. Activity from legacy meeting rooms may remain in the feed. Profile removal clears the member's activity and references to their deleted rooms. Activity indicates public work and participation in the directory; it does not imply that someone is online or currently on a call.

## Profiles and ownership

Joining requires a name, bio, skills, a public contact link, and a real intent. Profiles are public. Sign-in creates a private account first; nothing is published until the person supplies their intent and saves a profile. Returning to the same provider identity on another device restores the same profile, room ownership, and private radar.

The sign-in dialog supports Google and GitHub OAuth, Sign in with Apple, and a configurable Agora OIDC identity service. Members can explicitly connect another provider to the same account. Signing in with a new provider whose verified email already belongs to an account does not create a second account: the browser is asked to sign in once with that account's existing login and then to confirm the connection, or to create a separate account instead. Unverified emails never match, and two accounts that already share an email are not merged. See [the platform guide](docs/platform.md) for the details. An existing browser-only profile can connect a login while preserving its ID and rooms; its old browser token is then invalidated. Accounts are never merged by email alone. Provider subjects and session hashes stay private. Account sessions last 30 days and logout revokes the current session. Removing a public profile also removes its radar and owned rooms, while the private login account remains available to start a new profile.

Browser-only participation is still available. Its editing access belongs to that browser until a login is connected; clearing the cookie loses access. Public GitHub contributor snapshots are not authenticated accounts.

Profiles, rooms, accounts, credits, billing, and private radar persist in PostgreSQL when `DATABASE_URL` is set, or `.data/community.json` for local development. Protect and back up this state. Deleting a profile removes its radar, rooms it created, and its entries on other room rosters, while preserving its private account and purchases. Public profile text may be sent to the model for directory search; disclose only information you intend to share.

## Connect sign-in providers

Set `SITE_URL` to the public HTTPS origin, such as `https://agora.build`. Google and GitHub can also use `http://localhost:3002` during development. Register the exact callback URLs below; credentials stay in the server's `.env`. Behind a proxy, preserve the public Host header. The configured HTTPS origin enables Secure cookies even when Node receives HTTP from the proxy.

| Provider | Callback Path | Server Configuration |
| --- | --- | --- |
| Google | `/auth/google/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub | `/auth/github/callback` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Apple | `/auth/apple/callback` | `APPLE_CLIENT_ID` (Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_FILE` |
| Agora Identity | `/auth/agora/callback` | `AGORA_OIDC_ISSUER`, `AGORA_OIDC_CLIENT_ID`, `AGORA_OIDC_CLIENT_SECRET` |

Google and OIDC identity tokens are verified for signature, issuer, audience, expiry, and nonce. GitHub identities come from its authenticated `/user` API; a GitHub email counts only when `/user/emails` marks it primary and verified, and Google or Apple emails only when the token says `email_verified`. Flows use one-use browser-bound state, and PKCE where supported. Apple's name/email scope requires a `form_post` callback; its transaction cookie uses SameSite=None and Secure, and the server generates a short-lived client secret from the `.p8` key. Keep that private key outside the repository and deployment output. Apple requires a registered HTTPS domain and return URL; localhost does not work for it.

Agora RTC App IDs and certificates authorize media channels, not account login. Use a registered Agora OIDC service or the existing Agora OAuth flow described in [the platform guide](docs/platform.md#agora-console-connections). Existing OAuth must provide a verified permanent user ID before it can create a portal user; callback login IDs and emails cannot replace it. Without configuration, each provider is visibly unavailable and browser-only participation continues to work. OAuth transactions last ten minutes and are held in process memory; use one Node process or sticky routing, and restart an interrupted sign-in if the server restarts.

Provider references: [Google OpenID metadata](https://accounts.google.com/.well-known/openid-configuration), [GitHub OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), and [Apple OpenID metadata](https://appleid.apple.com/.well-known/openid-configuration).

## Connect models and web research

Copy `.env.example` to `.env`, configure provider variables, and restart the server. Keep keys server-side and out of Git.

- `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`: OpenAI-compatible chat completions with strict JSON-schema output. A local compatible endpoint can work without a key.
- `TTS_BASE_URL`, `TTS_MODEL`, `TTS_API_KEY`: speech generation through `/audio/speech`.
- `RADAR_BASE_URL`, `RADAR_MODEL`, `RADAR_API_KEY`: Responses API with the `web_search` tool. A generic chat endpoint alone cannot provide sourced radar results.
- `OPENAI_API_KEY`: may configure all three services instead of separate keys.

With no provider configured, people search uses explicit keyword matching and playgrounds show unavailable status. Configuration indicates readiness, not a completed provider health check. Upstream failures appear as errors; no simulated answers are published.

Radar runs manually or, for members who explicitly enable monitoring, checks every 15 minutes for scans due at `RADAR_INTERVAL_HOURS` (default 24). It sends intent and interests to the configured provider, persists results privately, and publishes only source URLs retrieved or cited by web search. Changing intent clears prior results. It never contacts anyone on a member's behalf. Monitoring requires a running server.

Shared inference is limited to six calls per minute per client IP and `MODEL_REQUESTS_PER_HOUR` per house (default 60); automated radar uses the same hourly allowance. Chat and speech require a house profile. Review allowances against your provider budget before connecting it.

## Agora group calls

Create an Agora project with App Certificate authentication enabled. Set `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE` in the server's `.env` and restart. Both must be 32-character hexadecimal values. The certificate stays on the server; signed-in people receive short-lived, channel-specific AccessToken2 credentials from `POST /api/spaces/<id>/rtc-token`, and only while they are currently in that room. `AGORA_TOKEN_TTL_SECONDS` defaults to 3600 and is bounded to 60–3600 seconds. The SDK renews credentials before they expire; renewals require the same browser profile and current presence in the room.

Calls happen inside the Stoa's lot rooms and your own spaces. Video layouts follow the theme: over avatars (Agora), a strip (Cyberpunk), or a grid (Minimal). Members choose whether to enable devices, toggle microphone/camera, share a screen, and leave the call. Screen sharing uses a separate Agora publisher so it can run alongside the camera; browser support determines whether screen audio is available. Camera, microphone, and screen tracks close on leave and page exit. Separate tabs get distinct media identities.

Old `/meet/<id>` links and `/meetings.html?room=<id>` redirect to `/stoa/s/<id>`, where legacy rooms now live as spaces with the same ids. The `/api/rooms` routes answer `410 Gone`.

Use HTTPS for remote callers, or `http://localhost:3002` for local development. Browsers restrict media devices on plain remote HTTP. No Agora credentials are bundled in the site. Without valid configuration, rooms stay usable and calls show an unavailable state. Leaving a room or removing a profile blocks new tokens and renewal; an already-issued Agora token remains valid until its short expiration.

## Stoa spaces

The Stoa is a walkable plaza (`/stoa/`) with first-come rooms (`/stoa/room/<slug>`) and unlisted or private spaces (`/stoa/s/<id>`). Calls use Agora RTC; movement, presence, and live messages use Agora Signaling. Enable Signaling for the Agora project and set `SPACE_CHANNEL_SECRET` to at least 32 random characters. The built-in maps in `worlds/` are generated by `npm run maps`.

Built-in themes live in `themes/` (Agora, Minimal, Cyberpunk) and are validated at startup. Hosts can hand over hosting, remove people from the room, and decorate it. Signed-in people can start their own spaces (`/stoa/?start=<title>` opens the dialog with a title filled in), invite others with links, manage members, change settings, and delete a space. Free accounts can own up to 3 spaces; premium plans can own up to 20.

Visitors can switch their own view to Minimal; `/stoa/?theme=cyberpunk` previews a theme. Movement works with click or tap and with the arrow keys or WASD; the side panel offers the same actions for keyboard and screen reader users.

## The physical forge

Demo days, hackathons, and whiteboard sessions are core community activities. The homepage offers a session-planning entry point for each. Start a space in the Stoa with your real intent, include a place and time in the session purpose, and share the invite with collaborators. Use the same workspace to prepare online and reconnect after meeting in person. These are planning tools; the site does not advertise invented events, venues, or attendees.

## Community offers

`data/offers.json` starts empty. Add only confirmed offers with `provider`, `title`, `description`, `url`, optional `eligibility`, and optional ISO `expiresAt`. Expired offers are hidden. No discounts are implied before a partnership is confirmed.

## Verification

`npm test` uses the Node test runner with isolated temporary data and mocked providers. It covers public-file restrictions, profiles and ownership, cross-device sign-in, OAuth state/PKCE/JWT verification, Apple's POST callback, safe account linking, session expiry and logout, old meeting-link redirects, persistence, search, sourced research, service limits, Agora token signatures/renewal, provider migration, activity caching/deletion, and production output. For UI changes, check all pages on desktop and mobile, keyboard navigation, reduced motion, dialogs, empty states, filters, sourced activity, provider availability, and two browser sessions entering one room. With configured provider registrations, verify live logins and Agora media, token renewal, and device release on leave.
