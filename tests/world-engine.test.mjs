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
  return { engine, handlers, drawn, themes, events, timers, frames, flush, advance: (ms) => { time += ms; } };
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
test("destroy stops the loop", () => {
  const { engine, frames, timers, drawn, flush } = setup();
  engine.walkTo({ x: 21, y: 12 });
  engine.destroy();
  const [drawnBefore, timersBefore] = [drawn.length, timers.length];
  engine.setLabels([{ x: 1, y: 1, text: "Hi" }]); flush();
  for (const callback of timers) callback();
  flush();
  assert.equal(drawn.length, drawnBefore);
  assert.equal(timers.length, timersBefore);
  assert.equal(frames.length, 0);
});
test("walking to a new tile mid-walk keeps the avatar where it is", () => {
  const { engine, events, drawn, flush, advance } = setup();
  engine.walkTo({ x: 21, y: 12 });
  const first = events.move[0];
  advance(300); flush();
  const before = drawn.at(-1).avatars[0];
  assert.equal(engine.walkTo({ x: 23, y: 17 }), true);
  flush();
  const after = drawn.at(-1).avatars[0];
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
  const { path, startedAt } = events.move.at(-1);
  assert.deepEqual(path[0], first.path[1]);
  assert.deepEqual(path.at(-1), { x: 23, y: 17 });
  assert.equal(startedAt, 1000 + 300 - 100);
});
test("modified keys and secondary buttons are ignored, and listeners can be removed", () => {
  const { engine, handlers, events } = setup();
  let prevented = false;
  handlers.keydown({ key: "ArrowLeft", ctrlKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(events.move.length, 0);
  handlers.pointerup({ button: 2, clientX: 0, clientY: 0 });
  assert.equal(events.move.length, 0);
  const seen = [];
  const off = engine.on("move", (value) => seen.push(value));
  engine.walkTo({ x: 21, y: 12 });
  off();
  engine.walkTo({ x: 23, y: 17 });
  assert.equal(seen.length, 1);
});
