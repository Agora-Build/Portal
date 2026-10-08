# Stoa Rooms (Plan C2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rooms useful once you're inside them. Add Agora RTC calls with theme-chosen video layouts, decorate mode for hosts, host tools (hand over, remove), creating and managing your own spaces (settings, invites, members), and retire the old meetings page in favour of the Stoa.

**Architecture:** The server already enforces everything (Plan A): `rtc-token`, `decor`, `host`, `remove`, `invitations`, `members`, `PUT`/`DELETE` on spaces. This plan adds two read paths on the server (`GET /api/spaces/mine` and member names for owners) and builds the browser side. `world/rtc-client.js` is UI-free Agora RTC, extracted from the legacy `call.js`. `stoa/call.js`, `stoa/decor.js` and `stoa/spaces.js` are page layers. The stage (`stoa/stage.js`) stays the single owner of "where am I". It tells the page when the room changes (`onRoom`), applies decorations, and runs host actions. Two new channel notices carry changes to peers: `{t:"decor", version}` and `{t:"rekey"}`.

**Tech Stack:** Node 20 built-ins, browser ES modules, `agora-rtc-sdk-ng` (served at `/assets/agora-rtc.js`), `agora-rtm-sdk` 2.x, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-07-stoa-spaces-design.md` (sections 1 Hosts, Decorating, User-created spaces; 2 removal; 3 RTC; API table). Earlier plans: `2026-10-07-spaces-core.md` (A), `2026-10-07-world-engine.md` (B), `2026-10-08-stoa-live.md` (C1).

## Global Constraints

- Node.js 20+, built-in modules only on the server. No new npm dependencies.
- JavaScript: two-space indentation, double quotes, semicolons. Match the dense one-line style of the surrounding files. Comments explain *why*, sparingly.
- Every commit message ends with the line `🤖 Built with SMT <smt@agora.build>`. No co-author trailers.
- Credentials never appear in source, tests, docs, or memory. Tests use the fake values already in the test files (`"a".repeat(32)` and so on).
- Native buttons, accessible names, `aria-pressed` for toggles. The panel offers everything the canvas offers. Respect `prefers-reduced-motion`.
- Keep the paper, terracotta and charcoal palette and the shared CSS variables. Call controls look the same in every theme (spec section 3).
- Devices stay off until the person chooses to join a call. Joining only to listen must work (spec section 3).
- The plaza has no call (spec section 3). Calls exist only in lot rooms and user spaces, and only while the person holds the room's lease.
- `npm test` must pass after every task.
- Never stop or restart the user's server on port 3002.

## File Structure

| File | Responsibility |
| --- | --- |
| `world/protocol.js` (modify) | Reads `decor` and `rekey` notices |
| `world/engine.js` (modify) | `draw` event (camera + drawn avatars), `setPicking` for decor placement |
| `stoa/lease.js` (modify) | `beatNow()` heartbeat on demand |
| `stoa/place.js` (modify) | `onDecor`, `onRekey`, `decorChanged(version)`, `rekey()` |
| `world/rtc-client.js` (create) | Agora RTC without UI: join, devices, screen share, renewal, snapshots |
| `scripts/spaces/service.mjs`, `routes.mjs` (modify) | `GET /api/spaces/mine`; `roster` / `blockedRoster` names for owners |
| `stoa/call.js` (create) | Call controls and video tiles; layouts `over-avatar`, `strip`, `grid` |
| `stoa/decor.js` (create) | Decor working copy (pure) and decor-mode editor (DOM) |
| `stoa/spaces.js` (create) | Your spaces list, create dialog, manage dialog (settings, invites, members, delete) |
| `stoa/stage.js` (modify) | `onRoom`, `onPeople`, `people()`, decor apply/save, host tools, rekey |
| `stoa/panel.js` (modify) | Host tools in the people list; Decorate and Manage buttons |
| `stoa.html`, `stoa.js`, `styles.css` (modify) | Markup, wiring, styles |
| `scripts/serve.mjs`, `scripts/build.mjs`, `scripts/auth.mjs`, `script.js`, HTML pages, README (modify) | Retire meetings |
| `meetings.html`, `meetings.js`, `call.js` (delete) | Replaced by the Stoa |

Each new browser file must be added to `publicFiles` in `scripts/serve.mjs` in the task that creates it. `scripts/build.mjs` already copies `world/` and `stoa/` whole.

---

### Task 1: Channel notices, heartbeat on demand, and engine hooks

**Files:**
- Modify: `world/protocol.js` (the `readMessage` switch)
- Modify: `stoa/place.js`, `stoa/lease.js`, `world/engine.js`
- Test: `tests/stoa-protocol.test.mjs`, `tests/stoa-place.test.mjs`, `tests/world-engine.test.mjs`

**Interfaces:**
- Produces: `readMessage` accepts `{ t: "decor", version }` (integer ≥ 1) and `{ t: "rekey" }`.
- Produces: `openPlace({ ..., onDecor(fromActorId, version), onRekey(fromActorId) })`. The returned place gains `decorChanged(version)` (publishes `{t:"decor",version}`) and `rekey()` (publishes `{t:"rekey"}` and returns `Promise<boolean>` for whether it was sent). Guests and quiet places publish neither.
- Produces: `createLease(...)` returns `{ stop, beatNow, leave, leaveOnUnload }`. `beatNow()` runs one heartbeat now with the same success and loss handling, and resolves when it finishes. After `stop()` it does nothing.
- Produces: engine event `"draw"` emitted after every drawn frame with `{ camera: { x, y, zoom }, tileSize, avatars: [{ id, x, y, self }] }`. `avatars` holds only the people actually drawn, self first. `self` is a boolean.
- Produces: `engine.setPicking(handler | null)`. While a handler is set, a primary click or tap inside the bounds calls `handler({ x, y })` instead of walking. This works even when `setInteractive(false)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/stoa-protocol.test.mjs` (it already has `plaza` and `readMessage`):

```js
test("decor and rekey notices are read strictly", () => {
  assert.deepEqual(readMessage(JSON.stringify({ t: "decor", version: 3 }), plaza), { t: "decor", version: 3 });
  for (const version of [0, -1, 1.5, "3", undefined, null]) assert.equal(readMessage(JSON.stringify({ t: "decor", version }), plaza), null, String(version));
  assert.deepEqual(readMessage(JSON.stringify({ t: "rekey", extra: 1 }), plaza), { t: "rekey" });
});
```

Append to `tests/stoa-place.test.mjs`. The existing `opened()` helper does not pass the new callbacks, so this test calls `openPlace` directly:

```js
test("decor and rekey notices reach the caller with who sent them, and can be published", async () => {
  const live = fakeLive({ who: [{ userId: ada, states: state(22, 17, "Ada") }] }), engine = fakeEngine(), seen = [];
  const place = await openPlace({ live, map: plaza, engine, self: { name: "Me" }, channel: { name: "room-1", key: null, spaceId: "lot-x" }, onDecor: (from, version) => seen.push(["decor", from, version]), onRekey: (from) => seen.push(["rekey", from]) });
  live.handlers.message(ada, JSON.stringify({ t: "decor", version: 2 }));
  live.handlers.message(ada, JSON.stringify({ t: "rekey" }));
  live.handlers.message(bo, JSON.stringify({ t: "rekey" }));
  const adaId = "account:72a639ba-3a45-4afe-936b-222222222222";
  assert.deepEqual(seen, [["decor", adaId, 2], ["rekey", adaId]], "people without presence are ignored");
  place.decorChanged(5);
  assert.equal(await place.rekey(), true);
  assert.deepEqual(live.published.slice(-2), [{ t: "decor", version: 5 }, { t: "rekey" }]);
});
test("watchers never publish decor or rekey notices", async () => {
  const { live, place } = await opened({ quiet: true });
  place.decorChanged(1);
  assert.equal(await place.rekey(), false);
  assert.deepEqual(live.published, []);
});
test("a heartbeat can be run at once, and does nothing after the lease stops", async () => {
  const accesses = [], losses = [];
  let replies = [{ channel: "c3", key: null, blocked: [], hostId: null }, Object.assign(new Error("Gone"), { status: 410 })];
  const api = async () => { const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply; };
  const lease = createLease({ api, spaceId: "lot-x", onAccess: (access) => accesses.push(access.channel), onLost: (error) => losses.push(error.status), repeat: () => 1, stopRepeat() {} });
  await lease.beatNow();
  await lease.beatNow();
  assert.deepEqual([accesses, losses], [["c3"], [410]]);
  replies = [{ channel: "c4" }];
  await lease.beatNow();
  assert.deepEqual(accesses, ["c3"], "a stopped lease does not beat");
});
```

Append to `tests/world-engine.test.mjs`:

```js
test("each drawn frame is reported with the camera and where the drawn people stand", () => {
  const { engine, flush } = setup();
  const frames = [];
  engine.on("draw", (frame) => frames.push(frame));
  engine.setOthers([{ id: "bo", name: "Bo", walk: { path: [{ x: 22, y: 17 }], startedAt: 0 } }]); flush();
  const last = frames.at(-1);
  assert.equal(last.tileSize, 32);
  assert.ok(last.camera.zoom > 0);
  assert.deepEqual(last.avatars.map(({ id, x, y, self }) => [id, x, y, self]), [["self", 21, 17, true], ["bo", 22, 17, false]]);
});
test("picking hands clicked tiles to the picker instead of walking, even with input off", () => {
  const { engine, handlers, events, drawn } = setup();
  const picked = [];
  engine.setInteractive(false);
  engine.setPicking((tile) => picked.push(tile));
  const { camera } = drawn.at(-1);
  const click = () => handlers.pointerup({ button: 0, clientX: (23 * 32 + 16 - camera.x) * camera.zoom, clientY: (17 * 32 + 16 - camera.y) * camera.zoom });
  click();
  assert.deepEqual(picked, [{ x: 23, y: 17 }]);
  assert.equal(events.move.length, 0);
  engine.setPicking(null);
  click();
  assert.equal(events.move.length, 0, "with picking off, input off still means no walking");
  engine.setInteractive(true);
  click();
  assert.equal(events.move.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/stoa-protocol.test.mjs tests/stoa-place.test.mjs tests/world-engine.test.mjs`
Expected: the five new tests FAIL (`null` instead of a notice, `place.decorChanged is not a function`, `lease.beatNow is not a function`, `Unknown engine event: draw`, `engine.setPicking is not a function`).

- [ ] **Step 3: Implement**

`world/protocol.js`: in `readMessage`, add two cases before `default`:

```js
    case "decor": return Number.isInteger(data.version) && data.version > 0 ? { t: "decor", version: data.version } : null;
    case "rekey": return { t: "rekey" };
```

`stoa/place.js`:
- Signature: add `onDecor = () => {}, onRekey = () => {}` after `onRefresh = () => {}`.
- In the `message` handler, after the `refresh` line:

```js
      if (message.t === "decor") onDecor(message.from.id, message.version);
      if (message.t === "rekey") onRekey(message.from.id);
```

- In the returned object, after `refresh()`:

```js
    decorChanged(version) { if (!guest) publish({ t: "decor", version }); },
    rekey() { return guest ? Promise.resolve(false) : publish({ t: "rekey" }); },
```

`stoa/lease.js`: replace the body so the heartbeat is a named function:

```js
// Keeps an entry lease alive and reports when it ends. Leaving on page close uses a beacon so it still reaches the server.
export function createLease({ api, spaceId, onAccess = () => {}, onLost = () => {}, every = 20000, repeat = (callback, delay) => setInterval(callback, delay), stopRepeat = (handle) => clearInterval(handle), beacon = (url) => navigator.sendBeacon?.(url) }) {
  const base = "/api/spaces/" + spaceId;
  let timer = null, stopped = false;
  const stop = () => { stopped = true; if (timer !== null) { stopRepeat(timer); timer = null; } };
  const beat = async () => {
    try { const access = await api(base + "/heartbeat", { method: "POST" }); if (!stopped) onAccess(access); }
    catch (error) { if (!stopped && [401, 403, 404, 410].includes(error.status)) { stop(); onLost(error); } }
  };
  timer = repeat(beat, every);
  return {
    stop,
    // An extra heartbeat right away, for when the host says access has changed.
    beatNow: () => stopped ? Promise.resolve() : beat(),
    async leave() { stop(); try { await api(base + "/leave", { method: "POST" }); } catch { /* the lease expires on its own */ } },
    leaveOnUnload() { stop(); beacon(base + "/leave"); }
  };
}
```

`world/engine.js`:
- Header comment: add `"draw" { camera, tileSize, avatars } after each frame` to the events list.
- `const listeners = { arrive: [], move: [], walk: [], stop: [], face: [], draw: [] };`
- Add `picking = null` to the `let current = theme, ...` declarations.
- In `frame()`, replace the `renderer.draw(...)` line with:

```js
    const avatars = [{ id: self.id, name: self.name, self: true, bubble: speech(self.bubble, time), ...shown }, ...crowd];
    renderer.draw({ camera, time, avatars, decor, labels, bounds, motion: !reducedMotion });
    if (listeners.draw.length) emit("draw", { camera, tileSize: s, avatars: avatars.map((avatar) => ({ id: avatar.id, x: avatar.x, y: avatar.y, self: Boolean(avatar.self) })) });
```

- Replace `onPointer`:

```js
  const onPointer = (event) => {
    if (event.button || (!interactive && !picking)) return;
    const box = canvas.getBoundingClientRect(), tile = screenToTile(camera, event.clientX - box.left, event.clientY - box.top, map.tileSize);
    if (!inBounds(tile)) return;
    if (picking) picking(tile); else walkTo(tile);
  };
```

- Add after `setInteractive`: `setPicking(handler) { picking = typeof handler === "function" ? handler : null; },`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with 6 more tests than before. The protocol test file already covers `refresh`; nothing else changes.

- [ ] **Step 5: Commit**

```bash
git add world/protocol.js world/engine.js stoa/place.js stoa/lease.js tests/stoa-protocol.test.mjs tests/stoa-place.test.mjs tests/world-engine.test.mjs
git commit -m "Add decor and rekey notices, on-demand heartbeats, and engine draw and pick hooks

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: A UI-free RTC client

**Files:**
- Create: `world/rtc-client.js`
- Modify: `scripts/serve.mjs` (`publicFiles`: add `"world/rtc-client.js"`)
- Test: `tests/rtc-client.test.mjs`

**Interfaces:**
- Consumes: the AgoraRTC Web SDK 4.x API, the same calls the legacy `call.js` uses. Credentials come from `POST /api/spaces/<id>/rtc-token` with the shape `{ appId, channel, uid, screenUid, token, screenToken, expiresAt }` (`scripts/calls.mjs` `credentials()`).
- Produces: `mediaError(error) -> string`, `isScreen(uid) -> boolean`.
- Produces: `createRtcClient({ AgoraRTC, fetchCredentials(uid?), onChange(snapshot), onError(message), onEnded(message) })`, returning:
  - `join({ audio, video })`, `toggle("audio" | "video")`, `share()`. Each resolves to `true` when it ran and `false` when another action was running, the client was closed, or the action failed (failures are reported through `onError`).
  - `leave() -> Promise`
  - `play(uid, element) -> boolean`
  - `resumeAudio()`
  - `snapshot()`, which returns `{ joined, busy, closed, uid, screenUid, audio, video, screen, audioBlocked, peers: [{ uid, audio, video, screen }] }`. `audio`/`video` mean your own tracks are on. `peers` excludes your own screen-share uid.
- `fetchCredentials()` with no argument asks for a new identity. With a uid it renews that identity.

- [ ] **Step 1: Write the failing tests**

Create `tests/rtc-client.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRtcClient, isScreen, mediaError } from "../world/rtc-client.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const me = "u1_aaaaaaaaaaaa", peer = "u2_bbbbbbbbbbbb";
const credentials = (n = 1) => ({ appId: "app", channel: "agora-build-space-x", uid: me, screenUid: me + "_screen", token: "t" + n, screenToken: "s" + n });
function fakeTrack(kind) {
  const track = { kind, enabled: true, closed: false, stopped: false, played: [], listeners: {}, async setEnabled(value) { track.enabled = value; }, close() { track.closed = true; }, stop() { track.stopped = true; }, play(element, options) { track.played.push([element, options]); }, on(type, listener) { track.listeners[type] = listener; } };
  return track;
}
function fakeAgora({ deny = null } = {}) {
  const sdk = {
    clients: [], tracks: [], checkSystemRequirements: () => true,
    createClient() {
      const client = {
        listeners: {}, remoteUsers: [], joined: null, published: [], left: false, renewed: [], connectionState: "DISCONNECTED",
        on(type, listener) { client.listeners[type] = listener; }, emit(type, ...args) { client.listeners[type]?.(...args); },
        async join(appId, channel, token, uid) { client.joined = { appId, channel, token, uid }; client.connectionState = "CONNECTED"; },
        async leave() { client.left = true; client.connectionState = "DISCONNECTED"; },
        async publish(tracks) { client.published.push(...[].concat(tracks)); },
        async subscribe(user, media) { user[media + "Track"] = fakeTrack(media); },
        async renewToken(token) { client.renewed.push(token); },
        removeAllListeners() { client.listeners = {}; }
      };
      sdk.clients.push(client);
      return client;
    },
    async createMicrophoneAudioTrack() { if (deny === "audio") throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" }); const track = fakeTrack("audio"); sdk.tracks.push(track); return track; },
    async createCameraVideoTrack() { const track = fakeTrack("video"); sdk.tracks.push(track); return track; },
    async createScreenVideoTrack() { const track = fakeTrack("screen"); sdk.tracks.push(track); return track; }
  };
  return sdk;
}
function make({ sdk = fakeAgora(), fetch } = {}) {
  const fetches = [], errors = [], ended = [];
  const rtc = createRtcClient({ AgoraRTC: sdk, fetchCredentials: fetch || (async (uid) => { fetches.push(uid); return credentials(fetches.length); }), onError: (message) => errors.push(message), onEnded: (message) => ended.push(message) });
  return { rtc, sdk, fetches, errors, ended };
}
const own = (snapshot) => ({ joined: snapshot.joined, audio: snapshot.audio, video: snapshot.video, screen: snapshot.screen });

test("screen-share uids and device errors are recognised", () => {
  assert.equal(isScreen(me + "_screen"), true);
  assert.equal(isScreen(me), false);
  assert.match(mediaError({ code: "PERMISSION_DENIED" }), /declined/);
  assert.match(mediaError({ name: "NotFoundError" }), /could not be found/);
  assert.equal(mediaError({ status: 403, message: "Step in first." }), "Step in first.");
});
test("joining publishes the chosen devices, toggles work, and leaving releases everything", async () => {
  const { rtc, sdk } = make();
  assert.equal(await rtc.join({ audio: true }), true);
  const [client] = sdk.clients;
  assert.deepEqual(client.joined, { appId: "app", channel: "agora-build-space-x", token: "t1", uid: me });
  assert.deepEqual(client.published.map((track) => track.kind), ["audio"]);
  assert.deepEqual(own(rtc.snapshot()), { joined: true, audio: true, video: false, screen: false });
  await rtc.toggle("audio");
  assert.equal(rtc.snapshot().audio, false);
  await rtc.toggle("video");
  assert.equal(rtc.snapshot().video, true);
  await rtc.leave();
  assert.ok(sdk.tracks.every((track) => track.closed), "every device is released");
  assert.equal(client.left, true);
  assert.equal(await rtc.toggle("audio"), false, "nothing runs after leaving");
});
test("people appear as they publish and disappear as they leave; your own screen is not a peer", async () => {
  const { rtc, sdk } = make();
  await rtc.join({});
  const [client] = sdk.clients, user = { uid: peer };
  client.remoteUsers.push(user);
  client.emit("user-joined", user);
  client.emit("user-published", user, "video");
  await tick();
  assert.deepEqual(rtc.snapshot().peers, [{ uid: peer, audio: false, video: true, screen: false }]);
  const element = {};
  assert.equal(rtc.play(peer, element), true);
  assert.deepEqual(user.videoTrack.played, [[element, { fit: "cover" }]]);
  client.emit("user-unpublished", user, "video");
  assert.equal(rtc.snapshot().peers[0].video, false);
  assert.equal(rtc.play(peer, element), false);
  client.emit("user-joined", { uid: me + "_screen" });
  assert.equal(rtc.snapshot().peers.length, 1);
  client.remoteUsers = [];
  client.emit("user-left", user);
  assert.deepEqual(rtc.snapshot().peers, []);
});
test("tokens renew with the same identity, and a refused renewal ends the call", async () => {
  let refuse = false;
  const fetches = [];
  const { rtc, sdk, ended } = make({ fetch: async (uid) => { fetches.push(uid); if (refuse) throw Object.assign(new Error("Step into this space before joining its call."), { status: 403 }); return credentials(fetches.length); } });
  await rtc.join({ audio: true });
  const [client] = sdk.clients;
  client.emit("token-privilege-will-expire");
  await tick(); await tick();
  assert.deepEqual([fetches, client.renewed], [[undefined, me], ["t2"]]);
  refuse = true;
  client.emit("token-privilege-did-expire");
  for (let index = 0; index < 5; index += 1) await tick();
  assert.deepEqual(ended, ["Step into this space before joining its call."]);
  assert.equal(client.left, true);
  assert.ok(sdk.tracks.every((track) => track.closed));
});
test("a declined microphone still joins to listen, with a clear reason", async () => {
  const { rtc, errors } = make({ sdk: fakeAgora({ deny: "audio" }) });
  assert.equal(await rtc.join({ audio: true }), true);
  assert.deepEqual(own(rtc.snapshot()), { joined: true, audio: false, video: false, screen: false });
  assert.match(errors[0], /declined/);
});
test("leaving while still joining releases everything and never joins", async () => {
  let release;
  const sdk = fakeAgora();
  const { rtc } = make({ sdk, fetch: () => new Promise((resolve) => { release = resolve; }) });
  const joining = rtc.join({ audio: true });
  await tick();
  const leaving = rtc.leave();
  release(credentials());
  await leaving; await joining;
  assert.equal(sdk.clients.length, 0);
  assert.equal(sdk.tracks.length, 0);
});
test("screen sharing uses a second client and stops when the browser ends it", async () => {
  const { rtc, sdk } = make();
  await rtc.join({});
  assert.equal(await rtc.share(), true);
  const screenClient = sdk.clients[1];
  assert.deepEqual([screenClient.joined.uid, screenClient.joined.token], [me + "_screen", "s2"]);
  assert.equal(rtc.snapshot().screen, true);
  const element = {};
  assert.equal(rtc.play(me + "_screen", element), true);
  const [screenTrack] = screenClient.published;
  assert.deepEqual(screenTrack.played, [[element, { fit: "contain" }]]);
  screenTrack.listeners["track-ended"]();
  await tick(); await tick();
  assert.equal(rtc.snapshot().screen, false);
  assert.equal(screenClient.left, true);
  assert.equal(screenTrack.closed, true);
});
test("an unexpected disconnect ends the call", async () => {
  const { rtc, sdk, ended } = make();
  await rtc.join({});
  sdk.clients[0].emit("connection-state-change", "DISCONNECTED", "CONNECTED");
  for (let index = 0; index < 5; index += 1) await tick();
  assert.deepEqual(ended, ["The call disconnected. Join again when you're ready."]);
  assert.equal(rtc.snapshot().joined, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/rtc-client.test.mjs`
Expected: FAIL with `Cannot find module '../world/rtc-client.js'`.

- [ ] **Step 3: Implement `world/rtc-client.js`**

```js
// Agora RTC with no UI: joining, devices, publishing, screen sharing, and token renewal. The page draws from snapshots.
export const isScreen = (uid) => String(uid).endsWith("_screen");
export function mediaError(error) {
  if (error?.status) return error.message;
  const code = String(error?.code || error?.name || "");
  if (/PERMISSION|NOT_ALLOWED|NotAllowed/i.test(code)) return "Device access was declined. Check your browser permissions and try again.";
  if (/NOT_FOUND|NotFound/i.test(code)) return "That microphone or camera could not be found. You can still listen to the call.";
  return "The call could not complete that action. Check your connection and try again.";
}

export function createRtcClient({ AgoraRTC, fetchCredentials, onChange = () => {}, onError = () => {}, onEnded = () => {} }) {
  let client = null, credentials = null, audio = null, video = null, screen = null, joined = false, busy = false, closed = false, renewing = null, audioBlocked = false, work = Promise.resolve();
  const remote = new Map();
  const snapshot = () => ({ joined, busy, closed, uid: credentials?.uid || null, screenUid: credentials?.screenUid || null, audio: Boolean(audio?.enabled), video: Boolean(video?.enabled), screen: Boolean(screen), audioBlocked, peers: [...remote.values()].map((peer) => ({ uid: peer.uid, audio: peer.audio, video: peer.video, screen: isScreen(peer.uid) })) });
  const changed = () => { if (!closed) onChange(snapshot()); };
  // One action at a time; a click while another action runs is ignored.
  function operate(action) {
    if (busy || closed) return Promise.resolve(false);
    busy = true; changed();
    work = (async () => {
      try { await action(); return true; }
      catch (error) { if (!closed) onError(mediaError(error)); return false; }
      finally { busy = false; changed(); }
    })();
    return work;
  }
  async function renew() {
    if (closed) return;
    if (renewing) return renewing;
    renewing = (async () => {
      const next = await fetchCredentials(credentials.uid);
      if (closed) return;
      credentials = next;
      await client.renewToken(next.token);
      if (screen?.client.connectionState === "CONNECTED") await screen.client.renewToken(next.screenToken);
    })();
    try { await renewing; } finally { renewing = null; }
  }
  const end = (message) => { if (!closed) leave().then(() => onEnded(message)); };
  function watchToken(target) {
    const refresh = () => renew().catch((error) => end(error?.status ? error.message : "Call access could not be renewed. Join again."));
    target.on("token-privilege-will-expire", refresh);
    target.on("token-privilege-did-expire", refresh);
  }
  function watch() {
    const own = (user) => user.uid === credentials.screenUid;
    const entry = (user) => { if (!remote.has(user.uid)) remote.set(user.uid, { uid: user.uid, user, audio: false, video: false }); return remote.get(user.uid); };
    client.on("user-joined", (user) => { if (closed || own(user)) return; entry(user); changed(); });
    client.on("user-left", (user) => { remote.delete(user.uid); changed(); });
    client.on("user-published", (user, media) => {
      if (closed || own(user)) return;
      client.subscribe(user, media).then(() => {
        if (closed || !client.remoteUsers.some((peer) => peer.uid === user.uid)) return;
        const peer = entry(user);
        peer.user = user; peer[media] = true;
        if (media === "audio") user.audioTrack?.play();
        changed();
      }).catch(() => { if (!closed) onError("One person's audio or video could not load. It will retry when they share it again."); });
    });
    client.on("user-unpublished", (user, media) => {
      if (closed || own(user)) return;
      if (media === "video") user.videoTrack?.stop();
      if (media === "audio") user.audioTrack?.stop();
      const peer = remote.get(user.uid);
      if (peer) { peer[media] = false; changed(); }
    });
    client.on("connection-state-change", (next, previous) => { if (next === "DISCONNECTED" && previous !== "DISCONNECTING" && joined) end("The call disconnected. Join again when you're ready."); });
    watchToken(client);
  }
  async function enable(kind) {
    const track = kind === "audio" ? await AgoraRTC.createMicrophoneAudioTrack() : await AgoraRTC.createCameraVideoTrack({ encoderConfig: "480p_1" });
    if (closed) { track.close(); return; }
    if (kind === "audio") audio = track; else video = track;
    try { await client.publish(track); }
    catch (error) { track.close(); if (kind === "audio") audio = null; else video = null; throw error; }
  }
  async function stopScreen() {
    const current = screen;
    if (!current) return;
    screen = null;
    current.client.removeAllListeners();
    for (const track of current.tracks) { track.stop(); track.close(); }
    await current.client.leave().catch(() => {});
  }
  async function leave() {
    if (closed) return;
    closed = true;
    // Devices are released at once, even while a join or publish is still pending.
    for (const track of [audio, video, ...(screen?.tracks || [])]) track?.close();
    await work.catch(() => {});
    await Promise.allSettled([stopScreen(), (async () => { client?.removeAllListeners(); await client?.leave(); })()]);
    for (const track of [audio, video]) track?.close();
    audio = null; video = null; joined = false; remote.clear();
  }
  return {
    snapshot,
    join: ({ audio: withAudio = false, video: withVideo = false } = {}) => operate(async () => {
      if (!AgoraRTC.checkSystemRequirements()) throw Object.assign(new Error("This browser can't join calls. Try a current Chrome, Edge, Firefox, or Safari."), { status: 400 });
      AgoraRTC.onAutoplayFailed = () => { audioBlocked = true; changed(); };
      credentials = await fetchCredentials();
      if (closed) return;
      client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
      watch();
      try { await client.join(credentials.appId, credentials.channel, credentials.token, credentials.uid); }
      catch (error) { client.removeAllListeners(); await client.leave().catch(() => {}); client = null; throw error; }
      if (closed) return;
      joined = true;
      for (const [kind, wanted] of [["audio", withAudio], ["video", withVideo]]) {
        if (wanted && !closed) { try { await enable(kind); } catch (error) { onError(mediaError(error)); } }
      }
    }),
    toggle: (kind) => operate(async () => {
      if (!joined) return;
      const track = kind === "audio" ? audio : video;
      if (!track) { await enable(kind); return; }
      await track.setEnabled(!track.enabled);
      if (kind === "video" && !track.enabled) track.stop();
    }),
    share: () => operate(async () => {
      if (!joined) return;
      if (screen) { await stopScreen(); return; }
      // Capture during the click, before any network work, as browsers require.
      const captured = await AgoraRTC.createScreenVideoTrack({ encoderConfig: "1080p_1" }, "auto");
      const tracks = Array.isArray(captured) ? captured : [captured];
      if (closed) { for (const track of tracks) track.close(); return; }
      const second = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
      screen = { client: second, tracks };
      tracks[0].on("track-ended", () => { if (!closed && screen?.client === second) stopScreen().then(changed); });
      try {
        await renew();
        if (closed || screen?.client !== second) return;
        watchToken(second);
        await second.join(credentials.appId, credentials.channel, credentials.screenToken, credentials.screenUid);
        if (closed || screen?.client !== second) return;
        await second.publish(tracks);
      } catch (error) { await stopScreen(); throw error; }
    }),
    // Plays someone's video into an element; false when there is nothing to show.
    play(uid, element) {
      if (closed) return false;
      const peer = remote.get(uid);
      const track = uid === credentials?.uid ? (video?.enabled ? video : null) : uid === credentials?.screenUid ? screen?.tracks[0] : peer?.video ? peer.user.videoTrack : null;
      if (!track) return false;
      track.play(element, { fit: isScreen(uid) ? "contain" : "cover" });
      return true;
    },
    resumeAudio() { for (const user of client?.remoteUsers || []) user.audioTrack?.play(); audioBlocked = false; changed(); },
    leave
  };
}
```

Add `"world/rtc-client.js"` to `publicFiles` in `scripts/serve.mjs`, next to `"world/sdk.js"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/rtc-client.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add world/rtc-client.js scripts/serve.mjs tests/rtc-client.test.mjs
git commit -m "Add a UI-free Agora RTC client for room calls

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 3: Your spaces, and member names for owners

**Files:**
- Modify: `scripts/spaces/service.mjs` (the `view` helper and a new `mine` method)
- Modify: `scripts/spaces/routes.mjs` (one route)
- Test: `tests/spaces-service.test.mjs`, `tests/spaces-api.test.mjs`

**Interfaces:**
- Produces: `spaces.mine(token)` and `GET /api/spaces/mine`, both returning `{ spaces: [{ id, title, purpose, visibility, access, capacity, themeId, owner, occupancy, path }], owned, limit, canCreate }`. The list holds every non-system space where you are a member (owners are members), newest first. Signed out: 401.
- Produces: when the viewer can `edit` the space (the owner or an admin), `GET /api/spaces/<id>` (and every other `view`) also includes `roster: [{ id, name }]` for `members` and `blockedRoster: [{ id, name }]` for `blocked`. Names come from profiles (`state.people`), then accounts (`state.accounts`), then `"Builder"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/spaces-service.test.mjs`:

```js
test("your spaces lists spaces you own or belong to, newest first, with your allowance", async (t) => {
  const { spaces, clock, person } = await setup(t);
  const owner = await person("Owner"), friend = await person("Friend"), stranger = await person("Stranger");
  const first = await spaces.create(owner.token, { title: "First space" });
  clock.now += 1000;
  const second = await spaces.create(owner.token, { title: "Second space", visibility: "private" });
  await spaces.addMember(owner.token, first.id, friend.id);
  const mine = await spaces.mine(owner.token);
  assert.deepEqual(mine.spaces.map((space) => [space.title, space.owner, space.path]), [["Second space", true, "/stoa/s/" + second.id], ["First space", true, "/stoa/s/" + first.id]]);
  assert.deepEqual([mine.owned, mine.canCreate], [2, mine.limit > 2]);
  assert.deepEqual((await spaces.mine(friend.token)).spaces.map((space) => [space.title, space.owner, space.occupancy]), [["First space", false, 0]]);
  assert.deepEqual((await spaces.mine(stranger.token)).spaces, []);
  await assert.rejects(spaces.mine(null), { status: 401 });
});
test("owners see member and blocked names; others see neither", async (t) => {
  const { spaces, person } = await setup(t);
  const owner = await person("Owner"), friend = await person("Friend");
  const space = await spaces.create(owner.token, { title: "Named space" });
  await spaces.addMember(owner.token, space.id, friend.id);
  const seen = await spaces.get(owner.token, space.id);
  assert.deepEqual(seen.roster, [{ id: owner.id, name: "Owner" }, { id: friend.id, name: "Friend" }]);
  assert.deepEqual(seen.blockedRoster, []);
  const asFriend = await spaces.get(friend.token, space.id);
  assert.equal(asFriend.roster, undefined);
  assert.equal(asFriend.blockedRoster, undefined);
});
```

Append to `tests/spaces-api.test.mjs`:

```js
test("your spaces needs sign-in and lists what you own", async () => {
  const { instance, url } = await start();
  try {
    assert.equal((await request(url, "/api/spaces/mine")).status, 401);
    const ada = await join(url, "Ada");
    const created = await (await post(url, "/api/spaces", ada, { title: "Ada's lab" })).json();
    const mine = await (await request(url, "/api/spaces/mine", { cookie: ada })).json();
    assert.deepEqual(mine.spaces.map((space) => [space.id, space.owner]), [[created.space.id, true]]);
  } finally { await close(instance); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/spaces-service.test.mjs tests/spaces-api.test.mjs`
Expected: FAIL (`spaces.mine is not a function`; `roster` is undefined; `/api/spaces/mine` returns 404).

- [ ] **Step 3: Implement**

`scripts/spaces/service.mjs`: replace the `view` line with:

```js
  const nameOf = (state, id) => state.people.find((person) => person.id === id)?.name || (state.accounts || []).find((account) => account.id === id)?.name || "Builder";
  const roster = (state, ids) => ids.map((id) => ({ id, name: nameOf(state, id) }));
  // Owners manage members by name, so their view carries names for the member and blocked lists.
  const view = (state, space, actor) => {
    const manage = can(actor, "edit", space), result = publicSpace(space, { occupants: occupants(state, space), manage });
    return manage ? { ...result, roster: roster(state, space.members), blockedRoster: roster(state, space.blocked) } : result;
  };
```

Add a method after `get`:

```js
    async mine(token) {
      const actor = signedIn(await actorFor(token));
      await ready();
      const state = await store.snapshot();
      const list = state.spaces.filter((space) => !system(space) && space.members.some((id) => actor.ids.includes(id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const owns = owned(state, actor).length, limit = entitlements(actor.plan).spaces;
      return { spaces: list.map((space) => ({ id: space.id, title: space.title, purpose: space.purpose, visibility: space.visibility, access: space.access, capacity: space.capacity, themeId: space.themeId, owner: actor.ids.includes(space.ownerId), occupancy: leasesFor(state, space.id, now()).length, path: "/stoa/s/" + space.id })), owned: owns, limit, canCreate: owns < limit };
    },
```

The test advances `clock.now` between the two spaces, so ISO `createdAt` ordering is enough.

Every `view` an owner receives now carries `roster` and `blockedRoster` (create, get, update, enter). If an existing test compares a whole owner view with `deepEqual`, add the two fields to its expected value rather than weakening the assertion.

`scripts/spaces/routes.mjs`: after the `POST /api/spaces` line add:

```js
  if (path === "/api/spaces/mine" && method === "GET") return { status: 200, body: await spaces.mine(token) };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/spaces/service.mjs scripts/spaces/routes.mjs tests/spaces-service.test.mjs tests/spaces-api.test.mjs
git commit -m "List your spaces and give owners member names

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 4: Calls inside rooms

**Files:**
- Create: `stoa/call.js`
- Modify: `stoa/stage.js` (`onRoom`, `onPeople`, `people()`)
- Modify: `stoa.html`, `stoa.js`, `styles.css`, `scripts/serve.mjs` (`publicFiles`: add `"stoa/call.js"`)
- Test: `tests/stoa-call.test.mjs` (create), `tests/stoa-stage.test.mjs`, `tests/spaces-api.test.mjs` (markup ids)

**Interfaces:**
- Consumes: `createRtcClient`, `isScreen` (Task 2); the engine `"draw"` event (Task 1); `loadAgora()` from `world/sdk.js`; theme `video` (`"over-avatar" | "strip" | "grid"`).
- Produces (pure, tested):
  - `actorUuid(uid)`
  - `nameFor(uid, { people, self, snapshot })`
  - `tileList(snapshot, { people, self }) -> [{ uid, name, video, screen, mine }]`
  - `overAvatar(tile, frame) -> { left, top } | null`
- Produces (DOM): `createCallView({ doc, engine, api, self, people, say, loadSdk, secure })` returning `{ enter(spaceId), exit(), setLayout(layout), refresh() }`.
- Produces (stage): `createStage({ ..., onRoom(space | null), onPeople(list) })`.
  - `onRoom` fires only when the leased room changes: entering a lot or space gives its `space`; the plaza, watching, or "left" gives `null`. Re-opening the same room on a new channel does not fire it.
  - `onPeople(list)` fires each time the merged people list is rebuilt.
  - New method `stage.people()` returns the latest merged list.

How people are matched: RTC uids are `<actor uuid>_<12 hex>` (and `..._screen`). Presence ids are `account:<uuid>` or `member:<uuid>`. Your own engine avatar has `self: true`.

- [ ] **Step 1: Write the failing tests**

Create `tests/stoa-call.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { actorUuid, nameFor, overAvatar, tileList } from "../stoa/call.js";

const ada = "72a639ba-3a45-4afe-936b-222222222222", me = "72a639ba-3a45-4afe-936b-111111111111";
const people = [{ id: "account:" + ada, name: "Ada" }];
const self = { id: "account:" + me, name: "Me" };
const snapshot = { joined: true, uid: me + "_aaaaaaaaaaaa", screenUid: me + "_aaaaaaaaaaaa_screen", audio: true, video: false, screen: true, peers: [{ uid: ada + "_bbbbbbbbbbbb", audio: true, video: true, screen: false }, { uid: ada + "_bbbbbbbbbbbb_screen", audio: false, video: true, screen: true }, { uid: "99999999-0000-4000-8000-000000000000_cccccccccccc", audio: true, video: false, screen: false }] };

test("call identities map back to people by their UUID", () => {
  assert.equal(actorUuid(ada + "_bbbbbbbbbbbb_screen"), ada);
  const names = tileList(snapshot, { people, self }).map((tile) => [tile.name, tile.video, tile.screen, tile.mine]);
  assert.deepEqual(names, [["Me (you)", false, false, true], ["Your screen", true, true, true], ["Ada", true, false, false], ["Ada's screen", true, true, false], ["Builder", false, false, false]]);
  assert.deepEqual(tileList({ ...snapshot, joined: false }, { people, self }), []);
  assert.equal(nameFor(snapshot.uid, { people, self, snapshot }), "Me (you)");
});
test("over-avatar tiles sit above the matching avatar; screens and people out of view do not float", () => {
  const frame = { tileSize: 32, camera: { x: 100, y: 50, zoom: 2 }, avatars: [{ id: self.id, x: 5, y: 4, self: true }, { id: "account:" + ada, x: 7, y: 3, self: false }] };
  const [mine, screen, adaTile, , stranger] = tileList(snapshot, { people, self });
  assert.deepEqual(overAvatar(mine, frame), { left: ((5 + 0.5) * 32 - 100) * 2, top: (4 * 32 - 50) * 2 });
  assert.deepEqual(overAvatar(adaTile, frame), { left: ((7 + 0.5) * 32 - 100) * 2, top: (3 * 32 - 50) * 2 });
  assert.equal(overAvatar(screen, frame), null);
  assert.equal(overAvatar(stranger, frame), null);
  assert.equal(overAvatar(mine, null), null);
});
```

In `tests/stoa-stage.test.mjs`:
- Change `function setup({ api, signedIn = true, withLive = true, clock = { time: 0, timers: [] } } = {})` to also take `...options`, and spread `...options` into the `createStage({...})` call, after the existing fields.
- Append:

```js
test("the call follows the room: one callback per room entered or left, not per channel change", async () => {
  const rooms = [];
  const api = async (path) => path === "/api/spaces/plaza/enter" ? access("plaza", "plaza-1") : path.endsWith("/enter") ? access("lot-" + lot.slug, "lot-ch") : {};
  const { stage, leases } = setup({ api, onRoom: (room) => rooms.push(room ? room.id : null) });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  leases.at(-1).options.onAccess({ channel: "lot-ch-2", key: null, blocked: [], hostId: "a-me" });
  await tick(); await tick();
  await stage.leaveRoom();
  assert.deepEqual(rooms, ["lot-" + lot.slug, null]);
});
test("the merged people list is kept and reported each time it is rebuilt", async () => {
  const lists = [];
  const api = async (path) => path === "/api/spaces/plaza/enter" ? access("plaza", "plaza-1") : {};
  const { stage, calls, flushFrames } = setup({ api, onPeople: (list) => lists.push(list.map((person) => person.name)) });
  await stage.toPlaza(null);
  calls.handlers["plaza-1"].presence({ type: "snapshot", people: [{ userId: "a-72a639ba-3a45-4afe-936b-222222222222", states: { x: String(lot.door.x), y: String(lot.door.y + 1), dir: "down", name: "Ada" } }] });
  flushFrames();
  assert.deepEqual(lists.at(-1), ["Ada"]);
  assert.deepEqual(stage.people().map((person) => person.name), ["Ada"]);
});
```

In `tests/spaces-api.test.mjs`, in the test that checks Stoa markup ids (the `for (const id of ["stoa-here", ...` line), add `"stoa-call", "stoa-call-join", "stoa-video"` to the id list and `"/stoa/call.js", "/world/rtc-client.js"` to the module list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/stoa-call.test.mjs tests/stoa-stage.test.mjs tests/spaces-api.test.mjs`
Expected: FAIL (missing module, `stage.people is not a function`, no `onRoom` calls, missing ids).

- [ ] **Step 3: Implement the stage changes**

In `stoa/stage.js`:
- Add `onRoom = () => {}, onPeople = () => {}` to the `createStage` options, after `self, plaza,`.
- Add `everyone = [], roomId = null` to the `let live = firstLive, ...` declarations.
- In `showPeople`'s scheduled callback, after `const list = [...seen.values()];`, add `everyone = list;`. After `panel.setPeople(...)`, add `onPeople(list);`.
- In `settle(next)`, right after `here = next;`:

```js
    // The call and the decor editor belong to a room, so the page hears about room changes, not channel changes.
    const room = next.leased && (next.kind === "lot" || next.kind === "space") ? next.space : null;
    if ((room?.id || null) !== roomId) { roomId = room?.id || null; onRoom(room); }
```

- In the returned object, add `people: () => everyone,` after `setTopic,`.

- [ ] **Step 4: Implement `stoa/call.js`**

```js
import { createRtcClient, isScreen } from "../world/rtc-client.js";
import { loadAgora } from "../world/sdk.js";

// Calls inside rooms: native controls in the panel, video tiles over the map in the layout the theme chooses.
// RTC uids start with the person's actor UUID, so tiles are named and placed from presence.
export const actorUuid = (uid) => String(uid).split("_")[0];
export function nameFor(uid, { people, self, snapshot }) {
  if (uid === snapshot.uid) return self.name + " (you)";
  if (uid === snapshot.screenUid) return "Your screen";
  const person = people.find((entry) => String(entry.id).split(":")[1] === actorUuid(uid));
  return (person?.name || "Builder") + (isScreen(uid) ? "'s screen" : "");
}
export function tileList(snapshot, { people, self }) {
  if (!snapshot?.joined) return [];
  const own = [{ uid: snapshot.uid, video: snapshot.video, screen: false, mine: true }, ...(snapshot.screen ? [{ uid: snapshot.screenUid, video: true, screen: true, mine: true }] : [])];
  return [...own, ...snapshot.peers.map((peer) => ({ uid: peer.uid, video: peer.video, screen: peer.screen, mine: false }))].map((tile) => ({ ...tile, name: nameFor(tile.uid, { people, self, snapshot }) }));
}
// Where a tile floats in over-avatar layout: just above the person's head, in canvas pixels. Null when they aren't drawn.
export function overAvatar(tile, frame) {
  if (tile.screen || !frame) return null;
  const avatar = frame.avatars.find((entry) => tile.mine ? entry.self : String(entry.id).split(":")[1] === actorUuid(tile.uid));
  if (!avatar) return null;
  return { left: ((avatar.x + 0.5) * frame.tileSize - frame.camera.x) * frame.camera.zoom, top: (avatar.y * frame.tileSize - frame.camera.y) * frame.camera.zoom };
}

export function createCallView({ doc = document, engine, api, self, people = () => [], say = () => {}, loadSdk = loadAgora, secure = () => globalThis.isSecureContext !== false }) {
  const $ = (selector) => doc.querySelector(selector);
  const section = $("#stoa-call"), status = $("#stoa-call-status"), preflight = $("#stoa-call-preflight"), layer = $("#stoa-video");
  const buttons = { join: $("#stoa-call-join"), audio: $("#stoa-call-audio"), video: $("#stoa-call-video"), share: $("#stoa-call-share"), resume: $("#stoa-call-resume"), leave: $("#stoa-call-leave") };
  const tiles = new Map();
  let spaceId = null, rtc = null, layout = "strip", frame = null;

  function place() {
    for (const view of tiles.values()) {
      const spot = layout === "over-avatar" ? overAvatar(view.tile, frame) : null;
      view.card.classList.toggle("is-floating", Boolean(spot));
      view.card.style.transform = spot ? "translate(" + Math.round(spot.left) + "px, " + Math.round(spot.top) + "px) translate(-50%, -100%)" : "";
      // Over avatars, a person without video is already shown by their avatar.
      view.card.hidden = layout === "over-avatar" && !view.tile.screen && !view.playing;
    }
  }
  function render() {
    const now = rtc ? rtc.snapshot() : null, joined = Boolean(now?.joined);
    buttons.join.hidden = joined; preflight.hidden = joined;
    buttons.join.disabled = !secure() || Boolean(now?.busy);
    for (const key of ["audio", "video", "share", "leave"]) { buttons[key].hidden = !joined; buttons[key].disabled = Boolean(now?.busy); }
    if (!globalThis.navigator?.mediaDevices?.getDisplayMedia) buttons.share.disabled = true;
    const toggle = (button, on, onText, offText) => { button.textContent = on ? onText : offText; button.setAttribute("aria-pressed", String(on)); };
    toggle(buttons.audio, Boolean(now?.audio), "Mute mic", "Turn mic on");
    toggle(buttons.video, Boolean(now?.video), "Turn camera off", "Turn camera on");
    toggle(buttons.share, Boolean(now?.screen), "Stop sharing", "Share screen");
    buttons.resume.hidden = !now?.audioBlocked;
    layer.hidden = !joined;
    layer.dataset.layout = layout;
    const wanted = joined ? tileList(now, { people: people(), self }) : [];
    for (const [uid, view] of tiles) if (!wanted.some((tile) => tile.uid === uid)) { view.card.remove(); tiles.delete(uid); }
    for (const tile of wanted) {
      let view = tiles.get(tile.uid);
      if (!view) {
        const card = doc.createElement("article"), player = doc.createElement("div"), label = doc.createElement("span");
        card.className = "stoa-tile" + (tile.screen ? " is-screen" : ""); player.className = "stoa-tile-player"; label.className = "stoa-tile-name";
        card.append(player, label);
        layer.append(card);
        view = { card, player, label, playing: false, tile };
        tiles.set(tile.uid, view);
      }
      view.tile = tile;
      if (view.label.textContent !== tile.name) { view.label.textContent = tile.name; view.card.setAttribute("aria-label", tile.name); }
      if (tile.video && !view.playing) view.playing = rtc.play(tile.uid, view.player);
      if (!tile.video) view.playing = false;
      view.card.classList.toggle("has-video", view.playing);
    }
    place();
  }
  function reset(message) {
    for (const view of tiles.values()) view.card.remove();
    tiles.clear();
    render();
    status.textContent = message;
  }
  async function join() {
    if (rtc || !spaceId) return;
    const id = spaceId;
    status.textContent = "Connecting to the call...";
    let AgoraRTC;
    try { ({ AgoraRTC } = await loadSdk()); } catch (error) { if (spaceId === id) status.textContent = "The call couldn't load (" + (error.message || "unknown error") + ")."; return; }
    if (spaceId !== id || rtc) return;
    AgoraRTC.setLogLevel?.(3);
    const client = createRtcClient({
      AgoraRTC,
      fetchCredentials: (uid) => api("/api/spaces/" + encodeURIComponent(id) + "/rtc-token", { method: "POST", body: JSON.stringify(uid ? { uid } : {}) }),
      onChange: () => { if (rtc === client) render(); },
      onError: (message) => { if (rtc === client) say(message); },
      onEnded: (message) => { if (rtc === client) { rtc = null; reset(message); } }
    });
    rtc = client;
    render();
    await client.join({ audio: $("#stoa-call-mic").checked, video: $("#stoa-call-camera").checked });
    if (rtc !== client) return;
    if (!client.snapshot().joined) { rtc = null; await client.leave(); reset("You're not in the call. Try joining again."); return; }
    status.textContent = "You're in the call.";
  }
  async function leave(message) { const client = rtc; rtc = null; await client?.leave(); reset(message); }

  buttons.join.addEventListener("click", join);
  buttons.audio.addEventListener("click", () => rtc?.toggle("audio"));
  buttons.video.addEventListener("click", () => rtc?.toggle("video"));
  buttons.share.addEventListener("click", () => rtc?.share());
  buttons.resume.addEventListener("click", () => rtc?.resumeAudio());
  buttons.leave.addEventListener("click", () => leave("You left the call."));
  engine.on("draw", (next) => { frame = next; if (layout === "over-avatar" && tiles.size) place(); });
  return {
    enter(id) {
      if (spaceId === id) return;
      if (rtc) leave("");
      spaceId = id;
      section.hidden = false;
      reset(secure() ? "Join to talk with everyone in this room. Your mic and camera stay off until you choose." : "Open this page over HTTPS to use your microphone and camera.");
    },
    exit() { spaceId = null; section.hidden = true; if (rtc) leave(""); else reset(""); },
    setLayout(next) { layout = next || "strip"; render(); },
    refresh() { if (rtc) render(); }
  };
}
```

Add `"stoa/call.js"` to `publicFiles` in `scripts/serve.mjs`.

- [ ] **Step 5: Markup, styles, and wiring**

`stoa.html`:
- Wrap the canvas so tiles can sit over it. Replace `<div class="stoa-stage"><canvas ...></canvas><p class="stoa-help" ...>...</p></div>` with:

```html
<div class="stoa-stage"><div class="stoa-view"><canvas id="stoa-canvas" tabindex="0" aria-label="Plaza map" aria-describedby="stoa-help"></canvas><div class="stoa-video" id="stoa-video" data-layout="strip" role="region" aria-label="Call video" hidden></div></div><p class="stoa-help" id="stoa-help">Click or tap to walk. Select the map to use the arrow keys or WASD.</p></div>
```

- Inside `<section class="stoa-here" ...>`, before the `#stoa-leave` button:

```html
              <section class="stoa-call" id="stoa-call" hidden aria-labelledby="stoa-call-title">
                <h3 class="stoa-panel-title" id="stoa-call-title">Call</h3>
                <p class="stoa-call-status" id="stoa-call-status" role="status" aria-live="polite"></p>
                <div class="stoa-call-preflight" id="stoa-call-preflight"><label><input type="checkbox" id="stoa-call-mic" checked> Microphone on</label><label><input type="checkbox" id="stoa-call-camera"> Camera on</label></div>
                <div class="stoa-call-controls">
                  <button class="button button-small" type="button" id="stoa-call-join">Join call</button>
                  <button class="button button-secondary button-small" type="button" id="stoa-call-audio" aria-pressed="false" hidden>Turn mic on</button>
                  <button class="button button-secondary button-small" type="button" id="stoa-call-video" aria-pressed="false" hidden>Turn camera on</button>
                  <button class="button button-secondary button-small" type="button" id="stoa-call-share" aria-pressed="false" hidden>Share screen</button>
                  <button class="button button-secondary button-small" type="button" id="stoa-call-resume" hidden>Play call audio</button>
                  <button class="button button-secondary button-small stoa-call-leave" type="button" id="stoa-call-leave" hidden>Leave call</button>
                </div>
              </section>
```

`styles.css`: append after the `.stoa-signin` rule:

```css
.stoa-view { position: relative; }
.stoa-video { position: absolute; inset: 0; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 8px; padding: 8px; pointer-events: none; overflow: hidden; }
.stoa-video[data-layout="grid"] { inset: 0 0 0 auto; width: min(46%, 520px); display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.stoa-tile { position: relative; width: 168px; aspect-ratio: 16 / 10; overflow: hidden; border: 1px solid var(--line); border-radius: 4px; background: #202824; pointer-events: auto; }
.stoa-video[data-layout="grid"] .stoa-tile { width: auto; }
.stoa-tile.is-screen { width: min(100%, 360px); aspect-ratio: 16 / 9; }
.stoa-tile.is-floating { position: absolute; left: 0; top: 0; width: 96px; }
.stoa-tile-player { position: absolute; inset: 0; }
.stoa-tile-name { position: absolute; left: 6px; bottom: 6px; max-width: calc(100% - 12px); padding: 2px 6px; border-radius: 3px; background: rgba(32, 40, 36, 0.78); color: #f3efe6; font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stoa-call { margin: 4px 0 14px; }
.stoa-call-status { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
.stoa-call-preflight { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 8px; font-size: 12px; }
.stoa-call-preflight label { display: flex; align-items: center; gap: 6px; }
.stoa-call-controls { display: flex; flex-wrap: wrap; gap: 6px; }
.stoa-call-controls [aria-pressed="true"] { background: #e6ebdc; border-color: #98a98a; }
.stoa-call-leave { color: var(--accent); }
@media (prefers-reduced-motion: no-preference) { .stoa-tile.is-floating { transition: opacity 0.2s; } }
```

`stoa.js`:
- `import { createCallView } from "./stoa/call.js";`
- In the theme block, `active` is a `const` arrow function inside `try`. Hoist it so `stoa.js` can reach it later: declare `let active = () => null;` next to `let map = null, engine = null, ...`, and assign `active = () => minimal ? byId.get("minimal") : chosen;` inside the block.
- In the minimal toggle handler, after `engine.setTheme(active());`, add `call?.setLayout(active().video);`. Declare `let call = null;` next to `let live = null, stage = null;`. That declaration comes after the theme block in the file, but the click handler only runs after the page has loaded, so `call` exists by then. Keep it at module scope.
- Add `ids: [state.account?.id, state.profile?.id].filter(Boolean)` to `self`.
- In the `if (engine) {` block, before `stage = createStage(...)`:

```js
  call = createCallView({ engine, api, self, people: () => stage?.people() || [], say: (text) => panel.say(text) });
  call.setLayout(active().video);
```

- Add `onRoom: (room) => room ? call.enter(room.id) : call.exit(), onPeople: () => call.refresh()` to the `createStage({...})` options.
- In the `pagehide` listener, add `call.exit();` before `stage.unload();`.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Check it in a browser**

Start a throwaway server on a free port (never 3002): `PORT=4390 node scripts/serve.mjs --port 4390`. No Agora credentials are configured there, so expect the call UI to say calls aren't connected.
- In a lot room, the Call section shows "Join call" with the mic and camera checkboxes.
- Pressing Join reports "Agora calls are not connected yet." through the status line or panel, and the controls reset.
- On the plaza, the Call section is hidden.

Check desktop (1280×800) and mobile (390×844) widths with headless Chrome, as in Plan C1. Stop the throwaway server afterwards. The live call check with real credentials happens at the end of the plan (Final verification).

- [ ] **Step 8: Commit**

```bash
git add stoa/call.js stoa/stage.js stoa.html stoa.js styles.css scripts/serve.mjs tests/stoa-call.test.mjs tests/stoa-stage.test.mjs tests/spaces-api.test.mjs
git commit -m "Add calls inside Stoa rooms with theme-chosen video layouts

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 5: Decorate mode

**Files:**
- Create: `stoa/decor.js`
- Modify: `stoa/stage.js`, `stoa/panel.js`, `stoa.html`, `stoa.js`, `styles.css`, `scripts/serve.mjs` (`publicFiles`: add `"stoa/decor.js"`)
- Test: `tests/stoa-decor.test.mjs` (create), `tests/stoa-stage.test.mjs`, `tests/stoa-panel.test.mjs`

**Interfaces:**
- Consumes: `engine.setPicking`, `engine.setDecor`, `engine.setInteractive`, `engine.position()`, `engine.facing()`. From Task 1: `place.decorChanged`, `onDecor`. From Task 4: `onRoom`. `DECOR_KINDS` from `world/kinds.js`, `KEYS`/`STEP` from `world/motion.js`, `walkable` from `world/map.js`.
- Produces (pure): `createArrangement({ map, area, items, makeId })` returning:
  - `items()`, `selected()`, `select(id)`, `deselect()`
  - `pick(tile, kind)` → `"selected" | "moved" | "placed" | "blocked" | "full" | "none" | "unknown"`
  - `place(kind, tile)`, `move(dir)`, `rotate()`, `remove()`
  - Limit: 60 items. Free tile means inside `area`, walkable on the map, and not already used.
- Produces (DOM): `createDecorEditor({ doc, canvas, engine, map, onSave(items) -> Promise<boolean>, onClose(), say })` returning `{ open({ items, area }), close(), abort(), isOpen() }`. `close()` restores the original arrangement in the engine; `abort()` just ends editing without restoring.
- Produces (stage):
  - `settle` applies `next.space?.decor || []` to the engine unless editing.
  - `fetchRoom` re-applies the fetched `space.decor`.
  - A `decor` notice from the host or the space owner triggers `refreshRoom()`.
  - New methods: `canManage() -> boolean`, `decorArea() -> rect | null`, `decor() -> items`, `setEditing(boolean)`, `saveDecor(items) -> Promise<boolean>`.
- Produces (panel): `showRoom({ ..., host })` also shows `#stoa-decor-open` when `host`. The panel gets a new handler, `decorate`.

"Host" in the panel means "can do host things": you are the host or the space's owner. The stage computes it with a new helper, `mine(id)`, which checks `self.ids` (falling back to `[self.id]`).

- [ ] **Step 1: Write the failing tests**

Create `tests/stoa-decor.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseMap, walkable } from "../world/map.js";
import { createArrangement } from "../stoa/decor.js";

const room = parseMap(JSON.parse(await readFile(new URL("../worlds/room/map.json", import.meta.url), "utf8")));
const area = { x: 0, y: 0, width: room.width, height: room.height };
// The first three open tiles in a row on the room map.
const open = (() => { for (let y = 0; y < room.height; y += 1) for (let x = 0; x < room.width - 2; x += 1) if ([0, 1, 2].every((dx) => walkable(room, x + dx, y))) return { x, y }; throw new Error("no open row"); })();
let next = 0;
const make = (items = []) => createArrangement({ map: room, area, items, makeId: () => "d" + (next += 1) });

test("placing, selecting, moving, rotating, and removing decorations", () => {
  const decor = make();
  assert.equal(decor.pick(open, "plant"), "placed");
  assert.deepEqual(decor.selected(), { id: "d1", kind: "plant", x: open.x, y: open.y, rotation: 0, variant: 0 });
  assert.equal(decor.move("right"), "moved");
  assert.deepEqual([decor.selected().x, decor.selected().y], [open.x + 1, open.y]);
  assert.equal(decor.rotate(), "rotated");
  assert.equal(decor.selected().rotation, 90);
  decor.deselect();
  assert.equal(decor.pick(open, "sofa"), "placed");
  assert.equal(decor.pick({ x: open.x + 1, y: open.y }), "selected", "a click on a placed item selects it");
  assert.equal(decor.selected().kind, "plant");
  assert.equal(decor.move("left"), "blocked", "the sofa is in the way");
  assert.equal(decor.pick({ x: open.x + 2, y: open.y }), "moved", "a click elsewhere moves the selected item");
  assert.equal(decor.remove(), "removed");
  assert.deepEqual(decor.items().map((item) => item.kind), ["sofa"]);
  assert.equal(decor.remove(), "none");
});
test("decorations stay on open floor inside the area, one per tile, at most 60", () => {
  const decor = createArrangement({ map: room, area: { x: open.x, y: open.y, width: 1, height: 1 }, items: [] , makeId: () => "x" + (next += 1) });
  assert.equal(decor.place("plant", { x: open.x + 1, y: open.y }), "blocked", "outside the area");
  assert.equal(decor.place("dragon", open), "unknown");
  assert.equal(decor.place("plant", open), "placed");
  assert.equal(decor.place("lamp", open), "blocked", "one per tile");
  const full = make(Array.from({ length: 60 }, (_, index) => ({ id: "f" + index, kind: "plant", x: 0, y: index, rotation: 0, variant: 0 })));
  assert.equal(full.place("plant", open), "full");
  assert.equal(full.items().length, 60);
});
test("the working copy never changes the items it was given", () => {
  const items = [{ id: "a", kind: "lamp", x: open.x, y: open.y, rotation: 0, variant: 0 }];
  const decor = make(items);
  decor.select("a"); decor.rotate();
  assert.equal(items[0].rotation, 0);
});
```

In `tests/stoa-stage.test.mjs`:
- Add `decor: []` to the `calls` object, and add `setDecor: (list) => { calls.decor.push(list); }` to the fake `engine`.
- In the fake `createLease`, add `beatNow() { entry.beats = (entry.beats || 0) + 1; return Promise.resolve(); }` to the entry. Task 6 uses it; adding it now keeps the fake complete.
- Append:

```js
test("a room's saved decorations are shown on entry and cleared on the plaza", async () => {
  const items = [{ id: "d1", kind: "plant", x: lot.entry.x + 1, y: lot.entry.y, rotation: 0, variant: 0 }];
  const api = async (path) => path === "/api/spaces/plaza/enter" ? access("plaza", "plaza-1") : path.endsWith("/enter") ? { ...access("lot-" + lot.slug, "lot-ch"), space: { ...space("lot-" + lot.slug), decor: items } } : {};
  const { stage, calls } = setup({ api });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  assert.deepEqual(calls.decor.at(-1), items);
  assert.deepEqual(stage.decor(), items);
  await stage.leaveRoom();
  assert.deepEqual(calls.decor.at(-1), []);
});
test("saving decorations stores them, shows them, and tells the room the new version", async () => {
  const saved = [{ id: "d2", kind: "lamp", x: lot.entry.x, y: lot.entry.y - 1, rotation: 0, variant: 0 }], puts = [];
  const api = async (path, options) => {
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return access("lot-" + lot.slug, "lot-ch");
    if (path.endsWith("/decor")) { puts.push(JSON.parse(options.body)); return { decor: saved, version: 4 }; }
    return {};
  };
  const { stage, calls } = setup({ api });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  assert.equal(stage.canManage(), true, "the first one in hosts the lot");
  assert.deepEqual(stage.decorArea(), lot.interior);
  assert.equal(await stage.saveDecor(saved), true);
  assert.deepEqual(puts, [{ items: saved }]);
  assert.deepEqual(calls.decor.at(-1), saved);
  assert.ok(calls.published.includes(JSON.stringify({ t: "decor", version: 4 })));
});
test("a decor notice from the host refetches the room; from anyone else it is ignored", async () => {
  const { gets, calls } = await inLot();
  const handlers = calls.handlers["lot-ch"];
  handlers.message(guestUser, JSON.stringify({ t: "decor", version: 2 }));
  await tick();
  assert.equal(gets.length, 0);
  handlers.message(hostUser, JSON.stringify({ t: "decor", version: 2 }));
  await tick();
  assert.equal(gets.length, 1);
});
```

`inLot`, `hostUser`, `guestUser`, `present` and `hostActor` already exist in this file.

In `tests/stoa-panel.test.mjs`, append:

```js
test("the Decorate button shows only for the host and calls the decorate handler", () => {
  const doc = fakeDocument(), panel = createPanel(doc);
  let opened = 0;
  panel.on({ decorate: () => { opened += 1; } });
  panel.showRoom({ kicker: "LOT ROOM", title: "AI agents", topic: null, tags: [], host: false, leaveLabel: "Back" });
  assert.equal(doc.querySelector("#stoa-decor-open").hidden, true);
  panel.showRoom({ kicker: "LOT ROOM", title: "AI agents", topic: null, tags: [], host: true, leaveLabel: "Back" });
  assert.equal(doc.querySelector("#stoa-decor-open").hidden, false);
  doc.querySelector("#stoa-decor-open").listeners.click();
  assert.equal(opened, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/stoa-decor.test.mjs tests/stoa-stage.test.mjs tests/stoa-panel.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `stoa/decor.js`**

```js
import { walkable } from "../world/map.js";
import { DECOR_KINDS } from "../world/kinds.js";
import { KEYS, STEP } from "../world/motion.js";

export const DECOR_LABELS = { plant: "Plant", lamp: "Lamp", rug: "Rug", sofa: "Sofa", chair: "Chair", table: "Table", whiteboard: "Whiteboard", bookshelf: "Bookshelf", screen: "Screen", banner: "Banner", poster: "Poster", statue: "Statue", fountain: "Fountain" };
const LIMIT = 60;

// The host's working copy of a room's decorations. The server checks the whole arrangement on save; this keeps edits sensible.
export function createArrangement({ map, area, items = [], makeId = () => "d" + Math.random().toString(36).slice(2, 10) }) {
  let list = items.map((item) => ({ ...item })), selected = null;
  const inside = (tile) => tile.x >= area.x && tile.y >= area.y && tile.x < area.x + area.width && tile.y < area.y + area.height;
  const free = (tile, except = null) => inside(tile) && walkable(map, tile.x, tile.y) && !list.some((item) => item !== except && item.x === tile.x && item.y === tile.y);
  const current = () => list.find((item) => item.id === selected) || null;
  const arrangement = {
    items: () => list.map((item) => ({ ...item })),
    selected: () => current() ? { ...current() } : null,
    select(id) { selected = list.some((item) => item.id === id) ? id : null; return Boolean(selected); },
    deselect() { selected = null; },
    // A click on a placed item selects it; elsewhere it moves the selected item there, or places the chosen kind.
    pick(tile, kind) {
      const hit = list.find((item) => item.x === tile.x && item.y === tile.y);
      if (hit) { selected = hit.id; return "selected"; }
      const item = current();
      if (item) { if (!free(tile, item)) return "blocked"; item.x = tile.x; item.y = tile.y; return "moved"; }
      return kind ? arrangement.place(kind, tile) : "none";
    },
    place(kind, tile) {
      if (!DECOR_KINDS.includes(kind)) return "unknown";
      if (list.length >= LIMIT) return "full";
      if (!free(tile)) return "blocked";
      const item = { id: makeId(), kind, x: tile.x, y: tile.y, rotation: 0, variant: 0 };
      list.push(item); selected = item.id;
      return "placed";
    },
    move(dir) {
      const item = current();
      if (!item) return "none";
      const [dx, dy] = STEP[dir], next = { x: item.x + dx, y: item.y + dy };
      if (!free(next, item)) return "blocked";
      item.x = next.x; item.y = next.y;
      return "moved";
    },
    rotate() { const item = current(); if (!item) return "none"; item.rotation = (item.rotation + 90) % 360; return "rotated"; },
    remove() { const item = current(); if (!item) return "none"; list = list.filter((entry) => entry !== item); selected = null; return "removed"; }
  };
  return arrangement;
}

const OUTCOMES = { blocked: "That tile is taken, blocked, or outside the room.", full: "A room holds up to 60 decorations.", none: "Choose a decoration first, or select one on the map." };
// Decor mode: the map picks tiles instead of walking, and the panel lists every item for keyboard and screen reader users.
export function createDecorEditor({ doc = document, canvas, engine, map, onSave = async () => false, onClose = () => {}, say = () => {} }) {
  const $ = (selector) => doc.querySelector(selector);
  const section = $("#stoa-decor"), palette = $("#stoa-palette"), list = $("#stoa-decor-list"), save = $("#stoa-decor-save");
  let arrangement = null, original = [], kind = null;
  const describe = (item) => DECOR_LABELS[item.kind] + " at " + item.x + ", " + item.y + (item.rotation ? ", turned " + item.rotation + "°" : "");
  const kindButtons = DECOR_KINDS.map((entry) => {
    const button = doc.createElement("button");
    button.type = "button"; button.className = "button button-secondary button-small"; button.textContent = DECOR_LABELS[entry];
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => { kind = kind === entry ? null : entry; arrangement?.deselect(); render(); });
    palette.append(button);
    return [entry, button];
  });
  function render() {
    if (!arrangement) return;
    engine.setDecor(arrangement.items());
    for (const [entry, button] of kindButtons) button.setAttribute("aria-pressed", String(kind === entry));
    const chosen = arrangement.selected();
    list.replaceChildren(...arrangement.items().map((item) => {
      const row = doc.createElement("li"), button = doc.createElement("button");
      button.type = "button"; button.textContent = describe(item);
      if (chosen?.id === item.id) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => { arrangement.select(item.id); render(); canvas.focus(); });
      row.append(button);
      return row;
    }));
    $("#stoa-decor-selected").textContent = chosen ? "Selected: " + describe(chosen) + ". Arrow keys move it, R turns it, Delete removes it." : kind ? "Click the map to place a " + DECOR_LABELS[kind].toLowerCase() + "." : "Choose a decoration, or select one to move it.";
  }
  const report = (outcome) => { if (OUTCOMES[outcome]) say(OUTCOMES[outcome]); render(); };
  const onKey = (event) => {
    if (!arrangement || event.ctrlKey || event.metaKey || event.altKey) return;
    const dir = KEYS[event.key];
    if (dir) { event.preventDefault(); report(arrangement.move(dir)); }
    else if (event.key === "r" || event.key === "R") { event.preventDefault(); report(arrangement.rotate()); }
    else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); report(arrangement.remove()); }
    else if (event.key === "Escape") { arrangement.deselect(); kind = null; render(); }
  };
  function finish(restore) {
    if (!arrangement) return;
    canvas.removeEventListener("keydown", onKey);
    engine.setPicking(null);
    engine.setInteractive(true);
    if (restore) engine.setDecor(original);
    arrangement = null; kind = null;
    section.hidden = true;
    onClose();
  }
  $("#stoa-decor-here").addEventListener("click", () => {
    if (!arrangement) return;
    const at = engine.position(), [dx, dy] = STEP[engine.facing()] || [0, 1];
    report(kind ? arrangement.place(kind, { x: at.x + dx, y: at.y + dy }) : "none");
  });
  save.addEventListener("click", async () => {
    if (!arrangement) return;
    save.disabled = true;
    try { if (await onSave(arrangement.items())) finish(false); } finally { save.disabled = false; }
  });
  $("#stoa-decor-cancel").addEventListener("click", () => finish(true));
  return {
    open({ items = [], area }) {
      if (arrangement) return;
      original = items.map((item) => ({ ...item }));
      arrangement = createArrangement({ map, area: area || { x: 0, y: 0, width: map.width, height: map.height }, items: original });
      engine.setInteractive(false);
      engine.setPicking((tile) => report(arrangement.pick(tile, kind)));
      canvas.addEventListener("keydown", onKey);
      section.hidden = false;
      render();
    },
    close: () => finish(true),
    abort: () => finish(false),
    isOpen: () => Boolean(arrangement)
  };
}
```

`DECOR_LABELS` must cover all 13 entries of `DECOR_KINDS` (they match the spec list).

Add `"stoa/decor.js"` to `publicFiles`.

- [ ] **Step 4: Implement the stage changes**

In `stoa/stage.js`:
- Add `currentDecor = [], editing = false` to the `let` declarations.
- Add helpers after `showRoom`. Also change `showRoom` so `host` uses `mine`:

```js
  const mine = (id) => Boolean(id) && (self.ids || [self.id]).includes(id);
  const canManage = () => Boolean(here && (here.kind === "lot" || here.kind === "space") && here.leased && self.signedIn && (mine(here.access?.hostId) || mine(here.space?.ownerId)));
  const showDecor = (items) => { currentDecor = items || []; if (!editing) engine.setDecor(currentDecor); };
```

  In `showRoom`, replace `host: Boolean(self.id) && hostId === self.id` with `host: Boolean(self.id) && (mine(hostId) || mine(space.ownerId))`.
- In `settle(next)`, after the `onRoom` block from Task 4, add `editing = false; showDecor(next.space?.decor);`. A transition always ends editing; `stoa.js` aborts the editor through `onRoom`.
- In the `openPlace({...})` call inside `settle`, add:

```js
onDecor: (from) => { if (here === next && from && (from === next.access?.hostId || from === next.space?.ownerId)) refreshRoom(); }
```

- In `fetchRoom`, after `if (here === at) showRoom(space, space.hostId);`, turn the `if` into a block that also calls `showDecor(space.decor);`.
- Add to the returned object:

```js
    canManage,
    decor: () => currentDecor,
    decorArea: () => here?.kind === "lot" ? here.lot.interior : here?.kind === "space" ? { x: 0, y: 0, width: map.width, height: map.height } : null,
    setEditing(value) { editing = Boolean(value); if (!editing) engine.setDecor(currentDecor); },
    async saveDecor(items) {
      const at = here;
      if (!canManage()) { panel.say("Only the host can decorate."); return false; }
      try {
        const result = await api("/api/spaces/" + encodeURIComponent(at.space.id) + "/decor", { method: "PUT", body: JSON.stringify({ items }) });
        if (here !== at) return false;
        editing = false;
        showDecor(result.decor);
        for (const place of places) place.decorChanged(result.version);
        panel.say("Decorations saved.");
        return true;
      } catch (error) { if (here === at) panel.say(error.message); return false; }
    },
```

- [ ] **Step 5: Panel, markup, styles, wiring**

`stoa/panel.js`:
- Add `decorate() {}` to `handlers`.
- Wire it: `$("#stoa-decor-open").addEventListener("click", () => handlers.decorate());`
- In `showRoom`, add `$("#stoa-decor-open").hidden = !host;`.
- In `showPlaza`, add `$("#stoa-decor-open").hidden = true;`.

`stoa.html`: inside `#stoa-here`, after the topic form, add:

```html
              <button class="button button-secondary button-small" type="button" id="stoa-decor-open" hidden>Decorate</button>
              <section class="stoa-decor" id="stoa-decor" hidden aria-labelledby="stoa-decor-title">
                <h3 class="stoa-panel-title" id="stoa-decor-title">Decorate</h3>
                <p class="stoa-decor-selected" id="stoa-decor-selected" aria-live="polite"></p>
                <div class="stoa-palette" id="stoa-palette" role="group" aria-label="Decorations"></div>
                <button class="button button-secondary button-small" type="button" id="stoa-decor-here">Place in front of me</button>
                <ul class="stoa-decor-list" id="stoa-decor-list" aria-label="Placed decorations"></ul>
                <div class="stoa-decor-actions"><button class="button button-small" type="button" id="stoa-decor-save">Save decorations</button><button class="button button-secondary button-small" type="button" id="stoa-decor-cancel">Cancel</button></div>
              </section>
```

`styles.css`, appended:

```css
.stoa-decor { margin: 10px 0 14px; padding: 12px; border: 1px solid var(--line); border-radius: 4px; }
.stoa-decor-selected { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
.stoa-palette { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.stoa-palette [aria-pressed="true"] { background: #e6ebdc; border-color: #98a98a; }
.stoa-decor-list { list-style: none; margin: 8px 0; padding: 0; max-height: 160px; overflow-y: auto; font-size: 12px; }
.stoa-decor-list button { background: none; border: 0; padding: 3px 0; font: inherit; color: inherit; cursor: pointer; text-align: left; }
.stoa-decor-list [aria-current="true"] { color: var(--accent); font-weight: 600; }
.stoa-decor-actions { display: flex; gap: 6px; }
```

`stoa.js`:
- `import { createDecorEditor } from "./stoa/decor.js";`
- In the `if (engine) {` block, before `createStage`:

```js
  decor = createDecorEditor({ canvas, engine, map, say: (text) => panel.say(text), onSave: (items) => stage.saveDecor(items), onClose: () => stage.setEditing(false) });
```

- Change `onRoom` to `(room) => { decor?.abort(); if (room) call.enter(room.id); else call.exit(); }`.
- Register the panel handler (the existing `panel.on({...})` call; add an entry):

```js
  decorate: () => {
    if (!stage?.canManage()) { panel.say("Only the host can decorate."); return; }
    stage.setEditing(true);
    decor.open({ items: stage.decor(), area: stage.decorArea() });
    panel.say("Decor mode is on. Choose a decoration, then click the map or use Place in front of me.");
    canvas.focus();
  },
```

  Declare `let decor = null;` at module scope next to `call` (the handler runs only after the block assigns it), and write the handler's open call as `decor?.open(...)`.
- `onClose` runs whenever editing ends (save, cancel, or abort), so the stage's `editing` flag always clears.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Check it in a browser**

On a throwaway server (not 3002), sign in as a test profile, walk into a lot room as the first person, and press Decorate.
- Choose Plant and click a floor tile. It appears and the list shows "Plant at x, y".
- Select it in the list, then press the arrow keys, R, and Delete. Each one works.
- Save. "Decorations saved." appears and the plant stays.
- Cancel after a change. The saved arrangement returns.

Check at desktop and mobile widths.

- [ ] **Step 8: Commit**

```bash
git add stoa/decor.js stoa/stage.js stoa/panel.js stoa.html stoa.js styles.css scripts/serve.mjs tests/stoa-decor.test.mjs tests/stoa-stage.test.mjs tests/stoa-panel.test.mjs
git commit -m "Add decorate mode for room hosts

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 6: Host tools — hand over and remove

**Files:**
- Modify: `stoa/panel.js` (`setPeople`, `peopleKey`, handlers), `stoa/stage.js`, `stoa.js`, `styles.css`
- Test: `tests/stoa-panel.test.mjs`, `tests/stoa-stage.test.mjs`

**Interfaces:**
- Consumes: `POST /api/spaces/<id>/host { actorId }` → `{ hostId }`. `POST /api/spaces/<id>/remove { actorId }` → `{ removed, channel, key, blocked, hostId }`. From Task 1: `place.rekey()`, `onRekey`, `lease.beatNow()`. From Task 5: `canManage()`.
- Produces (panel):
  - `setPeople(list, selfName, { manage = false, hostId = null, selfId = null } = {})`. A host badge marks whoever is host, including you. When `manage` is true, each other person gets "Make host" (unless they already are) and "Remove" buttons.
  - `peopleKey(list, selfName, options)` includes `manage` and `hostId`, so the list rebuilds when either changes.
  - New handlers: `makeHost(person)`, `remove(person)`.
- Produces (stage): `makeHost(person)`, `removePerson(person)`. A `rekey` notice from the host or owner makes the lease heartbeat at once (`lease.beatNow()`).

- [ ] **Step 1: Write the failing tests**

`tests/stoa-panel.test.mjs`. The fake `Element` needs `classList` and `type`; extend its constructor with `classList: { toggle() {}, add() {} }`. Then append:

```js
test("hosts get Make host and Remove for everyone else; the host is marked", () => {
  const doc = fakeDocument(), panel = createPanel(doc), calls = [];
  panel.on({ makeHost: (person) => calls.push(["host", person.id]), remove: (person) => calls.push(["remove", person.id]) });
  const list = [{ id: "account:a", name: "Ada" }, { id: "account:b", name: "Bo" }];
  panel.setPeople(list, "Me", { manage: false, hostId: "account:a", selfId: "account:me" });
  const people = doc.querySelector("#stoa-people");
  const text = (item) => [item.textContent, ...item.children.map((child) => child.textContent)].join("|");
  assert.match(text(people.children[1]), /host/, "Ada is marked as host");
  assert.equal(people.children[1].children.some((child) => child.tagName === "button"), false, "no tools without manage");
  panel.setPeople(list, "Me", { manage: true, hostId: "account:me", selfId: "account:me" });
  assert.match(text(people.children[0]), /host/, "you are marked as host");
  const buttons = people.children[1].children.filter((child) => child.tagName === "button");
  assert.deepEqual(buttons.map((button) => button.textContent), ["Make host", "Remove"]);
  buttons[0].listeners.click(); buttons[1].listeners.click();
  assert.deepEqual(calls, [["host", "account:a"], ["remove", "account:a"]]);
  assert.match(buttons[1].attrs["aria-label"], /Remove Ada/);
});
test("the people key changes with manage and host", () => {
  const list = [{ id: "account:a", name: "Ada" }];
  assert.notEqual(peopleKey(list, "Me", { manage: true }), peopleKey(list, "Me", { manage: false }));
  assert.notEqual(peopleKey(list, "Me", { hostId: "account:a" }), peopleKey(list, "Me", { hostId: null }));
});
```

`tests/stoa-stage.test.mjs`, appended:

```js
test("the host can hand over hosting; the room stops offering host tools", async () => {
  const posts = [];
  const api = async (path, options) => {
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return access("lot-" + lot.slug, "lot-ch");
    if (path.endsWith("/host")) { posts.push(JSON.parse(options.body)); return { hostId: "account:72a639ba-3a45-4afe-936b-222222222222" }; }
    return {};
  };
  const { stage, calls } = setup({ api });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  await stage.makeHost({ id: "account:72a639ba-3a45-4afe-936b-222222222222", name: "Ada" });
  assert.deepEqual(posts, [{ actorId: "account:72a639ba-3a45-4afe-936b-222222222222" }]);
  assert.equal(calls.showRoom.at(-1).host, false);
  assert.equal(stage.canManage(), false);
  assert.ok(calls.published.includes(JSON.stringify({ t: "refresh" })), "the room is told to refresh");
});
test("removing someone tells the room to check access, then reopens on the new channel", async () => {
  const api = async (path) => {
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return access("space-1", "space-ch");
    if (path.endsWith("/remove")) return { removed: true, channel: "space-ch-2", key: null, blocked: ["account:bad"], hostId: "a-me" };
    return {};
  };
  const { stage, calls } = setup({ api });
  await stage.openSpace("space-1");
  await stage.removePerson({ id: "account:bad", name: "Bad" });
  assert.ok(calls.published.includes(JSON.stringify({ t: "rekey" })));
  assert.deepEqual(calls.joined.slice(-1), ["space-ch-2"]);
  assert.ok(calls.left.includes("space-ch"));
});
test("a rekey from the host makes the lease check in now; from anyone else it is ignored", async () => {
  const { calls, leases } = await inLot();
  const handlers = calls.handlers["lot-ch"], lease = leases.at(-1);
  handlers.message(guestUser, JSON.stringify({ t: "rekey" }));
  assert.equal(lease.beats || 0, 0);
  handlers.message(hostUser, JSON.stringify({ t: "rekey" }));
  assert.equal(lease.beats, 1);
});
```

If `openSpace` in the test setup needs the live connection to have joined (`withLive` defaults to true) and `access()` returns `hostId: "a-me"` with `self.id = "a-me"`, then `canManage()` is true for the space. Keep these values.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/stoa-panel.test.mjs tests/stoa-stage.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the panel**

`stoa/panel.js`:

```js
// People are rebuilt only when who is here, a name, the host, or your host tools change, so a busy plaza doesn't churn the page.
export const peopleKey = (list, selfName, { manage = false, hostId = null } = {}) => [selfName, manage ? "manage" : "", hostId || ""].join("\u0001") + "\n" + list.map((person) => person.id + "\u0000" + person.name).sort().join("\n");
```

- Add `makeHost() {}, remove() {}` to `handlers`.
- Replace `setPeople`:

```js
    setPeople(list, selfName, options = {}) {
      const { manage = false, hostId = null, selfId = null } = options;
      const key = peopleKey(list, selfName, options);
      if (key === shownPeople) return;
      shownPeople = key;
      const row = (name, isHost) => { const item = node("li", "", "stoa-person"); item.append(node("span", name)); if (isHost) item.append(node("span", "host", "stoa-host-badge")); return item; };
      const tool = (text, label, action) => { const button = node("button", text, "button button-secondary button-small"); button.type = "button"; button.setAttribute("aria-label", label); button.addEventListener("click", action); return button; };
      people.replaceChildren(row(selfName + " (you)", Boolean(selfId) && selfId === hostId), ...list.map((person) => {
        const item = row(person.name, person.id === hostId);
        if (manage) {
          if (person.id !== hostId) item.append(tool("Make host", "Make " + person.name + " the host", () => handlers.makeHost(person)));
          item.append(tool("Remove", "Remove " + person.name + " from this room", () => handlers.remove(person)));
        }
        return item;
      }));
    },
```

`styles.css`:

```css
.stoa-person { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.stoa-person > span:first-child { margin-right: auto; }
.stoa-host-badge { font: 10px var(--mono); letter-spacing: 1px; text-transform: uppercase; color: var(--accent); border: 1px solid currentColor; border-radius: 3px; padding: 1px 5px; }
```

- [ ] **Step 4: Implement the stage**

In `stoa/stage.js`:
- In `showPeople`'s callback, change `panel.setPeople(list, self.name)` to:

```js
      panel.setPeople(list, self.name, { manage: canManage(), hostId: here?.kind === "lot" || here?.kind === "space" ? here.access?.hostId || null : null, selfId: self.id });
```

  `canManage` is a `const` arrow declared after `showPeople`. The scheduled callback runs later, so that is fine.
- `showRoom` → also call `showPeople()` at its end, so host changes refresh the tools.
- In the `openPlace` options in `settle`, add:

```js
onRekey: (from) => { if (here === next && from && (from === next.access?.hostId || from === next.space?.ownerId)) lease?.beatNow(); }
```

- Add two functions after `setTopic`:

```js
  async function makeHost(person) {
    const at = here;
    if (!canManage()) return;
    try {
      const { hostId } = await api("/api/spaces/" + encodeURIComponent(at.space.id) + "/host", { method: "POST", body: JSON.stringify({ actorId: person.id }) });
      if (here !== at) return;
      at.access = { ...at.access, hostId };
      showRoom(at.space, hostId);
      for (const place of places) place.refresh();
      panel.say(person.name + " is the host now.");
    } catch (error) { if (here === at) panel.say(error.message); }
  }
  // Removal blocks the person and, in private and unlisted spaces, moves everyone else to a new channel.
  async function removePerson(person) {
    const at = here;
    if (!canManage()) return;
    try {
      const access = await api("/api/spaces/" + encodeURIComponent(at.space.id) + "/remove", { method: "POST", body: JSON.stringify({ actorId: person.id }) });
      if (here !== at) return;
      await Promise.all(places.map((place) => place.rekey()));
      panel.say(person.name + " was removed from this room.");
      onAccess(access, at);
      await chain;
    } catch (error) { if (here === at) panel.say(error.message); }
  }
```

  `onAccess` already reopens on a new channel through `transition` (renew, then `settle`) and applies `blocked` otherwise. `await chain` lets the test observe the reopened channel.
- Add `makeHost, removePerson,` to the returned object.

`stoa.js`, in `panel.on({...})`:

```js
  makeHost: (person) => stage?.makeHost(person),
  remove: (person) => { if (confirm("Remove " + person.name + " from this room? They can't come back until the room empties or the owner allows them back.")) stage?.removePerson(person); },
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add stoa/panel.js stoa/stage.js stoa.js styles.css tests/stoa-panel.test.mjs tests/stoa-stage.test.mjs
git commit -m "Let hosts hand over hosting and remove people

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 7: Create and manage your spaces

**Files:**
- Create: `stoa/spaces.js`
- Modify: `stoa.html`, `stoa.js`, `stoa/panel.js` (Manage button), `stoa/stage.js` (owner flag), `styles.css`, `scripts/serve.mjs` (`publicFiles`: add `"stoa/spaces.js"`)
- Test: `tests/stoa-spaces.test.mjs` (create), `tests/stoa-panel.test.mjs`, `tests/spaces-api.test.mjs` (markup ids)

**Interfaces:**
- Consumes: `GET /api/spaces/mine` and `roster`/`blockedRoster` from Task 3. Also `POST /api/spaces`, `PUT/DELETE /api/spaces/<id>`, `POST /api/spaces/<id>/invitations {}` → `{ path, usesLeft, expiresAt }`, `POST /api/spaces/<id>/members { memberId }`, `DELETE /api/spaces/<id>/members/<memberId>`.
- Produces (pure):
  - `spacePayload(values) -> { title, purpose, visibility, access, capacity, themeId }`. Private forces access to `members`; unknown visibility becomes `unlisted`; capacity is parsed as an integer.
  - `describeSpace(space) -> string`
  - `inviteUrl(origin, path) -> string`
- Produces (DOM): `createSpacesUi({ doc, api, say, navigate, confirm, copy, origin })` returning `{ showMine(listing), openCreate(prefill), openManage(spaceId) }`.
- Produces (panel): `showRoom({ ..., owner })` shows `#stoa-manage` when `owner`. New handler `manage`. `showPlaza()` shows `#stoa-mine-section` only when `setSignedIn(true)` was called. New panel method `setSignedIn(value)`.
- Produces (stage): `showRoom` passes `owner: here?.kind === "space" && mine(space.ownerId)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/stoa-spaces.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSpace, inviteUrl, spacePayload } from "../stoa/spaces.js";

test("form values become a valid space request", () => {
  assert.deepEqual(spacePayload({ title: "  Lab  ", purpose: " Pairing ", visibility: "private", access: "open", capacity: "8", themeId: "cyberpunk" }), { title: "Lab", purpose: "Pairing", visibility: "private", access: "members", capacity: 8, themeId: "cyberpunk" });
  assert.deepEqual(spacePayload({ title: "Lab", visibility: "listed", access: "house", capacity: "12" }), { title: "Lab", purpose: "", visibility: "unlisted", access: "house", capacity: 12, themeId: "agora" });
  assert.equal(spacePayload({ title: "Lab", access: "everyone", capacity: "x" }).access, "members");
  assert.ok(Number.isNaN(spacePayload({ title: "Lab", capacity: "x" }).capacity), "the server reports a bad capacity");
});
test("spaces are described in plain words, and invite links are absolute", () => {
  assert.equal(describeSpace({ visibility: "private", access: "members", occupancy: 2 }), "Private · members only · 2 here");
  assert.equal(describeSpace({ visibility: "unlisted", access: "open", occupancy: 0 }), "Unlisted · anyone with the link · 0 here");
  assert.equal(inviteUrl("https://agora.build", "/stoa/s/abc?invite=xyz"), "https://agora.build/stoa/s/abc?invite=xyz");
});
```

`tests/stoa-panel.test.mjs`, appended:

```js
test("Manage shows only for the owner; your spaces only for signed-in people on the plaza", () => {
  const doc = fakeDocument(), panel = createPanel(doc);
  let managed = 0;
  panel.on({ manage: () => { managed += 1; } });
  panel.showRoom({ kicker: "UNLISTED SPACE", title: "Lab", topic: null, tags: [], host: true, owner: false, leaveLabel: "Leave" });
  assert.equal(doc.querySelector("#stoa-manage").hidden, true);
  panel.showRoom({ kicker: "UNLISTED SPACE", title: "Lab", topic: null, tags: [], host: true, owner: true, leaveLabel: "Leave" });
  assert.equal(doc.querySelector("#stoa-manage").hidden, false);
  doc.querySelector("#stoa-manage").listeners.click();
  assert.equal(managed, 1);
  panel.showPlaza();
  assert.equal(doc.querySelector("#stoa-mine-section").hidden, true);
  panel.setSignedIn(true);
  panel.showPlaza();
  assert.equal(doc.querySelector("#stoa-mine-section").hidden, false);
});
```

`tests/spaces-api.test.mjs`: add `"stoa-mine-section", "stoa-new", "space-dialog", "manage-dialog", "stoa-manage"` to the Stoa markup id list, and `"/stoa/spaces.js"` to the module list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/stoa-spaces.test.mjs tests/stoa-panel.test.mjs tests/spaces-api.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `stoa/spaces.js`**

```js
// Your own spaces: the list on the plaza, the create dialog, and the owner's manage dialog (settings, invites, members).
export const THEME_CHOICES = [["agora", "Agora"], ["minimal", "Minimal"], ["cyberpunk", "Cyberpunk"]];
const ACCESS_WORDS = { open: "anyone with the link", house: "house members", members: "members only" };
export function spacePayload(values) {
  const visibility = values.visibility === "private" ? "private" : "unlisted";
  const access = visibility === "private" ? "members" : Object.hasOwn(ACCESS_WORDS, values.access) ? values.access : "members";
  return { title: String(values.title || "").trim(), purpose: String(values.purpose || "").trim(), visibility, access, capacity: Number.parseInt(values.capacity, 10), themeId: THEME_CHOICES.some(([id]) => id === values.themeId) ? values.themeId : "agora" };
}
export const describeSpace = (space) => [space.visibility === "private" ? "Private" : "Unlisted", ACCESS_WORDS[space.access] || "members only", space.occupancy + " here"].join(" · ");
export const inviteUrl = (origin, path) => new URL(path, origin).href;

export function createSpacesUi({ doc = document, api, say = () => {}, navigate = (path) => location.assign(path), confirm = (text) => window.confirm(text), copy = (text) => navigator.clipboard.writeText(text), origin = location.origin }) {
  const $ = (selector) => doc.querySelector(selector);
  const node = (tag, text, className) => { const element = doc.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
  const createDialog = $("#space-dialog"), createForm = $("#space-form"), manageDialog = $("#manage-dialog"), manageForm = $("#manage-form");
  let managing = null;
  // Private spaces admit members and invited people only, so the access choice is locked to members.
  const lockAccess = (form) => { const priv = form.elements.visibility.value === "private"; if (priv) form.elements.access.value = "members"; form.elements.access.disabled = priv; };
  for (const form of [createForm, manageForm]) form.elements.visibility.addEventListener("change", () => lockAccess(form));
  const fill = (form, space) => { for (const field of ["title", "purpose", "visibility", "access", "capacity", "themeId"]) form.elements[field].value = space[field] ?? ""; lockAccess(form); };
  const values = (form) => spacePayload(Object.fromEntries(["title", "purpose", "visibility", "access", "capacity", "themeId"].map((field) => [field, form.elements[field].value])));

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = createForm.querySelector("[type=submit]"), error = $("#space-error");
    button.disabled = true; error.textContent = "";
    try { const { space } = await api("/api/spaces", { method: "POST", body: JSON.stringify(values(createForm)) }); navigate("/stoa/s/" + space.id); }
    catch (failure) { error.textContent = failure.message; }
    finally { button.disabled = false; }
  });

  // `keep` is a person who gets no button: the server keeps the owner a member.
  function people(list, selector, label, action, keep = null) {
    $(selector).replaceChildren(...list.map((person) => {
      const item = node("li", "", "manage-person");
      item.append(node("span", person.name));
      if (action && person.id !== keep) { const button = node("button", label, "button button-secondary button-small"); button.type = "button"; button.setAttribute("aria-label", label + ": " + person.name); button.addEventListener("click", () => action(person)); item.append(button); }
      return item;
    }));
    if (!list.length) $(selector).replaceChildren(node("li", "Nobody yet.", "muted"));
  }
  async function load(id) {
    const { space } = await api("/api/spaces/" + encodeURIComponent(id));
    managing = space;
    fill(manageForm, space);
    $("#manage-title").textContent = "Manage " + space.title;
    people(space.roster || [], "#manage-members", "Remove", async (person) => {
      if (!confirm("Remove " + person.name + " from the members of " + space.title + "?")) return;
      try { await api("/api/spaces/" + encodeURIComponent(space.id) + "/members/" + encodeURIComponent(person.id), { method: "DELETE" }); await load(space.id); say(person.name + " is no longer a member."); }
      catch (error) { $("#manage-error").textContent = error.message; }
    }, space.ownerId);
    people(space.blockedRoster || [], "#manage-blocked", "Allow back", async (person) => {
      try { await api("/api/spaces/" + encodeURIComponent(space.id) + "/members", { method: "POST", body: JSON.stringify({ memberId: person.id }) }); await load(space.id); say(person.name + " can come back."); }
      catch (error) { $("#manage-error").textContent = error.message; }
    });
  }
  manageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("#manage-error");
    error.textContent = "";
    try { const { space } = await api("/api/spaces/" + encodeURIComponent(managing.id), { method: "PUT", body: JSON.stringify(values(manageForm)) }); managing = { ...managing, ...space }; say("Space settings saved."); }
    catch (failure) { error.textContent = failure.message; }
  });
  $("#manage-invite").addEventListener("click", async () => {
    try {
      const invite = await api("/api/spaces/" + encodeURIComponent(managing.id) + "/invitations", { method: "POST", body: "{}" });
      const field = $("#manage-invite-url");
      field.value = inviteUrl(origin, invite.path);
      field.hidden = false; $("#manage-copy").hidden = false;
      $("#manage-invite-note").textContent = "Works " + invite.usesLeft + " times until " + new Date(invite.expiresAt).toLocaleString() + ". Anyone with it can join as a member.";
    } catch (error) { $("#manage-error").textContent = error.message; }
  });
  $("#manage-copy").addEventListener("click", async () => {
    try { await copy($("#manage-invite-url").value); say("Invite link copied."); }
    catch { $("#manage-invite-url").select?.(); say("Copy the selected link."); }
  });
  $("#manage-delete").addEventListener("click", async () => {
    if (!managing || !confirm("Delete " + managing.title + " for everyone? This can't be undone.")) return;
    try { await api("/api/spaces/" + encodeURIComponent(managing.id), { method: "DELETE" }); navigate("/stoa/"); }
    catch (error) { $("#manage-error").textContent = error.message; }
  });

  return {
    showMine({ spaces = [], canCreate = false, owned = 0, limit = 0 } = {}) {
      $("#stoa-mine").replaceChildren(...(spaces.length ? spaces.map((space) => {
        const item = node("li", "", "stoa-room"), link = node("a", space.title);
        link.href = space.path;
        item.append(link, node("span", describeSpace(space) + (space.owner ? "" : " · member")));
        return item;
      }) : [node("li", "You don't have any spaces yet.", "muted")]));
      $("#stoa-new").disabled = !canCreate;
      $("#stoa-mine-note").textContent = canCreate ? "" : "You own " + owned + " of " + limit + " spaces your plan allows.";
    },
    openCreate(prefill = {}) {
      createForm.reset();
      fill(createForm, { title: "", purpose: "", visibility: "unlisted", access: "members", capacity: 12, themeId: "agora", ...prefill });
      $("#space-error").textContent = "";
      createDialog.showModal();
    },
    async openManage(id) {
      $("#manage-error").textContent = "";
      $("#manage-invite-url").hidden = true; $("#manage-copy").hidden = true; $("#manage-invite-note").textContent = "";
      try { await load(id); manageDialog.showModal(); }
      catch (error) { say(error.message); }
    }
  };
}
```

Add `"stoa/spaces.js"` to `publicFiles`.

- [ ] **Step 4: Markup, panel, stage, styles, wiring**

`stoa.html`:
- In the panel, after the `#stoa-rooms-section` section:

```html
            <section id="stoa-mine-section" hidden aria-labelledby="stoa-mine-title">
              <h2 class="stoa-panel-title" id="stoa-mine-title">Your spaces</h2>
              <ul class="stoa-rooms" id="stoa-mine"></ul>
              <p class="stoa-mine-note" id="stoa-mine-note"></p>
              <button class="button button-small" type="button" id="stoa-new">Start a space</button>
            </section>
```

- In `#stoa-here`, after `#stoa-decor-open`: `<button class="button button-secondary button-small" type="button" id="stoa-manage" hidden>Manage space</button>`
- Replace the legacy `#room-dialog` dialog in `stoa.html` with the two new dialogs. `script.js` still needs `#room-form` on the page until Task 8. To keep it from throwing, Task 7 keeps the `#room-dialog` markup as is; Task 8 removes it everywhere. Add the new dialogs before `<div id="toast"...>`:

```html
  <dialog id="space-dialog" aria-labelledby="space-title">
    <div class="dialog-head"><span class="kicker">A PLACE OF YOUR OWN</span><button class="close-button" type="button" data-close aria-label="Close space form">&times;</button></div>
    <h2 id="space-title">Start a space.</h2>
    <p class="dialog-intro">Your space is unlisted or private: people find it through you. You host it whenever you're there.</p>
    <form id="space-form" class="stack-form">
      <label>Name<input name="title" required minlength="2" maxlength="80" placeholder="Voice agents build session"></label>
      <label>What is it for? <span class="optional">optional</span><textarea name="purpose" maxlength="300" rows="2" placeholder="Pair on interruption handling every Thursday."></textarea></label>
      <div class="form-row">
        <label>Who can find it<select name="visibility"><option value="unlisted">Anyone with the link</option><option value="private">Members and invited people</option></select></label>
        <label>Who can walk in<select name="access"><option value="open">Anyone signed in</option><option value="house">House members</option><option value="members">Members only</option></select></label>
      </div>
      <div class="form-row">
        <label>Capacity<input name="capacity" type="number" min="2" max="50" required></label>
        <label>Theme<select name="themeId"><option value="agora">Agora</option><option value="minimal">Minimal</option><option value="cyberpunk">Cyberpunk</option></select></label>
      </div>
      <p id="space-error" class="form-error" role="alert"></p>
      <button type="submit" class="button">Create space</button>
    </form>
  </dialog>
  <dialog id="manage-dialog" aria-labelledby="manage-title">
    <div class="dialog-head"><span class="kicker">YOUR SPACE</span><button class="close-button" type="button" data-close aria-label="Close manage dialog">&times;</button></div>
    <h2 id="manage-title">Manage space</h2>
    <form id="manage-form" class="stack-form">
      <label>Name<input name="title" required minlength="2" maxlength="80"></label>
      <label>What is it for? <span class="optional">optional</span><textarea name="purpose" maxlength="300" rows="2"></textarea></label>
      <div class="form-row">
        <label>Who can find it<select name="visibility"><option value="unlisted">Anyone with the link</option><option value="private">Members and invited people</option></select></label>
        <label>Who can walk in<select name="access"><option value="open">Anyone signed in</option><option value="house">House members</option><option value="members">Members only</option></select></label>
      </div>
      <div class="form-row">
        <label>Capacity<input name="capacity" type="number" min="2" max="50" required></label>
        <label>Theme<select name="themeId"><option value="agora">Agora</option><option value="minimal">Minimal</option><option value="cyberpunk">Cyberpunk</option></select></label>
      </div>
      <button type="submit" class="button button-small">Save settings</button>
    </form>
    <h3 class="stoa-panel-title">Invite</h3>
    <div class="manage-invite"><button class="button button-secondary button-small" type="button" id="manage-invite">Create an invite link</button><input id="manage-invite-url" readonly hidden aria-label="Invite link"><button class="button button-secondary button-small" type="button" id="manage-copy" hidden>Copy link</button></div>
    <p class="form-note" id="manage-invite-note"></p>
    <h3 class="stoa-panel-title">Members</h3>
    <ul class="manage-people" id="manage-members"></ul>
    <h3 class="stoa-panel-title">Removed</h3>
    <ul class="manage-people" id="manage-blocked"></ul>
    <p id="manage-error" class="form-error" role="alert"></p>
    <div class="dialog-actions"><button class="delete-button" type="button" id="manage-delete">Delete this space</button></div>
  </dialog>
```

`stoa/panel.js`:
- Add `manage() {}` to `handlers`. Wire `$("#stoa-manage")` click → `handlers.manage()` and `$("#stoa-new")` click → `handlers.start()`.
- Add `let signedIn = false;`.
- `showRoom` also sets `$("#stoa-manage").hidden = !owner;` (destructure `owner = false`) and `$("#stoa-mine-section").hidden = true;`.
- `showPlaza` also sets `$("#stoa-manage").hidden = true; $("#stoa-mine-section").hidden = !signedIn;`.
- New method `setSignedIn(value) { signedIn = Boolean(value); }`.

`stoa/stage.js`, `showRoom`: add `owner: here?.kind === "space" && mine(space.ownerId)` to the object passed to `panel.showRoom`.

`styles.css`:

```css
.stoa-mine-note { font-size: 12px; color: var(--muted); }
.manage-invite { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.manage-invite input { flex: 1 1 220px; font: 12px var(--mono); padding: 7px 8px; border: 1px solid var(--line); border-radius: 4px; }
.manage-people { list-style: none; margin: 0 0 8px; padding: 0; }
.manage-person { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
#stoa-mine a { color: inherit; font-weight: 500; }
```

`stoa.js`:
- `import { createSpacesUi } from "./stoa/spaces.js";`
- After `await sessionReady;` and `self`: `panel.setSignedIn(self.signedIn);` and `const spacesUi = createSpacesUi({ api, say: (text) => panel.say(text) });`
- Replace the `start` handler with:

```js
  start: () => self.signedIn ? spacesUi.openCreate() : (panel.say("Sign in to start a space."), openSignIn()),
  manage: () => spaceId && spacesUi.openManage(spaceId),
```

- On the plaza (`!spaceId`) when signed in, load your spaces once after entering: `api("/api/spaces/mine").then((mine) => spacesUi.showMine(mine)).catch(() => {});`. Then honour `?start=`: if `new URLSearchParams(location.search).has("start")`, call the `start` behaviour with `{ title: params.get("start") }` as the prefill (signed out: say and open sign-in). Remove `start` from the URL with `history.replaceState` so a reload doesn't reopen the dialog.
- The full-plaza offer's `#stoa-start` keeps calling `handlers.start()`, which now opens the dialog.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Check it in a browser**

On a throwaway server (not 3002), signed in:
- Start a space (private). You land in it. Manage → change the capacity → Save.
- Create an invite link. Copy it and open it in a second browser profile. That profile joins as a member and appears under Members.
- Remove the member. Then delete the space; you land on `/stoa/`.
- The plaza's Your spaces list shows the space before deletion.

Check at desktop and mobile widths, and keyboard-only through both dialogs.

- [ ] **Step 7: Commit**

```bash
git add stoa/spaces.js stoa/panel.js stoa/stage.js stoa.html stoa.js styles.css scripts/serve.mjs tests/stoa-spaces.test.mjs tests/stoa-panel.test.mjs tests/spaces-api.test.mjs
git commit -m "Create, invite to, and manage your own Stoa spaces

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 8: Retire the meetings page

**Files:**
- Delete: `meetings.html`, `meetings.js`, `call.js`
- Modify: `scripts/serve.mjs` (`publicFiles`, the `/api/rooms` routes, `/meet/<id>`, `/meetings.html`)
- Modify: `scripts/build.mjs` (file list), `scripts/auth.mjs` (`returnPath`)
- Modify: `script.js` (`newRoom`, the room form handler, room drafts)
- Modify: `index.html`, `explore.html`, `services.html`, `radar.html`, `account.html`, `stoa.html` (remove `#room-dialog`), `index.html` (the Common Room note)
- Modify: `styles.css` (drop `.call-*` and meetings-only rules that nothing uses any more)
- Modify: `README.md`
- Modify: `scripts/calls.mjs` (drop `issue(room, ...)` if nothing else uses it)
- Test: `tests/server.test.mjs`, `tests/auth.test.mjs`, `tests/spaces-api.test.mjs`, `tests/calls.test.mjs`

**Interfaces:**
- Produces:
  - `GET /meet/<uuid>` → 308 to `/stoa/s/<uuid>`, keeping the query string.
  - `GET /meetings.html` → 308 to `/stoa/s/<room>` when `?room=<uuid>`, otherwise to `/stoa/`.
  - Every `/api/rooms` path (`/api/rooms`, `/api/rooms/<id>/join`, `/api/rooms/<id>/call`), any method → 410 `{ error: "Meeting rooms are now Stoa spaces. Start one from the Stoa." }`, using the server's normal error JSON (`AppError(410, ...)`).
  - `returnPath` accepts `/stoa/`, `/stoa/room/<slug>` and `/stoa/s/<uuid>`, and keeps accepting `/meet/<uuid>`. It drops `/meetings.html`.
  - `newRoom(person, title)` in `script.js` navigates to `/stoa/?start=<title>`, where the title is `"Connect with " + person.name` when a person is given.
- The store keeps its legacy room data and functions. Plan A migrates rooms into spaces at startup, and freezing creation here (410) makes that migration complete, as the Plan A notes required.

- [ ] **Step 1: Write the failing tests**

Read `tests/server.test.mjs` lines 30–40, 130–215 and 270–290 first. In it:
- Remove `"/meetings.html"` from the page list near line 36.
- Delete the tests (or the parts of tests) that create, join or call rooms through `/api/rooms`, and the assertions about `meetings.js`. Keep any test that only exercises store-level legacy data (around line 213) as it is.
- Remove `meetings.html`, `meetings.js` and `call.js` from the production-files list near line 275, and the `/meetings.html` 200 check near line 280.
- Add:

```js
test("old meeting links and the rooms API point people to the Stoa", async () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const meet = await fetch(base + "/meet/" + id + "?invite=abc", { redirect: "manual" });
  assert.deepEqual([meet.status, meet.headers.get("location")], [308, "/stoa/s/" + id + "?invite=abc"]);
  const page = await fetch(base + "/meetings.html?room=" + id, { redirect: "manual" });
  assert.deepEqual([page.status, page.headers.get("location")], [308, "/stoa/s/" + id]);
  const bare = await fetch(base + "/meetings.html", { redirect: "manual" });
  assert.deepEqual([bare.status, bare.headers.get("location")], [308, "/stoa/"]);
  for (const [path, method] of [["/api/rooms", "GET"], ["/api/rooms", "POST"], ["/api/rooms/" + id + "/join", "POST"], ["/api/rooms/" + id + "/call", "POST"]]) {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 410, method + " " + path);
    assert.match((await response.json()).error, /Stoa/);
  }
  for (const file of ["/meetings.js", "/call.js"]) assert.equal((await fetch(base + file)).status, 404, file);
});
```

Use whatever this file calls its shared server URL (`base` above). Read the file's top to find the name.

`tests/auth.test.mjs`:
- Lines 197–202 use `returnTo=/meetings.html`. Change them to `/stoa/` and expect `location` to be `/stoa/?signin=success`.
- Add assertions to the `returnPath` test (near line 67):

```js
  assert.equal(returnPath("/stoa/"), "/stoa/");
  assert.equal(returnPath("/stoa/room/ai-agents?x=1"), "/stoa/room/ai-agents?x=1");
  assert.equal(returnPath("/stoa/s/11111111-1111-1111-1111-111111111111?invite=abc&signin=failed"), "/stoa/s/11111111-1111-1111-1111-111111111111?invite=abc");
  assert.equal(returnPath("/meetings.html"), "/");
  assert.equal(returnPath("/stoa/s/not-a-uuid"), "/");
```

`tests/spaces-api.test.mjs`, line ~174: remove `"/meetings.html"` from the page list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the new redirect, 410 and `returnPath` assertions FAIL.

- [ ] **Step 3: Implement the server side**

`scripts/serve.mjs`:
- Remove `"meetings.html"`, `"meetings.js"` and `"call.js"` from `publicFiles`.
- Replace the whole `/api/rooms` branch chain (the `else if (path === "/api/rooms" ...` arms, around lines 323–335) with one arm:

```js
        } else if (path === "/api/rooms" || path.startsWith("/api/rooms/")) throw new AppError(410, "Meeting rooms are now Stoa spaces. Start one from the Stoa.");
```

  Keep the surrounding `if`/`else if` chain intact; read the lines before and after first.
- Replace the `/meet/` lookup (the `const meeting = ...` line and the 404 line after it) with:

```js
      const meeting = /^\/meet\/([a-f0-9-]{36})$/.exec(path);
      if (meeting) { response.writeHead(308, { Location: "/stoa/s/" + meeting[1] + requestUrl.search }).end(); return; }
      if (path === "/meetings.html") { const room = requestUrl.searchParams.get("room"); response.writeHead(308, { Location: /^[a-f0-9-]{36}$/.test(room || "") ? "/stoa/s/" + room : "/stoa/" }).end(); return; }
```

- Change `const filename = stoa ? "stoa.html" : meeting ? "meetings.html" : ...` to `const filename = stoa ? "stoa.html" : path === "/" ? "index.html" : path.slice(1);`.
- If `store.rooms()` or `calls.issue` are no longer referenced in `serve.mjs`, leave the store alone. In `scripts/calls.mjs`, remove `issue(room, person, input)` only if `grep -rn "calls.issue(\|\.issue(room" scripts` finds no other callers, and remove its test in `tests/calls.test.mjs`. Keep `issueSpace`.

`scripts/build.mjs`: remove `"meetings.html"`, `"meetings.js"` and `"call.js"` from the copied file list.

`scripts/auth.mjs`, in `returnPath`, replace the allowlist line with:

```js
  const stoa = /^\/stoa\/(?:room\/[a-z0-9-]{2,40}|s\/[a-f0-9-]{36})?$/.test(url.pathname);
  if (!["/", "/index.html", "/explore.html", "/radar.html", "/services.html", "/account.html", "/oauth/authorize"].includes(url.pathname) && !stoa && !/^\/meet\/[a-f0-9-]{36}$/.test(url.pathname)) return "/";
```

- [ ] **Step 4: Implement the page side**

`script.js`:
- Replace `newRoom` with:

```js
// Rooms are Stoa spaces now: starting one opens the Stoa's create dialog.
export function newRoom(person, title = "") {
  location.assign("/stoa/?start=" + encodeURIComponent(person ? "Connect with " + person.name : title));
}
```

- Delete the `document.querySelector("#room-form").addEventListener("submit", ...)` block.
- In the `sessionReady.then(...)` block, remove the `foundry-room-draft` logic. Keep: if signed in with an account but no profile (and not on account or services), `openJoin()`; otherwise `notify("You are signed in. Your profile and rooms are ready.")`. Change that wording to `"You are signed in. Your profile and spaces are ready."`.
- In `openProfile`, rename the "Start a room" button text to "Start a space".
- `grep -n "foundry-room-draft\|room-dialog\|room-form\|room-error" script.js` must return nothing afterwards.

HTML pages:
- Remove the entire `<dialog id="room-dialog" ...>...</dialog>` block from `index.html`, `explore.html`, `services.html`, `radar.html`, `account.html` and `stoa.html`. Each block starts at `<dialog id="room-dialog"` and ends at the next `</dialog>`; each spans 4 lines. Use a small Node script or careful edits, then `grep -c room-dialog *.html` must print 0 for each file.
- `index.html` line ~54: the note `<a class="tool-note note-room" href="/meetings.html">` changes to `href="/stoa/"`. Read the line and update its copy so it describes walking into the Stoa's rooms rather than a meetings page. Keep the note's markup and classes.
- The `data-new-room` buttons on the homepage keep working through `newRoom`.

`styles.css`: remove rules used only by `meetings.html` and `call.js`. Before deleting each selector, check that `grep -rn "<class-name>" --include='*.html' --include='*.js' .` (excluding `node_modules`, `dist` and `docs`) finds no remaining use. Candidates: `.call-panel`, `.call-heading`, `.call-status`, `.call-stage`, `.call-tile`, `.call-player`, `.call-placeholder`, `.call-tile-name`, `.call-preflight`, `.call-controls`, `.meeting-intro`, and the matching media-query lines.

Delete the files: `git rm meetings.html meetings.js call.js`.

`README.md`:
- Pages and data: replace the `meetings.html` line with: `` - `stoa.html` / `stoa.js` / `stoa/` / `world/`: the Stoa — a walkable plaza with first-come rooms and your own spaces, live presence and messages over Agora Signaling, and calls over Agora RTC. ``
- "Agora group calls": rewrite it for the Stoa. Calls happen inside lot rooms and your spaces, through `POST /api/spaces/<id>/rtc-token`, and only for people currently in the room. Theme video layouts are over avatars (Agora), a strip (Cyberpunk), or a grid (Minimal). Keep the existing device, screen-share, HTTPS and token-TTL facts that still hold. Old `/meet/<id>` links redirect to `/stoa/s/<id>`; `/api/rooms` answers 410.
- "Stoa spaces": add hosts (hand over, remove, decorate), your spaces (create, invite links, members, settings, delete), and plan limits.
- Remove "creating a room, and joining a room roster" from the activity paragraph if it no longer happens. `record(...)` calls in `store.mjs` for rooms no longer run because the routes are gone; leave `store.mjs` unchanged.

- [ ] **Step 5: Run the tests**

Run: `npm test && npm run build`
Expected: PASS, and `dist/` has no `meetings.html`, `meetings.js` or `call.js`.

- [ ] **Step 6: Check it in a browser**

On a throwaway server:
- `/meet/<existing legacy room id>` lands in that space's Stoa page (the migrated room).
- The homepage's Common Room note links to `/stoa/`. A Demo days "plan a session" button opens the Stoa's Start a space dialog with the title filled in.
- A builder profile's "Start a space" does the same with "Connect with <name>".

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Retire the meetings page in favour of Stoa spaces

🤖 Built with SMT <smt@agora.build>"
```

Before committing, check `git status` shows only the intended files (no `.data/`, `dist/` or scratch files).

---

## Final verification (controller, after the final review)

1. `npm test` and `npm run build` pass.
2. Live check with real Agora. The user approved using the atem project's credentials for live tests. Put them only in the environment of a throwaway server on a free port; never print them or write them to a file.
   - Two headless Chrome profiles use fake media devices (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`) on `http://localhost:<port>`.
   - Both enter the same lot room and join the call: each sees the other's video tile in the over-avatar layout. With the Minimal view on, the grid layout shows.
   - Toggle mic and camera; share a screen.
   - The host decorates; the other client sees the change.
   - The host hands over hosting, then the new host removes the other person. The removed person leaves the call and the room.
   - In a private space, the owner creates an invite link and the second profile joins with it.
   - Record the results in this plan under "Live check", stop the server, and delete its temporary data.
3. Screenshots at desktop and mobile widths for the PR.

## Notes for later plans

- Plan D (Agora Chat): team messages and DMs, with the call panel's "chat" control (spec section 3) linking to the room's Chat group.
- Selection highlight in decor mode needs a renderer hook (an outline at a tile). v1 names the selection in the panel only.
- Proximity audio (spec section 2) can use `overAvatar`'s matching to decide which streams to subscribe to.
