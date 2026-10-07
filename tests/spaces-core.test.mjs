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
