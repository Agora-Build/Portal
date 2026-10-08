import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { parseMap } from "../world/map.js";
import { MESSAGE_LIMIT, SKEW_LIMIT, STRAIGHT_LIMIT, TEXT_LIMIT, actorFromUser, createLimiter, readMessage, readState, shared, stopAt, straightPath, trusted, writeMessage, writeState } from "../world/protocol.js";
import { importKey, open, seal } from "../world/crypto.js";

const plaza = parseMap(JSON.parse(await readFile(new URL("../worlds/plaza/map.json", import.meta.url), "utf8")));
const uuid = "72a639ba-3a45-4afe-936b-111111111111";

test("limits are fixed", () => {
  assert.deepEqual([MESSAGE_LIMIT, TEXT_LIMIT, SKEW_LIMIT, STRAIGHT_LIMIT], [8192, 500, 2000, 40]);
});
test("Signaling user IDs map back to portal actors", () => {
  assert.equal(actorFromUser("a-" + uuid), "account:" + uuid);
  assert.equal(actorFromUser("m-" + uuid), "member:" + uuid);
  for (const other of ["g-0123456789abcdef", "a-nope", "x-" + uuid, "", null]) assert.equal(actorFromUser(other), null, String(other));
});
test("only well-formed messages are accepted", () => {
  const move = { t: "move", path: [{ x: 21, y: 17 }, { x: 21, y: 16 }], startedAt: 1000 };
  assert.deepEqual(readMessage(writeMessage({ ...move, extra: "dropped" }), plaza), move);
  assert.deepEqual(readMessage(writeMessage({ t: "walk", from: { x: 21, y: 17 }, dir: "up", startedAt: 5 }), plaza), { t: "walk", from: { x: 21, y: 17 }, dir: "up", startedAt: 5 });
  assert.deepEqual(readMessage(writeMessage({ t: "stop", at: { x: 21, y: 15 } }), plaza), { t: "stop", at: { x: 21, y: 15 } });
  assert.deepEqual(readMessage(writeMessage({ t: "face", dir: "left" }), plaza), { t: "face", dir: "left" });
  assert.deepEqual(readMessage(writeMessage({ t: "say", text: "  hello  " }), plaza), { t: "say", text: "hello" });
  assert.deepEqual(readMessage(writeMessage({ t: "refresh" }), plaza), { t: "refresh" });
  for (const bad of [
    "not json", "null", "[]", writeMessage({ t: "dance" }),
    writeMessage({ ...move, path: [{ x: 21, y: 17 }, { x: 21, y: 15 }] }),
    writeMessage({ ...move, path: [{ x: 0, y: 0 }] }),
    writeMessage({ ...move, startedAt: "soon" }),
    writeMessage({ t: "walk", from: { x: 0, y: 0 }, dir: "up", startedAt: 1 }),
    writeMessage({ t: "walk", from: { x: 21, y: 17 }, dir: "north", startedAt: 1 }),
    writeMessage({ t: "stop", at: { x: 1.5, y: 2 } }),
    writeMessage({ t: "say", text: "   " }),
    writeMessage({ t: "say", text: "x".repeat(501) }),
    "x".repeat(8193)
  ]) assert.equal(readMessage(bad, plaza), null, bad.slice(0, 60));
});
test("presence state is strings out and validated values in", () => {
  assert.deepEqual(writeState({ x: 21, y: 17, dir: "up", name: "Ada" + "x".repeat(80) }), { x: "21", y: "17", dir: "up", name: "Ada" + "x".repeat(57) });
  assert.deepEqual(readState({ x: "21", y: "17", dir: "up", name: " Ada " }, plaza), { x: 21, y: 17, dir: "up", name: "Ada" });
  assert.deepEqual(readState({ x: "21", y: "17", dir: "sideways" }, plaza), { x: 21, y: 17, dir: "down", name: "Builder" });
  for (const bad of [null, {}, { x: "0", y: "0" }, { x: "a", y: "1" }, { x: "21.5", y: "17" }]) assert.equal(readState(bad, plaza), null, JSON.stringify(bad));
});
test("receivers trust only present, signed-in, unblocked publishers", () => {
  const present = new Set(["a-" + uuid, "m-" + uuid, "g-0123456789abcdef"]);
  const context = { self: "a-self", present, blocked: new Set() };
  assert.equal(trusted("a-" + uuid, context), true);
  assert.equal(trusted("a-self", { ...context, present: new Set(["a-self"]) }), false);
  assert.equal(trusted("g-0123456789abcdef", context), false);
  assert.equal(trusted("a-absent", context), false);
  assert.equal(trusted("m-" + uuid, { ...context, blocked: new Set(["member:" + uuid]) }), false);
});
test("keyboard walks go straight until blocked and stop on a tile of the path", () => {
  const up = straightPath(plaza, { x: 21, y: 17 }, "up");
  assert.deepEqual(up.map((tile) => tile.y), [17, 16, 15, 14, 13, 12]);
  assert.deepEqual(straightPath(plaza, { x: 21, y: 18 }, "down"), [{ x: 21, y: 18 }]);
  assert.equal(straightPath(plaza, { x: 1, y: 18 }, "right").length, STRAIGHT_LIMIT + 1, "a long open row is capped");
  assert.deepEqual(straightPath(plaza, { x: 21, y: 17 }, "up", new Set(["21,15"])).map((tile) => tile.y), [17, 16]);
  const walk = { path: up, startedAt: 10, dir: "up" };
  assert.deepEqual(stopAt(walk, { x: 21, y: 15 }), { path: up.slice(0, 3), startedAt: 10, dir: "up" });
  assert.equal(stopAt(walk, { x: 5, y: 5 }), null);
});
test("start times from skewed clocks fall back to the receiver's clock", () => {
  assert.equal(shared(10000, 11000), 10000);
  assert.equal(shared(10000, 12001), 12001);
  assert.equal(shared(15000, 12000), 12000);
});
test("the limiter allows a burst, drops extra chat, and keeps only the latest pending move", () => {
  let time = 0; const timers = []; const sent = [];
  const limiter = createLimiter({ perSecond: 4, burst: 2, now: () => time, later: (callback, delay) => { timers.push({ callback, delay }); return timers.length; } });
  assert.equal(limiter.send(() => sent.push("a")), true);
  assert.equal(limiter.send(() => sent.push("b")), true);
  assert.equal(limiter.send(() => sent.push("dropped")), false);
  assert.equal(limiter.send(() => sent.push("old"), { latest: true }), true);
  assert.equal(limiter.send(() => sent.push("new"), { latest: true }), true);
  assert.deepEqual(sent, ["a", "b"]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 250);
  time = 250; timers[0].callback();
  assert.deepEqual(sent, ["a", "b", "new"]);
});

