import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { githubEvents, createActivityFeed } from "../scripts/activity.mjs";
import { createStore } from "../scripts/store.mjs";

const projects = [{ name: "Vox" }, { name: "Atem" }];
const seedFile = new URL("../data/people.json", import.meta.url).pathname;
const projectsFile = new URL("../data/projects.json", import.meta.url).pathname;
const snapshotFile = new URL("../data/activity.json", import.meta.url).pathname;
const event = (change = {}) => ({ id: "123", public: true, type: "PushEvent", created_at: "2026-10-04T10:00:00Z", actor: { login: "guohai" }, repo: { name: "Agora-Build/Vox" }, payload: { ref: "refs/heads/main", head: "a".repeat(40) }, ...change });
const member = (name) => ({ name, bio: "Working on voice agents.", intent: "Build a language practice agent.", skills: ["Rust"], contact: "https://example.com/member", monitor: false });

test("GitHub events preserve facts and timestamps, reject unrelated or private events, and deduplicate IDs", () => {
  const output = githubEvents([
    event(), event(), event({ id: "private", public: false }), event({ id: "unrelated", repo: { name: "other/Vox" } }),
    event({ id: "unknown", type: "WatchEvent" }), event({ id: "invalid-date", created_at: "no-date" }),
    event({ id: "pull", type: "PullRequestEvent", created_at: "2026-10-04T11:00:00Z", payload: { action: "closed", pull_request: { merged: true, title: "Handle voice interruptions", html_url: "javascript:alert(1)" } } })
  ], projects);
  assert.equal(output.length, 2);
  assert.equal(output[0].action, "merged a pull request in");
  assert.equal(output[0].url, "https://github.com/Agora-Build/Vox");
  assert.equal(output[1].action, "pushed code to");
  assert.equal(output[1].detail, "main");
  assert.equal(output[1].createdAt, "2026-10-04T10:00:00Z");
  assert.equal(output[1].url, "https://github.com/Agora-Build/Vox/commit/" + "a".repeat(40));
  assert.equal(output[1].commitMessage, undefined);
});

test("concurrent activity requests share a GitHub refresh; ETags and cache windows avoid extra requests", async () => {
  let calls = 0;
  let timestamp = Date.parse("2026-10-04T12:00:00Z");
  const store = { people: async () => [{ id: "github:guohai", username: "guohai", name: "Brent G" }], activity: async () => [] };
  const feed = createActivityFeed({ store, projectsFile, now: () => timestamp, request: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.github.com/orgs/Agora-Build/events?per_page=30");
    await new Promise((done) => setTimeout(done, 10));
    if (calls === 1) return Response.json([event()], { headers: { etag: '"feed-1"' } });
    assert.equal(options.headers["If-None-Match"], '"feed-1"');
    return new Response(null, { status: 304 });
  } });
  const responses = await Promise.all([feed.get(), feed.get(), feed.get()]);
  assert.equal(calls, 1);
  assert.ok(responses.every((response) => response.items.length === 1 && response.github.status === "fresh"));
  assert.equal(responses[0].items[0].actorName, "Brent G");
  assert.equal(responses[0].items[0].canViewProfile, true);
  await feed.get();
  assert.equal(calls, 1);
  timestamp += 121000;
  const unchanged = await feed.get();
  assert.equal(calls, 2);
  assert.equal(unchanged.items.length, 1);
  assert.equal(unchanged.github.checkedAt, new Date(timestamp).toISOString());
});

test("GitHub outages retain explicitly labeled sourced history and honor rate-limit backoff", async () => {
  let calls = 0;
  let timestamp = Date.parse("2026-10-04T12:00:00Z");
  const store = { people: async () => [], activity: async () => [] };
  const feed = createActivityFeed({ store, projectsFile, snapshotFile, now: () => timestamp, request: async () => {
    calls++;
    return new Response("Unavailable", { status: 403, headers: { "x-ratelimit-reset": String(timestamp / 1000 + 900) } });
  } });
  const saved = await feed.get();
  assert.equal(saved.github.status, "unavailable");
  assert.ok(saved.github.checkedAt);
  assert.ok(saved.items.length > 0);
  assert.ok(saved.items.every((item) => item.source === "github" && item.url.startsWith("https://github.com/Agora-Build/")));
  timestamp += 121000;
  await feed.get();
  assert.equal(calls, 1);
});

test("community activity records actual joins and intent changes, excludes repeat roster joins, and removes deleted identities", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "agora-activity-test-"));
  try {
    const store = createStore(seedFile, resolve(directory, "community.json"));
    const host = await store.join(member("Host builder"));
    const guest = await store.join(member("Guest builder"));
    const room = await store.createRoom(host.token, { title: "Voice workshop", intent: "Compare latency approaches." });
    await store.joinRoom(guest.token, room.id);
    await store.joinRoom(guest.token, room.id);
    await store.edit(guest.token, { ...member("Renamed builder"), intent: "Build an audio device tool." });
    const events = await store.activity();
    assert.equal(events.length, 5);
    assert.equal(events.filter((entry) => entry.kind === "room-join").length, 1);
    assert.ok(events.filter((entry) => entry.actorId === guest.person.id).every((entry) => entry.actorName === "Renamed builder"));
    assert.ok(events.every((entry) => Number.isFinite(Date.parse(entry.createdAt))));
    assert.ok(!JSON.stringify(events).includes("sessionHash") && !JSON.stringify(events).includes(host.token));
    await store.remove(host.token);
    assert.ok((await store.activity()).every((entry) => entry.actorId !== host.person.id && entry.roomId !== room.id));
    await store.remove(guest.token);
    assert.deepEqual(await store.activity(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
