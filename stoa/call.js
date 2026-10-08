import { createRtcClient, isScreen } from "../world/rtc-client.js";
import { loadAgora } from "../world/sdk.js";

// Calls inside rooms: native controls in the panel, video tiles over the map in the layout the theme chooses.
// RTC uids start with the person's actor UUID, so tiles are named and placed from presence.
export const actorUuid = (uid) => String(uid).split("_")[0];
export function nameFor(uid, { people, self, snapshot }) {
  if (uid === snapshot.uid) return self.name + " (you)";
  if (uid === snapshot.screenUid) return "Your screen";
  if ((self.ids || []).some((id) => String(id).split(":").pop() === actorUuid(uid))) return self.name + " (another tab)" + (isScreen(uid) ? "'s screen" : "");
  const person = people.find((entry) => String(entry.id).split(":")[1] === actorUuid(uid));
  return (person?.name || "Builder") + (isScreen(uid) ? "'s screen" : "");
}
export function tileList(snapshot, { people, self }) {
  if (!snapshot?.joined) return [];
  const own = [{ uid: snapshot.uid, video: snapshot.video, screen: false, mine: true }, ...(snapshot.screen ? [{ uid: snapshot.screenUid, video: true, screen: true, mine: true }] : [])];
  return [...own, ...snapshot.peers.map((peer) => ({ uid: peer.uid, video: peer.video, screen: peer.screen, mine: false }))].map((tile) => ({ ...tile, name: nameFor(tile.uid, { people, self, snapshot }) }));
}
// Where a tile floats in over-avatar layout: just above the person's head, in canvas pixels. Null when they aren't drawn.
export function overAvatar(tile, frame) {
  if (tile.screen || !frame) return null;
  const avatar = frame.avatars.find((entry) => tile.mine ? entry.self : String(entry.id).split(":")[1] === actorUuid(tile.uid));
  if (!avatar) return null;
  return { left: ((avatar.x + 0.5) * frame.tileSize - frame.camera.x) * frame.camera.zoom, top: (avatar.y * frame.tileSize - frame.camera.y) * frame.camera.zoom };
}

