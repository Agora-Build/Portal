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
