import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createStore } from "../scripts/store.mjs";
import { createLedger } from "../scripts/ledger.mjs";

const root = new URL("../", import.meta.url).pathname;
const seed = resolve(root, "data/people.json");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sub = (n) => "acct_" + String(n).padStart(26, "0");
const profile = (name) => ({ name, bio: "Building voice agents with Rust.", intent: "Build a language practice voice agent with natural interruptions.", skills: ["Rust"], contact: "https://example.com/builder" });
let temp;
before(async () => { temp = await mkdtemp(resolve(tmpdir(), "store-identity-")); });
after(async () => { await rm(temp, { recursive: true, force: true }); });
const file = () => resolve(temp, randomBytes(8).toString("hex") + ".json");
const silent = () => {};

// A version 1 state as the Portal wrote it before auth.agora.build: provider accounts, OAuth data and pending links.
const OLD = "account:11111111-1111-4111-8111-111111111111";
const KEPT = sub(7);
const guestToken = "guest-browser-session-token";
function v1() {
  const at = new Date(0).toISOString();
  return {
    accounts: [
      { id: OLD, identities: [{ provider: "github", issuer: "https://github.com", subject: "42", email: "old@example.com" }], name: "Old", avatar: "", contact: "", profileId: "member:linked", createdAt: at, stripeCustomerId: "cus_old", connections: { agora: { iv: "x", ciphertext: "y", tag: "z" } }, sessionEpoch: 3 },
      { id: KEPT, identities: [{ provider: "github", issuer: "https://github.com", subject: "43" }], name: "Kept", avatar: "", profileId: null, createdAt: at, sessionEpoch: 1 }
    ],
    sessions: [{ hash: hash("old-account-session"), accountId: OLD, expiresAt: Date.now() + 86400000 }, { hash: hash("kept-account-session"), accountId: KEPT, expiresAt: Date.now() + 86400000 }],
    authorizationCodes: [{ hash: "code", accountId: OLD, expiresAt: Date.now() + 60000 }],
    grants: [{ id: "grant", accountId: OLD, accessHash: "a", refreshHash: "r", refreshExpiresAt: Date.now() + 86400000 }],
    pendingLinks: [{ hash: "link", accountId: OLD, identity: { provider: "google", issuer: "https://accounts.google.com", subject: "9", email: "old@example.com" }, expiresAt: Date.now() + 600000 }],
    people: [
      { id: "member:guest", name: "Guest", bio: "Guest bio here.", intent: "Guest intent here.", skills: ["Rust"], contact: "https://example.com/guest", source: "community", avatar: "", username: "", projects: [], joinedAt: at, sessionHash: hash(guestToken) },
      { id: "member:linked", name: "Linked", bio: "Linked bio here.", intent: "Linked intent here.", skills: ["Go"], contact: "https://example.com/linked", source: "community", avatar: "", username: "", projects: [], joinedAt: at, accountId: OLD }
    ],
    rooms: [
      { id: "22222222-2222-4222-8222-222222222222", title: "A room", intent: "Talk", ownerId: "member:guest", participants: ["member:guest", "member:linked"], createdAt: at },
      { id: "33333333-3333-4333-8333-333333333333", title: "Linked room", intent: "Gone", ownerId: "member:linked", participants: ["member:linked", "member:guest"], createdAt: at }
    ],
    radar: { "member:guest": { items: [{ title: "A lead" }], intent: "Guest intent here.", checkedAt: at }, "member:linked": { items: [], intent: "Linked intent here.", checkedAt: at } },
    spaces: [
      { id: "plaza", type: "stoa", worldId: "plaza", ownerId: null, members: [], hostId: OLD, title: "The plaza" },
      { id: "space-old", type: "stoa", worldId: "room", ownerId: OLD, members: [OLD, "member:guest"], hostId: OLD, title: "Old's space" },
      { id: "space-guest", type: "stoa", worldId: "room", ownerId: "member:guest", members: ["member:guest", OLD, KEPT], hostId: null, title: "Guest's space" },
      { id: "space-kept", type: "stoa", worldId: "room", ownerId: KEPT, members: [KEPT, "member:linked"], hostId: null, title: "Kept's space" },
      { id: "space-linked", type: "stoa", worldId: "room", ownerId: "member:linked", members: ["member:linked"], hostId: null, title: "Linked's space" }
    ],
    spaceLeases: [
      { spaceId: "space-old", actorId: OLD, ids: [OLD, "member:linked"], name: "Old", enteredAt: 0, expiresAt: Date.now() + 60000 },
      { spaceId: "space-guest", actorId: "member:guest", ids: ["member:guest"], name: "Guest", enteredAt: 0, expiresAt: Date.now() + 60000 },
      { spaceId: "plaza", actorId: OLD, ids: [OLD], name: "Old", enteredAt: 0, expiresAt: Date.now() + 60000 }
    ],
    ledger: {
      balances: { "system:external": -15, [OLD]: 3, [KEPT]: 5, "system:escrow": 2, "system:platform": 5, ["system:refund-debt:" + OLD]: 0 },
      entries: [
        { id: 1, account: "system:external", amount: -10, reason: "Purchase", ref: "d-old", groupId: "g1", createdAt: at },
        { id: 2, account: OLD, amount: 10, reason: "Purchase", ref: "d-old", groupId: "g1", createdAt: at },
        { id: 3, account: "system:external", amount: -5, reason: "Grant", ref: "d-kept", groupId: "g2", createdAt: at },
        { id: 4, account: KEPT, amount: 5, reason: "Grant", ref: "d-kept", groupId: "g2", createdAt: at },
        { id: 5, account: OLD, amount: -5, reason: "vox:x:hold", ref: "r1", groupId: "g3", createdAt: at },
        { id: 6, account: "system:escrow", amount: 5, reason: "vox:x:hold", ref: "r1", groupId: "g3", createdAt: at },
        { id: 7, account: "system:escrow", amount: -5, reason: "vox:x:capture", ref: "r1", groupId: "g4", createdAt: at },
        { id: 8, account: "system:platform", amount: 5, reason: "vox:x:capture", ref: "r1", groupId: "g4", createdAt: at },
        { id: 9, account: OLD, amount: -2, reason: "vox:y:hold", ref: "r2", groupId: "g5", createdAt: at },
        { id: 10, account: "system:escrow", amount: 2, reason: "vox:y:hold", ref: "r2", groupId: "g5", createdAt: at }
      ],
      reservations: [{ id: "r1", userId: OLD, service: "vox:x", credits: 5, key: "k1", status: "captured", createdAt: 0 }, { id: "r2", userId: OLD, service: "vox:y", credits: 2, key: "k2", status: "held", createdAt: 0 }],
      deposits: { "d-old": { userId: OLD, credits: 10, reason: "Purchase", idempotencyKey: "d-old" }, "d-kept": { userId: KEPT, credits: 5, reason: "Grant", idempotencyKey: "d-kept" } },
      debts: { [OLD]: 1 }
    },
    orders: [{ id: "o1", userId: OLD, status: "paid", credits: 10 }, { id: "o2", userId: KEPT, status: "pending", credits: 5 }],
    billingEvents: { evt_1: "checkout.session.completed" },
    activity: [
      { id: "house:1", source: "community", actorId: "member:guest", actorName: "Guest", kind: "member", action: "took a seat in", subject: "the foundry", createdAt: at },
      { id: "house:2", source: "community", actorId: "member:linked", actorName: "Linked", kind: "member", action: "took a seat in", subject: "the foundry", createdAt: at },
      { id: "house:3", source: "community", actorId: "member:guest", actorName: "Guest", kind: "room-join", action: "joined the roster for", subject: "Linked room", roomId: "33333333-3333-4333-8333-333333333333", createdAt: at }
    ]
  };
}

