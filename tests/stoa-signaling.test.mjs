import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createLive } from "../world/signaling.js";
import { importKey, open, seal } from "../world/crypto.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const me = "a-72a639ba-3a45-4afe-936b-111111111111", ada = "a-72a639ba-3a45-4afe-936b-222222222222";

function fakeAgora() {
  const clients = [];
  class RTM {
    constructor(appId, userId) {
      Object.assign(this, { appId, userId, calls: [], handlers: {}, pages: [] });
      const self = this;
      this.presence = {
        async setState(...args) { self.calls.push(["setState", ...args]); },
        async whoNow(...args) { self.calls.push(["whoNow", ...args]); return self.pages.shift() || { occupants: [], nextPage: "" }; }
      };
      clients.push(this);
    }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    async login(options) { this.calls.push(["login", options]); }
    async subscribe(...args) { this.calls.push(["subscribe", ...args]); }
    async unsubscribe(...args) { this.calls.push(["unsubscribe", ...args]); }
    async publish(...args) { this.calls.push(["publish", ...args]); }
    async renewToken(token) { this.calls.push(["renewToken", token]); }
    async logout() { this.calls.push(["logout"]); }
  }
  return { AgoraRTM: { RTM }, clients };
}
async function connected(userId = me) {
  const { AgoraRTM, clients } = fakeAgora();
  let issued = 0;
  const live = createLive({ AgoraRTM, fetchToken: async () => ({ appId: "a".repeat(32), userId, token: "token-" + (++issued), channels: [] }) });
  await live.connect();
  return { live, client: clients[0] };
}
const recorder = () => { const seen = { messages: [], changes: [] }; return { seen, handlers: { message: (publisher, text) => seen.messages.push([publisher, text]), presence: (change) => seen.changes.push(change) } }; };

