import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStore } from "../scripts/store.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";
import { createSignaling, signalingConfig } from "../scripts/spaces/signaling.mjs";
import { createSpaces, loadWorlds } from "../scripts/spaces/service.mjs";

const root = new URL("../", import.meta.url).pathname;
const worlds = loadWorlds(root);
const secret = "s".repeat(32);
const env = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACE_CHANNEL_SECRET: secret };
const profile = (name) => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });
const missing = { status: 404, message: "This space was not found." };

async function setup(t, { plazaCapacity, before, admins = [] } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "spaces-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { now: 1800000000000 };
  const now = () => clock.now;
  const store = createStore(resolve(root, "data/people.json"), resolve(directory, "state.json"), { now });
  const person = async (name) => { const { token } = await store.join(profile(name)); return { token, id: (await store.actor(token)).id }; };
  const context = before ? await before(store, person) : {};
  const spaces = createSpaces({ store, worlds, secret, now, plazaCapacity, admins, signaling: createSignaling(signalingConfig(env), { now }), calls: createAgoraCalls(agoraConfig(env), { now }) });
  const events = [];
  spaces.onEvents((list) => events.push(...list));
  const account = async (name, subject) => {
    const login = await store.login({ provider: "github", issuer: "https://github.com", subject: String(subject), name });
    await store.join(profile(name), login.token);
    const actor = await store.actor(login.token);
    return { token: login.token, id: actor.id, accountId: actor.accountId, memberId: actor.memberId };
  };
  return { store, spaces, events, clock, person, account, ...context };
}

test("system spaces and legacy rooms are prepared once", async (t) => {
  const { spaces, store, owner, room } = await setup(t, { before: async (store, person) => { const owner = await person("Owner"); return { owner, room: await store.createRoom(owner.token, { title: "Demo prep", intent: "Plan the demo day together." }) }; } });
  const listing = await spaces.list();
  assert.deepEqual(listing.rooms.map((entry) => entry.slug), ["ai-agents", "voice-ai", "rtc-lab", "founders-table", "open-source", "lounge"]);
  assert.deepEqual(listing.plaza, { capacity: 200, occupancy: 0, blocked: [] });
  const migrated = await spaces.get(owner.token, room.id);
  assert.deepEqual([migrated.visibility, migrated.access, migrated.members, migrated.title], ["unlisted", "members", [owner.id], "Demo prep"]);
  await spaces.list();
  assert.equal((await store.snapshot()).spaces.length, 8);
});

test("the first person in a lot hosts and sets the topic; hosting passes on; an empty lot resets", async (t) => {
  const { spaces, events, clock, person } = await setup(t);
  const [a, b, c] = [await person("Ada"), await person("Bo"), await person("Cy")];
  const first = await spaces.enter(a.token, "lot-ai-agents");
  assert.deepEqual([first.firstIn, first.hostId, first.channel, first.key], [true, a.id, "ab-stoa-ai-agents", null]);
  clock.now += 1000; await spaces.enter(b.token, "lot-ai-agents");
  clock.now += 1000; await spaces.enter(c.token, "lot-ai-agents");
  await assert.rejects(spaces.topic(b.token, "lot-ai-agents", { topic: "Agents" }), { status: 403 });
  await assert.rejects(spaces.topic(a.token, "lot-ai-agents", { topic: "x" }), { status: 422 });
  const topical = await spaces.topic(a.token, "lot-ai-agents", { topic: "Agent evals", tags: ["Evals", "agents"] });
  assert.deepEqual([topical.topic, topical.tags], ["Agent evals", ["evals", "agents"]]);
  assert.equal((await spaces.list({ q: "evals" })).rooms.length, 1);
  assert.equal((await spaces.list({ q: "evals" })).rooms[0].hostName, "Ada");
  await spaces.leave(a.token, "lot-ai-agents");
  assert.equal((await spaces.get(c.token, "lot-ai-agents")).hostId, b.id);
  assert.deepEqual(await spaces.setHost(b.token, "lot-ai-agents", { actorId: c.id }), { hostId: c.id });
  await assert.rejects(spaces.setHost(b.token, "lot-ai-agents", { actorId: b.id }), { status: 403 });
  await assert.rejects(spaces.setHost(c.token, "lot-ai-agents", { actorId: a.id }), { status: 422 });
  await spaces.leave(b.token, "lot-ai-agents");
  await spaces.leave(c.token, "lot-ai-agents");
  const empty = await spaces.get(null, "lot-ai-agents");
  assert.deepEqual([empty.topic, empty.tags, empty.hostId, empty.occupancy], [null, [], null, 0]);
  assert.ok(events.some((event) => event.type === "emptied" && event.spaceId === "lot-ai-agents"));
});