export function createCallView({ doc = document, engine, api, self, people = () => [], say = () => {}, loadSdk = loadAgora, secure = () => globalThis.isSecureContext !== false }) {
  const $ = (selector) => doc.querySelector(selector);
  const section = $("#stoa-call"), status = $("#stoa-call-status"), preflight = $("#stoa-call-preflight"), layer = $("#stoa-video");
  let busyJoining = false;
  const buttons = { join: $("#stoa-call-join"), audio: $("#stoa-call-audio"), video: $("#stoa-call-video"), share: $("#stoa-call-share"), resume: $("#stoa-call-resume"), leave: $("#stoa-call-leave") };
  const tiles = new Map();
  let spaceId = null, rtc = null, layout = "strip", frame = null;

  function place() {
    for (const view of tiles.values()) {
      const spot = layout === "over-avatar" ? overAvatar(view.tile, frame) : null;
      view.card.classList.toggle("is-floating", Boolean(spot));
      view.card.style.transform = spot ? "translate(" + Math.round(spot.left) + "px, " + Math.round(spot.top) + "px) translate(-50%, -100%)" : "";
      // Over avatars, a person without video is already shown by their avatar.
      view.card.hidden = layout === "over-avatar" && !view.tile.screen && (!view.playing || !spot);
    }
  }
  function render() {
    const now = rtc ? rtc.snapshot() : null, joined = Boolean(now?.joined);
    buttons.join.hidden = joined; preflight.hidden = joined;
    buttons.join.disabled = !secure() || busyJoining || Boolean(now?.busy);
    for (const key of ["audio", "video", "share", "leave"]) { buttons[key].hidden = !joined; buttons[key].disabled = Boolean(now?.busy); }
    if (!globalThis.navigator?.mediaDevices?.getDisplayMedia) buttons.share.disabled = true;
    buttons.audio.setAttribute("aria-pressed", String(Boolean(now?.audio)));
    buttons.video.setAttribute("aria-pressed", String(Boolean(now?.video)));
    buttons.share.setAttribute("aria-pressed", String(Boolean(now?.screen)));
    buttons.resume.hidden = !now?.audioBlocked;
    layer.hidden = !joined;
    layer.dataset.layout = layout;
    const wanted = joined ? tileList(now, { people: people(), self }) : [];
    for (const [uid, view] of tiles) if (!wanted.some((tile) => tile.uid === uid)) { view.card.remove(); tiles.delete(uid); }
    for (const tile of wanted) {
      let view = tiles.get(tile.uid);
      if (!view) {
        const card = doc.createElement("article"), player = doc.createElement("div"), label = doc.createElement("span");
        card.className = "stoa-tile" + (tile.screen ? " is-screen" : ""); player.className = "stoa-tile-player"; label.className = "stoa-tile-name";
        card.append(player, label);
        layer.append(card);
        view = { card, player, label, playing: false, tile };
        tiles.set(tile.uid, view);
      }
      view.tile = tile;
      if (view.label.textContent !== tile.name) { view.label.textContent = tile.name; view.card.setAttribute("aria-label", tile.name); }
      if (tile.video && !view.playing) view.playing = rtc.play(tile.uid, view.player);
      if (!tile.video) view.playing = false;
      view.card.classList.toggle("has-video", view.playing);
    }
    place();
  }
  function reset(message) {
    for (const view of tiles.values()) view.card.remove();
    tiles.clear();
    render();
    status.textContent = message;
  }
  async function join() {
    if (rtc || !spaceId || busyJoining) return;
    const id = spaceId;
    busyJoining = true; render();
    try { await connect(id); } finally { busyJoining = false; render(); }
  }
  async function connect(id) {
    status.textContent = "Connecting to the call...";
    let AgoraRTC;
    try { ({ AgoraRTC } = await loadSdk()); } catch (error) { if (spaceId === id) status.textContent = "The call couldn't load (" + (error.message || "unknown error") + ")."; return; }
    if (spaceId !== id || rtc) return;
    AgoraRTC.setLogLevel?.(3);
    const client = createRtcClient({
      AgoraRTC,
      fetchCredentials: (uid) => api("/api/spaces/" + encodeURIComponent(id) + "/rtc-token", { method: "POST", body: JSON.stringify(uid ? { uid } : {}) }),
      onChange: () => { if (rtc === client) render(); },
      onError: (message) => { if (rtc === client) say(message); },
      onEnded: (message) => { if (rtc === client) { rtc = null; reset(message); } }
    });
    rtc = client;
    render();
    await client.join({ audio: $("#stoa-call-mic").checked, video: $("#stoa-call-camera").checked });
    if (rtc !== client) return;
    if (!client.snapshot().joined) { rtc = null; await client.leave(); reset("You're not in the call. Try joining again."); return; }
    status.textContent = "You're in the call.";
    buttons.audio.focus();
  }
  async function leave(message, focus = false) {
    const client = rtc, id = spaceId;
    rtc = null; render();
    await client?.leave();
    if (spaceId !== id) return;
    reset(message);
    if (focus) buttons.join.focus();
  }

  buttons.join.addEventListener("click", join);
  buttons.audio.addEventListener("click", () => rtc?.toggle("audio"));
  buttons.video.addEventListener("click", () => rtc?.toggle("video"));
  buttons.share.addEventListener("click", () => rtc?.share());
  buttons.resume.addEventListener("click", () => rtc?.resumeAudio());
  buttons.leave.addEventListener("click", () => leave("You left the call.", true));
  engine.on("draw", (next) => { frame = next; if (layout === "over-avatar" && tiles.size) place(); });
  return {
    enter(id) {
      if (spaceId === id) return;
      if (rtc) leave("");
      spaceId = id;
      section.hidden = false;
      reset(secure() ? "Join to talk with everyone in this room. Choose your mic and camera first; nothing turns on until you join." : "Open this page over HTTPS to use your microphone and camera.");
    },
    exit() { spaceId = null; section.hidden = true; if (rtc) leave(""); else reset(""); },
    setLayout(next) { layout = next || "strip"; render(); },
    refresh() { if (rtc) render(); }
  };
}
