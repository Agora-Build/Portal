import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseMap } from "../world/map.js";
import { createStage } from "../stoa/stage.js";

const plaza = parseMap(JSON.parse(await readFile(new URL("../worlds/plaza/map.json", import.meta.url), "utf8")));
const lot = plaza.lots[0];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };
const space = (id, title = id) => ({ id, title, topic: null, tags: [], visibility: "public" });

function setup({ api, signedIn = true, withLive = true, clock = { time: 0, timers: [] }, ...options } = {}) {
  const calls = { decor: [], teleports: [], bounds: [], interactive: null, published: [], states: [], canTalk: [], reasons: [], showRoom: [], offer: 0, joined: [], left: [], others: 0, people: 0, handlers: {}, quiet: {} };
  const frames = [];
  const live = !withLive ? null : {
    userId: "a-me", guest: false, renew: async () => {},
    join: async (name, options, handlers) => { calls.joined.push(name); calls.handlers[name] = handlers; calls.quiet[name] = options.quiet; }, leave: async (name) => { calls.left.push(name); },
    publish: async (name, text) => { calls.published.push(text); }, setState: async (name, text) => { calls.states.push(text); }, who: async () => []
  };
  const handlers = {}, pos = { x: lot.door.x, y: lot.door.y };
  const engine = {
    teleport: (tile) => { calls.teleports.push(tile); }, setBounds: (bounds) => { calls.bounds.push(bounds); }, setOthers() { calls.others += 1; }, position: () => pos, setDecor: (list) => { calls.decor.push(list); }, setInteractive: (value) => { calls.interactive = value; }, facing: () => "down", say() {}, walkTo: () => true,
    on(name, handler) { handlers[name] = handler; return () => {}; }
  };
  const panel = {
    said: [], say(message) { this.said.push(message); }, setPeople() { calls.people += 1; }, addMessage(entry) { this.added = (this.added || 0) + 1; }, clearMessages() {}, showPlaza() {}, hideOffer() {},
    canTalk: (value, reason) => { calls.canTalk.push(value); calls.reasons.push(reason); }, showRoom: (room) => calls.showRoom.push(room), showOffer: () => { calls.offer += 1; }
  };
  const leases = [];
  const createLease = (options) => { const entry = { options, active: true, stop() { entry.active = false; }, async leave() { entry.active = false; }, leaveOnUnload() { entry.active = false; }, beatNow() { entry.beats = (entry.beats || 0) + 1; return Promise.resolve(); } }; leases.push(entry); return entry; };
  const stage = createStage({ api, map: plaza, engine, panel, live, self: { id: "a-me", name: "Me", signedIn }, plaza: { bounds: null, channel: "plaza-1" }, createLease, schedule: (callback) => frames.push(callback), now: () => clock.time, later: (callback, delay) => { clock.timers.push({ callback, delay }); return clock.timers.length; }, ...options });
  const flushFrames = () => { for (const callback of frames.splice(0)) callback(); };
  return { stage, calls, panel, leases, handlers, live, flushFrames, clock };
}
const access = (id, channel) => ({ space: space(id), channel, key: null, blocked: [], hostId: "a-me" });

test("a full plaza is watched quietly with the offer shown", async () => {
  const api = async (path) => { const error = new Error("full"); error.status = 409; error.data = { full: true, offer: { spaces: [], canCreate: true } }; throw error; };
  const { stage, calls, handlers } = setup({ api });
  await stage.toPlaza(null);
  assert.equal(calls.offer, 1);
  assert.deepEqual(calls.joined, ["plaza-1"]);
  assert.deepEqual(calls.states, []);
  assert.equal(calls.canTalk.at(-1), false);
  handlers.move?.({ path: [], startedAt: 0 });
  handlers.arrive?.({ x: 1, y: 1 });
  await tick();
  assert.deepEqual(calls.published, []);
  assert.deepEqual(calls.states, []);
  assert.equal(stage.say("hello"), false);
  assert.match(stage.watchNotice(lot), /plaza is full/);
});

