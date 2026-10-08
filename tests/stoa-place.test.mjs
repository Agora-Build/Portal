import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseMap } from "../world/map.js";
import { openPlace } from "../stoa/place.js";
import { createLease } from "../stoa/lease.js";

const plaza = parseMap(JSON.parse(await readFile(new URL("../worlds/plaza/map.json", import.meta.url), "utf8")));
const me = "a-72a639ba-3a45-4afe-936b-111111111111", ada = "a-72a639ba-3a45-4afe-936b-222222222222", bo = "m-72a639ba-3a45-4afe-936b-333333333333";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const state = (x, y, name) => ({ x: String(x), y: String(y), dir: "down", name });

function fakeLive({ guest = false, who = [] } = {}) {
  return {
    userId: guest ? "g-0123456789abcdef" : me, guest, joined: [], left: [], published: [], states: [], handlers: null,
    async join(name, options, handlers) { this.joined.push([name, options]); this.handlers = handlers; },
    async leave(name) { this.left.push(name); },
    async publish(name, text) { this.published.push(JSON.parse(text)); },
    async setState(name, value) { this.states.push([name, value]); },
    async who() { return who; }
  };
}
function fakeEngine() {
  const listeners = {};
  return {
    said: [],
    on(type, listener) { (listeners[type] ||= []).push(listener); return () => { listeners[type] = listeners[type].filter((item) => item !== listener); }; },
    emit(type, value) { for (const listener of listeners[type] || []) listener(value); },
    position() { return { x: 21, y: 17 }; }, facing() { return "up"; },
    say(text) { this.said.push(text); }
  };
}
async function opened({ guest = false, who = [], now = () => 1000, later } = {}) {
  const live = fakeLive({ guest, who }), engine = fakeEngine(), seen = { people: [], said: [], refreshed: 0 };
  const place = await openPlace({ live, map: plaza, engine, self: { name: "Me" }, channel: { name: "ab-stoa-plaza", key: null, spaceId: "plaza" }, onPeople: (list) => { seen.people = list; }, onSay: (entry) => seen.said.push(entry), onRefresh: () => { seen.refreshed += 1; }, now, later });
  return { live, engine, place, seen };
}

