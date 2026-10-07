import { api, el, state, notify } from "./script.js";

const panel = document.querySelector("#call-panel");
const stage = document.querySelector("#call-stage");
const status = document.querySelector("#call-status");
const join = document.querySelector("#call-join");
const mic = document.querySelector("#call-mic");
const camera = document.querySelector("#call-camera");
const share = document.querySelector("#call-share");
const leave = document.querySelector("#call-leave");
const resume = document.querySelector("#call-resume");
let current;
let sdkPromise;

function loadSDK() {
  if (window.AgoraRTC) return Promise.resolve(window.AgoraRTC);
  if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
    const script = el("script", { src: "/assets/agora-rtc.js" });
    const timer = setTimeout(() => fail(), 15000);
    const fail = () => { clearTimeout(timer); script.remove(); sdkPromise = null; reject(new Error("The call engine could not load. Try again.")); };
    script.onerror = fail;
    script.onload = () => { clearTimeout(timer); if (window.AgoraRTC) resolve(window.AgoraRTC); else fail(); };
    document.head.append(script);
  });
  return sdkPromise;
}

function mediaError(error) {
  if (error.status) return error.message;
  if (/PERMISSION|NOT_ALLOWED|NotAllowed/i.test(error.code || error.name || "")) return "Device access was declined. Check your browser permissions and try again.";
  if (/NOT_FOUND|NotFound/i.test(error.code || error.name || "")) return "That microphone or camera could not be found. You can still listen to the call.";
  return "The call could not complete that action. Check your connection and try again.";
}

function controls(ctx) {
  const connected = ctx.joined && !ctx.closed;
  join.disabled = ctx.busy || connected || !ctx.ready || !window.isSecureContext;
  join.hidden = connected;
  document.querySelector("#call-preflight").hidden = connected;
  for (const button of [mic, camera, share]) button.disabled = !connected || ctx.busy;
  const audioOn = Boolean(ctx.audio?.enabled);
  const videoOn = Boolean(ctx.video?.enabled);
  mic.textContent = audioOn ? "Mute mic" : "Turn mic on";
  camera.textContent = videoOn ? "Turn camera off" : "Turn camera on";
  mic.setAttribute("aria-pressed", String(audioOn));
  camera.setAttribute("aria-pressed", String(videoOn));
  share.textContent = ctx.screen ? "Stop sharing" : "Share screen";
  share.setAttribute("aria-pressed", String(Boolean(ctx.screen)));
  share.disabled ||= !navigator.mediaDevices?.getDisplayMedia;
  leave.textContent = connected ? "Leave call" : "Close";
}

function personName(uid, ctx) {
  if (uid === ctx.credentials?.uid || uid === ctx.credentials?.screenUid) return "You";
  const id = "member:" + String(uid).split("_")[0];
  return state.people.find((person) => person.id === id)?.name || "Builder";
}

async function refreshNames(ctx) {
  if (ctx.peopleRequest) return ctx.peopleRequest;
  ctx.peopleRequest = (async () => {
    const result = await api("/api/people");
    if (ctx.closed) return;
    state.people = result.people;
    for (const [uid, view] of ctx.tiles) {
      const screen = String(uid).endsWith("_screen");
      const name = personName(uid, ctx) + (screen ? " / screen" : "");
      view.card.setAttribute("aria-label", name);
      view.label.textContent = name;
      if (!screen) view.placeholder.textContent = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("");
    }
  })();
  try { await ctx.peopleRequest; } finally { ctx.peopleRequest = null; }
}

function tile(ctx, uid) {
  if (ctx.tiles.has(uid)) return ctx.tiles.get(uid);
  const screen = String(uid).endsWith("_screen");
  const name = personName(uid, ctx) + (screen ? " / screen" : "");
  const player = el("div", { class: "call-player" });
  const placeholder = el("div", { class: "call-placeholder", "aria-hidden": "true", text: screen ? "[ ]" : name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("") });
  const label = el("span", { class: "call-tile-name", text: name });
  const card = el("article", { class: "call-tile" + (screen ? " is-screen" : ""), "aria-label": name }, [player, placeholder, label]);
  stage.append(card);
  const value = { card, player, placeholder, label };
  ctx.tiles.set(uid, value);
  return value;
}

function showVideo(ctx, uid, track) {
  const view = tile(ctx, uid);
  view.placeholder.hidden = Boolean(track);
  if (track) track.play(view.player, { fit: String(uid).endsWith("_screen") ? "contain" : "cover" });
}

function count(ctx) {
  const peers = ctx.client?.remoteUsers.filter((user) => !String(user.uid).endsWith("_screen")) || [];
  document.querySelector("#call-count").textContent = ctx.joined ? (peers.length + 1) + " in this call" : "Not connected";
}