test("a lost lease racing a lot entry leaves exactly one active lease", async () => {
  for (const order of ["lot-first", "lost-first"]) {
    const lotEnter = deferred();
    const api = async (path) => {
      if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
      if (path.endsWith("/enter")) return lotEnter.promise;
      return {};
    };
    const { stage, leases } = setup({ api });
    await stage.toPlaza(null);
    const plazaLease = leases[0];
    const entering = stage.enterLot(lot);
    await tick();
    const lose = () => plazaLease.options.onLost({ status: 410 });
    if (order === "lost-first") { lose(); await tick(); lotEnter.resolve(access("lot-" + lot.slug, "lot-ch")); }
    else { lotEnter.resolve(access("lot-" + lot.slug, "lot-ch")); await entering; lose(); }
    await entering; await tick(); await tick();
    assert.equal(leases.filter((entry) => entry.active).length, 1, order);
  }
});

test("a room refresh that finishes after leaving does not redraw the room", async () => {
  const refresh = deferred();
  let first = true;
  const api = async (path) => {
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return access("lot-" + lot.slug, "lot-ch");
    if (path.includes("/leave")) return {};
    if (path.startsWith("/api/spaces/lot-")) return refresh.promise;
    return {};
  };
  const { stage, calls, leases } = setup({ api });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  const before = calls.showRoom.length;
  leases.at(-1).options.onAccess({ channel: "lot-ch", hostId: "someone-else", blocked: [] });
  await tick();
  await stage.leaveRoom();
  refresh.resolve({ space: space("lot-" + lot.slug) });
  await tick(); await tick();
  assert.equal(calls.showRoom.length, before);
});

test("a failed lot entry queued behind a lost plaza lease ends on the plaza with one lease", async () => {
  const lotEnter = deferred();
  let plazaEnters = 0;
  const api = async (path) => {
    if (path === "/api/spaces/plaza/enter") { plazaEnters += 1; return access("plaza", "plaza-1"); }
    if (path.endsWith("/enter")) return lotEnter.promise;
    return {};
  };
  const { stage, leases, calls } = setup({ api });
  await stage.toPlaza(null);
  const first = leases[0];
  const entering = stage.enterLot(lot);
  await tick();
  first.options.onLost({ status: 410 });
  const error = new Error("full"); error.status = 409;
  lotEnter.reject(error);
  await entering; await tick(); await tick();
  assert.equal(plazaEnters, 2, "the lost plaza lease is re-entered once the failed lot entry is done");
  assert.equal(leases.filter((entry) => entry.active).length, 1);
  assert.equal(calls.interactive, true);
});

test("overlapping returns to the plaza never leave the plaza and keep one lease", async () => {
  const paths = [];
  const api = async (path) => {
    paths.push(path);
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return access("lot-" + lot.slug, "lot-ch");
    return {};
  };
  const { stage, leases } = setup({ api });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  const lotLease = leases.at(-1);
  lotLease.options.onLost({ status: 410 });
  const back = stage.leaveRoom();
  await Promise.all([back, stage.toPlaza(null)]);
  await tick();
  assert.ok(!paths.includes("/api/spaces/plaza/leave"));
  assert.equal(leases.filter((entry) => entry.active).length, 1);
});

test("a lost report from a replaced lease is ignored", async () => {
  const api = async (path) => path.endsWith("/enter") ? access(path.includes("lot-") ? "lot-" + lot.slug : "plaza", path.includes("lot-") ? "lot-ch" : "plaza-1") : {};
  const { stage, leases, calls } = setup({ api });
  await stage.toPlaza(null);
  const old = leases[0];
  await stage.enterLot(lot);
  const count = leases.length, rooms = calls.showRoom.length;
  old.options.onLost({ status: 410 });
  await tick(); await tick();
  assert.equal(leases.length, count);
  assert.equal(leases.filter((entry) => entry.active).length, 1);
  assert.equal(calls.showRoom.length, rooms);
});

test("arriving on a lot door enters it and arriving on its exit leaves", async () => {
  const paths = [];
  const api = async (path) => {
    paths.push(path);
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return access("lot-" + lot.slug, "lot-ch");
    return {};
  };
  const { stage, calls, leases } = setup({ api });
  await stage.toPlaza(null);
  stage.onArrive(lot.door);
  await tick(); await tick(); await tick();
  assert.ok(paths.includes("/api/spaces/lot-" + lot.slug + "/enter"));
  assert.deepEqual(calls.teleports.at(-1), lot.entry);
  assert.deepEqual(calls.bounds.at(-1), lot.interior);
  stage.onArrive({ x: lot.entry.x, y: lot.entry.y + 1 });
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(leases.at(-1).options.spaceId, "plaza");
  assert.ok(!leases.find((entry) => entry.options.spaceId === "lot-" + lot.slug).active);
  assert.notDeepEqual(calls.bounds.at(-1), lot.interior);
  assert.equal(leases.filter((entry) => entry.active).length, 1);
});