function checkMigrated(state, fixture) {
  assert.equal(state.version, 2);
  assert.deepEqual(state.accounts.map((account) => account.id), [KEPT], "only acct_ accounts remain");
  assert.equal("identities" in state.accounts[0], false);
  assert.equal("sessionEpoch" in state.accounts[0], false);
  assert.deepEqual(state.sessions, []);
  for (const key of ["authorizationCodes", "grants", "pendingLinks"]) assert.equal(key in state, false, key + " is gone");
  assert.deepEqual(state.people.map((person) => person.id), ["member:guest"], "guest profiles stay; a removed account's profile goes");
  assert.equal(state.people[0].sessionHash, hash(guestToken));
  assert.deepEqual(state.rooms, [{ ...fixture.rooms[0], participants: ["member:guest"] }], "the profile's rooms and room places go");
  assert.deepEqual(state.radar, { "member:guest": fixture.radar["member:guest"] });
  assert.deepEqual(state.activity, [fixture.activity[0]], "its activity and activity about its rooms go");
  assert.deepEqual(state.spaces.map((space) => space.id), ["plaza", "space-guest", "space-kept"]);
  assert.deepEqual(state.spaces.find((space) => space.id === "space-kept").members, [KEPT]);
  assert.deepEqual(state.spaces.find((space) => space.id === "space-guest").members, ["member:guest", KEPT]);
  assert.equal(state.spaces.find((space) => space.id === "plaza").hostId, null);
  assert.deepEqual(state.spaceLeases.map((lease) => lease.spaceId), ["space-guest"]);
  const book = state.ledger;
  assert.ok(book.entries.every((entry) => !entry.account.includes(OLD)), "no ledger rows of removed accounts");
  assert.deepEqual(book.entries.map((entry) => entry.id), book.entries.map((_, index) => index + 1));
  assert.equal(book.entries.reduce((total, entry) => total + entry.amount, 0), 0);
  assert.equal(Object.values(book.balances).reduce((total, value) => total + value, 0), 0);
  assert.equal(book.balances[KEPT], 5);
  assert.equal(OLD in book.balances, false);
  assert.equal(book.balances["system:escrow"], 0);
  assert.deepEqual(book.reservations, []);
  assert.deepEqual(Object.keys(book.deposits), ["d-kept"]);
  assert.deepEqual(book.debts, {});
  assert.deepEqual(state.orders.map((order) => order.id), ["o2"]);
  assert.deepEqual(state.billingEvents, fixture.billingEvents);
  assert.ok(!JSON.stringify(state).includes(OLD), "nothing refers to a removed account");
  assert.ok(!JSON.stringify(state).includes("member:linked"), "nothing refers to its profile");
}

