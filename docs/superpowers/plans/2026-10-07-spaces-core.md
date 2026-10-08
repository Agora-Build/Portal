# Spaces Core (Plan A of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server side of Spaces: the space model, permissions, entry leases and hosts, plaza capacity, invitations, decorations, Signaling and RTC token issuing, the shared map module, the built-in worlds, and the HTTP API that Stoa's client (Plan C) will use.

**Architecture:** Spaces live in the existing store aggregate (`state.spaces`, `state.spaceLeases`), so every change runs inside the store's single atomic `transaction`. Pure modules (`permissions`, `model`, `leases`, `decor`, `signaling`) hold the rules and are unit-tested in isolation. `service.mjs` composes them over the store, and `routes.mjs` maps HTTP requests to the service. `world/map.js` is plain ESM shared by the browser and the server.

**Tech Stack:** Node.js 20+, built-in `node:test`, `node:crypto`, `agora-token` 2.0.6 (already a dependency). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-stoa-spaces-design.md`

**Later plans:** B (world engine and themes), C (Stoa client), D (Agora Chat teams and DMs), E (discovery hooks). This plan prepares for them through `spaces.onEvents()` (D), the `tags` field and the `noticeboard` map objects (E), and `world/map.js` (B and C).

## Global Constraints

- Node.js 20.12 or newer; built-in modules only; no new npm dependencies.
- JavaScript style: two-space indent, double quotes, semicolons, `.mjs` for Node scripts. Follow the compact one-line style of `scripts/store.mjs`.
- Errors are `AppError(status, message, details?)` with friendly, plain sentences.
- Never store message content. Signaling and Chat carry it.
- Unlisted and private spaces never appear in `GET /api/spaces`, in guest or plaza Signaling tokens, or in any plaza data.
- A person who may not see a private space gets the same 404 as for a missing space: `"This space was not found."`
- Actor identity: `actor.id` is the account ID when an account exists, otherwise the profile (member) ID. `actor.ids` holds both, and ownership and membership match against either.
- Plaza capacity is 200. Lease length is 60 seconds. Signaling tokens last 900 seconds. A space has at most 60 decorations, and a topic has at most 5 tags.
- Basic plans get 3 user-created spaces and every other plan gets 20 (`entitlements(plan).spaces`).
- Every commit message ends with the line `🤖 Built with SMT <smt@agora.build>`. Do not add co-author trailers.
- Run `npm test` before every commit; it must pass completely.

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/store.mjs` (modify) | `AppError` details, `actor(token)`, `spaces`/`spaceLeases` state |
| `scripts/plans.mjs` (modify) | `spaces` entitlement |
| `world/map.js` (create) | Parse Tiled maps; walkability, A*, reachability, path checks (browser and server) |
| `scripts/maps/build-maps.mjs` (create) | Generates the built-in Tiled maps |
| `worlds/plaza/map.json`, `worlds/room/map.json` (generated) | Built-in worlds |
| `scripts/spaces/permissions.mjs` (create) | `can()` and visibility/access rules |
| `scripts/spaces/model.mjs` (create) | Space records, input validation, system spaces, migration, tags |
| `scripts/spaces/leases.mjs` (create) | Entry leases, capacity, hosts, sweeping |
| `scripts/spaces/decor.mjs` (create) | Decoration validation |
| `scripts/spaces/signaling.mjs` (create) | Channel names, space keys, Signaling tokens |
| `scripts/calls.mjs` (modify) | `issueSpace()` RTC tokens |
| `scripts/spaces/service.mjs` (create) | Spaces operations over the store |
| `scripts/spaces/routes.mjs` (create) | HTTP routing for spaces, worlds, Signaling |
| `scripts/serve.mjs` (modify) | Wiring, `/stoa` pages, error details, sweeper |
| `stoa.html` (create) | Page shell that Plan C fills in |
| `scripts/build.mjs`, `.env.example`, `README.md` (modify) | Build output and configuration |
| `tests/map.test.mjs`, `tests/spaces-core.test.mjs`, `tests/spaces-service.test.mjs`, `tests/spaces-api.test.mjs` (create) | Tests |

---

### Task 1: Store groundwork and the spaces entitlement