test("sealed payloads open only with the same space key", async () => {
  const keyText = randomBytes(32).toString("base64"), otherText = randomBytes(32).toString("base64");
  const key = await importKey(keyText), other = await importKey(otherText);
  const first = await seal(key, "hello plaza"), second = await seal(key, "hello plaza");
  assert.match(first, /^e1\.[A-Za-z0-9+/=]+$/);
  assert.notEqual(first, second, "every seal uses a fresh iv");
  assert.equal(await open(key, first), "hello plaza");
  assert.equal(await open(other, first), null);
  assert.equal(await open(key, first.slice(0, -4) + "AAAA"), null);
  for (const bad of ["hello plaza", "e1.", "e1.!!!", null, 42]) assert.equal(await open(key, bad), null, String(bad));
  assert.equal(await open(key, await seal(key, "名字 ✓")), "名字 ✓");
});

import { BUBBLE_MS, createPresence } from "../world/presence.js";

const ada = "a-72a639ba-3a45-4afe-936b-222222222222", bo = "m-72a639ba-3a45-4afe-936b-333333333333", self = "a-72a639ba-3a45-4afe-936b-111111111111";
const at = (x, y, extra = {}) => ({ x: String(x), y: String(y), dir: "down", name: "Ada", ...extra });
const people = (time = 0) => { const clock = { time }; return { clock, room: createPresence({ map: plaza, self, now: () => clock.time }) }; };

