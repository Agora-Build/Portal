# Agora Build: The Builder's Foundry

A boundaryless community workspace for builders of real-time communication, voice AI, and developer tools. Build together in a persistent digital foundry; meet in person for demo days, hackathons, and whiteboard sessions, then bring the work back online. A floating navigation bar opens onto a warm canvas with a terminal search, tactile project and profile cards, and a sourced public activity log. Discover people through their work and real intent, explore projects, meet in groups, and use shared services.

## Run the house

Requires Node.js 20.12 or newer. Install the pinned Agora SDK, OpenID Connect, PostgreSQL, and Stripe dependencies first.

```sh
npm ci
npm run dev
# Listens on 0.0.0.0:3002. BoTUBE can continue using port 3000.
npm run dev -- --port 4173
npm test
npm run build
npm run preview
npm run test:e2e        # against a real auth.agora.build; see docs/platform.md#verification
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

Each page is served at a clean address ending in `/`: `/` (home), `/explore/`, `/stoa/`, `/radar/`, `/services/` and `/account/`, from the matching `<name>.html`. `/<name>` and the old `/<name>.html` redirect there with `308`, keeping the query string; other names stay `404`.

- `index.html` / `people.js`: people discovery, skills, natural-language search, and public profiles.
- `activity.js` / `scripts/activity.mjs`: public GitHub events and actual community actions, with timestamps and source links.
- `explore.html` / `explore.js`: 16 verified GitHub projects, categories, search, and sorting.
- `stoa.html` / `stoa.js` / `stoa/` / `world/`: the Stoa — a walkable plaza with first-come rooms and your own spaces, live presence and messages over Agora Signaling, and calls over Agora RTC.
- `radar.html` / `radar.js`: intent-driven web research with source links and reasons.
- `services.html` / `services.js`: language-model and text-to-speech playgrounds, plus verified offers.
- `account.html` / `account.js`: shared identity, credits, membership plans, purchases, and Agora Console connections.

Sign-in comes from auth.agora.build; the portal owns the account's credit ledger,
subscription, and Agora Console connection. See [platform setup and integration](docs/platform.md)
for the IdP registration, the API contract for apps (IdP access tokens, scopes,
billing clients), PostgreSQL storage, Stripe subscription/credit purchases, and
encrypted Agora resources. Moving Vox and Astation onto the IdP is their teams'
next phase; their current accounts, balances, and subscription state are not changed here.

Shared navigation, dialogs, sign-in, and browser sessions live in `script.js`; styling lives in `styles.css`. The backend uses built-in Node modules in `scripts/serve.mjs`, `store.mjs`, `models.mjs`, and `activity.mjs`; `calls.mjs` uses the official Agora token builder, and `idp.mjs` (the auth.agora.build client) uses `openid-client` and `jose`. The browser SDK is served locally at `/assets/agora-rtc.js` and loaded only when someone joins a call.

`data/people.json` contains a public GitHub contributor snapshot. GitHub checks on October 4, 2026 found one human contributor across all 16 public Agora-Build repositories. Public contributors are labeled separately from people who join the house; their intent and willingness to collaborate are not inferred. Project facts live in `data/projects.json`; refresh descriptions, activity, and directory markup together.

## Public activity

The homepage polls `/api/activity` every minute while visible. The server reads public Agora-Build GitHub events at most once every two minutes, shares concurrent requests, uses ETags, and backs off on rate limits. The feed includes real pushes, pull requests, issues, and releases from repositories in the project directory. GitHub can delay event delivery; timestamps show when actions happened, not when they were fetched. `data/activity.json` is a dated GitHub snapshot used when live sync is unavailable, with that state labeled explicitly.

Joining the foundry and changing an intent also produce public activity entries. Activity from legacy meeting rooms may remain in the feed. Profile removal clears the member's activity and references to their deleted rooms. Activity indicates public work and participation in the directory; it does not imply that someone is online or currently on a call.

## Profiles and ownership

Joining requires a name, bio, skills, a public contact link, and a real intent. Profiles are public. Signing in creates a private account first; nothing is published until the person supplies their intent and saves a profile. Signing in with the same Agora Build account on another device restores the same profile, space ownership, and private radar.

Every "Sign in" link goes straight to auth.agora.build (`/auth/login?returnTo=<this page>`), one step with no dialog in between. Signed out, the account page shows the sign-in section inline, with "Continue with this browser" for a browser-only profile; the header's "Take a seat" and the Stoa's "Sign in to walk and talk" send visitors there (`/account/?returnTo=<this page>`), and a browser-only profile saved there returns to that same-site page. GitHub, Google, and any later logins are chosen there, and linked logins, devices, and "sign out everywhere" are managed on the IdP's account page ("Manage sign-in"). The account ID is the IdP's `acct_…` ID, the same in every Agora Build app. A browser-only profile that signs in is kept by its account when the account has none yet. Account sessions last 30 days; signing out ends both the portal session and the IdP session, and the IdP's back-channel logout ends portal sessions too. Emails and session hashes stay private. Removing a public profile also removes its radar and owned spaces, while the private account remains available to start a new profile.

"Continue with this browser" is still available for looking around: walking the Stoa, appearing on the radar, and keeping a public profile. Its editing access belongs to that browser; clearing the cookie loses access. Credits, services, billing, Agora Console, and owning spaces need a signed-in account. Public GitHub contributor snapshots are not authenticated accounts.

Profiles, rooms, accounts, credits, billing, and private radar persist in PostgreSQL when `DATABASE_URL` is set, or `.data/community.json` for local development. Protect and back up this state. Deleting a profile removes its radar, rooms it created, and its entries on other room rosters, while preserving its private account and purchases. Public profile text may be sent to the model for directory search; disclose only information you intend to share.

## Connect sign-in

Set `SITE_URL` to the public HTTPS origin, such as `https://agora.build` (or `http://localhost:3002` in development), and register the portal as the `portal` client of auth.agora.build. Behind a proxy, preserve the public Host header. The configured HTTPS origin enables Secure `__Host-` cookies even when Node receives HTTP from the proxy.

