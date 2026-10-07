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
