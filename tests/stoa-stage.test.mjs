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

function setup({ api, signedIn = true } = {}) {
  const calls = { interactive: null, published: [], states: [], canTalk: [], showRoom: [], offer: 0, joined: [], left: [] };
  const live = {
    userId: "a-me", guest: false, renew: async () => {},
    join: async (name) => { calls.joined.push(name); }, leave: async (name) => { calls.left.push(name); },
    publish: async (name, text) => { calls.published.push(text); }, setState: async (name, text) => { calls.states.push(text); }, who: async () => []
  };
  const handlers = {}, pos = { x: lot.door.x, y: lot.door.y };
  const engine = {
    teleport() {}, setBounds() {}, setOthers() {}, position: () => pos, setInteractive: (value) => { calls.interactive = value; }, facing: () => "down", say() {}, walkTo: () => true,
    on(name, handler) { handlers[name] = handler; return () => {}; }
  };
  const panel = {
    said: [], say(message) { this.said.push(message); }, setPeople() {}, addMessage() {}, clearMessages() {}, showPlaza() {}, hideOffer() {},
    canTalk: (value) => calls.canTalk.push(value), showRoom: (room) => calls.showRoom.push(room), showOffer: () => { calls.offer += 1; }
  };
  const leases = [];
  const createLease = (options) => { const entry = { options, active: true, stop() { entry.active = false; }, async leave() { entry.active = false; }, leaveOnUnload() { entry.active = false; } }; leases.push(entry); return entry; };
  const stage = createStage({ api, map: plaza, engine, panel, live, self: { id: "a-me", name: "Me", signedIn }, plaza: { bounds: null, channel: "plaza-1" }, createLease });
  return { stage, calls, panel, leases, handlers };
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