test("a guest arriving on a door is asked to sign in without calling the API", async () => {
  const paths = [];
  const { stage, panel } = setup({ signedIn: false, api: async (path) => { paths.push(path); return {}; } });
  await stage.toPlaza(null);
  stage.onArrive(lot.door);
  await tick();
  assert.equal(panel.said.at(-1), "Sign in to step into " + lot.title + ".");
  assert.deepEqual(paths, []);
});

const hostUser = "a-72a639ba-3a45-4afe-936b-222222222222", hostActor = "account:72a639ba-3a45-4afe-936b-222222222222", guestUser = "a-72a639ba-3a45-4afe-936b-333333333333";
const present = (userId, name) => ({ userId, states: { x: String(lot.entry.x), y: String(lot.entry.y), dir: "down", name } });

test("many presence events in one frame update the engine and panel once", async () => {
  const api = async (path) => path.endsWith("/enter") ? access("plaza", "plaza-1") : {};
  const { stage, calls, flushFrames } = setup({ api });
  await stage.toPlaza(null);
  flushFrames();
  const [othersBefore, peopleBefore] = [calls.others, calls.people];
  const handlers = calls.handlers["plaza-1"];
  for (let index = 0; index < 50; index += 1) handlers.presence({ type: "state", userId: "a-72a639ba-3a45-4afe-936b-" + String(index).padStart(12, "0"), states: { x: String(lot.door.x), y: String(lot.door.y + 1), dir: "down", name: "P" + index } });
  assert.equal(calls.others, othersBefore, "nothing is drawn until the frame");
  flushFrames();
  assert.deepEqual([calls.others - othersBefore, calls.people - peopleBefore], [1, 1]);
});

async function inLot({ hostBy = hostActor } = {}) {
  const gets = [], refreshes = [];
  const api = async (path) => {
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return { ...access("lot-" + lot.slug, "lot-ch"), hostId: hostBy };
    if (path.startsWith("/api/spaces/lot-") && !path.includes("/leave")) { gets.push(path); const wait = deferred(); refreshes.push(wait); return wait.promise; }
    return {};
  };
  const env = setup({ api });
  await env.stage.toPlaza(null);
  await env.stage.enterLot(lot);
  const handlers = env.calls.handlers["lot-ch"];
  handlers.presence({ type: "snapshot", people: [present(hostUser, "Host"), present(guestUser, "Visitor")] });
  const say = (user) => handlers.message(user, JSON.stringify({ t: "refresh" }));
  return { ...env, gets, refreshes, say };
}

test("refresh requests are coalesced to one in flight and one every five seconds", async () => {
  const { gets, refreshes, say, clock } = await inLot();
  for (let index = 0; index < 10; index += 1) say(hostUser);
  await tick();
  assert.equal(gets.length, 1, "one request while the first is in flight");
  refreshes[0].resolve({ space: space("lot-" + lot.slug) });
  await tick(); await tick();
  assert.equal(gets.length, 1, "the trailing request waits for the gap");
  assert.equal(clock.timers.length, 1);
  assert.ok(clock.timers[0].delay > 0 && clock.timers[0].delay <= 5000);
  clock.time += 5000; clock.timers[0].callback();
  await tick();
  assert.equal(gets.length, 2);
});

test("refresh messages from anyone but the host are ignored", async () => {
  const { gets, say } = await inLot();
  say(guestUser);
  await tick();
  assert.equal(gets.length, 0);
  say(hostUser);
  await tick();
  assert.equal(gets.length, 1);
});

