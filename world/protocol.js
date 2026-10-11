import { validPath, walkable } from "./map.js";
import { STEP } from "./motion.js";

// The live protocol on a space channel: what clients publish, what receivers accept, and how keyboard walks are shared.
export const MESSAGE_LIMIT = 8192;
export const TEXT_LIMIT = 500;
export const SKEW_LIMIT = 2000;
export const STRAIGHT_LIMIT = 40;
const DIRS = Object.keys(STEP);
const isTile = (value) => Boolean(value) && Number.isInteger(value.x) && Number.isInteger(value.y);
const copy = ({ x, y }) => ({ x, y });

export const actorFromUser = (userId) => /^a-[a-f0-9-]{36}$/.test(userId || "") ? "account:" + userId.slice(2) : /^m-[a-f0-9-]{36}$/.test(userId || "") ? "member:" + userId.slice(2) : null;

export function readMessage(text, map) {
  if (typeof text !== "string" || text.length > MESSAGE_LIMIT) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  switch (data.t) {
    case "move": return Array.isArray(data.path) && data.path.every(isTile) && validPath(map, data.path) && Number.isFinite(data.startedAt) ? { t: "move", path: data.path.map(copy), startedAt: data.startedAt } : null;
    case "walk": return isTile(data.from) && walkable(map, data.from.x, data.from.y) && DIRS.includes(data.dir) && Number.isFinite(data.startedAt) ? { t: "walk", from: copy(data.from), dir: data.dir, startedAt: data.startedAt } : null;
    case "stop": return isTile(data.at) && walkable(map, data.at.x, data.at.y) ? { t: "stop", at: copy(data.at) } : null;
    case "face": return DIRS.includes(data.dir) && isTile(data.at) && walkable(map, data.at.x, data.at.y) ? { t: "face", dir: data.dir, at: copy(data.at) } : null;
    case "say": { const say = typeof data.text === "string" ? data.text.trim() : ""; return say && data.text.length <= TEXT_LIMIT ? { t: "say", text: say } : null; }
    case "refresh": return { t: "refresh" };
    case "decor": return Number.isInteger(data.version) && data.version > 0 ? { t: "decor", version: data.version } : null;
    case "rekey": return { t: "rekey" };
    default: return null;
  }
}
export const writeMessage = (message) => JSON.stringify(message);

export const writeState = ({ x, y, dir, name }) => ({ x: String(x), y: String(y), dir: String(dir), name: String(name).slice(0, 60) });
export function readState(states, map) {
  if (!states || typeof states !== "object") return null;
  const x = Number(states.x), y = Number(states.y);
  if (states.x === undefined || states.y === undefined || !Number.isInteger(x) || !Number.isInteger(y) || !walkable(map, x, y)) return null;
  const name = typeof states.name === "string" ? states.name.trim().slice(0, 60) : "";
  return { x, y, dir: DIRS.includes(states.dir) ? states.dir : "down", name: name || "Builder" };
}

export const trusted = (publisher, { self, present, blocked }) => typeof publisher === "string" && publisher !== self && !publisher.startsWith("g-") && present.has(publisher) && !blocked.has(actorFromUser(publisher));

export function straightPath(map, from, dir, extra = new Set(), limit = STRAIGHT_LIMIT) {
  const [dx, dy] = STEP[dir], path = [copy(from)];
  while (path.length <= limit) {
    const last = path[path.length - 1], next = { x: last.x + dx, y: last.y + dy };
    if (!walkable(map, next.x, next.y, extra)) break;
    path.push(next);
  }
  return path;
}
export function stopAt(walk, at) {
  const index = walk.path.findIndex((step) => step.x === at.x && step.y === at.y);
  return index < 0 ? null : { ...walk, path: walk.path.slice(0, index + 1) };
}
export const shared = (startedAt, now) => Math.abs(startedAt - now) > SKEW_LIMIT ? now : startedAt;

export function createLimiter({ perSecond, burst = perSecond, now = () => Date.now(), later = (callback, delay) => setTimeout(callback, delay) }) {
  let tokens = burst, last = now(), waiting = null, timer = null;
  const refill = () => { const time = now(); tokens = Math.min(burst, tokens + ((time - last) / 1000) * perSecond); last = time; };
  const wait = () => Math.ceil(((1 - tokens) / perSecond) * 1000);
  function flush() {
    timer = null; refill();
    if (waiting && tokens >= 1) { tokens -= 1; const action = waiting; waiting = null; action(); }
    else if (waiting) timer = later(flush, wait());
  }
  return {
    send(action, { latest = false } = {}) {
      refill();
      if (!waiting && tokens >= 1) { tokens -= 1; action(); return true; }
      if (!latest) return false;
      waiting = action;
      if (timer === null) timer = later(flush, wait());
      return true;
    }
  };
}