| Identity provider | Paths on `SITE_URL` registered at the IdP | Server configuration |
| --- | --- | --- |
| auth.agora.build | redirect `/auth/callback`, post-logout `/`, back-channel logout `/auth/backchannel-logout` | `AUTH_ISSUER`, `PORTAL_CLIENT_ID` (default `portal`), `PORTAL_CLIENT_SECRET`, optional `PORTAL_API_AUDIENCE` (default `https://api.agora.build`) |

The IdP's clients file holds the same secret through `secretEnv: "PORTAL_CLIENT_SECRET"`; the registration block is in [the platform guide](docs/platform.md#idp-registration). The portal no longer reads `GOOGLE_*`, `GITHUB_*`, `APPLE_*`, `AGORA_OIDC_*`, `IDENTITY_CLIENTS_FILE`, `VOX_IDENTITY_*`, or `ASTATION_IDENTITY_ENABLED`, and it no longer serves `/oauth/*`. Without `AUTH_ISSUER` and a valid secret, or while the IdP is unreachable, sign-in shows itself as temporarily unavailable and browser-only participation keeps working.

Connecting Agora Console is separate from signing in: it uses Agora's OAuth (`AGORA_OAUTH_*`) with the redirect URI `<SITE_URL>/connect/agora/callback`. See [Agora Console connections](docs/platform.md#agora-console-connections).

### Local deployment

The local containers `portal-local` (`http://localhost:3080`) and `auth-local` (`http://auth.localhost:3090`) share the `portal-local` Docker network. Both the browser and the portal must reach the IdP at the same issuer URL, so `auth-local` needs the network alias `auth.localhost`; the IdP's back-channel logout reaches the portal at `http://portal.localhost:3002/auth/backchannel-logout`, so `portal-local` needs the alias `portal.localhost` (the IdP accepts plain http only for local host names). Register the `portal` client in the IdP's local clients file with those URLs and put the same `PORTAL_CLIENT_SECRET` in both deployments' settings.

## Connect models and web research

Copy `.env.example` to `.env`, configure provider variables, and restart the server. Keep keys server-side and out of Git.

- `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`: OpenAI-compatible chat completions with strict JSON-schema output. A local compatible endpoint can work without a key.
- `TTS_BASE_URL`, `TTS_MODEL`, `TTS_API_KEY`: speech generation through `/audio/speech`.
- `RADAR_BASE_URL`, `RADAR_MODEL`, `RADAR_API_KEY`: Responses API with the `web_search` tool. A generic chat endpoint alone cannot provide sourced radar results.
- `OPENAI_API_KEY`: may configure all three services instead of separate keys.

With no provider configured, people search uses explicit keyword matching and playgrounds show unavailable status. Configuration indicates readiness, not a completed provider health check. Upstream failures appear as errors; no simulated answers are published.

Radar runs manually or, for members who explicitly enable monitoring, checks every 15 minutes for scans due at `RADAR_INTERVAL_HOURS` (default 24). It sends intent and interests to the configured provider, persists results privately, and publishes only source URLs retrieved or cited by web search. Changing intent clears prior results. It never contacts anyone on a member's behalf. Monitoring requires a running server.

