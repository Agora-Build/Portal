# World Engine And Themes (Plan B of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Stoa visible: a themed, walkable plaza at `/stoa/` where one person moves by click, tap, or keyboard, with three built-in themes, a Minimal view, and an accessible side panel.

**Architecture:** There are three layers. Maps (`worlds/*.json`) say what each tile is for. Themes (`themes/<id>/theme.json`) are data only and say how each tile and decoration looks. The engine (`world/*.js`) handles movement, camera, and input, and draws through a swappable `Renderer` interface whose Canvas 2D implementation draws from a fixed catalog of patterns and shapes. Everything under `world/` is plain browser ESM; the pure parts are also imported by Node tests and the server.

**Tech Stack:** Browser ES modules, Canvas 2D, the Node 20 built-in test runner, and no new dependencies. Visual checks use the installed `google-chrome --headless`.

**Spec:** `docs/superpowers/specs/2026-10-07-stoa-spaces-design.md` (section 4, "World Engine And Themes")

**Builds on Plan A:** `world/map.js` (`parseMap`, `findPath`, `walkable`, `reachable`), the worlds in `worlds/`, `GET /api/worlds/<id>`, `GET /api/spaces`, `scripts/spaces/routes.mjs` (`handleSpaces`), `scripts/spaces/model.mjs` (`THEMES`), and the `stoa.html` shell.

## Global Constraints

