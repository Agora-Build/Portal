import { findPath, walkable } from "./map.js";
import { BLOCKING_DECOR } from "./kinds.js";
import { follow, screenToTile, zoomFor } from "./camera.js";
import { KEYS, STEP, WALK_SPEED, positionAt } from "./motion.js";
import { createCanvasRenderer } from "./renderer-canvas.js";

// Times are wall-clock (Date.now) because move.startedAt is published, so peers share the clock.
// One person's movement, input, camera, and drawing. Other people arrive through setOthers; "move" events go out to them.
export function createEngine({ canvas, map, theme, start, reducedMotion = false, renderer = createCanvasRenderer(canvas, { map, theme }), now = () => Date.now(), raf = (callback) => requestAnimationFrame(callback), later = (callback, delay) => setTimeout(callback, delay), cancel = (handle) => clearTimeout(handle), ratio = () => globalThis.devicePixelRatio || 1 }) {
  const listeners = { arrive: [], move: [] };
  const self = { id: "self", name: "You", walk: { path: [start], startedAt: now(), dir: "down" }, arrived: true };
  let current = theme, others = [], decor = [], labels = [], held = null, pending = false, timer = null, destroyed = false;
  let camera = { x: 0, y: 0, zoom: 1 }, viewport = { width: 1, height: 1 };
  const emit = (type, value) => { for (const listener of listeners[type]) listener(value); };
  const here = (time = now()) => positionAt(self.walk, time);
  const blocked = () => new Set(decor.filter((item) => BLOCKING_DECOR.has(item.kind)).map((item) => item.x + "," + item.y));
  const ambient = () => !reducedMotion && (current.effects.some((effect) => effect !== "neon-glow") || map.roles.includes("water"));
  const schedule = () => { if (!destroyed && !pending) { pending = true; raf(frame); } };

  function frame() {
    pending = false;
    if (destroyed) return;
    const time = now(), s = map.tileSize;
    const reached = here(time);
    if (reached.done && !self.arrived) { self.arrived = true; emit("arrive", { x: reached.x, y: reached.y }); if (held) step(held); }
    const shown = here(time);
    camera = follow({ x: (shown.x + 0.5) * s, y: (shown.y + 0.5) * s }, viewport, { width: map.width * s, height: map.height * s }, zoomFor(viewport, s));
    const crowd = others.map((other) => ({ id: other.id, name: other.name, ...positionAt(other.walk, time) }));
    renderer.draw({ camera, time, avatars: [{ id: self.id, name: self.name, self: true, ...shown }, ...crowd], decor, labels, motion: !reducedMotion });
    if (!shown.done || crowd.some((other) => !other.done)) schedule();
    else if (ambient() && timer === null) timer = later(() => { timer = null; schedule(); }, 66);
  }

  function walkTo(target) {
    const time = now(), position = here(time), walk = self.walk;
    let route;
    if (position.done) {
      const path = findPath(map, { x: Math.round(position.x), y: Math.round(position.y) }, target, blocked());
      if (!path) return false;
      route = { path, startedAt: time };
    } else {
      // Mid-walk: keep the segment in progress so the avatar does not snap to a tile.
      const travelled = ((time - walk.startedAt) / 1000) * WALK_SPEED, index = Math.floor(travelled), part = travelled - index;
      const ahead = findPath(map, walk.path[index + 1], target, blocked());
      if (!ahead) return false;
      route = { path: [walk.path[index], ...ahead], startedAt: time - (part * 1000) / WALK_SPEED };
    }
    self.walk = { ...route, dir: position.dir };
    self.arrived = false;
    emit("move", route);
    schedule();
    return true;
  }

  function step(dir) {
    const position = here();
    if (!position.done) return;
    const [dx, dy] = STEP[dir], target = { x: position.x + dx, y: position.y + dy };
    if (walkable(map, target.x, target.y, blocked())) walkTo(target);
    else { self.walk = { path: [{ x: position.x, y: position.y }], startedAt: now(), dir }; schedule(); }
  }

  const onPointer = (event) => {
    if (event.button) return;
    const bounds = canvas.getBoundingClientRect();
    walkTo(screenToTile(camera, event.clientX - bounds.left, event.clientY - bounds.top, map.tileSize));
  };
  const onKeyDown = (event) => {
    const dir = KEYS[event.key];
    if (!dir || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (held === dir) return;
    held = dir;
    step(dir);
  };
  const onKeyUp = (event) => { if (!event.ctrlKey && !event.metaKey && !event.altKey && KEYS[event.key] === held) held = null; };
  const onBlur = () => { held = null; };
  const inputs = [["pointerup", onPointer], ["keydown", onKeyDown], ["keyup", onKeyUp], ["blur", onBlur]];
  for (const [type, listener] of inputs) canvas.addEventListener(type, listener);

  const engine = {
    walkTo,
    position() { const position = here(); return { x: Math.round(position.x), y: Math.round(position.y) }; },
    on(type, listener) { listeners[type].push(listener); return () => { listeners[type] = listeners[type].filter((item) => item !== listener); }; },
    setSelf({ name }) { self.name = name; schedule(); },
    setTheme(next) { current = next; renderer.setTheme(next); schedule(); },
    setLabels(list) { labels = list; schedule(); },
    setDecor(list) { decor = list; schedule(); },
    setOthers(list) { others = list; schedule(); },
    resize() { viewport = { width: canvas.clientWidth || 1, height: canvas.clientHeight || 1 }; renderer.resize(viewport.width, viewport.height, ratio()); schedule(); },
    destroy() { destroyed = true; for (const [type, listener] of inputs) canvas.removeEventListener(type, listener); if (timer !== null) cancel(timer); timer = null; }
  };
  engine.resize();
  return engine;
}