test("expired leases free seats and hand over hosting", async (t) => {
  const { spaces, clock, person } = await setup(t);
  const [a, b] = [await person("Ada"), await person("Bo")];
  await spaces.enter(a.token, "lot-rtc-lab");
  clock.now += 61000;
  const next = await spaces.enter(b.token, "lot-rtc-lab");
  assert.deepEqual([next.firstIn, next.hostId], [true, b.id]);
  await assert.rejects(spaces.heartbeat(a.token, "lot-rtc-lab"), { status: 410 });
  assert.equal((await spaces.heartbeat(b.token, "lot-rtc-lab")).hostId, b.id);
});

test("a full plaza offers the person's unlisted spaces, and lots stay open", async (t) => {
  const { spaces, person } = await setup(t, { plazaCapacity: 1 });
  const [a, b] = [await person("Ada"), await person("Bo")];
  await spaces.enter(a.token, "plaza");
  const own = await spaces.create(b.token, { title: "Bo's corner" });
  await assert.rejects(spaces.enter(b.token, "plaza"), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.message, "The plaza is full right now.");
    assert.deepEqual(error.details, { full: true, offer: { spaces: [{ id: own.id, title: "Bo's corner", visibility: "unlisted", path: "/stoa/s/" + own.id }], canCreate: true } });
    return true;
  });
  assert.equal((await spaces.enter(b.token, "lot-lounge")).firstIn, true);
  await spaces.enter(a.token, "lot-voice-ai");
  assert.equal((await spaces.list()).plaza.occupancy, 0, "people inside a lot leave the plaza");
  assert.equal((await spaces.enter(b.token, "plaza")).space.id, "plaza");
});

test("people can own as many spaces as their plan allows", async (t) => {
  const { spaces, person } = await setup(t);
  const a = await person("Ada");
  for (const title of ["One", "Two", "Three"]) await spaces.create(a.token, { title });
  await assert.rejects(spaces.create(a.token, { title: "Four" }), { status: 409 });
  await assert.rejects(spaces.create(null, { title: "Guest" }), { status: 401 });
});

