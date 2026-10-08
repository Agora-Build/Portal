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

function setup({ reducedMotion = false, theme = agora, size = [640, 480] } = {}) {
  let time = 1000;
  const frames = [], timers = [], drawn = [], themes = [], handlers = {}, events = { move: [], arrive: [], walk: [], stop: [], face: [] };
  const canvas = { clientWidth: size[0], clientHeight: size[1], addEventListener: (type, listener) => { handlers[type] = listener; }, removeEventListener: (type) => { delete handlers[type]; }, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const renderer = { resize() {}, setTheme: (theme) => themes.push(theme), draw: (frame) => drawn.push(frame) };
  const engine = createEngine({ canvas, map: plaza, theme, start: plaza.spawns[0], reducedMotion, renderer, now: () => time, raf: (callback) => frames.push(callback), later: (callback) => { timers.push(callback); return timers.length; }, cancel() {}, ratio: () => 1 });
  for (const type of Object.keys(events)) engine.on(type, (value) => events[type].push(value));
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

test("bounds keep the camera and the frame inside the plaza", () => {
  const { engine, drawn, flush } = setup();
  const rect = { x: 0, y: 0, width: 44, height: 20 };
  engine.setBounds(rect);
  engine.walkTo({ x: 21, y: 17 });
  flush();
  const frame = drawn.at(-1);
  assert.deepEqual(frame.bounds, rect);
  assert.ok(frame.camera.y + 480 / frame.camera.zoom <= 20 * 32 + 1e-9);
  engine.setBounds(null);
  flush();
  assert.equal(drawn.at(-1).bounds, null);
});

test("a theme that draws water flat does not keep an idle loop running", () => {
  assert.ok(plaza.roles.includes("water"), "the plaza has water");
  assert.equal(setup({ theme: minimal }).timers.length, 0, "Minimal is still when idle");
  assert.equal(setup().timers.length, 1, "animated water keeps ambient redraws");
});
test("releasing a key always releases the hold, even with modifiers", () => {
  const { handlers, events, flush, advance } = setup();
  handlers.keydown(key("ArrowUp"));
  handlers.keyup({ key: "ArrowUp", metaKey: true });
  advance(201); flush();
  assert.deepEqual([events.walk.length, events.stop.length], [1, 1]);
});
test("self identity decides the avatar id", () => {
  const { engine, drawn, flush } = setup();
  engine.setSelf({ id: "account:x", name: "Ada" }); flush();
  assert.equal(drawn.at(-1).avatars[0].id, "account:x");
  engine.setSelf({ name: "Ada" }); flush();
  assert.equal(drawn.at(-1).avatars[0].id, "account:x", "an omitted id keeps the current one");
});
test("bad peer walks are ignored and never throw while drawing", () => {
  const { engine, drawn, flush } = setup();
  engine.setOthers([
    { id: "empty", name: "E", walk: { path: [], startedAt: 0 } },
    { id: "none", name: "N" },
    null,
    { id: "wall", name: "W", walk: { path: [{ x: 0, y: 0 }], startedAt: 0 } },
    { id: "time", name: "T", walk: { path: [{ x: 22, y: 17 }], startedAt: "x" } },
    { id: "frac", name: "F", walk: { path: [{ x: 22.5, y: 17 }], startedAt: 0 } },
    { id: "ok", name: "Bo", walk: { path: [{ x: 22, y: 17 }], startedAt: 0 } }
  ]);
  assert.doesNotThrow(() => flush());
  assert.deepEqual(drawn.at(-1).avatars.map((avatar) => avatar.name), ["You", "Bo"]);
});
test("unknown engine events throw a clear error", () => {
  const { engine } = setup();
  assert.throws(() => engine.on("__proto__", () => {}), /Unknown engine event: __proto__/);
  assert.throws(() => engine.on("nope", () => {}), /Unknown engine event: nope/);
});
test("walking to the tile you stand on does nothing", () => {
  const { engine, events } = setup();
  assert.equal(engine.walkTo({ x: 21, y: 17 }), false);
  assert.equal(events.move.length, 0);
});
test("an arrival not yet announced is announced before the next walk starts", () => {
  const { engine, events, advance } = setup();
  engine.walkTo({ x: 21, y: 12 });
  advance(10000);
  assert.equal(events.arrive.length, 0);
  assert.equal(engine.walkTo({ x: 23, y: 17 }), true);
  assert.deepEqual(events.arrive, [{ x: 21, y: 12 }]);
  assert.equal(events.move.length, 2);
});
test("a held key publishes one walk and its release publishes one stop", () => {
  const { engine, handlers, events, flush, advance } = setup();
  handlers.keydown(key("ArrowUp"));
  assert.equal(events.move.length, 0);
  assert.deepEqual(events.walk, [{ from: { x: 21, y: 17 }, dir: "up", startedAt: 1000 }]);
  handlers.keydown(key("ArrowUp"));
  assert.equal(events.walk.length, 1, "key repeat does not restart the walk");
  advance(300); flush();
  handlers.keyup(key("ArrowUp"));
  assert.deepEqual(events.stop, [{ at: { x: 21, y: 15 } }]);
  advance(1000); flush();
  assert.deepEqual(engine.position(), { x: 21, y: 15 });
  assert.deepEqual(events.arrive.at(-1), { x: 21, y: 15 });
});
test("a key toward a wall only turns you and says so", () => {
  const { engine, handlers, events, flush, advance, drawn } = setup();
  engine.walkTo({ x: 1, y: 18 }); advance(10000); flush();
  handlers.keydown(key("s")); flush();
  assert.deepEqual(events.face, [{ dir: "down", at: { x: 1, y: 18 } }]);
  assert.equal(events.walk.length, 0);
  assert.equal(drawn.at(-1).avatars[0].dir, "down");
});
test("teleporting, turning input off, and clicks outside the bounds", () => {
  const { engine, handlers, events, flush, drawn } = setup();
  engine.teleport({ x: 17, y: 31 }, "up");
  engine.setBounds({ x: 15, y: 21, width: 6, height: 12 });
  flush();
  assert.deepEqual([engine.position(), engine.facing(), events.move.length], [{ x: 17, y: 31 }, "up", 0]);
  const { camera } = drawn.at(-1);
  const click = (tile) => handlers.pointerup({ button: 0, clientX: (tile.x * 32 + 16 - camera.x) * camera.zoom, clientY: (tile.y * 32 + 16 - camera.y) * camera.zoom });
  click({ x: 22, y: 25 });
  assert.equal(events.move.length, 0, "a tile outside the bounds is ignored");
  click({ x: 16, y: 29 });
  assert.equal(events.move.length, 1);
  engine.setInteractive(false);
  click({ x: 16, y: 28 }); handlers.keydown(key("ArrowUp"));
  assert.deepEqual([events.move.length, events.walk.length], [1, 0]);
});
test("turning input off ends a keyboard walk", () => {
  const { engine, handlers, events } = setup();
  handlers.keydown(key("ArrowUp"));
  engine.setInteractive(false);
  assert.deepEqual(events.stop, [{ at: { x: 21, y: 17 } }]);
});
test("speech bubbles show for a while, then the engine redraws without them", () => {
  const { engine, drawn, flush, advance, timers } = setup({ theme: minimal });
  assert.equal(timers.length, 0);
  engine.say("Hello plaza");
  engine.setOthers([{ id: "bo", name: "Bo", walk: { path: [{ x: 22, y: 17 }], startedAt: 0 }, bubble: { text: "Hi!", until: 4000 } }]);
  flush();
  assert.deepEqual(drawn.at(-1).avatars.map((avatar) => avatar.bubble), ["Hello plaza", "Hi!"]);
  assert.equal(timers.length, 1, "a timer wakes the engine when the first bubble ends");
  advance(3001); timers[0](); flush();
  assert.deepEqual(drawn.at(-1).avatars.map((avatar) => avatar.bubble), ["Hello plaza", null]);
  advance(5000); timers[1](); flush();
  assert.deepEqual(drawn.at(-1).avatars.map((avatar) => avatar.bubble), [null, null]);
});
test("a decoration placed on your route sends you around it", () => {
  const { engine, events, flush, advance } = setup();
  engine.walkTo({ x: 21, y: 12 }); advance(100); flush();
  engine.setDecor([{ kind: "statue", x: 21, y: 14 }]);
  assert.equal(events.move.length, 2);
  const route = events.move.at(-1).path;
  assert.equal(route.some((step) => step.x === 21 && step.y === 14), false);
  assert.deepEqual(route.at(-1), { x: 21, y: 12 });
});
test("a decoration in front of a keyboard walk stops it before the decoration", () => {
  const { engine, handlers, events } = setup();
  handlers.keydown(key("ArrowUp"));
  engine.setDecor([{ kind: "statue", x: 21, y: 14 }]);
  assert.deepEqual(events.stop, [{ at: { x: 21, y: 15 } }]);
});
test("only people within about two screens of the camera are drawn, but everyone is kept", () => {
  const { engine, drawn, flush, advance } = setup({ size: [320, 240] });
  const others = [{ id: "bo", name: "Bo", walk: { path: [{ x: 22, y: 17 }], startedAt: 0 } }, { id: "far", name: "Far", walk: { path: [{ x: 42, y: 1 }], startedAt: 0 } }];
  engine.setOthers(others); flush();
  assert.deepEqual(drawn.at(-1).avatars.map((avatar) => avatar.id), ["self", "bo"]);
  assert.equal(engine.walkTo({ x: 42, y: 1 }), true);
  advance(10000); engine.setOthers(others); flush();
  assert.equal(drawn.at(-1).avatars.length, 3, "the far person is drawn again once the camera is near");
});
test("someone walking in from off-screen is drawn as they arrive, even with nothing else animating", () => {
  const { engine, drawn, frames, timers, advance } = setup({ reducedMotion: true, theme: minimal, size: [200, 200] });
  const path = [];
  for (let x = 1; x <= 12; x += 1) path.push({ x, y: 9 });
  engine.setOthers([{ id: "far", name: "Far", walk: { path, startedAt: 1000 } }]);
  const run = () => { for (const callback of [...frames.splice(0), ...timers.splice(0)]) callback(); };
  run();
  assert.equal(drawn.at(-1).avatars.some((avatar) => avatar.id === "far"), false, "far away people are not drawn");
  for (let step = 0; step < 20; step += 1) { advance(100); run(); }
  const far = drawn.at(-1).avatars.find((avatar) => avatar.id === "far");
  assert.ok(far, "the walker is drawn once they come into view");
  assert.equal(far.x, 11, "and at their real position while still walking");
});
