import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAppServer } from "../scripts/serve.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { createStore } from "../scripts/store.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { authConfig, createAuth } from "../scripts/auth.mjs";

const root = new URL("../", import.meta.url).pathname;
const profile = (name = "Test builder") => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });
let temporary;
let origin;
let server;
const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });
async function start(options = {}, directory = root) {
  const instance = createAppServer(directory, { monitor: false, storageFile: resolve(temporary, Math.random() + ".json"), models: createModelClient(modelConfig({})), calls: createAgoraCalls(agoraConfig({})), auth: createAuth(authConfig({})), ...options });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  return { instance, url: "http://127.0.0.1:" + instance.address().port };
}
async function request(path, { cookie, method = "GET", data, base = origin, headers = {} } = {}) {
  return fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, ...(data !== undefined ? { body: typeof data === "string" ? data : JSON.stringify(data) } : {}) });
}
async function join(name, base = origin) {
  const response = await request("/api/profile", { base, method: "POST", data: profile(name) });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  return { person: (await response.json()).profile, cookie: response.headers.get("set-cookie").split(";")[0] };
}
before(async () => { temporary = await mkdtemp(resolve(tmpdir(), "agora-house-test-")); const result = await start(); server = result.instance; origin = result.url; });
after(async () => { await close(server); await rm(temporary, { recursive: true, force: true }); });