test("private spaces stay hidden from strangers and admit invitation holders", async (t) => {
  const { spaces, events, clock, person } = await setup(t);
  const [owner, guest, late, later] = [await person("Owner"), await person("Guest"), await person("Late"), await person("Later")];
  const space = await spaces.create(owner.token, { title: "Board room", visibility: "private" });
  await assert.rejects(spaces.get(guest.token, space.id), missing);
  await assert.rejects(spaces.get(guest.token, "00000000-0000-4000-8000-000000000000"), missing);
  await assert.rejects(spaces.enter(guest.token, space.id), missing);
  await assert.rejects(spaces.invite(guest.token, space.id, {}), missing);
  assert.equal(await spaces.visible(guest.token, space.id), false);
  const invitation = await spaces.invite(owner.token, space.id, { uses: 1, hours: 1 });
  assert.equal(invitation.path, "/stoa/s/" + space.id + "?invite=" + invitation.token);
  assert.equal(await spaces.visible(guest.token, space.id, invitation.token), true);
  const entered = await spaces.enter(guest.token, space.id, invitation.token);
  assert.match(entered.channel, /^ab-stoa-[a-f0-9]{24}$/);
  assert.equal(Buffer.from(entered.key, "base64").length, 32);
  assert.ok(events.some((event) => event.type === "member-added" && event.actorId === guest.id));
  assert.equal((await spaces.get(guest.token, space.id)).title, "Board room", "members keep seeing the space");
  await assert.rejects(spaces.invite(guest.token, space.id, {}), { status: 403 });
  await assert.rejects(spaces.enter(late.token, space.id, invitation.token), missing, "used invitations stop working");
  const expiring = await spaces.invite(owner.token, space.id, { uses: 5, hours: 1 });
  clock.now += 3600001;
  await assert.rejects(spaces.enter(later.token, space.id, expiring.token), missing);
  await assert.rejects(spaces.invite(owner.token, space.id, { uses: 0 }), { status: 422 });
  assert.equal(JSON.stringify(await spaces.get(owner.token, space.id)).includes(invitation.token), false, "invitation tokens are never stored in the clear");
});

test("removing someone blocks them, renames hidden channels, and ends their heartbeat", async (t) => {
  const { spaces, events, person } = await setup(t);
  const [owner, visitor] = [await person("Owner"), await person("Visitor")];
  const space = await spaces.create(owner.token, { title: "Open studio", access: "open" });
  const before = await spaces.enter(owner.token, space.id);
  await spaces.enter(visitor.token, space.id);
  await assert.rejects(spaces.removePerson(visitor.token, space.id, { actorId: owner.id }), { status: 403 });
  await assert.rejects(spaces.removePerson(owner.token, space.id, { actorId: owner.id }), { status: 422 });
  const after = await spaces.removePerson(owner.token, space.id, { actorId: visitor.id });
  assert.notEqual(after.channel, before.channel);
  assert.notEqual(after.key, before.key);
  assert.ok(events.some((event) => event.type === "removed" && event.actorId === visitor.id));
  await assert.rejects(spaces.heartbeat(visitor.token, space.id), { status: 410 });
  await assert.rejects(spaces.enter(visitor.token, space.id), { status: 403 });
  await spaces.addMember(owner.token, space.id, visitor.id);
  assert.equal((await spaces.enter(visitor.token, space.id)).channel, after.channel, "the owner can let them back in");
  const left = await spaces.removeMember(owner.token, space.id, visitor.id);
  assert.deepEqual(left.members, [owner.id]);
  assert.ok(events.some((event) => event.type === "member-removed" && event.actorId === visitor.id));
  await assert.rejects(spaces.removeMember(owner.token, space.id, owner.id), { status: 422 });
});

test("owners edit and delete their spaces; the map's rooms cannot be edited", async (t) => {
  const { spaces, events, person } = await setup(t);
  const [owner, other] = [await person("Owner"), await person("Other")];
  const space = await spaces.create(owner.token, { title: "Studio" });
  assert.equal((await spaces.update(owner.token, space.id, { title: "Studio two", themeId: "cyberpunk" })).title, "Studio two");
  await assert.rejects(spaces.update(other.token, space.id, { title: "Mine" }), { status: 403 });
  await assert.rejects(spaces.update(owner.token, "lot-lounge", { title: "Mine" }), { status: 403 });
  await assert.rejects(spaces.destroy(other.token, space.id), { status: 403 });
  assert.deepEqual(await spaces.destroy(owner.token, space.id), { deleted: true });
  assert.ok(events.some((event) => event.type === "deleted" && event.spaceId === space.id));
  await assert.rejects(spaces.get(owner.token, space.id), missing);
});

