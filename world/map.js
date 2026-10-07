// Shared by the browser engine and the server: maps describe purpose (roles), never artwork.
export const CORE_ROLES = ["floor", "path", "grass", "water", "wall", "column", "door", "table", "seat", "plant", "decor"];
const BLOCKING = new Set(["wall", "column", "water", "table", "plant"]);
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const props = (entry) => Object.fromEntries((entry?.properties || []).map((property) => [property.name, property.value]));

export function parseMap(source) {
  const { width, height, tilewidth: size } = source || {};
  if (source?.orientation !== "orthogonal" || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 200 || height > 200 || !Number.isInteger(size) || size !== source.tileheight) throw new Error("Unsupported map.");
  const tiles = new Map();
  for (const tileset of source.tilesets || []) for (const tile of tileset.tiles || []) tiles.set(tileset.firstgid + tile.id, props(tile));
  const roles = new Array(width * height).fill(null);
  const blocked = new Uint8Array(width * height);
  for (const name of ["ground", "structure"]) {
    const data = source.layers.find((layer) => layer.type === "tilelayer" && layer.name === name)?.data;
    if (!data) continue;
    if (data.length !== width * height) throw new Error("Layer " + name + " has the wrong size.");
    data.forEach((gid, index) => {
      if (!gid) return;
      const tile = tiles.get(gid);
      if (!tile || !CORE_ROLES.includes(tile.role)) throw new Error("Unknown tile " + gid + ".");
      roles[index] = tile.role;
      blocked[index] = (tile.walkable === undefined ? BLOCKING.has(tile.role) : !tile.walkable) ? 1 : 0;
    });
  }
  roles.forEach((role, index) => { if (!role) blocked[index] = 1; });
  const objects = (name) => (source.layers.find((layer) => layer.type === "objectgroup" && layer.name === name)?.objects || []).map((object) => ({ name: object.name, ...props(object), x: Math.floor(object.x / size), y: Math.floor(object.y / size), width: Math.round((object.width || 0) / size), height: Math.round((object.height || 0) / size) }));
  return {
    id: props(source).id, width, height, tileSize: size, roles, blocked,
    lots: objects("lot").map((lot) => ({ lotId: lot.lotId, slug: lot.slug, title: lot.title, capacity: lot.capacity, door: { x: lot.doorX, y: lot.doorY }, entry: { x: lot.entryX, y: lot.entryY }, interior: { x: lot.x, y: lot.y, width: lot.width, height: lot.height } })),
    spawns: objects("spawn").map(({ x, y }) => ({ x, y })),
    zones: objects("zone").map(({ name, x, y, width: w, height: h }) => ({ name, x, y, width: w, height: h })),
    interactables: objects("interactable").map(({ id, kind, label, query, x, y }) => ({ id, kind, label, query, x, y }))
  };
}

export const inside = (map, x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.width && y < map.height;
export const roleAt = (map, x, y) => inside(map, x, y) ? map.roles[y * map.width + x] : null;
export const walkable = (map, x, y, extra = new Set()) => inside(map, x, y) && !map.blocked[y * map.width + x] && !extra.has(x + "," + y);

export function findPath(map, from, to, extra = new Set()) {
  if (!inside(map, from.x, from.y) || !walkable(map, to.x, to.y, extra)) return null;
  const key = (x, y) => y * map.width + x;
  const start = key(from.x, from.y), goal = key(to.x, to.y);
  const came = new Map(), cost = new Map([[start, 0]]);
  const open = [[Math.abs(from.x - to.x) + Math.abs(from.y - to.y), start]];
  while (open.length) {
    let best = 0;
    for (let index = 1; index < open.length; index += 1) if (open[index][0] < open[best][0]) best = index;
    const [, current] = open.splice(best, 1)[0];
    if (current === goal) {
      const path = [];
      for (let node = goal; node !== undefined; node = came.get(node)) path.unshift({ x: node % map.width, y: Math.floor(node / map.width) });
      return path;
    }
    const x = current % map.width, y = Math.floor(current / map.width);
    for (const [dx, dy] of STEPS) {
      const nx = x + dx, ny = y + dy;
      if (!walkable(map, nx, ny, extra)) continue;
      const next = key(nx, ny), score = cost.get(current) + 1;
      if (score >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, score); came.set(next, current);
      open.push([score + Math.abs(nx - to.x) + Math.abs(ny - to.y), next]);
    }
  }
  return null;
}

export function reachable(map, start, extra = new Set()) {
  const seen = new Set([start.x + "," + start.y]), queue = [start];
  while (queue.length) {
    const { x, y } = queue.shift();
    for (const [dx, dy] of STEPS) {
      const nx = x + dx, ny = y + dy, id = nx + "," + ny;
      if (!seen.has(id) && walkable(map, nx, ny, extra)) { seen.add(id); queue.push({ x: nx, y: ny }); }
    }
  }
  return seen;
}

export const validPath = (map, path, extra = new Set()) => Array.isArray(path) && path.length > 0 && path.length <= 400 && path.every((step, index) => step && walkable(map, step.x, step.y, extra) && (index === 0 || Math.abs(step.x - path[index - 1].x) + Math.abs(step.y - path[index - 1].y) === 1));
