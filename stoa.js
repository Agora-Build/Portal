import { api, openSignIn, sessionReady, state } from "./script.js";
import { parseMap } from "./world/map.js";
import { createEngine } from "./world/engine.js";
import { createLive } from "./world/signaling.js";
import { loadAgora } from "./world/sdk.js";
import { createPanel } from "./stoa/panel.js";
import { createCallView } from "./stoa/call.js";
import { createDecorEditor } from "./stoa/decor.js";
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

let map = null, engine = null, minimal = stored.get() === "true", preview = null, plazaBounds = null, active = () => null, call = null, decor = null;
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
    active = () => minimal ? byId.get("minimal") : chosen;
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
      call?.setLayout(active().video);
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
const self = { id: state.account?.id || state.profile?.id || null, ids: [state.account?.id, state.profile?.id].filter(Boolean), name: state.profile?.name || state.account?.name || "You", signedIn: Boolean(state.account || state.profile) };
panel.setPeople([], self.name);
panel.canTalk(self.signedIn);
let live = null, stage = null;
const unavailable = "The Stoa view isn't available, so there's nothing to walk or talk in.";
// Controls work even without the canvas: Go to explains where the door is, Sign in and Start a space still do their jobs.
panel.on({
  go: (target) => {
    if (!stage) { panel.say(unavailable + " " + target.title + " is at the door tile (" + target.door.x + ", " + target.door.y + ")."); return; }
    const notice = stage.watchNotice(target);
    if (notice) panel.say(notice);
    else if (engine.walkTo(target.door)) panel.say("Walking to " + target.title + ".");
    else { const at = engine.position(); panel.say(at.x === target.door.x && at.y === target.door.y ? "You're already at the door of " + target.title + "." : target.title + " can't be reached right now."); }
    canvas.focus();
  },
  say: (text) => stage ? stage.say(text) : (panel.say(unavailable), false),
  topic: (topic, tags) => stage?.setTopic(topic, tags),
  leave: () => stage?.leaveRoom(),
  decorate: () => {
    if (!stage?.canManage()) { panel.say("Only the host can decorate."); return; }
    stage.setEditing(true);
    decor?.open({ items: stage.decor(), ...stage.decorRegion() });
    panel.decorating(decor?.isOpen());
    panel.say("Decor mode is on. Choose a decoration, then click the map or use Place in front of me.");
    canvas.focus();
  },
  start: async () => { try { const created = await api("/api/spaces", { method: "POST", body: JSON.stringify({ title: self.name + "'s space" }) }); location.assign("/stoa/s/" + created.space.id); } catch (error) { panel.say(error.message); } },
  signin: () => openSignIn()
});
// Signaling loads and connects in the background: the page is already usable, and the stage picks the connection up when it is ready.
async function connectLive() {
  let candidate = null, timer = null, abandoned = false, connecting = null;
  try {
    connecting = (async () => {
      const { AgoraRTM } = await loadAgora();
      candidate = createLive({
        AgoraRTM,
        fetchToken: () => api("/api/signaling/token", { method: "POST", body: "{}" }),
        onStatus: (kind, detail) => {
          if (kind === "duplicate") panel.say("You opened the Stoa in another tab; live movement continues there.");
          else if (kind === "link" && detail?.currentState === "FAILED") panel.say("The live connection was lost. Reload the page to reconnect.");
        }
      });
      return (await candidate.connect()).channels?.[0]?.name || null;
    })();
    const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => { abandoned = true; reject(Object.assign(new Error("Live movement is taking too long to connect."), { timedOut: true })); }, 10000); });
    const channel = await Promise.race([connecting, timeout]);
    clearTimeout(timer);
    live = candidate;
    await stage.attachLive(live, channel);
  } catch (error) {
    clearTimeout(timer);
    // A connection that finishes after the timeout is closed again rather than left running unattached.
    if (abandoned) connecting?.then(() => candidate?.close(), () => {}).catch(() => {});
    else candidate?.close().catch(() => {});
    live = null;
    panel.say(error.status === 503 ? "Live movement isn't connected yet, so you won't see other people. You can still walk and visit rooms." : error.timedOut ? error.message : "Live movement couldn't start (" + (error.message || "unknown error") + ").");
  }
}
if (engine) {
  engine.setSelf({ id: self.id || undefined, name: self.name });
  call = createCallView({ engine, api, self, people: () => stage?.people() || [], say: (text) => panel.say(text) });
  call.setLayout(active().video);
  decor = createDecorEditor({ canvas, engine, map, say: (text) => panel.say(text), onSave: (items) => stage.saveDecor(items), onClose: () => { stage.setEditing(false); panel.decorating(false); } });
  stage = createStage({ api, map, engine, panel, live: null, self, plaza: spaceId ? null : { bounds: plazaBounds, channel: null }, onRoom: (room) => { decor?.abort(); if (room) call.enter(room.id); else call.exit(); }, onPeople: () => call.refresh(), onManage: (can) => { if (!can) decor?.abort(); } });
  engine.on("arrive", (tile) => stage.onArrive(tile));
  // Leaving the page releases the entry lease and, as far as the browser allows, the Signaling login.
  addEventListener("pagehide", () => { call.exit(); stage.unload(); live?.close().catch(() => {}); });
  const entering = spaceId ? stage.openSpace(spaceId, invite) : stage.toPlaza(null, minimal ? "Minimal view is on." : preview ? "Previewing the " + preview.name + " theme. Only you see it." : undefined);
  connectLive();
  await entering;
  if (!spaceId) {
    if (lot) panel.say("You're at the door of " + lot.title + ". Step in when you're ready.");
    setInterval(async () => {
      try { const listing = await stage.poll(); summaries = new Map(listing.rooms.map((room) => [room.slug, room])); panel.setRooms(map.lots, summaries); engine.setLabels(labels()); }
      catch { /* try again on the next round */ }
    }, 10000);
  }
}
if (problems.length) panel.say((engine && !self.signedIn && !spaceId ? ["You're watching the plaza. Sign in to walk and talk."] : []).concat(problems).join(" "));
else if (!engine) panel.say("The Stoa view is not available.");
