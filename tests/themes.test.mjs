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
test("themes reject unknown fields", () => {
  assert.ok(broken((theme) => { theme.roles.floor.image = "floor.svg"; }).some((msg) => msg.includes("unknown field")));
  assert.ok(broken((theme) => { theme.script = "alert('hi')"; }).some((msg) => msg.includes("unknown field")));
  assert.ok(broken((theme) => { theme.roles.lava = { pattern: "flat", colors: ["#111111"] }; }).some((msg) => msg.includes("unknown field")));
  assert.deepEqual(validateTheme(sampleTheme()), []);
});
test("lighting.ambient rejects NaN", () => {
  assert.notDeepEqual(broken((theme) => { theme.lighting.ambient = NaN; }), []);
});

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