test("only the host decorates, within the room's rules", async (t) => {
  const { spaces, person } = await setup(t);
  const [a, b] = [await person("Ada"), await person("Bo")];
  await spaces.enter(a.token, "lot-rtc-lab");
  await spaces.enter(b.token, "lot-rtc-lab");
  assert.deepEqual(await spaces.decorate(a.token, "lot-rtc-lab", [{ id: "p", kind: "plant", x: 15, y: 22 }]), { decor: [{ id: "p", kind: "plant", x: 15, y: 22, rotation: 0, variant: 0 }], version: 1 });
  await assert.rejects(spaces.decorate(b.token, "lot-rtc-lab", []), { status: 403 });
  await assert.rejects(spaces.decorate(a.token, "lot-rtc-lab", [{ id: "p", kind: "plant", x: 17, y: 32 }]), { status: 422 });
  await assert.rejects(spaces.decorate(a.token, "plaza", []), { status: 403 });
});

test("Signaling tokens list only channels the person may use", async (t) => {
  const { spaces, person } = await setup(t);
  const [owner, stranger] = [await person("Owner"), await person("Stranger")];
  const hidden = await spaces.create(owner.token, { title: "Secret plans", visibility: "private" });
  const entered = await spaces.enter(owner.token, hidden.id);
  const guest = await spaces.signalingToken(null);
  assert.match(guest.userId, /^g-[a-f0-9]{16}$/);
  assert.deepEqual(guest.channels, [{ spaceId: "plaza", name: "ab-stoa-plaza", write: false, key: null }]);
  const own = await spaces.signalingToken(owner.token);
  assert.equal(own.userId, owner.id.replace("member:", "m-"));
  assert.deepEqual(own.channels.map((channel) => [channel.spaceId, channel.name, channel.write, channel.key]), [["plaza", "ab-stoa-plaza", true, null], [hidden.id, entered.channel, true, entered.key]]);
  const outside = JSON.stringify([await spaces.list(), await spaces.signalingToken(stranger.token), guest]);
  for (const value of [hidden.id, "Secret plans", entered.channel, entered.key]) assert.equal(outside.includes(value), false, value);
});

test("RTC tokens require being inside a room", async (t) => {
  const { spaces, person } = await setup(t);
  const a = await person("Ada");
  await assert.rejects(spaces.rtcToken(a.token, "lot-lounge", {}), { status: 403 });
  await spaces.enter(a.token, "lot-lounge");
  assert.equal((await spaces.rtcToken(a.token, "lot-lounge", {})).channel, "agora-build-space-lot-lounge");
  await spaces.enter(a.token, "plaza");
  await assert.rejects(spaces.rtcToken(a.token, "plaza", {}), { status: 422 });
});

test("simultaneous entries never exceed capacity and produce one host", async (t) => {
  const { spaces, person } = await setup(t);
  const walkers = [];
  for (let index = 0; index < 8; index += 1) walkers.push(await person("Walker " + index));
  const results = await Promise.allSettled(walkers.map((walker) => spaces.enter(walker.token, "lot-rtc-lab")));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 6);
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => result.reason.status === 409));
  assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.firstIn).length, 1);
  const room = await spaces.get(null, "lot-rtc-lab");
  assert.equal(room.occupancy, 6);
  assert.ok(room.occupants.some((occupant) => occupant.id === room.hostId));
});

test("hidden private spaces answer every operation exactly like a missing one", async (t) => {
  const { spaces, person } = await setup(t);
  const [owner, stranger] = [await person("Owner"), await person("Stranger")];
  const space = await spaces.create(owner.token, { title: "Board room", visibility: "private" });
  const ghost = "00000000-0000-4000-8000-000000000000";
  const calls = (id) => [
    () => spaces.get(stranger.token, id), () => spaces.enter(stranger.token, id), () => spaces.invite(stranger.token, id, {}),
    () => spaces.update(stranger.token, id, { title: "x y z" }), () => spaces.destroy(stranger.token, id),
    () => spaces.addMember(stranger.token, id, owner.id), () => spaces.removeMember(stranger.token, id, owner.id),
    () => spaces.leave(stranger.token, id), () => spaces.heartbeat(stranger.token, id), () => spaces.topic(stranger.token, id, { topic: "Topic here" }),
    () => spaces.setHost(stranger.token, id, { actorId: owner.id }), () => spaces.decorate(stranger.token, id, []),
    () => spaces.removePerson(stranger.token, id, { actorId: owner.id }), () => spaces.rtcToken(stranger.token, id, {})
  ];
  for (const call of calls(space.id)) await assert.rejects(call(), missing);
  for (const call of calls(ghost)) await assert.rejects(call(), missing);
});

