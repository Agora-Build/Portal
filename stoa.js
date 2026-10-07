import { api, sessionReady, state } from "./script.js";
import { parseMap } from "./world/map.js";
import { createEngine } from "./world/engine.js";

const root = document.querySelector("#stoa");
const canvas = document.querySelector("#stoa-canvas");
const status = document.querySelector("#stoa-status");
const roomList = document.querySelector("#stoa-rooms");
const peopleList = document.querySelector("#stoa-people");
const minimalToggle = document.querySelector("#stoa-minimal");
const say = (message) => { status.textContent = message; };
const node = (tag, text, className) => { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };

// Theme tokens restyle only the Stoa section; the site header and footer keep the portal's look.
function applyUi(theme) {
  for (const [token, value] of Object.entries(theme.ui)) if (token.startsWith("--")) root.style.setProperty(token, value);
  root.style.fontFamily = theme.ui.font ? "\"" + theme.ui.font + "\", sans-serif" : "";
}

try {
  const [source, { themes }, listing] = await Promise.all([api("/api/worlds/plaza"), api("/api/themes"), api("/api/spaces")]);
  const map = parseMap(source);
  const byId = Object.fromEntries(themes.map((theme) => [theme.id, theme]));
  const preview = byId[new URLSearchParams(location.search).get("theme")];
  const chosen = preview || byId.agora;
  let minimal = localStorage.getItem("stoa-minimal") === "true";
  const active = () => minimal ? byId.minimal : chosen;
  const engine = createEngine({ canvas, map, theme: active(), start: map.spawns[0], reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches });
  applyUi(active());
  minimalToggle.setAttribute("aria-pressed", String(minimal));
  minimalToggle.addEventListener("click", () => {
    minimal = !minimal;
    localStorage.setItem("stoa-minimal", String(minimal));
    minimalToggle.setAttribute("aria-pressed", String(minimal));
    applyUi(active());
    engine.setTheme(active());
  });
  new ResizeObserver(() => engine.resize()).observe(canvas);

  const rooms = new Map(listing.rooms.map((room) => [room.slug, room]));
  engine.setLabels(map.lots.map((lot) => ({ x: lot.door.x, y: lot.door.y - 1, text: rooms.get(lot.slug)?.topic || lot.title })));
  for (const lot of map.lots) {
    const room = rooms.get(lot.slug) || { topic: null, occupancy: 0, capacity: lot.capacity };
    const entry = node("li", "", "stoa-room");
    const go = node("button", "Go to", "button button-secondary button-small");
    go.type = "button";
    go.setAttribute("aria-label", "Walk to " + lot.title);
    go.addEventListener("click", () => { if (engine.walkTo(lot.door)) say("Walking to " + lot.title + "."); canvas.focus(); });
    entry.append(node("strong", lot.title), node("span", (room.topic || "Open") + " · " + room.occupancy + " of " + room.capacity + " here"), go);
    roomList.append(entry);
  }
  const doors = new Map(map.lots.map((lot) => [lot.door.x + "," + lot.door.y, lot]));
  engine.on("arrive", (tile) => { const lot = doors.get(tile.x + "," + tile.y); if (lot) say("You are at the door of " + lot.title + ". Stepping inside comes with the next update."); });

  await sessionReady;
  const name = state.profile?.name || state.account?.name || "You";
  engine.setSelf({ name });
  peopleList.replaceChildren(node("li", name + " (you)"));
  say(preview ? "Previewing the " + preview.name + " theme. Only you see it." : "You're on the plaza. Walk to a room to see who's there.");
} catch (error) {
  say(error.message || "The plaza could not open. Please try again.");
}