test("opening a place joins its channel, shows who is there, and shares where you stand", async () => {
  const { live, place, seen } = await opened({ who: [{ userId: ada, states: state(22, 17, "Ada") }] });
  assert.deepEqual(live.joined, [["ab-stoa-plaza", { spaceId: "plaza", key: null }]]);
  assert.deepEqual(seen.people.map((person) => person.name), ["Ada"]);
  assert.deepEqual(live.states, [["ab-stoa-plaza", { x: "21", y: "17", dir: "up", name: "Me" }]]);
  assert.equal(place.channel, "ab-stoa-plaza");
  assert.deepEqual(place.people().map((person) => person.name), ["Ada"]);
});
test("movement is published within the rate limit, keeping the latest pending message", async () => {
  let time = 0; const timers = [];
  const { live, engine } = await opened({ now: () => time, later: (callback) => { timers.push(callback); return timers.length; } });
  for (let index = 0; index < 6; index += 1) engine.emit("move", { path: [{ x: 21, y: 17 }, { x: 21, y: 16 }], startedAt: index });
  await tick();
  assert.deepEqual(live.published.map((message) => message.startedAt), [0, 1, 2, 3]);
  time = 250; timers[0](); await tick();
  assert.deepEqual(live.published.map((message) => message.startedAt), [0, 1, 2, 3, 5]);
  time = 10000;
  engine.emit("walk", { from: { x: 21, y: 17 }, dir: "up", startedAt: 10000 });
  engine.emit("stop", { at: { x: 21, y: 15 } });
  engine.emit("face", { dir: "left" });
  engine.emit("arrive", { x: 21, y: 15 });
  await tick();
  assert.deepEqual(live.published.slice(-4), [{ t: "walk", from: { x: 21, y: 17 }, dir: "up", startedAt: 10000 }, { t: "stop", at: { x: 21, y: 15 } }, { t: "face", dir: "left" }, { t: "stop", at: { x: 21, y: 15 } }]);
  assert.equal(live.states.length, 2, "arriving shares the new resting place");
});
test("messages and presence from others reach the people list and the message log", async () => {
  const { live, seen } = await opened({ who: [{ userId: ada, states: state(22, 17, "Ada") }] });
  live.handlers.message(ada, JSON.stringify({ t: "say", text: "Hi all" }));
  assert.deepEqual(seen.said, [{ name: "Ada", text: "Hi all", self: false }]);
  assert.equal(seen.people[0].bubble.text, "Hi all");
  live.handlers.message(ada, JSON.stringify({ t: "refresh" }));
  assert.equal(seen.refreshed, 1);
  live.handlers.presence({ type: "state", userId: bo, states: state(20, 17, "Bo") });
  assert.deepEqual(seen.people.map((person) => person.name), ["Ada", "Bo"]);
  live.handlers.presence({ type: "leave", userId: ada });
  assert.deepEqual(seen.people.map((person) => person.name), ["Bo"]);
  live.handlers.presence({ type: "snapshot", people: [{ userId: ada, states: state(22, 17, "Ada") }] });
  assert.deepEqual(seen.people.map((person) => person.name), ["Ada"]);
});
test("saying something publishes it, shows your bubble, and respects the chat limit", async () => {
  const { live, engine, place, seen } = await opened();
  assert.equal(place.say("  hello  "), true);
  await tick();
  assert.deepEqual(live.published.at(-1), { t: "say", text: "hello" });
  assert.deepEqual(engine.said, ["hello"]);
  assert.deepEqual(seen.said, [{ name: "Me", text: "hello", self: true }]);
  assert.equal(place.say("two"), true);
  assert.equal(place.say("three"), true);
  assert.equal(place.say("four"), false, "a fourth message in the same second is refused");
  assert.equal(place.say("   "), false);
  place.refresh(); await tick();
  assert.deepEqual(live.published.at(-1), { t: "refresh" });
});
test("guests only watch", async () => {
  const { live, engine, place } = await opened({ guest: true });
  engine.emit("move", { path: [{ x: 21, y: 17 }, { x: 21, y: 16 }], startedAt: 1 });
  await tick();
  assert.deepEqual([live.published, live.states, place.say("hi")], [[], [], false]);
});
test("closing leaves the channel and stops publishing; blocked people are dropped", async () => {
  const { live, engine, place, seen } = await opened({ who: [{ userId: ada, states: state(22, 17, "Ada") }] });
  place.setBlocked(["account:72a639ba-3a45-4afe-936b-222222222222"]);
  assert.deepEqual(seen.people, []);
  await place.close();
  assert.deepEqual(live.left, ["ab-stoa-plaza"]);
  engine.emit("move", { path: [{ x: 21, y: 17 }, { x: 21, y: 16 }], startedAt: 1 });
  live.handlers.presence({ type: "state", userId: bo, states: state(20, 17, "Bo") });
  await tick();
  assert.deepEqual([live.published, seen.people], [[], []]);
});
test("the lease heartbeats, reports access, survives passing errors, and ends cleanly", async () => {
  const calls = [], beacons = [], accesses = [], losses = [];
  let beat, stopped = 0;
  const replies = [{ channel: "c2", key: null, blocked: [], hostId: null }];
  const api = async (path, options) => {
    calls.push([path, options?.method]);
    if (!path.endsWith("/heartbeat")) return { left: true };
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const lease = createLease({ api, spaceId: "lot-rtc-lab", onAccess: (access) => accesses.push(access), onLost: (error) => losses.push(error.status), repeat: (callback, every) => { beat = callback; assert.equal(every, 20000); return 7; }, stopRepeat: () => { stopped += 1; }, beacon: (url) => beacons.push(url) });
  await beat();
  assert.deepEqual(accesses, [{ channel: "c2", key: null, blocked: [], hostId: null }]);
  replies.push(Object.assign(new Error("Busy"), { status: 500 }));
  await beat();
  assert.deepEqual(losses, []);
  replies.push(Object.assign(new Error("Gone"), { status: 410 }));
  await beat();
  assert.deepEqual([losses, stopped], [[410], 1]);
  await lease.leave();
  assert.deepEqual(calls.at(-1), ["/api/spaces/lot-rtc-lab/leave", "POST"]);
  lease.leaveOnUnload();
  assert.deepEqual(beacons, ["/api/spaces/lot-rtc-lab/leave"]);
});
test("arriving always settles peers on your real tile, even when the budget is spent", async () => {
  const timers = []; let time = 5000;
  const { live, engine } = await opened({ now: () => time, later: (callback) => { timers.push(callback); return timers.length; } });
  const route = { path: [{ x: 21, y: 17 }, { x: 21, y: 16 }], startedAt: 1 };
  for (let index = 0; index < 4; index += 1) engine.emit("move", route);
  engine.emit("walk", { from: { x: 21, y: 17 }, dir: "up", startedAt: 2 });
  engine.emit("stop", { at: { x: 21, y: 16 } });
  engine.emit("face", { dir: "left" });
  engine.emit("arrive", { x: 21, y: 15 });
  await tick();
  assert.equal(live.published.length, 4);
  time = 5250; timers[0](); await tick();
  assert.deepEqual(live.published.at(-1), { t: "stop", at: { x: 21, y: 15 } });
});
test("a failed snapshot leaves the channel and rejects", async () => {
  const live = fakeLive(); live.who = async () => { throw new Error("down"); };
  await assert.rejects(openPlace({ live, map: plaza, engine: fakeEngine(), self: { name: "Me" }, channel: { name: "ab-stoa-plaza", key: null, spaceId: "plaza" } }), /down/);
  assert.deepEqual(live.left, ["ab-stoa-plaza"]);
});
test("a heartbeat in flight when the lease stops reports nothing", async () => {
  const accesses = [], losses = [], pending = [];
  let beat;
  const api = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const lease = createLease({ api, spaceId: "s", onAccess: (a) => accesses.push(a), onLost: (e) => losses.push(e), repeat: (callback) => { beat = callback; return 1; }, stopRepeat: () => {}, beacon: () => {} });
  const first = beat(), second = beat();
  lease.stop();
  pending[0].resolve({ channel: "c" });
  pending[1].reject(Object.assign(new Error("Gone"), { status: 410 }));
  await first; await second;
  assert.deepEqual([accesses, losses], [[], []]);
});