test("a lease lost with 410 in a lot or space re-enters once; 403 still ends it", async () => {
  for (const [status, expected] of [[410, "reentered"], [403, "removed"]]) {
    const paths = [];
    const api = async (path) => {
      paths.push(path);
      if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
      if (path.endsWith("/enter")) return access("lot-" + lot.slug, "lot-ch");
      return {};
    };
    const { stage, leases, calls } = setup({ api });
    await stage.toPlaza(null);
    await stage.enterLot(lot);
    const lotEnters = () => paths.filter((path) => path === "/api/spaces/lot-" + lot.slug + "/enter").length;
    leases.at(-1).options.onLost({ status });
    for (let i = 0; i < 6; i += 1) await tick();
    if (expected === "reentered") {
      assert.equal(lotEnters(), 2);
      assert.deepEqual(calls.bounds.at(-1), lot.interior);
    } else {
      assert.equal(lotEnters(), 1);
      assert.notDeepEqual(calls.bounds.at(-1), lot.interior);
    }
    assert.equal(leases.filter((entry) => entry.active).length, 1, String(status));
  }
});

test("a lost space lease re-enters with the same invite, then reports it gone if that fails", async () => {
  const bodies = []; let fail = false;
  const api = async (path, options) => {
    if (path.endsWith("/enter")) { bodies.push(options?.body); if (fail) { const error = new Error("hidden"); error.status = 404; throw error; } return access("sp-1", "sp-ch"); }
    return {};
  };
  const { stage, leases, panel, calls } = setup({ api });
  await stage.openSpace("sp-1", "inv");
  leases.at(-1).options.onLost({ status: 410 });
  for (let i = 0; i < 6; i += 1) await tick();
  assert.deepEqual(bodies, ['{"invite":"inv"}', '{"invite":"inv"}']);
  fail = true;
  leases.at(-1).options.onLost({ status: 410 });
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(panel.said.at(-1), "You're no longer in this space.");
  assert.equal(calls.canTalk.at(-1), false);
  assert.equal(calls.reasons.at(-1), "You're no longer in this space.");
});

test("signed-in watchers of a full plaza are told why, not asked to sign in", async () => {
  const api = async () => { const error = new Error("full"); error.status = 409; error.data = { full: true, offer: { spaces: [], canCreate: false } }; throw error; };
  const { stage, calls } = setup({ api });
  await stage.toPlaza(null);
  assert.equal(calls.canTalk.at(-1), false);
  assert.match(calls.reasons.at(-1), /plaza is full/);
  assert.equal(calls.quiet["plaza-1"], true, "watchers subscribe quietly");
  const guest = setup({ api, signedIn: false });
  await guest.stage.toPlaza(null);
  assert.equal(guest.calls.reasons.at(-1), undefined);
});

test("a message that fails to send is reported in the status line", async () => {
  const api = async (path) => path.endsWith("/enter") ? access("plaza", "plaza-1") : {};
  const { stage, panel, live } = setup({ api });
  await stage.toPlaza(null);
  live.publish = async () => { throw new Error("offline"); };
  assert.equal(stage.say("hello"), true);
  await tick(); await tick();
  assert.equal(panel.said.at(-1), "That message didn't send.");
});

test("connecting live after the stage started opens the current place's channel", async () => {
  const api = async (path) => path.endsWith("/enter") ? access("plaza", "plaza-1") : {};
  const { stage, calls, live } = setup({ api, withLive: false });
  await stage.toPlaza(null);
  assert.deepEqual(calls.joined, []);
  const later = setup({ api }).live;
  const joined = [];
  later.join = async (name, options, handlers) => { joined.push([name, options.quiet]); calls.handlers[name] = handlers; };
  await stage.attachLive(later, "plaza-1");
  assert.deepEqual(joined, [["plaza-1", false]]);
});

test("connecting live while watching the plaza joins it quietly", async () => {
  const api = async () => { const error = new Error("full"); error.status = 409; error.data = { full: true, offer: { spaces: [], canCreate: false } }; throw error; };
  const { stage } = setup({ api, withLive: false });
  await stage.toPlaza(null);
  const joined = [], later = { userId: "a-me", guest: false, renew: async () => {}, join: async (name, options) => { joined.push([name, options.quiet]); }, leave: async () => {}, publish: async () => {}, setState: async () => {}, who: async () => [] };
  await stage.attachLive(later, "plaza-1");
  assert.deepEqual(joined, [["plaza-1", true]]);
});