test("making a space private removes people who may no longer enter", async (t) => {
  const { spaces, person } = await setup(t);
  const [owner, stranger] = [await person("Owner"), await person("Stranger")];
  const space = await spaces.create(owner.token, { title: "Open studio", access: "open" });
  const before = await spaces.enter(owner.token, space.id);
  await spaces.enter(stranger.token, space.id);
  await spaces.update(owner.token, space.id, { visibility: "private", access: "members" });
  await assert.rejects(spaces.heartbeat(stranger.token, space.id), missing, "an evicted stranger sees the space as hidden, never as 410");
  const own = await spaces.heartbeat(owner.token, space.id);
  assert.notEqual(own.channel, before.channel);
  assert.equal((await spaces.signalingToken(stranger.token)).channels.some((channel) => channel.spaceId === space.id), false);
});

test("access tightening on an unlisted space rotates the channel and key", async (t) => {
  const { spaces, person } = await setup(t);
  const [owner, stranger] = [await person("Owner"), await person("Stranger")];
  const space = await spaces.create(owner.token, { title: "Side room", visibility: "unlisted", access: "open" });
  const before = await spaces.enter(owner.token, space.id);
  await spaces.enter(stranger.token, space.id);
  await spaces.update(owner.token, space.id, { access: "members" });
  const after = await spaces.heartbeat(owner.token, space.id);
  assert.notEqual(after.channel, before.channel);
  assert.notEqual(after.key, before.key);
});

test("account-backed actors own, enter, sign tokens, and are blocked by both ids", async (t) => {
  const admins = [];
  const { spaces, account } = await setup(t, { admins });
  const [owner, guest] = [await account("Acct Owner", 1), await account("Acct Guest", 2)];
  assert.match(owner.id, /^account:/);
  const space = await spaces.create(owner.token, { title: "Account room", access: "open" });
  assert.equal(space.ownerId, owner.id);
  assert.deepEqual(space.members, [owner.id]);
  const entered = await spaces.enter(owner.token, space.id);
  assert.equal(entered.hostId, owner.id);
  assert.equal((await spaces.get(owner.token, space.id)).occupants[0].id, owner.id);
  await spaces.enter(guest.token, space.id);
  const signed = await spaces.signalingToken(owner.token);
  assert.match(signed.userId, /^a-/);
  assert.ok(signed.channels.some((channel) => channel.spaceId === space.id && channel.name === entered.channel));
  const rtc = await spaces.rtcToken(owner.token, space.id, {});
  assert.ok(rtc.uid.startsWith(owner.id.replace(/^account:/, "") + "_"));
  const removed = await spaces.removePerson(owner.token, space.id, { actorId: guest.id });
  assert.deepEqual(removed.blocked, [guest.id, guest.memberId]);
  assert.notEqual(removed.channel, entered.channel);
  await assert.rejects(spaces.enter(guest.token, space.id), { status: 403 });
});

test("a platform admin sees and enters a private space", async (t) => {
  const admins = [];
  const { spaces, person, account } = await setup(t, { admins });
  const owner = await person("Owner");
  const space = await spaces.create(owner.token, { title: "Board room", visibility: "private" });
  const admin = await account("Admin", 9);
  await assert.rejects(spaces.get(admin.token, space.id), missing);
  admins.push(admin.accountId);
  assert.equal((await spaces.get(admin.token, space.id)).id, space.id);
  assert.equal((await spaces.enter(admin.token, space.id)).space.id, space.id);
});

