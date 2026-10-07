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