test("six pages, internal links, assets, and section anchors load", async () => {
  for (const page of ["/", "/explore.html", "/services.html", "/radar.html", "/meetings.html", "/account.html"]) {
    const response = await request(page);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    const links = new Set([...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]).filter((url) => !url.startsWith("https://")));
    for (const link of links) assert.equal((await fetch(new URL(link, origin + page))).status, 200, link);
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes('id="' + target + '"'), target);
  }
});
test("only allowlisted public files are served", async () => {
  for (const path of ["/AGENTS.md", "/README.md", "/package.json", "/scripts/serve.mjs", "/.env", "/.env.example", "/.data/community.json", "/data/people.json", "/missing", "/%2e%2e/package.json"]) assert.equal((await request(path)).status, 404, path);
  const response = await request("/", { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  const image = await request("/assets/guohai.jpg", { method: "HEAD" });
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.equal(await image.text(), "");
});
test("real GitHub seed and sixteen projects are available without fabricated members", async () => {
  const people = await (await request("/api/people")).json();
  assert.equal(people.people.length, 1);
  assert.equal(people.people[0].id, "github:guohai");
  assert.equal(people.people[0].intent, "");
  const { projects } = await (await request("/api/projects")).json();
  assert.equal(projects.length, 16);
  assert.ok(projects.every((project) => project.url.startsWith("https://github.com/Agora-Build/")));
});
test("joining requires real intent, skills, and a valid public contact", async () => {
  for (const change of [{ intent: "" }, { skills: [] }, { contact: "javascript:alert(1)" }, { contact: "https://user:password@example.com" }]) {
    const isolated = await start();
    try { assert.equal((await request("/api/profile", { base: isolated.url, method: "POST", data: { ...profile(), ...change } })).status, 422); }
    finally { await close(isolated.instance); }
  }
});
test("profile sessions authorize only their owner and never expose session hashes", async () => {
  const isolated = await start();
  try {
    const a = await join("First builder", isolated.url);
    const b = await join("Second builder", isolated.url);
    const me = await (await request("/api/me", { base: isolated.url, cookie: a.cookie })).json();
    assert.equal(me.profile.id, a.person.id);
    assert.equal((await request("/api/profile", { base: isolated.url, method: "PUT", data: profile() })).status, 401);
    assert.equal((await request("/api/profile", { base: isolated.url, cookie: a.cookie, method: "POST", data: profile() })).status, 409);
    const edited = await request("/api/profile", { base: isolated.url, cookie: a.cookie, method: "PUT", data: { ...profile("Updated builder"), id: b.person.id, source: "github" } });
    assert.equal((await edited.json()).profile.id, a.person.id);
    const bMe = await (await request("/api/me", { base: isolated.url, cookie: b.cookie })).json();
    assert.equal(bMe.profile.name, "Second builder");
    const publicText = await (await request("/api/people", { base: isolated.url })).text();
    assert.ok(!publicText.includes("sessionHash") && !publicText.includes(a.cookie.split("=")[1]));
    assert.equal((await request("/api/profile", { base: isolated.url, cookie: a.cookie, method: "DELETE" })).status, 200);
    assert.equal((await (await request("/api/me", { base: isolated.url, cookie: a.cookie })).json()).profile, null);
  } finally { await close(isolated.instance); }
});
test("concurrent joins survive atomic persistence and restarting the server", async () => {
  const storageFile = resolve(temporary, "persistence.json");
  const first = await start({ storageFile });
  const members = await Promise.all(Array.from({ length: 5 }, (_, index) => join("Concurrent builder " + index, first.url)));
  await close(first.instance);
  const second = await start({ storageFile });
  try {
    const people = await (await request("/api/people", { base: second.url })).json();
    assert.equal(people.people.length, 6);
    assert.equal((await (await request("/api/me", { base: second.url, cookie: members[0].cookie })).json()).profile.name, "Concurrent builder 0");
    const saved = JSON.parse(await readFile(storageFile, "utf8"));
    assert.equal(saved.people.length, 5);
    assert.notEqual(saved.people[0].sessionHash, members[0].cookie.split("=")[1]);
  } finally { await close(second.instance); }
});
test("basic people search supports skills, project facts, and empty results", async () => {
  const run = async (query, skill = "all") => (await request("/api/people/search", { method: "POST", data: { query, skill } })).json();
  assert.equal((await run("voice AI")).people[0].id, "github:guohai");
  assert.equal((await run("HapticHatch")).people.length, 1);
  assert.equal((await run("", "Rust")).people.length, 1);
  assert.equal((await run("", "Pottery")).people.length, 0);
  const empty = await run("zxqnonexistent");
  assert.equal(empty.people.length, 0);
  assert.equal(empty.mode, "basic");
  assert.equal((await request("/api/people/search", { method: "POST", data: { query: "x".repeat(1001) } })).status, 422);
});
test("cross-origin mutations, invalid JSON, and oversized bodies are rejected", async () => {
  assert.equal((await request("/api/profile", { method: "POST", data: profile(), headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal((await request("/api/people/search", { method: "POST", data: "not-json" })).status, 400);
  assert.equal((await request("/api/people/search", { method: "POST", data: "x".repeat(17000) })).status, 413);
  assert.equal((await request("/api/profile", { method: "POST" })).status, 415);
});
test("unconfigured model services report their status and do not fake results", async () => {
  const config = await (await request("/api/services")).json();
  assert.equal(config.language.ready, false);
  assert.equal(config.speech.ready, false);
  assert.equal(config.radar.ready, false);
  assert.deepEqual(config.offers, []);
  assert.equal((await request("/api/services/chat", { method: "POST", data: { message: "Help me" } })).status, 503);
  assert.equal((await request("/api/services/tts", { method: "POST", data: { text: "Hello" } })).status, 503);
  assert.equal((await request("/api/radar", { method: "POST" })).status, 503);
});
test("multiple members join the same meeting without impersonation or duplicate roster entries", async () => {
  const isolated = await start();
  try {
    const a = await join("Room host", isolated.url);
    const b = await join("Room guest", isolated.url);
    assert.equal((await request("/api/rooms", { base: isolated.url, method: "POST", data: { title: "Unauthorized", intent: "Test" } })).status, 401);
    const response = await request("/api/rooms", { base: isolated.url, cookie: a.cookie, method: "POST", data: { title: "Voice workshop", intent: "Compare interruption handling" } });
    assert.equal(response.status, 201);
    const { room } = await response.json();
    assert.equal(room.callProvider, "agora");
    assert.ok(!("videoUrl" in room));
    assert.equal(room.path, "/meet/" + room.id);
    const page = await request(room.path, { base: isolated.url });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /src="\/meetings.js"/);
    assert.equal((await request("/meet/11111111-1111-1111-1111-111111111111", { base: isolated.url })).status, 404);
    assert.deepEqual(room.participants, [a.person.id]);
    const path = "/api/rooms/" + room.id + "/join";
    assert.equal((await request(path, { base: isolated.url, method: "POST" })).status, 401);
    for (let index = 0; index < 2; index++) await request(path, { base: isolated.url, cookie: b.cookie, method: "POST", data: { memberId: a.person.id } });
    const rooms = await (await request("/api/rooms", { base: isolated.url })).json();
    assert.deepEqual(rooms.rooms[0].participants, [a.person.id, b.person.id]);
    assert.equal(rooms.rooms[0].callProvider, "agora");
    assert.deepEqual(rooms.calls, { provider: "agora", ready: false });
    await request("/api/profile", { base: isolated.url, cookie: b.cookie, method: "DELETE" });
    assert.deepEqual((await (await request("/api/rooms", { base: isolated.url })).json()).rooms[0].participants, [a.person.id]);
    await request("/api/profile", { base: isolated.url, cookie: a.cookie, method: "DELETE" });
    assert.equal((await (await request("/api/rooms", { base: isolated.url })).json()).rooms.length, 0);
  } finally { await close(isolated.instance); }
});
test("Agora call tokens require room membership, bind identities to sessions, and renew without exposing the certificate", async () => {
  const config = agoraConfig({ AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32) });
  const isolated = await start({ calls: createAgoraCalls(config) });
  try {
    const a = await join("Call host", isolated.url);
    const b = await join("Call guest", isolated.url);
    const { room } = await (await request("/api/rooms", { base: isolated.url, cookie: a.cookie, method: "POST", data: { title: "Agora workshop", intent: "Work on voice routing" } })).json();
    const path = "/api/rooms/" + room.id + "/call";
    assert.equal((await request(path, { base: isolated.url, method: "POST", data: {} })).status, 401);
    assert.equal((await request(path, { base: isolated.url, cookie: b.cookie, method: "POST", data: {} })).status, 403);
    assert.equal((await request(path, { base: isolated.url, cookie: a.cookie, method: "POST", data: {}, headers: { Origin: "https://elsewhere.example" } })).status, 403);
    const response = await request(path, { base: isolated.url, cookie: a.cookie, method: "POST", data: {} });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const host = await response.json();
    assert.equal(host.provider, "agora");
    assert.equal(host.channel, "agora-build-" + room.id);
    assert.match(host.token, /^007/);
    assert.match(host.screenToken, /^007/);
    assert.equal(host.screenUid, host.uid + "_screen");
    assert.ok(!JSON.stringify(host).includes(config.certificate));
    const renewed = await (await request(path, { base: isolated.url, cookie: a.cookie, method: "POST", data: { uid: host.uid, channel: "unrelated-room", appId: "untrusted" } })).json();
    assert.equal(renewed.uid, host.uid);
    assert.equal(renewed.channel, host.channel);
    assert.equal(renewed.appId, config.appId);
    await request("/api/rooms/" + room.id + "/join", { base: isolated.url, cookie: b.cookie, method: "POST" });
    const guest = await (await request(path, { base: isolated.url, cookie: b.cookie, method: "POST", data: {} })).json();
    assert.equal(guest.channel, host.channel);
    assert.notEqual(guest.uid, host.uid);
    assert.equal((await request(path, { base: isolated.url, cookie: b.cookie, method: "POST", data: { uid: host.uid } })).status, 422);
    const anotherTab = await (await request(path, { base: isolated.url, cookie: a.cookie, method: "POST", data: {} })).json();
    assert.notEqual(anotherTab.uid, host.uid);
    await request("/api/profile", { base: isolated.url, cookie: a.cookie, method: "DELETE" });
    assert.equal((await request(path, { base: isolated.url, cookie: b.cookie, method: "POST", data: { uid: guest.uid } })).status, 404);
    for (const file of ["/scripts/calls.mjs", "/node_modules/agora-token/index.js"]) assert.equal((await request(file, { base: isolated.url })).status, 404);
  } finally { await close(isolated.instance); }
});
test("unconfigured Agora calls keep rooms usable and reject token issuance with an honest status", async () => {
  const a = await join("Unconfigured caller");
  const { room } = await (await request("/api/rooms", { cookie: a.cookie, method: "POST", data: { title: "Future workshop", intent: "Plan a demo day" } })).json();
  const response = await request("/api/rooms/" + room.id + "/call", { cookie: a.cookie, method: "POST", data: {} });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Agora calls are not connected/);
  assert.equal((await request("/assets/agora-rtc.js")).status, 200);
  assert.equal((await request("/call.js")).status, 200);
});
test("existing room IDs and rosters survive the call provider change without publishing old external call links", async () => {
  const storageFile = resolve(temporary, "legacy-rooms.json");
  const id = "fef01f04-24ee-4b5e-8556-111111111111";
  await writeFile(storageFile, JSON.stringify({ people: [], radar: {}, rooms: [{ id, title: "Existing room", intent: "Keep working together", participants: [], ownerId: "legacy-owner", videoUrl: "https://old-provider.example/legacy" }] }));
  const store = createStore(resolve(root, "data/people.json"), storageFile);
  assert.deepEqual((await store.rooms())[0], { id, title: "Existing room", intent: "Keep working together", participants: [], ownerId: "legacy-owner", callProvider: "agora", path: "/meet/" + id });
  const person = await store.join(profile("New participant"));
  const room = await store.joinRoom(person.token, id);
  assert.ok(!("videoUrl" in room));
  assert.deepEqual(room.participants, [person.person.id]);
});
test("connected service API preserves provider privacy, requires membership, and enforces allowances", async () => {
  const config = modelConfig({ OPENAI_API_KEY: "test-only-provider-secret" });
  const models = { config, chat: async () => "Mocked workshop answer", speak: async () => Buffer.from("ID3-mocked-audio"), research: async () => ({ items: [{ kind: "resource", title: "Test source", url: "https://example.com/source", reason: "Relevant to voice agents" }] }), search: async (people) => people };
  const isolated = await start({ models, modelLimit: 3 });
  try {
    const publicConfig = await (await request("/api/services", { base: isolated.url })).text();
    assert.ok(!publicConfig.includes("test-only-provider-secret") && !publicConfig.includes("api.openai.com"));
    assert.equal((await request("/api/services/chat", { base: isolated.url, method: "POST", data: { message: "Help" } })).status, 401);
    const member = await join("Service tester", isolated.url);
    const chat = await request("/api/services/chat", { base: isolated.url, cookie: member.cookie, method: "POST", data: { message: "Help" } });
    assert.equal((await chat.json()).answer, "Mocked workshop answer");
    const speech = await request("/api/services/tts", { base: isolated.url, cookie: member.cookie, method: "POST", data: { text: "Hello", voice: "coral" } });
    assert.equal(speech.headers.get("content-type"), "audio/mpeg");
    assert.equal(await speech.text(), "ID3-mocked-audio");
    assert.equal((await request("/api/radar", { base: isolated.url, cookie: member.cookie, method: "POST" })).status, 200);
    const privateRadar = await (await request("/api/radar", { base: isolated.url, cookie: member.cookie })).json();
    assert.equal(privateRadar.result.items.length, 1);
    assert.equal((await (await request("/api/radar", { base: isolated.url })).json()).result, null);
    assert.equal((await request("/api/radar", { base: isolated.url, cookie: member.cookie, method: "POST" })).status, 429);
    assert.equal((await request("/api/services/chat", { base: isolated.url, cookie: member.cookie, method: "POST", data: { message: "More" } })).status, 429);
  } finally { await close(isolated.instance); }
});
test("profile intent updates discard earlier radar results and stale in-flight scans", async () => {
  const storageFile = resolve(temporary, "intent-race.json");
  const store = createStore(resolve(root, "data/people.json"), storageFile);
  const { person, token } = await store.join(profile());
  await store.saveRadar(person.id, { items: [{ title: "Old match" }] }, person.intent);
  assert.equal((await store.radar(person.id)).items.length, 1);
  await store.edit(token, { ...profile(), intent: "Build a real-time video tool instead." });
  assert.equal(await store.radar(person.id), null);
  await store.saveRadar(person.id, { items: [{ title: "Stale match" }] }, person.intent);
  assert.equal(await store.radar(person.id), null);
});
test("automatic radar scans only opted-in members and respects the scan interval", async () => {
  const store = createStore(resolve(root, "data/people.json"), resolve(temporary, "monitor.json"));
  const watched = await store.join({ ...profile("Watched builder"), monitor: true });
  const manual = await store.join(profile("Manual builder"));
  const calls = [];
  const models = {
    config: modelConfig({ OPENAI_API_KEY: "test-only-monitor-key" }),
    research: async (person) => { calls.push(person.id); return { items: [] }; }
  };
  const isolated = await start({ store, models, monitor: true, monitorIntervalMs: 20 });
  try {
    const deadline = Date.now() + 2000;
    while (!await store.radar(watched.person.id) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    assert.equal((await store.radar(watched.person.id))?.intent, watched.person.intent);
    await new Promise((done) => setTimeout(done, 80));
    assert.deepEqual(calls, [watched.person.id]);
    assert.equal(await store.radar(manual.person.id), null);
    assert.equal(await store.radar("github:guohai"), null);
  } finally { await close(isolated.instance); }
});
test("production output includes six pages, platform backend, seed data, and no private state", async () => {
  await import("../scripts/build.mjs");
  for (const file of ["account.html", "account.js", "scripts/identity.mjs", "scripts/ledger.mjs", "scripts/credits.mjs", "scripts/billing.mjs", "scripts/connections.mjs", "scripts/plans.mjs", "scripts/persistence.mjs", "scripts/platform-admin.mjs"]) assert.deepEqual(await readFile(resolve(root, "dist", file)), await readFile(resolve(root, file)), file);
  const files = ["index.html", "explore.html", "services.html", "radar.html", "meetings.html", "styles.css", "script.js", "people.js", "activity.js", "explore.js", "services.js", "radar.js", "meetings.js", "call.js", "package.json", "package-lock.json", "assets/favicon.svg", "assets/guohai.jpg", "scripts/serve.mjs", "scripts/store.mjs", "scripts/models.mjs", "scripts/activity.mjs", "scripts/calls.mjs", "scripts/auth.mjs", "stoa.html", "stoa.js", "world/engine.js", "world/sdk.js", "world/map.js", "world/kinds.js", "stoa/stage.js", "world/signaling.js", "worlds/plaza/map.json", "worlds/room/map.json", "scripts/spaces/service.mjs", "scripts/spaces/routes.mjs", "data/people.json", "data/projects.json", "data/offers.json", "data/activity.json", "themes/agora/theme.json", "themes/minimal/theme.json", "themes/cyberpunk/theme.json"];
  for (const file of files) assert.deepEqual(await readFile(resolve(root, "dist", file)), await readFile(resolve(root, file)), file);
  for (const file of [".env", ".data/community.json"]) await assert.rejects(readFile(resolve(root, "dist", file)), { code: "ENOENT" });
  const built = await start({}, resolve(root, "dist"));
  try {
    assert.equal((await request("/meetings.html", { base: built.url })).status, 200);
    assert.equal((await request("/account.html", { base: built.url })).status, 200);
    assert.equal((await request("/assets/agora-rtc.js", { base: built.url })).status, 200);
    assert.equal((await request("/assets/agora-rtm.js", { base: built.url })).status, 200);
    assert.equal((await request("/call.js", { base: built.url })).status, 200);
    assert.equal((await request("/stoa/", { base: built.url })).status, 200);
    assert.equal((await (await request("/api/projects", { base: built.url })).json()).projects.length, 16);
  } finally { await close(built.instance); }
});
test("public activity API returns the feed without exposing runtime files", async () => {
  const data = { items: [{ id: "github:test", source: "github", actorName: "Public builder", action: "pushed code to", subject: "Vox", createdAt: "2026-10-04T10:00:00Z", url: "https://github.com/Agora-Build/Vox" }], github: { status: "fresh", checkedAt: "2026-10-04T12:00:00Z" }, pollAfterSeconds: 60 };
  const isolated = await start({ activity: { get: async () => data } });
  try {
    const response = await request("/api/activity", { base: isolated.url });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), data);
    assert.equal((await request("/scripts/activity.mjs", { base: isolated.url })).status, 404);
    assert.equal((await request("/data/activity.json", { base: isolated.url })).status, 404);
  } finally { await close(isolated.instance); }
});
