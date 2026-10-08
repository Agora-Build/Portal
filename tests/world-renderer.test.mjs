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

test("tiles outside the bounds are not drawn", () => {
  const rects = (frame) => render(minimal, { motion: false, ...frame }, [1408, 1088]).calls.filter(([name]) => name === "fillRect");
  const all = rects({}), bounded = rects({ bounds: { x: 0, y: 0, width: 44, height: 20 } });
  assert.ok(all.some(([, , y]) => y >= 20 * 32), "the whole map draws interiors");
  assert.ok(bounded.length > 0 && bounded.length < all.length);
  assert.ok(!bounded.some(([, , y]) => y >= 20 * 32));
});

// Fill colors of the whole-tile rectangles drawn at tile (x, y).
const originRects = (calls, x, y) => { let style = null; const out = []; for (const [name, a, b, c, d] of calls) { if (name === "set:fillStyle") style = a; else if (name === "fillRect" && a === x * 32 && b === y * 32 && c === 32 && d === 32) out.push(style); } return out; };
const tileView = (x, y) => ({ motion: false, camera: { x: x * 32, y: y * 32, zoom: 1 } });
test("a tile that fills itself is not drawn over its ground", () => {
  const index = plaza.roles.findIndex((role, i) => role === "wall" && plaza.ground[i] && plaza.ground[i] !== "wall");
  assert.ok(index >= 0);
  const x = index % plaza.width, y = Math.floor(index / plaza.width);
  const painted = originRects(render(agora, tileView(x, y)).calls, x, y);
  assert.deepEqual(painted, [agora.roles.wall.colors[0]], "only the wall is painted: " + painted);
});
test("ground still shows under shapes that do not fill the tile", () => {
  const index = plaza.roles.findIndex((role, i) => role && !["flat", "tiles", "path", "grass", "water", "wall", "neon"].includes(agora.roles[role].pattern) && plaza.ground[i] && plaza.ground[i] !== role);
  assert.ok(index >= 0, "the plaza has a column, door, or similar over ground");
  const x = index % plaza.width, y = Math.floor(index / plaza.width);
  assert.ok(originRects(render(agora, tileView(x, y)).calls, x, y).includes(agora.roles[plaza.ground[index]].colors[0]));
});
test("unknown decoration kinds are skipped and fonts have a fallback", () => {
  const { calls } = render(agora, { motion: false, decor: [{ kind: "__proto__", x: 3, y: 3 }, { kind: "constructor", x: 4, y: 3 }, { kind: "toString", x: 5, y: 3 }], avatars: [{ id: "a", name: "Ada", x: 3, y: 3 }] });
  const fonts = calls.filter(([name]) => name === "set:font").map(([, value]) => value);
  assert.ok(fonts.length > 0 && fonts.every((font) => font.endsWith(", sans-serif")), fonts.join("|"));
  assert.ok(fonts.some((font) => font.includes("\"IBM Plex Sans\"")));
});

test("speech bubbles are drawn above avatars that are talking", () => {
  const { calls } = render(agora, { avatars: [{ id: "a", name: "Ada", x: 5, y: 5, dir: "down", bubble: "Hello there" }, { id: "b", name: "Bo", x: 7, y: 5, dir: "down" }], motion: false });
  const texts = calls.filter(([name]) => name === "fillText").map(([, text]) => text);
  assert.equal(texts.filter((text) => text === "Hello there").length, 1);
});
