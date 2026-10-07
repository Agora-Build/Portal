import { api, sessionReady, state } from "./script.js";
import { parseMap } from "./world/map.js";
import { createEngine } from "./world/engine.js";

const root = document.querySelector("#stoa");
const canvas = document.querySelector("#stoa-canvas");
const status = document.querySelector("#stoa-status");
const roomList = document.querySelector("#stoa-rooms");
const peopleList = document.querySelector("#stoa-people");
const minimalToggle = document.querySelector("#stoa-minimal");
let remembered = null;
const stored = { get: () => { try { return localStorage.getItem("stoa-minimal"); } catch { return remembered; } }, set: (value) => { remembered = value; try { localStorage.setItem("stoa-minimal", value); } catch { /* storage unavailable; keep it for this visit */ } } };
const say = (message) => { status.textContent = message; };
const node = (tag, text, className) => { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };

// Theme tokens restyle only the Stoa section; the site header and footer keep the portal's look.
const fontStack = (name) => name ? (/\s/.test(name) ? "\"" + name + "\"" : name) + ", sans-serif" : "";
function applyUi(theme) {
  for (const [token, value] of Object.entries(theme.ui)) if (token.startsWith("--")) root.style.setProperty(token, value);
  root.style.fontFamily = fontStack(theme.ui.font);
}

const [worldResult, themesResult, spacesResult] = await Promise.allSettled([api("/api/worlds/plaza"), api("/api/themes"), api("/api/spaces")]);
const problems = [];
const failure = (result, what) => { if (result.status === "rejected") problems.push(what + " could not load" + (result.reason?.message ? " (" + result.reason.message + ")" : "") + "."); };
failure(worldResult, "The plaza map"); failure(themesResult, "Themes"); failure(spacesResult, "The room list");

let map = null, engine = null, minimal = false, preview = null;
const rooms = new Map((spacesResult.value?.rooms || []).map((room) => [room.slug, room]));
const door = (lot) => lot.door.x + ", " + lot.door.y;

try { if (worldResult.status === "fulfilled") map = parseMap(worldResult.value); } catch (error) { problems.push("The plaza map is not valid (" + error.message + ")."); }

// The room list needs only the map and /api/spaces, so it is built whether or not the canvas works.
function listRooms() {
  for (const lot of map.lots) {
    const room = rooms.get(lot.slug) || { topic: null, occupancy: 0, capacity: lot.capacity };
    const entry = node("li", "", "stoa-room");
    const go = node("button", "Go to", "button button-secondary button-small");
    go.type = "button";
    go.setAttribute("aria-label", "Walk to " + lot.title);
    go.addEventListener("click", () => {
      if (!engine) say("The plaza view isn't available, so " + lot.title + " can't be walked to. Its door is at tile " + door(lot) + ".");
      else if (engine.walkTo(lot.door)) say("Walking to " + lot.title + ".");
      else { const at = engine.position(); say(at.x === lot.door.x && at.y === lot.door.y ? "You're already at the door of " + lot.title + "." : lot.title + " can't be reached right now."); }
      canvas.focus();
    });
    entry.append(node("strong", lot.title), node("span", (room.topic || "Open") + " · " + room.occupancy + " of " + room.capacity + " here"), go);
    roomList.append(entry);
  }
}
if (map) listRooms();

if (map && themesResult.status === "fulfilled") {
  try {
    const byId = new Map(themesResult.value.themes.map((theme) => [theme.id, theme]));
    const wanted = new URLSearchParams(location.search).get("theme");
    preview = wanted !== null && byId.has(wanted) && wanted !== "agora" ? byId.get(wanted) : null;
    const chosen = preview || byId.get("agora");
    minimal = stored.get() === "true";
    const active = () => minimal ? byId.get("minimal") : chosen;
    engine = createEngine({ canvas, map, theme: active(), start: map.spawns[0], reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches });
    const plaza = map.zones.find((zone) => zone.name === "plaza");
    if (plaza) engine.setBounds({ x: Math.max(0, plaza.x - 1), y: Math.max(0, plaza.y - 1), width: Math.min(map.width, plaza.x + plaza.width + 1) - Math.max(0, plaza.x - 1), height: Math.min(map.height, plaza.y + plaza.height + 1) - Math.max(0, plaza.y - 1) });
    applyUi(active());
    minimalToggle.setAttribute("aria-pressed", String(minimal));
    minimalToggle.addEventListener("click", () => {
      minimal = !minimal;
      stored.set(String(minimal));
      minimalToggle.setAttribute("aria-pressed", String(minimal));
      applyUi(active());
      engine.setTheme(active());
    });
    new ResizeObserver(() => engine.resize()).observe(canvas);
    // Canvas text uses the web font only once it has loaded, so draw again then.
    document.fonts?.ready.then(() => engine?.resize());
    engine.setLabels(map.lots.map((lot) => ({ x: lot.door.x, y: lot.door.y - 1, text: rooms.get(lot.slug)?.topic || lot.title })));
    const doors = new Map(map.lots.map((lot) => [lot.door.x + "," + lot.door.y, lot]));
    engine.on("arrive", (tile) => { const lot = doors.get(tile.x + "," + tile.y); if (lot) say("You are at the door of " + lot.title + ". Stepping inside comes with the next update."); });
  } catch (error) {
    engine = null;
    problems.push("The plaza view could not start (" + (error.message || "unknown error") + ").");
  }
}

await sessionReady;
const name = state.profile?.name || state.account?.name || "You";
if (engine) engine.setSelf({ id: state.account?.id || state.profile?.id, name });
peopleList.replaceChildren(node("li", name + " (you)"));
if (problems.length) say(problems.join(" ") + (map && !engine ? " The rooms are listed below." : ""));
else say(minimal ? "Minimal view is on." : preview ? "Previewing the " + preview.name + " theme. Only you see it." : "You're on the plaza. Walk to a room to see who's there.");
