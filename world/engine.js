import { findPath, validPath } from "./map.js";
import { BLOCKING_DECOR } from "./kinds.js";
import { follow, screenToTile, zoomFor } from "./camera.js";
import { KEYS, WALK_SPEED, positionAt } from "./motion.js";
import { straightPath } from "./protocol.js";
import { createCanvasRenderer } from "./renderer-canvas.js";

// Times are wall-clock (Date.now) because walk start times are published, so peers share the clock.
// One person's movement, input, camera, and drawing. Other people arrive through setOthers.
// Events: "move" { path, startedAt } for pointer walks; "walk" { from, dir, startedAt } and "stop" { at } for keyboard
// walks; "face" { dir } when a key only turns you; "arrive" { x, y } when a walk ends.
export function createEngine({ canvas, map, theme, start, reducedMotion = false, renderer = createCanvasRenderer(canvas, { map, theme }), now = () => Date.now(), raf = (callback) => requestAnimationFrame(callback), later = (callback, delay) => setTimeout(callback, delay), cancel = (handle) => clearTimeout(handle), ratio = () => globalThis.devicePixelRatio || 1 }) {
  const listeners = { arrive: [], move: [], walk: [], stop: [], face: [] };
  const self = { id: "self", name: "You", walk: { path: [start], startedAt: now(), dir: "down" }, arrived: true, keyboard: false, bubble: null };
  let current = theme, others = [], decor = [], labels = [], held = null, pending = false, timer = null, destroyed = false, interactive = true;
  let bounds = null, camera = { x: 0, y: 0, zoom: 1 }, viewport = { width: 1, height: 1 };
  const emit = (type, value) => { for (const listener of listeners[type]) listener(value); };
  const here = (time = now()) => positionAt(self.walk, time);
  const blocked = () => new Set(decor.filter((item) => BLOCKING_DECOR.has(item.kind)).map((item) => item.x + "," + item.y));
  const ambient = () => !reducedMotion && (current.effects.some((effect) => effect !== "neon-glow") || (map.roles.includes("water") && current.roles.water?.pattern === "water"));
  const sound = (other) => Boolean(other) && Boolean(other.walk) && Number.isFinite(other.walk.startedAt) && Array.isArray(other.walk.path) && other.walk.path.every((step) => step && Number.isInteger(step.x) && Number.isInteger(step.y)) && validPath(map, other.walk.path);
  const speech = (bubble, time) => bubble && bubble.until > time ? bubble.text : null;
  const inBounds = (tile) => !bounds || (tile.x >= bounds.x && tile.y >= bounds.y && tile.x < bounds.x + bounds.width && tile.y < bounds.y + bounds.height);
  const progress = (walk, time) => { const travelled = Math.max(0, ((time - walk.startedAt) / 1000) * WALK_SPEED); return { travelled, index: Math.floor(travelled), part: travelled - Math.floor(travelled) }; };
  const schedule = () => { if (!destroyed && !pending) { pending = true; raf(frame); } };

  function frame() {
    pending = false;
    if (destroyed) return;
    const time = now(), s = map.tileSize;
    const area = bounds || { x: 0, y: 0, width: map.width, height: map.height };
    const reached = here(time);
    if (reached.done && !self.arrived) { self.arrived = true; self.keyboard = false; emit("arrive", { x: reached.x, y: reached.y }); if (held) keyWalk(held); }
    const shown = here(time);
    camera = follow({ x: (shown.x + 0.5) * s, y: (shown.y + 0.5) * s }, viewport, { x: area.x * s, y: area.y * s, width: area.width * s, height: area.height * s }, zoomFor(viewport, s));
    const crowd = others.map((other) => ({ id: other.id, name: other.name, bubble: speech(other.bubble, time), ...positionAt(other.walk, time) }));
    renderer.draw({ camera, time, avatars: [{ id: self.id, name: self.name, self: true, bubble: speech(self.bubble, time), ...shown }, ...crowd], decor, labels, bounds, motion: !reducedMotion });
    const talking = [self.bubble, ...others.map((other) => other.bubble)].filter((bubble) => bubble && bubble.until > time);
    if (!shown.done || crowd.some((other) => !other.done)) schedule();
    else if (timer === null && (ambient() || talking.length)) timer = later(() => { timer = null; schedule(); }, ambient() ? 66 : Math.max(50, Math.min(...talking.map((bubble) => bubble.until - time)) + 10));
  }

  function walkTo(target) {
    const time = now(), position = here(time), walk = self.walk, avoid = blocked();
    let route;
    if (position.done && !self.arrived) { self.arrived = true; emit("arrive", { x: position.x, y: position.y }); }
    if (position.done) {
      if (target.x === position.x && target.y === position.y) return false;
      const path = findPath(map, { x: Math.round(position.x), y: Math.round(position.y) }, target, avoid);
      if (!path) return false;
      route = { path, startedAt: time };
    } else {
      // Mid-walk: keep the segment in progress so the avatar does not snap to a tile, unless that tile is now blocked.
      const { index, part } = progress(walk, time), next = walk.path[index + 1];
      if (avoid.has(next.x + "," + next.y)) {
        const path = findPath(map, walk.path[index], target, avoid);
        if (!path) return false;
        route = { path, startedAt: time };
      } else {
        const ahead = findPath(map, next, target, avoid);
        if (!ahead) return false;
        route = { path: [walk.path[index], ...ahead], startedAt: time - (part * 1000) / WALK_SPEED };
      }
    }
    self.walk = { ...route, dir: position.dir };
    self.arrived = false; self.keyboard = false;
    emit("move", route);
    schedule();
    return true;
  }

  // Keyboard walks are shared as one "walk" (straight until blocked) and one "stop", so a held key sends two messages.
  function keyWalk(dir) {
    const time = now(), position = here(time);
    if (!position.done) return;
    const from = { x: position.x, y: position.y }, path = straightPath(map, from, dir, blocked());
    if (path.length < 2) { self.walk = { path: [from], startedAt: time, dir }; emit("face", { dir }); schedule(); return; }
    self.walk = { path, startedAt: time, dir };
    self.arrived = false; self.keyboard = true;
    emit("walk", { from, dir, startedAt: time });
    schedule();
  }
  function keyStop() {
    if (!self.keyboard) return;
    self.keyboard = false;
    const walk = self.walk, index = Math.min(walk.path.length - 1, Math.ceil(progress(walk, now()).travelled)), at = walk.path[index];
    self.walk = { ...walk, path: walk.path.slice(0, index + 1) };
    emit("stop", { at: { x: at.x, y: at.y } });
    schedule();
  }

  const onPointer = (event) => {
    if (!interactive || event.button) return;
    const box = canvas.getBoundingClientRect(), tile = screenToTile(camera, event.clientX - box.left, event.clientY - box.top, map.tileSize);
    if (inBounds(tile)) walkTo(tile);
  };
  const onKeyDown = (event) => {
    const dir = KEYS[event.key];
    if (!interactive || !dir || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (held === dir) return;
    keyStop();
    held = dir;
    keyWalk(dir);
  };
  const onKeyUp = (event) => { if (KEYS[event.key] === held) { held = null; keyStop(); } };
  const onBlur = () => { held = null; keyStop(); };
  const inputs = [["pointerup", onPointer], ["keydown", onKeyDown], ["keyup", onKeyUp], ["blur", onBlur]];
  for (const [type, listener] of inputs) canvas.addEventListener(type, listener);

  const engine = {
    walkTo,
    position() { const position = here(); return { x: Math.round(position.x), y: Math.round(position.y) }; },
    facing() { return here().dir; },
    teleport(tile, dir = "down") { held = null; self.keyboard = false; self.walk = { path: [{ x: tile.x, y: tile.y }], startedAt: now(), dir }; self.arrived = true; schedule(); },
    on(type, listener) { if (!Object.hasOwn(listeners, type)) throw new Error("Unknown engine event: " + type); listeners[type].push(listener); return () => { listeners[type] = listeners[type].filter((item) => item !== listener); }; },
    say(text, ms = 8000) { self.bubble = { text: String(text), until: now() + ms }; schedule(); },
    setInteractive(value) { interactive = Boolean(value); if (!interactive) { held = null; keyStop(); } },
    setSelf({ id, name }) { if (id) self.id = id; self.name = name; schedule(); },
    setTheme(next) { current = next; renderer.setTheme(next); schedule(); },
    setBounds(rect) { bounds = rect || null; schedule(); },
    setLabels(list) { labels = list; schedule(); },
    setDecor(list) {
      decor = list;
      const time = now(), position = here(time), walk = self.walk;
      if (!position.done) {
        const avoid = blocked(), { index } = progress(walk, time);
        const hit = walk.path.findIndex((step, at) => at > index && avoid.has(step.x + "," + step.y));
        if (hit > 0 && self.keyboard) { self.keyboard = false; self.walk = { ...walk, path: walk.path.slice(0, hit) }; const at = walk.path[hit - 1]; emit("stop", { at: { x: at.x, y: at.y } }); }
        else if (hit > 0 && !walkTo(walk.path[walk.path.length - 1])) { const at = { x: walk.path[index].x, y: walk.path[index].y }; self.walk = { path: [at], startedAt: time, dir: position.dir }; emit("move", { path: [at], startedAt: time }); }
      }
      schedule();
    },
    setOthers(list) { others = list.filter(sound); schedule(); },
    resize() { viewport = { width: canvas.clientWidth || 1, height: canvas.clientHeight || 1 }; renderer.resize(viewport.width, viewport.height, ratio()); schedule(); },
    destroy() { destroyed = true; for (const [type, listener] of inputs) canvas.removeEventListener(type, listener); if (timer !== null) cancel(timer); timer = null; }
  };
  engine.resize();
  return engine;
}
