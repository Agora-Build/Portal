import { test } from "node:test";
import assert from "node:assert/strict";
import { follow, screenToTile, tileCenter, zoomFor } from "../world/camera.js";
import { KEYS, STEP, WALK_SPEED, direction, positionAt } from "../world/motion.js";

test("zoom shows about eighteen tiles across the shorter side, within limits", () => {
  assert.equal(zoomFor({ width: 1152, height: 576 }, 32), 1);
  assert.equal(zoomFor({ width: 100, height: 100 }, 32), 0.6);
  assert.equal(zoomFor({ width: 4000, height: 4000 }, 32), 2);
});
test("the camera follows the target, stops at the world's edges, and centers small worlds", () => {
  const world = { width: 1408, height: 1088 }, viewport = { width: 640, height: 480 };
  assert.deepEqual(follow({ x: 700, y: 500 }, viewport, world, 1), { x: 380, y: 260, zoom: 1 });
  assert.deepEqual(follow({ x: 10, y: 10 }, viewport, world, 1), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(follow({ x: 1400, y: 1080 }, viewport, world, 1), { x: 768, y: 608, zoom: 1 });
  assert.deepEqual(follow({ x: 50, y: 50 }, viewport, { width: 320, height: 240 }, 1), { x: -160, y: -120, zoom: 1 });
  assert.deepEqual(follow({ x: 700, y: 500 }, viewport, { x: 100, y: 50, width: 600, height: 500 }, 1), { x: 80, y: 70, zoom: 1 });
  assert.deepEqual(follow({ x: 50, y: 50 }, viewport, { x: 100, y: 50, width: 320, height: 240 }, 1), { x: -60, y: -70, zoom: 1 });
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