**Files:**
- Modify: `scripts/store.mjs` (the `AppError` class, `normalize`, `read`'s empty state, and a new `actor` method)
- Modify: `scripts/plans.mjs` (`entitlements`)
- Modify: `scripts/serve.mjs` (the error handler at the end of the request `catch`)
- Modify: `tests/platform.test.mjs:146`
- Test: `tests/spaces-core.test.mjs`

**Interfaces:**
- Produces: `new AppError(status, message, details)` with `error.details`; `store.actor(token) -> { id, accountId, memberId, name, avatar, hasProfile, plan } | null`; `state.spaces` and `state.spaceLeases` arrays; `entitlements(plan).spaces` (3 on Basic, 20 on other plans).

- [ ] **Step 1: Write the failing test**

Create `tests/spaces-core.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AppError, createStore } from "../scripts/store.mjs";
import { entitlements } from "../scripts/plans.mjs";

const root = new URL("../", import.meta.url).pathname;
const profile = (name = "Test builder") => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });

test("plans grant 3 spaces on Basic and 20 on every other plan", () => {
  assert.equal(entitlements("basic").spaces, 3);
  for (const plan of ["premium", "principal", "fellow"]) assert.equal(entitlements(plan).spaces, 20);
});
test("errors can carry details for the client", () => {
  const error = new AppError(409, "Full.", { full: true });
  assert.equal(error.status, 409);
  assert.deepEqual(error.details, { full: true });
  assert.equal(new AppError(404, "Missing.").details, undefined);
});
test("the store resolves the acting person for accounts, profiles, and guests", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "spaces-actor-"));
  try {
    const store = createStore(resolve(root, "data/people.json"), resolve(directory, "state.json"));
    assert.equal(await store.actor(""), null);
    assert.equal(await store.actor("unknown"), null);
    const { token: profileToken, person } = await store.join(profile("Profile only"));
    assert.deepEqual(await store.actor(profileToken), { id: person.id, accountId: null, memberId: person.id, name: "Profile only", avatar: "", hasProfile: true, plan: "basic" });
    const login = await store.login({ provider: "github", issuer: "https://github.com", subject: "42", name: "Account only" });
    const actor = await store.actor(login.token);
    assert.equal(actor.id, login.account.id);
    assert.equal(actor.memberId, null);
    assert.equal(actor.hasProfile, false);
    assert.equal(actor.name, "Account only");
    const state = await store.snapshot();
    assert.deepEqual([state.spaces, state.spaceLeases], [[], []]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spaces-core.test.mjs`
Expected: FAIL. `entitlements("basic").spaces` is `undefined`, `error.details` is missing, and `store.actor is not a function`.

- [ ] **Step 3: Implement**

In `scripts/plans.mjs`, replace the `return` line of `entitlements`:

```js
  return { projects: premium ? 20 : 5, evalFlowsPerProject: premium ? 20 : 10, apiEvalFlows: premium ? 200 : 50, privateResources: premium, ownStorage: premium, publishMainline: ["principal", "fellow"].includes(plan), spaces: premium ? 20 : 3 };
```

In `tests/platform.test.mjs` line 146, add `spaces: 3` to the expected object:

```js
  assert.deepEqual(entitlements("basic"), { projects: 5, evalFlowsPerProject: 10, apiEvalFlows: 50, privateResources: false, ownStorage: false, publishMainline: false, spaces: 3 });
```

In `scripts/store.mjs`, replace the `AppError` class:

```js
export class AppError extends Error {
  constructor(status, message, details) { super(message); this.status = status; if (details) this.details = details; }
}
```

In `createStore`'s `normalize`, change the second line to:

```js
    state.people ||= []; state.rooms ||= []; state.radar ||= {}; state.spaces ||= []; state.spaceLeases ||= [];
```

In `read()`, change the `ENOENT` return value to:

```js
{ people: [], rooms: [], radar: {}, accounts: [], sessions: [], authorizationCodes: [], grants: [], spaces: [], spaceLeases: [] }
```

Add this method to the returned object, directly after `async me(token) { ... },`:

```js
    async actor(token) {
      if (!token) return null;
      const state = await read();
      const account = accountFor(state, token);
      const person = personFor(state, token);
      if (!account && !person) return null;
      return { id: account?.id || person.id, accountId: account?.id || null, memberId: person?.id || null, name: person?.name || account?.name || "Builder", avatar: person?.avatar || account?.avatar || "", hasProfile: Boolean(person), plan: effectivePlan(account) };
    },
```

In `scripts/serve.mjs`, replace the last line of the request `catch` block (the `json(response, error.code === "ENOENT" ...` line) with:

```js
      json(response, error.code === "ENOENT" ? 404 : error.status || 500, { error: error.code === "ENOENT" ? "This page was not found." : error.status ? error.message : "The house could not complete this request. Please try again.", ...(error.status && error.details ? error.details : {}) });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, including `tests/spaces-core.test.mjs` and the updated platform test.

- [ ] **Step 5: Commit**

```bash
git add scripts/store.mjs scripts/plans.mjs scripts/serve.mjs tests/platform.test.mjs tests/spaces-core.test.mjs
git commit -m "Add spaces state, actor lookup, and space entitlements" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: Shared map module

**Files:**
- Create: `world/map.js`
- Test: `tests/map.test.mjs`

**Interfaces:**
- Produces (all exported from `world/map.js`):
  - `CORE_ROLES: string[]`: `["floor","path","grass","water","wall","column","door","table","seat","plant","decor"]`
  - `parseMap(source) -> { id, width, height, tileSize, roles: (string|null)[], blocked: Uint8Array, lots: [{ lotId, slug, title, capacity, door:{x,y}, entry:{x,y}, interior:{x,y,width,height} }], spawns: [{x,y}], zones: [{name,x,y,width,height}], interactables: [{id,kind,label,query,x,y}] }`. Throws `Error` for an unsupported map.
  - `inside(map, x, y) -> boolean`, `roleAt(map, x, y) -> string|null`, `walkable(map, x, y, extra = new Set()) -> boolean` (`extra` holds `"x,y"` keys of extra blocked tiles)
  - `findPath(map, from, to, extra) -> [{x,y}] | null` (four directions, includes both ends)
  - `reachable(map, start, extra) -> Set<"x,y">`
  - `validPath(map, path, extra) -> boolean` (each step adjacent and walkable, at most 400 steps)

- [ ] **Step 1: Write the failing test**

Create `tests/map.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_ROLES, findPath, parseMap, reachable, roleAt, validPath, walkable } from "../world/map.js";

const role = (id, name, extra = []) => ({ id, properties: [{ name: "role", type: "string", value: name }, ...extra] });
const fixture = () => ({
  type: "map", orientation: "orthogonal", width: 5, height: 4, tilewidth: 32, tileheight: 32,
  properties: [{ name: "id", type: "string", value: "tiny" }],
  tilesets: [{ firstgid: 1, tiles: [role(0, "floor"), role(1, "wall"), role(2, "water", [{ name: "walkable", type: "bool", value: true }]), role(3, "seat")] }],
  layers: [
    { type: "tilelayer", name: "ground", data: new Array(20).fill(1) },
    { type: "tilelayer", name: "structure", data: [0, 0, 2, 0, 0, 0, 0, 2, 0, 4, 0, 0, 2, 0, 3, 0, 0, 0, 0, 0] },
    { type: "objectgroup", name: "spawn", objects: [{ id: 1, name: "", x: 0, y: 0, width: 0, height: 0 }] },
    { type: "objectgroup", name: "lot", objects: [{ id: 2, name: "", x: 96, y: 0, width: 64, height: 96, properties: [{ name: "lotId", value: "a" }, { name: "slug", value: "a-room" }, { name: "title", value: "A" }, { name: "capacity", value: 4 }, { name: "doorX", value: 3 }, { name: "doorY", value: 3 }, { name: "entryX", value: 3 }, { name: "entryY", value: 2 }] }] },
    { type: "objectgroup", name: "interactable", objects: [{ id: 3, name: "", x: 32, y: 96, width: 0, height: 0, properties: [{ name: "id", value: "board" }, { name: "kind", value: "noticeboard" }, { name: "label", value: "Board" }, { name: "query", value: "voice" }] }] }
  ]
});

test("core roles are fixed and ordered", () => {
  assert.deepEqual(CORE_ROLES, ["floor", "path", "grass", "water", "wall", "column", "door", "table", "seat", "plant", "decor"]);
});
test("maps parse roles, walkability overrides, lots, spawns, and interactables", () => {
  const map = parseMap(fixture());
  assert.equal(map.id, "tiny");
  assert.deepEqual([map.width, map.height, map.tileSize], [5, 4, 32]);
  assert.equal(roleAt(map, 2, 0), "wall");
  assert.equal(roleAt(map, 4, 2), "water");
  assert.equal(walkable(map, 2, 0), false);
  assert.equal(walkable(map, 4, 2), true, "a tile property can make water walkable");
  assert.equal(walkable(map, 4, 1), true, "seats are walkable");
  assert.equal(walkable(map, -1, 0), false);
  assert.equal(walkable(map, 0.5, 0), false);
  assert.deepEqual(map.spawns, [{ x: 0, y: 0 }]);
  assert.deepEqual(map.lots, [{ lotId: "a", slug: "a-room", title: "A", capacity: 4, door: { x: 3, y: 3 }, entry: { x: 3, y: 2 }, interior: { x: 3, y: 0, width: 2, height: 3 } }]);
  assert.deepEqual(map.interactables, [{ id: "board", kind: "noticeboard", label: "Board", query: "voice", x: 1, y: 3 }]);
});
test("unsupported maps are rejected", () => {
  assert.throws(() => parseMap({ ...fixture(), orientation: "isometric" }));
  const unknown = fixture(); unknown.layers[1].data[0] = 99;
  assert.throws(() => parseMap(unknown), /Unknown tile/);
  const short = fixture(); short.layers[0].data = [1];
  assert.throws(() => parseMap(short), /wrong size/);
});
test("paths are shortest, avoid blocked tiles, and respect extra blockers", () => {
  const map = parseMap(fixture());
  const path = findPath(map, { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.equal(path.length, 11);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path.at(-1), { x: 4, y: 0 });
  assert.equal(validPath(map, path), true);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }), null);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 4, y: 0 }, new Set(["2,3"])), null);
  const open = reachable(map, { x: 0, y: 0 }, new Set(["1,3"]));
  assert.ok(open.has("0,3"));
  assert.ok(!open.has("4,0"));
});
test("received paths are rejected when they jump or cross blocked tiles", () => {
  const map = parseMap(fixture());
  assert.equal(validPath(map, [{ x: 0, y: 0 }, { x: 0, y: 2 }]), false);
  assert.equal(validPath(map, [{ x: 1, y: 0 }, { x: 2, y: 0 }]), false);
  assert.equal(validPath(map, []), false);
  assert.equal(validPath(map, "nope"), false);
  assert.equal(validPath(map, new Array(401).fill({ x: 0, y: 0 })), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/map.test.mjs`
Expected: FAIL with `Cannot find module` for `world/map.js`.

- [ ] **Step 3: Implement**

Create `world/map.js`:

```js
// Shared by the browser engine and the server: maps describe purpose (roles), never artwork.
export const CORE_ROLES = ["floor", "path", "grass", "water", "wall", "column", "door", "table", "seat", "plant", "decor"];
const BLOCKING = new Set(["wall", "column", "water", "table", "plant"]);
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const props = (entry) => Object.fromEntries((entry?.properties || []).map((property) => [property.name, property.value]));

export function parseMap(source) {
  const { width, height, tilewidth: size } = source || {};
  if (source?.orientation !== "orthogonal" || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 200 || height > 200 || !Number.isInteger(size) || size !== source.tileheight) throw new Error("Unsupported map.");
  const tiles = new Map();
  for (const tileset of source.tilesets || []) for (const tile of tileset.tiles || []) tiles.set(tileset.firstgid + tile.id, props(tile));
  const roles = new Array(width * height).fill(null);
  const blocked = new Uint8Array(width * height);
  for (const name of ["ground", "structure"]) {
    const data = source.layers.find((layer) => layer.type === "tilelayer" && layer.name === name)?.data;
    if (!data) continue;
    if (data.length !== width * height) throw new Error("Layer " + name + " has the wrong size.");
    data.forEach((gid, index) => {
      if (!gid) return;
      const tile = tiles.get(gid);
      if (!tile || !CORE_ROLES.includes(tile.role)) throw new Error("Unknown tile " + gid + ".");
      roles[index] = tile.role;
      blocked[index] = (tile.walkable === undefined ? BLOCKING.has(tile.role) : !tile.walkable) ? 1 : 0;
    });
  }
  roles.forEach((role, index) => { if (!role) blocked[index] = 1; });
  const objects = (name) => (source.layers.find((layer) => layer.type === "objectgroup" && layer.name === name)?.objects || []).map((object) => ({ name: object.name, ...props(object), x: Math.floor(object.x / size), y: Math.floor(object.y / size), width: Math.round((object.width || 0) / size), height: Math.round((object.height || 0) / size) }));
  return {
    id: props(source).id, width, height, tileSize: size, roles, blocked,
    lots: objects("lot").map((lot) => ({ lotId: lot.lotId, slug: lot.slug, title: lot.title, capacity: lot.capacity, door: { x: lot.doorX, y: lot.doorY }, entry: { x: lot.entryX, y: lot.entryY }, interior: { x: lot.x, y: lot.y, width: lot.width, height: lot.height } })),
    spawns: objects("spawn").map(({ x, y }) => ({ x, y })),
    zones: objects("zone").map(({ name, x, y, width: w, height: h }) => ({ name, x, y, width: w, height: h })),
    interactables: objects("interactable").map(({ id, kind, label, query, x, y }) => ({ id, kind, label, query, x, y }))
  };
}

export const inside = (map, x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.width && y < map.height;
export const roleAt = (map, x, y) => inside(map, x, y) ? map.roles[y * map.width + x] : null;
export const walkable = (map, x, y, extra = new Set()) => inside(map, x, y) && !map.blocked[y * map.width + x] && !extra.has(x + "," + y);

export function findPath(map, from, to, extra = new Set()) {
  if (!inside(map, from.x, from.y) || !walkable(map, to.x, to.y, extra)) return null;
  const key = (x, y) => y * map.width + x;
  const start = key(from.x, from.y), goal = key(to.x, to.y);
  const came = new Map(), cost = new Map([[start, 0]]);
  const open = [[Math.abs(from.x - to.x) + Math.abs(from.y - to.y), start]];
  while (open.length) {
    let best = 0;
    for (let index = 1; index < open.length; index += 1) if (open[index][0] < open[best][0]) best = index;
    const [, current] = open.splice(best, 1)[0];
    if (current === goal) {
      const path = [];
      for (let node = goal; node !== undefined; node = came.get(node)) path.unshift({ x: node % map.width, y: Math.floor(node / map.width) });
      return path;
    }
    const x = current % map.width, y = Math.floor(current / map.width);
    for (const [dx, dy] of STEPS) {
      const nx = x + dx, ny = y + dy;
      if (!walkable(map, nx, ny, extra)) continue;
      const next = key(nx, ny), score = cost.get(current) + 1;
      if (score >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, score); came.set(next, current);
      open.push([score + Math.abs(nx - to.x) + Math.abs(ny - to.y), next]);
    }
  }
  return null;
}

export function reachable(map, start, extra = new Set()) {
  const seen = new Set([start.x + "," + start.y]), queue = [start];
  while (queue.length) {
    const { x, y } = queue.shift();
    for (const [dx, dy] of STEPS) {
      const nx = x + dx, ny = y + dy, id = nx + "," + ny;
      if (!seen.has(id) && walkable(map, nx, ny, extra)) { seen.add(id); queue.push({ x: nx, y: ny }); }
    }
  }
  return seen;
}

export const validPath = (map, path, extra = new Set()) => Array.isArray(path) && path.length > 0 && path.length <= 400 && path.every((step, index) => step && walkable(map, step.x, step.y, extra) && (index === 0 || Math.abs(step.x - path[index - 1].x) + Math.abs(step.y - path[index - 1].y) === 1));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/map.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add world/map.js tests/map.test.mjs
git commit -m "Add shared map parsing and pathfinding" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 3: Built-in worlds

**Files:**
- Create: `scripts/maps/build-maps.mjs`
- Create (generated): `worlds/plaza/map.json`, `worlds/room/map.json`
- Modify: `package.json` (add a `maps` script)
- Test: `tests/map.test.mjs` (append)

**Interfaces:**
- Consumes: `CORE_ROLES`, `parseMap`, `reachable`, `roleAt`, `walkable` from Task 2.
- Produces:
  - The plaza (44×34): six lots, with lot IDs and slugs `agents/ai-agents`, `voice/voice-ai`, `rtc/rtc-lab`, `founders/founders-table`, `oss/open-source`, `lounge/lounge` and capacities 8, 8, 6, 6, 10, 12. Spawns are at (21,17) and (22,17). Three `noticeboard` interactables have the IDs `collaborators`, `voice-ai`, `offers`.
  - Lot `i` (0 to 5) has its interior at `x0 = 1 + 7i`, `y = 21`, 6×12, with entry `(x0+2, 31)` and exit door `(x0+2, 32)`.
  - The room (20×14) has spawns at (9,11) and (10,11) and 8 seats.

- [ ] **Step 1: Write the failing test**

Append to `tests/map.test.mjs`:

```js
import { readFile } from "node:fs/promises";
const world = async (id) => parseMap(JSON.parse(await readFile(new URL("../worlds/" + id + "/map.json", import.meta.url), "utf8")));
const seatsIn = (map, area) => { const seats = []; for (let y = area.y; y < area.y + area.height; y += 1) for (let x = area.x; x < area.x + area.width; x += 1) if (roleAt(map, x, y) === "seat") seats.push({ x, y }); return seats; };

test("the plaza has six reachable lots whose interiors are separate and fully reachable", async () => {
  const plaza = await world("plaza");
  assert.equal(plaza.id, "plaza");
  assert.deepEqual(plaza.lots.map((lot) => [lot.slug, lot.capacity]), [["ai-agents", 8], ["voice-ai", 8], ["rtc-lab", 6], ["founders-table", 6], ["open-source", 10], ["lounge", 12]]);
  const [spawn] = plaza.spawns;
  assert.ok(walkable(plaza, spawn.x, spawn.y));
  const outside = reachable(plaza, spawn);
  for (const lot of plaza.lots) {
    assert.equal(roleAt(plaza, lot.door.x, lot.door.y), "door", lot.slug);
    assert.ok(outside.has(lot.door.x + "," + lot.door.y), lot.slug + " door is reachable");
    assert.ok(!outside.has(lot.entry.x + "," + lot.entry.y), lot.slug + " interior is separate");
    const inside = reachable(plaza, lot.entry);
    const seats = seatsIn(plaza, lot.interior);
    assert.equal(seats.length, 6, lot.slug);
    for (const seat of seats) assert.ok(inside.has(seat.x + "," + seat.y), lot.slug + " seat");
    assert.ok(inside.has(lot.entry.x + "," + (lot.entry.y + 1)), lot.slug + " exit");
    assert.equal(roleAt(plaza, lot.entry.x, lot.entry.y + 1), "door");
  }
  assert.deepEqual(plaza.interactables.map((entry) => [entry.id, entry.kind]), [["collaborators", "noticeboard"], ["voice-ai", "noticeboard"], ["offers", "noticeboard"]]);
});
test("the room world seats everyone reachably", async () => {
  const room = await world("room");
  assert.equal(room.id, "room");
  const open = reachable(room, room.spawns[0]);
  const seats = seatsIn(room, { x: 0, y: 0, width: room.width, height: room.height });
  assert.equal(seats.length, 8);
  for (const seat of seats) assert.ok(open.has(seat.x + "," + seat.y));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/map.test.mjs`
Expected: FAIL with `ENOENT` for `worlds/plaza/map.json`.

- [ ] **Step 3: Implement the generator and generate the maps**

Create `scripts/maps/build-maps.mjs`:

```js
// Generates the built-in Tiled-compatible worlds. Designers may replace the JSON with maps edited in Tiled.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_ROLES } from "../../world/map.js";

const SIZE = 32;
const prop = (values) => Object.entries(values).map(([name, value]) => ({ name, type: typeof value === "number" ? "int" : typeof value === "boolean" ? "bool" : "string", value }));
const blank = (width, height, role) => Array.from({ length: height }, () => new Array(width).fill(role));
const fill = (grid, x, y, width, height, role) => { for (let row = y; row < y + height; row += 1) for (let column = x; column < x + width; column += 1) grid[row][column] = role; };

export function tiled(id, grid, objects) {
  const height = grid.length, width = grid[0].length, gid = (role) => CORE_ROLES.indexOf(role) + 1;
  const ground = [], structure = [];
  for (const row of grid) for (const role of row) {
    const base = ["water", "grass", "path"].includes(role) ? role : "floor";
    ground.push(gid(base)); structure.push(role === base ? 0 : gid(role));
  }
  let next = 1;
  const group = (name, list) => ({ type: "objectgroup", name, objects: list.map(({ x, y, width: w = 0, height: h = 0, name: label = "", ...rest }) => ({ id: next++, name: label, x: x * SIZE, y: y * SIZE, width: w * SIZE, height: h * SIZE, point: !w && !h, properties: prop(rest) })) });
  const layers = [{ type: "tilelayer", name: "ground", width, height, data: ground }, { type: "tilelayer", name: "structure", width, height, data: structure }, ...Object.entries(objects).map(([name, list]) => group(name, list))];
  return { type: "map", version: "1.10", tiledversion: "1.10.2", orientation: "orthogonal", renderorder: "right-down", width, height, tilewidth: SIZE, tileheight: SIZE, infinite: false, nextobjectid: next, properties: prop({ id }), tilesets: [{ firstgid: 1, name: "roles", tilewidth: SIZE, tileheight: SIZE, tilecount: CORE_ROLES.length, columns: 0, tiles: CORE_ROLES.map((role, index) => ({ id: index, properties: prop({ role }) })) }], layers };
}

export const LOTS = [
  { lotId: "agents", slug: "ai-agents", title: "AI agents", capacity: 8 },
  { lotId: "voice", slug: "voice-ai", title: "Voice AI", capacity: 8 },
  { lotId: "rtc", slug: "rtc-lab", title: "RTC lab", capacity: 6 },
  { lotId: "founders", slug: "founders-table", title: "Founders' table", capacity: 6 },
  { lotId: "oss", slug: "open-source", title: "Open source", capacity: 10 },
  { lotId: "lounge", slug: "lounge", title: "The lounge", capacity: 12 }
];
// Four facades face down from the top edge of the plaza and two face up from the bottom.
const FACADES = [{ x: 2, y: 2, top: true }, { x: 10, y: 2, top: true }, { x: 27, y: 2, top: true }, { x: 35, y: 2, top: true }, { x: 6, y: 14, top: false }, { x: 29, y: 14, top: false }];

export function plaza() {
  const grid = blank(44, 34, "wall");
  fill(grid, 1, 1, 42, 18, "grass");
  fill(grid, 1, 9, 42, 2, "path"); fill(grid, 21, 1, 2, 18, "path");
  fill(grid, 17, 6, 10, 8, "path"); fill(grid, 19, 8, 6, 4, "water");
  for (const [x, y] of [[17, 6], [26, 6], [17, 13], [26, 13]]) grid[y][x] = "column";
  for (const [x, y] of [[20, 7], [23, 7], [20, 12], [23, 12]]) grid[y][x] = "seat";
  for (const [x, y] of [[5, 8], [38, 8], [5, 11], [38, 11]]) grid[y][x] = "plant";
  const lots = LOTS.map((lot, index) => {
    const facade = FACADES[index], door = { x: facade.x + 3, y: facade.top ? facade.y + 3 : facade.y };
    fill(grid, facade.x, facade.y, 7, 4, "wall");
    grid[door.y][door.x] = "door";
    const x0 = 1 + index * 7;
    fill(grid, x0, 21, 6, 12, "floor");
    fill(grid, x0 + 2, 25, 2, 3, "table");
    for (let y = 25; y < 28; y += 1) { grid[y][x0 + 1] = "seat"; grid[y][x0 + 4] = "seat"; }
    grid[21][x0] = "plant"; grid[21][x0 + 5] = "plant";
    grid[32][x0 + 2] = "door";
    return { ...lot, x: x0, y: 21, width: 6, height: 12, doorX: door.x, doorY: door.y, entryX: x0 + 2, entryY: 31 };
  });
  return tiled("plaza", grid, {
    lot: lots,
    spawn: [{ x: 21, y: 17 }, { x: 22, y: 17 }],
    zone: [{ name: "plaza", x: 1, y: 1, width: 42, height: 18 }, { name: "fountain", x: 17, y: 6, width: 10, height: 8 }],
    interactable: [
      { x: 12, y: 8, id: "collaborators", kind: "noticeboard", label: "Looking for collaborators", query: "collaborators" },
      { x: 31, y: 8, id: "voice-ai", kind: "noticeboard", label: "Voice AI", query: "voice ai" },
      { x: 25, y: 16, id: "offers", kind: "noticeboard", label: "Offers", query: "offers" }
    ]
  });
}

export function room() {
  const grid = blank(20, 14, "wall");
  fill(grid, 1, 1, 18, 12, "floor");
  fill(grid, 8, 5, 4, 3, "table");
  for (let x = 8; x < 12; x += 1) { grid[4][x] = "seat"; grid[8][x] = "seat"; }
  for (const [x, y] of [[1, 1], [18, 1], [1, 12], [18, 12]]) grid[y][x] = "plant";
  return tiled("room", grid, { spawn: [{ x: 9, y: 11 }, { x: 10, y: 11 }], zone: [{ name: "room", x: 1, y: 1, width: 18, height: 12 }] });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = new URL("../../", import.meta.url);
  for (const [id, map] of [["plaza", plaza()], ["room", room()]]) {
    await mkdir(new URL("worlds/" + id + "/", root), { recursive: true });
    await writeFile(new URL("worlds/" + id + "/map.json", root), JSON.stringify(map) + "\n");
  }
  console.log("Wrote worlds/plaza/map.json and worlds/room/map.json.");
}
```

In `package.json` `scripts`, add after `"test"`:

```json
    "maps": "node scripts/maps/build-maps.mjs"
```

(Add a comma after the `"test"` entry.)

Run: `npm run maps`
Expected output: `Wrote worlds/plaza/map.json and worlds/room/map.json.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/map.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/maps/build-maps.mjs worlds/ package.json tests/map.test.mjs
git commit -m "Add the plaza and room worlds" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 4: Permissions

**Files:**
- Create: `scripts/spaces/permissions.mjs`
- Test: `tests/spaces-core.test.mjs` (append)

**Interfaces:**
- Consumes: actor objects shaped `{ id, ids: string[], hasProfile, admin }` (built by the service in Task 10). The guest actor is `null`.
- Produces:
  - `VISIBILITY = ["listed","unlisted","private"]`, `ACCESS = ["open","house","members"]`
  - `validCombination(visibility, access) -> boolean` (`private` requires `members`)
  - `can(actor, action, space, context = {}) -> boolean`
    - actions: `see | enter | chat | speak | host | decorate | moderate | edit | invite | delete`
    - context: `{ invited?: boolean, present?: boolean }`
    - `space` fields used: `visibility, access, ownerId, members, blocked, hostId`

- [ ] **Step 1: Write the failing test**

Append to `tests/spaces-core.test.mjs`:

```js
import { ACCESS, VISIBILITY, can, validCombination } from "../scripts/spaces/permissions.mjs";

const actor = (id, extra = {}) => ({ id: "account:" + id, ids: ["account:" + id, ...(extra.memberId ? [extra.memberId] : [])], hasProfile: Boolean(extra.memberId), admin: false, ...extra });
const owner = actor("owner"), member = actor("member"), stranger = actor("stranger", { memberId: "member:stranger" }), noProfile = actor("plain"), admin = actor("admin", { admin: true });
const space = (visibility, access, extra = {}) => ({ visibility, access, ownerId: owner.id, members: [owner.id, member.id], blocked: [], hostId: null, ...extra });

test("visibility and access combine except private with open or house access", () => {
  assert.deepEqual(VISIBILITY, ["listed", "unlisted", "private"]);
  assert.deepEqual(ACCESS, ["open", "house", "members"]);
  for (const visibility of VISIBILITY) for (const access of ACCESS) assert.equal(validCombination(visibility, access), visibility !== "private" || access === "members", visibility + "/" + access);
  assert.equal(validCombination("secret", "open"), false);
});
test("seeing a space depends only on visibility, membership, invitation, or presence", () => {
  for (const visibility of ["listed", "unlisted"]) assert.equal(can(null, "see", space(visibility, "members")), true);
  const hidden = space("private", "members");
  assert.equal(can(null, "see", hidden), false);
  assert.equal(can(stranger, "see", hidden), false);
  assert.equal(can(stranger, "see", hidden, { invited: true }), true);
  assert.equal(can(member, "see", hidden), true);
  assert.equal(can(owner, "see", hidden), true);
  assert.equal(can(admin, "see", hidden), true);
});
test("entering follows the access rule and never admits guests or blocked people", () => {
  assert.equal(can(null, "enter", space("listed", "open")), false);
  assert.equal(can(noProfile, "enter", space("listed", "open")), true);
  assert.equal(can(noProfile, "enter", space("unlisted", "house")), false);
  assert.equal(can(stranger, "enter", space("unlisted", "house")), true);
  assert.equal(can(member, "enter", space("unlisted", "house")), true, "members may enter house spaces without a profile");
  assert.equal(can(stranger, "enter", space("unlisted", "members")), false);
  assert.equal(can(stranger, "enter", space("unlisted", "members"), { invited: true }), true);
  assert.equal(can(member, "enter", space("private", "members")), true);
  assert.equal(can(stranger, "enter", space("listed", "open", { blocked: ["member:stranger"] })), false, "blocks match any of the person's IDs");
});
test("hosting powers belong to the present host or the present owner; editing belongs to the owner", () => {
  const hosted = space("unlisted", "open", { hostId: member.id });
  for (const action of ["host", "decorate", "moderate"]) {
    assert.equal(can(member, action, hosted, { present: true }), true, action);
    assert.equal(can(member, action, hosted), false, action + " requires presence");
    assert.equal(can(owner, action, hosted, { present: true }), true, action + " owner");
    assert.equal(can(stranger, action, hosted, { present: true }), false, action + " stranger");
  }
  for (const action of ["edit", "invite", "delete"]) {
    assert.equal(can(owner, action, hosted), true, action);
    assert.equal(can(member, action, hosted), false, action);
  }
  assert.equal(can(stranger, "chat", hosted, { present: true }), true);
  assert.equal(can(stranger, "chat", hosted), false);
  assert.equal(can(null, "speak", hosted, { present: true }), false);
  assert.equal(can(admin, "delete", hosted), true);
  assert.equal(can(owner, "fly", hosted), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spaces-core.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/spaces/permissions.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/spaces/permissions.mjs`:

```js
// One rule set for REST handlers and token issuing. Visibility decides who can learn a space exists; access decides who can enter.
export const VISIBILITY = ["listed", "unlisted", "private"];
export const ACCESS = ["open", "house", "members"];
export const validCombination = (visibility, access) => VISIBILITY.includes(visibility) && ACCESS.includes(access) && (visibility !== "private" || access === "members");

export function can(actor, action, space, context = {}) {
  if (actor?.admin) return true;
  const mine = (id) => Boolean(actor && id && actor.ids.includes(id));
  const owner = mine(space.ownerId);
  const member = owner || (space.members || []).some(mine);
  const blocked = (space.blocked || []).some(mine);
  const present = Boolean(actor && context.present);
  switch (action) {
    case "see": return space.visibility !== "private" || member || Boolean(context.invited) || present;
    case "enter":
      if (!actor || blocked || !can(actor, "see", space, context)) return false;
      if (space.access === "open") return true;
      if (space.access === "house") return actor.hasProfile || member;
      return member || Boolean(context.invited);
    case "chat": case "speak": return present && !blocked;
    case "host": case "decorate": case "moderate": return present && (mine(space.hostId) || owner);
    case "edit": case "invite": case "delete": return owner;
    default: return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/spaces-core.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/spaces/permissions.mjs tests/spaces-core.test.mjs
git commit -m "Add space permissions" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 5: Space model

**Files:**
- Create: `scripts/spaces/model.mjs`
- Test: `tests/spaces-core.test.mjs` (append)

**Interfaces:**
- Consumes: `AppError` (Task 1), `validCombination` (Task 4), a parsed plaza map (Task 2/3).
- Produces:
  - `DECOR_KINDS` (13 kinds), `THEMES = ["agora","minimal","cyberpunk"]`, `PLAZA_ID = "plaza"`, `PLAZA_CAPACITY = 200`, `lotSpaceId(slug) -> "lot-" + slug`
  - `spaceInput(input, current = {}) -> { title, purpose, visibility, access, capacity, themeId }`. Throws 422.
  - `normalizeTags(value = []) -> string[]`. Throws 422.
  - `newSpace(fields, { id, ownerId, now }) -> Space`
  - `systemSpaces(plazaMap, now, plazaCapacity = PLAZA_CAPACITY) -> Space[]` (the plaza first, then one per lot)
  - `migratedRoom(room, now) -> Space`
  - `publicSpace(space, { occupants = [], manage = false }) -> object`. It never includes `invitations[].tokenHash` or `channelEpoch`. It includes `members`, `blocked`, and `invitations` only when `manage` is true.
  - A Space record has `{ id, type, worldId, themeId, title, purpose, visibility, access, capacity, ownerId, members, invitations, blocked, channelEpoch, hostId, topic, tags, decor, decorVersion, slug?, lot?, createdAt, updatedAt }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/spaces-core.test.mjs`:

```js
import { readFile } from "node:fs/promises";
import { parseMap } from "../world/map.js";
import { DECOR_KINDS, PLAZA_CAPACITY, PLAZA_ID, THEMES, lotSpaceId, migratedRoom, newSpace, normalizeTags, publicSpace, spaceInput, systemSpaces } from "../scripts/spaces/model.mjs";

const plazaMap = parseMap(JSON.parse(await readFile(new URL("../worlds/plaza/map.json", import.meta.url), "utf8")));

test("space input is validated with defaults and partial updates", () => {
  assert.deepEqual(spaceInput({ title: "  Demo night  " }), { title: "Demo night", purpose: "", visibility: "unlisted", access: "members", capacity: 12, themeId: "agora" });
  const current = spaceInput({ title: "Team", visibility: "private", access: "members", capacity: 4, themeId: "cyberpunk" });
  assert.deepEqual(spaceInput({ capacity: 6 }, current), { ...current, capacity: 6 });
  for (const bad of [{ title: "x" }, { title: "Ok", visibility: "listed" }, { title: "Ok", visibility: "private", access: "open" }, { title: "Ok", capacity: 1 }, { title: "Ok", capacity: 51 }, { title: "Ok", capacity: 2.5 }, { title: "Ok", themeId: "neon" }, { title: "Ok", purpose: "p".repeat(301) }]) assert.throws(() => spaceInput(bad), { status: 422 }, JSON.stringify(bad));
});
test("tags are limited to five and normalized", () => {
  assert.deepEqual(normalizeTags([" Voice  AI ", "voice ai", "Rust"]), ["voice ai", "rust"]);
  assert.deepEqual(normalizeTags(), []);
  assert.throws(() => normalizeTags(["a", "b", "c", "d", "e", "f"]), { status: 422 });
  assert.throws(() => normalizeTags(["t".repeat(31)]), { status: 422 });
  assert.throws(() => normalizeTags("rust"), { status: 422 });
});
test("system spaces come from the plaza map and lots are listed, open, and FCFS", () => {
  assert.equal(DECOR_KINDS.length, 13);
  assert.deepEqual(THEMES, ["agora", "minimal", "cyberpunk"]);
  const [plaza, ...lots] = systemSpaces(plazaMap, 0);
  assert.equal(plaza.id, PLAZA_ID);
  assert.equal(plaza.capacity, PLAZA_CAPACITY);
  assert.equal(systemSpaces(plazaMap, 0, 2)[0].capacity, 2);
  assert.equal(lots.length, 6);
  assert.deepEqual(lots[0], { ...lots[0], id: lotSpaceId("ai-agents"), slug: "ai-agents", lot: { worldId: "plaza", lotId: "agents" }, visibility: "listed", access: "open", ownerId: null, capacity: 8, worldId: "plaza", topic: null, tags: [], decor: [] });
});
test("legacy meeting rooms become unlisted members-only spaces with their rosters", () => {
  const room = { id: "fd616fdb-aa48-4c67-bd26-222222222222", title: "Demo", intent: "Plan the demo", ownerId: "member:a", participants: ["member:a", "member:b"], createdAt: "2026-01-01T00:00:00.000Z" };
  const space = migratedRoom(room, 0);
  assert.deepEqual([space.id, space.visibility, space.access, space.ownerId, space.purpose, space.createdAt], [room.id, "unlisted", "members", "member:a", "Plan the demo", room.createdAt]);
  assert.deepEqual(space.members, ["member:a", "member:b"]);
});
test("public spaces hide invitation hashes and the channel epoch", () => {
  const space = { ...newSpace(spaceInput({ title: "Team" }), { id: "s1", ownerId: "account:o", now: 0 }), invitations: [{ id: "i1", tokenHash: "secret", usesLeft: 1, expiresAt: 1 }], channelEpoch: 3 };
  const outside = publicSpace(space, { occupants: [{ id: "account:o", name: "O" }] });
  assert.equal(outside.occupancy, 1);
  for (const field of ["invitations", "members", "blocked", "channelEpoch"]) assert.equal(field in outside, false, field);
  const managed = publicSpace(space, { manage: true });
  assert.deepEqual(managed.invitations, [{ id: "i1", usesLeft: 1, expiresAt: 1 }]);
  assert.deepEqual(managed.members, ["account:o"]);
  assert.equal(JSON.stringify(managed).includes("secret"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spaces-core.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/spaces/model.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/spaces/model.mjs`:

```js
import { AppError } from "../store.mjs";
import { validCombination } from "./permissions.mjs";

export const DECOR_KINDS = ["plant", "lamp", "rug", "sofa", "chair", "table", "whiteboard", "bookshelf", "screen", "banner", "poster", "statue", "fountain"];
export const THEMES = ["agora", "minimal", "cyberpunk"];
export const PLAZA_ID = "plaza";
export const PLAZA_CAPACITY = 200;
export const lotSpaceId = (slug) => "lot-" + slug;
const pick = (input, field, fallback) => input[field] === undefined ? fallback : input[field];

export function spaceInput(input, current = {}) {
  const value = { title: pick(input, "title", current.title), purpose: pick(input, "purpose", current.purpose ?? ""), visibility: pick(input, "visibility", current.visibility ?? "unlisted"), access: pick(input, "access", current.access ?? "members"), capacity: pick(input, "capacity", current.capacity ?? 12), themeId: pick(input, "themeId", current.themeId ?? "agora") };
  if (typeof value.title !== "string" || value.title.trim().length < 2 || value.title.trim().length > 80) throw new AppError(422, "Add a title of 2 to 80 characters.");
  if (typeof value.purpose !== "string" || value.purpose.trim().length > 300) throw new AppError(422, "Keep the purpose under 300 characters.");
  if (!["unlisted", "private"].includes(value.visibility)) throw new AppError(422, "Your spaces are unlisted or private.");
  if (!validCombination(value.visibility, value.access)) throw new AppError(422, "A private space admits members and invited people only.");
  if (!Number.isInteger(value.capacity) || value.capacity < 2 || value.capacity > 50) throw new AppError(422, "Choose a capacity from 2 to 50.");
  if (!THEMES.includes(value.themeId)) throw new AppError(422, "Choose an available theme.");
  return { ...value, title: value.title.trim(), purpose: value.purpose.trim() };
}

export function normalizeTags(value = []) {
  if (!Array.isArray(value) || value.length > 5 || value.some((tag) => typeof tag !== "string")) throw new AppError(422, "Add up to 5 tags.");
  const tags = [...new Set(value.map((tag) => tag.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean))];
  if (tags.some((tag) => tag.length > 30)) throw new AppError(422, "Keep each tag under 30 characters.");
  return tags;
}

const runtime = () => ({ invitations: [], blocked: [], channelEpoch: 0, hostId: null, topic: null, tags: [], decor: [], decorVersion: 0 });

export function newSpace(fields, { id, ownerId, now }) {
  const at = new Date(now).toISOString();
  return { id, type: "stoa", worldId: "room", ...fields, ownerId, members: [ownerId], ...runtime(), createdAt: at, updatedAt: at };
}

export function systemSpaces(plazaMap, now, plazaCapacity = PLAZA_CAPACITY) {
  const at = new Date(now).toISOString();
  const base = { type: "stoa", worldId: "plaza", themeId: "agora", visibility: "listed", access: "open", ownerId: null, members: [], ...runtime(), purpose: "", createdAt: at, updatedAt: at };
  return [{ ...base, id: PLAZA_ID, title: "The plaza", capacity: plazaCapacity }, ...plazaMap.lots.map((lot) => ({ ...base, id: lotSpaceId(lot.slug), slug: lot.slug, lot: { worldId: "plaza", lotId: lot.lotId }, title: lot.title, capacity: lot.capacity }))];
}

export function migratedRoom(room, now) {
  const space = newSpace({ title: String(room.title || "Meeting room").slice(0, 80), purpose: String(room.intent || "").slice(0, 300), visibility: "unlisted", access: "members", capacity: 12, themeId: "agora" }, { id: room.id, ownerId: room.ownerId, now });
  return { ...space, members: [...new Set([room.ownerId, ...(room.participants || [])])], createdAt: room.createdAt || space.createdAt };
}

export function publicSpace(space, { occupants = [], manage = false } = {}) {
  const { invitations, blocked, members, channelEpoch, ...rest } = space;
  return { ...rest, occupancy: occupants.length, occupants, ...(manage ? { members, blocked, invitations: invitations.map(({ tokenHash, ...entry }) => entry) } : {}) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/spaces-core.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/spaces/model.mjs tests/spaces-core.test.mjs
git commit -m "Add the space model" -m "🤖 Built with SMT <smt@agora.build>"
```

---
### Task 6: Entry leases and hosts

**Files:**
- Create: `scripts/spaces/leases.mjs`
- Test: `tests/spaces-core.test.mjs` (append)

**Interfaces:**
- Consumes: `AppError`, `PLAZA_ID`. State is `{ spaces: Space[], spaceLeases: Lease[] }`, and actors have the shape `{ id, ids, name }`.
- Produces:
  - `LEASE_MS = 60000`
  - Lease record: `{ spaceId, actorId, ids: string[], name, enteredAt, expiresAt }`
  - `leasesFor(state, spaceId, now) -> Lease[]` (active leases only)
  - `leaseOf(state, spaceId, actorId, now) -> Lease|null` (matches `actorId` or any ID in `lease.ids`)
  - `enter(state, space, actor, now) -> { lease, firstIn, events }`. Throws 409 `"This space is full right now."`
  - `leave(state, space, actorId, now) -> events`
  - `heartbeat(state, space, actorId, now) -> Lease`. Throws 410 `"You are no longer in this space."`
  - `sweep(state, now) -> events`
  - Events: `{ type: "entered"|"left", spaceId, actorId }`, `{ type: "host", spaceId, hostId }`, `{ type: "emptied", spaceId }`

- [ ] **Step 1: Write the failing test**

Append to `tests/spaces-core.test.mjs`:

```js
import { LEASE_MS, enter, heartbeat, leaseOf, leasesFor, leave, sweep } from "../scripts/spaces/leases.mjs";

const walker = (id) => ({ id: "account:" + id, ids: ["account:" + id, "member:" + id], name: id.toUpperCase() });
const world = () => { const state = { spaces: systemSpaces(plazaMap, 0), spaceLeases: [] }; return { state, plaza: state.spaces[0], lot: state.spaces.find((space) => space.id === "lot-rtc-lab") }; };

test("the first person in hosts, capacity holds, and one person holds one lease", () => {
  const { state, lot } = world();
  const first = enter(state, lot, walker("a"), 0);
  assert.equal(first.firstIn, true);
  assert.equal(lot.hostId, "account:a");
  assert.deepEqual(first.events, [{ type: "entered", spaceId: lot.id, actorId: "account:a" }, { type: "host", spaceId: lot.id, hostId: "account:a" }]);
  const again = enter(state, lot, walker("a"), 5000);
  assert.equal(again.firstIn, false);
  assert.equal(leasesFor(state, lot.id, 5000).length, 1);
  assert.equal(again.lease.expiresAt, 5000 + LEASE_MS);
  assert.equal(leaseOf(state, lot.id, "member:a", 5000), again.lease, "leases match any of the person's IDs");
  for (const id of ["b", "c", "d", "e", "f"]) assert.equal(enter(state, lot, walker(id), 6000).firstIn, false);
  assert.equal(lot.hostId, "account:a");
  assert.throws(() => enter(state, lot, walker("g"), 7000), { status: 409, message: "This space is full right now." });
});
test("hosting passes to the longest-present person, and the owner hosts whenever present", () => {
  const { state } = world();
  const space = newSpace(spaceInput({ title: "Team", access: "open" }), { id: "s1", ownerId: "account:o", now: 0 });
  state.spaces.push(space);
  enter(state, space, walker("a"), 0);
  enter(state, space, walker("b"), 1000);
  enter(state, space, walker("o"), 2000);
  assert.equal(space.hostId, "account:o");
  assert.deepEqual(leave(state, space, "account:o", 3000), [{ type: "left", spaceId: "s1", actorId: "account:o" }, { type: "host", spaceId: "s1", hostId: "account:a" }]);
  leave(state, space, "account:a", 4000);
  assert.equal(space.hostId, "account:b");
  assert.deepEqual(leave(state, space, "account:nobody", 5000), []);
});
test("an emptied lot clears its session, but a user space keeps its own", () => {
  const { state, lot } = world();
  enter(state, lot, walker("a"), 0);
  Object.assign(lot, { topic: "Demos", tags: ["rtc"], decor: [{ id: "p", kind: "plant", x: 1, y: 1 }], blocked: ["account:z"] });
  const events = leave(state, lot, "account:a", 1000);
  assert.ok(events.some((event) => event.type === "emptied"));
  assert.deepEqual([lot.topic, lot.tags, lot.decor, lot.blocked, lot.hostId], [null, [], [], [], null]);
  const space = { ...newSpace(spaceInput({ title: "Team", access: "open" }), { id: "s2", ownerId: "account:o", now: 0 }), topic: "Keep" };
  state.spaces.push(space);
  enter(state, space, walker("a"), 0);
  leave(state, space, "account:a", 1000);
  assert.equal(space.topic, "Keep");
});
test("expired leases are swept, freeing seats and handing over the host", () => {
  const { state, lot } = world();
  enter(state, lot, walker("a"), 0);
  enter(state, lot, walker("b"), 10000);
  assert.deepEqual(sweep(state, 30000), []);
  const events = sweep(state, LEASE_MS + 1);
  assert.deepEqual(events, [{ type: "left", spaceId: lot.id, actorId: "account:a" }, { type: "host", spaceId: lot.id, hostId: "account:b" }]);
  assert.equal(heartbeat(state, lot, "account:b", 65000).expiresAt, 65000 + LEASE_MS);
  assert.throws(() => heartbeat(state, lot, "account:a", 65000), { status: 410 });
});
test("the plaza never has a host", () => {
  const { state, plaza } = world();
  assert.deepEqual(enter(state, plaza, walker("a"), 0).events, [{ type: "entered", spaceId: "plaza", actorId: "account:a" }]);
  assert.equal(plaza.hostId, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spaces-core.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/spaces/leases.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/spaces/leases.mjs`:

```js
import { AppError } from "../store.mjs";
import { PLAZA_ID } from "./model.mjs";

// Leases count who is inside a space; capacity and hosting are decided only from active leases.
export const LEASE_MS = 60000;
const mine = (lease, id) => lease.actorId === id || lease.ids.includes(id);
export const leasesFor = (state, spaceId, now) => state.spaceLeases.filter((lease) => lease.spaceId === spaceId && lease.expiresAt > now);
export const leaseOf = (state, spaceId, actorId, now) => (actorId && leasesFor(state, spaceId, now).find((lease) => mine(lease, actorId))) || null;

function settle(state, space, now, events) {
  const present = leasesFor(state, space.id, now).sort((a, b) => a.enteredAt - b.enteredAt);
  if (space.id !== PLAZA_ID) {
    const keep = space.hostId && present.some((lease) => mine(lease, space.hostId));
    const next = keep ? space.hostId : (present.find((lease) => lease.ids.includes(space.ownerId)) || present[0])?.actorId || null;
    if (next !== space.hostId) { space.hostId = next; events.push({ type: "host", spaceId: space.id, hostId: next }); }
  }
  if (!present.length && space.lot) { Object.assign(space, { topic: null, tags: [], decor: [], blocked: [] }); events.push({ type: "emptied", spaceId: space.id }); }
}

export function enter(state, space, actor, now) {
  const events = [];
  const current = leaseOf(state, space.id, actor.id, now);
  if (current) { current.expiresAt = now + LEASE_MS; return { lease: current, firstIn: false, events }; }
  const present = leasesFor(state, space.id, now);
  if (present.length >= space.capacity) throw new AppError(409, "This space is full right now.");
  const lease = { spaceId: space.id, actorId: actor.id, ids: actor.ids, name: actor.name, enteredAt: now, expiresAt: now + LEASE_MS };
  state.spaceLeases.push(lease);
  events.push({ type: "entered", spaceId: space.id, actorId: actor.id });
  const hostPresent = space.hostId && present.some((entry) => mine(entry, space.hostId));
  if (space.id !== PLAZA_ID && (actor.ids.includes(space.ownerId) || !hostPresent) && space.hostId !== actor.id) { space.hostId = actor.id; events.push({ type: "host", spaceId: space.id, hostId: actor.id }); }
  return { lease, firstIn: present.length === 0, events };
}

export function leave(state, space, actorId, now) {
  const events = [];
  const gone = state.spaceLeases.filter((lease) => lease.spaceId === space.id && mine(lease, actorId));
  if (!gone.length) return events;
  state.spaceLeases = state.spaceLeases.filter((lease) => !gone.includes(lease));
  for (const lease of gone) events.push({ type: "left", spaceId: space.id, actorId: lease.actorId });
  settle(state, space, now, events);
  return events;
}

export function heartbeat(state, space, actorId, now) {
  const lease = leaseOf(state, space.id, actorId, now);
  if (!lease) throw new AppError(410, "You are no longer in this space.");
  lease.expiresAt = now + LEASE_MS;
  return lease;
}

export function sweep(state, now) {
  const events = [];
  const expired = state.spaceLeases.filter((lease) => lease.expiresAt <= now);
  if (!expired.length) return events;
  state.spaceLeases = state.spaceLeases.filter((lease) => lease.expiresAt > now);
  for (const lease of expired) events.push({ type: "left", spaceId: lease.spaceId, actorId: lease.actorId });
  for (const id of new Set(expired.map((lease) => lease.spaceId))) {
    const space = state.spaces.find((entry) => entry.id === id);
    if (space) settle(state, space, now, events);
  }
  return events;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/spaces-core.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/spaces/leases.mjs tests/spaces-core.test.mjs
git commit -m "Add entry leases, capacity, and hosting" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 7: Decoration validation

**Files:**
- Create: `scripts/spaces/decor.mjs`
- Test: `tests/spaces-core.test.mjs` (append)

**Interfaces:**
- Consumes: `DECOR_KINDS` (Task 5); `reachable`, `roleAt`, `walkable` (Task 2); a parsed world map; a space with optional `lot: { lotId }`.
- Produces: `BLOCKING_DECOR` (a Set of `sofa, table, whiteboard, bookshelf, statue, fountain`), `DECOR_LIMIT = 60`, and `validateDecor(items, map, space) -> [{ id, kind, x, y, rotation, variant }]`. Throws 422 with one of these messages:
  - `"Place up to 60 decorations."`
  - `"Each decoration needs a short ID."`
  - `"Choose a known decoration."`
  - `"This decoration's rotation or style is not available."`
  - `"Place decorations on open floor inside the room."`
  - `"Keep doors and entrances clear."`
  - `"Only one decoration fits on each tile."`
  - `"Keep every door, entrance, and seat reachable."`

- [ ] **Step 1: Write the failing test**

Append to `tests/spaces-core.test.mjs`:

```js
import { BLOCKING_DECOR, DECOR_LIMIT, validateDecor } from "../scripts/spaces/decor.mjs";

const roomMap = parseMap(JSON.parse(await readFile(new URL("../worlds/room/map.json", import.meta.url), "utf8")));
const userSpace = { id: "s1" };
const lotSpace = { id: "lot-rtc-lab", lot: { worldId: "plaza", lotId: "rtc" } };
const rejects = (items, map, space, message) => assert.throws(() => validateDecor(items, map, space), { status: 422, message });

test("valid decorations are normalized", () => {
  assert.equal(DECOR_LIMIT, 60);
  assert.ok(BLOCKING_DECOR.has("sofa") && !BLOCKING_DECOR.has("plant"));
  assert.deepEqual(validateDecor([{ id: "p1", kind: "plant", x: 3, y: 3 }, { id: "s1", kind: "sofa", x: 4, y: 3, rotation: 90, variant: 2, extra: "ignored" }], roomMap, userSpace), [{ id: "p1", kind: "plant", x: 3, y: 3, rotation: 0, variant: 0 }, { id: "s1", kind: "sofa", x: 4, y: 3, rotation: 90, variant: 2 }]);
  assert.deepEqual(validateDecor([], roomMap, userSpace), []);
});
test("decorations must be known, well-formed, on open floor, and inside the room", () => {
  rejects(new Array(61).fill(0).map((_, index) => ({ id: "d" + index, kind: "plant", x: 2 + (index % 16), y: 2 + Math.floor(index / 16) })), roomMap, userSpace, "Place up to 60 decorations.");
  rejects("plant", roomMap, userSpace, "Place up to 60 decorations.");
  rejects([{ id: "bad id!", kind: "plant", x: 3, y: 3 }], roomMap, userSpace, "Each decoration needs a short ID.");
  rejects([{ id: "d", kind: "dragon", x: 3, y: 3 }], roomMap, userSpace, "Choose a known decoration.");
  rejects([{ id: "d", kind: "plant", x: 3, y: 3, rotation: 45 }], roomMap, userSpace, "This decoration's rotation or style is not available.");
  rejects([{ id: "d", kind: "plant", x: 3, y: 3, variant: 8 }], roomMap, userSpace, "This decoration's rotation or style is not available.");
  rejects([{ id: "d", kind: "plant", x: 0, y: 3 }], roomMap, userSpace, "Place decorations on open floor inside the room.");
  rejects([{ id: "d", kind: "plant", x: 9, y: 6 }], roomMap, userSpace, "Place decorations on open floor inside the room.");
  rejects([{ id: "d", kind: "plant", x: 9, y: 11 }], roomMap, userSpace, "Keep doors and entrances clear.");
  rejects([{ id: "a", kind: "plant", x: 3, y: 3 }, { id: "b", kind: "lamp", x: 3, y: 3 }], roomMap, userSpace, "Only one decoration fits on each tile.");
});
test("blocking decorations may not cut off seats, doors, or entrances", () => {
  const walls = [[8, 11], [11, 11], [9, 10], [10, 10], [9, 12], [10, 12]].map(([x, y], index) => ({ id: "w" + index, kind: "statue", x, y }));
  rejects(walls, roomMap, userSpace, "Keep every door, entrance, and seat reachable.");
  assert.equal(validateDecor(walls.map((item) => ({ ...item, kind: "plant" })), roomMap, userSpace).length, 6, "non-blocking decorations never cut anything off");
  rejects([{ id: "d", kind: "sofa", x: 8, y: 4 }], roomMap, userSpace, "Keep every door, entrance, and seat reachable.");
});
test("lot decorations stay inside the lot's interior and keep its doors clear", () => {
  assert.equal(validateDecor([{ id: "p", kind: "plant", x: 15, y: 22 }], plazaMap, lotSpace).length, 1);
  rejects([{ id: "p", kind: "plant", x: 22, y: 22 }], plazaMap, lotSpace, "Place decorations on open floor inside the room.");
  rejects([{ id: "p", kind: "plant", x: 17, y: 31 }], plazaMap, lotSpace, "Keep doors and entrances clear.");
  rejects([{ id: "p", kind: "plant", x: 17, y: 32 }], plazaMap, lotSpace, "Keep doors and entrances clear.");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spaces-core.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/spaces/decor.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/spaces/decor.mjs`:

```js
import { AppError } from "../store.mjs";
import { reachable, roleAt, walkable } from "../../world/map.js";
import { DECOR_KINDS } from "./model.mjs";

// Decorations are semantic kinds; the theme draws them. Blocking kinds must never cut people off.
export const BLOCKING_DECOR = new Set(["sofa", "table", "whiteboard", "bookshelf", "statue", "fountain"]);
export const DECOR_LIMIT = 60;
const tilesIn = (map, area, role) => { const tiles = []; for (let y = area.y; y < area.y + area.height; y += 1) for (let x = area.x; x < area.x + area.width; x += 1) if (roleAt(map, x, y) === role) tiles.push({ x, y }); return tiles; };

function region(map, space) {
  if (!space.lot) {
    const area = { x: 0, y: 0, width: map.width, height: map.height };
    return { area, start: map.spawns[0], protect: [...map.spawns, ...tilesIn(map, area, "door")] };
  }
  const lot = map.lots.find((entry) => entry.lotId === space.lot.lotId);
  return { area: lot.interior, start: lot.entry, protect: [lot.entry, ...tilesIn(map, lot.interior, "door")] };
}

export function validateDecor(items, map, space) {
  if (!Array.isArray(items) || items.length > DECOR_LIMIT) throw new AppError(422, "Place up to 60 decorations.");
  const { area, start, protect } = region(map, space);
  const protectedTiles = new Set(protect.map(({ x, y }) => x + "," + y));
  const used = new Set();
  const clean = items.map((item) => {
    const { id, kind, x, y, rotation = 0, variant = 0 } = item && typeof item === "object" ? item : {};
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new AppError(422, "Each decoration needs a short ID.");
    if (!DECOR_KINDS.includes(kind)) throw new AppError(422, "Choose a known decoration.");
    if (![0, 90, 180, 270].includes(rotation) || !Number.isInteger(variant) || variant < 0 || variant > 7) throw new AppError(422, "This decoration's rotation or style is not available.");
    if (!walkable(map, x, y) || x < area.x || y < area.y || x >= area.x + area.width || y >= area.y + area.height) throw new AppError(422, "Place decorations on open floor inside the room.");
    if (protectedTiles.has(x + "," + y)) throw new AppError(422, "Keep doors and entrances clear.");
    if (used.has(x + "," + y)) throw new AppError(422, "Only one decoration fits on each tile.");
    used.add(x + "," + y);
    return { id, kind, x, y, rotation, variant };
  });
  const open = reachable(map, start, new Set(clean.filter((item) => BLOCKING_DECOR.has(item.kind)).map((item) => item.x + "," + item.y)));
  if ([...protect, ...tilesIn(map, area, "seat")].some(({ x, y }) => !open.has(x + "," + y))) throw new AppError(422, "Keep every door, entrance, and seat reachable.");
  return clean;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/spaces-core.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/spaces/decor.mjs tests/spaces-core.test.mjs
git commit -m "Add decoration validation" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 8: Signaling channels, keys, and tokens

**Files:**
- Create: `scripts/spaces/signaling.mjs`
- Test: `tests/spaces-core.test.mjs` (append)

**Interfaces:**
- Consumes: `agora-token` (`RtmTokenBuilder`, `Rtm2Permissions`), `AppError`.
- Produces:
  - `signalingConfig(env) -> { appId, certificate, secret, permissions, ttl: 900, ready }`. It is `ready` only with a 32-hex app ID, a 32-hex certificate, and a secret of at least 32 characters.
  - `channelName(secret, space) -> string`:
    - listed spaces: `"ab-<type>-<slug or id>"`
    - unlisted and private spaces: `"ab-<type>-" + 24 hex characters` of HMAC-SHA256(`secret`, `"channel:<id>:<epoch>"`)
  - `spaceKey(secret, space) -> string|null`: base64 of the 32-byte HMAC-SHA256(`secret`, `"key:<id>:<epoch>"`); `null` for listed spaces.
  - `signalingUser(actor|null) -> "a-<uuid>" | "m-<uuid>" | "g-<16 hex>"`
  - `createSignaling(config, { now }) -> { ready, issue(userId, channels: [{ name, write }]) -> { appId, userId, token, expiresAt } }`. `issue` throws 503 when not ready. With `permissions` it uses `buildTokenWithPermissions`; otherwise it builds a login-only token.

- [ ] **Step 1: Write the failing test**

Append to `tests/spaces-core.test.mjs`:

```js
import tokenTypes from "agora-token/src/AccessToken2.js";
import { channelName, createSignaling, signalingConfig, signalingUser, spaceKey } from "../scripts/spaces/signaling.mjs";

const signalingEnv = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACE_CHANNEL_SECRET: "s".repeat(32) };
const parse = (token) => { const parsed = new tokenTypes.AccessToken2(); assert.equal(parsed.from_string(token), true); assert.equal(parsed.verifySignature("b".repeat(32)), true); return parsed; };

test("Signaling needs Agora credentials and a long channel secret", () => {
  const config = signalingConfig(signalingEnv);
  assert.deepEqual([config.ready, config.ttl, config.permissions], [true, 900, false]);
  assert.equal(signalingConfig({ ...signalingEnv, SPACE_CHANNEL_SECRET: "short" }).ready, false);
  assert.equal(signalingConfig({}).ready, false);
  assert.equal(signalingConfig({ ...signalingEnv, AGORA_RTM_PERMISSIONS: "true" }).permissions, true);
  assert.throws(() => createSignaling(signalingConfig({})).issue("a-x", []), { status: 503 });
});
test("listed channels are public names; unlisted and private names and keys need the secret and change with the epoch", () => {
  const secret = "s".repeat(32);
  assert.equal(channelName(secret, { id: "plaza", type: "stoa", visibility: "listed" }), "ab-stoa-plaza");
  assert.equal(channelName(secret, { id: "lot-ai-agents", slug: "ai-agents", type: "stoa", visibility: "listed" }), "ab-stoa-ai-agents");
  assert.equal(spaceKey(secret, { id: "plaza", type: "stoa", visibility: "listed" }), null);
  const hidden = { id: "8f9c4d02-0d56-4c79-9a39-111111111111", type: "stoa", visibility: "private", channelEpoch: 0 };
  const name = channelName(secret, hidden);
  assert.match(name, /^ab-stoa-[a-f0-9]{24}$/);
  assert.equal(name.includes(hidden.id), false);
  assert.notEqual(channelName(secret, { ...hidden, channelEpoch: 1 }), name);
  assert.notEqual(channelName("t".repeat(32), hidden), name);
  const key = spaceKey(secret, hidden);
  assert.equal(Buffer.from(key, "base64").length, 32);
  assert.notEqual(spaceKey(secret, { ...hidden, channelEpoch: 1 }), key);
});
test("Signaling user IDs come from the account, the profile, or a random guest ID", () => {
  assert.equal(signalingUser({ id: "account:72a639ba-3a45-4afe-936b-111111111111" }), "a-72a639ba-3a45-4afe-936b-111111111111");
  assert.equal(signalingUser({ id: "member:72a639ba-3a45-4afe-936b-111111111111" }), "m-72a639ba-3a45-4afe-936b-111111111111");
  assert.match(signalingUser(null), /^g-[a-f0-9]{16}$/);
  assert.notEqual(signalingUser(null), signalingUser(null));
});
test("Signaling tokens are signed for the user and add channel permissions only when enabled", () => {
  const login = createSignaling(signalingConfig(signalingEnv), { now: () => 1700000000000 }).issue("a-x", [{ name: "ab-stoa-plaza", write: true }]);
  assert.deepEqual([login.appId, login.userId, login.expiresAt], ["a".repeat(32), "a-x", new Date(1700000000000 + 900000).toISOString()]);
  const parsed = parse(login.token);
  assert.equal(parsed.expire, 900);
  assert.equal(parsed.getServices(tokenTypes.kRtmServiceType)[0].__user_id.toString(), "a-x");
  const scoped = createSignaling(signalingConfig({ ...signalingEnv, AGORA_RTM_PERMISSIONS: "true" })).issue("g-1", [{ name: "ab-stoa-plaza", write: false }, { name: "ab-stoa-ai-agents", write: true }]);
  const service = parse(scoped.token).getServices(tokenTypes.kRtm2ServiceType)[0];
  assert.deepEqual(service.__permissions.details, { 0: { 0: ["ab-stoa-plaza", "ab-stoa-ai-agents"], 1: ["ab-stoa-ai-agents"] } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spaces-core.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/spaces/signaling.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/spaces/signaling.mjs`:

```js
import { createHmac, randomBytes } from "node:crypto";
import agoraToken from "agora-token";
import { AppError } from "../store.mjs";

// Signaling tokens grant login only. Isolation comes from secret-derived channel names and per-space keys;
// AGORA_RTM_PERMISSIONS=true adds Agora's per-channel permissions on top when Agora enables them.
export function signalingConfig(env = process.env) {
  const appId = env.AGORA_APP_ID || "", certificate = env.AGORA_APP_CERTIFICATE || "", secret = env.SPACE_CHANNEL_SECRET || "";
  return { appId, certificate, secret, permissions: env.AGORA_RTM_PERMISSIONS === "true", ttl: 900, ready: /^[a-f0-9]{32}$/i.test(appId) && /^[a-f0-9]{32}$/i.test(certificate) && secret.length >= 32 };
}

const mac = (secret, value) => createHmac("sha256", secret).update(value).digest();
export const channelName = (secret, space) => "ab-" + space.type + "-" + (space.visibility === "listed" ? space.slug || space.id : mac(secret, "channel:" + space.id + ":" + (space.channelEpoch || 0)).toString("hex").slice(0, 24));
export const spaceKey = (secret, space) => space.visibility === "listed" ? null : mac(secret, "key:" + space.id + ":" + (space.channelEpoch || 0)).toString("base64");
export const signalingUser = (actor) => actor ? actor.id.replace(/^account:/, "a-").replace(/^member:/, "m-") : "g-" + randomBytes(8).toString("hex");

export function createSignaling(config = signalingConfig(), { now = Date.now } = {}) {
  const { RtmTokenBuilder, Rtm2Permissions } = agoraToken;
  return {
    ready: config.ready,
    issue(userId, channels) {
      if (!config.ready) throw new AppError(503, "Live movement and messages are not connected yet.");
      let token;
      if (config.permissions) {
        const permissions = new Rtm2Permissions();
        permissions.add(Rtm2Permissions.kMessageChannels, Rtm2Permissions.kRead, channels.map((channel) => channel.name));
        const writable = channels.filter((channel) => channel.write).map((channel) => channel.name);
        if (writable.length) permissions.add(Rtm2Permissions.kMessageChannels, Rtm2Permissions.kWrite, writable);
        token = RtmTokenBuilder.buildTokenWithPermissions(config.appId, config.certificate, userId, permissions, config.ttl);
      } else token = RtmTokenBuilder.buildToken(config.appId, config.certificate, userId, config.ttl);
      return { appId: config.appId, userId, token, expiresAt: new Date(now() + config.ttl * 1000).toISOString() };
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/spaces-core.test.mjs`
Expected: PASS. If `getServices` or a service type constant is named differently in `agora-token`, read `node_modules/agora-token/src/AccessToken2.js` and `node_modules/agora-token/test/RtmTokenBuilder2Test.js` and adjust **only the test's** token inspection to match them.

- [ ] **Step 5: Commit**

```bash
git add scripts/spaces/signaling.mjs tests/spaces-core.test.mjs
git commit -m "Add Signaling channel names, space keys, and tokens" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 9: RTC tokens for spaces

**Files:**
- Modify: `scripts/calls.mjs` (replace `createAgoraCalls`)
- Test: `tests/calls.test.mjs` (append)

**Interfaces:**
- Produces: `calls.issueSpace(space, actor, input = {}) -> { provider, appId, channel: "agora-build-space-<space.id>", uid, screenUid, token, screenToken, expiresAt }`. The UID prefix is the actor ID without its `account:` or `member:` prefix, then `_`. The service (Task 10) checks the lease before calling it. `calls.issue(room, person, input)` behaves exactly as before.

- [ ] **Step 1: Write the failing test**

Append to `tests/calls.test.mjs`:

```js
test("space calls use the space channel and an identity derived from the account", () => {
  const calls = createAgoraCalls(config);
  const actor = { id: "account:72a639ba-3a45-4afe-936b-333333333333" };
  const credentials = calls.issueSpace({ id: "lot-ai-agents" }, actor);
  assert.equal(credentials.channel, "agora-build-space-lot-ai-agents");
  assert.match(credentials.uid, /^72a639ba-3a45-4afe-936b-333333333333_[a-f0-9]{12}$/);
  assert.equal(credentials.screenUid, credentials.uid + "_screen");
  assert.equal(calls.issueSpace({ id: "lot-ai-agents" }, actor, { uid: credentials.uid }).uid, credentials.uid);
  assert.throws(() => calls.issueSpace({ id: "lot-ai-agents" }, actor, { uid: "someone_123456789abc" }), { status: 422 });
  assert.throws(() => createAgoraCalls(agoraConfig({})).issueSpace({ id: "lot-ai-agents" }, actor), { status: 503 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/calls.test.mjs`
Expected: FAIL with `calls.issueSpace is not a function`.

- [ ] **Step 3: Implement**

In `scripts/calls.mjs`, replace the whole `createAgoraCalls` function with:

```js
export function createAgoraCalls(config = agoraConfig(), { now = Date.now } = {}) {
  function credentials(channel, prefix, input) {
    if (!config.ready) throw new AppError(503, "Agora calls are not connected yet.");
    // Each tab gets its own identity; renewals can only reuse this person's IDs.
    const uid = input.uid === undefined ? prefix + randomBytes(6).toString("hex") : input.uid;
    if (typeof uid !== "string" || !uid.startsWith(prefix) || !/^[a-f0-9]{12}$/.test(uid.slice(prefix.length))) throw new AppError(422, "This call identity does not belong to your profile.");
    const screenUid = uid + "_screen";
    const sign = (account) => agoraToken.RtcTokenBuilder.buildTokenWithUserAccount(config.appId, config.certificate, channel, account, agoraToken.RtcRole.PUBLISHER, config.ttl, config.ttl);
    return { provider: "agora", appId: config.appId, channel, uid, screenUid, token: sign(uid), screenToken: sign(screenUid), expiresAt: new Date(now() + config.ttl * 1000).toISOString() };
  }
  return {
    ready: config.ready,
    issue(room, person, input = {}) {
      if (!room.participants.includes(person.id)) throw new AppError(403, "Join this room's roster before entering the call.");
      return credentials("agora-build-" + room.id, person.id.replace(/^member:/, "") + "_", input);
    },
    issueSpace(space, actor, input = {}) {
      return credentials("agora-build-space-" + space.id, actor.id.replace(/^(account|member):/, "") + "_", input);
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/calls.test.mjs`
Expected: PASS (4 tests, including the 3 existing ones).

- [ ] **Step 5: Commit**

```bash
git add scripts/calls.mjs tests/calls.test.mjs
git commit -m "Issue RTC tokens for spaces" -m "🤖 Built with SMT <smt@agora.build>"
```

---
### Task 10: Spaces service

**Files:**
- Create: `scripts/spaces/service.mjs`
- Test: `tests/spaces-service.test.mjs`

**Interfaces:**
- Consumes:
  - `store.transaction`, `store.snapshot`, `store.actor`, `store.join`, `store.createRoom` (Task 1 and existing code)
  - `parseMap` (Task 2), `can` (Task 4), the model (Task 5), the leases (Task 6), `validateDecor` (Task 7)
  - `channelName`, `spaceKey`, `signalingUser`, `signaling.issue` (Task 8); `calls.issueSpace` (Task 9)
- Produces:
  - `loadWorlds(directory) -> { plaza: { source, map }, room: { source, map } }` (synchronous; reads `worlds/<id>/map.json`)
  - `createSpaces({ store, worlds, signaling, calls, secret = "", admins = [], now = Date.now, plazaCapacity }) -> spaces` with:
    - `list({ q }) -> { plaza: { capacity, occupancy, blocked }, rooms: [{ id, slug, title, topic, tags, capacity, occupancy, occupants, hostName, path }] }`
    - `create(token, input) -> PublicSpace`; `get(token, id, invite?) -> PublicSpace`; `visible(token, id, invite?) -> boolean`; `update(token, id, input) -> PublicSpace`; `destroy(token, id) -> { deleted: true }`
    - `enter(token, id, invite?) -> { space, firstIn, channel, key, blocked, hostId }`
    - `leave(token, id) -> { left: true }`; `heartbeat(token, id) -> { channel, key, blocked, hostId }`
    - `topic(token, id, { topic, tags }) -> PublicSpace`; `setHost(token, id, { actorId }) -> { hostId }`; `decorate(token, id, items) -> { decor, version }`
    - `removePerson(token, id, { actorId }) -> { removed: true, channel, key, blocked, hostId }`
    - `invite(token, id, { uses, hours }) -> { token, path, usesLeft, expiresAt }`
    - `addMember(token, id, memberId) -> { members }`; `removeMember(token, id, memberId) -> { members }`
    - `signalingToken(token) -> { appId, userId, token, expiresAt, channels: [{ spaceId, name, write, key }] }`
    - `rtcToken(token, id, input) -> RTC credentials`
    - `sweep() -> Promise<void>`
    - `onEvents(listener)`: the listener receives each committed batch of events. Plan D uses it for Chat sync. Event types: `entered`, `left`, `host`, `emptied`, `member-added`, `member-removed`, `removed`, `deleted`.

- [ ] **Step 1: Write the failing test**

Create `tests/spaces-service.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStore } from "../scripts/store.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { createSignaling, signalingConfig } from "../scripts/spaces/signaling.mjs";
import { createSpaces, loadWorlds } from "../scripts/spaces/service.mjs";

const root = new URL("../", import.meta.url).pathname;
const worlds = loadWorlds(root);
const secret = "s".repeat(32);
const env = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACE_CHANNEL_SECRET: secret };
const profile = (name) => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });
const missing = { status: 404, message: "This space was not found." };

async function setup(t, { plazaCapacity, before } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "spaces-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { now: 1800000000000 };
  const now = () => clock.now;
  const store = createStore(resolve(root, "data/people.json"), resolve(directory, "state.json"), { now });
  const person = async (name) => { const { token } = await store.join(profile(name)); return { token, id: (await store.actor(token)).id }; };
  const context = before ? await before(store, person) : {};
  const spaces = createSpaces({ store, worlds, secret, now, plazaCapacity, signaling: createSignaling(signalingConfig(env), { now }), calls: createAgoraCalls(agoraConfig(env), { now }) });
  const events = [];
  spaces.onEvents((list) => events.push(...list));
  return { store, spaces, events, clock, person, ...context };
}

test("system spaces and legacy rooms are prepared once", async (t) => {
  const { spaces, store, owner, room } = await setup(t, { before: async (store, person) => { const owner = await person("Owner"); return { owner, room: await store.createRoom(owner.token, { title: "Demo prep", intent: "Plan the demo day together." }) }; } });
  const listing = await spaces.list();
  assert.deepEqual(listing.rooms.map((entry) => entry.slug), ["ai-agents", "voice-ai", "rtc-lab", "founders-table", "open-source", "lounge"]);
  assert.deepEqual(listing.plaza, { capacity: 200, occupancy: 0, blocked: [] });
  const migrated = await spaces.get(owner.token, room.id);
  assert.deepEqual([migrated.visibility, migrated.access, migrated.members, migrated.title], ["unlisted", "members", [owner.id], "Demo prep"]);
  await spaces.list();
  assert.equal((await store.snapshot()).spaces.length, 8);
});

test("the first person in a lot hosts and sets the topic; hosting passes on; an empty lot resets", async (t) => {
  const { spaces, events, clock, person } = await setup(t);
  const [a, b, c] = [await person("Ada"), await person("Bo"), await person("Cy")];
  const first = await spaces.enter(a.token, "lot-ai-agents");
  assert.deepEqual([first.firstIn, first.hostId, first.channel, first.key], [true, a.id, "ab-stoa-ai-agents", null]);
  clock.now += 1000; await spaces.enter(b.token, "lot-ai-agents");
  clock.now += 1000; await spaces.enter(c.token, "lot-ai-agents");
  await assert.rejects(spaces.topic(b.token, "lot-ai-agents", { topic: "Agents" }), { status: 403 });
  await assert.rejects(spaces.topic(a.token, "lot-ai-agents", { topic: "x" }), { status: 422 });
  const topical = await spaces.topic(a.token, "lot-ai-agents", { topic: "Agent evals", tags: ["Evals", "agents"] });
  assert.deepEqual([topical.topic, topical.tags], ["Agent evals", ["evals", "agents"]]);
  assert.equal((await spaces.list({ q: "evals" })).rooms.length, 1);
  assert.equal((await spaces.list({ q: "evals" })).rooms[0].hostName, "Ada");
  await spaces.leave(a.token, "lot-ai-agents");
  assert.equal((await spaces.get(c.token, "lot-ai-agents")).hostId, b.id);
  assert.deepEqual(await spaces.setHost(b.token, "lot-ai-agents", { actorId: c.id }), { hostId: c.id });
  await assert.rejects(spaces.setHost(b.token, "lot-ai-agents", { actorId: b.id }), { status: 403 });
  await assert.rejects(spaces.setHost(c.token, "lot-ai-agents", { actorId: a.id }), { status: 422 });
  await spaces.leave(b.token, "lot-ai-agents");
  await spaces.leave(c.token, "lot-ai-agents");
  const empty = await spaces.get(null, "lot-ai-agents");
  assert.deepEqual([empty.topic, empty.tags, empty.hostId, empty.occupancy], [null, [], null, 0]);
  assert.ok(events.some((event) => event.type === "emptied" && event.spaceId === "lot-ai-agents"));
});

test("expired leases free seats and hand over hosting", async (t) => {
  const { spaces, clock, person } = await setup(t);
  const [a, b] = [await person("Ada"), await person("Bo")];
  await spaces.enter(a.token, "lot-rtc-lab");
  clock.now += 61000;
  const next = await spaces.enter(b.token, "lot-rtc-lab");
  assert.deepEqual([next.firstIn, next.hostId], [true, b.id]);
  await assert.rejects(spaces.heartbeat(a.token, "lot-rtc-lab"), { status: 410 });
  assert.equal((await spaces.heartbeat(b.token, "lot-rtc-lab")).hostId, b.id);
});

test("a full plaza offers the person's unlisted spaces, and lots stay open", async (t) => {
  const { spaces, person } = await setup(t, { plazaCapacity: 1 });
  const [a, b] = [await person("Ada"), await person("Bo")];
  await spaces.enter(a.token, "plaza");
  const own = await spaces.create(b.token, { title: "Bo's corner" });
  await assert.rejects(spaces.enter(b.token, "plaza"), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.message, "The plaza is full right now.");
    assert.deepEqual(error.details, { full: true, offer: { spaces: [{ id: own.id, title: "Bo's corner", visibility: "unlisted", path: "/stoa/s/" + own.id }], canCreate: true } });
    return true;
  });
  assert.equal((await spaces.enter(b.token, "lot-lounge")).firstIn, true);
  await spaces.enter(a.token, "lot-voice-ai");
  assert.equal((await spaces.list()).plaza.occupancy, 0, "people inside a lot leave the plaza");
  assert.equal((await spaces.enter(b.token, "plaza")).space.id, "plaza");
});

test("people can own as many spaces as their plan allows", async (t) => {
  const { spaces, person } = await setup(t);
  const a = await person("Ada");
  for (const title of ["One", "Two", "Three"]) await spaces.create(a.token, { title });
  await assert.rejects(spaces.create(a.token, { title: "Four" }), { status: 409 });
  await assert.rejects(spaces.create(null, { title: "Guest" }), { status: 401 });
});

test("private spaces stay hidden from strangers and admit invitation holders", async (t) => {
  const { spaces, events, clock, person } = await setup(t);
  const [owner, guest, late, later] = [await person("Owner"), await person("Guest"), await person("Late"), await person("Later")];
  const space = await spaces.create(owner.token, { title: "Board room", visibility: "private" });
  await assert.rejects(spaces.get(guest.token, space.id), missing);
  await assert.rejects(spaces.get(guest.token, "00000000-0000-4000-8000-000000000000"), missing);
  await assert.rejects(spaces.enter(guest.token, space.id), missing);
  await assert.rejects(spaces.invite(guest.token, space.id, {}), missing);
  assert.equal(await spaces.visible(guest.token, space.id), false);
  const invitation = await spaces.invite(owner.token, space.id, { uses: 1, hours: 1 });
  assert.equal(invitation.path, "/stoa/s/" + space.id + "?invite=" + invitation.token);
  assert.equal(await spaces.visible(guest.token, space.id, invitation.token), true);
  const entered = await spaces.enter(guest.token, space.id, invitation.token);
  assert.match(entered.channel, /^ab-stoa-[a-f0-9]{24}$/);
  assert.equal(Buffer.from(entered.key, "base64").length, 32);
  assert.ok(events.some((event) => event.type === "member-added" && event.actorId === guest.id));
  assert.equal((await spaces.get(guest.token, space.id)).title, "Board room", "members keep seeing the space");
  await assert.rejects(spaces.invite(guest.token, space.id, {}), { status: 403 });
  await assert.rejects(spaces.enter(late.token, space.id, invitation.token), missing, "used invitations stop working");
  const expiring = await spaces.invite(owner.token, space.id, { uses: 5, hours: 1 });
  clock.now += 3600001;
  await assert.rejects(spaces.enter(later.token, space.id, expiring.token), missing);
  await assert.rejects(spaces.invite(owner.token, space.id, { uses: 0 }), { status: 422 });
  assert.equal(JSON.stringify(await spaces.get(owner.token, space.id)).includes(invitation.token), false, "invitation tokens are never stored in the clear");
});

test("removing someone blocks them, renames hidden channels, and ends their heartbeat", async (t) => {
  const { spaces, events, person } = await setup(t);
  const [owner, visitor] = [await person("Owner"), await person("Visitor")];
  const space = await spaces.create(owner.token, { title: "Open studio", access: "open" });
  const before = await spaces.enter(owner.token, space.id);
  await spaces.enter(visitor.token, space.id);
  await assert.rejects(spaces.removePerson(visitor.token, space.id, { actorId: owner.id }), { status: 403 });
  await assert.rejects(spaces.removePerson(owner.token, space.id, { actorId: owner.id }), { status: 422 });
  const after = await spaces.removePerson(owner.token, space.id, { actorId: visitor.id });
  assert.notEqual(after.channel, before.channel);
  assert.notEqual(after.key, before.key);
  assert.ok(events.some((event) => event.type === "removed" && event.actorId === visitor.id));
  await assert.rejects(spaces.heartbeat(visitor.token, space.id), { status: 410 });
  await assert.rejects(spaces.enter(visitor.token, space.id), { status: 403 });
  await spaces.addMember(owner.token, space.id, visitor.id);
  assert.equal((await spaces.enter(visitor.token, space.id)).channel, after.channel, "the owner can let them back in");
  const left = await spaces.removeMember(owner.token, space.id, visitor.id);
  assert.deepEqual(left.members, [owner.id]);
  assert.ok(events.some((event) => event.type === "member-removed" && event.actorId === visitor.id));
  await assert.rejects(spaces.removeMember(owner.token, space.id, owner.id), { status: 422 });
});

test("owners edit and delete their spaces; the map's rooms cannot be edited", async (t) => {
  const { spaces, events, person } = await setup(t);
  const [owner, other] = [await person("Owner"), await person("Other")];
  const space = await spaces.create(owner.token, { title: "Studio" });
  assert.equal((await spaces.update(owner.token, space.id, { title: "Studio two", themeId: "cyberpunk" })).title, "Studio two");
  await assert.rejects(spaces.update(other.token, space.id, { title: "Mine" }), { status: 403 });
  await assert.rejects(spaces.update(owner.token, "lot-lounge", { title: "Mine" }), { status: 403 });
  await assert.rejects(spaces.destroy(other.token, space.id), { status: 403 });
  assert.deepEqual(await spaces.destroy(owner.token, space.id), { deleted: true });
  assert.ok(events.some((event) => event.type === "deleted" && event.spaceId === space.id));
  await assert.rejects(spaces.get(owner.token, space.id), missing);
});

test("only the host decorates, within the room's rules", async (t) => {
  const { spaces, person } = await setup(t);
  const [a, b] = [await person("Ada"), await person("Bo")];
  await spaces.enter(a.token, "lot-rtc-lab");
  await spaces.enter(b.token, "lot-rtc-lab");
  assert.deepEqual(await spaces.decorate(a.token, "lot-rtc-lab", [{ id: "p", kind: "plant", x: 15, y: 22 }]), { decor: [{ id: "p", kind: "plant", x: 15, y: 22, rotation: 0, variant: 0 }], version: 1 });
  await assert.rejects(spaces.decorate(b.token, "lot-rtc-lab", []), { status: 403 });
  await assert.rejects(spaces.decorate(a.token, "lot-rtc-lab", [{ id: "p", kind: "plant", x: 17, y: 32 }]), { status: 422 });
  await assert.rejects(spaces.decorate(a.token, "plaza", []), { status: 403 });
});

test("Signaling tokens list only channels the person may use", async (t) => {
  const { spaces, person } = await setup(t);
  const [owner, stranger] = [await person("Owner"), await person("Stranger")];
  const hidden = await spaces.create(owner.token, { title: "Secret plans", visibility: "private" });
  const entered = await spaces.enter(owner.token, hidden.id);
  const guest = await spaces.signalingToken(null);
  assert.match(guest.userId, /^g-[a-f0-9]{16}$/);
  assert.deepEqual(guest.channels, [{ spaceId: "plaza", name: "ab-stoa-plaza", write: false, key: null }]);
  const own = await spaces.signalingToken(owner.token);
  assert.equal(own.userId, owner.id.replace("member:", "m-"));
  assert.deepEqual(own.channels.map((channel) => [channel.spaceId, channel.name, channel.write, channel.key]), [["plaza", "ab-stoa-plaza", true, null], [hidden.id, entered.channel, true, entered.key]]);
  const outside = JSON.stringify([await spaces.list(), await spaces.signalingToken(stranger.token), guest]);
  for (const value of [hidden.id, "Secret plans", entered.channel, entered.key]) assert.equal(outside.includes(value), false, value);
});

test("RTC tokens require being inside a room", async (t) => {
  const { spaces, person } = await setup(t);
  const a = await person("Ada");
  await assert.rejects(spaces.rtcToken(a.token, "lot-lounge", {}), { status: 403 });
  await spaces.enter(a.token, "lot-lounge");
  assert.equal((await spaces.rtcToken(a.token, "lot-lounge", {})).channel, "agora-build-space-lot-lounge");
  await spaces.enter(a.token, "plaza");
  await assert.rejects(spaces.rtcToken(a.token, "plaza", {}), { status: 422 });
});

test("simultaneous entries never exceed capacity and produce one host", async (t) => {
  const { spaces, person } = await setup(t);
  const walkers = [];
  for (let index = 0; index < 8; index += 1) walkers.push(await person("Walker " + index));
  const results = await Promise.allSettled(walkers.map((walker) => spaces.enter(walker.token, "lot-rtc-lab")));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 6);
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => result.reason.status === 409));
  assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.firstIn).length, 1);
  const room = await spaces.get(null, "lot-rtc-lab");
  assert.equal(room.occupancy, 6);
  assert.ok(room.occupants.some((occupant) => occupant.id === room.hostId));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spaces-service.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/spaces/service.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/spaces/service.mjs`:

```js
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../store.mjs";
import { entitlements } from "../plans.mjs";
import { parseMap } from "../../world/map.js";
import { can } from "./permissions.mjs";
import { PLAZA_ID, migratedRoom, newSpace, normalizeTags, publicSpace, spaceInput, systemSpaces } from "./model.mjs";
import { enter as enterLease, heartbeat as heartbeatLease, leaseOf, leasesFor, leave as leaveLease, sweep as sweepLeases } from "./leases.mjs";
import { validateDecor } from "./decor.mjs";
import { channelName, signalingUser, spaceKey } from "./signaling.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const ACTOR_ID = /^(member|account):[a-f0-9-]{36}$/;
const notFound = () => new AppError(404, "This space was not found.");

export function loadWorlds(directory) {
  return Object.fromEntries(["plaza", "room"].map((id) => {
    const source = JSON.parse(readFileSync(resolve(directory, "worlds", id, "map.json"), "utf8"));
    return [id, { source, map: parseMap(source) }];
  }));
}

export function createSpaces({ store, worlds, signaling, calls, secret = "", admins = [], now = Date.now, plazaCapacity }) {
  const listeners = [];
  let prepared;
  // System spaces follow the plaza map; legacy meeting rooms become unlisted members-only spaces once.
  const ready = () => prepared ||= store.transaction((state) => {
    for (const system of systemSpaces(worlds.plaza.map, now(), plazaCapacity)) {
      const existing = state.spaces.find((space) => space.id === system.id);
      if (!existing) state.spaces.push(system);
      else Object.assign(existing, { title: system.title, capacity: system.capacity, slug: system.slug, lot: system.lot });
    }
    for (const room of state.rooms) if (!state.spaces.some((space) => space.id === room.id)) state.spaces.push(migratedRoom(room, now()));
  }).catch((error) => { prepared = undefined; throw error; });
  async function mutate(work) {
    await ready();
    const events = [];
    const result = await store.transaction((state) => { events.push(...sweepLeases(state, now())); return work(state, events); });
    if (events.length) for (const listener of listeners) listener(events);
    return result;
  }
  async function actorFor(token) {
    const actor = token ? await store.actor(token) : null;
    return actor && { ...actor, ids: [actor.accountId, actor.memberId].filter(Boolean), admin: Boolean(actor.accountId && admins.includes(actor.accountId)) };
  }
  const signedIn = (actor) => { if (!actor) throw new AppError(401, "Sign in to step into the Stoa."); return actor; };
  const find = (state, id) => { const space = state.spaces.find((entry) => entry.id === id); if (!space) throw notFound(); return space; };
  const system = (space) => Boolean(space.lot) || space.id === PLAZA_ID;
  const invitationFor = (space, invite) => typeof invite === "string" && invite ? space.invitations.find((entry) => entry.tokenHash === hash(invite) && entry.expiresAt > now() && entry.usesLeft > 0) || null : null;
  const present = (state, space, actor) => Boolean(actor && leaseOf(state, space.id, actor.id, now()));
  const visible = (state, space, actor, invite) => can(actor, "see", space, { invited: Boolean(invitationFor(space, invite)), present: present(state, space, actor) });
  const findVisible = (state, id, actor, invite) => { const space = find(state, id); if (!visible(state, space, actor, invite)) throw notFound(); return space; };
  const occupants = (state, space) => leasesFor(state, space.id, now()).sort((a, b) => a.enteredAt - b.enteredAt).map((lease) => ({ id: lease.actorId, name: lease.name }));
  const view = (state, space, actor) => publicSpace(space, { occupants: occupants(state, space), manage: can(actor, "edit", space) });
  const owned = (state, actor) => state.spaces.filter((space) => !system(space) && actor.ids.includes(space.ownerId));
  const offerFor = (state, actor) => ({ spaces: state.spaces.filter((space) => !system(space) && space.members.some((id) => actor.ids.includes(id))).map((space) => ({ id: space.id, title: space.title, visibility: space.visibility, path: "/stoa/s/" + space.id })), canCreate: owned(state, actor).length < entitlements(actor.plan).spaces });
  const access = (space) => ({ channel: channelName(secret, space), key: spaceKey(secret, space), blocked: space.blocked, hostId: space.hostId });
  const requirePresent = (state, space, actor) => { if (!present(state, space, actor)) throw new AppError(403, "Step into this space first."); };

  const spaces = {
    onEvents(listener) { listeners.push(listener); },
    async sweep() { await mutate(() => null); },
    async list({ q = "" } = {}) {
      await ready();
      const state = await store.snapshot();
      const query = String(q).trim().toLowerCase().slice(0, 100);
      const plaza = find(state, PLAZA_ID);
      const rooms = state.spaces.filter((space) => space.visibility === "listed" && space.lot).map((space) => {
        const people = occupants(state, space);
        return { id: space.id, slug: space.slug, title: space.title, topic: space.topic, tags: space.tags, capacity: space.capacity, occupancy: people.length, occupants: people, hostName: people.find((entry) => entry.id === space.hostId)?.name || null, path: "/stoa/room/" + space.slug };
      }).filter((room) => !query || [room.title, room.topic || "", ...room.tags].some((value) => value.toLowerCase().includes(query)));
      return { plaza: { capacity: plaza.capacity, occupancy: leasesFor(state, PLAZA_ID, now()).length, blocked: plaza.blocked }, rooms };
    },
    async create(token, input) {
      const actor = signedIn(await actorFor(token));
      const fields = spaceInput(input || {});
      return mutate((state) => {
        if (owned(state, actor).length >= entitlements(actor.plan).spaces) throw new AppError(409, "You have reached your plan's space limit.", { offer: offerFor(state, actor) });
        const space = newSpace(fields, { id: randomUUID(), ownerId: actor.id, now: now() });
        state.spaces.push(space);
        return view(state, space, actor);
      });
    },
    async get(token, id, invite) {
      await ready();
      const actor = await actorFor(token);
      const state = await store.snapshot();
      return view(state, findVisible(state, id, actor, invite), actor);
    },
    async visible(token, id, invite) {
      try { await spaces.get(token, id, invite); return true; }
      catch (error) { if (error.status === 404) return false; throw error; }
    },
    async update(token, id, input) {
      const actor = signedIn(await actorFor(token));
      return mutate((state) => {
        const space = findVisible(state, id, actor);
        if (system(space)) throw new AppError(403, "The map sets the plaza and its rooms.");
        if (!can(actor, "edit", space)) throw new AppError(403, "Only the owner can change this space.");
        const fields = spaceInput(input || {}, space);
        if (fields.visibility !== space.visibility) space.channelEpoch += 1;
        Object.assign(space, fields, { updatedAt: new Date(now()).toISOString() });
        return view(state, space, actor);
      });
    },
    async destroy(token, id) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = findVisible(state, id, actor);
        if (system(space) || !can(actor, "delete", space)) throw new AppError(403, "Only the owner can delete this space.");
        state.spaces = state.spaces.filter((entry) => entry !== space);
        state.spaceLeases = state.spaceLeases.filter((lease) => lease.spaceId !== space.id);
        events.push({ type: "deleted", spaceId: space.id, members: space.members });
        return { deleted: true };
      });
    },
    async enter(token, id, invite) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = find(state, id);
        const invitation = invitationFor(space, invite);
        const context = { invited: Boolean(invitation), present: present(state, space, actor) };
        if (!can(actor, "see", space, context)) throw notFound();
        if (!can(actor, "enter", space, context)) throw new AppError(403, space.blocked.some((entry) => actor.ids.includes(entry)) ? "You can't enter this space right now." : "This space is open to its members.");
        if (invitation && !space.members.some((entry) => actor.ids.includes(entry))) {
          space.members.push(actor.id);
          invitation.usesLeft -= 1;
          events.push({ type: "member-added", spaceId: space.id, actorId: actor.id });
        }
        if (space.lot) events.push(...leaveLease(state, find(state, PLAZA_ID), actor.id, now()));
        let result;
        try { result = enterLease(state, space, actor, now()); }
        catch (error) {
          if (space.id === PLAZA_ID && error.status === 409) throw new AppError(409, "The plaza is full right now.", { full: true, offer: offerFor(state, actor) });
          throw error;
        }
        events.push(...result.events);
        return { space: view(state, space, actor), firstIn: result.firstIn, ...access(space) };
      });
    },
    async leave(token, id) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => { events.push(...leaveLease(state, find(state, id), actor.id, now())); return { left: true }; });
    },
    async heartbeat(token, id) {
      const actor = signedIn(await actorFor(token));
      return mutate((state) => { const space = find(state, id); heartbeatLease(state, space, actor.id, now()); return access(space); });
    },
    async topic(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      const topic = typeof input.topic === "string" ? input.topic.trim() : "";
      if (topic.length < 2 || topic.length > 80) throw new AppError(422, "Add a topic of 2 to 80 characters.");
      const tags = normalizeTags(input.tags);
      return mutate((state) => {
        const space = find(state, id);
        requirePresent(state, space, actor);
        if (space.id === PLAZA_ID || !can(actor, "host", space, { present: true })) throw new AppError(403, "Only the host can set the topic.");
        Object.assign(space, { topic, tags });
        return view(state, space, actor);
      });
    },
    async setHost(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = find(state, id);
        requirePresent(state, space, actor);
        if (space.id === PLAZA_ID || !can(actor, "host", space, { present: true })) throw new AppError(403, "Only the host or owner can hand over hosting.");
        const target = leaseOf(state, space.id, input.actorId, now());
        if (!target) throw new AppError(422, "Choose someone who is here.");
        space.hostId = target.actorId;
        events.push({ type: "host", spaceId: space.id, hostId: space.hostId });
        return { hostId: space.hostId };
      });
    },
    async decorate(token, id, items) {
      const actor = signedIn(await actorFor(token));
      return mutate((state) => {
        const space = find(state, id);
        requirePresent(state, space, actor);
        if (space.id === PLAZA_ID || !can(actor, "decorate", space, { present: true })) throw new AppError(403, "Only the host can decorate.");
        space.decor = validateDecor(items, worlds[space.worldId].map, space);
        space.decorVersion = (space.decorVersion || 0) + 1;
        return { decor: space.decor, version: space.decorVersion };
      });
    },
    async removePerson(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = find(state, id);
        requirePresent(state, space, actor);
        if (!can(actor, "moderate", space, { present: true })) throw new AppError(403, "Only the host can remove someone.");
        const target = leaseOf(state, space.id, input.actorId, now());
        const ids = target?.ids || [input.actorId];
        if (!ACTOR_ID.test(input.actorId || "") || ids.includes(space.ownerId) || ids.some((entry) => actor.ids.includes(entry))) throw new AppError(422, "This person can't be removed.");
        space.blocked = [...new Set([...space.blocked, ...ids])];
        if (space.visibility !== "listed") space.channelEpoch += 1;
        events.push(...leaveLease(state, space, input.actorId, now()), { type: "removed", spaceId: space.id, actorId: input.actorId });
        return { removed: true, ...access(space) };
      });
    },
    async invite(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      const uses = input.uses ?? 10, hours = input.hours ?? 72;
      if (!Number.isInteger(uses) || uses < 1 || uses > 100 || !Number.isInteger(hours) || hours < 1 || hours > 720) throw new AppError(422, "Choose 1 to 100 uses and 1 to 720 hours.");
      const raw = randomBytes(24).toString("base64url");
      return mutate((state) => {
        const space = findVisible(state, id, actor);
        if (system(space) || !can(actor, "invite", space)) throw new AppError(403, "Only the owner can invite people.");
        space.invitations = space.invitations.filter((entry) => entry.expiresAt > now() && entry.usesLeft > 0).slice(-49);
        const invitation = { id: randomUUID(), tokenHash: hash(raw), usesLeft: uses, expiresAt: now() + hours * 3600000, createdBy: actor.id, createdAt: new Date(now()).toISOString() };
        space.invitations.push(invitation);
        return { token: raw, path: "/stoa/s/" + space.id + "?invite=" + raw, usesLeft: uses, expiresAt: new Date(invitation.expiresAt).toISOString() };
      });
    },
    async addMember(token, id, memberId) {
      const actor = signedIn(await actorFor(token));
      if (!ACTOR_ID.test(memberId || "")) throw new AppError(422, "Choose a builder to add.");
      return mutate((state, events) => {
        const space = findVisible(state, id, actor);
        if (system(space) || !can(actor, "edit", space)) throw new AppError(403, "Only the owner can change members.");
        space.blocked = space.blocked.filter((entry) => entry !== memberId);
        if (!space.members.includes(memberId)) { space.members.push(memberId); events.push({ type: "member-added", spaceId: space.id, actorId: memberId }); }
        return { members: space.members };
      });
    },
    async removeMember(token, id, memberId) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = findVisible(state, id, actor);
        if (system(space) || !can(actor, "edit", space)) throw new AppError(403, "Only the owner can change members.");
        if (memberId === space.ownerId) throw new AppError(422, "The owner stays a member.");
        space.members = space.members.filter((entry) => entry !== memberId);
        if (space.visibility !== "listed") space.channelEpoch += 1;
        events.push(...leaveLease(state, space, memberId, now()), { type: "member-removed", spaceId: space.id, actorId: memberId });
        return { members: space.members };
      });
    },
    async signalingToken(token) {
      await ready();
      const actor = await actorFor(token);
      const state = await store.snapshot();
      const channels = [{ spaceId: PLAZA_ID, name: channelName(secret, find(state, PLAZA_ID)), write: Boolean(actor), key: null }];
      if (actor) for (const lease of state.spaceLeases.filter((entry) => entry.actorId === actor.id && entry.expiresAt > now() && entry.spaceId !== PLAZA_ID)) {
        const space = state.spaces.find((entry) => entry.id === lease.spaceId);
        if (space) channels.push({ spaceId: space.id, name: channelName(secret, space), write: true, key: spaceKey(secret, space) });
      }
      return { ...signaling.issue(signalingUser(actor), channels), channels };
    },
    async rtcToken(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      await ready();
      const state = await store.snapshot();
      const space = find(state, id);
      if (space.id === PLAZA_ID) throw new AppError(422, "Calls happen inside rooms.");
      if (!present(state, space, actor)) throw new AppError(403, "Step into this space before joining its call.");
      return calls.issueSpace(space, actor, input);
    }
  };
  return spaces;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/spaces-service.test.mjs`
Expected: PASS (12 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/spaces/service.mjs tests/spaces-service.test.mjs
git commit -m "Add the spaces service" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 11: HTTP routes, Stoa pages, build output, and configuration

**Files:**
- Create: `scripts/spaces/routes.mjs`, `stoa.html`
- Modify: `scripts/serve.mjs` (imports, wiring in `createAppServer`, the last `/api/` branch, page routing, `publicFiles`, the sweeper)
- Modify: `scripts/build.mjs`, `.env.example`, `README.md`
- Modify: `tests/server.test.mjs` (the production output test)
- Test: `tests/spaces-api.test.mjs`

**Interfaces:**
- Consumes: `createSpaces`, `loadWorlds` (Task 10); `createSignaling`, `signalingConfig` (Task 8).
- Produces:
  - `handleSpaces({ path, method, url, token, read, spaces, worlds, limit, ip }) -> { status, body } | null`
  - `createAppServer` options: `worlds`, `signaling`, `spaces`, `channelSecret`, `plazaCapacity`
  - Pages: `/stoa/`, `/stoa/room/<slug>`, `/stoa/s/<id>`, all served by `stoa.html`
  - Endpoints as listed in spec section 5 (discovery endpoints come in Plan E)

- [ ] **Step 1: Write the failing test**

Create `tests/spaces-api.test.mjs`:

```js
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAppServer } from "../scripts/serve.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { authConfig, createAuth } from "../scripts/auth.mjs";
import { createSignaling, signalingConfig } from "../scripts/spaces/signaling.mjs";

const root = new URL("../", import.meta.url).pathname;
const env = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACE_CHANNEL_SECRET: "s".repeat(32) };
const profile = (name) => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });
const absent = "/00000000-0000-4000-8000-000000000000";
let temporary;
const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });
async function start(options = {}) {
  const instance = createAppServer(root, { monitor: false, storageFile: resolve(temporary, Math.random() + ".json"), models: createModelClient(modelConfig({})), calls: createAgoraCalls(agoraConfig(env)), auth: createAuth(authConfig({})), signaling: createSignaling(signalingConfig(env)), channelSecret: env.SPACE_CHANNEL_SECRET, ...options });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  return { instance, url: "http://127.0.0.1:" + instance.address().port };
}
const request = (base, path, { cookie, method = "GET", data } = {}) => fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
const post = (base, path, cookie, data = {}) => request(base, path, { cookie, method: "POST", data });
async function join(base, name) {
  const response = await post(base, "/api/profile", undefined, profile(name));
  assert.equal(response.status, 201);
  return response.headers.get("set-cookie").split(";")[0];
}
before(async () => { temporary = await mkdtemp(resolve(tmpdir(), "spaces-api-")); });
after(() => rm(temporary, { recursive: true, force: true }));

test("Stoa pages and worlds are served, and hidden spaces look exactly like missing ones", async () => {
  const { instance, url } = await start();
  try {
    for (const path of ["/stoa/", "/stoa/room/ai-agents"]) {
      const response = await request(url, path);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /Stoa/);
    }
    assert.equal((await request(url, "/stoa/room/nowhere")).status, 404);
    const owner = await join(url, "Owner"), stranger = await join(url, "Stranger");
    const created = await post(url, "/api/spaces", owner, { title: "Board room", visibility: "private" });
    assert.equal(created.status, 201);
    const { space } = await created.json();
    assert.equal((await request(url, "/stoa/s/" + space.id, { cookie: owner })).status, 200);
    const hidden = await request(url, "/stoa/s/" + space.id, { cookie: stranger });
    const missing = await request(url, "/stoa/s" + absent, { cookie: stranger });
    assert.deepEqual([hidden.status, await hidden.text()], [missing.status, await missing.text()]);
    const apiHidden = await request(url, "/api/spaces/" + space.id, { cookie: stranger });
    const apiMissing = await request(url, "/api/spaces" + absent, { cookie: stranger });
    assert.deepEqual([apiHidden.status, await apiHidden.json()], [404, await apiMissing.json()]);
    const plaza = await (await request(url, "/api/worlds/plaza")).json();
    assert.deepEqual([plaza.width, plaza.height], [44, 34]);
    assert.equal((await request(url, "/api/worlds/secret")).status, 404);
    assert.equal(JSON.stringify(await (await request(url, "/api/spaces")).json()).includes(space.id), false);
    assert.equal((await post(url, "/api/spaces", undefined, { title: "Guest" })).status, 401);
  } finally { await close(instance); }
});

test("walking in, hosting, decorating, and calls work over HTTP", async () => {
  const { instance, url } = await start();
  try {
    const ada = await join(url, "Ada"), bo = await join(url, "Bo");
    assert.equal((await post(url, "/api/spaces/lot-voice-ai/enter")).status, 401);
    const entered = await (await post(url, "/api/spaces/lot-voice-ai/enter", ada)).json();
    assert.deepEqual([entered.firstIn, entered.channel], [true, "ab-stoa-voice-ai"]);
    await post(url, "/api/spaces/lot-voice-ai/enter", bo);
    assert.equal((await post(url, "/api/spaces/lot-voice-ai/topic", bo, { topic: "Turn taking" })).status, 403);
    const topic = await post(url, "/api/spaces/lot-voice-ai/topic", ada, { topic: "Turn taking", tags: ["latency"] });
    assert.equal((await topic.json()).space.topic, "Turn taking");
    const listing = await (await request(url, "/api/spaces?q=latency")).json();
    assert.deepEqual(listing.rooms.map((room) => [room.slug, room.occupancy, room.hostName]), [["voice-ai", 2, "Ada"]]);
    const decor = await request(url, "/api/spaces/lot-voice-ai/decor", { cookie: ada, method: "PUT", data: { items: [{ id: "lamp", kind: "lamp", x: 8, y: 22 }] } });
    assert.equal((await decor.json()).version, 1);
    const call = await (await post(url, "/api/spaces/lot-voice-ai/rtc-token", ada)).json();
    assert.equal(call.channel, "agora-build-space-lot-voice-ai");
    assert.equal((await request(url, "/api/spaces/lot-voice-ai/heartbeat", { cookie: ada, method: "POST" })).status, 200);
    assert.equal((await request(url, "/api/spaces/lot-voice-ai/leave", { cookie: ada, method: "POST" })).status, 200);
    assert.equal((await request(url, "/api/spaces/lot-voice-ai/heartbeat", { cookie: ada, method: "POST" })).status, 410);
    const signaling = await (await post(url, "/api/signaling/token")).json();
    assert.match(signaling.userId, /^g-/);
  } finally { await close(instance); }
});

test("a full plaza answers with an offer of other places", async () => {
  const { instance, url } = await start({ plazaCapacity: 1 });
  try {
    const ada = await join(url, "Ada"), bo = await join(url, "Bo");
    assert.equal((await post(url, "/api/spaces/plaza/enter", ada)).status, 200);
    const full = await post(url, "/api/spaces/plaza/enter", bo);
    assert.equal(full.status, 409);
    assert.deepEqual(await full.json(), { error: "The plaza is full right now.", full: true, offer: { spaces: [], canCreate: true } });
  } finally { await close(instance); }
});

test("invitations, membership, and deletion work over HTTP", async () => {
  const { instance, url } = await start();
  try {
    const owner = await join(url, "Owner"), guest = await join(url, "Guest");
    const guestId = (await (await request(url, "/api/me", { cookie: guest })).json()).profile.id;
    const { space } = await (await post(url, "/api/spaces", owner, { title: "Board room", visibility: "private" })).json();
    const invitation = await post(url, "/api/spaces/" + space.id + "/invitations", owner, { uses: 2, hours: 24 });
    assert.equal(invitation.status, 201);
    const { token } = await invitation.json();
    assert.equal((await request(url, "/api/spaces/" + space.id + "?invite=" + token, { cookie: guest })).status, 200);
    assert.equal((await post(url, "/api/spaces/" + space.id + "/enter", guest, { invite: token })).status, 200);
    assert.equal((await request(url, "/api/spaces/" + space.id + "/members/" + guestId, { cookie: owner, method: "DELETE" })).status, 200);
    assert.equal((await request(url, "/api/spaces/" + space.id, { cookie: guest })).status, 404);
    assert.equal((await request(url, "/api/spaces/" + space.id, { cookie: owner, method: "DELETE" })).status, 200);
    assert.equal((await request(url, "/api/spaces/" + space.id, { cookie: owner })).status, 404);
  } finally { await close(instance); }
});

test("missing Signaling or call configuration is reported plainly", async () => {
  const { instance, url } = await start({ signaling: createSignaling(signalingConfig({})), calls: createAgoraCalls(agoraConfig({})) });
  try {
    assert.equal((await post(url, "/api/signaling/token")).status, 503);
    const ada = await join(url, "Ada");
    assert.equal((await post(url, "/api/spaces/lot-lounge/enter", ada)).status, 200);
    assert.equal((await post(url, "/api/spaces/lot-lounge/rtc-token", ada)).status, 503);
  } finally { await close(instance); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spaces-api.test.mjs`
Expected: FAIL. `/stoa/` returns 404 and `/api/spaces` returns 404.

- [ ] **Step 3: Implement routes and wiring**

Create `scripts/spaces/routes.mjs`:

```js
import { AppError } from "../store.mjs";

const SPACE = /^\/api\/spaces\/(plaza|lot-[a-z0-9-]{2,40}|[a-f0-9-]{36})(?:\/(enter|leave|heartbeat|topic|host|decor|remove|invitations|members|rtc-token)(?:\/((?:member|account):[a-f0-9-]{36}))?)?$/;

// Maps HTTP requests to the spaces service. Returns null when the request is not a spaces route.
export async function handleSpaces({ path, method, url, token, read, spaces, worlds, limit, ip }) {
  if (path === "/api/spaces" && method === "GET") return { status: 200, body: await spaces.list({ q: url.searchParams.get("q") || "" }) };
  if (path === "/api/spaces" && method === "POST") { limit("spaces:" + ip, 20, 3600000); return { status: 201, body: { space: await spaces.create(token, await read()) } }; }
  if (path === "/api/signaling/token" && method === "POST") { limit("signaling:" + ip, 30, 60000); return { status: 200, body: await spaces.signalingToken(token) }; }
  const world = /^\/api\/worlds\/([a-z]+)$/.exec(path);
  if (world && method === "GET") {
    if (!Object.hasOwn(worlds, world[1])) throw new AppError(404, "This world was not found.");
    return { status: 200, body: worlds[world[1]].source };
  }
  const match = SPACE.exec(path);
  if (!match) return null;
  const [, id, action, memberId] = match;
  limit("space:" + ip, 240, 60000);
  if (!action) {
    if (method === "GET") return { status: 200, body: { space: await spaces.get(token, id, url.searchParams.get("invite")) } };
    if (method === "PUT") return { status: 200, body: { space: await spaces.update(token, id, await read()) } };
    if (method === "DELETE") return { status: 200, body: await spaces.destroy(token, id) };
    return null;
  }
  if (memberId) return action === "members" && method === "DELETE" ? { status: 200, body: await spaces.removeMember(token, id, memberId) } : null;
  if (action === "decor" && method === "PUT") return { status: 200, body: await spaces.decorate(token, id, (await read()).items) };
  if (method !== "POST") return null;
  // Leaving and heartbeats carry no body, so navigator.sendBeacon can call them.
  if (action === "leave") return { status: 200, body: await spaces.leave(token, id) };
  if (action === "heartbeat") return { status: 200, body: await spaces.heartbeat(token, id) };
  const input = await read();
  if (action === "enter") return { status: 200, body: await spaces.enter(token, id, input.invite) };
  if (action === "topic") return { status: 200, body: { space: await spaces.topic(token, id, input) } };
  if (action === "host") return { status: 200, body: await spaces.setHost(token, id, input) };
  if (action === "remove") return { status: 200, body: await spaces.removePerson(token, id, input) };
  if (action === "invitations") return { status: 201, body: await spaces.invite(token, id, input) };
  if (action === "members") return { status: 200, body: await spaces.addMember(token, id, input.memberId) };
  if (action === "rtc-token") return { status: 200, body: await spaces.rtcToken(token, id, input) };
  return null;
}
```

In `scripts/serve.mjs`:

1. Add the imports after the `createPostgresPersistence` import:

```js
import { createSignaling, signalingConfig } from "./spaces/signaling.mjs";
import { createSpaces, loadWorlds } from "./spaces/service.mjs";
import { handleSpaces } from "./spaces/routes.mjs";
```

2. Add `"stoa.html"` and `"world/map.js"` to the `publicFiles` set.

3. In `createAppServer`, after the `const activity = ...` line, add:

```js
  const worlds = options.worlds || loadWorlds(directory);
  const signaling = options.signaling || createSignaling(signalingConfig());
  const spaces = options.spaces || createSpaces({ store, worlds, signaling, calls, secret: options.channelSecret ?? signalingConfig().secret, admins: (process.env.PLATFORM_ADMINS || "").split(",").map((id) => id.trim()).filter(Boolean), plazaCapacity: options.plazaCapacity });
```

4. Replace the final branch of the `/api/` chain, `        } else throw new AppError(404, "This page or service was not found.");`, with:

```js
        } else {
          const handled = await handleSpaces({ path, method: request.method, url: requestUrl, token, read: () => body(request), spaces, worlds, limit, ip: request.socket.remoteAddress });
          if (!handled) throw new AppError(404, "This page or service was not found.");
          json(response, handled.status, handled.body);
        }
```

5. Replace the line `      const filename = meeting ? "meetings.html" : path === "/" ? "index.html" : path.slice(1);` with:

```js
      const stoa = /^\/stoa(?:\/|\/room\/([a-z0-9-]{2,40})|\/s\/([a-f0-9-]{36}))$/.exec(path);
      if (stoa && ((stoa[1] && !worlds.plaza.map.lots.some((lot) => lot.slug === stoa[1])) || (stoa[2] && !(await spaces.visible(token, stoa[2], requestUrl.searchParams.get("invite")))))) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("This space was not found."); return; }
      const filename = stoa ? "stoa.html" : meeting ? "meetings.html" : path === "/" ? "index.html" : path.slice(1);
```

6. Before `return server;`, add the sweeper:

```js
  const spaceSweep = setInterval(() => { spaces.sweep().catch(() => {}); }, 15000);
  spaceSweep.unref();
  server.on("close", () => clearInterval(spaceSweep));
```

Create `stoa.html` (a shell; Plan C replaces its body):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#202824">
  <meta name="description" content="The Stoa is Agora Build's walkable plaza for builders: meet people, start a topic, and work together.">
  <title>Stoa | Agora Build</title>
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <main id="main" class="main-content">
    <section class="page-intro"><div><p class="kicker">THE STOA</p><h1>The plaza is being built.</h1><p>Soon you can walk in, meet builders, start a topic, and work together.</p></div></section>
  </main>
</body>
</html>
```

In `scripts/build.mjs`:

1. Add `"stoa.html"` to the first file list, after `"account.js"`.
2. After the line that copies the `scripts/*.mjs` files, add:

```js
await cp(new URL("scripts/spaces/", root), new URL("scripts/spaces/", output), { recursive: true });
await cp(new URL("world/", root), new URL("world/", output), { recursive: true });
await cp(new URL("worlds/", root), new URL("worlds/", output), { recursive: true });
```

In `tests/server.test.mjs`, the production output test:

1. Add `"stoa.html"`, `"world/map.js"`, `"worlds/plaza/map.json"`, `"worlds/room/map.json"`, `"scripts/spaces/service.mjs"`, and `"scripts/spaces/routes.mjs"` to the `files` array.
2. Inside its `try` block, add:

```js
    assert.equal((await request("/stoa/", { base: built.url })).status, 200);
```

In `.env.example`, after `AGORA_TOKEN_TTL_SECONDS=3600`, add:

```
# Agora Signaling (RTM 2.x) carries movement, presence and live messages, using AGORA_APP_ID and AGORA_APP_CERTIFICATE.
# Enable Signaling for the project in Agora Console.
# At least 32 random characters. Derives private channel names and per-space keys; keep it secret and stable.
SPACE_CHANNEL_SECRET=
# Set to true only after Agora enables per-channel Signaling permissions for this project.
AGORA_RTM_PERMISSIONS=false
# Comma-separated portal account IDs (account:<uuid>) with platform admin rights in spaces.
PLATFORM_ADMINS=
```

In `README.md`, add a section after `## Agora group calls`:

```markdown
## Stoa spaces

The Stoa is a walkable plaza (`/stoa/`) with first-come rooms (`/stoa/room/<slug>`) and unlisted or private spaces (`/stoa/s/<id>`). Calls use Agora RTC; movement, presence, and live messages use Agora Signaling. Enable Signaling for the Agora project and set `SPACE_CHANNEL_SECRET` to at least 32 random characters. The built-in maps in `worlds/` are generated by `npm run maps`.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/spaces-api.test.mjs`
Expected: PASS (5 tests).

Run: `npm test`
Expected: PASS, including the updated production output test.

Run: `npm run build && node dist/scripts/serve.mjs --port 4199 & sleep 2; curl -s -o /dev/null -w "%{http_code}\n" localhost:4199/stoa/; curl -s localhost:4199/api/spaces | head -c 200; kill %1`
Expected: `200`, then JSON beginning with `{"plaza":{"capacity":200`.

- [ ] **Step 5: Commit**

```bash
git add scripts/spaces/routes.mjs stoa.html scripts/serve.mjs scripts/build.mjs .env.example README.md tests/server.test.mjs tests/spaces-api.test.mjs
git commit -m "Serve the spaces API and Stoa pages" -m "🤖 Built with SMT <smt@agora.build>"
```

---

## Spec Coverage (Plan A)

| Spec requirement | Task |
| --- | --- |
| Space record, visibility and access kept separate, private needs `members` | 4, 5 |
| `can()` used by REST and tokens | 4, 10 |
| Plaza and lots from the map, FCFS, topic and tags, plaza capacity 200 and the full-plaza offer | 3, 5, 6, 10 |
| Hosts (first in, longest present, owner priority, hand-over), host powers | 6, 10 |
| Decorating rules and limits | 7, 10 |
| User spaces, entitlements 3 and 20, invitations (hashed, expiring, limited uses), members | 1, 5, 10 |
| Migration of meeting rooms | 5, 10 |
| Entry leases, heartbeat, sweeper, lot reset | 6, 10, 11 |
| Signaling: channel names, per-space keys, epochs, guest and member tokens, optional permissions | 8, 10 |
| RTC only for lease holders | 9, 10 |
| Maps (Tiled subset, roles, lots, spawns, zones, interactables), shared module | 2, 3 |
| Pages and API, 404 that matches a missing space, error details | 1, 11 |
| Hooks for Chat sync (events) and discovery (tags, `?q=`, noticeboards on the map) | 3, 5, 10 |

Deferred to later plans: `/meet/<id>` redirect and the meetings page retirement, client-side encryption and receiver rules (C), themes and the renderer (B), Chat (D), and noticeboard results and profile cards (E).

## Notes for Later Plans (from the final review)

- **Plan C (client):**
  - Treat 404 and 410 from `heartbeat` as "you have left".
  - Call `/api/signaling/token` after `enter`, because the enter response carries channel names and keys but no token.
  - Update a space with `PUT /api/spaces/<id>`; the spec says PATCH, so align the spec.
  - Add a 308 redirect from `/stoa` to `/stoa/`.
  - Key the spaces rate limits by actor rather than IP so heartbeats from a shared NAT don't exhaust them.
  - Decide whether owners and admins may remove people without being present.
- **Plan D (Chat):**
  - `spaces.onEvents` runs after commit and cannot veto a change, but the spec wants member-list changes kept only if Chat succeeds. Add a pre-commit hook or a compensating transaction for create, delete, add-member, remove-member and invitation acceptance.
  - Rule on invitation acceptance inside `enter`, which must never block.
  - Events carry only `actorId`; add `ids` so Chat usernames can be derived from member IDs.
  - Add a `created` event.
  - Ignore plaza `entered`/`left` events.
- **Plan E (discovery):**
  - Occupants expose only `{ id, name }`. Add the member ID for profile cards and DMs.
  - Make `publicSpace` an allowlist before adding new fields.
- **`/meet` redirect (Plan C):**
  - Room migration runs once per process. Re-sync rooms or freeze room creation before redirecting `/meet/<id>`.
  - Migrated rooms count toward the 3-space Basic limit.
- **Scale:**
  - Leases live in the single state document, so every heartbeat rewrites it.
  - Move leases out of the aggregate, or batch heartbeats, before real plaza load.
