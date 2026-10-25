import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAppServer, platformAdmins } from "../scripts/serve.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { createStore } from "../scripts/store.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";

const root = new URL("../", import.meta.url).pathname;
const profile = (name = "Test builder") => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });
let temporary;
let origin;
let server;
const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });
async function start(options = {}, directory = root) {
  const instance = createAppServer(directory, { monitor: false, storageFile: resolve(temporary, Math.random() + ".json"), models: createModelClient(modelConfig({})), calls: createAgoraCalls(agoraConfig({})), idp: null, ...options });
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
  for (const page of ["/", "/explore/", "/marketplaces/", "/radar/", "/account/"]) {
    const response = await request(page);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    const links = new Set([...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]).filter((url) => !url.startsWith("https://")));
    for (const link of links) assert.equal((await fetch(new URL(link, origin + page))).status, 200, link);
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes('id="' + target + '"'), target);
  }
});
test("pages live at clean /name/ URLs; /name and /name.html redirect there with 308, keeping the query", async () => {
  for (const name of ["account", "explore", "marketplaces", "radar"]) {
    const page = await request("/" + name + "/");
    assert.equal(page.status, 200, name);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    // Every internal link and asset is absolute and served directly from the page at /name/, with no redirect.
    for (const [, link] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (link.startsWith("https://")) continue;
      assert.ok(link.startsWith("/"), name + " " + link + " is absolute");
      assert.equal((await fetch(new URL(link, origin + "/" + name + "/"), { redirect: "manual" })).status, link.startsWith("/auth/login") ? 303 : 200, name + " " + link);
    }
    for (const old of ["/" + name, "/" + name + ".html"]) {
      const moved = await fetch(origin + old + "?connected=agora&x=1", { redirect: "manual" });
      assert.deepEqual([moved.status, moved.headers.get("location")], [308, "/" + name + "/?connected=agora&x=1"], old);
    }
  }
  for (const [old, clean] of [["/index.html", "/"], ["/index", "/"], ["/stoa", "/stoa/"], ["/stoa.html?x=1", "/stoa/?x=1"]]) {
    const moved = await fetch(origin + old, { redirect: "manual" });
    assert.deepEqual([moved.status, moved.headers.get("location")], [308, clean], old);
  }
  for (const path of ["/unknown", "/unknown/", "/unknown.html", "/account//", "/account/x", "/Account/", "/styles.css/", "/meetings", "/account.js/"]) assert.equal((await fetch(origin + path, { redirect: "manual" })).status, 404, path);
  assert.equal((await fetch(origin + "/styles.css", { redirect: "manual" })).status, 200, "assets are not redirected");
  assert.equal((await fetch(origin + "/api/projects", { redirect: "manual" })).status, 200, "/api is untouched");
  assert.equal((await fetch(origin + "/api", { redirect: "manual" })).status, 404, "/api is not a page");
  const login = await fetch(origin + "/auth/login?returnTo=%2Faccount.html", { redirect: "manual" });
  assert.deepEqual([login.status, login.headers.get("location")], [303, "/account/?signin=unavailable"], "/auth is untouched and an old returnTo comes back clean");
  assert.equal((await fetch(origin + "/connect/agora", { redirect: "manual" })).headers.get("location"), "/auth/login?returnTo=%2Faccount%2F", "/connect is untouched");
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
test("unconfigured marketplaces report their status and do not fake results", async () => {
  const config = await (await request("/api/marketplaces")).json();
  assert.equal(config.language.ready, false);
  assert.equal(config.speech.ready, false);
  assert.equal(config.radar.ready, false);
  assert.deepEqual(config.offers, []);
  assert.equal((await request("/api/marketplaces/chat", { method: "POST", data: { message: "Help me" } })).status, 503);
  assert.equal((await request("/api/marketplaces/tts", { method: "POST", data: { text: "Hello" } })).status, 503);
  assert.equal((await request("/api/radar", { method: "POST" })).status, 503);
});
test("old meeting links and the rooms API point people to the Stoa", async () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const meet = await fetch(origin + "/meet/" + id + "?invite=abc", { redirect: "manual" });
  assert.deepEqual([meet.status, meet.headers.get("location")], [308, "/stoa/s/" + id + "?invite=abc"]);
  const page = await fetch(origin + "/meetings.html?room=" + id, { redirect: "manual" });
  assert.deepEqual([page.status, page.headers.get("location")], [308, "/stoa/s/" + id]);
  const bare = await fetch(origin + "/meetings.html", { redirect: "manual" });
  assert.deepEqual([bare.status, bare.headers.get("location")], [308, "/stoa/"]);
  for (const [path, method] of [["/api/rooms", "GET"], ["/api/rooms", "POST"], ["/api/rooms/" + id + "/join", "POST"], ["/api/rooms/" + id + "/call", "POST"]]) {
    const response = await fetch(origin + path, { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 410, method + " " + path);
    assert.match((await response.json()).error, /Stoa/);
  }
  for (const file of ["/meetings.js", "/call.js"]) assert.equal((await fetch(origin + file)).status, 404, file);
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
test("the marketplace API preserves provider privacy, requires a signed-in account, and enforces allowances", async () => {
  const config = modelConfig({ OPENAI_API_KEY: "test-only-provider-secret" });
  const models = { config, chat: async () => "Mocked workshop answer", speak: async () => Buffer.from("ID3-mocked-audio"), research: async () => ({ items: [{ kind: "resource", title: "Test source", url: "https://example.com/source", reason: "Relevant to voice agents" }] }), search: async (people) => people };
  const store = createStore(resolve(root, "data/people.json"), resolve(temporary, "marketplaces.json"), { log: () => {} });
  const isolated = await start({ models, modelLimit: 3, store });
  try {
    const publicConfig = await (await request("/api/marketplaces", { base: isolated.url })).text();
    assert.ok(!publicConfig.includes("test-only-provider-secret") && !publicConfig.includes("api.openai.com"));
    assert.equal((await request("/api/marketplaces/chat", { base: isolated.url, method: "POST", data: { message: "Help" } })).status, 401);
    const visitor = await join("Guest tester", isolated.url);
    assert.equal((await request("/api/marketplaces/chat", { base: isolated.url, cookie: visitor.cookie, method: "POST", data: { message: "Help" } })).status, 401, "guests can't use the marketplaces");
    const { token } = await store.signIn({ sub: "ab" + "T".repeat(26), sid: "sid", name: "Marketplace tester", idToken: "id-token" });
    const joined = await request("/api/profile", { base: isolated.url, cookie: "house_session=" + token, method: "POST", data: profile("Marketplace tester") });
    const member = { cookie: joined.headers.get("set-cookie").split(";")[0] };
    const chat = await request("/api/marketplaces/chat", { base: isolated.url, cookie: member.cookie, method: "POST", data: { message: "Help" } });
    assert.equal((await chat.json()).answer, "Mocked workshop answer");
    const speech = await request("/api/marketplaces/tts", { base: isolated.url, cookie: member.cookie, method: "POST", data: { text: "Hello", voice: "coral" } });
    assert.equal(speech.headers.get("content-type"), "audio/mpeg");
    assert.equal(await speech.text(), "ID3-mocked-audio");
    assert.equal((await request("/api/radar", { base: isolated.url, cookie: member.cookie, method: "POST" })).status, 200);
    const privateRadar = await (await request("/api/radar", { base: isolated.url, cookie: member.cookie })).json();
    assert.equal(privateRadar.result.items.length, 1);
    assert.equal((await (await request("/api/radar", { base: isolated.url })).json()).result, null);
    assert.equal((await request("/api/radar", { base: isolated.url, cookie: member.cookie, method: "POST" })).status, 429);
    assert.equal((await request("/api/marketplaces/chat", { base: isolated.url, cookie: member.cookie, method: "POST", data: { message: "More" } })).status, 429);
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
test("the marketplaces page replaced the services page; its old addresses are 404 like any unknown page", async () => {
  const html = await (await request("/marketplaces/")).text();
  assert.match(html, /<title>Marketplaces \| Agora Build<\/title>/);
  assert.match(html, /<a href="\/marketplaces\/" class="is-active" aria-current="page">Marketplaces<\/a>/);
  assert.match(html, /src="\/marketplaces\.js"/);
  for (const old of ["/services/", "/services", "/services.html", "/services.js"]) assert.equal((await fetch(origin + old, { redirect: "manual" })).status, 404, old);
  assert.equal((await request("/api/services")).status, 404, "the old API route is gone");
  assert.equal((await request("/api/services/chat", { method: "POST", data: { message: "Help me" } })).status, 404, "the old chat route is gone");
});
test("production output includes six pages, platform backend, seed data, and no private state", async () => {
  await import("../scripts/build.mjs");
  for (const file of ["account.html", "account.js", "integrations.js", "scripts/idp.mjs", "scripts/return-path.mjs", "scripts/billing-clients.mjs", "scripts/ledger.mjs", "scripts/credits.mjs", "scripts/billing.mjs", "scripts/connections.mjs", "scripts/plans.mjs", "scripts/persistence.mjs", "scripts/platform-admin.mjs", "scripts/agora-shapes.mjs"]) assert.deepEqual(await readFile(resolve(root, "dist", file)), await readFile(resolve(root, file)), file);
  for (const file of ["migrations/001_integrations.sql", "scripts/integrations/db.mjs"]) assert.deepEqual(await readFile(resolve(root, "dist", file)), await readFile(resolve(root, file)), file);
  const files = ["index.html", "explore.html", "marketplaces.html", "radar.html", "styles.css", "script.js", "people.js", "activity.js", "explore.js", "marketplaces.js", "radar.js", "package.json", "package-lock.json", "assets/favicon.svg", "assets/guohai.jpg", "scripts/serve.mjs", "scripts/store.mjs", "scripts/models.mjs", "scripts/activity.mjs", "scripts/calls.mjs", "stoa.html", "stoa.js", "world/engine.js", "world/sdk.js", "world/map.js", "world/kinds.js", "stoa/stage.js", "world/signaling.js", "worlds/plaza/map.json", "worlds/room/map.json", "scripts/spaces/service.mjs", "scripts/spaces/routes.mjs", "data/people.json", "data/projects.json", "data/offers.json", "data/activity.json", "themes/agora/theme.json", "themes/minimal/theme.json", "themes/cyberpunk/theme.json"];
  for (const file of files) assert.deepEqual(await readFile(resolve(root, "dist", file)), await readFile(resolve(root, file)), file);
  for (const file of [".env", ".data/community.json", "scripts/auth.mjs", "scripts/identity.mjs"]) await assert.rejects(readFile(resolve(root, "dist", file)), { code: "ENOENT" });
  const built = await start({}, resolve(root, "dist"));
  try {
    assert.equal((await request("/account/", { base: built.url })).status, 200);
    assert.equal((await request("/assets/agora-rtc.js", { base: built.url })).status, 200);
    assert.equal((await request("/assets/agora-rtm.js", { base: built.url })).status, 200);
    for (const file of ["meetings.html", "meetings.js", "call.js"]) await assert.rejects(readFile(resolve(root, "dist", file)), { code: "ENOENT" });
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
// /auth/login allows 20 requests a minute per client address.
async function loginsUntilLimited(base, forwarded) {
  const statuses = [];
  for (const hops of forwarded) statuses.push((await fetch(base + "/auth/login", { redirect: "manual", headers: hops ? { "X-Forwarded-For": hops } : {} })).status);
  return statuses;
}
test("without TRUST_PROXY, IP limits use the socket address and ignore X-Forwarded-For", async () => {
  const { instance, url } = await start({ trustProxy: "0" });
  try {
    const statuses = await loginsUntilLimited(url, Array.from({ length: 21 }, (_, index) => "203.0.113." + index));
    assert.deepEqual([statuses.slice(0, 20).every((status) => status === 303), statuses[20]], [true, 429]);
  } finally { await close(instance); }
});
test("with TRUST_PROXY=1, IP limits use the last X-Forwarded-For hop only", async () => {
  const { instance, url } = await start({ trustProxy: "1" });
  try {
    // A client can prepend anything; only the hop the trusted proxy appended counts.
    const spoofed = Array.from({ length: 21 }, (_, index) => "198.51.100." + index + ", 203.0.113.7");
    const statuses = await loginsUntilLimited(url, spoofed);
    assert.deepEqual([statuses.slice(0, 20).every((status) => status === 303), statuses[20]], [true, 429]);
    assert.equal((await loginsUntilLimited(url, ["198.51.100.1, 203.0.113.8"]))[0], 303, "another client behind the proxy has its own allowance");
    assert.equal((await loginsUntilLimited(url, [""]))[0], 303, "without the header the socket address is used");
  } finally { await close(instance); }
});

test("PLATFORM_ADMINS keeps only ab… account IDs and logs how many it ignored, never which", () => {
  const admin = "ab01M5KE40Z7VPK97NJS49W8QQSD", lines = [];
  assert.deepEqual(platformAdmins(" " + admin + ", acct_01M5KE40Z7VPK97NJS49W8QQSD,,member:11111111-1111-4111-8111-111111111111 ", (line) => lines.push(line)), [admin]);
  assert.deepEqual(lines, ["PLATFORM_ADMINS: ignored 2 entries that are not auth.agora.build account IDs."]);
  assert.deepEqual(platformAdmins(undefined, (line) => lines.push(line)), []);
  assert.deepEqual(platformAdmins(admin, (line) => lines.push(line)), [admin]);
  assert.equal(lines.length, 1);
});
