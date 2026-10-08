import { test } from "node:test";
import assert from "node:assert/strict";
import { actorUuid, nameFor, overAvatar, tileList } from "../stoa/call.js";

const ada = "72a639ba-3a45-4afe-936b-222222222222", me = "72a639ba-3a45-4afe-936b-111111111111";
const people = [{ id: "account:" + ada, name: "Ada" }];
const self = { id: "account:" + me, name: "Me" };
const snapshot = { joined: true, uid: me + "_aaaaaaaaaaaa", screenUid: me + "_aaaaaaaaaaaa_screen", audio: true, video: false, screen: true, peers: [{ uid: ada + "_bbbbbbbbbbbb", audio: true, video: true, screen: false }, { uid: ada + "_bbbbbbbbbbbb_screen", audio: false, video: true, screen: true }, { uid: "99999999-0000-4000-8000-000000000000_cccccccccccc", audio: true, video: false, screen: false }] };

test("call identities map back to people by their UUID", () => {
  assert.equal(actorUuid(ada + "_bbbbbbbbbbbb_screen"), ada);
  const names = tileList(snapshot, { people, self }).map((tile) => [tile.name, tile.video, tile.screen, tile.mine]);
  assert.deepEqual(names, [["Your screen", true, true, true], ["Ada's screen", true, true, false], ["Me (you)", false, false, true], ["Ada", true, false, false], ["Builder", false, false, false]]);
  assert.deepEqual(tileList({ ...snapshot, joined: false }, { people, self }), []);
  assert.equal(nameFor(snapshot.uid, { people, self, snapshot }), "Me (you)");
});
test("over-avatar tiles sit above the matching avatar; screens and people out of view do not float", () => {
  const frame = { tileSize: 32, camera: { x: 100, y: 50, zoom: 2 }, avatars: [{ id: self.id, x: 5, y: 4, self: true }, { id: "account:" + ada, x: 7, y: 3, self: false }] };
  const [screen, , mine, adaTile, stranger] = tileList(snapshot, { people, self });
  assert.deepEqual(overAvatar(mine, frame), { left: ((5 + 0.5) * 32 - 100) * 2, top: (4 * 32 - 50) * 2 });
  assert.deepEqual(overAvatar(adaTile, frame), { left: ((7 + 0.5) * 32 - 100) * 2, top: (3 * 32 - 50) * 2 });
  assert.equal(overAvatar(screen, frame), null);
  assert.equal(overAvatar(stranger, frame), null);
  assert.equal(overAvatar(mine, null), null);
});
test("another tab of the same person is named as such", () => {
  const mine = { ...self, ids: [self.id, "member:" + me] };
  assert.equal(nameFor(me + "_dddddddddddd", { people, self: mine, snapshot }), "Me (another tab)");
  assert.equal(nameFor(me + "_dddddddddddd_screen", { people, self: mine, snapshot }), "Me (another tab)'s screen");
  assert.equal(nameFor(snapshot.uid, { people, self: mine, snapshot }), "Me (you)");
});
test("screen shares come first, then people with video, then the rest; your own camera leads the people", () => {
  const quiet = { uid: "99999999-0000-4000-8000-000000000000_cccccccccccc", audio: true, video: false, screen: false };
  const order = tileList({ ...snapshot, screen: false, peers: [quiet, snapshot.peers[0], snapshot.peers[1]] }, { people, self }).map((tile) => tile.name);
  assert.deepEqual(order, ["Ada's screen", "Me (you)", "Ada", "Builder"]);
});
