import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { effectivePlan, entitlements } from "./plans.mjs";

export class AppError extends Error {
  constructor(status, message, details) { super(message); this.status = status; if (details) this.details = details; }
}
// Portal account IDs are the auth.agora.build subject.
export const ACCOUNT_ID = /^acct_[0-9A-HJKMNP-TV-Z]{26}$/;
export const STATE_VERSION = 2;
const SESSION_LIFETIME = 30 * 86400000;
const SESSIONS_PER_ACCOUNT = 20;
const TRANSACTION_LIFETIME = 600000;
const TRANSACTION_LIMIT = 1000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const publicProfile = ({ sessionHash, accountId, ...person }) => person;
const publicRoom = ({ videoUrl, ...room }) => ({ ...room, callProvider: "agora", path: "/meet/" + room.id });
const publicAccount = (account) => account ? { id: account.id, name: account.name ?? null, avatar: account.avatar || "", email: account.email ?? null, plan: effectivePlan(account), entitlements: entitlements(effectivePlan(account)), connections: Object.keys(account.connections || {}) } : null;
export const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
};

export function text(input, field, max, required = true) {
  const value = typeof input[field] === "string" ? input[field].trim() : "";
  if ((required && value.length < 2) || value.length > max) throw new AppError(422, "Add " + field + " of " + (required ? "2 to " : "up to ") + max + " characters.");
  return value;
}

function fields(input) {
  const contact = safeUrl(text(input, "contact", 240));
  if (!contact) throw new AppError(422, "Add a valid public HTTP or HTTPS contact link.");
  if (!Array.isArray(input.skills) || input.skills.length < 1 || input.skills.length > 8 || input.skills.some((skill) => typeof skill !== "string" || !skill.trim() || skill.length > 40)) throw new AppError(422, "Add 1 to 8 skills or interests.");
  return {
    name: text(input, "name", 60), bio: text(input, "bio", 400),
    intent: text(input, "intent", 400), lookingFor: text(input, "lookingFor", 300, false),
    location: text(input, "location", 80, false), contact,
    skills: [...new Set(input.skills.map((skill) => skill.trim()))],
    monitor: input.monitor === true
  };
}

const plural = (count, word) => count + " " + word + (count === 1 ? "" : "s");
// Version 2 starts empty: the Portal's own provider accounts, sessions, OAuth codes and grants, and pending links go,
// with every ledger, billing and space row of those accounts. Guests' profiles, rooms and the radar stay.
export function migrateState(state) {
  const removed = new Set((state.accounts || []).filter((account) => !ACCOUNT_ID.test(account?.id || "")).map((account) => account?.id));
  const isRemoved = (id) => typeof id === "string" && removed.has(id);
  // A removed account's public profile can no longer be signed in to, so it goes the way store.remove() takes a profile.
  const orphans = new Set((state.people || []).filter((person) => isRemoved(person.accountId)).map((person) => person.id));
  const gone = (id) => typeof id === "string" && (removed.has(id) || orphans.has(id));
  const counts = { accounts: removed.size, profiles: orphans.size, sessions: (state.sessions || []).length, codes: (state.authorizationCodes || []).length, grants: (state.grants || []).length, links: (state.pendingLinks || []).length, spaces: 0, orders: 0, entries: 0 };
  state.accounts = (state.accounts || []).filter((account) => !gone(account?.id));
  for (const account of state.accounts) { delete account.identities; delete account.sessionEpoch; delete account.contact; }
  state.sessions = [];
  delete state.authorizationCodes; delete state.grants; delete state.pendingLinks;
  if (state.people) state.people = state.people.filter((person) => !orphans.has(person.id));
  const ownedRooms = new Set((state.rooms || []).filter((room) => orphans.has(room.ownerId)).map((room) => room.id));
  if (state.rooms) state.rooms = state.rooms.filter((room) => !ownedRooms.has(room.id));
  for (const room of state.rooms || []) if (Array.isArray(room.participants)) room.participants = room.participants.filter((id) => !orphans.has(id));
  if (state.activity) state.activity = state.activity.filter((entry) => !orphans.has(entry.actorId) && !ownedRooms.has(entry.roomId));
  for (const id of orphans) if (state.radar) delete state.radar[id];
  const spaces = state.spaces || [];
  const dropped = new Set(spaces.filter((space) => gone(space.ownerId)).map((space) => space.id));
  counts.spaces = dropped.size;
  state.spaces = spaces.filter((space) => !dropped.has(space.id));
  for (const space of state.spaces) {
    if (Array.isArray(space.members)) space.members = space.members.filter((id) => !gone(id));
    if (Array.isArray(space.blocked)) space.blocked = space.blocked.filter((id) => !gone(id));
    if (Array.isArray(space.invitations)) space.invitations = space.invitations.filter((invitation) => !gone(invitation.createdBy));
    if (gone(space.hostId)) space.hostId = null;
  }
  state.spaceLeases = (state.spaceLeases || []).filter((lease) => !dropped.has(lease.spaceId) && !gone(lease.actorId) && !(lease.ids || []).some(gone));
  const orders = state.orders || [];
  const refs = new Set(orders.filter((order) => gone(order.userId)).map((order) => order.id));
  counts.orders = refs.size;
  if (state.orders) state.orders = orders.filter((order) => !gone(order.userId));
  const book = state.ledger;
  if (book) {
    for (const reservation of book.reservations || []) if (gone(reservation.userId)) refs.add(reservation.id);
    for (const [key, deposit] of Object.entries(book.deposits || {})) if (gone(deposit?.userId)) { refs.add(key); delete book.deposits[key]; }
    const owned = (account) => gone(account) || (typeof account === "string" && account.startsWith("system:refund-debt:") && gone(account.slice(19)));
    // A transfer is removed whole, together with the escrow and refund movements of the removed accounts' rows, so the book still balances.
    const groups = new Set((book.entries || []).filter((entry) => owned(entry.account) || refs.has(entry.ref)).map((entry) => entry.groupId));
    const keep = [];
    for (const entry of book.entries || []) {
      if (groups.has(entry.groupId)) { counts.entries++; if (book.balances && Object.hasOwn(book.balances, entry.account)) book.balances[entry.account] -= entry.amount; }
      else keep.push(entry);
    }
    book.entries = keep.map((entry, index) => ({ ...entry, id: index + 1 }));
    for (const key of Object.keys(book.balances || {})) if (owned(key)) delete book.balances[key];
    if (book.reservations) book.reservations = book.reservations.filter((reservation) => !gone(reservation.userId));
    for (const key of Object.keys(book.debts || {})) if (gone(key)) delete book.debts[key];
  }
  state.version = STATE_VERSION;
  return counts;
}

