import { test } from "node:test";
import assert from "node:assert/strict";
import { createRtcClient, isScreen, mediaError } from "../world/rtc-client.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const me = "u1_aaaaaaaaaaaa", peer = "u2_bbbbbbbbbbbb";
const credentials = (n = 1) => ({ appId: "app", channel: "agora-build-space-x", uid: me, screenUid: me + "_screen", token: "t" + n, screenToken: "s" + n });
function fakeTrack(kind) {
  const track = { kind, enabled: true, closed: false, stopped: false, played: [], listeners: {}, async setEnabled(value) { track.enabled = value; }, close() { track.closed = true; }, stop() { track.stopped = true; }, play(element, options) { track.played.push([element, options]); }, on(type, listener) { track.listeners[type] = listener; } };
  return track;
}
function fakeAgora({ deny = null } = {}) {
  const sdk = {
    clients: [], tracks: [], checkSystemRequirements: () => true,
    createClient() {
      const client = {
        listeners: {}, remoteUsers: [], joined: null, published: [], left: false, renewed: [], connectionState: "DISCONNECTED",
        on(type, listener) { client.listeners[type] = listener; }, emit(type, ...args) { client.listeners[type]?.(...args); },
        async join(appId, channel, token, uid) { client.joined = { appId, channel, token, uid }; client.connectionState = "CONNECTED"; },
        async leave() { client.left = true; client.connectionState = "DISCONNECTED"; },
        async publish(tracks) { client.published.push(...[].concat(tracks)); },
        async subscribe(user, media) { user[media + "Track"] = fakeTrack(media); },
        async renewToken(token) { client.renewed.push(token); },
        removeAllListeners() { client.listeners = {}; }
      };
      sdk.clients.push(client);
      return client;
    },
    async createMicrophoneAudioTrack() { if (deny === "audio") throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" }); const track = fakeTrack("audio"); sdk.tracks.push(track); return track; },
    async createCameraVideoTrack() { const track = fakeTrack("video"); sdk.tracks.push(track); return track; },
    async createScreenVideoTrack() { const track = fakeTrack("screen"); sdk.tracks.push(track); return track; }
  };
  return sdk;
}
function make({ sdk = fakeAgora(), fetch } = {}) {
  const fetches = [], errors = [], ended = [];
  const rtc = createRtcClient({ AgoraRTC: sdk, fetchCredentials: fetch || (async (uid) => { fetches.push(uid); return credentials(fetches.length); }), onError: (message) => errors.push(message), onEnded: (message) => ended.push(message) });
  return { rtc, sdk, fetches, errors, ended };
}
const own = (snapshot) => ({ joined: snapshot.joined, audio: snapshot.audio, video: snapshot.video, screen: snapshot.screen });

test("screen-share uids and device errors are recognised", () => {
  assert.equal(isScreen(me + "_screen"), true);
  assert.equal(isScreen(me), false);
  assert.match(mediaError({ code: "PERMISSION_DENIED" }), /declined/);
  assert.match(mediaError({ name: "NotFoundError" }), /could not be found/);
  assert.equal(mediaError({ status: 403, message: "Step in first." }), "Step in first.");
});
test("joining publishes the chosen devices, toggles work, and leaving releases everything", async () => {
  const { rtc, sdk } = make();
  assert.equal(await rtc.join({ audio: true }), true);
  const [client] = sdk.clients;
  assert.deepEqual(client.joined, { appId: "app", channel: "agora-build-space-x", token: "t1", uid: me });
  assert.deepEqual(client.published.map((track) => track.kind), ["audio"]);
  assert.deepEqual(own(rtc.snapshot()), { joined: true, audio: true, video: false, screen: false });
  await rtc.toggle("audio");
  assert.equal(rtc.snapshot().audio, false);
  await rtc.toggle("video");
  assert.equal(rtc.snapshot().video, true);
  await rtc.leave();
  assert.ok(sdk.tracks.every((track) => track.closed), "every device is released");
  assert.equal(client.left, true);
  assert.equal(await rtc.toggle("audio"), false, "nothing runs after leaving");
});
test("people appear as they publish and disappear as they leave; your own screen is not a peer", async () => {
  const { rtc, sdk } = make();
  await rtc.join({});
  const [client] = sdk.clients, user = { uid: peer };
  client.remoteUsers.push(user);
  client.emit("user-joined", user);
  client.emit("user-published", user, "video");
  await tick();
  assert.deepEqual(rtc.snapshot().peers, [{ uid: peer, audio: false, video: true, screen: false }]);
  const element = {};
  assert.equal(rtc.play(peer, element), true);
  assert.deepEqual(user.videoTrack.played, [[element, { fit: "cover" }]]);
  client.emit("user-unpublished", user, "video");
  assert.equal(rtc.snapshot().peers[0].video, false);
  assert.equal(rtc.play(peer, element), false);
  client.emit("user-joined", { uid: me + "_screen" });
  assert.equal(rtc.snapshot().peers.length, 1);
  client.remoteUsers = [];
  client.emit("user-left", user);
  assert.deepEqual(rtc.snapshot().peers, []);
});
test("tokens renew with the same identity, and a refused renewal ends the call", async () => {
  let refuse = false;
  const fetches = [];
  const { rtc, sdk, ended } = make({ fetch: async (uid) => { fetches.push(uid); if (refuse) throw Object.assign(new Error("Step into this space before joining its call."), { status: 403 }); return credentials(fetches.length); } });
  await rtc.join({ audio: true });
  const [client] = sdk.clients;
  client.emit("token-privilege-will-expire");
  await tick(); await tick();
  assert.deepEqual([fetches, client.renewed], [[undefined, me], ["t2"]]);
  refuse = true;
  client.emit("token-privilege-did-expire");
  for (let index = 0; index < 5; index += 1) await tick();
  assert.deepEqual(ended, ["Step into this space before joining its call."]);
  assert.equal(client.left, true);
  assert.ok(sdk.tracks.every((track) => track.closed));
});
test("a declined microphone still joins to listen, with a clear reason", async () => {
  const { rtc, errors } = make({ sdk: fakeAgora({ deny: "audio" }) });
  assert.equal(await rtc.join({ audio: true }), true);
  assert.deepEqual(own(rtc.snapshot()), { joined: true, audio: false, video: false, screen: false });
  assert.match(errors[0], /declined/);
});
test("leaving while still joining releases everything and never joins", async () => {
  let release;
  const sdk = fakeAgora();
  const { rtc } = make({ sdk, fetch: () => new Promise((resolve) => { release = resolve; }) });
  const joining = rtc.join({ audio: true });
  await tick();
  const leaving = rtc.leave();
  release(credentials());
  await leaving;
  assert.equal(await joining, false);
  assert.equal(sdk.clients.length, 0);
  assert.equal(sdk.tracks.length, 0);
});
test("screen sharing uses a second client and stops when the browser ends it", async () => {
  const { rtc, sdk } = make();
  await rtc.join({});
  assert.equal(await rtc.share(), true);
  const screenClient = sdk.clients[1];
  assert.deepEqual([screenClient.joined.uid, screenClient.joined.token], [me + "_screen", "s2"]);
  assert.equal(rtc.snapshot().screen, true);
  const element = {};
  assert.equal(rtc.play(me + "_screen", element), true);
  const [screenTrack] = screenClient.published;
  assert.deepEqual(screenTrack.played, [[element, { fit: "contain" }]]);
  screenTrack.listeners["track-ended"]();
  await tick(); await tick();
  assert.equal(rtc.snapshot().screen, false);
  assert.equal(screenClient.left, true);
  assert.equal(screenTrack.closed, true);
});
test("an unexpected disconnect ends the call", async () => {
  const { rtc, sdk, ended } = make();
  await rtc.join({});
  sdk.clients[0].emit("connection-state-change", "DISCONNECTED", "CONNECTED");
  for (let index = 0; index < 5; index += 1) await tick();
  assert.deepEqual(ended, ["The call disconnected. Join again when you're ready."]);
  assert.equal(rtc.snapshot().joined, false);
});
test("leaving starts leaving the connection before a pending join settles", async () => {
  const sdk = fakeAgora(), create = sdk.createClient;
  let finish;
  sdk.createClient = () => { const client = create(); client.join = () => new Promise((resolve) => { finish = resolve; }); return client; };
  const { rtc } = make({ sdk });
  const joining = rtc.join({ audio: true });
  for (let index = 0; index < 3; index += 1) await tick();
  const leaving = rtc.leave();
  assert.equal(rtc.leave(), leaving, "a second leave shares the first");
  await tick();
  assert.equal(sdk.clients[0].left, true);
  finish();
  await leaving;
  assert.equal(await joining, false);
});
test("the browser ending a share while its client is joining reports no error", async () => {
  const sdk = fakeAgora(), create = sdk.createClient;
  let finish;
  sdk.createClient = () => { const client = create(); if (sdk.clients.length === 2) client.join = () => new Promise((resolve) => { finish = resolve; }); return client; };
  const { rtc, errors } = make({ sdk });
  await rtc.join({});
  const sharing = rtc.share();
  for (let index = 0; index < 5; index += 1) await tick();
  sdk.tracks.at(-1).listeners["track-ended"]();
  await tick();
  finish();
  assert.equal(await sharing, false);
  assert.deepEqual(errors, []);
  assert.equal(rtc.snapshot().screen, false);
});
test("actions before joining resolve false", async () => {
  const { rtc } = make();
  assert.equal(await rtc.toggle("audio"), false);
  assert.equal(await rtc.share(), false);
});