test("a version 1 state file starts empty: old accounts and their data go, guests, rooms and the radar stay", async () => {
  const path = file(), fixture = v1(), lines = [];
  await writeFile(path, JSON.stringify(fixture));
  const store = createStore(seed, path, { log: (line) => lines.push(line) });
  checkMigrated(await store.snapshot(), fixture);
  checkMigrated(JSON.parse(await readFile(path, "utf8")), fixture);
  assert.equal(lines.length, 1, "the migration logs once");
  assert.match(lines[0], /1 account/);
  assert.match(lines[0], /2 sessions/);
  assert.match(lines[0], /1 account profile\b/);
  assert.match(lines[0], /2 spaces/, "the account's space and its profile's space");
  for (const secret of [OLD, "member:", "Linked", "old@example.com", hash(guestToken), "cus_old"]) assert.ok(!lines[0].includes(secret), "the log has counts only");
  assert.equal((await store.me(guestToken)).id, "member:guest", "a guest's browser session keeps working");
  assert.equal(await store.browserToken("kept-account-session"), false, "old account sessions end");

  const again = createStore(seed, path, { log: (line) => lines.push(line) });
  const before = await readFile(path, "utf8");
  checkMigrated(await again.snapshot(), fixture);
  await again.transaction(() => {});
  assert.equal(lines.length, 1, "the migration runs once");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), JSON.parse(before));
});