test("signalingToken matches leases through any of the actor ids", async (t) => {
  const { spaces, store, account } = await setup(t);
  const owner = await account("Acct Owner", 1);
  const space = await spaces.create(owner.token, { title: "Id room", access: "open" });
  await spaces.enter(owner.token, space.id);
  await store.transaction((state) => { state.spaceLeases[0].actorId = owner.memberId; });
  assert.ok((await spaces.signalingToken(owner.token)).channels.some((channel) => channel.spaceId === space.id));
});

test("removeMember validates input and ignores non-members", async (t) => {
  const { spaces, events, person } = await setup(t);
  const [owner, other] = [await person("Owner"), await person("Other")];
  const space = await spaces.create(owner.token, { title: "Member room", visibility: "unlisted" });
  await assert.rejects(spaces.removeMember(owner.token, space.id, "nonsense"), { status: 422, message: "Choose a builder to remove." });
  const before = await spaces.enter(owner.token, space.id);
  events.length = 0;
  await spaces.removeMember(owner.token, space.id, other.id);
  assert.equal(events.some((event) => event.type === "member-removed"), false);
  assert.equal((await spaces.heartbeat(owner.token, space.id)).channel, before.channel);
});

test("a throwing or rejecting listener never fails a committed change", async (t) => {
  const { spaces, person } = await setup(t);
  spaces.onEvents(() => { throw new Error("boom"); });
  spaces.onEvents(async () => { throw new Error("late"); });
  const owner = await person("Owner");
  assert.equal((await spaces.enter(owner.token, "plaza")).space.id, "plaza");
});

test("sweep without expired leases never writes", async (t) => {
  const { spaces, store, person, clock } = await setup(t);
  const owner = await person("Owner");
  await spaces.enter(owner.token, "plaza");
  const original = store.transaction;
  let count = 0;
  store.transaction = (...args) => { count += 1; return original(...args); };
  await spaces.sweep();
  assert.equal(count, 0);
  clock.now += 120000;
  await spaces.sweep();
  assert.equal(count, 1);
});
test("your spaces lists spaces you own or belong to, newest first, with your allowance", async (t) => {
  const { spaces, clock, person } = await setup(t);
  const owner = await person("Owner"), friend = await person("Friend"), stranger = await person("Stranger");
  const first = await spaces.create(owner.token, { title: "First space" });
  clock.now += 1000;
  const second = await spaces.create(owner.token, { title: "Second space", visibility: "private" });
  await spaces.addMember(owner.token, first.id, friend.id);
  const mine = await spaces.mine(owner.token);
  assert.deepEqual(mine.spaces.map((space) => [space.title, space.owner, space.path]), [["Second space", true, "/stoa/s/" + second.id], ["First space", true, "/stoa/s/" + first.id]]);
  assert.deepEqual([mine.owned, mine.canCreate], [2, mine.limit > 2]);
  assert.deepEqual((await spaces.mine(friend.token)).spaces.map((space) => [space.title, space.owner, space.occupancy]), [["First space", false, 0]]);
  assert.deepEqual((await spaces.mine(stranger.token)).spaces, []);
  await assert.rejects(spaces.mine(null), { status: 401 });
});
test("owners see member and blocked names; others see neither", async (t) => {
  const { spaces, person } = await setup(t);
  const owner = await person("Owner"), friend = await person("Friend");
  const space = await spaces.create(owner.token, { title: "Named space" });
  await spaces.addMember(owner.token, space.id, friend.id);
  const seen = await spaces.get(owner.token, space.id);
  assert.deepEqual(seen.roster, [{ id: owner.id, name: "Owner" }, { id: friend.id, name: "Friend" }]);
  assert.deepEqual(seen.blockedRoster, []);
  const asFriend = await spaces.get(friend.token, space.id);
  assert.equal(asFriend.roster, undefined);
  assert.equal(asFriend.blockedRoster, undefined);
});
