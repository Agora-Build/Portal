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
test("protected tiles stay clear and blocking kinds cannot cut off an entrance or a seat", () => {
  const decor = createArrangement({ map: room, area, items: [], start: { x: 10, y: 10 }, protect: [{ x: 1, y: 2 }], makeId: () => "p" + (next += 1) });
  assert.equal(decor.place("plant", { x: 1, y: 2 }), "protected");
  assert.equal(decor.place("sofa", { x: 2, y: 2 }), "placed", "the entrance still has another way in");
  assert.equal(decor.place("sofa", { x: 1, y: 3 }), "unreachable", "that would seal the entrance");
  assert.equal(decor.place("plant", { x: 1, y: 3 }), "placed", "a plant does not block");
  assert.equal(decor.move("down"), "moved", "non-blocking kinds move freely");
  const seated = createArrangement({ map: room, area, items: [], start: { x: 10, y: 10 }, makeId: () => "q" + (next += 1) });
  const around = [{ x: 7, y: 4 }, { x: 8, y: 3 }, { x: 9, y: 3 }, { x: 10, y: 3 }, { x: 11, y: 3 }, { x: 12, y: 4 }];
  const results = around.map((tile) => seated.place("statue", tile));
  assert.equal(results.at(-1), "unreachable", "the last statue would wall in the row of seats");
  assert.deepEqual(results.slice(0, -1), Array(5).fill("placed"));
});

// A tiny fake document, enough for the editor's buttons, lists, and canvas.
class Element {
  constructor(tag) { Object.assign(this, { tagName: tag, children: [], listeners: {}, attrs: {}, hidden: false, disabled: false, textContent: "", className: "" }); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener(type) { delete this.listeners[type]; }
  setAttribute(name, value) { this.attrs[name] = value; }
  focus() { this.focused = (this.focused || 0) + 1; }
}
test("the editor takes over the map while open and gives it back on abort or close", async () => {
  const { createDecorEditor } = await import("../stoa/decor.js");
  const registry = new Map(), doc = { querySelector: (selector) => { if (!registry.has(selector)) registry.set(selector, new Element(selector)); return registry.get(selector); }, createElement: (tag) => new Element(tag) };
  const canvas = new Element("canvas"), log = { decor: [], picking: [], interactive: [], closed: 0 };
  const engine = { setDecor: (list) => log.decor.push(list), setPicking: (handler) => log.picking.push(handler), setInteractive: (value) => log.interactive.push(value), position: () => open, facing: () => "right" };
  const editor = createDecorEditor({ doc, canvas, engine, map: room, say() {}, onClose: () => { log.closed += 1; } });
  const saved = [{ id: "a", kind: "lamp", x: open.x, y: open.y, rotation: 0, variant: 0 }];
  editor.open({ items: saved, area });
  assert.equal(editor.isOpen(), true);
  assert.equal(log.interactive.at(-1), false);
  assert.equal(typeof log.picking.at(-1), "function");
  assert.equal(registry.get("#stoa-decor").hidden, false);
  assert.equal(registry.get("#stoa-decor-turn").disabled, true, "nothing is selected yet");
  log.picking.at(-1)({ x: open.x, y: open.y });
  assert.equal(registry.get("#stoa-decor-turn").disabled, false);
  canvas.listeners.keydown({ key: "Delete", preventDefault() {} });
  assert.deepEqual(log.decor.at(-1), [], "the lamp was removed from the working copy");
  editor.close();
  assert.deepEqual(log.decor.at(-1), saved, "closing restores the saved arrangement");
  assert.equal(log.closed, 1);
  assert.equal(editor.isOpen(), false);
  editor.open({ items: saved, area });
  const before = log.decor.length;
  editor.abort();
  assert.equal(log.picking.at(-1), null);
  assert.equal(log.interactive.at(-1), true);
  assert.equal(log.closed, 2);
  assert.equal(log.decor.length, before, "abort leaves the engine's decorations alone");
});