test("the migration runs through a PostgreSQL-style persistence too, once", async () => {
  let document = v1(), writes = 0;
  const fixture = v1();
  const persistence = { async read() { return structuredClone(document); }, async update(change) { const state = structuredClone(document); const value = await change(state); document = state; writes++; return value; } };
  const lines = [];
  const store = createStore(seed, "unused", { persistence, log: (line) => lines.push(line) });
  const [first, second] = await Promise.all([store.snapshot(), store.snapshot()]);
  checkMigrated(first, fixture); checkMigrated(second, fixture);
  checkMigrated(document, fixture);
  assert.equal(lines.length, 1);
  assert.equal(writes, 1);
  const other = createStore(seed, "unused", { persistence, log: (line) => lines.push(line) });
  await other.snapshot();
  assert.equal(lines.length, 1);
  assert.equal(writes, 1, "a migrated state is not rewritten");
});

test("a fresh store is version 2 and logs nothing", async () => {
  const path = file(), lines = [];
  const store = createStore(seed, path, { log: (line) => lines.push(line) });
  assert.equal(await store.actor("").then((actor) => actor.kind), null);
  await store.ensureAccount(sub(1));
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
  assert.deepEqual(lines, []);
});

test("the old identity, linking and OAuth-grant methods are gone", () => {
  const store = createStore(seed, file(), { log: silent });
  for (const name of ["login", "pendingLink", "resolvePendingLink", "authorize", "exchangeCode", "grantForAccount", "refreshGrant", "access", "revokeGrant", "logoutEverywhere", "accountIdentity"]) assert.equal(store[name], undefined, name);
});

test("signIn keys the account by sub, refreshes its name, picture and email, and keeps the ID token private", async () => {
  const path = file();
  const store = createStore(seed, path, { log: silent });
  const first = await store.signIn({ sub: sub(1), sid: "sid-1", name: "Ada", picture: "https://example.com/ada.png", email: "ada@example.com", idToken: "id-token-one" });
  assert.equal(typeof first.token, "string");
  const account = (await store.session(first.token)).account;
  assert.equal(account.id, sub(1));
  assert.equal(account.name, "Ada");
  assert.equal(account.avatar, "https://example.com/ada.png");
  assert.equal(account.email, "ada@example.com");
  assert.equal(account.plan, "basic");
  assert.equal("identities" in account || "providers" in account, false);
  await store.signIn({ sub: sub(1), sid: "sid-1b", name: "Ada", email: "ada@example.com", idToken: "id-token-1b" });
  assert.equal((await store.snapshot()).accounts[0].avatar, "https://example.com/ada.png", "a sign-in without a picture keeps the avatar");
  const second = await store.signIn({ sub: sub(1), sid: "sid-2", name: "Ada L.", picture: null, email: null, idToken: "id-token-two" });
  assert.equal((await store.snapshot()).accounts[0].avatar, "", "a sign-in whose picture is null clears it");
  const state = await store.snapshot();
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].name, "Ada L.");
  assert.equal(state.accounts[0].email, null, "an unverified or absent email is not stored");
  assert.ok(state.accounts[0].updatedAt);
  assert.equal((await store.session(second.token)).account.id, sub(1));
  const saved = await readFile(path, "utf8");
  assert.ok(!saved.includes(first.token) && !saved.includes(second.token), "session tokens are stored hashed");
  assert.ok(!JSON.stringify(await store.session(first.token)).includes("id-token"), "the ID token is never served");
  for (const bad of ["account:11111111-1111-4111-8111-111111111111", "acct_short", "", undefined, "acct_" + "a".repeat(26), "acct_" + "I".repeat(26)]) await assert.rejects(store.signIn({ sub: bad, idToken: "x" }), { status: 422 });
});

test("an account keeps at most 20 sessions", async () => {
  const store = createStore(seed, file(), { log: silent });
  const tokens = [];
  for (let index = 0; index < 21; index++) tokens.push((await store.signIn({ sub: sub(2), sid: "sid-" + index, name: "Bo", idToken: "t" + index })).token);
  const other = await store.signIn({ sub: sub(3), sid: "other", name: "Cy", idToken: "o" });
  assert.equal(await store.browserToken(tokens[0]), false, "the oldest session ends");
  for (const token of tokens.slice(1)) assert.equal(await store.browserToken(token), true);
  assert.equal(await store.browserToken(other.token), true);
  assert.equal((await store.snapshot()).sessions.filter((session) => session.accountId === sub(2)).length, 20);
});

