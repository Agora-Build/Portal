import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AppError, createStore } from "../scripts/store.mjs";
import { entitlements } from "../scripts/plans.mjs";

const root = new URL("../", import.meta.url).pathname;
const profile = (name = "Test builder") => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", lookingFor: "Audio engineers", skills: ["Rust", "Voice AI"], location: "Remote", contact: "https://example.com/builder", monitor: false });

test("plans grant 3 spaces on Basic and 20 on every other plan", () => {
  assert.equal(entitlements("basic").spaces, 3);
  for (const plan of ["premium", "principal", "fellow"]) assert.equal(entitlements(plan).spaces, 20);
});
test("errors can carry details for the client", () => {
  const error = new AppError(409, "Full.", { full: true });
  assert.equal(error.status, 409);
  assert.deepEqual(error.details, { full: true });
  assert.equal(new AppError(404, "Missing.").details, undefined);
});
test("the store resolves the acting person for accounts, profiles, and guests", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "spaces-actor-"));
  try {
    const store = createStore(resolve(root, "data/people.json"), resolve(directory, "state.json"));
    assert.equal(await store.actor(""), null);
    assert.equal(await store.actor("unknown"), null);
    const { token: profileToken, person } = await store.join(profile("Profile only"));
    assert.deepEqual(await store.actor(profileToken), { id: person.id, accountId: null, memberId: person.id, name: "Profile only", avatar: "", hasProfile: true, plan: "basic" });
    const login = await store.login({ provider: "github", issuer: "https://github.com", subject: "42", name: "Account only" });
    const actor = await store.actor(login.token);
    assert.equal(actor.id, login.account.id);
    assert.equal(actor.memberId, null);
    assert.equal(actor.hasProfile, false);
    assert.equal(actor.name, "Account only");
    const state = await store.snapshot();
    assert.deepEqual([state.spaces, state.spaceLeases], [[], []]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import { ACCESS, VISIBILITY, can, validCombination } from "../scripts/spaces/permissions.mjs";

const actor = (id, extra = {}) => ({ id: "account:" + id, ids: ["account:" + id, ...(extra.memberId ? [extra.memberId] : [])], hasProfile: Boolean(extra.memberId), admin: false, ...extra });
const owner = actor("owner"), member = actor("member"), stranger = actor("stranger", { memberId: "member:stranger" }), noProfile = actor("plain"), admin = actor("admin", { admin: true });
const space = (visibility, access, extra = {}) => ({ visibility, access, ownerId: owner.id, members: [owner.id, member.id], blocked: [], hostId: null, ...extra });

test("visibility and access combine except private with open or house access", () => {
  assert.deepEqual(VISIBILITY, ["listed", "unlisted", "private"]);
  assert.deepEqual(ACCESS, ["open", "house", "members"]);
  for (const visibility of VISIBILITY) for (const access of ACCESS) assert.equal(validCombination(visibility, access), visibility !== "private" || access === "members", visibility + "/" + access);
  assert.equal(validCombination("secret", "open"), false);
});
test("seeing a space depends only on visibility, membership, invitation, or presence", () => {
  for (const visibility of ["listed", "unlisted"]) assert.equal(can(null, "see", space(visibility, "members")), true);
  const hidden = space("private", "members");
  assert.equal(can(null, "see", hidden), false);
  assert.equal(can(stranger, "see", hidden), false);
  assert.equal(can(stranger, "see", hidden, { invited: true }), true);
  assert.equal(can(member, "see", hidden), true);
  assert.equal(can(owner, "see", hidden), true);
  assert.equal(can(admin, "see", hidden), true);
});
test("entering follows the access rule and never admits guests or blocked people", () => {
  assert.equal(can(null, "enter", space("listed", "open")), false);
  assert.equal(can(noProfile, "enter", space("listed", "open")), true);
  assert.equal(can(noProfile, "enter", space("unlisted", "house")), false);
  assert.equal(can(stranger, "enter", space("unlisted", "house")), true);
  assert.equal(can(member, "enter", space("unlisted", "house")), true, "members may enter house spaces without a profile");
  assert.equal(can(stranger, "enter", space("unlisted", "members")), false);
  assert.equal(can(stranger, "enter", space("unlisted", "members"), { invited: true }), true);
  assert.equal(can(member, "enter", space("private", "members")), true);
  assert.equal(can(stranger, "enter", space("listed", "open", { blocked: ["member:stranger"] })), false, "blocks match any of the person's IDs");
});
test("hosting powers belong to the present host or the present owner; editing belongs to the owner", () => {
  const hosted = space("unlisted", "open", { hostId: member.id });
  for (const action of ["host", "decorate", "moderate"]) {
    assert.equal(can(member, action, hosted, { present: true }), true, action);
    assert.equal(can(member, action, hosted), false, action + " requires presence");
    assert.equal(can(owner, action, hosted, { present: true }), true, action + " owner");
    assert.equal(can(stranger, action, hosted, { present: true }), false, action + " stranger");
  }
  for (const action of ["edit", "invite", "delete"]) {
    assert.equal(can(owner, action, hosted), true, action);
    assert.equal(can(member, action, hosted), false, action);
  }
  assert.equal(can(stranger, "chat", hosted, { present: true }), true);
  assert.equal(can(stranger, "chat", hosted), false);
  assert.equal(can(null, "speak", hosted, { present: true }), false);
  assert.equal(can(admin, "delete", hosted), true);
  assert.equal(can(owner, "fly", hosted), false);
});

import { readFile } from "node:fs/promises";
import { parseMap } from "../world/map.js";
import { DECOR_KINDS, PLAZA_CAPACITY, PLAZA_ID, THEMES, lotSpaceId, migratedRoom, newSpace, normalizeTags, publicSpace, spaceInput, systemSpaces } from "../scripts/spaces/model.mjs";

const plazaMap = parseMap(JSON.parse(await readFile(new URL("../worlds/plaza/map.json", import.meta.url), "utf8")));

test("space input is validated with defaults and partial updates", () => {
  assert.deepEqual(spaceInput({ title: "  Demo night  " }), { title: "Demo night", purpose: "", visibility: "unlisted", access: "members", capacity: 12, themeId: "agora" });
  const current = spaceInput({ title: "Team", visibility: "private", access: "members", capacity: 4, themeId: "cyberpunk" });
  assert.deepEqual(spaceInput({ capacity: 6 }, current), { ...current, capacity: 6 });
  for (const bad of [{ title: "x" }, { title: "Ok", visibility: "listed" }, { title: "Ok", visibility: "private", access: "open" }, { title: "Ok", capacity: 1 }, { title: "Ok", capacity: 51 }, { title: "Ok", capacity: 2.5 }, { title: "Ok", themeId: "neon" }, { title: "Ok", purpose: "p".repeat(301) }]) assert.throws(() => spaceInput(bad), { status: 422 }, JSON.stringify(bad));
});
test("tags are limited to five and normalized", () => {
  assert.deepEqual(normalizeTags([" Voice  AI ", "voice ai", "Rust"]), ["voice ai", "rust"]);
  assert.deepEqual(normalizeTags(), []);
  assert.throws(() => normalizeTags(["a", "b", "c", "d", "e", "f"]), { status: 422 });
  assert.throws(() => normalizeTags(["t".repeat(31)]), { status: 422 });
  assert.throws(() => normalizeTags("rust"), { status: 422 });
});
test("system spaces come from the plaza map and lots are listed, open, and FCFS", () => {
  assert.equal(DECOR_KINDS.length, 13);
  assert.deepEqual(THEMES, ["agora", "minimal", "cyberpunk"]);
  const [plaza, ...lots] = systemSpaces(plazaMap, 0);
  assert.equal(plaza.id, PLAZA_ID);
  assert.equal(plaza.capacity, PLAZA_CAPACITY);
  assert.equal(systemSpaces(plazaMap, 0, 2)[0].capacity, 2);
  assert.equal(lots.length, 6);
  assert.deepEqual(lots[0], { ...lots[0], id: lotSpaceId("ai-agents"), slug: "ai-agents", lot: { worldId: "plaza", lotId: "agents" }, visibility: "listed", access: "open", ownerId: null, capacity: 8, worldId: "plaza", topic: null, tags: [], decor: [] });
});
test("legacy meeting rooms become unlisted members-only spaces with their rosters", () => {
  const room = { id: "fd616fdb-aa48-4c67-bd26-222222222222", title: "Demo", intent: "Plan the demo", ownerId: "member:a", participants: ["member:a", "member:b"], createdAt: "2026-01-01T00:00:00.000Z" };
  const space = migratedRoom(room, 0);
  assert.deepEqual([space.id, space.visibility, space.access, space.ownerId, space.purpose, space.createdAt], [room.id, "unlisted", "members", "member:a", "Plan the demo", room.createdAt]);
  assert.deepEqual(space.members, ["member:a", "member:b"]);
});
test("public spaces hide invitation hashes and the channel epoch", () => {
  const space = { ...newSpace(spaceInput({ title: "Team" }), { id: "s1", ownerId: "account:o", now: 0 }), invitations: [{ id: "i1", tokenHash: "secret", usesLeft: 1, expiresAt: 1 }], channelEpoch: 3 };
  const outside = publicSpace(space, { occupants: [{ id: "account:o", name: "O" }] });
  assert.equal(outside.occupancy, 1);
  for (const field of ["invitations", "members", "blocked", "channelEpoch"]) assert.equal(field in outside, false, field);
  const managed = publicSpace(space, { manage: true });
  assert.deepEqual(managed.invitations, [{ id: "i1", usesLeft: 1, expiresAt: 1 }]);
  assert.deepEqual(managed.members, ["account:o"]);
  assert.equal(JSON.stringify(managed).includes("secret"), false);
});
test("system spaces have independent array instances", () => {
  const [plaza, ...lots] = systemSpaces(plazaMap, 0);
  plaza.decor.push("lamp");
  plaza.members.push("account:test");
  assert.deepEqual(lots[0].decor, []);
  assert.deepEqual(lots[0].members, []);
  assert.notEqual(plaza.decor, lots[0].decor);
  assert.notEqual(plaza.members, lots[0].members);
});

import { LEASE_MS, enter, heartbeat, leaseOf, leasesFor, leave, sweep } from "../scripts/spaces/leases.mjs";

const walker = (id) => ({ id: "account:" + id, ids: ["account:" + id, "member:" + id], name: id.toUpperCase() });
const world = () => { const state = { spaces: systemSpaces(plazaMap, 0), spaceLeases: [] }; return { state, plaza: state.spaces[0], lot: state.spaces.find((space) => space.id === "lot-rtc-lab") }; };

test("the first person in hosts, capacity holds, and one person holds one lease", () => {
  const { state, lot } = world();
  const first = enter(state, lot, walker("a"), 0);
  assert.equal(first.firstIn, true);
  assert.equal(lot.hostId, "account:a");
  assert.deepEqual(first.events, [{ type: "entered", spaceId: lot.id, actorId: "account:a" }, { type: "host", spaceId: lot.id, hostId: "account:a" }]);
  const again = enter(state, lot, walker("a"), 5000);
  assert.equal(again.firstIn, false);
  assert.equal(leasesFor(state, lot.id, 5000).length, 1);
  assert.equal(again.lease.expiresAt, 5000 + LEASE_MS);
  assert.equal(leaseOf(state, lot.id, "member:a", 5000), again.lease, "leases match any of the person's IDs");
  for (const id of ["b", "c", "d", "e", "f"]) assert.equal(enter(state, lot, walker(id), 6000).firstIn, false);
  assert.equal(lot.hostId, "account:a");
  assert.throws(() => enter(state, lot, walker("g"), 7000), { status: 409, message: "This space is full right now." });
});
test("hosting passes to the longest-present person, and the owner hosts whenever present", () => {
  const { state } = world();
  const space = newSpace(spaceInput({ title: "Team", access: "open" }), { id: "s1", ownerId: "account:o", now: 0 });
  state.spaces.push(space);
  enter(state, space, walker("a"), 0);
  enter(state, space, walker("b"), 1000);
  enter(state, space, walker("o"), 2000);
  assert.equal(space.hostId, "account:o");
  assert.deepEqual(leave(state, space, "account:o", 3000), [{ type: "left", spaceId: "s1", actorId: "account:o" }, { type: "host", spaceId: "s1", hostId: "account:a" }]);
  leave(state, space, "account:a", 4000);
  assert.equal(space.hostId, "account:b");
  assert.deepEqual(leave(state, space, "account:nobody", 5000), []);
});
test("an emptied lot clears its session, but a user space keeps its own", () => {
  const { state, lot } = world();
  enter(state, lot, walker("a"), 0);
  Object.assign(lot, { topic: "Demos", tags: ["rtc"], decor: [{ id: "p", kind: "plant", x: 1, y: 1 }], blocked: ["account:z"] });
  const events = leave(state, lot, "account:a", 1000);
  assert.ok(events.some((event) => event.type === "emptied"));
  assert.deepEqual([lot.topic, lot.tags, lot.decor, lot.blocked, lot.hostId], [null, [], [], [], null]);
  const space = { ...newSpace(spaceInput({ title: "Team", access: "open" }), { id: "s2", ownerId: "account:o", now: 0 }), topic: "Keep" };
  state.spaces.push(space);
  enter(state, space, walker("a"), 0);
  leave(state, space, "account:a", 1000);
  assert.equal(space.topic, "Keep");
});
test("expired leases are swept, freeing seats and handing over the host", () => {
  const { state, lot } = world();
  enter(state, lot, walker("a"), 0);
  enter(state, lot, walker("b"), 10000);
  assert.deepEqual(sweep(state, 30000), []);
  const events = sweep(state, LEASE_MS + 1);
  assert.deepEqual(events, [{ type: "left", spaceId: lot.id, actorId: "account:a" }, { type: "host", spaceId: lot.id, hostId: "account:b" }]);
  assert.equal(heartbeat(state, lot, "account:b", 65000).expiresAt, 65000 + LEASE_MS);
  assert.throws(() => heartbeat(state, lot, "account:a", 65000), { status: 410 });
});
test("the plaza never has a host", () => {
  const { state, plaza } = world();
  assert.deepEqual(enter(state, plaza, walker("a"), 0).events, [{ type: "entered", spaceId: "plaza", actorId: "account:a" }]);
  assert.equal(plaza.hostId, null);
});