async function renew(ctx) {
  if (ctx.closed) return;
  if (ctx.renewing) return ctx.renewing;
  ctx.renewing = (async () => {
    const credentials = await api("/api/rooms/" + ctx.room.id + "/call", { method: "POST", body: JSON.stringify({ uid: ctx.credentials.uid }) });
    if (ctx.closed) return;
    ctx.credentials = credentials;
    await ctx.client.renewToken(credentials.token);
    if (ctx.screen?.client.connectionState === "CONNECTED") await ctx.screen.client.renewToken(credentials.screenToken);
  })();
  try { await ctx.renewing; } finally { ctx.renewing = null; }
}

function tokenEvents(client, ctx) {
  const refresh = () => renew(ctx).catch(async (error) => {
    if (ctx.closed) return;
    notify(error.status ? error.message : "Call access could not be renewed. Please rejoin.");
    await leaveCall();
  });
  client.on("token-privilege-will-expire", refresh);
  client.on("token-privilege-did-expire", refresh);
}

function clientEvents(ctx) {
  const client = ctx.client;
  const ownScreen = (user) => user.uid === ctx.credentials.screenUid;
  client.on("user-joined", (user) => {
    if (ctx.closed || ownScreen(user)) return;
    tile(ctx, user.uid); count(ctx);
    if (personName(user.uid, ctx) === "Builder") refreshNames(ctx).catch(() => {});
  });
  client.on("user-left", (user) => {
    ctx.tiles.get(user.uid)?.card.remove(); ctx.tiles.delete(user.uid); count(ctx);
  });
  client.on("user-published", (user, media) => {
    if (ctx.closed || ownScreen(user)) return;
    client.subscribe(user, media).then(() => {
      if (ctx.closed || !client.remoteUsers.some((peer) => peer.uid === user.uid)) return;
      if (media === "video") showVideo(ctx, user.uid, user.videoTrack);
      if (media === "audio") user.audioTrack?.play();
      count(ctx);
    }).catch(() => { if (!ctx.closed) notify("One participant's media could not be loaded. Agora will retry when they republish."); });
  });
  client.on("user-unpublished", (user, media) => {
    if (ctx.closed || ownScreen(user)) return;
    if (media === "video") { user.videoTrack?.stop(); showVideo(ctx, user.uid, null); }
    if (media === "audio") user.audioTrack?.stop();
  });
  client.on("connection-state-change", (next, previous) => {
    if (ctx.closed) return;
    if (next === "RECONNECTING") status.textContent = "Connection interrupted. Reconnecting...";
    if (next === "CONNECTED") status.textContent = "Connected / Agora RTC";
    if (next === "DISCONNECTED" && previous !== "DISCONNECTING" && ctx.joined) {
      notify("The call disconnected. Open the room to rejoin.");
      leaveCall();
    }
  });
  tokenEvents(client, ctx);
}

async function enableTrack(ctx, kind) {
  const track = kind === "audio" ? await ctx.sdk.createMicrophoneAudioTrack() : await ctx.sdk.createCameraVideoTrack({ encoderConfig: "480p_1" });
  if (ctx.closed) { track.close(); return; }
  ctx[kind] = track;
  try { await ctx.client.publish(track); }
  catch (error) { track.close(); ctx[kind] = null; throw error; }
  if (kind === "video" && !ctx.closed) showVideo(ctx, ctx.credentials.uid, track);
}

async function stopScreen(ctx) {
  const screen = ctx.screen;
  if (!screen) return;
  ctx.screen = null;
  screen.client.removeAllListeners();
  for (const track of screen.tracks) { track.stop(); track.close(); }
  ctx.tiles.get(ctx.credentials.screenUid)?.card.remove();
  ctx.tiles.delete(ctx.credentials.screenUid);
  await screen.client.leave();
  ctx.screenEnded = false;
}

async function operate(operation) {
  const ctx = current;
  if (!ctx || ctx.busy || ctx.closed) return;
  ctx.busy = true; controls(ctx);
  ctx.work = (async () => {
    try { await operation(ctx); }
    catch (error) { if (!ctx.closed) notify(mediaError(error)); }
    finally {
      ctx.busy = false;
      if (!ctx.closed) {
        controls(ctx);
        if (ctx.screenEnded) operate(stopScreen);
      }
    }
  })();
  await ctx.work;
}

export function openCall(room, ready) {
  if (current) {
    if (current.room.id !== room.id) { notify("Leave your current call before opening another room."); return; }
  } else {
    current = { room, ready, busy: false, joined: false, closed: false, tiles: new Map() };
    stage.replaceChildren();
    document.querySelector("#call-title").textContent = room.title;
    document.querySelector("#call-purpose").textContent = room.intent;
    status.textContent = !ready ? "Calls are not connected yet. You can still share this room's invite." : !window.isSecureContext ? "Open this page over HTTPS or localhost to use your microphone and camera." : "Ready when you are. Choose your devices, then join.";
    document.querySelector("#call-error").textContent = "";
    resume.hidden = true;
    count(current); controls(current);
  }
  panel.hidden = false;
  panel.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  document.querySelector("#call-title").focus({ preventScroll: true });
}

