import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAppServer } from "../scripts/serve.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { authConfig, createAuth } from "../scripts/auth.mjs";
import { createSignaling, signalingConfig } from "../scripts/spaces/signaling.mjs";

const root = new URL("../", import.meta.url).pathname;
const env = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACE_CHANNEL_SECRET: "s".repeat(32) };
const profile = (name) => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });
const absent = "/00000000-0000-4000-8000-000000000000";
let temporary;
const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });
async function start(options = {}) {
  const instance = createAppServer(root, { monitor: false, storageFile: resolve(temporary, Math.random() + ".json"), models: createModelClient(modelConfig({})), calls: createAgoraCalls(agoraConfig(env)), auth: createAuth(authConfig({})), signaling: createSignaling(signalingConfig(env)), channelSecret: env.SPACE_CHANNEL_SECRET, ...options });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  return { instance, url: "http://127.0.0.1:" + instance.address().port };
}
const request = (base, path, { cookie, method = "GET", data } = {}) => fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
const post = (base, path, cookie, data = {}) => request(base, path, { cookie, method: "POST", data });
async function join(base, name) {
  const response = await post(base, "/api/profile", undefined, profile(name));
  assert.equal(response.status, 201);
  return response.headers.get("set-cookie").split(";")[0];
}
before(async () => { temporary = await mkdtemp(resolve(tmpdir(), "spaces-api-")); });
after(() => rm(temporary, { recursive: true, force: true }));

test("Stoa pages and worlds are served, and hidden spaces look exactly like missing ones", async () => {
  const { instance, url } = await start();
  try {
    for (const path of ["/stoa/", "/stoa/room/ai-agents"]) {
      const response = await request(url, path);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /Stoa/);
    }
    assert.equal((await request(url, "/stoa/room/nowhere")).status, 404);
    const owner = await join(url, "Owner"), stranger = await join(url, "Stranger");
    const created = await post(url, "/api/spaces", owner, { title: "Board room", visibility: "private" });
    assert.equal(created.status, 201);
    const { space } = await created.json();
    assert.equal((await request(url, "/stoa/s/" + space.id, { cookie: owner })).status, 200);
    const hidden = await request(url, "/stoa/s/" + space.id, { cookie: stranger });
    const missing = await request(url, "/stoa/s" + absent, { cookie: stranger });
    assert.deepEqual([hidden.status, await hidden.text()], [missing.status, await missing.text()]);
    const apiHidden = await request(url, "/api/spaces/" + space.id, { cookie: stranger });
    const apiMissing = await request(url, "/api/spaces" + absent, { cookie: stranger });
    assert.deepEqual([apiHidden.status, await apiHidden.json()], [404, await apiMissing.json()]);
    const plaza = await (await request(url, "/api/worlds/plaza")).json();
    assert.deepEqual([plaza.width, plaza.height], [44, 34]);
    assert.equal((await request(url, "/api/worlds/secret")).status, 404);
    assert.equal(JSON.stringify(await (await request(url, "/api/spaces")).json()).includes(space.id), false);
    assert.equal((await post(url, "/api/spaces", undefined, { title: "Guest" })).status, 401);
  } finally { await close(instance); }
});

test("walking in, hosting, decorating, and calls work over HTTP", async () => {
  const { instance, url } = await start();
  try {
    const ada = await join(url, "Ada"), bo = await join(url, "Bo");
    assert.equal((await post(url, "/api/spaces/lot-voice-ai/enter")).status, 401);
    const entered = await (await post(url, "/api/spaces/lot-voice-ai/enter", ada)).json();
    assert.deepEqual([entered.firstIn, entered.channel], [true, "ab-stoa-voice-ai"]);
    await post(url, "/api/spaces/lot-voice-ai/enter", bo);
    assert.equal((await post(url, "/api/spaces/lot-voice-ai/topic", bo, { topic: "Turn taking" })).status, 403);
    const topic = await post(url, "/api/spaces/lot-voice-ai/topic", ada, { topic: "Turn taking", tags: ["latency"] });
    assert.equal((await topic.json()).space.topic, "Turn taking");
    const listing = await (await request(url, "/api/spaces?q=latency")).json();
    assert.deepEqual(listing.rooms.map((room) => [room.slug, room.occupancy, room.hostName]), [["voice-ai", 2, "Ada"]]);
    const decor = await request(url, "/api/spaces/lot-voice-ai/decor", { cookie: ada, method: "PUT", data: { items: [{ id: "lamp", kind: "lamp", x: 8, y: 22 }] } });
    assert.equal((await decor.json()).version, 1);
    const call = await (await post(url, "/api/spaces/lot-voice-ai/rtc-token", ada)).json();
    assert.equal(call.channel, "agora-build-space-lot-voice-ai");
    assert.equal((await request(url, "/api/spaces/lot-voice-ai/heartbeat", { cookie: ada, method: "POST" })).status, 200);
    assert.equal((await request(url, "/api/spaces/lot-voice-ai/leave", { cookie: ada, method: "POST" })).status, 200);
    assert.equal((await request(url, "/api/spaces/lot-voice-ai/heartbeat", { cookie: ada, method: "POST" })).status, 410);
    const signaling = await (await post(url, "/api/signaling/token")).json();
    assert.match(signaling.userId, /^g-/);
  } finally { await close(instance); }
});