Shared inference is limited to six calls per minute per client IP and `MODEL_REQUESTS_PER_HOUR` per house (default 60); automated radar uses the same hourly allowance. Chat and speech require a signed-in account. Review allowances against your provider budget before connecting it.

## Agora group calls

Create an Agora project with App Certificate authentication enabled. Set `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE` in the server's `.env` and restart. Both must be 32-character hexadecimal values. The certificate stays on the server; signed-in people receive short-lived, channel-specific AccessToken2 credentials from `POST /api/spaces/<id>/rtc-token`, and only while they are currently in that room. `AGORA_TOKEN_TTL_SECONDS` defaults to 3600 and is bounded to 60–3600 seconds. The SDK renews credentials before they expire; renewals require the same browser profile and current presence in the room.

Calls happen inside the Stoa's lot rooms and your own spaces. Video layouts follow the theme: over avatars (Agora), a strip (Cyberpunk), or a grid (Minimal). Members choose whether to enable devices, toggle microphone/camera, share a screen, and leave the call. Screen sharing uses a separate Agora publisher so it can run alongside the camera; browser support determines whether screen audio is available. Camera, microphone, and screen tracks close on leave and page exit. Separate tabs get distinct media identities.

Old `/meet/<id>` links and `/meetings.html?room=<id>` redirect to `/stoa/s/<id>`, where legacy rooms now live as spaces with the same ids. The `/api/rooms` routes answer `410 Gone`.

Use HTTPS for remote callers, or `http://localhost:3002` for local development. Browsers restrict media devices on plain remote HTTP. No Agora credentials are bundled in the site. Without valid configuration, rooms stay usable and calls show an unavailable state. Leaving a room or removing a profile blocks new tokens and renewal; an already-issued Agora token remains valid until its short expiration.

## Stoa spaces

The Stoa is a walkable plaza (`/stoa/`) with first-come rooms (`/stoa/room/<slug>`) and unlisted or private spaces (`/stoa/s/<id>`). Calls use Agora RTC; movement, presence, and live messages use Agora Signaling. Enable Signaling for the Agora project and set `SPACES_SIGNALING_SECRET` to at least 32 random characters. The built-in maps in `worlds/` are generated by `npm run maps`.

Built-in themes live in `themes/` (Agora, Minimal, Cyberpunk) and are validated at startup. Hosts can hand over hosting, remove people from the room, and decorate it. Signed-in people can start their own spaces (`/stoa/?start=<title>` opens the dialog with a title filled in), invite others with links, manage members, change settings, and delete a space. Free accounts can own up to 3 spaces; premium plans can own up to 20.

Visitors can switch their own view to Minimal; `/stoa/?theme=cyberpunk` previews a theme. Movement works with click or tap and with the arrow keys or WASD; the side panel offers the same actions for keyboard and screen reader users.

## The physical forge

Demo days, hackathons, and whiteboard sessions are core community activities. The homepage offers a session-planning entry point for each. Start a space in the Stoa with your real intent, include a place and time in the session purpose, and share the invite with collaborators. Use the same workspace to prepare online and reconnect after meeting in person. These are planning tools; the site does not advertise invented events, venues, or attendees.

## Community offers

`data/offers.json` starts empty. Add only confirmed offers with `provider`, `title`, `description`, `url`, optional `eligibility`, and optional ISO `expiresAt`. Expired offers are hidden. No discounts are implied before a partnership is confirmed.

## Verification

`npm test` uses the Node test runner with isolated temporary data, a stand-in IdP, and mocked providers. It covers public-file restrictions, profiles and ownership, the sign-in callback (state, PKCE, nonce, ID token), sessions and logout, back-channel logout, IdP access tokens and scopes, key rotation, the billing allowlist, guests, Agora Console connect, the identity migration, old meeting-link redirects, persistence, search, sourced research, service limits, Agora token signatures/renewal, activity caching/deletion, and production output. `npm run test:e2e` runs the portal against the real auth.agora.build from an Agora-Build/Auth checkout, and `node scripts/browser-smoke.mjs` drives a real Chromium through the same stack; both are opt-in and described in [the platform guide](docs/platform.md#verification). For UI changes, check all pages on desktop and mobile, keyboard navigation, reduced motion, dialogs, empty states, filters, sourced activity, provider availability, and two browser sessions entering one room. With configured registrations, verify live sign-in through auth.agora.build, Agora Console connect, and Agora media, token renewal, and device release on leave.

## License

MIT. See [LICENSE](LICENSE).