test("account sessions last 30 days", async () => {
  let clock = Date.now();
  const store = createStore(seed, file(), { now: () => clock, log: silent });
  const { token } = await store.signIn({ sub: sub(4), sid: "s", name: "Di", idToken: "t" });
  clock += 29 * 86400000;
  assert.equal((await store.session(token)).account.id, sub(4));
  clock += 2 * 86400000;
  assert.deepEqual(await store.session(token), { profile: null, account: null });
  assert.deepEqual(await store.actor(token), { kind: null });
});

test("an auth transaction is used once, lasts 600 seconds, and at most 1000 are kept", async () => {
  let clock = Date.now();
  const store = createStore(seed, file(), { now: () => clock, log: silent });
  const tx = { id: "transaction-one", state: "state", nonce: "nonce", verifier: "verifier", returnTo: "/stoa/", createdAt: clock };
  await store.saveAuthTransaction(tx);
  assert.equal(JSON.stringify(await store.snapshot()).includes("transaction-one"), false, "the cookie value is stored hashed");
  assert.deepEqual(await store.takeAuthTransaction("transaction-one"), tx);
  assert.equal(await store.takeAuthTransaction("transaction-one"), null, "single use");
  assert.equal(await store.takeAuthTransaction(""), null);
  assert.equal(await store.takeAuthTransaction(undefined), null);
  await store.saveAuthTransaction({ ...tx, id: "transaction-two" });
  clock += 600000;
  assert.equal(await store.takeAuthTransaction("transaction-two"), null, "expired");
  await store.saveAuthTransaction({ ...tx, id: "transaction-three" });
  clock += 599000;
  assert.equal((await store.takeAuthTransaction("transaction-three")).id, "transaction-three");
  for (let index = 0; index < 1001; index++) await store.saveAuthTransaction({ ...tx, id: "bulk-" + index });
  const kept = (await store.snapshot()).authTransactions;
  assert.equal(kept.length, 1000);
  assert.equal(await store.takeAuthTransaction("bulk-0"), null, "the oldest is dropped");
  assert.equal((await store.takeAuthTransaction("bulk-1000")).id, "bulk-1000");
  await assert.rejects(store.saveAuthTransaction({ state: "no id" }), { status: 422 });
});

test("ensureAccount creates a minimal account once, without overwriting a signed-in one", async () => {
  const store = createStore(seed, file(), { log: silent });
  const created = await store.ensureAccount(sub(5));
  assert.equal(created.id, sub(5));
  assert.equal(created.name, null);
  assert.equal((await store.ensureAccount(sub(5))).id, sub(5));
  assert.equal((await store.snapshot()).accounts.length, 1);
  const ledger = createLedger(store);
  assert.equal((await ledger.balance(sub(5))).credits, 0, "an app user gets a wallet");
  await store.signIn({ sub: sub(5), sid: "s", name: "Eve", idToken: "t" });
  assert.equal((await store.ensureAccount(sub(5))).name, "Eve");
  const [one, two] = await Promise.all([store.ensureAccount(sub(6)), store.ensureAccount(sub(6))]);
  assert.equal(one.id, two.id);
  assert.equal((await store.snapshot()).accounts.filter((account) => account.id === sub(6)).length, 1);
  for (const bad of ["account:11111111-1111-4111-8111-111111111111", "acct_", null]) await assert.rejects(store.ensureAccount(bad), { status: 422 });
});

test("endSessionsBySid with a sub ends only that sub's sessions with the sid", async () => {
  const store = createStore(seed, file(), { log: silent });
  const one = await store.signIn({ sub: sub(20), sid: "same", idToken: "t" });
  const two = await store.signIn({ sub: sub(21), sid: "same", idToken: "t" });
  assert.deepEqual(await store.endSessionsBySid("same", sub(20)), { ended: 1 });
  assert.equal((await store.actor(one.token)).kind, null);
  assert.equal((await store.actor(two.token)).kind, "account");
});