test("a full plaza answers with an offer of other places", async () => {
  const { instance, url } = await start({ plazaCapacity: 1 });
  try {
    const ada = await join(url, "Ada"), bo = await join(url, "Bo");
    assert.equal((await post(url, "/api/spaces/plaza/enter", ada)).status, 200);
    const full = await post(url, "/api/spaces/plaza/enter", bo);
    assert.equal(full.status, 409);
    assert.deepEqual(await full.json(), { error: "The plaza is full right now.", full: true, offer: { spaces: [], canCreate: true } });
  } finally { await close(instance); }
});

test("invitations, membership, and deletion work over HTTP", async () => {
  const { instance, url } = await start();
  try {
    const owner = await join(url, "Owner"), guest = await join(url, "Guest");
    const guestId = (await (await request(url, "/api/me", { cookie: guest })).json()).profile.id;
    const { space } = await (await post(url, "/api/spaces", owner, { title: "Board room", visibility: "private" })).json();
    const invitation = await post(url, "/api/spaces/" + space.id + "/invitations", owner, { uses: 2, hours: 24 });
    assert.equal(invitation.status, 201);
    const { token } = await invitation.json();
    assert.equal((await request(url, "/api/spaces/" + space.id + "?invite=" + token, { cookie: guest })).status, 200);
    assert.equal((await post(url, "/api/spaces/" + space.id + "/enter", guest, { invite: token })).status, 200);
    assert.equal((await request(url, "/api/spaces/" + space.id + "/members/" + guestId, { cookie: owner, method: "DELETE" })).status, 200);
    assert.equal((await request(url, "/api/spaces/" + space.id, { cookie: guest })).status, 404);
    assert.equal((await request(url, "/api/spaces/" + space.id, { cookie: owner, method: "DELETE" })).status, 200);
    assert.equal((await request(url, "/api/spaces/" + space.id, { cookie: owner })).status, 404);
  } finally { await close(instance); }
});

test("missing Signaling or call configuration is reported plainly", async () => {
  const { instance, url } = await start({ signaling: createSignaling(signalingConfig({})), calls: createAgoraCalls(agoraConfig({})) });
  try {
    assert.equal((await post(url, "/api/signaling/token")).status, 503);
    const ada = await join(url, "Ada");
    assert.equal((await post(url, "/api/spaces/lot-lounge/enter", ada)).status, 200);
    assert.equal((await post(url, "/api/spaces/lot-lounge/rtc-token", ada)).status, 503);
  } finally { await close(instance); }
});

test("a JSON null body never causes a server error", async () => {
  const { instance, url } = await start();
  try {
    const cookie = await join(url, "Nina");
    for (const path of ["/api/spaces/plaza/enter", "/api/spaces/plaza/members", "/api/spaces/plaza/topic"]) {
      const response = await request(url, path, { cookie, method: "POST", data: null });
      assert.ok(response.status < 500, path + " " + response.status);
    }
    assert.ok((await request(url, "/api/spaces/plaza/decor", { cookie, method: "PUT", data: null })).status < 500);
    assert.ok((await request(url, "/api/spaces", { cookie, method: "POST", data: null })).status < 500);
  } finally { await close(instance); }
});

test("the themes API returns the three built-in themes", async () => {
  const { instance, url } = await start();
  try {
    const response = await request(url, "/api/themes");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).themes.map((theme) => theme.id), ["agora", "minimal", "cyberpunk"]);
  } finally { await close(instance); }
});