- No new npm dependencies and no external assets (no image URLs or CDN fonts beyond the stylesheet's existing Google Fonts import).
- Themes are data only: no JavaScript, and no image files in this plan. Image roles come with the later custom-themes plan.
- Every theme must draw every core role (`CORE_ROLES`) and every themed kind (`THEMED_KINDS`, the 13 decor kinds plus `noticeboard`).
- Theme UI tokens are limited to `--paper`, `--surface`, `--ink`, `--muted`, `--line`, `--accent`, `--accent-dark`, `--green` (hex colors only) and `font` (one of `IBM Plex Sans`, `IBM Plex Mono`, `Georgia`, `system-ui`).
- Effects come only from the catalog `dust`, `rain`, `leaves`, `neon-glow`. With `prefers-reduced-motion`, nothing animates: no effects, no water motion, and no idle redraw loop.
- The canvas is never the only way to act. A DOM panel lists rooms with **Go to** buttons, the people present, and live status messages.
- Viewers may switch only their own display to Minimal. `?theme=<id>` previews a built-in theme for the viewer only.
- Code style follows the repo: two-space indent, double quotes, semicolons, compact one-line style, `.mjs` for Node scripts, and `.js` ESM under `world/` and at the root for browser modules.
- Every commit message ends with the line `🤖 Built with SMT <smt@agora.build>`. Do not add co-author trailers. Run `npm test` before each commit; it must pass completely.

## File Structure

| File | Responsibility |
| --- | --- |
| `world/kinds.js` (create) | `DECOR_KINDS`, `BLOCKING_DECOR`, `THEMED_KINDS`, shared by server and browser |
| `world/map.js` (modify) | Adds the `ground` role array |
| `world/themes.js` (create) | Theme contract, catalogs, `validateTheme()` |
| `themes/agora/theme.json`, `themes/minimal/theme.json`, `themes/cyberpunk/theme.json` (create) | Built-in themes |
| `scripts/spaces/themes.mjs` (create) | `loadThemes()` validates the built-ins at startup |
| `world/camera.js`, `world/motion.js` (create) | Camera math and walking interpolation |
| `world/renderer-canvas.js` (create) | Canvas 2D renderer: patterns, decor shapes, avatars, labels, lighting, effects |
| `world/engine.js` (create) | Movement, input, camera follow, and the draw loop |
| `stoa.html`, `stoa.js`, `styles.css` (modify or create) | The plaza page and its panel |
| `scripts/spaces/model.mjs`, `scripts/spaces/decor.mjs`, `scripts/spaces/routes.mjs`, `scripts/serve.mjs`, `scripts/build.mjs` (modify) | Wiring |
| `tests/map.test.mjs`, `tests/themes.test.mjs`, `tests/world-client.test.mjs`, `tests/world-renderer.test.mjs`, `tests/world-engine.test.mjs`, `tests/spaces-api.test.mjs`, `tests/server.test.mjs` | Tests |

---

### Task 1: Shared kinds and the ground layer

**Files:**
- Create: `world/kinds.js`
- Modify: `scripts/spaces/model.mjs:4`, `scripts/spaces/decor.mjs:3,6`, `world/map.js` (the tile-layer loop and the returned object), `scripts/maps/build-maps.mjs` (`tiled()` and `plaza()`)
- Regenerate: `worlds/plaza/map.json` (`npm run maps`)
- Test: `tests/map.test.mjs` (append)

**Interfaces:**
- Produces from `world/kinds.js`:
  - `DECOR_KINDS` (the same 13 kinds, in the same order)
  - `BLOCKING_DECOR` (a Set of `sofa, table, whiteboard, bookshelf, statue, fountain`)
  - `THEMED_KINDS` (`[...DECOR_KINDS, "noticeboard"]`)
- `model.mjs` and `decor.mjs` keep exporting `DECOR_KINDS` and `BLOCKING_DECOR`, so existing imports keep working.
- `parseMap(source).ground: (string|null)[]` holds the ground-layer role of each tile. `roles` still holds the topmost role.
- `tiled(id, grid, objects, under)` takes an optional 2D grid of ground roles. When it is given, structure tiles keep that ground instead of `floor`. The plaza passes one, so seats sit on the path and plants on grass.

- [ ] **Step 1: Write the failing test**

Append to `tests/map.test.mjs`:

```js
import { BLOCKING_DECOR, DECOR_KINDS, THEMED_KINDS } from "../world/kinds.js";
import { DECOR_KINDS as SERVER_KINDS } from "../scripts/spaces/model.mjs";
import { BLOCKING_DECOR as SERVER_BLOCKING } from "../scripts/spaces/decor.mjs";

test("decoration kinds are shared by the browser and the server", () => {
  assert.deepEqual(DECOR_KINDS, ["plant", "lamp", "rug", "sofa", "chair", "table", "whiteboard", "bookshelf", "screen", "banner", "poster", "statue", "fountain"]);
  assert.deepEqual(THEMED_KINDS, [...DECOR_KINDS, "noticeboard"]);
  assert.deepEqual([...BLOCKING_DECOR], ["sofa", "table", "whiteboard", "bookshelf", "statue", "fountain"]);
  assert.equal(SERVER_KINDS, DECOR_KINDS);
  assert.equal(SERVER_BLOCKING, BLOCKING_DECOR);
});
test("maps keep the ground role beneath structures", async () => {
  const plaza = await world("plaza");
  const at = (x, y) => [plaza.ground[y * plaza.width + x], plaza.roles[y * plaza.width + x]];
  assert.deepEqual(at(20, 7), ["path", "seat"]);
  assert.deepEqual(at(5, 8), ["grass", "plant"]);
  assert.deepEqual(at(0, 0), ["floor", "wall"]);
  assert.deepEqual(at(21, 17), ["path", "path"]);
  assert.equal(plaza.ground.length, plaza.width * plaza.height);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/map.test.mjs`
Expected: FAIL with `Cannot find module` for `world/kinds.js`.

- [ ] **Step 3: Implement**

Create `world/kinds.js`:

```js
// Semantic kinds shared by maps, themes, the engine, and the server. Themes draw them; they never carry behavior.
export const DECOR_KINDS = ["plant", "lamp", "rug", "sofa", "chair", "table", "whiteboard", "bookshelf", "screen", "banner", "poster", "statue", "fountain"];
export const BLOCKING_DECOR = new Set(["sofa", "table", "whiteboard", "bookshelf", "statue", "fountain"]);
export const THEMED_KINDS = [...DECOR_KINDS, "noticeboard"];
```

In `scripts/spaces/model.mjs`, replace line 4 (`export const DECOR_KINDS = [...]`) with:

```js
export { DECOR_KINDS } from "../../world/kinds.js";
```

In `scripts/spaces/decor.mjs`, replace `import { DECOR_KINDS } from "./model.mjs";` with:

```js
import { BLOCKING_DECOR, DECOR_KINDS } from "../../world/kinds.js";
```

and replace the line `export const BLOCKING_DECOR = new Set([...]);` with:

```js
export { BLOCKING_DECOR };
```

In `scripts/maps/build-maps.mjs`:
1. Change the signature to `export function tiled(id, grid, objects, under = null) {`.
2. Change the ground loop to walk coordinates so it can read `under`:

```js
  grid.forEach((row, y) => row.forEach((role, x) => {
    const base = ["water", "grass", "path"].includes(role) ? role : under ? under[y][x] : "floor";
    ground.push(gid(base)); structure.push(role === base ? 0 : gid(role));
  }));
```

   This replaces the existing `for (const row of grid) for (const role of row) { ... }` loop.
3. In `plaza()`, directly after `const grid = blank(44, 34, "wall");`, build the ground grid with the same ground fills:

```js
  const under = blank(44, 34, "floor");
  fill(under, 1, 1, 42, 18, "grass");
  fill(under, 1, 9, 42, 2, "path"); fill(under, 21, 1, 2, 18, "path");
  fill(under, 17, 6, 10, 8, "path"); fill(under, 19, 8, 6, 4, "water");
```

4. Change the plaza's `return tiled("plaza", grid, {` to pass `under` as the fourth argument: `return tiled("plaza", grid, { ...objects... }, under);`. Keep the object literal unchanged and add `, under` after its closing brace.
5. Run `npm run maps` to regenerate `worlds/plaza/map.json`. The room map does not change.

In `world/map.js` `parseMap`:
1. Next to `const roles = ...`, add `const ground = new Array(width * height).fill(null);`.
2. Directly after `roles[index] = tile.role;`, add `if (name === "ground") ground[index] = tile.role;`.
3. In the returned object, change `roles, blocked,` to `roles, ground, blocked,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all existing tests plus 2 new).

- [ ] **Step 5: Commit**

```bash
git add world/kinds.js world/map.js scripts/spaces/model.mjs scripts/spaces/decor.mjs scripts/maps/build-maps.mjs worlds/plaza/map.json tests/map.test.mjs
git commit -m "Share decoration kinds and keep the map's ground layer" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: The theme contract

**Files:**
- Create: `world/themes.js`
- Test: `tests/themes.test.mjs`

**Interfaces:**
- Consumes: `CORE_ROLES` (`world/map.js`), `THEMED_KINDS` (Task 1).
- Produces:
  - Constants: `PATTERNS`, `EFFECTS`, `UI_TOKENS`, `FONTS`, `AVATAR_STYLES`, `VIDEO_LAYOUTS`, `MANIFEST_LIMIT = 65536`
  - `validateTheme(theme) -> string[]` (an empty array means valid)
- Theme manifest shape:
  ```
  { id, name, version: 1,
    roles: { <every core role>: { pattern: <PATTERNS>, colors: [1..4 hex] } },
    decor: { <every themed kind>: { colors: [1..4 hex], variants?: [[1..4 hex]] (at most 8) } },
    avatar: { style: "token"|"pawn", palette: [4..12 hex], outline: hex },
    ui: { <UI_TOKENS>: hex, font?: <FONTS> },
    lighting: { ambient: 0..1, tint: hex },
    effects: [<EFFECTS>],
    video: "over-avatar"|"strip"|"grid" }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/themes.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_ROLES } from "../world/map.js";
import { THEMED_KINDS } from "../world/kinds.js";
import { AVATAR_STYLES, EFFECTS, FONTS, MANIFEST_LIMIT, PATTERNS, UI_TOKENS, VIDEO_LAYOUTS, validateTheme } from "../world/themes.js";

export function sampleTheme() {
  return {
    id: "sample", name: "Sample", version: 1,
    roles: Object.fromEntries(CORE_ROLES.map((role) => [role, { pattern: "flat", colors: ["#112233"] }])),
    decor: Object.fromEntries(THEMED_KINDS.map((kind) => [kind, { colors: ["#445566", "#778899"] }])),
    avatar: { style: "token", palette: ["#111111", "#222222", "#333333", "#444444"], outline: "#000000" },
    ui: { "--paper": "#ffffff", "--ink": "#000000", font: "system-ui" },
    lighting: { ambient: 1, tint: "#ffffff" },
    effects: [],
    video: "grid"
  };
}
const broken = (change) => { const theme = sampleTheme(); change(theme); return validateTheme(theme); };

test("the theme catalogs are fixed", () => {
  assert.deepEqual(PATTERNS, ["flat", "tiles", "path", "grass", "water", "wall", "column", "door", "table", "seat", "plant", "decor", "neon"]);
  assert.deepEqual(EFFECTS, ["dust", "rain", "leaves", "neon-glow"]);
  assert.deepEqual(UI_TOKENS, ["--paper", "--surface", "--ink", "--muted", "--line", "--accent", "--accent-dark", "--green"]);
  assert.deepEqual(FONTS, ["IBM Plex Sans", "IBM Plex Mono", "Georgia", "system-ui"]);
  assert.deepEqual(AVATAR_STYLES, ["token", "pawn"]);
  assert.deepEqual(VIDEO_LAYOUTS, ["over-avatar", "strip", "grid"]);
  assert.equal(MANIFEST_LIMIT, 65536);
});
test("a complete data-only theme is valid", () => {
  assert.deepEqual(validateTheme(sampleTheme()), []);
  assert.deepEqual(broken((theme) => { theme.decor.rug.variants = [["#010101"], ["#020202", "#030303"]]; theme.effects = ["rain", "neon-glow"]; }), []);
});
test("every role and themed kind must be drawn", () => {
  assert.match(broken((theme) => { delete theme.roles.water; }).join(" "), /water role/);
  assert.match(broken((theme) => { delete theme.decor.noticeboard; }).join(" "), /noticeboard decoration/);
});
test("themes cannot carry code, files, or unknown styling", () => {
  assert.notDeepEqual(broken((theme) => { theme.roles.floor = { image: "floor.svg" }; }), []);
  assert.notDeepEqual(broken((theme) => { theme.roles.floor.pattern = "script"; }), []);
  assert.notDeepEqual(broken((theme) => { theme.roles.floor.colors = ["red"]; }), []);
  assert.notDeepEqual(broken((theme) => { theme.roles.floor.colors = ["#111111", "#222222", "#333333", "#444444", "#555555"]; }), []);
  assert.notDeepEqual(broken((theme) => { theme.ui["--paper"] = "url(https://evil.example)"; }), []);
  assert.notDeepEqual(broken((theme) => { theme.ui["--position"] = "#ffffff"; }), []);
  assert.notDeepEqual(broken((theme) => { theme.ui.font = "Comic Sans MS"; }), []);
  assert.notDeepEqual(broken((theme) => { theme.effects = ["fireworks"]; }), []);
  assert.notDeepEqual(broken((theme) => { theme.decor.rug.variants = new Array(9).fill(["#010101"]); }), []);
  assert.notDeepEqual(broken((theme) => { theme.avatar.style = "robot"; }), []);
  assert.notDeepEqual(broken((theme) => { theme.avatar.palette = ["#111111"]; }), []);
  assert.notDeepEqual(broken((theme) => { theme.lighting.ambient = 2; }), []);
  assert.notDeepEqual(broken((theme) => { theme.video = "theatre"; }), []);
  assert.notDeepEqual(broken((theme) => { theme.version = 2; }), []);
  assert.notDeepEqual(broken((theme) => { theme.id = "Bad Id"; }), []);
  assert.notDeepEqual(broken((theme) => { theme.name = "x".repeat(70000); }), []);
  assert.deepEqual(validateTheme(null), ["A theme must be an object."]);
  assert.deepEqual(validateTheme([]), ["A theme must be an object."]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/themes.test.mjs`
Expected: FAIL with `Cannot find module` for `world/themes.js`.

- [ ] **Step 3: Implement**

Create `world/themes.js`:

```js
import { CORE_ROLES } from "./map.js";
import { THEMED_KINDS } from "./kinds.js";

// Themes are data only: patterns, shapes, and effects come from fixed catalogs the renderer implements.
export const PATTERNS = ["flat", "tiles", "path", "grass", "water", "wall", "column", "door", "table", "seat", "plant", "decor", "neon"];
export const EFFECTS = ["dust", "rain", "leaves", "neon-glow"];
export const UI_TOKENS = ["--paper", "--surface", "--ink", "--muted", "--line", "--accent", "--accent-dark", "--green"];
export const FONTS = ["IBM Plex Sans", "IBM Plex Mono", "Georgia", "system-ui"];
export const AVATAR_STYLES = ["token", "pawn"];
export const VIDEO_LAYOUTS = ["over-avatar", "strip", "grid"];
export const MANIFEST_LIMIT = 65536;
const COLOR = /^#[0-9a-f]{6}$/i;

export function validateTheme(theme) {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) return ["A theme must be an object."];
  const errors = [];
  const colors = (value, where, min = 1, max = 4) => { if (!Array.isArray(value) || value.length < min || value.length > max || !value.every((color) => typeof color === "string" && COLOR.test(color))) errors.push(where + " needs " + min + " to " + max + " colors like #a1b2c3."); };
  if (JSON.stringify(theme).length > MANIFEST_LIMIT) errors.push("The theme is larger than 64 KB.");
  if (typeof theme.id !== "string" || !/^[a-z0-9-]{2,40}$/.test(theme.id)) errors.push("The theme needs an id of 2 to 40 lowercase letters, digits, or dashes.");
  if (typeof theme.name !== "string" || theme.name.length < 2 || theme.name.length > 40) errors.push("The theme needs a name of 2 to 40 characters.");
  if (theme.version !== 1) errors.push("Only theme version 1 is supported.");
  for (const role of CORE_ROLES) {
    const entry = theme.roles?.[role];
    if (!entry) { errors.push("The theme does not draw the " + role + " role."); continue; }
    if (!PATTERNS.includes(entry.pattern)) errors.push("The " + role + " role uses an unknown pattern.");
    colors(entry.colors, "The " + role + " role");
  }
  for (const kind of THEMED_KINDS) {
    const entry = theme.decor?.[kind];
    if (!entry) { errors.push("The theme does not draw the " + kind + " decoration."); continue; }
    colors(entry.colors, "The " + kind + " decoration");
    if (entry.variants === undefined) continue;
    if (!Array.isArray(entry.variants) || entry.variants.length > 8) errors.push("The " + kind + " decoration may have up to 8 variants.");
    else entry.variants.forEach((variant, index) => colors(variant, "Variant " + index + " of " + kind));
  }
  if (!AVATAR_STYLES.includes(theme.avatar?.style)) errors.push("Choose an avatar style: token or pawn.");
  colors(theme.avatar?.palette, "The avatar palette", 4, 12);
  colors([theme.avatar?.outline], "The avatar outline");
  for (const [token, value] of Object.entries(theme.ui || {})) {
    if (token === "font") { if (!FONTS.includes(value)) errors.push("Choose an available font."); }
    else if (!UI_TOKENS.includes(token)) errors.push("The ui token " + token + " is not allowed.");
    else if (typeof value !== "string" || !COLOR.test(value)) errors.push("The ui token " + token + " must be a color like #a1b2c3.");
  }
  const ambient = theme.lighting?.ambient;
  if (typeof ambient !== "number" || ambient < 0 || ambient > 1) errors.push("Lighting ambient must be between 0 and 1.");
  colors([theme.lighting?.tint], "The lighting tint");
  if (!Array.isArray(theme.effects) || theme.effects.some((effect) => !EFFECTS.includes(effect))) errors.push("Effects must come from the built-in list.");
  if (!VIDEO_LAYOUTS.includes(theme.video)) errors.push("Choose a video layout: over-avatar, strip, or grid.");
  return errors;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/themes.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add world/themes.js tests/themes.test.mjs
git commit -m "Add the data-only theme contract" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 3: Built-in themes and the themes API

**Files:**
- Create: `themes/agora/theme.json`, `themes/minimal/theme.json`, `themes/cyberpunk/theme.json`, `scripts/spaces/themes.mjs`
- Modify: `scripts/spaces/routes.mjs` (the `handleSpaces` parameters and one new route), `scripts/serve.mjs` (import, wiring, the `handleSpaces` call), `scripts/build.mjs` (copy `themes/`), `tests/server.test.mjs` (production files)
- Test: `tests/themes.test.mjs` (append), `tests/spaces-api.test.mjs` (append)

**Interfaces:**
- Consumes: `THEMES = ["agora","minimal","cyberpunk"]` (`model.mjs`), `validateTheme` (Task 2).
- Produces:
  - `loadThemes(directory) -> Theme[]`, in `THEMES` order. Throws an `Error` naming the theme if any built-in is invalid or its id does not match its folder.
  - `GET /api/themes -> { themes: Theme[] }`
  - `createAppServer` accepts an optional `options.themes`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/themes.test.mjs`:

```js
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadThemes } from "../scripts/spaces/themes.mjs";
import { THEMES } from "../scripts/spaces/model.mjs";

const root = new URL("../", import.meta.url).pathname;

test("the three built-in themes are valid and look different", () => {
  const themes = loadThemes(root);
  assert.deepEqual(themes.map((theme) => theme.id), THEMES);
  for (const theme of themes) assert.deepEqual(validateTheme(theme), [], theme.id);
  const [agora, minimal, cyberpunk] = themes;
  assert.notEqual(agora.roles.floor.colors[0], cyberpunk.roles.floor.colors[0]);
  assert.deepEqual(minimal.effects, [], "Minimal has no effects");
  assert.ok(cyberpunk.effects.includes("rain") && cyberpunk.effects.includes("neon-glow"));
  assert.equal(agora.ui["--accent"], "#ce4b24", "Agora keeps the portal's terracotta");
});
test("an invalid built-in theme stops the server from starting", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "themes-"));
  try {
    for (const id of THEMES) {
      await mkdir(resolve(directory, "themes", id), { recursive: true });
      await writeFile(resolve(directory, "themes", id, "theme.json"), JSON.stringify({ ...sampleTheme(), id }));
    }
    assert.equal(loadThemes(directory).length, 3);
    await writeFile(resolve(directory, "themes", "minimal", "theme.json"), JSON.stringify({ ...sampleTheme(), id: "minimal", effects: ["fireworks"] }));
    assert.throws(() => loadThemes(directory), /Theme minimal is invalid/);
    await writeFile(resolve(directory, "themes", "minimal", "theme.json"), JSON.stringify({ ...sampleTheme(), id: "other" }));
    assert.throws(() => loadThemes(directory), /Theme minimal is invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
```

Append to `tests/spaces-api.test.mjs`:

```js
test("the themes API returns the three built-in themes", async () => {
  const { instance, url } = await start();
  try {
    const response = await request(url, "/api/themes");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).themes.map((theme) => theme.id), ["agora", "minimal", "cyberpunk"]);
  } finally { await close(instance); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/themes.test.mjs tests/spaces-api.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/spaces/themes.mjs`. The API test fails with 404.

- [ ] **Step 3: Implement**

Create `scripts/spaces/themes.mjs`:

```js
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateTheme } from "../../world/themes.js";
import { THEMES } from "./model.mjs";

// Built-in themes are validated at startup so a broken theme can never reach a browser.
export function loadThemes(directory) {
  return THEMES.map((id) => {
    const theme = JSON.parse(readFileSync(resolve(directory, "themes", id, "theme.json"), "utf8"));
    const errors = validateTheme(theme);
    if (theme.id !== id) errors.push("Its id does not match its folder.");
    if (errors.length) throw new Error("Theme " + id + " is invalid: " + errors.join(" "));
    return theme;
  });
}
```

Create `themes/agora/theme.json`:

```json
{
  "id": "agora",
  "name": "Agora",
  "version": 1,
  "roles": {
    "floor": { "pattern": "tiles", "colors": ["#ebe5d5", "#dcd3bd"] },
    "path": { "pattern": "path", "colors": ["#ddd2b8", "#c9bc9c"] },
    "grass": { "pattern": "grass", "colors": ["#b9c29b", "#97a37a"] },
    "water": { "pattern": "water", "colors": ["#7ea6aa", "#a9c9cb"] },
    "wall": { "pattern": "wall", "colors": ["#d7cdb5", "#b9ad92", "#e8e0cc"] },
    "column": { "pattern": "column", "colors": ["#f4f1e8", "#cfc6b0"] },
    "door": { "pattern": "door", "colors": ["#ce4b24", "#7a2c14"] },
    "table": { "pattern": "table", "colors": ["#8a6a4f", "#6b503b"] },
    "seat": { "pattern": "seat", "colors": ["#b5552f", "#8a3f22"] },
    "plant": { "pattern": "plant", "colors": ["#526951", "#a0522d"] },
    "decor": { "pattern": "decor", "colors": ["#ce4b24"] }
  },
  "decor": {
    "plant": { "colors": ["#526951", "#a0522d"], "variants": [["#526951", "#a0522d"], ["#6f8a5a", "#8a5a3c"]] },
    "lamp": { "colors": ["#f2c46d", "#3b3a33"] },
    "rug": { "colors": ["#ce4b24", "#8f3a1d"], "variants": [["#ce4b24", "#8f3a1d"], ["#526951", "#384a37"]] },
    "sofa": { "colors": ["#b5552f", "#7f3a20"] },
    "chair": { "colors": ["#8a6a4f", "#5e4734"] },
    "table": { "colors": ["#8a6a4f", "#6b503b"] },
    "whiteboard": { "colors": ["#fffef9", "#6c746b"] },
    "bookshelf": { "colors": ["#ce4b24", "#5e4734", "#526951"] },
    "screen": { "colors": ["#7ea6aa", "#272d28"] },
    "banner": { "colors": ["#ce4b24", "#272d28"] },
    "poster": { "colors": ["#f5f4ee", "#272d28"] },
    "statue": { "colors": ["#f4f1e8", "#cfc6b0"] },
    "fountain": { "colors": ["#e8e0cc", "#7ea6aa"] },
    "noticeboard": { "colors": ["#c9a97a", "#5e4734", "#fffef9"] }
  },
  "avatar": { "style": "token", "palette": ["#ce4b24", "#526951", "#3c5a78", "#8a6a4f", "#7a4f8a", "#c08a1f"], "outline": "#272d28" },
  "ui": { "--paper": "#f5f4ee", "--surface": "#fffef9", "--ink": "#272d28", "--muted": "#6c746b", "--line": "#dedfd3", "--accent": "#ce4b24", "--accent-dark": "#a93a1a", "--green": "#526951", "font": "IBM Plex Sans" },
  "lighting": { "ambient": 1, "tint": "#fff4dc" },
  "effects": ["dust"],
  "video": "over-avatar"
}
```

Create `themes/minimal/theme.json`:

```json
{
  "id": "minimal",
  "name": "Minimal",
  "version": 1,
  "roles": {
    "floor": { "pattern": "flat", "colors": ["#ffffff"] },
    "path": { "pattern": "flat", "colors": ["#eeeeee"] },
    "grass": { "pattern": "flat", "colors": ["#e3eee0"] },
    "water": { "pattern": "flat", "colors": ["#cfe3f5"] },
    "wall": { "pattern": "flat", "colors": ["#1a1a1a"] },
    "column": { "pattern": "flat", "colors": ["#555555"] },
    "door": { "pattern": "flat", "colors": ["#0057d9"] },
    "table": { "pattern": "flat", "colors": ["#8c8c8c"] },
    "seat": { "pattern": "seat", "colors": ["#4a4a4a", "#222222"] },
    "plant": { "pattern": "flat", "colors": ["#2e7d32"] },
    "decor": { "pattern": "flat", "colors": ["#0057d9"] }
  },
  "decor": {
    "plant": { "colors": ["#2e7d32", "#4a4a4a"] },
    "lamp": { "colors": ["#f9a825", "#222222"] },
    "rug": { "colors": ["#cccccc", "#999999"] },
    "sofa": { "colors": ["#4a4a4a", "#222222"] },
    "chair": { "colors": ["#4a4a4a", "#222222"] },
    "table": { "colors": ["#8c8c8c", "#5c5c5c"] },
    "whiteboard": { "colors": ["#ffffff", "#222222"] },
    "bookshelf": { "colors": ["#0057d9", "#222222", "#b3261e"] },
    "screen": { "colors": ["#cfe3f5", "#111111"] },
    "banner": { "colors": ["#0057d9", "#222222"] },
    "poster": { "colors": ["#ffffff", "#222222"] },
    "statue": { "colors": ["#bbbbbb", "#777777"] },
    "fountain": { "colors": ["#bbbbbb", "#cfe3f5"] },
    "noticeboard": { "colors": ["#ffffff", "#222222", "#0057d9"] }
  },
  "avatar": { "style": "token", "palette": ["#0057d9", "#b3261e", "#1e7d32", "#6a1b9a", "#e65100", "#00695c"], "outline": "#000000" },
  "ui": { "--paper": "#ffffff", "--surface": "#ffffff", "--ink": "#111111", "--muted": "#4a4a4a", "--line": "#c8c8c8", "--accent": "#0057d9", "--accent-dark": "#003c99", "--green": "#1e7d32", "font": "system-ui" },
  "lighting": { "ambient": 1, "tint": "#ffffff" },
  "effects": [],
  "video": "grid"
}
```

Create `themes/cyberpunk/theme.json`:

```json
{
  "id": "cyberpunk",
  "name": "Cyberpunk",
  "version": 1,
  "roles": {
    "floor": { "pattern": "neon", "colors": ["#14151f", "#ff2bd6"] },
    "path": { "pattern": "neon", "colors": ["#1b1d2b", "#00e5ff"] },
    "grass": { "pattern": "tiles", "colors": ["#16202a", "#1f2e3a"] },
    "water": { "pattern": "water", "colors": ["#0b2a3a", "#00e5ff"] },
    "wall": { "pattern": "wall", "colors": ["#252838", "#11121a", "#3a3e57"] },
    "column": { "pattern": "column", "colors": ["#2e3250", "#00e5ff"] },
    "door": { "pattern": "door", "colors": ["#ff2bd6", "#5c0f4f"] },
    "table": { "pattern": "table", "colors": ["#2b2f45", "#1a1c2b"] },
    "seat": { "pattern": "seat", "colors": ["#00e5ff", "#007d8c"] },
    "plant": { "pattern": "plant", "colors": ["#39ff88", "#2b2f45"] },
    "decor": { "pattern": "decor", "colors": ["#ffd400"] }
  },
  "decor": {
    "plant": { "colors": ["#39ff88", "#2b2f45"] },
    "lamp": { "colors": ["#ff2bd6", "#2b2f45"] },
    "rug": { "colors": ["#3a1d5c", "#ff2bd6"] },
    "sofa": { "colors": ["#00e5ff", "#005c66"] },
    "chair": { "colors": ["#ff2bd6", "#5c0f4f"] },
    "table": { "colors": ["#2b2f45", "#1a1c2b"] },
    "whiteboard": { "colors": ["#0b2a3a", "#00e5ff"] },
    "bookshelf": { "colors": ["#ff2bd6", "#11121a", "#00e5ff"] },
    "screen": { "colors": ["#00e5ff", "#05060a"] },
    "banner": { "colors": ["#ffd400", "#11121a"] },
    "poster": { "colors": ["#ff2bd6", "#11121a"] },
    "statue": { "colors": ["#9d7bff", "#2e3250"] },
    "fountain": { "colors": ["#2e3250", "#00e5ff"] },
    "noticeboard": { "colors": ["#151724", "#00e5ff", "#ff2bd6"] }
  },
  "avatar": { "style": "pawn", "palette": ["#ff2bd6", "#00e5ff", "#39ff88", "#ffd400", "#ff6b2b", "#9d7bff"], "outline": "#0b0c12" },
  "ui": { "--paper": "#0b0c12", "--surface": "#151724", "--ink": "#e8eaff", "--muted": "#9aa0c3", "--line": "#2a2d44", "--accent": "#ff2bd6", "--accent-dark": "#c21fa3", "--green": "#39ff88", "font": "IBM Plex Mono" },
  "lighting": { "ambient": 0.7, "tint": "#1a0b3d" },
  "effects": ["rain", "neon-glow"],
  "video": "strip"
}
```

In `scripts/spaces/routes.mjs`:
1. Add `themes` to the destructured parameters: `({ path, method, url, token, read: readBody, spaces, worlds, themes, limit, ip })`.
2. Directly after the `/api/signaling/token` line, add:

```js
  if (path === "/api/themes" && method === "GET") return { status: 200, body: { themes } };
```

In `scripts/serve.mjs`:
1. After the `handleSpaces` import, add `import { loadThemes } from "./spaces/themes.mjs";`.
2. After `const worlds = options.worlds || loadWorlds(directory);`, add `const themes = options.themes || loadThemes(directory);`.
3. In the `handleSpaces({ ... })` call, add `themes,` after `worlds,`.

In `scripts/build.mjs`, after the line that copies `worlds/`, add:

```js
await cp(new URL("themes/", root), new URL("themes/", output), { recursive: true });
```

In `tests/server.test.mjs`, add `"themes/agora/theme.json"`, `"themes/minimal/theme.json"`, `"themes/cyberpunk/theme.json"`, and `"world/kinds.js"` to the production test's `files` array.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/themes.test.mjs tests/spaces-api.test.mjs`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add themes/ scripts/spaces/themes.mjs scripts/spaces/routes.mjs scripts/serve.mjs scripts/build.mjs tests/themes.test.mjs tests/spaces-api.test.mjs tests/server.test.mjs
git commit -m "Add the Agora, Minimal, and Cyberpunk themes" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 4: Camera and motion

**Files:**
- Create: `world/camera.js`, `world/motion.js`
- Test: `tests/world-client.test.mjs`

**Interfaces:**
- Produces from `world/camera.js`. A camera is `{ x, y, zoom }`, where `x` and `y` are the world-pixel point at the viewport's top-left.
  - `zoomFor(viewport, tileSize) -> number`: shows about 12 tiles across the viewport's shorter side, clamped to 0.6..2.
  - `follow(target, viewport, world, zoom) -> camera`: centers the target, clamps to the world's edges, and centers a world smaller than the viewport.
  - `screenToTile(camera, px, py, tileSize) -> { x, y }`
  - `tileCenter(tile, tileSize) -> { x, y }` (world pixels)
- Produces from `world/motion.js`:
  - `WALK_SPEED = 5` (tiles per second)
  - `STEP` (direction to `[dx, dy]`)
  - `KEYS` (key to direction, for the arrows and WASD in both cases)
  - `direction(from, to)`
  - `positionAt(walk, now, speed = WALK_SPEED) -> { x, y, dir, done }` (fractional tiles while walking; `walk = { path, startedAt, dir? }`)

- [ ] **Step 1: Write the failing test**

Create `tests/world-client.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { follow, screenToTile, tileCenter, zoomFor } from "../world/camera.js";
import { KEYS, STEP, WALK_SPEED, direction, positionAt } from "../world/motion.js";

test("zoom shows about twelve tiles across the shorter side, within limits", () => {
  assert.equal(zoomFor({ width: 768, height: 384 }, 32), 1);
  assert.equal(zoomFor({ width: 100, height: 100 }, 32), 0.6);
  assert.equal(zoomFor({ width: 4000, height: 4000 }, 32), 2);
});
test("the camera follows the target, stops at the world's edges, and centers small worlds", () => {
  const world = { width: 1408, height: 1088 }, viewport = { width: 640, height: 480 };
  assert.deepEqual(follow({ x: 700, y: 500 }, viewport, world, 1), { x: 380, y: 260, zoom: 1 });
  assert.deepEqual(follow({ x: 10, y: 10 }, viewport, world, 1), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(follow({ x: 1400, y: 1080 }, viewport, world, 1), { x: 768, y: 608, zoom: 1 });
  assert.deepEqual(follow({ x: 50, y: 50 }, viewport, { width: 320, height: 240 }, 1), { x: -160, y: -120, zoom: 1 });
  assert.deepEqual(follow({ x: 700, y: 500 }, viewport, world, 2), { x: 540, y: 380, zoom: 2 });
});
test("screen points map to tiles through the camera", () => {
  const camera = { x: 380, y: 260, zoom: 2 };
  assert.deepEqual(screenToTile(camera, 0, 0, 32), { x: 11, y: 8 });
  assert.deepEqual(screenToTile(camera, 64, 32, 32), { x: 12, y: 8 });
  const center = tileCenter({ x: 12, y: 9 }, 32);
  assert.deepEqual(center, { x: 400, y: 304 });
  assert.deepEqual(screenToTile({ x: 0, y: 0, zoom: 1 }, center.x, center.y, 32), { x: 12, y: 9 });
});
test("walks move at a fixed speed along the path and face the way they go", () => {
  assert.equal(WALK_SPEED, 5);
  const walk = { path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], startedAt: 1000 };
  assert.deepEqual(positionAt(walk, 1000), { x: 0, y: 0, dir: "right", done: false });
  assert.deepEqual(positionAt(walk, 1100), { x: 0.5, y: 0, dir: "right", done: false });
  assert.deepEqual(positionAt(walk, 1300), { x: 1, y: 0.5, dir: "down", done: false });
  assert.deepEqual(positionAt(walk, 1400), { x: 1, y: 1, dir: "down", done: true });
  assert.deepEqual(positionAt(walk, 500), { x: 0, y: 0, dir: "right", done: false });
  assert.deepEqual(positionAt({ path: [{ x: 3, y: 4 }], startedAt: 0 }, 99), { x: 3, y: 4, dir: "down", done: true });
  assert.deepEqual(positionAt({ path: [{ x: 3, y: 4 }], startedAt: 0, dir: "left" }, 99), { x: 3, y: 4, dir: "left", done: true });
});
test("arrows and WASD map to the four directions", () => {
  assert.deepEqual(STEP, { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] });
  for (const [key, dir] of [["ArrowUp", "up"], ["w", "up"], ["W", "up"], ["ArrowDown", "down"], ["s", "down"], ["ArrowLeft", "left"], ["a", "left"], ["ArrowRight", "right"], ["D", "right"]]) assert.equal(KEYS[key], dir, key);
  assert.equal(KEYS.Enter, undefined);
  assert.equal(direction({ x: 1, y: 1 }, { x: 1, y: 0 }), "up");
  assert.equal(direction({ x: 1, y: 1 }, { x: 0, y: 1 }), "left");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/world-client.test.mjs`
Expected: FAIL with `Cannot find module` for `world/camera.js`.

- [ ] **Step 3: Implement**

Create `world/camera.js`:

```js
// Camera math in world pixels. A camera's x/y is the world point drawn at the viewport's top-left corner.
export const zoomFor = (viewport, tileSize) => Math.max(0.6, Math.min(2, Math.min(viewport.width, viewport.height) / (12 * tileSize)));

export function follow(target, viewport, world, zoom) {
  const width = viewport.width / zoom, height = viewport.height / zoom;
  const axis = (point, size, length) => length <= size ? -(size - length) / 2 : Math.max(0, Math.min(point - size / 2, length - size));
  return { x: axis(target.x, width, world.width), y: axis(target.y, height, world.height), zoom };
}

export const screenToTile = (camera, px, py, tileSize) => ({ x: Math.floor((camera.x + px / camera.zoom) / tileSize), y: Math.floor((camera.y + py / camera.zoom) / tileSize) });
export const tileCenter = (tile, tileSize) => ({ x: (tile.x + 0.5) * tileSize, y: (tile.y + 0.5) * tileSize });
```

Create `world/motion.js`:

```js
// Walks are a path plus a start time; every client works out the same position, so nothing streams continuously.
export const WALK_SPEED = 5;
export const STEP = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export const KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right" };
export const direction = (from, to) => to.x > from.x ? "right" : to.x < from.x ? "left" : to.y < from.y ? "up" : "down";

export function positionAt(walk, now, speed = WALK_SPEED) {
  const steps = walk.path.length - 1;
  const travelled = Math.max(0, ((now - walk.startedAt) / 1000) * speed);
  if (steps <= 0 || travelled >= steps) {
    const last = walk.path[steps < 0 ? 0 : steps];
    return { x: last.x, y: last.y, dir: steps > 0 ? direction(walk.path[steps - 1], last) : walk.dir || "down", done: true };
  }
  const index = Math.floor(travelled), part = travelled - index, from = walk.path[index], to = walk.path[index + 1];
  return { x: from.x + (to.x - from.x) * part, y: from.y + (to.y - from.y) * part, dir: direction(from, to), done: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/world-client.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add world/camera.js world/motion.js tests/world-client.test.mjs
git commit -m "Add camera and walking motion" -m "🤖 Built with SMT <smt@agora.build>"
```

---
### Task 5: Canvas renderer

**Files:**
- Create: `world/renderer-canvas.js`
- Test: `tests/world-renderer.test.mjs`

**Interfaces:**
- Consumes: `THEMED_KINDS` (Task 1), a parsed map with `roles`, `ground`, `interactables`, `tileSize`, `width`, `height`, and a validated theme (Task 3).
- Produces from `world/renderer-canvas.js`:
  - `PATTERN_DRAW`: one draw function per `PATTERNS` entry, in the same order. Signature `(ctx, x, y, size, colors, tile, time)`.
  - `DECOR_DRAW`: one draw function per `THEMED_KINDS` entry, in the same order. Signature `(ctx, x, y, size, colors)`.
  - `shade(hex, amount) -> hex`, `hashTile(x, y) -> uint32`, `hashText(text) -> uint32`
  - `createCanvasRenderer(canvas, { map, theme }) -> { resize(width, height, ratio), setTheme(theme), draw(frame) }`. This is the `Renderer` interface; a WebGL renderer would implement the same three methods.
  - `frame = { camera, time = 0, avatars = [{ id, name, x, y, dir, self? }], decor = [{ kind, x, y, rotation?, variant? }], labels = [{ x, y, text }], motion = true }`. With `motion: false`, water stays still and no effects are drawn.

- [ ] **Step 1: Write the failing test**

Create `tests/world-renderer.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseMap } from "../world/map.js";
import { THEMED_KINDS } from "../world/kinds.js";
import { PATTERNS } from "../world/themes.js";
import { DECOR_DRAW, PATTERN_DRAW, createCanvasRenderer, hashText, shade } from "../world/renderer-canvas.js";
import { loadThemes } from "../scripts/spaces/themes.mjs";

const root = new URL("../", import.meta.url).pathname;
const plaza = parseMap(JSON.parse(await readFile(new URL("../worlds/plaza/map.json", import.meta.url), "utf8")));
const [agora, minimal, cyberpunk] = loadThemes(root);
const whole = { x: 0, y: 0, zoom: 1 };

// A recording 2D context: every method call and property assignment is logged in order.
function fakeCanvas() {
  const calls = [], values = {};
  const ctx = new Proxy(values, {
    get: (target, name) => name in target ? target[name] : name === "measureText" ? () => ({ width: 20 }) : (...args) => { calls.push([name, ...args]); },
    set: (target, name, value) => { target[name] = value; calls.push(["set:" + String(name), value]); return true; }
  });
  return { canvas: { width: 0, height: 0, getContext: () => ctx }, calls };
}
const render = (theme, frame, size = [640, 480]) => {
  const { canvas, calls } = fakeCanvas();
  const renderer = createCanvasRenderer(canvas, { map: plaza, theme });
  renderer.resize(size[0], size[1], 1);
  renderer.draw({ camera: whole, ...frame });
  return { calls, canvas, renderer };
};

test("the renderer implements every pattern and every themed kind", () => {
  assert.deepEqual(Object.keys(PATTERN_DRAW), PATTERNS);
  assert.deepEqual(Object.keys(DECOR_DRAW), THEMED_KINDS);
});
test("colors shade within range and names hash deterministically", () => {
  assert.equal(shade("#808080", 0.1), "#9a9a9a");
  assert.equal(shade("#ffffff", 0.5), "#ffffff");
  assert.equal(shade("#000000", -0.5), "#000000");
  assert.equal(hashText("Ada"), hashText("Ada"));
  assert.notEqual(hashText("Ada"), hashText("Bo"));
});
test("every built-in theme draws the whole plaza with people, decorations, and labels", () => {
  for (const theme of [agora, minimal, cyberpunk]) {
    const { canvas, calls } = fakeCanvas();
    const renderer = createCanvasRenderer(canvas, { map: plaza, theme });
    renderer.resize(1408, 1088, 2);
    assert.deepEqual([canvas.width, canvas.height], [2816, 2176]);
    renderer.draw({ camera: whole, time: 1234, avatars: [{ id: "a", name: "Ada Lovelace", x: 21, y: 17, dir: "down", self: true }, { id: "b", name: "Bo", x: 22.5, y: 17, dir: "left" }], decor: THEMED_KINDS.map((kind, index) => ({ kind, x: 2 + index, y: 24, rotation: 90, variant: 1 })), labels: [{ x: 5, y: 4, text: "AI agents" }] });
    const texts = calls.filter(([name]) => name === "fillText").map(([, text]) => text);
    assert.ok(calls.filter(([name]) => name === "fillRect").length > plaza.width * plaza.height, theme.id);
    assert.ok(texts.includes("Ada Lovelace") && texts.includes("Bo") && texts.includes("AI agents"), theme.id);
    assert.equal(texts.includes("AL"), theme.avatar.style === "token", theme.id + " draws initials only on tokens");
  }
});
test("only the tiles in view are drawn", () => {
  const all = render(minimal, { motion: false }, [1408, 1088]).calls.filter(([name]) => name === "fillRect").length;
  const { canvas, calls } = fakeCanvas();
  const renderer = createCanvasRenderer(canvas, { map: plaza, theme: minimal });
  renderer.resize(128, 128, 1);
  renderer.draw({ camera: { x: 640, y: 480, zoom: 2 }, motion: false });
  assert.ok(calls.filter(([name]) => name === "fillRect").length < all / 20);
});
test("without motion nothing depends on time and no effects are drawn", () => {
  const still = render(cyberpunk, { time: 5000, motion: false }).calls;
  assert.deepEqual(render(cyberpunk, { time: 9000, motion: false }).calls, still);
  const moving = render(cyberpunk, { time: 5000 }).calls;
  assert.notDeepEqual(render(cyberpunk, { time: 9000 }).calls, moving);
  assert.ok(moving.filter(([name]) => name === "stroke").length > still.filter(([name]) => name === "stroke").length);
});
test("dim themes are tinted by their lighting; bright themes are not", () => {
  const tinted = render(cyberpunk, { motion: false }).calls;
  const index = tinted.findIndex(([name, value]) => name === "set:globalAlpha" && Math.abs(value - 0.18) < 1e-9);
  assert.ok(index > 0);
  assert.deepEqual(tinted.slice(index).find(([name]) => name === "fillRect"), ["fillRect", 0, 0, 640, 480]);
  assert.equal(render(agora, { motion: false }).calls.some(([name, value]) => name === "set:globalAlpha" && Math.abs(value - 0.18) < 1e-9), false);
  const { canvas, calls } = fakeCanvas();
  const renderer = createCanvasRenderer(canvas, { map: plaza, theme: agora });
  renderer.resize(640, 480, 1);
  renderer.setTheme(cyberpunk);
  renderer.draw({ camera: whole, motion: false });
  assert.deepEqual(calls, tinted, "setTheme switches the look completely");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/world-renderer.test.mjs`
Expected: FAIL with `Cannot find module` for `world/renderer-canvas.js`.

- [ ] **Step 3: Implement**

Create `world/renderer-canvas.js`:

```js
// Canvas 2D renderer. It draws semantic roles and kinds from the theme's data and a fixed catalog of shapes,
// so a WebGL renderer can replace it later by implementing the same resize/setTheme/draw interface.
export const hashTile = (x, y) => (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0;
export const hashText = (text) => [...String(text)].reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) >>> 0, 7);
export function shade(hex, amount) {
  const value = parseInt(hex.slice(1), 16), channel = (shift) => Math.max(0, Math.min(255, Math.round(((value >> shift) & 255) + amount * 255)));
  return "#" + [16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("");
}
const box = (ctx, color, x, y, width, height) => { ctx.fillStyle = color; ctx.fillRect(x, y, width, height); };
const dot = (ctx, color, x, y, radius) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); };

export const PATTERN_DRAW = {
  flat(ctx, x, y, s, [a]) { box(ctx, a, x, y, s, s); },
  tiles(ctx, x, y, s, [a, b = shade(a, -0.08)]) { box(ctx, a, x, y, s, s); ctx.strokeStyle = b; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1); },
  path(ctx, x, y, s, [a, b = shade(a, -0.1)], tile) { box(ctx, a, x, y, s, s); const h = hashTile(tile.x, tile.y); for (let i = 0; i < 3; i += 1) box(ctx, b, x + 3 + ((h >>> (i * 5)) % (s - 8)), y + 3 + ((h >>> (i * 7 + 3)) % (s - 8)), 4, 2); },
  grass(ctx, x, y, s, [a, b = shade(a, -0.12)], tile) {
    box(ctx, a, x, y, s, s); ctx.strokeStyle = b; ctx.lineWidth = 1.2;
    const h = hashTile(tile.x, tile.y);
    for (let i = 0; i < 4; i += 1) { const px = x + 4 + ((h >>> (i * 4)) % (s - 8)), py = y + 6 + ((h >>> (i * 6 + 2)) % (s - 12)); ctx.beginPath(); ctx.moveTo(px, py + 5); ctx.lineTo(px + 1.5, py); ctx.stroke(); }
  },
  water(ctx, x, y, s, [a, b = shade(a, 0.15)], tile, time) {
    box(ctx, a, x, y, s, s); ctx.strokeStyle = b; ctx.lineWidth = 1.5;
    const phase = time / 450 + tile.x + tile.y;
    for (const row of [0.35, 0.72]) { ctx.beginPath(); for (let i = 0; i <= s; i += 4) ctx.lineTo(x + i, y + s * row + Math.sin(phase + i / 5) * 1.5); ctx.stroke(); }
  },
  wall(ctx, x, y, s, [a, b = shade(a, -0.15), c = shade(a, 0.1)]) { box(ctx, a, x, y, s, s); box(ctx, c, x, y, s, 4); box(ctx, b, x, y + s / 3, s, 1); box(ctx, b, x, y + (2 * s) / 3, s, 1); box(ctx, b, x + s / 2, y + 4, 1, s / 3 - 4); },
  column(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 5, y + s - 7, s - 10, 4); box(ctx, a, x + 9, y + 7, s - 18, s - 14); box(ctx, b, x + 6, y + 3, s - 12, 4); },
  door(ctx, x, y, s, [a, b = shade(a, -0.25)]) { box(ctx, b, x + 2, y, s - 4, s); box(ctx, a, x + 5, y + 3, s - 10, s - 3); },
  table(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 1, y + 4, s - 2, s - 4); box(ctx, a, x + 1, y + 1, s - 2, s - 6); },
  seat(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 8, y + 12, s - 16, s - 18); box(ctx, a, x + 8, y + 8, s - 16, s - 20); },
  plant(ctx, x, y, s, [a, b = "#8a5a3c"]) { box(ctx, b, x + 11, y + s - 11, s - 22, 9); dot(ctx, a, x + s / 2, y + s / 2 - 2, s / 4); dot(ctx, shade(a, 0.08), x + s / 2 - 5, y + s / 2 + 1, s / 6); dot(ctx, shade(a, -0.06), x + s / 2 + 5, y + s / 2, s / 6); },
  decor(ctx, x, y, s, [a]) { ctx.fillStyle = a; ctx.beginPath(); ctx.moveTo(x + s / 2, y + 6); ctx.lineTo(x + s - 6, y + s / 2); ctx.lineTo(x + s / 2, y + s - 6); ctx.lineTo(x + 6, y + s / 2); ctx.fill(); },
  neon(ctx, x, y, s, [a, b = "#00e5ff"]) { box(ctx, a, x, y, s, s); ctx.globalAlpha = 0.35; ctx.strokeStyle = b; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1); ctx.globalAlpha = 1; }
};

export const DECOR_DRAW = {
  plant: (ctx, x, y, s, colors) => PATTERN_DRAW.plant(ctx, x, y, s, colors),
  lamp(ctx, x, y, s, [a, b = shade(a, -0.3)]) { box(ctx, b, x + s / 2 - 1, y + 10, 2, s - 14); box(ctx, b, x + 10, y + s - 5, s - 20, 3); dot(ctx, a, x + s / 2, y + 9, 6); },
  rug(ctx, x, y, s, [a, b = shade(a, -0.15)]) { box(ctx, b, x + 2, y + 6, s - 4, s - 12); box(ctx, a, x + 5, y + 9, s - 10, s - 18); },
  sofa(ctx, x, y, s, [a, b = shade(a, -0.18)]) { box(ctx, b, x + 3, y + 8, s - 6, s - 14); box(ctx, a, x + 6, y + 13, s - 12, s - 22); },
  chair(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 9, y + 7, s - 18, 6); box(ctx, a, x + 9, y + 13, s - 18, s - 22); },
  table: (ctx, x, y, s, colors) => PATTERN_DRAW.table(ctx, x, y, s, colors),
  whiteboard(ctx, x, y, s, [a, b = shade(a, -0.4)]) { box(ctx, b, x + 3, y + 5, s - 6, s - 14); box(ctx, a, x + 5, y + 7, s - 10, s - 18); box(ctx, b, x + 8, y + s - 9, 2, 6); box(ctx, b, x + s - 10, y + s - 9, 2, 6); },
  bookshelf(ctx, x, y, s, [a, b = shade(a, -0.25), c = shade(a, 0.25)]) { box(ctx, b, x + 4, y + 3, s - 8, s - 6); for (let i = 0; i < 5; i += 1) { box(ctx, i % 2 ? a : c, x + 7 + i * 4, y + 6, 3, s / 2 - 6); box(ctx, i % 2 ? c : a, x + 7 + i * 4, y + s / 2 + 1, 3, s / 2 - 7); } },
  screen(ctx, x, y, s, [a, b = "#111318"]) { box(ctx, b, x + 3, y + 6, s - 6, s - 15); box(ctx, a, x + 5, y + 8, s - 10, s - 19); box(ctx, b, x + s / 2 - 2, y + s - 9, 4, 6); },
  banner(ctx, x, y, s, [a, b = shade(a, -0.3)]) { box(ctx, b, x + 9, y + 3, 2, s - 6); ctx.fillStyle = a; ctx.beginPath(); ctx.moveTo(x + 11, y + 4); ctx.lineTo(x + s - 7, y + 4); ctx.lineTo(x + s - 7, y + s / 2 + 4); ctx.lineTo(x + (s + 4) / 2, y + s / 2 - 1); ctx.lineTo(x + 11, y + s / 2 + 4); ctx.fill(); },
  poster(ctx, x, y, s, [a, b = shade(a, -0.35)]) { box(ctx, b, x + 7, y + 5, s - 14, s - 10); box(ctx, a, x + 9, y + 7, s - 18, s - 14); },
  statue(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 7, y + s - 10, s - 14, 7); box(ctx, a, x + 12, y + 11, s - 24, s - 21); dot(ctx, a, x + s / 2, y + 9, 5); },
  fountain(ctx, x, y, s, [a, b = "#7fa3a8"]) { dot(ctx, a, x + s / 2, y + s / 2, s / 2 - 2); dot(ctx, b, x + s / 2, y + s / 2, s / 2 - 6); dot(ctx, a, x + s / 2, y + s / 2, 3); },
  noticeboard(ctx, x, y, s, [a, b = shade(a, -0.3), c = "#fffef9"]) { box(ctx, b, x + 7, y + s - 10, 3, 9); box(ctx, b, x + s - 10, y + s - 10, 3, 9); box(ctx, b, x + 3, y + 4, s - 6, s - 13); box(ctx, a, x + 5, y + 6, s - 10, s - 17); box(ctx, c, x + 8, y + 9, 6, 5); box(ctx, c, x + 17, y + 11, 6, 4); }
};

const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase();

function label(ctx, text, cx, top, font, theme) {
  ctx.font = "500 10px " + font;
  const width = ctx.measureText(text).width + 8;
  ctx.globalAlpha = 0.85; box(ctx, theme.ui?.["--ink"] || "#272d28", cx - width / 2, top, width, 14); ctx.globalAlpha = 1;
  ctx.fillStyle = theme.ui?.["--surface"] || "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, cx, top + 7.5);
}

function drawAvatar(ctx, avatar, s, theme, font) {
  const color = theme.avatar.palette[hashText(avatar.id) % theme.avatar.palette.length];
  const cx = (avatar.x + 0.5) * s, cy = (avatar.y + 0.5) * s;
  ctx.lineWidth = 2; ctx.strokeStyle = theme.avatar.outline;
  if (theme.avatar.style === "pawn") {
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(cx, cy + 6, 9, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    dot(ctx, color, cx, cy - 6, 6); ctx.beginPath(); ctx.arc(cx, cy - 6, 6, 0, Math.PI * 2); ctx.stroke();
  } else {
    dot(ctx, color, cx, cy, s * 0.36); ctx.beginPath(); ctx.arc(cx, cy, s * 0.36, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#ffffff"; ctx.font = "600 10px " + font; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(initials(avatar.name), cx, cy + 0.5);
  }
  if (avatar.self) { ctx.strokeStyle = theme.ui?.["--accent"] || theme.avatar.outline; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2); ctx.stroke(); }
  label(ctx, avatar.name, cx, cy + s * 0.62, font, theme);
}

function drawEffects(ctx, theme, width, height, time) {
  for (const effect of theme.effects) {
    if (effect === "dust") {
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      for (let i = 0; i < 40; i += 1) { const h = hashTile(i, 7); ctx.fillRect(((h % 1000) / 1000) * width + Math.sin(time / 3000 + i) * 12, ((((h >>> 10) % 1000) / 1000) * height + (time / 80) * (((i % 3) + 1) * 0.2)) % height, 2, 2); }
    } else if (effect === "rain") {
      ctx.strokeStyle = "rgba(160, 220, 255, 0.35)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 0; i < 90; i += 1) { const h = hashTile(i, 3), x = ((((h % 1000) / 1000) * (width + 40) + time / 6) % (width + 40)) - 20, y = ((((h >>> 10) % 1000) / 1000) * height + time / 2.5) % height; ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 12); }
      ctx.stroke();
    } else if (effect === "leaves") {
      ctx.fillStyle = theme.decor.plant.colors[0];
      for (let i = 0; i < 18; i += 1) { const h = hashTile(i, 11); ctx.beginPath(); ctx.ellipse(((((h % 1000) / 1000) * width + Math.sin(time / 900 + i) * 20) + width) % width, ((((h >>> 10) % 1000) / 1000) * height + time / 40) % height, 4, 2, (time / 500 + i) % Math.PI, 0, Math.PI * 2); ctx.fill(); }
    }
  }
}

export function createCanvasRenderer(canvas, { map, theme }) {
  const ctx = canvas.getContext("2d"), s = map.tileSize;
  let current = theme, viewport = { width: 1, height: 1, ratio: 1 };
  function tile(role, x, y, time) {
    const entry = current.roles[role];
    const glow = current.effects.includes("neon-glow") && (role === "door" || entry.pattern === "neon");
    if (glow) { ctx.shadowColor = current.roles.door.colors[0]; ctx.shadowBlur = 10; }
    PATTERN_DRAW[entry.pattern](ctx, x * s, y * s, s, entry.colors, { x, y }, time);
    if (glow) ctx.shadowBlur = 0;
  }
  function decorItem(item) {
    const entry = current.decor[item.kind];
    if (!entry) return;
    ctx.save(); ctx.translate((item.x + 0.5) * s, (item.y + 0.5) * s); ctx.rotate(((item.rotation || 0) * Math.PI) / 180); ctx.translate(-s / 2, -s / 2);
    DECOR_DRAW[item.kind](ctx, 0, 0, s, entry.variants?.[item.variant || 0] || entry.colors);
    ctx.restore();
  }
  return {
    resize(width, height, ratio = 1) { viewport = { width, height, ratio }; canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); },
    setTheme(next) { current = next; },
    draw({ camera, time = 0, avatars = [], decor = [], labels = [], motion = true }) {
      const { width, height, ratio } = viewport, font = current.ui?.font || "IBM Plex Sans", t = motion ? time : 0;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      box(ctx, current.ui?.["--paper"] || "#111111", 0, 0, width, height);
      ctx.save(); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
      const x0 = Math.max(0, Math.floor(camera.x / s)), y0 = Math.max(0, Math.floor(camera.y / s));
      const x1 = Math.min(map.width - 1, Math.floor((camera.x + width / camera.zoom) / s)), y1 = Math.min(map.height - 1, Math.floor((camera.y + height / camera.zoom) / s));
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
        const index = y * map.width + x, role = map.roles[index], ground = map.ground[index];
        if (ground && ground !== role) tile(ground, x, y, t);
        if (role) tile(role, x, y, t);
      }
      for (const item of map.interactables) decorItem(item);
      for (const item of decor) decorItem(item);
      for (const entry of labels) label(ctx, entry.text, (entry.x + 0.5) * s, entry.y * s + 4, font, current);
      for (const avatar of [...avatars].sort((a, b) => a.y - b.y)) drawAvatar(ctx, avatar, s, current, font);
      ctx.restore();
      if (current.lighting.ambient < 1) { ctx.globalAlpha = (1 - current.lighting.ambient) * 0.6; box(ctx, current.lighting.tint, 0, 0, width, height); ctx.globalAlpha = 1; }
      if (motion) drawEffects(ctx, current, width, height, time);
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/world-renderer.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add world/renderer-canvas.js tests/world-renderer.test.mjs
git commit -m "Add the Canvas world renderer" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 6: The engine

**Files:**
- Create: `world/engine.js`
- Test: `tests/world-engine.test.mjs`

**Interfaces:**
- Consumes: `findPath`, `walkable` (map), `BLOCKING_DECOR` (kinds), `follow`, `screenToTile`, `zoomFor` (camera), `KEYS`, `STEP`, `positionAt` (motion), `createCanvasRenderer` (Task 5).
- Produces: `createEngine({ canvas, map, theme, start, reducedMotion = false, renderer?, now?, raf?, later?, cancel?, ratio? }) -> engine` with:
  - `walkTo(tile) -> boolean` (false when the tile can't be reached)
  - `position() -> { x, y }` (the current tile, rounded)
  - `on("move" | "arrive", listener)`. `move` receives `{ path, startedAt }`; Plan C publishes it over Signaling. `arrive` receives `{ x, y }`.
  - `setSelf({ name })`, `setTheme(theme)`, `setLabels(list)`, `setDecor(list)`
  - `setOthers([{ id, name, walk }])` for Plan C
  - `resize()`, `destroy()`
  - Input: `pointerup` walks to the tile under the pointer. With the canvas focused, `keydown`/`keyup` for the arrows and WASD step one tile at a time while held. Repeated keydown events for the held key are ignored. Blocked steps only turn the avatar to face that way.
  - Drawing: frames are requested only while someone is moving. When idle, a single 66 ms timer keeps ambient animation (effects or water) going unless `reducedMotion` is set.
  - `now`, `raf`, `later`, `cancel` and `ratio` are injectable for tests and default to `performance.now`, `requestAnimationFrame`, `setTimeout`, `clearTimeout` and `devicePixelRatio`.

- [ ] **Step 1: Write the failing test**

Create `tests/world-engine.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseMap } from "../world/map.js";
import { createEngine } from "../world/engine.js";
import { loadThemes } from "../scripts/spaces/themes.mjs";