export function createStore(seedFile, storageFile, { now = Date.now, persistence, log = (line) => console.log(line) } = {}) {
  let queue = Promise.resolve();
  let prepared;
  const normalize = (state) => {
    if (state.version !== STATE_VERSION) {
      const used = Object.keys(state).length > 0;
      const counts = migrateState(state);
      if (used) log("Portal state moved to version 2 (sign-in through auth.agora.build): removed " + plural(counts.accounts, "account") + ", " + plural(counts.profiles, "account profile") + ", " + plural(counts.sessions, "session") + ", " + plural(counts.codes, "authorization code") + ", " + plural(counts.grants, "grant") + ", " + plural(counts.links, "pending link") + ", " + plural(counts.spaces, "space") + ", " + plural(counts.orders, "order") + " and " + counts.entries + (counts.entries === 1 ? " ledger entry" : " ledger entries") + "; kept " + plural((state.people || []).length, "profile") + " and " + plural((state.rooms || []).length, "room") + ".");
    }
    state.accounts ||= []; state.sessions ||= []; state.authTransactions ||= [];
    state.people ||= []; state.rooms ||= []; state.radar ||= {}; state.spaces ||= []; state.spaceLeases ||= [];
    return state;
  };
  async function load() {
    if (persistence) return persistence.read();
    try { return JSON.parse(await readFile(storageFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { version: STATE_VERSION }; throw error; }
  }
  function write(change) {
    // Keep concurrent joins and room updates inside one atomic read/write cycle.
    const operation = queue.catch(() => {}).then(async () => {
      const mutate = (state) => {
        normalize(state);
        state.sessions = state.sessions.filter((session) => session.expiresAt > now());
        state.authTransactions = state.authTransactions.filter((entry) => entry.expiresAt > now());
        return change(state);
      };
      if (persistence) return persistence.update(mutate);
      const state = await load();
      const result = await mutate(state);
      await mkdir(dirname(storageFile), { recursive: true });
      await writeFile(storageFile + ".tmp", JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(storageFile + ".tmp", storageFile);
      return result;
    });
    queue = operation;
    return operation;
  }
  // The one-time migration is written before anything else reads or changes the state.
  const prepare = () => prepared ||= (async () => {
    const state = await load();
    if (state.version !== STATE_VERSION && Object.keys(state).length) await write(() => {});
  })().catch((error) => { prepared = undefined; throw error; });
  async function read() { await prepare(); return normalize(await load()); }
  async function update(change) { await prepare(); return write(change); }
  const validSub = (sub) => { if (typeof sub !== "string" || !ACCOUNT_ID.test(sub)) throw new AppError(422, "This account ID is invalid."); return sub; };
  const newAccount = (id) => { const at = new Date(now()).toISOString(); return { id, name: null, avatar: "", email: null, profileId: null, createdAt: at, updatedAt: at }; };
  const sessionFor = (state, token) => (token && state.sessions.find((session) => session.hash === hash(token) && session.expiresAt > now())) || null;
  const accountFor = (state, token) => {
    const session = sessionFor(state, token);
    return (session && state.accounts.find((account) => account.id === session.accountId)) || null;
  };
  const personFor = (state, token) => {
    const account = accountFor(state, token);
    return account ? state.people.find((person) => person.id === account.profileId) : token && state.people.find((person) => person.sessionHash === hash(token));
  };
  const owner = (state, token) => {
    const person = personFor(state, token);
    if (!person) throw new AppError(401, "Join the house to use this feature.");
    return person;
  };
  const record = (state, person, kind, action, subject, extra = {}) => {
    state.activity = [{ id: "house:" + randomUUID(), source: "community", actorId: person.id, actorName: person.name, kind, action, subject, createdAt: new Date().toISOString(), ...extra }, ...(state.activity || [])].slice(0, 100);
  };
  const addSession = (state, account, token, { sid = null, idToken = null } = {}) => {
    const own = state.sessions.filter((entry) => entry.accountId === account.id).slice(-(SESSIONS_PER_ACCOUNT - 1));
    state.sessions = [...state.sessions.filter((entry) => entry.accountId !== account.id), ...own, { hash: hash(token), accountId: account.id, sid, idToken, expiresAt: now() + SESSION_LIFETIME }];
  };
  const endWhere = (match) => update((state) => {
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((session) => !match(session));
    return { ended: before - state.sessions.length };
  });
  return {
    transaction: update,
    snapshot: read,
    async browserToken(token) {
      if (!token) return false;
      const state = await read();
      return Boolean(sessionFor(state, token)) || state.people.some((person) => person.sessionHash === hash(token));
    },
    async people() { return [...(await read()).people.map(publicProfile), ...JSON.parse(await readFile(seedFile, "utf8"))]; },
    async me(token) { const person = personFor(await read(), token); return person ? publicProfile(person) : null; },
    // A Portal session resolves to its account; a guest's browser profile session resolves to the guest.
    async actor(token) {
      if (!token) return { kind: null };
      const state = await read();
      const account = accountFor(state, token);
      const person = personFor(state, token);
      if (account) return { kind: "account", account: publicAccount(account), profile: person ? publicProfile(person) : null };
      if (person) return { kind: "guest", profile: publicProfile(person) };
      return { kind: null };
    },
    async session(token) {
      const state = await read();
      const person = personFor(state, token);
      return { profile: person ? publicProfile(person) : null, account: publicAccount(accountFor(state, token)) };
    },
    async saveAuthTransaction(tx) {
      if (!tx || typeof tx.id !== "string" || !tx.id) throw new AppError(422, "This sign-in transaction is invalid.");
      const { id, ...rest } = tx;
      return update((state) => {
        state.authTransactions = [...state.authTransactions.filter((entry) => entry.hash !== hash(id)), { ...rest, hash: hash(id), expiresAt: now() + TRANSACTION_LIFETIME }].slice(-TRANSACTION_LIMIT);
      });
    },
    // Single use: the transaction is removed as it is read, so a replayed callback finds nothing.
    async takeAuthTransaction(id) {
      if (typeof id !== "string" || !id) return null;
      return update((state) => {
        const entry = state.authTransactions.find((value) => value.hash === hash(id));
        if (!entry) return null;
        state.authTransactions = state.authTransactions.filter((value) => value !== entry);
        const { hash: _, expiresAt, ...tx } = entry;
        return { id, ...tx };
      });
    },
    async signIn({ sub, sid = null, name = null, picture, email = null, idToken = null } = {}) {
      validSub(sub);
      const token = randomBytes(32).toString("base64url");
      return update((state) => {
        let account = state.accounts.find((entry) => entry.id === sub);
        if (!account) { account = newAccount(sub); state.accounts.push(account); }
        if (typeof name === "string" && name.trim()) account.name = name.trim().slice(0, 60);
        if (picture !== undefined) account.avatar = safeUrl(picture || "");
        // The IdP client passes an email only when it is verified.
        account.email = typeof email === "string" && email ? email.toLowerCase() : null;
        account.updatedAt = new Date(now()).toISOString();
        addSession(state, account, token, { sid: typeof sid === "string" && sid ? sid : null, idToken: typeof idToken === "string" && idToken ? idToken : null });
        return { token };
      });
    },
    // The first access token for a subject gives it a minimal account, so app users get a wallet.
    async ensureAccount(sub) {
      validSub(sub);
      const existing = (await read()).accounts.find((account) => account.id === sub);
      if (existing) return publicAccount(existing);
      return update((state) => {
        let account = state.accounts.find((entry) => entry.id === sub);
        if (!account) { account = newAccount(sub); state.accounts.push(account); }
        return publicAccount(account);
      });
    },
    async endSession(token) {
      if (!token) return { idToken: null };
      return update((state) => {
        const session = state.sessions.find((entry) => entry.hash === hash(token));
        state.sessions = state.sessions.filter((entry) => entry !== session);
        const legacy = state.people.find((person) => person.sessionHash === hash(token));
        if (legacy) delete legacy.sessionHash;
        return { idToken: session?.idToken || null };
      });
    },
    endSessionsBySid(sid) { return typeof sid === "string" && sid ? endWhere((session) => session.sid === sid) : Promise.resolve({ ended: 0 }); },
    endSessionsBySub(sub) { return typeof sub === "string" && sub ? endWhere((session) => session.accountId === sub) : Promise.resolve({ ended: 0 }); },
    async join(input, currentToken) {
      const token = randomBytes(32).toString("base64url");
      const person = { id: "member:" + randomUUID(), ...fields(input), source: "community", avatar: "", username: "", projects: [], joinedAt: new Date().toISOString(), sessionHash: hash(token) };
      await update((state) => {
        const account = accountFor(state, currentToken);
        const current = sessionFor(state, currentToken);
        if (personFor(state, currentToken)) throw new AppError(409, "You already have a profile. Edit it instead.");
        if (state.people.length >= 500) throw new AppError(409, "The house is full for now.");
        if (account) {
          person.accountId = account.id;
          person.avatar = account.avatar;
          delete person.sessionHash;
          account.profileId = person.id;
          // The new session replaces the one that joined, so the old token stops working.
          if (current) state.sessions = state.sessions.filter((session) => session !== current);
          addSession(state, account, token, { sid: current?.sid, idToken: current?.idToken });
        }
        state.people.unshift(person);
        record(state, person, "member", "took a seat in", "the foundry", { url: "index.html#people" });
      });
      return { person: publicProfile(person), token };
    },
    async edit(token, input) {
      const value = fields(input);
      return update((state) => {
        const person = owner(state, token);
        const changedIntent = person.intent !== value.intent;
        Object.assign(person, value);
        for (const entry of state.activity || []) if (entry.actorId === person.id) entry.actorName = person.name;
        if (changedIntent) record(state, person, "intent", "shared a new intent in", "the foundry", { url: "index.html#people" });
        delete state.radar[person.id];
        return publicProfile(person);
      });
    },
    async remove(token) {
      return update((state) => {
        const person = owner(state, token);
        const ownedRooms = new Set(state.rooms.filter((room) => room.ownerId === person.id).map((room) => room.id));
        state.people = state.people.filter((entry) => entry.id !== person.id);
        for (const account of state.accounts) if (account.profileId === person.id) account.profileId = null;
        state.rooms = state.rooms.filter((room) => room.ownerId !== person.id);
        for (const room of state.rooms) room.participants = room.participants.filter((id) => id !== person.id);
        state.activity = (state.activity || []).filter((entry) => entry.actorId !== person.id && !ownedRooms.has(entry.roomId));
        delete state.radar[person.id];
      });
    },
    async rooms() { return (await read()).rooms.map(publicRoom); },
    async activity() { return (await read()).activity || []; },
    async createRoom(token, input) {
      const title = text(input, "title", 80);
      const intent = text(input, "intent", 300);
      return update((state) => {
        const person = owner(state, token);
        if (state.rooms.length >= 100) throw new AppError(409, "The room directory is full for now.");
        const id = randomUUID();
        const room = { id, title, intent, ownerId: person.id, participants: [person.id], createdAt: new Date().toISOString() };
        state.rooms.unshift(room);
        record(state, person, "room", "opened a room for", title, { roomId: id, url: "/meet/" + id });
        return publicRoom(room);
      });
    },
    async joinRoom(token, id) {
      return update((state) => {
        const person = owner(state, token);
        const room = state.rooms.find((room) => room.id === id);
        if (!room) throw new AppError(404, "This room was not found.");
        if (!room.participants.includes(person.id)) {
          room.participants.push(person.id);
          record(state, person, "room-join", "joined the roster for", room.title, { roomId: id, url: "/meet/" + id });
        }
        return publicRoom(room);
      });
    },
    async radar(id) { return (await read()).radar[id] || null; },
    async saveRadar(id, result, intent) {
      return update((state) => {
        const person = state.people.find((person) => person.id === id);
        if (person && (!intent || person.intent === intent)) state.radar[id] = { ...result, intent: person.intent, checkedAt: new Date().toISOString() };
        return state.radar[id] || null;
      });
    }
  };
}
