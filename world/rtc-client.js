// Agora RTC with no UI: joining, devices, publishing, screen sharing, and token renewal. The page draws from snapshots.
export const isScreen = (uid) => String(uid).endsWith("_screen");
export function mediaError(error) {
  if (error?.status) return error.message;
  const code = String(error?.code || error?.name || "");
  if (/PERMISSION|NOT_ALLOWED|NotAllowed/i.test(code)) return "Device access was declined. Check your browser permissions and try again.";
  if (/NOT_FOUND|NotFound/i.test(code)) return "That microphone or camera could not be found. You can still listen to the call.";
  return "The call could not complete that action. Check your connection and try again.";
}

export function createRtcClient({ AgoraRTC, fetchCredentials, onChange = () => {}, onError = () => {}, onEnded = () => {} }) {
  let client = null, credentials = null, audio = null, video = null, screen = null, joined = false, busy = false, closed = false, renewing = null, audioBlocked = false, work = Promise.resolve(), leaving = null;
  const remote = new Map();
  const snapshot = () => ({ joined, busy, closed, uid: credentials?.uid || null, screenUid: credentials?.screenUid || null, audio: Boolean(audio?.enabled), video: Boolean(video?.enabled), screen: Boolean(screen), audioBlocked, peers: [...remote.values()].map((peer) => ({ uid: peer.uid, audio: peer.audio, video: peer.video, screen: isScreen(peer.uid) })) });
  const changed = () => { if (!closed) onChange(snapshot()); };
  // One action at a time; a click while another action runs is ignored.
  function operate(action) {
    if (busy || closed) return Promise.resolve(false);
    busy = true; changed();
    work = (async () => {
      try { return (await action()) !== false && !closed; }
      catch (error) { if (!closed) onError(mediaError(error)); return false; }
      finally { busy = false; changed(); }
    })();
    return work;
  }
  async function renew() {
    if (closed) return;
    if (renewing) return renewing;
    renewing = (async () => {
      const next = await fetchCredentials(credentials.uid);
      if (closed) return;
      credentials = next;
      await client.renewToken(next.token);
      if (screen?.client.connectionState === "CONNECTED") await screen.client.renewToken(next.screenToken);
    })();
    try { await renewing; } finally { renewing = null; }
  }
  const end = (message) => { if (!closed) leave().then(() => onEnded(message)); };
  function watchToken(target) {
    const refresh = () => renew().catch((error) => end(error?.status ? error.message : "Call access could not be renewed. Join again."));
    target.on("token-privilege-will-expire", refresh);
    target.on("token-privilege-did-expire", refresh);
  }
  function watch() {
    const own = (user) => user.uid === credentials.screenUid;
    const entry = (user) => { if (!remote.has(user.uid)) remote.set(user.uid, { uid: user.uid, user, audio: false, video: false }); return remote.get(user.uid); };
    client.on("user-joined", (user) => { if (closed || own(user)) return; entry(user); changed(); });
    client.on("user-left", (user) => { remote.delete(user.uid); changed(); });
    client.on("user-published", (user, media) => {
      if (closed || own(user)) return;
      client.subscribe(user, media).then(() => {
        if (closed || !client.remoteUsers.some((peer) => peer.uid === user.uid)) return;
        const peer = entry(user);
        peer.user = user; peer[media] = true;
        if (media === "audio") user.audioTrack?.play();
        changed();
      }).catch(() => { if (!closed) onError("One person's audio or video could not load. It will retry when they share it again."); });
    });
    client.on("user-unpublished", (user, media) => {
      if (closed || own(user)) return;
      if (media === "video") user.videoTrack?.stop();
      if (media === "audio") user.audioTrack?.stop();
      const peer = remote.get(user.uid);
      if (peer) { peer[media] = false; changed(); }
    });
    client.on("connection-state-change", (next, previous) => { if (next === "DISCONNECTED" && previous !== "DISCONNECTING" && joined) end("The call disconnected. Join again when you're ready."); });
    watchToken(client);
  }
  async function enable(kind) {
    const track = kind === "audio" ? await AgoraRTC.createMicrophoneAudioTrack() : await AgoraRTC.createCameraVideoTrack({ encoderConfig: "480p_1" });
    if (closed) { track.close(); return; }
    if (kind === "audio") audio = track; else video = track;
    try { await client.publish(track); }
    catch (error) { track.close(); if (kind === "audio") audio = null; else video = null; throw error; }
  }
  async function stopScreen() {
    const current = screen;
    if (!current) return;
    screen = null;
    current.client.removeAllListeners();
    for (const track of current.tracks) { track.stop(); track.close(); }
    await current.client.leave().catch(() => {});
  }
  function leave() {
    if (leaving) return leaving;
    closed = true;
    leaving = (async () => {
      // Devices are released and the connections start leaving at once, even while a join or publish is still pending.
      for (const track of [audio, video, ...(screen?.tracks || [])]) track?.close();
      const early = [client?.leave().catch(() => {}), screen?.client.leave().catch(() => {})];
      await Promise.allSettled([...early, work.catch(() => {})]);
      await Promise.allSettled([stopScreen(), (async () => { client?.removeAllListeners(); await client?.leave(); })()]);
      for (const track of [audio, video]) track?.close();
      audio = null; video = null; joined = false; remote.clear();
    })();
    return leaving;
  }
  return {
    snapshot,
    join: ({ audio: withAudio = false, video: withVideo = false } = {}) => operate(async () => {
      if (!AgoraRTC.checkSystemRequirements()) throw Object.assign(new Error("This browser can't join calls. Try a current Chrome, Edge, Firefox, or Safari."), { status: 400 });
      AgoraRTC.onAutoplayFailed = () => { audioBlocked = true; changed(); };
      credentials = await fetchCredentials();
      if (closed) return;
      client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
      watch();
      try { await client.join(credentials.appId, credentials.channel, credentials.token, credentials.uid); }
      catch (error) { client.removeAllListeners(); await client.leave().catch(() => {}); client = null; credentials = null; throw error; }
      if (closed) return;
      joined = true;
      for (const [kind, wanted] of [["audio", withAudio], ["video", withVideo]]) {
        if (wanted && !closed) { try { await enable(kind); } catch (error) { onError(mediaError(error)); } }
      }
    }),
    toggle: (kind) => operate(async () => {
      if (!joined) return false;
      const track = kind === "audio" ? audio : video;
      if (!track) { await enable(kind); return; }
      await track.setEnabled(!track.enabled);
      if (kind === "video" && !track.enabled) track.stop();
    }),
    share: () => operate(async () => {
      if (!joined) return false;
      if (screen) { await stopScreen(); return; }
      // Capture during the click, before any network work, as browsers require.
      const captured = await AgoraRTC.createScreenVideoTrack({ encoderConfig: "1080p_1" }, "auto");
      const tracks = Array.isArray(captured) ? captured : [captured];
      if (closed) { for (const track of tracks) track.close(); return false; }
      const second = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
      screen = { client: second, tracks };
      second.on("connection-state-change", (next, previous) => { if (next === "DISCONNECTED" && previous !== "DISCONNECTING" && !closed && screen?.client === second) stopScreen().then(changed); });
      tracks[0].on("track-ended", () => { if (!closed && screen?.client === second) stopScreen().then(changed); });
      try {
        await renew();
        if (closed || screen?.client !== second) return false;
        watchToken(second);
        await second.join(credentials.appId, credentials.channel, credentials.screenToken, credentials.screenUid);
        if (closed || screen?.client !== second) return false;
        await second.publish(tracks);
      } catch (error) {
        // Already stopped elsewhere (the browser ended it, or the call closed): nothing to report.
        const stopped = screen?.client !== second;
        await stopScreen();
        if (stopped) return false;
        throw error;
      }
    }),
    // Plays someone's video into an element; false when there is nothing to show.
    play(uid, element) {
      if (closed) return false;
      const peer = remote.get(uid);
      const track = uid === credentials?.uid ? (video?.enabled ? video : null) : uid === credentials?.screenUid ? screen?.tracks[0] : peer?.video ? peer.user.videoTrack : null;
      if (!track) return false;
      track.play(element, { fit: isScreen(uid) ? "contain" : "cover" });
      return true;
    },
    resumeAudio() { for (const user of client?.remoteUsers || []) user.audioTrack?.play(); audioBlocked = false; changed(); },
    leave
  };
}
