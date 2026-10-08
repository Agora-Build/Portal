import { api, openSignIn, sessionReady, state } from "./script.js";
import { parseMap } from "./world/map.js";
import { createEngine } from "./world/engine.js";
import { createLive } from "./world/signaling.js";
import { loadAgora } from "./world/sdk.js";
import { createPanel } from "./stoa/panel.js";
import { createStage, outsideDoor } from "./stoa/stage.js";

const root = document.querySelector("#stoa");
const canvas = document.querySelector("#stoa-canvas");
const minimalToggle = document.querySelector("#stoa-minimal");
const panel = createPanel();
let remembered = null;
const stored = { get: () => { try { return localStorage.getItem("stoa-minimal"); } catch { return remembered; } }, set: (value) => { remembered = value; try { localStorage.setItem("stoa-minimal", value); } catch { /* storage unavailable; keep it for this visit */ } } };

// Theme tokens restyle only the Stoa section; the site header and footer keep the portal's look.
const fontStack = (name) => name ? (/\s/.test(name) ? "\"" + name + "\"" : name) + ", sans-serif" : "";
function applyUi(theme) {
  for (const [token, value] of Object.entries(theme.ui)) if (token.startsWith("--")) root.style.setProperty(token, value);
  root.style.fontFamily = fontStack(theme.ui.font);
}

const [, roomSlug, spaceId] = /^\/stoa\/(?:room\/([a-z0-9-]{2,40})|s\/([a-f0-9-]{36}))?$/.exec(location.pathname) || [];
const invite = new URLSearchParams(location.search).get("invite");
const problems = [];
const failure = (result, what) => { if (result.status === "rejected") problems.push(what + " could not load" + (result.reason?.message ? " (" + result.reason.message + ")" : "") + "."); };
const [spaceResult, worldResult, themesResult, spacesResult] = await Promise.allSettled([
  spaceId ? api("/api/spaces/" + spaceId + (invite ? "?invite=" + encodeURIComponent(invite) : "")) : Promise.resolve(null),
  api("/api/worlds/" + (spaceId ? "room" : "plaza")), api("/api/themes"), spaceId ? Promise.resolve(null) : api("/api/spaces")
]);
failure(spaceResult, "This space"); failure(worldResult, "The map"); failure(themesResult, "Themes"); failure(spacesResult, "The room list");
const space = spaceResult.value?.space || null;
if (space) { document.querySelector("#stoa-title").textContent = space.title; document.title = space.title + " | Agora Build"; }

let map = null, engine = null, minimal = stored.get() === "true", preview = null, plazaBounds = null;
try { if (worldResult.status === "fulfilled") map = parseMap(worldResult.value); } catch (error) { problems.push("The map is not valid (" + error.message + ")."); }
let summaries = new Map((spacesResult.value?.rooms || []).map((room) => [room.slug, room]));
const lot = roomSlug && map ? map.lots.find((entry) => entry.slug === roomSlug) || null : null;
const labels = () => map.lots.map((entry) => ({ x: entry.door.x, y: entry.door.y - 1, text: summaries.get(entry.slug)?.topic || entry.title }));
if (map && !spaceId) panel.setRooms(map.lots, summaries);

if (map && themesResult.status === "fulfilled" && (!spaceId || space)) {
  try {
    const byId = new Map(themesResult.value.themes.map((theme) => [theme.id, theme]));
    const wanted = new URLSearchParams(location.search).get("theme");
    preview = wanted !== null && byId.has(wanted) ? byId.get(wanted) : null;
    const chosen = preview || byId.get(space?.themeId) || byId.get("agora");
    const active = () => minimal ? byId.get("minimal") : chosen;
    engine = createEngine({ canvas, map, theme: active(), start: lot ? outsideDoor(map, lot) : map.spawns[0], reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches });
    const zone = map.zones.find((entry) => entry.name === "plaza");
    if (zone && !spaceId) {
      const x = Math.max(0, zone.x - 1), y = Math.max(0, zone.y - 1);
      plazaBounds = { x, y, width: Math.min(map.width, zone.x + zone.width + 1) - x, height: Math.min(map.height, zone.y + zone.height + 1) - y };
      engine.setBounds(plazaBounds);
      engine.setLabels(labels());
    }
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
  } catch (error) {
    engine = null;
    problems.push("The view could not start (" + (error.message || "unknown error") + ").");
  }
}

await sessionReady;
const self = { id: state.account?.id || state.profile?.id || null, name: state.profile?.name || state.account?.name || "You", signedIn: Boolean(state.account || state.profile) };
panel.setPeople([], self.name);
panel.canTalk(self.signedIn);
let live = null, plazaChannel = null;
if (engine) {
  engine.setSelf({ id: self.id || undefined, name: self.name });
  try {
    const { AgoraRTM } = await loadAgora();
    live = createLive({ AgoraRTM, fetchToken: () => api("/api/signaling/token", { method: "POST", body: "{}" }), onStatus: (kind, detail) => { if (kind === "link" && detail?.currentState === "FAILED") panel.say("The live connection was lost. Reload the page to reconnect."); } });
    plazaChannel = (await live.connect()).channels?.[0]?.name || null;
  } catch (error) {
    live = null;
    problems.push(error.status === 503 ? "Live movement isn't connected yet, so you won't see other people. You can still walk and visit rooms." : "Live movement couldn't start (" + (error.message || "unknown error") + ").");
  }
  const stage = createStage({ api, map, engine, panel, live, self, plaza: spaceId ? null : { bounds: plazaBounds, channel: plazaChannel } });
  panel.on({
    go: (target) => {
      if (engine.walkTo(target.door)) panel.say("Walking to " + target.title + ".");
      else { const at = engine.position(); panel.say(at.x === target.door.x && at.y === target.door.y ? "You're already at the door of " + target.title + "." : target.title + " can't be reached right now."); }
      canvas.focus();
    },
    say: (text) => stage.say(text),
    topic: (topic, tags) => stage.setTopic(topic, tags),
    leave: () => stage.leaveRoom(),
    start: async () => { try { const created = await api("/api/spaces", { method: "POST", body: JSON.stringify({ title: self.name + "'s space" }) }); location.assign("/stoa/s/" + created.space.id); } catch (error) { panel.say(error.message); } },
    signin: () => openSignIn()
  });
  engine.on("arrive", (tile) => stage.onArrive(tile));
  addEventListener("pagehide", () => stage.unload());
  if (spaceId) await stage.openSpace(spaceId, invite);
  else {
    await stage.toPlaza(null);
    if (lot) panel.say("You're at the door of " + lot.title + ". Step in when you're ready.");
    setInterval(async () => {
      try { const listing = await stage.poll(); summaries = new Map(listing.rooms.map((room) => [room.slug, room])); panel.setRooms(map.lots, summaries); engine.setLabels(labels()); }
      catch { /* try again on the next round */ }
    }, 10000);
  }
}
if (problems.length) panel.say(problems.join(" "));
else if (!engine) panel.say("The Stoa view is not available.");