test("connecting logs in once as the user from the token", async () => {
  const { live, client } = await connected();
  assert.deepEqual([client.appId, client.userId, live.userId, live.guest], ["a".repeat(32), me, me, false]);
  assert.deepEqual(client.calls, [["login", { token: "token-1" }]]);
});
test("guests subscribe quietly; members do not", async () => {
  const guest = await connected("g-0123456789abcdef");
  await guest.live.join("ab-stoa-plaza", { spaceId: "plaza" }, recorder().handlers);
  assert.equal(guest.live.guest, true);
  assert.deepEqual(guest.client.calls.at(-1), ["subscribe", "ab-stoa-plaza", { withMessage: true, withPresence: true, beQuiet: true }]);
  const member = await connected();
  await member.live.join("ab-stoa-plaza", { spaceId: "plaza" }, recorder().handlers);
  assert.equal(member.client.calls.at(-1)[2].beQuiet, false);
});
test("plain channels carry text as is; keyed channels are sealed both ways", async () => {
  const keyText = randomBytes(32).toString("base64"), key = await importKey(keyText);
  const { live, client } = await connected();
  const plaza = recorder(), hidden = recorder();
  await live.join("ab-stoa-plaza", { spaceId: "plaza" }, plaza.handlers);
  await live.join("ab-stoa-secret", { spaceId: "s1", key: keyText }, hidden.handlers);
  await live.publish("ab-stoa-plaza", "hello");
  await live.publish("ab-stoa-secret", "psst");
  const published = client.calls.filter(([name]) => name === "publish");
  assert.deepEqual(published[0], ["publish", "ab-stoa-plaza", "hello"]);
  assert.match(published[1][2], /^e1\./);
  assert.equal(await open(key, published[1][2]), "psst");
  client.handlers.message({ channelName: "ab-stoa-plaza", publisher: ada, message: "hi" });
  client.handlers.message({ channelName: "ab-stoa-secret", publisher: ada, message: await seal(key, "secret hi") });
  client.handlers.message({ channelName: "ab-stoa-secret", publisher: ada, message: "not sealed" });
  client.handlers.message({ channelName: "ab-stoa-plaza", publisher: me, message: "my echo" });
  client.handlers.message({ channelName: "ab-stoa-other", publisher: ada, message: "stray" });
  await settle();
  assert.deepEqual(plaza.seen.messages, [[ada, "hi"]]);
  assert.deepEqual(hidden.seen.messages, [[ada, "secret hi"]]);
  await assert.rejects(live.publish("ab-stoa-missing", "x"), /Not in channel/);
});
test("presence events become snapshot, join, leave, and state changes, decrypted where keyed", async () => {
  const keyText = randomBytes(32).toString("base64"), key = await importKey(keyText);
  const { live, client } = await connected();
  const hidden = recorder();
  await live.join("ab-stoa-secret", { spaceId: "s1", key: keyText }, hidden.handlers);
  const sealed = async (state) => ({ s: await seal(key, JSON.stringify(state)) });
  client.handlers.presence({ channelName: "ab-stoa-secret", eventType: "SNAPSHOT", snapshot: [{ userId: ada, states: await sealed({ x: "1", y: "2" }) }, { userId: me, states: await sealed({ x: "3", y: "4" }) }, { userId: "a-bad", states: { s: "garbage" } }] });
  client.handlers.presence({ channelName: "ab-stoa-secret", eventType: "REMOTE_JOIN", publisher: ada });
  client.handlers.presence({ channelName: "ab-stoa-secret", eventType: "REMOTE_STATE_CHANGED", publisher: ada, stateChanged: await sealed({ x: "5", y: "6" }) });
  client.handlers.presence({ channelName: "ab-stoa-secret", eventType: "REMOTE_TIMEOUT", publisher: ada });
  client.handlers.presence({ channelName: "ab-stoa-secret", eventType: "INTERVAL", interval: { join: { users: [] }, leave: { users: ["a-left"] }, timeout: { users: [] }, userStateList: [{ userId: ada, states: await sealed({ x: "7", y: "8" }) }] } });
  await settle();
  assert.deepEqual(hidden.seen.changes, [
    { type: "snapshot", people: [{ userId: ada, states: { x: "1", y: "2" } }] },
    { type: "join", userId: ada },
    { type: "state", userId: ada, states: { x: "5", y: "6" } },
    { type: "leave", userId: ada },
    { type: "leave", userId: "a-left" },
    { type: "state", userId: ada, states: { x: "7", y: "8" } }
  ]);
});
test("state is sealed on keyed channels and who() follows every page", async () => {
  const keyText = randomBytes(32).toString("base64"), key = await importKey(keyText);
  const { live, client } = await connected();
  await live.join("ab-stoa-plaza", { spaceId: "plaza" }, recorder().handlers);
  await live.join("ab-stoa-secret", { spaceId: "s1", key: keyText }, recorder().handlers);
  await live.setState("ab-stoa-plaza", { x: "1", y: "1" });
  await live.setState("ab-stoa-secret", { x: "2", y: "2" });
  const states = client.calls.filter(([name]) => name === "setState");
  assert.deepEqual(states[0], ["setState", "ab-stoa-plaza", "MESSAGE", { x: "1", y: "1" }]);
  assert.deepEqual(JSON.parse(await open(key, states[1][3].s)), { x: "2", y: "2" });
  client.pages = [{ occupants: [{ userId: ada, states: { x: "1" } }, { userId: me, states: {} }], nextPage: "p2" }, { occupants: [{ userId: "a-two", states: { x: "2" } }], nextPage: "" }];
  assert.deepEqual(await live.who("ab-stoa-plaza"), [{ userId: ada, states: { x: "1" } }, { userId: "a-two", states: { x: "2" } }]);
  const asks = client.calls.filter(([name]) => name === "whoNow");
  assert.deepEqual([asks[0][3], asks[1][3]], [{ includedUserId: true, includedState: true }, { includedUserId: true, includedState: true, page: "p2" }]);
});
test("expiring tokens are renewed; leaving and closing stop delivery", async () => {
  const { live, client } = await connected();
  const plaza = recorder();
  await live.join("ab-stoa-plaza", { spaceId: "plaza" }, plaza.handlers);
  client.handlers.tokenPrivilegeWillExpire("ab-stoa-plaza");
  await settle();
  assert.deepEqual(client.calls.filter(([name]) => name === "renewToken"), [["renewToken", "token-2"]]);
  await live.leave("ab-stoa-plaza");
  client.handlers.message({ channelName: "ab-stoa-plaza", publisher: ada, message: "after" });
  await settle();
  assert.deepEqual(plaza.seen.messages, []);
  assert.deepEqual(client.calls.filter(([name]) => name === "unsubscribe"), [["unsubscribe", "ab-stoa-plaza"]]);
  await live.close();
  assert.deepEqual(client.calls.at(-1), ["logout"]);
});