async function leaveCall() {
  const ctx = current;
  if (!ctx || ctx.closed) return;
  ctx.closed = true;
  status.textContent = "Leaving the call...";
  // Release devices immediately, including when a join or publish is still pending.
  for (const track of [ctx.audio, ctx.video, ...(ctx.screen?.tracks || [])]) track?.close();
  await ctx.work;
  await Promise.allSettled([stopScreen(ctx), (async () => { ctx.client?.removeAllListeners(); await ctx.client?.leave(); })()]);
  for (const track of [ctx.audio, ctx.video]) track?.close();
  if (current === ctx) {
    current = null;
    stage.replaceChildren(); panel.hidden = true;
    document.querySelector("#rooms-title").focus({ preventScroll: true });
  }
}

join.addEventListener("click", () => operate(async (ctx) => {
  status.textContent = "Connecting to the room...";
  document.querySelector("#call-error").textContent = "";
  try {
    ctx.sdk = await loadSDK();
    if (ctx.closed) return;
    ctx.sdk.setLogLevel(3);
    if (!ctx.sdk.checkSystemRequirements()) throw new Error("unsupported");
    ctx.sdk.onAutoplayFailed = () => { if (!ctx.closed) resume.hidden = false; };
    ctx.credentials = await api("/api/rooms/" + ctx.room.id + "/call", { method: "POST", body: "{}" });
    if (ctx.closed) return;
    await refreshNames(ctx).catch(() => {});
    if (ctx.closed) return;
    ctx.client = ctx.sdk.createClient({ mode: "rtc", codec: "vp8" });
    clientEvents(ctx);
    await ctx.client.join(ctx.credentials.appId, ctx.credentials.channel, ctx.credentials.token, ctx.credentials.uid);
    if (ctx.closed) return;
    ctx.joined = true;
    tile(ctx, ctx.credentials.uid); count(ctx);
    for (const [kind, selector] of [["audio", "#call-start-mic"], ["video", "#call-start-camera"]]) {
      if (!ctx.closed && document.querySelector(selector).checked) {
        try { await enableTrack(ctx, kind); } catch (error) { notify(mediaError(error)); }
      }
    }
    if (!ctx.closed) status.textContent = "Connected / Agora RTC";
  } catch (error) {
    if (!ctx.closed) {
      ctx.client?.removeAllListeners(); await ctx.client?.leave().catch(() => {});
      status.textContent = "Could not connect. You can try joining again.";
      document.querySelector("#call-error").textContent = error.message === "unsupported" ? "This browser does not support Agora calls. Try a current Chrome, Edge, Firefox, or Safari." : mediaError(error);
    }
  }
}));

for (const [button, kind] of [[mic, "audio"], [camera, "video"]]) button.addEventListener("click", () => operate(async (ctx) => {
  if (!ctx[kind]) await enableTrack(ctx, kind);
  else {
    await ctx[kind].setEnabled(!ctx[kind].enabled);
    if (kind === "video") {
      if (!ctx.video.enabled) ctx.video.stop();
      showVideo(ctx, ctx.credentials.uid, ctx.video.enabled ? ctx.video : null);
    }
  }
}));

share.addEventListener("click", () => operate(async (ctx) => {
  if (ctx.screen) { await stopScreen(ctx); return; }
  // Capture on the click gesture before token/network work, as browsers require.
  const captured = await ctx.sdk.createScreenVideoTrack({ encoderConfig: "1080p_1" }, "auto");
  const tracks = Array.isArray(captured) ? captured : [captured];
  if (ctx.closed) { for (const track of tracks) track.close(); return; }
  const client = ctx.sdk.createClient({ mode: "rtc", codec: "vp8" });
  ctx.screen = { client, tracks };
  tracks[0].on("track-ended", () => { if (!ctx.closed) { ctx.screenEnded = true; if (!ctx.busy) operate(stopScreen); } });
  try {
    await renew(ctx);
    if (ctx.closed) return;
    tokenEvents(client, ctx);
    await client.join(ctx.credentials.appId, ctx.credentials.channel, ctx.credentials.screenToken, ctx.credentials.screenUid);
    if (ctx.closed) return;
    await client.publish(tracks);
    if (!ctx.closed) showVideo(ctx, ctx.credentials.screenUid, tracks[0]);
  } catch (error) { await stopScreen(ctx); throw error; }
}));

resume.addEventListener("click", () => {
  for (const user of current?.client?.remoteUsers || []) user.audioTrack?.play();
  resume.hidden = true;
});
leave.addEventListener("click", leaveCall);
document.addEventListener("house:session", () => { if (current && !state.profile) leaveCall(); });
window.addEventListener("pagehide", () => {
  const ctx = current;
  if (!ctx) return;
  ctx.closed = true;
  for (const track of [ctx.audio, ctx.video, ...(ctx.screen?.tracks || [])]) track?.close();
  ctx.client?.leave().catch(() => {});
  ctx.screen?.client.leave().catch(() => {});
  current = null;
  panel.hidden = true;
  stage.replaceChildren();
});