test("presence lists signed-in people with valid states only", () => {
  const { room } = people(1000);
  room.snapshot([{ userId: ada, states: at(21, 17) }, { userId: bo, states: at(22, 17, { name: "Bo" }) }, { userId: self, states: at(20, 17) }, { userId: "g-0123456789abcdef", states: at(19, 17) }, { userId: "a-bad", states: at(18, 17) }, { userId: "a-72a639ba-3a45-4afe-936b-444444444444", states: { x: "0", y: "0" } }]);
  assert.equal(BUBBLE_MS, 8000);
  assert.deepEqual(room.list(), [
    { id: "account:72a639ba-3a45-4afe-936b-222222222222", name: "Ada", walk: { path: [{ x: 21, y: 17 }], startedAt: 1000, dir: "down" }, bubble: null },
    { id: "member:72a639ba-3a45-4afe-936b-333333333333", name: "Bo", walk: { path: [{ x: 22, y: 17 }], startedAt: 1000, dir: "down" }, bubble: null }
  ]);
  room.leave(bo);
  assert.equal(room.list().length, 1);
});
test("moves, keyboard walks, stops, turns, and speech follow trusted messages", () => {
  const { clock, room } = people(1000);
  room.snapshot([{ userId: ada, states: at(21, 17) }]);
  assert.equal(room.message(bo, writeMessage({ t: "say", text: "hi" })), null, "people without presence are ignored");
  assert.equal(room.message(ada, "nonsense"), null);
  const moved = room.message(ada, writeMessage({ t: "move", path: [{ x: 21, y: 17 }, { x: 21, y: 16 }], startedAt: 1500 }));
  assert.deepEqual(moved.from, { id: "account:72a639ba-3a45-4afe-936b-222222222222", name: "Ada" });
  assert.deepEqual(room.list()[0].walk, { path: [{ x: 21, y: 17 }, { x: 21, y: 16 }], startedAt: 1500 });
  clock.time = 5000;
  room.message(ada, writeMessage({ t: "walk", from: { x: 21, y: 16 }, dir: "up", startedAt: 5000 }));
  assert.deepEqual(room.list()[0].walk.path.map((tile) => tile.y), [16, 15, 14, 13, 12]);
  room.message(ada, writeMessage({ t: "stop", at: { x: 21, y: 14 } }));
  assert.deepEqual(room.list()[0].walk.path.map((tile) => tile.y), [16, 15, 14]);
  clock.time = 9000;
  room.message(ada, writeMessage({ t: "stop", at: { x: 6, y: 8 } }));
  assert.deepEqual(room.list()[0].walk.path, [{ x: 6, y: 8 }]);
  room.message(ada, writeMessage({ t: "face", dir: "left" }));
  assert.deepEqual(room.list()[0].walk, { path: [{ x: 6, y: 8 }], startedAt: 9000, dir: "left" });
  room.message(ada, writeMessage({ t: "say", text: "Hello!" }));
  assert.deepEqual(room.list()[0].bubble, { text: "Hello!", until: 9000 + BUBBLE_MS });
  room.message(ada, writeMessage({ t: "move", path: [{ x: 6, y: 8 }, { x: 7, y: 8 }], startedAt: 1 }));
  assert.equal(room.list()[0].walk.startedAt, 9000, "a far-off clock falls back to the local one");
});
test("state updates rest people, never interrupt a walk, and blocked people disappear", () => {
  const { clock, room } = people(1000);
  room.snapshot([{ userId: ada, states: at(21, 17) }]);
  room.state(ada, at(22, 17));
  assert.deepEqual(room.list()[0].walk.path, [{ x: 22, y: 17 }]);
  room.message(ada, writeMessage({ t: "move", path: [{ x: 22, y: 17 }, { x: 22, y: 16 }], startedAt: 1000 }));
  room.state(ada, at(22, 16, { name: "Ada L." }));
  assert.deepEqual([room.list()[0].walk.path.length, room.list()[0].name], [2, "Ada L."]);
  clock.time = 2000;
  room.setBlocked(["account:72a639ba-3a45-4afe-936b-222222222222"]);
  assert.deepEqual(room.list(), []);
  room.state(ada, at(21, 17));
  assert.deepEqual(room.list(), [], "blocked people stay hidden");
});