test("endSession returns the ID token; sessions end by sid or by sub", async () => {
  const store = createStore(seed, file(), { log: silent });
  const a1 = await store.signIn({ sub: sub(8), sid: "sid-a", name: "Fay", idToken: "id-a1" });
  const a2 = await store.signIn({ sub: sub(8), sid: "sid-a", name: "Fay", idToken: "id-a2" });
  const b = await store.signIn({ sub: sub(8), sid: "sid-b", name: "Fay", idToken: "id-b" });
  const c = await store.signIn({ sub: sub(9), sid: "sid-c", name: "Gus", idToken: "id-c" });
  const d = await store.signIn({ sub: sub(9), sid: null, name: "Gus", idToken: "id-d" });
  assert.deepEqual(await store.endSession(a1.token), { idToken: "id-a1" });
  assert.equal(await store.browserToken(a1.token), false);
  assert.deepEqual(await store.endSession(a1.token), { idToken: null });
  assert.deepEqual(await store.endSession(""), { idToken: null });
  await store.endSessionsBySid("sid-a");
  assert.equal(await store.browserToken(a2.token), false);
  assert.equal(await store.browserToken(b.token), true, "another sid of the same account stays");
  await store.endSessionsBySid(null); await store.endSessionsBySid("");
  assert.equal(await store.browserToken(d.token), true, "an empty sid matches nothing");
  await store.endSessionsBySub(sub(9));
  assert.equal(await store.browserToken(c.token), false);
  assert.equal(await store.browserToken(d.token), false);
  assert.equal(await store.browserToken(b.token), true, "other accounts stay");
});

test("actor resolves an account session, a guest profile session, or nothing", async () => {
  const store = createStore(seed, file(), { log: silent });
  assert.deepEqual(await store.actor(""), { kind: null });
  assert.deepEqual(await store.actor("unknown"), { kind: null });
  const guest = await store.join(profile("Guest one"));
  const asGuest = await store.actor(guest.token);
  assert.equal(asGuest.kind, "guest");
  assert.equal(asGuest.profile.id, guest.person.id);
  assert.equal(asGuest.account, undefined);
  const { token } = await store.signIn({ sub: sub(10), sid: "s", name: "Hal", idToken: "t" });
  const asAccount = await store.actor(token);
  assert.equal(asAccount.kind, "account");
  assert.equal(asAccount.account.id, sub(10));
  assert.equal(asAccount.profile, null);
  const joined = await store.join(profile("Hal"), token);
  assert.notEqual(joined.token, token);
  assert.equal(await store.browserToken(token), false, "joining replaces the account session, so the old token stops working");
  assert.deepEqual(await store.actor(token), { kind: null });
  const withProfile = await store.actor(joined.token);
  assert.equal(withProfile.kind, "account");
  assert.equal(withProfile.profile.name, "Hal");
  assert.ok(!JSON.stringify(withProfile).includes("sessionHash"));
  const sessions = (await store.snapshot()).sessions.filter((session) => session.accountId === sub(10));
  assert.ok(sessions.every((session) => session.sid === "s"), "a session made on joining keeps the sign-in's sid");
  await store.endSessionsBySid("s");
  assert.deepEqual(await store.actor(joined.token), { kind: null });
});

test("removing a public profile keeps the account signed in and deletes the profile's rooms", async () => {
  const store = createStore(seed, file(), { log: silent });
  const { token } = await store.signIn({ sub: sub(11), sid: "s", name: "Ida", idToken: "t" });
  const member = await store.join(profile("Ida"), token);
  await store.createRoom(member.token, { title: "Temporary room", intent: "Delete this room" });
  await store.remove(member.token);
  assert.equal((await store.session(member.token)).account.id, sub(11));
  assert.equal((await store.session(member.token)).profile, null);
  assert.equal((await store.rooms()).length, 0);
});

