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