const root = new URL("../", import.meta.url).pathname;
const plaza = parseMap(JSON.parse(await readFile(new URL("../worlds/plaza/map.json", import.meta.url), "utf8")));
const [agora, minimal] = loadThemes(root);
const key = (name) => ({ key: name, preventDefault() {} });

function setup({ reducedMotion = false } = {}) {
  let time = 1000;
  const frames = [], timers = [], drawn = [], themes = [], handlers = {}, events = { move: [], arrive: [] };
  const canvas = { clientWidth: 640, clientHeight: 480, addEventListener: (type, listener) => { handlers[type] = listener; }, removeEventListener: (type) => { delete handlers[type]; }, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const renderer = { resize() {}, setTheme: (theme) => themes.push(theme), draw: (frame) => drawn.push(frame) };
  const engine = createEngine({ canvas, map: plaza, theme: agora, start: plaza.spawns[0], reducedMotion, renderer, now: () => time, raf: (callback) => frames.push(callback), later: (callback) => { timers.push(callback); return timers.length; }, cancel() {}, ratio: () => 1 });
  engine.on("move", (value) => events.move.push(value));
  engine.on("arrive", (value) => events.arrive.push(value));
  // Runs only the frames already requested, so a walking avatar cannot loop forever inside one flush.
  const flush = () => { for (const callback of frames.splice(0)) callback(); };
  flush();
  return { engine, handlers, drawn, themes, events, timers, flush, advance: (ms) => { time += ms; } };
}

test("walking to a tile follows a path and arrives", () => {
  const { engine, events, flush, advance, drawn } = setup();
  assert.equal(engine.walkTo({ x: 0, y: 0 }), false, "walls can't be reached");
  assert.equal(engine.walkTo({ x: 21, y: 12 }), true);
  const { path } = events.move[0];
  assert.deepEqual([path[0], path.at(-1)], [{ x: 21, y: 17 }, { x: 21, y: 12 }]);
  advance(((path.length - 1) / 5) * 1000 + 1); flush();
  assert.deepEqual(events.arrive, [{ x: 21, y: 12 }]);
  assert.deepEqual(engine.position(), { x: 21, y: 12 });
  const [me] = drawn.at(-1).avatars;
  assert.deepEqual([me.self, me.x, me.y, me.name], [true, 21, 12, "You"]);
});
test("holding a direction key keeps walking until it is released", () => {
  const { handlers, events, flush, advance } = setup();
  handlers.keydown(key("ArrowUp"));
  assert.deepEqual(events.move.at(-1).path, [{ x: 21, y: 17 }, { x: 21, y: 16 }]);
  handlers.keydown(key("ArrowUp"));
  assert.equal(events.move.length, 1, "key repeat does not restart the step");
  advance(201); flush();
  assert.deepEqual(events.move.at(-1).path, [{ x: 21, y: 16 }, { x: 21, y: 15 }]);
  handlers.keyup(key("ArrowUp"));
  advance(201); flush();
  assert.equal(events.move.length, 2);
  handlers.keydown(key("Enter"));
  assert.equal(events.move.length, 2, "other keys are ignored");
});
test("a blocked step only turns the walker", () => {
  const { engine, handlers, events, flush, advance, drawn } = setup();
  engine.walkTo({ x: 1, y: 18 }); advance(10000); flush();
  const moves = events.move.length;
  handlers.keydown(key("s")); flush();
  assert.equal(events.move.length, moves);
  assert.equal(drawn.at(-1).avatars[0].dir, "down");
  assert.deepEqual(engine.position(), { x: 1, y: 18 });
});
test("clicking or tapping walks to the tile under the pointer", () => {
  const { handlers, events, drawn } = setup();
  const { camera } = drawn.at(-1);
  handlers.pointerup({ clientX: (23 * 32 + 16 - camera.x) * camera.zoom, clientY: (17 * 32 + 16 - camera.y) * camera.zoom });
  assert.deepEqual(events.move.at(-1).path.at(-1), { x: 23, y: 17 });
});
test("blocking decorations change the route", () => {
  const { engine, events } = setup();
  engine.setDecor([{ kind: "statue", x: 21, y: 16 }, { kind: "plant", x: 22, y: 16 }]);
  engine.walkTo({ x: 21, y: 15 });
  assert.equal(events.move.at(-1).path.some((step) => step.x === 21 && step.y === 16), false);
  assert.equal(engine.walkTo({ x: 21, y: 16 }), false);
});
test("idle redraws run only for ambient animation, one timer at a time, and never with reduced motion", () => {
  const animated = setup();
  assert.equal(animated.timers.length, 1);
  animated.engine.setLabels([{ x: 1, y: 1, text: "Hi" }]); animated.flush();
  assert.equal(animated.timers.length, 1, "a second idle timer is not stacked");
  assert.deepEqual(animated.drawn.at(-1).labels, [{ x: 1, y: 1, text: "Hi" }]);
  animated.timers[0](); animated.flush();
  assert.equal(animated.timers.length, 2, "the idle loop continues after its timer fires");
  const still = setup({ reducedMotion: true });
  assert.equal(still.timers.length, 0);
  assert.equal(still.drawn.at(-1).motion, false);
});
test("themes, names, and people can change while walking; destroy removes input", () => {
  const { engine, handlers, themes, drawn, flush } = setup();
  engine.setTheme(minimal);
  engine.setSelf({ name: "Ada" });
  engine.setOthers([{ id: "bo", name: "Bo", walk: { path: [{ x: 22, y: 17 }], startedAt: 0 } }]);
  flush();
  assert.deepEqual(themes, [minimal]);
  assert.deepEqual(drawn.at(-1).avatars.map((avatar) => avatar.name), ["Ada", "Bo"]);
  engine.destroy();
  assert.deepEqual(Object.keys(handlers), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/world-engine.test.mjs`
Expected: FAIL with `Cannot find module` for `world/engine.js`.

- [ ] **Step 3: Implement**

Create `world/engine.js`:

```js
import { findPath, walkable } from "./map.js";
import { BLOCKING_DECOR } from "./kinds.js";
import { follow, screenToTile, zoomFor } from "./camera.js";
import { KEYS, STEP, positionAt } from "./motion.js";
import { createCanvasRenderer } from "./renderer-canvas.js";

// One person's movement, input, camera, and drawing. Other people arrive through setOthers; "move" events go out to them.
export function createEngine({ canvas, map, theme, start, reducedMotion = false, renderer = createCanvasRenderer(canvas, { map, theme }), now = () => performance.now(), raf = (callback) => requestAnimationFrame(callback), later = (callback, delay) => setTimeout(callback, delay), cancel = (handle) => clearTimeout(handle), ratio = () => globalThis.devicePixelRatio || 1 }) {
  const listeners = { arrive: [], move: [] };
  const self = { id: "self", name: "You", walk: { path: [start], startedAt: now(), dir: "down" }, arrived: true };
  let current = theme, others = [], decor = [], labels = [], held = null, pending = false, timer = null;
  let camera = { x: 0, y: 0, zoom: 1 }, viewport = { width: 1, height: 1 };
  const emit = (type, value) => { for (const listener of listeners[type]) listener(value); };
  const here = (time = now()) => positionAt(self.walk, time);
  const blocked = () => new Set(decor.filter((item) => BLOCKING_DECOR.has(item.kind)).map((item) => item.x + "," + item.y));
  const ambient = () => !reducedMotion && (current.effects.some((effect) => effect !== "neon-glow") || map.roles.includes("water"));
  const schedule = () => { if (!pending) { pending = true; raf(frame); } };

  function frame() {
    pending = false;
    const time = now(), s = map.tileSize;
    const reached = here(time);
    if (reached.done && !self.arrived) { self.arrived = true; emit("arrive", { x: reached.x, y: reached.y }); if (held) step(held); }
    const shown = here(time);
    camera = follow({ x: (shown.x + 0.5) * s, y: (shown.y + 0.5) * s }, viewport, { width: map.width * s, height: map.height * s }, zoomFor(viewport, s));
    const crowd = others.map((other) => ({ id: other.id, name: other.name, ...positionAt(other.walk, time) }));
    renderer.draw({ camera, time, avatars: [{ id: self.id, name: self.name, self: true, ...shown }, ...crowd], decor, labels, motion: !reducedMotion });
    if (!shown.done || crowd.some((other) => !other.done)) schedule();
    else if (ambient() && timer === null) timer = later(() => { timer = null; schedule(); }, 66);
  }

  function walkTo(target) {
    const time = now(), position = here(time);
    const path = findPath(map, { x: Math.round(position.x), y: Math.round(position.y) }, target, blocked());
    if (!path) return false;
    self.walk = { path, startedAt: time, dir: position.dir };
    self.arrived = false;
    emit("move", { path, startedAt: time });
    schedule();
    return true;
  }

  function step(dir) {
    const position = here();
    if (!position.done) return;
    const [dx, dy] = STEP[dir], target = { x: position.x + dx, y: position.y + dy };
    if (walkable(map, target.x, target.y, blocked())) walkTo(target);
    else { self.walk = { path: [{ x: position.x, y: position.y }], startedAt: now(), dir }; schedule(); }
  }

  const onPointer = (event) => {
    const bounds = canvas.getBoundingClientRect();
    walkTo(screenToTile(camera, event.clientX - bounds.left, event.clientY - bounds.top, map.tileSize));
  };
  const onKeyDown = (event) => {
    const dir = KEYS[event.key];
    if (!dir) return;
    event.preventDefault();
    if (held === dir) return;
    held = dir;
    step(dir);
  };
  const onKeyUp = (event) => { if (KEYS[event.key] === held) held = null; };
  const onBlur = () => { held = null; };
  const inputs = [["pointerup", onPointer], ["keydown", onKeyDown], ["keyup", onKeyUp], ["blur", onBlur]];
  for (const [type, listener] of inputs) canvas.addEventListener(type, listener);

  const engine = {
    walkTo,
    position() { const position = here(); return { x: Math.round(position.x), y: Math.round(position.y) }; },
    on(type, listener) { listeners[type].push(listener); },
    setSelf({ name }) { self.name = name; schedule(); },
    setTheme(next) { current = next; renderer.setTheme(next); schedule(); },
    setLabels(list) { labels = list; schedule(); },
    setDecor(list) { decor = list; schedule(); },
    setOthers(list) { others = list; schedule(); },
    resize() { viewport = { width: canvas.clientWidth || 1, height: canvas.clientHeight || 1 }; renderer.resize(viewport.width, viewport.height, ratio()); schedule(); },
    destroy() { for (const [type, listener] of inputs) canvas.removeEventListener(type, listener); if (timer !== null) cancel(timer); timer = null; }
  };
  engine.resize();
  return engine;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/world-engine.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add world/engine.js tests/world-engine.test.mjs
git commit -m "Add the world engine: movement, input, camera, and drawing loop" -m "🤖 Built with SMT <smt@agora.build>"
```

---

### Task 7: The walkable plaza page

**Files:**
- Modify: `stoa.html` (replace the shell), `styles.css` (append), `scripts/serve.mjs` (`publicFiles`), `scripts/build.mjs` (root file list), `README.md` (the Stoa section), `tests/server.test.mjs` (production files)
- Create: `stoa.js`
- Test: `tests/spaces-api.test.mjs` (append)

**Interfaces:**
- Consumes: `api`, `sessionReady`, `state` (`script.js`); `parseMap` (`world/map.js`); `createEngine` (Task 6); `GET /api/worlds/plaza`, `GET /api/themes`, `GET /api/spaces`.
- Produces:
  - `/stoa/` shows the themed plaza. You walk by click, tap, or keyboard.
  - The side panel lists every lot with its topic (or "Open") and occupancy, plus a **Go to** button that walks to the lot's door.
  - Arriving at a door announces it in the live status.
  - Lot titles (or topics) appear as signs above the doors.
  - **Minimal view** toggles the viewer's own display and is remembered in `localStorage` (`stoa-minimal`).
  - `?theme=<id>` previews a built-in theme.
  - Theme UI tokens are applied to `#stoa` only.

- [ ] **Step 1: Write the failing test**

Append to `tests/spaces-api.test.mjs`:

```js
test("the plaza page loads its engine modules and every linked file", async () => {
  const { instance, url } = await start();
  try {
    const page = await request(url, "/stoa/");
    const html = await page.text();
    assert.match(html, /<canvas id="stoa-canvas"/);
    assert.match(html, /id="stoa-rooms"/);
    assert.match(html, /aria-live="polite"/);
    const links = new Set([...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]).filter((link) => !link.startsWith("https://")));
    for (const link of links) assert.equal((await fetch(new URL(link, url + "/stoa/"))).status, 200, link);
    for (const module of ["/stoa.js", "/world/map.js", "/world/kinds.js", "/world/themes.js", "/world/camera.js", "/world/motion.js", "/world/renderer-canvas.js", "/world/engine.js"]) {
      const response = await request(url, module);
      assert.equal(response.status, 200, module);
      assert.match(response.headers.get("content-type"), /text\/javascript/, module);
    }
  } finally { await close(instance); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spaces-api.test.mjs`
Expected: FAIL. The shell page has no `stoa-canvas`, and `/stoa.js` returns 404.

- [ ] **Step 3: Implement**

**`stoa.html`:** replace the whole file. Copy `meetings.html` exactly, then make these changes:
1. `<title>` becomes `Stoa | Agora Build`.
2. The `<meta name="description">` content becomes `The Stoa is Agora Build's walkable plaza for builders: meet people, start a topic, and work together.`
3. Replace `<script type="module" src="/meetings.js"></script>` with `<script type="module" src="/stoa.js"></script>`. Keep `/script.js`.
4. In the nav, remove `class="is-active" aria-current="page"` from the Rooms link so no item is marked current.
5. Replace the entire `<main id="main" ...>...</main>` element (in `meetings.html` it starts on the line with `<main id="main" class="main-content">` and ends with `</main>`) with:

```html
    <main id="main" class="main-content stoa-main">
      <section class="stoa" id="stoa" aria-labelledby="stoa-title">
        <div class="stoa-heading"><div><p class="kicker">THE STOA / PUBLIC PLAZA</p><h1 id="stoa-title">Walk into the plaza.</h1></div><button class="button button-secondary button-small" type="button" id="stoa-minimal" aria-pressed="false">Minimal view</button></div>
        <div class="stoa-layout">
          <div class="stoa-stage"><canvas id="stoa-canvas" tabindex="0" aria-label="Plaza map" aria-describedby="stoa-help"></canvas><p class="stoa-help" id="stoa-help">Click or tap to walk. Select the map to use the arrow keys or WASD.</p></div>
          <aside class="stoa-panel" aria-label="Around you">
            <p class="stoa-status" id="stoa-status" role="status" aria-live="polite">Opening the plaza...</p>
            <h2 class="stoa-panel-title">Rooms</h2>
            <ul class="stoa-rooms" id="stoa-rooms"></ul>
            <h2 class="stoa-panel-title">Here now</h2>
            <ul class="stoa-people" id="stoa-people"></ul>
          </aside>
        </div>
      </section>
    </main>
```

Keep the header, footer, all dialogs, and `<div id="toast" ...>` from `meetings.html` unchanged, because `script.js` needs them.

Create `stoa.js`:

```js
import { api, sessionReady, state } from "./script.js";
import { parseMap } from "./world/map.js";
import { createEngine } from "./world/engine.js";

const root = document.querySelector("#stoa");
const canvas = document.querySelector("#stoa-canvas");
const status = document.querySelector("#stoa-status");
const roomList = document.querySelector("#stoa-rooms");
const peopleList = document.querySelector("#stoa-people");
const minimalToggle = document.querySelector("#stoa-minimal");
const say = (message) => { status.textContent = message; };
const node = (tag, text, className) => { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };

// Theme tokens restyle only the Stoa section; the site header and footer keep the portal's look.
function applyUi(theme) {
  for (const [token, value] of Object.entries(theme.ui)) if (token.startsWith("--")) root.style.setProperty(token, value);
  root.style.fontFamily = theme.ui.font ? "\"" + theme.ui.font + "\", sans-serif" : "";
}

try {
  const [source, { themes }, listing] = await Promise.all([api("/api/worlds/plaza"), api("/api/themes"), api("/api/spaces")]);
  const map = parseMap(source);
  const byId = Object.fromEntries(themes.map((theme) => [theme.id, theme]));
  const preview = byId[new URLSearchParams(location.search).get("theme")];
  const chosen = preview || byId.agora;
  let minimal = localStorage.getItem("stoa-minimal") === "true";
  const active = () => minimal ? byId.minimal : chosen;
  const engine = createEngine({ canvas, map, theme: active(), start: map.spawns[0], reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches });
  applyUi(active());
  minimalToggle.setAttribute("aria-pressed", String(minimal));
  minimalToggle.addEventListener("click", () => {
    minimal = !minimal;
    localStorage.setItem("stoa-minimal", String(minimal));
    minimalToggle.setAttribute("aria-pressed", String(minimal));
    applyUi(active());
    engine.setTheme(active());
  });
  new ResizeObserver(() => engine.resize()).observe(canvas);

  const rooms = new Map(listing.rooms.map((room) => [room.slug, room]));
  engine.setLabels(map.lots.map((lot) => ({ x: lot.door.x, y: lot.door.y - 1, text: rooms.get(lot.slug)?.topic || lot.title })));
  for (const lot of map.lots) {
    const room = rooms.get(lot.slug) || { topic: null, occupancy: 0, capacity: lot.capacity };
    const entry = node("li", "", "stoa-room");
    const go = node("button", "Go to", "button button-secondary button-small");
    go.type = "button";
    go.setAttribute("aria-label", "Walk to " + lot.title);
    go.addEventListener("click", () => { if (engine.walkTo(lot.door)) say("Walking to " + lot.title + "."); canvas.focus(); });
    entry.append(node("strong", lot.title), node("span", (room.topic || "Open") + " · " + room.occupancy + " of " + room.capacity + " here"), go);
    roomList.append(entry);
  }
  const doors = new Map(map.lots.map((lot) => [lot.door.x + "," + lot.door.y, lot]));
  engine.on("arrive", (tile) => { const lot = doors.get(tile.x + "," + tile.y); if (lot) say("You are at the door of " + lot.title + ". Stepping inside comes with the next update."); });

  await sessionReady;
  const name = state.profile?.name || state.account?.name || "You";
  engine.setSelf({ name });
  peopleList.replaceChildren(node("li", name + " (you)"));
  say(preview ? "Previewing the " + preview.name + " theme. Only you see it." : "You're on the plaza. Walk to a room to see who's there.");
} catch (error) {
  say(error.message || "The plaza could not open. Please try again.");
}
```

Append to `styles.css`:

```css
.stoa-main { max-width: 1400px; }
.stoa { color: var(--ink); }
.stoa-heading { display: flex; justify-content: space-between; align-items: end; gap: 20px; flex-wrap: wrap; margin-bottom: 18px; }
.stoa-heading h1 { margin: 6px 0 0; font-size: clamp(30px, 4vw, 46px); font-weight: 500; letter-spacing: -1.5px; }
.stoa-heading [aria-pressed="true"] { background: var(--ink); color: var(--paper); }
.stoa-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; }
.stoa-stage { background: var(--paper); border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
#stoa-canvas { display: block; width: 100%; height: min(72vh, 720px); min-height: 420px; touch-action: none; cursor: pointer; }
#stoa-canvas:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; }
.stoa-help { margin: 0; padding: 9px 14px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); background: var(--surface); }
.stoa-panel { padding: 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 5px; align-self: start; }
.stoa-status { margin: 0 0 18px; font-size: 13px; color: var(--muted); }
.stoa-panel-title { margin: 22px 0 10px; font: 500 12px var(--mono); letter-spacing: 1px; text-transform: uppercase; color: var(--muted); }
.stoa-rooms, .stoa-people { list-style: none; margin: 0; padding: 0; }
.stoa-room { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--line); }
.stoa-room strong { font-weight: 500; }
.stoa-room span { grid-column: 1; font-size: 12px; color: var(--muted); }
.stoa-room button { grid-row: 1 / span 2; grid-column: 2; }
.stoa-people li { font-size: 14px; padding: 6px 0; }
@media (max-width: 900px) { .stoa-layout { grid-template-columns: 1fr; } #stoa-canvas { height: 62vh; min-height: 340px; } }
```

In `scripts/serve.mjs`, add `"stoa.js"`, `"world/kinds.js"`, `"world/themes.js"`, `"world/camera.js"`, `"world/motion.js"`, `"world/renderer-canvas.js"`, and `"world/engine.js"` to `publicFiles`.

In `scripts/build.mjs`, add `"stoa.js"` to the root file list after `"stoa.html"`.

In `tests/server.test.mjs`, add `"stoa.js"` and `"world/engine.js"` to the production test's `files` array.

In `README.md`, append to the `## Stoa spaces` section:

```markdown
Built-in themes live in `themes/` (Agora, Minimal, Cyberpunk) and are validated at startup. Visitors can switch their own view to Minimal; `/stoa/?theme=cyberpunk` previews a theme. Movement works with click or tap and with the arrow keys or WASD; the side panel offers the same actions for keyboard and screen reader users.
```

- [ ] **Step 4: Run tests and check it in a real browser**

Run: `npm test`
Expected: PASS.

Start a server on a free port with throwaway state, then capture screenshots:

```bash
STOA_DATA=$(mktemp -d)
node -e 'import("./scripts/serve.mjs").then(({ createAppServer }) => createAppServer(process.cwd(), { storageFile: process.argv[1] + "/state.json", monitor: false }).listen(4381, "127.0.0.1"))' "$STOA_DATA" &
sleep 2
for view in "1280,900 desktop" "390,844 mobile"; do set -- $view; google-chrome --headless=new --disable-gpu --hide-scrollbars --window-size=$1 --virtual-time-budget=4000 --screenshot=/tmp/stoa-$2.png http://127.0.0.1:4381/stoa/; done
google-chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1280,900 --virtual-time-budget=4000 --screenshot=/tmp/stoa-cyberpunk.png "http://127.0.0.1:4381/stoa/?theme=cyberpunk"
kill %1; rm -rf "$STOA_DATA"
```

Expected: the three PNG files exist. Read each one and confirm:
- The plaza is drawn: paths, the fountain, six facades with door signs, and an avatar at the bottom center.
- The room list is filled.
- Mobile stacks the panel under the map.
- The Cyberpunk preview is dark and neon.

- [ ] **Step 5: Commit**

```bash
git add stoa.html stoa.js styles.css scripts/serve.mjs scripts/build.mjs README.md tests/spaces-api.test.mjs tests/server.test.mjs
git commit -m "Open the walkable plaza page" -m "🤖 Built with SMT <smt@agora.build>"
```

---

## Spec Coverage (Plan B)

| Spec requirement (section 4) | Task |
| --- | --- |
| Maps hold semantic roles; theme supplies art; server and client share `map.js` | 1, 2, 3 |
| Themes are data only, validated (roles and decor kinds, CSS token allowlist, size), with a fixed effects catalog | 2, 3 |
| Three built-in themes (Agora, Minimal, Cyberpunk) drawn in code, no external assets | 3, 5 |
| Viewer can switch to Minimal for their own display | 7 |
| Canvas 2D engine, high-resolution aware, camera follows, click/tap and arrows/WASD | 4, 5, 6 |
| Draws only while moving or animating; reduced motion stops effects and animation | 5, 6 |
| Renderer interface swappable for WebGL | 5 |
| Decorations drawn by theme from semantic kinds; blocking decorations shape paths | 1, 5, 6 |
| Accessibility panel: rooms with Go to, people, live status | 7 |

Deferred to Plan C: other people over Signaling, entering rooms, the host topic and decor modes, calls, private-space encryption, the Stoa navigation link, and the `/meet` redirect.