test("signIn with a guest token adopts that browser's guest profile when the account has none", async () => {
  const store = createStore(seed, file(), { log: silent });
  const guest = await store.join(profile("Guest adopter"));
  const { token } = await store.signIn({ sub: sub(12), sid: "s", name: "Jo", picture: "https://example.com/jo.png", idToken: "t", guestToken: guest.token });
  const actor = await store.actor(token);
  assert.equal(actor.kind, "account");
  assert.equal(actor.profile.id, guest.person.id);
  assert.equal(actor.profile.avatar, "https://example.com/jo.png", "an empty guest avatar takes the account picture");
  assert.equal(await store.browserToken(guest.token), false, "the guest token stops working");
  const state = await store.snapshot();
  assert.equal(state.accounts.find((account) => account.id === sub(12)).profileId, guest.person.id);
  const person = state.people.find((entry) => entry.id === guest.person.id);
  assert.equal(person.accountId, sub(12));
  assert.equal("sessionHash" in person, false);
  assert.equal(await store.accountProfile(sub(12)).then((value) => value?.id), guest.person.id);
  // The account now has a profile, so a second guest stays a guest.
  const other = await store.join(profile("Other guest"));
  const again = await store.signIn({ sub: sub(12), sid: "s2", idToken: "t", guestToken: other.token });
  assert.equal((await store.actor(again.token)).profile.id, guest.person.id);
  assert.deepEqual(await store.actor(other.token), { kind: null }, "the browser's guest token stops working");
  assert.equal((await store.snapshot()).people.some((person) => person.id === other.person.id), false, "the unadopted guest profile is removed");
  // A previous account session in the same browser is replaced, and unknown guest tokens change nothing.
  const replaced = await store.signIn({ sub: sub(13), sid: "s3", idToken: "t", guestToken: again.token });
  assert.equal(await store.browserToken(again.token), false);
  assert.equal((await store.actor(replaced.token)).profile, null);
  await store.signIn({ sub: sub(14), idToken: "t", guestToken: "no-such-token" });
  assert.equal(await store.accountProfile(sub(14)), null);
});

test("removing a profile also drops the spaces it owns and its memberships and leases elsewhere", async () => {
  const store = createStore(seed, file(), { log: silent });
  const guest = await store.join(profile("Space guest"));
  const id = guest.person.id;
  await store.transaction((state) => {
    state.spaces.push({ id: "11111111-1111-4111-8111-000000000001", ownerId: id, members: [id], blocked: [], invitations: [] });
    state.spaces.push({ id: "11111111-1111-4111-8111-000000000002", ownerId: sub(30), hostId: id, members: [sub(30), id], blocked: [id], invitations: [{ createdBy: id }, { createdBy: sub(30) }] });
    state.spaceLeases.push({ spaceId: "11111111-1111-4111-8111-000000000001", actorId: id, ids: [id] }, { spaceId: "11111111-1111-4111-8111-000000000002", actorId: id, ids: [id] }, { spaceId: "11111111-1111-4111-8111-000000000002", actorId: sub(30), ids: [sub(30)] });
  });
  await store.remove(guest.token);
  const state = await store.snapshot();
  assert.deepEqual(state.spaces.map((space) => space.id), ["11111111-1111-4111-8111-000000000002"]);
  assert.deepEqual([state.spaces[0].hostId, state.spaces[0].members, state.spaces[0].blocked, state.spaces[0].invitations], [null, [sub(30)], [], [{ createdBy: sub(30) }]]);
  assert.deepEqual(state.spaceLeases.map((lease) => lease.actorId), [sub(30)]);
});
test("joining keeps the sign-in session's absolute expiry rather than renewing it", async () => {
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const store = createStore(seed, file(), { now: () => clock, log: silent });
  const { token } = await store.signIn({ sub: sub(12), sid: "s", name: "Jo", idToken: "t" });
  const signedInUntil = (await store.snapshot()).sessions.find((session) => session.accountId === sub(12)).expiresAt;
  clock += 20 * 86400000;
  const joined = await store.join(profile("Jo"), token);
  const sessions = (await store.snapshot()).sessions.filter((session) => session.accountId === sub(12));
  assert.deepEqual(sessions.map((session) => session.expiresAt), [signedInUntil]);
  clock = signedInUntil;
  assert.deepEqual(await store.actor(joined.token), { kind: null }, "the joined session ends with the sign-in's 30 days");
});