test("the call follows the room: one callback per room entered or left, not per channel change", async () => {
  const rooms = [];
  const api = async (path) => path === "/api/spaces/plaza/enter" ? access("plaza", "plaza-1") : path.endsWith("/enter") ? access("lot-" + lot.slug, "lot-ch") : {};
  const { stage, leases } = setup({ api, onRoom: (room) => rooms.push(room ? room.id : null) });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  leases.at(-1).options.onAccess({ channel: "lot-ch-2", key: null, blocked: [], hostId: "a-me" });
  await tick(); await tick();
  await stage.leaveRoom();
  assert.deepEqual(rooms, ["lot-" + lot.slug, null]);
});
test("the merged people list is kept and reported each time it is rebuilt", async () => {
  const lists = [];
  const api = async (path) => path === "/api/spaces/plaza/enter" ? access("plaza", "plaza-1") : {};
  const { stage, calls, flushFrames } = setup({ api, onPeople: (list) => lists.push(list.map((person) => person.name)) });
  await stage.toPlaza(null);
  calls.handlers["plaza-1"].presence({ type: "snapshot", people: [{ userId: "a-72a639ba-3a45-4afe-936b-222222222222", states: { x: String(lot.door.x), y: String(lot.door.y + 1), dir: "down", name: "Ada" } }] });
  flushFrames();
  assert.deepEqual(lists.at(-1), ["Ada"]);
  assert.deepEqual(stage.people().map((person) => person.name), ["Ada"]);
});

test("a room's saved decorations are shown on entry and cleared on the plaza", async () => {
  const items = [{ id: "d1", kind: "plant", x: lot.entry.x + 1, y: lot.entry.y, rotation: 0, variant: 0 }];
  const api = async (path) => path === "/api/spaces/plaza/enter" ? access("plaza", "plaza-1") : path.endsWith("/enter") ? { ...access("lot-" + lot.slug, "lot-ch"), space: { ...space("lot-" + lot.slug), decor: items } } : {};
  const { stage, calls } = setup({ api });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  assert.deepEqual(calls.decor.at(-1), items);
  assert.deepEqual(stage.decor(), items);
  await stage.leaveRoom();
  assert.deepEqual(calls.decor.at(-1), []);
});
test("saving decorations stores them, shows them, and tells the room the new version", async () => {
  const saved = [{ id: "d2", kind: "lamp", x: lot.entry.x, y: lot.entry.y - 1, rotation: 0, variant: 0 }], puts = [];
  const api = async (path, options) => {
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return access("lot-" + lot.slug, "lot-ch");
    if (path.endsWith("/decor")) { puts.push(JSON.parse(options.body)); return { decor: saved, version: 4 }; }
    return {};
  };
  const { stage, calls } = setup({ api });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  assert.equal(stage.canManage(), true, "the first one in hosts the lot");
  assert.deepEqual(stage.decorArea(), lot.interior);
  assert.equal(await stage.saveDecor(saved), true);
  assert.deepEqual(puts, [{ items: saved }]);
  assert.deepEqual(calls.decor.at(-1), saved);
  assert.ok(calls.published.includes(JSON.stringify({ t: "decor", version: 4 })));
});
test("a decor notice from the host refetches the room; from anyone else it is ignored", async () => {
  const { gets, calls } = await inLot();
  const handlers = calls.handlers["lot-ch"];
  handlers.message(guestUser, JSON.stringify({ t: "decor", version: 2 }));
  await tick();
  assert.equal(gets.length, 0);
  handlers.message(hostUser, JSON.stringify({ t: "decor", version: 2 }));
  await tick();
  assert.equal(gets.length, 1);
});
test("saved decorations survive a same-room channel change and a save that races a settle", async () => {
  const saved = [{ id: "d2", kind: "lamp", x: lot.entry.x, y: lot.entry.y - 1, rotation: 0, variant: 0 }];
  const api = async (path) => path === "/api/spaces/plaza/enter" ? access("plaza", "plaza-1") : path.endsWith("/enter") ? access("lot-" + lot.slug, "lot-ch") : path.endsWith("/decor") ? { decor: saved, version: 2 } : {};
  const { stage, calls, leases } = setup({ api });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  assert.equal(await stage.saveDecor(saved), true);
  leases.at(-1).options.onAccess({ channel: "lot-ch-2", key: null, blocked: [], hostId: "a-me" });
  await tick(); await tick();
  assert.deepEqual(calls.joined.at(-1), "lot-ch-2");
  assert.deepEqual(calls.decor.at(-1), saved);
});
test("onManage reports when hosting is gained or lost, and the region protects doors and the entry", async () => {
  const managed = [];
  const api = async (path) => path === "/api/spaces/plaza/enter" ? access("plaza", "plaza-1") : path.endsWith("/enter") ? access("lot-" + lot.slug, "lot-ch") : {};
  const { stage, leases } = setup({ api, onManage: (can) => managed.push(can) });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  assert.deepEqual(managed, [true]);
  const region = stage.decorRegion();
  assert.deepEqual(region.start, lot.entry);
  assert.deepEqual(region.protect[0], lot.entry);
  leases.at(-1).options.onAccess({ channel: "lot-ch", hostId: "someone-else", blocked: [] });
  assert.deepEqual(managed, [true, false]);
  await stage.leaveRoom();
  assert.equal(stage.decorRegion(), null);
});

