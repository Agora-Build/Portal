// Walks are a path plus a start time; every client works out the same position, so nothing streams continuously.
export const WALK_SPEED = 5;
export const STEP = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export const KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right" };
export const direction = (from, to) => to.x > from.x ? "right" : to.x < from.x ? "left" : to.y < from.y ? "up" : "down";

export function positionAt(walk, now, speed = WALK_SPEED) {
  const steps = walk.path.length - 1;
  const travelled = Math.max(0, ((now - walk.startedAt) / 1000) * speed);
  if (steps <= 0 || travelled >= steps) {
    const last = walk.path[steps < 0 ? 0 : steps];
    return { x: last.x, y: last.y, dir: steps > 0 ? direction(walk.path[steps - 1], last) : walk.dir || "down", done: true };
  }
  const index = Math.floor(travelled), part = travelled - index, from = walk.path[index], to = walk.path[index + 1];
  return { x: from.x + (to.x - from.x) * part, y: from.y + (to.y - from.y) * part, dir: direction(from, to), done: false };
}
