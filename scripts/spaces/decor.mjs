import { AppError } from "../store.mjs";
import { reachable, roleAt, walkable } from "../../world/map.js";
import { DECOR_KINDS } from "./model.mjs";

// Decorations are semantic kinds; the theme draws them. Blocking kinds must never cut people off.
export const BLOCKING_DECOR = new Set(["sofa", "table", "whiteboard", "bookshelf", "statue", "fountain"]);
export const DECOR_LIMIT = 60;
const tilesIn = (map, area, role) => { const tiles = []; for (let y = area.y; y < area.y + area.height; y += 1) for (let x = area.x; x < area.x + area.width; x += 1) if (roleAt(map, x, y) === role) tiles.push({ x, y }); return tiles; };

function region(map, space) {
  if (!space.lot) {
    const area = { x: 0, y: 0, width: map.width, height: map.height };
    return { area, start: map.spawns[0], protect: [...map.spawns, ...tilesIn(map, area, "door")] };
  }
  const lot = map.lots.find((entry) => entry.lotId === space.lot.lotId);
  return { area: lot.interior, start: lot.entry, protect: [lot.entry, ...tilesIn(map, lot.interior, "door")] };
}

export function validateDecor(items, map, space) {
  if (!Array.isArray(items) || items.length > DECOR_LIMIT) throw new AppError(422, "Place up to 60 decorations.");
  const { area, start, protect } = region(map, space);
  const protectedTiles = new Set(protect.map(({ x, y }) => x + "," + y));
  const used = new Set();
  const clean = items.map((item) => {
    const { id, kind, x, y, rotation = 0, variant = 0 } = item && typeof item === "object" ? item : {};
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new AppError(422, "Each decoration needs a short ID.");
    if (!DECOR_KINDS.includes(kind)) throw new AppError(422, "Choose a known decoration.");
    if (![0, 90, 180, 270].includes(rotation) || !Number.isInteger(variant) || variant < 0 || variant > 7) throw new AppError(422, "This decoration's rotation or style is not available.");
    if (!walkable(map, x, y) || x < area.x || y < area.y || x >= area.x + area.width || y >= area.y + area.height) throw new AppError(422, "Place decorations on open floor inside the room.");
    if (protectedTiles.has(x + "," + y)) throw new AppError(422, "Keep doors and entrances clear.");
    if (used.has(x + "," + y)) throw new AppError(422, "Only one decoration fits on each tile.");
    used.add(x + "," + y);
    return { id, kind, x, y, rotation, variant };
  });
  const open = reachable(map, start, new Set(clean.filter((item) => BLOCKING_DECOR.has(item.kind)).map((item) => item.x + "," + item.y)));
  if ([...protect, ...tilesIn(map, area, "seat")].some(({ x, y }) => !open.has(x + "," + y))) throw new AppError(422, "Keep every door, entrance, and seat reachable.");
  return clean;
}
