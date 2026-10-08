import { walkable } from "../world/map.js";
import { DECOR_KINDS } from "../world/kinds.js";
import { KEYS, STEP } from "../world/motion.js";

export const DECOR_LABELS = { plant: "Plant", lamp: "Lamp", rug: "Rug", sofa: "Sofa", chair: "Chair", table: "Table", whiteboard: "Whiteboard", bookshelf: "Bookshelf", screen: "Screen", banner: "Banner", poster: "Poster", statue: "Statue", fountain: "Fountain" };
const LIMIT = 60;

// The host's working copy of a room's decorations. The server checks the whole arrangement on save; this keeps edits sensible.
export function createArrangement({ map, area, items = [], makeId = () => "d" + Math.random().toString(36).slice(2, 10) }) {
  let list = items.map((item) => ({ ...item })), selected = null;
  const inside = (tile) => tile.x >= area.x && tile.y >= area.y && tile.x < area.x + area.width && tile.y < area.y + area.height;
  const free = (tile, except = null) => inside(tile) && walkable(map, tile.x, tile.y) && !list.some((item) => item !== except && item.x === tile.x && item.y === tile.y);
  const current = () => list.find((item) => item.id === selected) || null;
  const arrangement = {
    items: () => list.map((item) => ({ ...item })),
    selected: () => current() ? { ...current() } : null,
    select(id) { selected = list.some((item) => item.id === id) ? id : null; return Boolean(selected); },
    deselect() { selected = null; },
    // A click on a placed item selects it; elsewhere it moves the selected item there, or places the chosen kind.
    pick(tile, kind) {
      const hit = list.find((item) => item.x === tile.x && item.y === tile.y);
      if (hit) { selected = hit.id; return "selected"; }
      const item = current();
      if (item) { if (!free(tile, item)) return "blocked"; item.x = tile.x; item.y = tile.y; return "moved"; }
      return kind ? arrangement.place(kind, tile) : "none";
    },
    place(kind, tile) {
      if (!DECOR_KINDS.includes(kind)) return "unknown";
      if (list.length >= LIMIT) return "full";
      if (!free(tile)) return "blocked";
      const item = { id: makeId(), kind, x: tile.x, y: tile.y, rotation: 0, variant: 0 };
      list.push(item); selected = item.id;
      return "placed";
    },
    move(dir) {
      const item = current();
      if (!item) return "none";
      const [dx, dy] = STEP[dir], next = { x: item.x + dx, y: item.y + dy };
      if (!free(next, item)) return "blocked";
      item.x = next.x; item.y = next.y;
      return "moved";
    },
    rotate() { const item = current(); if (!item) return "none"; item.rotation = (item.rotation + 90) % 360; return "rotated"; },
    remove() { const item = current(); if (!item) return "none"; list = list.filter((entry) => entry !== item); selected = null; return "removed"; }
  };
  return arrangement;
}

const OUTCOMES = { blocked: "That tile is taken, blocked, or outside the room.", full: "A room holds up to 60 decorations.", none: "Choose a decoration first, or select one on the map." };
// Decor mode: the map picks tiles instead of walking, and the panel lists every item for keyboard and screen reader users.
export function createDecorEditor({ doc = document, canvas, engine, map, onSave = async () => false, onClose = () => {}, say = () => {} }) {
  const $ = (selector) => doc.querySelector(selector);
  const section = $("#stoa-decor"), palette = $("#stoa-palette"), list = $("#stoa-decor-list"), save = $("#stoa-decor-save");
  let arrangement = null, original = [], kind = null;
  const describe = (item) => DECOR_LABELS[item.kind] + " at " + item.x + ", " + item.y + (item.rotation ? ", turned " + item.rotation + "°" : "");
  const kindButtons = DECOR_KINDS.map((entry) => {
    const button = doc.createElement("button");
    button.type = "button"; button.className = "button button-secondary button-small"; button.textContent = DECOR_LABELS[entry];
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => { kind = kind === entry ? null : entry; arrangement?.deselect(); render(); });
    palette.append(button);
    return [entry, button];
  });
  function render() {
    if (!arrangement) return;
    engine.setDecor(arrangement.items());
    for (const [entry, button] of kindButtons) button.setAttribute("aria-pressed", String(kind === entry));
    const chosen = arrangement.selected();
    list.replaceChildren(...arrangement.items().map((item) => {
      const row = doc.createElement("li"), button = doc.createElement("button");
      button.type = "button"; button.textContent = describe(item);
      if (chosen?.id === item.id) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => { arrangement.select(item.id); render(); canvas.focus(); });
      row.append(button);
      return row;
    }));
    $("#stoa-decor-selected").textContent = chosen ? "Selected: " + describe(chosen) + ". Arrow keys move it, R turns it, Delete removes it." : kind ? "Click the map to place a " + DECOR_LABELS[kind].toLowerCase() + "." : "Choose a decoration, or select one to move it.";
  }
  const report = (outcome) => { if (OUTCOMES[outcome]) say(OUTCOMES[outcome]); render(); };
  const onKey = (event) => {
    if (!arrangement || event.ctrlKey || event.metaKey || event.altKey) return;
    const dir = KEYS[event.key];
    if (dir) { event.preventDefault(); report(arrangement.move(dir)); }
    else if (event.key === "r" || event.key === "R") { event.preventDefault(); report(arrangement.rotate()); }
    else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); report(arrangement.remove()); }
    else if (event.key === "Escape") { arrangement.deselect(); kind = null; render(); }
  };
  function finish(restore) {
    if (!arrangement) return;
    canvas.removeEventListener("keydown", onKey);
    engine.setPicking(null);
    engine.setInteractive(true);
    if (restore) engine.setDecor(original);
    arrangement = null; kind = null;
    section.hidden = true;
    onClose();
  }
  $("#stoa-decor-here").addEventListener("click", () => {
    if (!arrangement) return;
    const at = engine.position(), [dx, dy] = STEP[engine.facing()] || [0, 1];
    report(kind ? arrangement.place(kind, { x: at.x + dx, y: at.y + dy }) : "none");
  });
  save.addEventListener("click", async () => {
    if (!arrangement) return;
    save.disabled = true;
    try { if (await onSave(arrangement.items())) finish(false); } finally { save.disabled = false; }
  });
  $("#stoa-decor-cancel").addEventListener("click", () => finish(true));
  return {
    open({ items = [], area }) {
      if (arrangement) return;
      original = items.map((item) => ({ ...item }));
      arrangement = createArrangement({ map, area: area || { x: 0, y: 0, width: map.width, height: map.height }, items: original });
      engine.setInteractive(false);
      engine.setPicking((tile) => report(arrangement.pick(tile, kind)));
      canvas.addEventListener("keydown", onKey);
      section.hidden = false;
      render();
    },
    close: () => finish(true),
    abort: () => finish(false),
    isOpen: () => Boolean(arrangement)
  };
}
