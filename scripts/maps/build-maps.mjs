// Generates the built-in Tiled-compatible worlds. Designers may replace the JSON with maps edited in Tiled.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_ROLES } from "../../world/map.js";

const SIZE = 32;
const prop = (values) => Object.entries(values).map(([name, value]) => ({ name, type: typeof value === "number" ? "int" : typeof value === "boolean" ? "bool" : "string", value }));
const blank = (width, height, role) => Array.from({ length: height }, () => new Array(width).fill(role));
const fill = (grid, x, y, width, height, role) => { for (let row = y; row < y + height; row += 1) for (let column = x; column < x + width; column += 1) grid[row][column] = role; };

export function tiled(id, grid, objects, under = null) {
  const height = grid.length, width = grid[0].length, gid = (role) => CORE_ROLES.indexOf(role) + 1;
  const ground = [], structure = [];
  grid.forEach((row, y) => row.forEach((role, x) => {
    const base = ["water", "grass", "path"].includes(role) ? role : under ? under[y][x] : "floor";
    ground.push(gid(base)); structure.push(role === base ? 0 : gid(role));
  }));
  let next = 1;
  const group = (name, list) => ({ type: "objectgroup", name, objects: list.map(({ x, y, width: w = 0, height: h = 0, name: label = "", ...rest }) => ({ id: next++, name: label, x: x * SIZE, y: y * SIZE, width: w * SIZE, height: h * SIZE, point: !w && !h, properties: prop(rest) })) });
  const layers = [{ type: "tilelayer", name: "ground", width, height, data: ground }, { type: "tilelayer", name: "structure", width, height, data: structure }, ...Object.entries(objects).map(([name, list]) => group(name, list))];
  return { type: "map", version: "1.10", tiledversion: "1.10.2", orientation: "orthogonal", renderorder: "right-down", width, height, tilewidth: SIZE, tileheight: SIZE, infinite: false, nextobjectid: next, properties: prop({ id }), tilesets: [{ firstgid: 1, name: "roles", tilewidth: SIZE, tileheight: SIZE, tilecount: CORE_ROLES.length, columns: 0, tiles: CORE_ROLES.map((role, index) => ({ id: index, properties: prop({ role }) })) }], layers };
}

export const LOTS = [
  { lotId: "agents", slug: "ai-agents", title: "AI agents", capacity: 8 },
  { lotId: "voice", slug: "voice-ai", title: "Voice AI", capacity: 8 },
  { lotId: "rtc", slug: "rtc-lab", title: "RTC lab", capacity: 6 },
  { lotId: "founders", slug: "founders-table", title: "Founders' table", capacity: 6 },
  { lotId: "oss", slug: "open-source", title: "Open source", capacity: 10 },
  { lotId: "lounge", slug: "lounge", title: "The lounge", capacity: 12 }
];
// Four facades face down from the top edge of the plaza and two face up from the bottom.
const FACADES = [{ x: 2, y: 2, top: true }, { x: 10, y: 2, top: true }, { x: 27, y: 2, top: true }, { x: 35, y: 2, top: true }, { x: 6, y: 14, top: false }, { x: 29, y: 14, top: false }];

export function plaza() {
  const grid = blank(44, 34, "wall");
  fill(grid, 1, 1, 42, 18, "grass");
  fill(grid, 1, 9, 42, 2, "path"); fill(grid, 21, 1, 2, 18, "path");
  fill(grid, 17, 6, 10, 8, "path"); fill(grid, 19, 8, 6, 4, "water");
  const under = blank(44, 34, "floor");
  fill(under, 1, 1, 42, 18, "grass");
  fill(under, 1, 9, 42, 2, "path"); fill(under, 21, 1, 2, 18, "path");
  fill(under, 17, 6, 10, 8, "path"); fill(under, 19, 8, 6, 4, "water");
  for (const [x, y] of [[17, 6], [26, 6], [17, 13], [26, 13]]) grid[y][x] = "column";
  for (const [x, y] of [[20, 7], [23, 7], [20, 12], [23, 12]]) grid[y][x] = "seat";
  for (const [x, y] of [[5, 8], [38, 8], [5, 11], [38, 11]]) grid[y][x] = "plant";
  const lots = LOTS.map((lot, index) => {
    const facade = FACADES[index], door = { x: facade.x + 3, y: facade.top ? facade.y + 3 : facade.y };
    fill(grid, facade.x, facade.y, 7, 4, "wall");
    grid[door.y][door.x] = "door";
    const x0 = 1 + index * 7;
    fill(grid, x0, 21, 6, 12, "floor");
    fill(grid, x0 + 2, 25, 2, 3, "table");
    for (let y = 25; y < 28; y += 1) { grid[y][x0 + 1] = "seat"; grid[y][x0 + 4] = "seat"; }
    grid[21][x0] = "plant"; grid[21][x0 + 5] = "plant";
    grid[32][x0 + 2] = "door";
    return { ...lot, x: x0, y: 21, width: 6, height: 12, doorX: door.x, doorY: door.y, entryX: x0 + 2, entryY: 31 };
  });
  return tiled("plaza", grid, {
    lot: lots,
    spawn: [{ x: 21, y: 17 }, { x: 22, y: 17 }],
    zone: [{ name: "plaza", x: 1, y: 1, width: 42, height: 18 }, { name: "fountain", x: 17, y: 6, width: 10, height: 8 }],
    interactable: [
      { x: 12, y: 8, id: "collaborators", kind: "noticeboard", label: "Looking for collaborators", query: "collaborators" },
      { x: 31, y: 8, id: "voice-ai", kind: "noticeboard", label: "Voice AI", query: "voice ai" },
      { x: 25, y: 16, id: "offers", kind: "noticeboard", label: "Offers", query: "offers" }
    ]
  }, under);
}

export function room() {
  const grid = blank(20, 14, "wall");
  fill(grid, 1, 1, 18, 12, "floor");
  fill(grid, 8, 5, 4, 3, "table");
  for (let x = 8; x < 12; x += 1) { grid[4][x] = "seat"; grid[8][x] = "seat"; }
  for (const [x, y] of [[1, 1], [18, 1], [1, 12], [18, 12]]) grid[y][x] = "plant";
  return tiled("room", grid, { spawn: [{ x: 9, y: 11 }, { x: 10, y: 11 }], zone: [{ name: "room", x: 1, y: 1, width: 18, height: 12 }] });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = new URL("../../", import.meta.url);
  for (const [id, map] of [["plaza", plaza()], ["room", room()]]) {
    await mkdir(new URL("worlds/" + id + "/", root), { recursive: true });
    await writeFile(new URL("worlds/" + id + "/map.json", root), JSON.stringify(map) + "\n");
  }
  console.log("Wrote worlds/plaza/map.json and worlds/room/map.json.");
}
