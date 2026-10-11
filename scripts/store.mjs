import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { effectivePlan, entitlements } from "./plans.mjs";

export class AppError extends Error {
  constructor(status, message, details) { super(message); this.status = status; if (details) this.details = details; }
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (entry) => (other) => other.provider === entry.provider && other.issuer === entry.issuer && other.subject === entry.subject;
const publicProfile = ({ sessionHash, accountId, ...person }) => person;
const publicRoom = ({ videoUrl, ...room }) => ({ ...room, callProvider: "agora", path: "/meet/" + room.id });
const publicAccount = (account) => account ? { id: account.id, name: account.name, avatar: account.avatar, contact: account.contact, providers: account.identities.filter((identity) => identity.provider !== "service").map((identity) => identity.provider), emails: [...new Set(account.identities.map((identity) => identity.email).filter(Boolean))], plan: effectivePlan(account), entitlements: entitlements(effectivePlan(account)), connections: Object.keys(account.connections || {}) } : null;
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

export function createStore(seedFile, storageFile, { now = Date.now, persistence } = {}) {
  let queue = Promise.resolve();
  const normalize = (state) => {
    state.accounts ||= []; state.sessions ||= []; state.authorizationCodes ||= []; state.grants ||= [];
    state.people ||= []; state.rooms ||= []; state.radar ||= {}; state.spaces ||= []; state.spaceLeases ||= [];
    return state;
  };
  async function read() {
    if (persistence) return normalize(await persistence.read());
    try {
      const state = JSON.parse(await readFile(storageFile, "utf8"));
      return normalize(state);
    } catch (error) { if (error.code === "ENOENT") return { people: [], rooms: [], radar: {}, accounts: [], sessions: [], authorizationCodes: [], grants: [], spaces: [], spaceLeases: [] }; throw error; }
  }
  function update(change) {
    // Keep concurrent joins and room updates inside one atomic read/write cycle.
    const operation = queue.catch(() => {}).then(async () => {
      const mutate = (state) => {
        normalize(state);
        state.sessions = state.sessions.filter((session) => session.expiresAt > now());
        state.authorizationCodes = state.authorizationCodes.filter((code) => code.expiresAt > now());
        state.grants = state.grants.filter((grant) => grant.refreshExpiresAt > now());
        return change(state);
      };
      if (persistence) return persistence.update(mutate);
      const state = await read();
      const result = await mutate(state);
      await mkdir(dirname(storageFile), { recursive: true });
      await writeFile(storageFile + ".tmp", JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(storageFile + ".tmp", storageFile);
      return result;
    });
    queue = operation;
    return operation;
  }
  const newAccount = (profile) => ({ id: "account:" + randomUUID(), identities: [], name: String(profile.name || "Builder").slice(0, 60), avatar: safeUrl(profile.avatar || ""), contact: safeUrl(profile.contact || ""), profileId: null, createdAt: new Date(now()).toISOString() });
  const loginsOf = (account) => [...new Set(account.identities.filter((entry) => entry.provider !== "service").map((entry) => entry.provider))];
  const accountFor = (state, token) => {
    const session = token && state.sessions.find((session) => session.hash === hash(token) && session.expiresAt > now());
    const grant = token && state.grants.find((grant) => grant.accessHash === hash(token) && grant.accessExpiresAt > now() && validGrant(state, grant));
    return state.accounts.find((account) => account.id === (session?.accountId || grant?.accountId)) || null;
  };
  const validGrant = (state, grant) => !grant.revoked && state.accounts.some((account) => account.id === grant.accountId && (account.sessionEpoch || 0) === grant.epoch);
  const addGrant = (state, accountId, clientId, scopes, sourceHash) => {
    const accessToken = randomBytes(32).toString("base64url"), refreshToken = randomBytes(32).toString("base64url");
    const account = state.accounts.find((account) => account.id === accountId);
    const grant = { id: randomUUID(), accountId, clientId, scopes, sourceHash, epoch: account.sessionEpoch || 0, accessHash: hash(accessToken), refreshHash: hash(refreshToken), usedRefreshHashes: [], accessExpiresAt: now() + 15 * 60000, refreshExpiresAt: now() + 30 * 86400000 };
    state.grants.push(grant);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 900, scope: scopes.join(" ") };
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
  const addSession = (state, account, token) => {
    const own = state.sessions.filter((entry) => entry.accountId === account.id).slice(-19);
    state.sessions = [...state.sessions.filter((entry) => entry.accountId !== account.id), ...own, { hash: hash(token), accountId: account.id, expiresAt: now() + 30 * 86400000 }];
  };
  return {
    transaction: update,
    snapshot: read,
    async browserToken(token) {
      if (!token) return false;
      const state = await read();
      return state.sessions.some((session) => session.hash === hash(token) && session.expiresAt > now()) || state.people.some((person) => person.sessionHash === hash(token));
    },
    async people() { return [...(await read()).people.map(publicProfile), ...JSON.parse(await readFile(seedFile, "utf8"))]; },
    async me(token) { const person = personFor(await read(), token); return person ? publicProfile(person) : null; },
    async actor(token) {
      if (!token) return null;
      const state = await read();
      const account = accountFor(state, token);
      const person = personFor(state, token);
      if (!account && !person) return null;
      return { id: account?.id || person.id, accountId: account?.id || null, memberId: person?.id || null, name: person?.name || account?.name || "Builder", avatar: person?.avatar || account?.avatar || "", hasProfile: Boolean(person), plan: effectivePlan(account) };
    },
    async session(token) {
      const state = await read();
      const person = personFor(state, token);
      const account = publicAccount(accountFor(state, token));
      // Emails are for the owner's own browser; an app token reading /api/me never sees them.
      const browser = token && state.sessions.some((session) => session.hash === hash(token) && session.expiresAt > now());
      if (account && !browser) delete account.emails;
      return { profile: person ? publicProfile(person) : null, account };
    },
    async accountIdentity(id) {
      const account = (await read()).accounts.find((account) => account.id === id);
      if (!account) throw new AppError(404, "Account not found.");
      return { sub: account.id, name: account.name, picture: account.avatar, identities: account.identities.map(({ provider, issuer, subject }) => ({ provider, issuer, subject })), plan: effectivePlan(account), entitlements: entitlements(effectivePlan(account)) };
    },
    async authorize(token, { clientId, redirectUri, challenge, scopes }) {
      const code = randomBytes(32).toString("base64url");
      return update((state) => {
        // Browser SSO requires a browser session, never a token issued to an app.
        const browser = state.sessions.find((session) => session.hash === hash(token) && session.expiresAt > now());
        if (!browser) throw new AppError(401, "Sign in to Agora.Build first.");
        state.authorizationCodes.push({ hash: hash(code), accountId: browser.accountId, clientId, redirectUri, challenge, scopes, sourceHash: browser.hash, expiresAt: now() + 60000 });
        return code;
      });
    },
    async exchangeCode({ code, clientId, redirectUri, verifier }) {
      return update((state) => {
        const entry = state.authorizationCodes.find((entry) => entry.hash === hash(code));
        if (!entry || entry.expiresAt <= now() || entry.clientId !== clientId || entry.redirectUri !== redirectUri || entry.challenge !== createHash("sha256").update(verifier).digest("base64url") || !state.sessions.some((session) => session.hash === entry.sourceHash && session.expiresAt > now())) throw new AppError(400, "Invalid or expired authorization code.");
        state.authorizationCodes = state.authorizationCodes.filter((value) => value !== entry);
        return addGrant(state, entry.accountId, clientId, entry.scopes, entry.sourceHash);
      });
    },
    async grantForAccount(accountId, clientId, scopes) {
      return update((state) => {
        if (!state.accounts.some((account) => account.id === accountId)) throw new AppError(401, "Sign in again.");
        return addGrant(state, accountId, clientId, scopes, null);
      });
    },
    async refreshGrant(clientId, refreshToken) {
      const refreshHash = hash(refreshToken);
      return update((state) => {
        const grant = state.grants.find((grant) => grant.clientId === clientId && (grant.refreshHash === refreshHash || grant.usedRefreshHashes.includes(refreshHash)));
        if (!grant || !validGrant(state, grant) || grant.refreshExpiresAt <= now()) return null;
        if (grant.refreshHash !== refreshHash) { grant.revoked = true; return null; }
        const accessToken = randomBytes(32).toString("base64url"), nextRefresh = randomBytes(32).toString("base64url");
        grant.usedRefreshHashes.push(grant.refreshHash);
        grant.accessHash = hash(accessToken); grant.refreshHash = hash(nextRefresh); grant.accessExpiresAt = now() + 15 * 60000;
        return { access_token: accessToken, refresh_token: nextRefresh, token_type: "Bearer", expires_in: 900, scope: grant.scopes.join(" ") };
      });
    },
    async access(token, scope) {
      const state = await read();
      const grant = token && state.grants.find((grant) => grant.accessHash === hash(token) && grant.accessExpiresAt > now() && validGrant(state, grant));
      if (!grant || (scope && !grant.scopes.includes(scope))) throw new AppError(401, "A valid Agora.Build access token is required.");
      const account = accountFor(state, token);
      return { sub: account.id, name: account.name, picture: account.avatar, clientId: grant.clientId, scope: grant.scopes.join(" "), plan: effectivePlan(account), entitlements: entitlements(effectivePlan(account)) };
    },
    async revokeGrant(clientId, value) {
      return update((state) => {
        const grant = state.grants.find((grant) => grant.clientId === clientId && (grant.refreshHash === hash(value) || grant.accessHash === hash(value)));
        if (grant) grant.revoked = true;
      });
    },
    async logoutEverywhere(token) {
      return update((state) => {
        const account = accountFor(state, token);
        if (!account) throw new AppError(401, "Sign in to manage sessions.");
        account.sessionEpoch = (account.sessionEpoch || 0) + 1;
        state.sessions = state.sessions.filter((session) => session.accountId !== account.id);
        state.authorizationCodes = state.authorizationCodes.filter((code) => code.accountId !== account.id);
      });
    },
    async login(identity, { linkToken, pendingLink } = {}) {
      const { provider, issuer, subject } = identity;
      // Providers pass an email only when they verified it; it is private and never identifies a user on its own.
      // Undefined means the provider could not be asked this time, so the stored email is kept.
      const email = identity.email === undefined ? undefined : typeof identity.email === "string" && identity.email ? identity.email.toLowerCase() : null;
      if (!["google", "github", "apple", "agora"].includes(provider) || typeof subject !== "string" || !subject || subject.length > 255 || typeof issuer !== "string" || !issuer) throw new AppError(422, "This login identity is invalid.");
      const token = randomBytes(32).toString("base64url");
      return update((state) => {
        state.pendingLinks = (state.pendingLinks || []).filter((entry) => entry.expiresAt > now());
        const waiting = pendingLink ? state.pendingLinks.find((entry) => entry.hash === hash(pendingLink)) || null : null;
        let account = state.accounts.find((entry) => entry.identities.some((entry) => entry.provider === provider && entry.issuer === issuer && entry.subject === subject));
        const browser = linkToken && state.sessions.find((session) => session.hash === hash(linkToken) && session.expiresAt > now());
        const linking = browser && accountFor(state, linkToken);
        const legacy = linkToken && state.people.find((person) => person.sessionHash === hash(linkToken));
        if (linkToken && !linking && !legacy) throw new AppError(401, "Your session expired. Sign in again before connecting another login.");
        if (account && ((linking && account.id !== linking.id) || (!linking && legacy && account.profileId && account.profileId !== legacy.id))) throw new AppError(409, "That login belongs to another account. Sign out to use it.");
        // A new login whose verified email already belongs to an account is held until that account signs in to confirm it.
        if (!account && !linkToken && email) {
          const owner = state.accounts.find((entry) => entry.identities.some((other) => other.email === email));
          if (owner) {
            const raw = randomBytes(32).toString("base64url");
            state.pendingLinks.push({ hash: hash(raw), accountId: owner.id, identity: { provider, issuer, subject, email }, profile: { name: identity.name, avatar: identity.avatar, contact: identity.contact }, confirmedBy: null, expiresAt: now() + 600000 });
            state.pendingLinks = state.pendingLinks.slice(-500);
            return { pendingLink: { token: raw, provider, providers: loginsOf(owner) } };
          }
        }
        if (!account) {
          if (linking?.identities.some((entry) => entry.provider === provider)) throw new AppError(409, "A login from this provider is already connected.");
          if (linking) account = linking;
          else {
            if (state.accounts.length >= 1000) throw new AppError(409, "Account sign-ups are full for now.");
            account = newAccount(identity);
            state.accounts.push(account);
          }
          account.identities.push({ provider, issuer, subject, email: email ?? null });
        } else if (email !== undefined) account.identities.find(same({ provider, issuer, subject })).email = email;
        // Signing in to the matching account only readies the held login; connecting it is a separate, explicit step on the portal.
        let link = {};
        if (pendingLink && !waiting) link = { linkExpired: true };
        else if (waiting && waiting.accountId !== account.id) { state.pendingLinks = state.pendingLinks.filter((entry) => entry !== waiting); link = { linkMismatch: true }; }
        else if (waiting) { waiting.confirmedBy = account.id; waiting.confirmedSession = hash(token); waiting.expiresAt = now() + 600000; link = { linkReady: true }; }
        if (legacy && !linking) {
          account.profileId = legacy.id;
          legacy.accountId = account.id;
          delete legacy.sessionHash;
        }
        addSession(state, account, token);
        const person = state.people.find((person) => person.id === account.profileId);
        return { token, account: publicAccount(account), profile: person ? publicProfile(person) : null, ...link };
      });
    },
    // What a held login is, for the browser holding it: the provider, a masked email, and whether this session may connect it.
    async pendingLink(raw, sessionToken) {
      const state = await read();
      const hold = raw && (state.pendingLinks || []).find((entry) => entry.hash === hash(raw) && entry.expiresAt > now());
      if (!hold) throw new AppError(404, "There is no login waiting to be connected.");
      const owner = state.accounts.find((account) => account.id === hold.accountId);
      const current = accountFor(state, sessionToken);
      const [name, domain] = hold.identity.email.split("@");
      return { provider: hold.identity.provider, email: name[0] + "***@" + domain, name: String(hold.profile?.name || "").slice(0, 60), providers: owner ? loginsOf(owner) : [], ready: Boolean(current && hold.confirmedBy === current.id && sessionToken && hold.confirmedSession === hash(sessionToken)) };
    },
    async resolvePendingLink(raw, sessionToken, action) {
      if (!["connect", "separate", "discard"].includes(action)) throw new AppError(422, "Choose connect, separate, or discard.");
      const token = randomBytes(32).toString("base64url");
      return update((state) => {
        state.pendingLinks = (state.pendingLinks || []).filter((entry) => entry.expiresAt > now());
        const hold = raw && state.pendingLinks.find((entry) => entry.hash === hash(raw));
        if (!hold) throw new AppError(404, "There is no login waiting to be connected.");
        state.pendingLinks = state.pendingLinks.filter((entry) => entry !== hold);
        if (action === "discard") return { discarded: true };
        const held = hold.identity;
        if (state.accounts.some((account) => account.identities.some(same(held)))) throw new AppError(409, "That login already belongs to an account.");
        if (action === "connect") {
          const current = accountFor(state, sessionToken);
          // Only the very session that signed in through the hold may connect it.
          if (!current || hold.confirmedBy !== current.id || !sessionToken || hold.confirmedSession !== hash(sessionToken)) throw new AppError(403, "Sign in to the matching account before connecting this login.");
          if (current.identities.some((entry) => entry.provider === held.provider)) throw new AppError(409, "This account already has a login from that provider.");
          current.identities.push(held);
          return { linked: held.provider, account: publicAccount(current) };
        }
        if (state.accounts.length >= 1000) throw new AppError(409, "Account sign-ups are full for now.");
        const account = newAccount(hold.profile || {});
        account.identities.push(held);
        state.accounts.push(account);
        // The browser switches to the new account, so its previous session ends rather than lingering.
        if (sessionToken) state.sessions = state.sessions.filter((session) => session.hash !== hash(sessionToken));
        addSession(state, account, token);
        return { token, account: publicAccount(account) };
      });
    },
    async logout(token) {
      return update((state) => {
        for (const grant of state.grants) if (grant.sourceHash === hash(token)) grant.revoked = true;
        state.sessions = state.sessions.filter((session) => session.hash !== hash(token));
        const legacy = token && state.people.find((person) => person.sessionHash === hash(token));
        if (legacy) delete legacy.sessionHash;
      });
    },
    async join(input, currentToken) {
      const token = randomBytes(32).toString("base64url");
      const person = { id: "member:" + randomUUID(), ...fields(input), source: "community", avatar: "", username: "", projects: [], joinedAt: new Date().toISOString(), sessionHash: hash(token) };
      await update((state) => {
        const account = accountFor(state, currentToken);
        if (personFor(state, currentToken)) throw new AppError(409, "You already have a profile. Edit it instead.");
        if (state.people.length >= 500) throw new AppError(409, "The house is full for now.");
        if (account) {
          person.accountId = account.id;
          person.avatar = account.avatar;
          delete person.sessionHash;
          account.profileId = person.id;
          addSession(state, account, token);
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
