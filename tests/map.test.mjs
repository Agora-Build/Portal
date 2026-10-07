import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_ROLES, findPath, parseMap, reachable, roleAt, validPath, walkable } from "../world/map.js";

const role = (id, name, extra = []) => ({ id, properties: [{ name: "role", type: "string", value: name }, ...extra] });
const fixture = () => ({
  type: "map", orientation: "orthogonal", width: 5, height: 4, tilewidth: 32, tileheight: 32,
  properties: [{ name: "id", type: "string", value: "tiny" }],
  tilesets: [{ firstgid: 1, tiles: [role(0, "floor"), role(1, "wall"), role(2, "water", [{ name: "walkable", type: "bool", value: true }]), role(3, "seat")] }],
  layers: [
    { type: "tilelayer", name: "ground", data: new Array(20).fill(1) },
    { type: "tilelayer", name: "structure", data: [0, 0, 2, 0, 0, 0, 0, 2, 0, 4, 0, 0, 2, 0, 3, 0, 0, 0, 0, 0] },
    { type: "objectgroup", name: "spawn", objects: [{ id: 1, name: "", x: 0, y: 0, width: 0, height: 0 }] },
    { type: "objectgroup", name: "lot", objects: [{ id: 2, name: "", x: 96, y: 0, width: 64, height: 96, properties: [{ name: "lotId", value: "a" }, { name: "slug", value: "a-room" }, { name: "title", value: "A" }, { name: "capacity", value: 4 }, { name: "doorX", value: 3 }, { name: "doorY", value: 3 }, { name: "entryX", value: 3 }, { name: "entryY", value: 2 }] }] },
    { type: "objectgroup", name: "interactable", objects: [{ id: 3, name: "", x: 32, y: 96, width: 0, height: 0, properties: [{ name: "id", value: "board" }, { name: "kind", value: "noticeboard" }, { name: "label", value: "Board" }, { name: "query", value: "voice" }] }] }
  ]
});

test("core roles are fixed and ordered", () => {
  assert.deepEqual(CORE_ROLES, ["floor", "path", "grass", "water", "wall", "column", "door", "table", "seat", "plant", "decor"]);
});
test("maps parse roles, walkability overrides, lots, spawns, and interactables", () => {
  const map = parseMap(fixture());
  assert.equal(map.id, "tiny");
  assert.deepEqual([map.width, map.height, map.tileSize], [5, 4, 32]);
  assert.equal(roleAt(map, 2, 0), "wall");
  assert.equal(roleAt(map, 4, 2), "water");
  assert.equal(walkable(map, 2, 0), false);
  assert.equal(walkable(map, 4, 2), true, "a tile property can make water walkable");
  assert.equal(walkable(map, 4, 1), true, "seats are walkable");
  assert.equal(walkable(map, -1, 0), false);
  assert.equal(walkable(map, 0.5, 0), false);
  assert.deepEqual(map.spawns, [{ x: 0, y: 0 }]);
  assert.deepEqual(map.lots, [{ lotId: "a", slug: "a-room", title: "A", capacity: 4, door: { x: 3, y: 3 }, entry: { x: 3, y: 2 }, interior: { x: 3, y: 0, width: 2, height: 3 } }]);
  assert.deepEqual(map.interactables, [{ id: "board", kind: "noticeboard", label: "Board", query: "voice", x: 1, y: 3 }]);
});
test("unsupported maps are rejected", () => {
  assert.throws(() => parseMap({ ...fixture(), orientation: "isometric" }));
  const unknown = fixture(); unknown.layers[1].data[0] = 99;
  assert.throws(() => parseMap(unknown), /Unknown tile/);
  const short = fixture(); short.layers[0].data = [1];
  assert.throws(() => parseMap(short), /wrong size/);
});
test("paths are shortest, avoid blocked tiles, and respect extra blockers", () => {
  const map = parseMap(fixture());
  const path = findPath(map, { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.equal(path.length, 11);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path.at(-1), { x: 4, y: 0 });
  assert.equal(validPath(map, path), true);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }), null);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 4, y: 0 }, new Set(["2,3"])), null);
  const open = reachable(map, { x: 0, y: 0 }, new Set(["1,3"]));
  assert.ok(open.has("0,3"));
  assert.ok(!open.has("4,0"));
});
test("received paths are rejected when they jump or cross blocked tiles", () => {
  const map = parseMap(fixture());
  assert.equal(validPath(map, [{ x: 0, y: 0 }, { x: 0, y: 2 }]), false);
  assert.equal(validPath(map, [{ x: 1, y: 0 }, { x: 2, y: 0 }]), false);
  assert.equal(validPath(map, []), false);
  assert.equal(validPath(map, "nope"), false);
  assert.equal(validPath(map, new Array(401).fill({ x: 0, y: 0 })), false);
});