test("the host can hand over hosting; the room stops offering host tools", async () => {
  const posts = [], managed = [];
  const api = async (path, options) => {
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return access("lot-" + lot.slug, "lot-ch");
    if (path.endsWith("/host")) { posts.push(JSON.parse(options.body)); return { hostId: "account:72a639ba-3a45-4afe-936b-222222222222" }; }
    return {};
  };
  const { stage, calls } = setup({ api, onManage: (can) => managed.push(can) });
  await stage.toPlaza(null);
  await stage.enterLot(lot);
  assert.equal(stage.canManage(), true);
  await stage.makeHost({ id: "account:72a639ba-3a45-4afe-936b-222222222222", name: "Ada" });
  assert.deepEqual(posts, [{ actorId: "account:72a639ba-3a45-4afe-936b-222222222222" }]);
  assert.equal(calls.showRoom.at(-1).host, false);
  assert.equal(calls.showRoom.at(-1).decorate, false);
  assert.equal(stage.canManage(), false);
  assert.equal(managed.at(-1), false, "the decor editor is told to close");
  assert.ok(calls.published.includes(JSON.stringify({ t: "refresh" })), "the room is told to refresh");
});
test("removing someone tells the room to check access, then reopens on the new channel", async () => {
  const api = async (path) => {
    if (path === "/api/spaces/plaza/enter") return access("plaza", "plaza-1");
    if (path.endsWith("/enter")) return access("space-1", "space-ch");
    if (path.endsWith("/remove")) return { removed: true, channel: "space-ch-2", key: null, blocked: ["account:bad"], hostId: "a-me" };
    return {};
  };
  const { stage, calls } = setup({ api });
  await stage.openSpace("space-1");
  await stage.removePerson({ id: "account:bad", name: "Bad" });
  assert.ok(calls.published.includes(JSON.stringify({ t: "rekey" })));
  assert.deepEqual(calls.joined.slice(-1), ["space-ch-2"]);
  assert.ok(calls.left.includes("space-ch"));
});
test("a rekey from the host makes the lease check in now; from anyone else it is ignored", async () => {
  const { calls, leases } = await inLot();
  const handlers = calls.handlers["lot-ch"], lease = leases.at(-1);
  handlers.message(guestUser, JSON.stringify({ t: "rekey" }));
  assert.equal(lease.beats || 0, 0);
  handlers.message(hostUser, JSON.stringify({ t: "rekey" }));
  assert.equal(lease.beats, 1);
});
test("remove wording follows the room kind, and a refresh from the owner is heard", async () => {
  const env = await inLot();
  assert.match(env.stage.removeNotice({ name: "Bo" }), /Remove Bo from this room\? .*until the room empties\./);
  const api = async (path) => path === "/api/spaces/plaza/enter" ? access("plaza", "plaza-1") : path.endsWith("/enter") ? { ...access("space-1", "space-ch"), space: { ...space("space-1"), ownerId: hostActor }, hostId: "account:someone" } : { space: space("space-1") };
  const { stage, calls } = setup({ api });
  await stage.openSpace("space-1");
  assert.match(stage.removeNotice({ name: "Bo" }), /from this space\? .*unless the owner allows them back\./);
  calls.handlers["space-ch"].presence({ type: "snapshot", people: [present(hostUser, "Owner")] });
  const before = calls.showRoom.length;
  calls.handlers["space-ch"].message(hostUser, JSON.stringify({ t: "refresh" }));
  await tick(); await tick();
  assert.ok(calls.showRoom.length > before, "owner refresh triggers a room fetch");
});
