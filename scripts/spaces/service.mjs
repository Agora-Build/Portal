import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../store.mjs";
import { entitlements } from "../plans.mjs";
import { parseMap } from "../../world/map.js";
import { can } from "./permissions.mjs";
import { PLAZA_ID, migratedRoom, newSpace, normalizeTags, publicSpace, spaceInput, systemSpaces } from "./model.mjs";
import { enter as enterLease, heartbeat as heartbeatLease, leaseOf, leasesFor, leave as leaveLease, sweep as sweepLeases } from "./leases.mjs";
import { validateDecor } from "./decor.mjs";
import { channelName, signalingUser, spaceKey } from "./signaling.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const ACTOR_ID = /^(member|account):[a-f0-9-]{36}$/;
const notFound = () => new AppError(404, "This space was not found.");

export function loadWorlds(directory) {
  return Object.fromEntries(["plaza", "room"].map((id) => {
    const source = JSON.parse(readFileSync(resolve(directory, "worlds", id, "map.json"), "utf8"));
    return [id, { source, map: parseMap(source) }];
  }));
}

export function createSpaces({ store, worlds, signaling, calls, secret = "", admins = [], now = Date.now, plazaCapacity }) {
  const listeners = [];
  let prepared;
  // System spaces follow the plaza map; legacy meeting rooms become unlisted members-only spaces once.
  const ready = () => prepared ||= store.transaction((state) => {
    for (const system of systemSpaces(worlds.plaza.map, now(), plazaCapacity)) {
      const existing = state.spaces.find((space) => space.id === system.id);
      if (!existing) state.spaces.push(system);
      else Object.assign(existing, { title: system.title, capacity: system.capacity, slug: system.slug, lot: system.lot });
    }
    for (const room of state.rooms) if (!state.spaces.some((space) => space.id === room.id)) state.spaces.push(migratedRoom(room, now()));
  }).catch((error) => { prepared = undefined; throw error; });
  async function mutate(work) {
    await ready();
    const events = [];
    const result = await store.transaction((state) => { events.push(...sweepLeases(state, now())); return work(state, events); });
    if (events.length) for (const listener of listeners) listener(events);
    return result;
  }
  async function actorFor(token) {
    const actor = token ? await store.actor(token) : null;
    return actor && { ...actor, ids: [actor.accountId, actor.memberId].filter(Boolean), admin: Boolean(actor.accountId && admins.includes(actor.accountId)) };
  }
  const signedIn = (actor) => { if (!actor) throw new AppError(401, "Sign in to step into the Stoa."); return actor; };
  const find = (state, id) => { const space = state.spaces.find((entry) => entry.id === id); if (!space) throw notFound(); return space; };
  const system = (space) => Boolean(space.lot) || space.id === PLAZA_ID;
  const invitationFor = (space, invite) => typeof invite === "string" && invite ? space.invitations.find((entry) => entry.tokenHash === hash(invite) && entry.expiresAt > now() && entry.usesLeft > 0) || null : null;
  const present = (state, space, actor) => Boolean(actor && leaseOf(state, space.id, actor.id, now()));
  const visible = (state, space, actor, invite) => can(actor, "see", space, { invited: Boolean(invitationFor(space, invite)), present: present(state, space, actor) });
  const findVisible = (state, id, actor, invite) => { const space = find(state, id); if (!visible(state, space, actor, invite)) throw notFound(); return space; };
  const occupants = (state, space) => leasesFor(state, space.id, now()).sort((a, b) => a.enteredAt - b.enteredAt).map((lease) => ({ id: lease.actorId, name: lease.name }));
  const view = (state, space, actor) => publicSpace(space, { occupants: occupants(state, space), manage: can(actor, "edit", space) });
  const owned = (state, actor) => state.spaces.filter((space) => !system(space) && actor.ids.includes(space.ownerId));
  const offerFor = (state, actor) => ({ spaces: state.spaces.filter((space) => !system(space) && space.members.some((id) => actor.ids.includes(id))).map((space) => ({ id: space.id, title: space.title, visibility: space.visibility, path: "/stoa/s/" + space.id })), canCreate: owned(state, actor).length < entitlements(actor.plan).spaces });
  const access = (space) => ({ channel: channelName(secret, space), key: spaceKey(secret, space), blocked: space.blocked, hostId: space.hostId });
  const requirePresent = (state, space, actor) => { if (!present(state, space, actor)) throw new AppError(403, "Step into this space first."); };

  const spaces = {
    onEvents(listener) { listeners.push(listener); },
    async sweep() { await mutate(() => null); },
    async list({ q = "" } = {}) {
      await ready();
      const state = await store.snapshot();
      const query = String(q).trim().toLowerCase().slice(0, 100);
      const plaza = find(state, PLAZA_ID);
      const rooms = state.spaces.filter((space) => space.visibility === "listed" && space.lot).map((space) => {
        const people = occupants(state, space);
        return { id: space.id, slug: space.slug, title: space.title, topic: space.topic, tags: space.tags, capacity: space.capacity, occupancy: people.length, occupants: people, hostName: people.find((entry) => entry.id === space.hostId)?.name || null, path: "/stoa/room/" + space.slug };
      }).filter((room) => !query || [room.title, room.topic || "", ...room.tags].some((value) => value.toLowerCase().includes(query)));
      return { plaza: { capacity: plaza.capacity, occupancy: leasesFor(state, PLAZA_ID, now()).length, blocked: plaza.blocked }, rooms };
    },
    async create(token, input) {
      const actor = signedIn(await actorFor(token));
      const fields = spaceInput(input || {});
      return mutate((state) => {
        if (owned(state, actor).length >= entitlements(actor.plan).spaces) throw new AppError(409, "You have reached your plan's space limit.", { offer: offerFor(state, actor) });
        const space = newSpace(fields, { id: randomUUID(), ownerId: actor.id, now: now() });
        state.spaces.push(space);
        return view(state, space, actor);
      });
    },
    async get(token, id, invite) {
      await ready();
      const actor = await actorFor(token);
      const state = await store.snapshot();
      return view(state, findVisible(state, id, actor, invite), actor);
    },
    async visible(token, id, invite) {
      try { await spaces.get(token, id, invite); return true; }
      catch (error) { if (error.status === 404) return false; throw error; }
    },
    async update(token, id, input) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = findVisible(state, id, actor);
        if (system(space)) throw new AppError(403, "The map sets the plaza and its rooms.");
        if (!can(actor, "edit", space)) throw new AppError(403, "Only the owner can change this space.");
        const fields = spaceInput(input || {}, space);
        if (fields.visibility !== space.visibility) space.channelEpoch += 1;
        Object.assign(space, fields, { updatedAt: new Date(now()).toISOString() });
        for (const lease of leasesFor(state, space.id, now())) {
          const holder = { id: lease.actorId, ids: lease.ids, hasProfile: lease.ids.some((entry) => entry.startsWith("member:")), admin: false };
          if (!can(holder, "enter", space)) events.push(...leaveLease(state, space, lease.actorId, now()));
        }
        return view(state, space, actor);
      });
    },
    async destroy(token, id) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = findVisible(state, id, actor);
        if (system(space) || !can(actor, "delete", space)) throw new AppError(403, "Only the owner can delete this space.");
        state.spaces = state.spaces.filter((entry) => entry !== space);
        state.spaceLeases = state.spaceLeases.filter((lease) => lease.spaceId !== space.id);
        events.push({ type: "deleted", spaceId: space.id, members: space.members });
        return { deleted: true };
      });
    },
    async enter(token, id, invite) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = find(state, id);
        const invitation = invitationFor(space, invite);
        const context = { invited: Boolean(invitation), present: present(state, space, actor) };
        if (!can(actor, "see", space, context)) throw notFound();
        if (!can(actor, "enter", space, context)) throw new AppError(403, space.blocked.some((entry) => actor.ids.includes(entry)) ? "You can't enter this space right now." : "This space is open to its members.");
        if (invitation && !space.members.some((entry) => actor.ids.includes(entry))) {
          space.members.push(actor.id);
          invitation.usesLeft -= 1;
          events.push({ type: "member-added", spaceId: space.id, actorId: actor.id });
        }
        if (space.lot) events.push(...leaveLease(state, find(state, PLAZA_ID), actor.id, now()));
        let result;
        try { result = enterLease(state, space, actor, now()); }
        catch (error) {
          if (space.id === PLAZA_ID && error.status === 409) throw new AppError(409, "The plaza is full right now.", { full: true, offer: offerFor(state, actor) });
          throw error;
        }
        events.push(...result.events);
        return { space: view(state, space, actor), firstIn: result.firstIn, ...access(space) };
      });
    },
    async leave(token, id) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => { events.push(...leaveLease(state, findVisible(state, id, actor), actor.id, now())); return { left: true }; });
    },
    async heartbeat(token, id) {
      const actor = signedIn(await actorFor(token));
      return mutate((state) => { const space = findVisible(state, id, actor); if (present(state, space, actor) && !can(actor, "enter", space)) throw new AppError(410, "You are no longer in this space."); heartbeatLease(state, space, actor.id, now()); return access(space); });
    },
    async topic(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      const topic = typeof input.topic === "string" ? input.topic.trim() : "";
      if (topic.length < 2 || topic.length > 80) throw new AppError(422, "Add a topic of 2 to 80 characters.");
      const tags = normalizeTags(input.tags);
      return mutate((state) => {
        const space = findVisible(state, id, actor);
        requirePresent(state, space, actor);
        if (space.id === PLAZA_ID || !can(actor, "host", space, { present: true })) throw new AppError(403, "Only the host can set the topic.");
        Object.assign(space, { topic, tags });
        return view(state, space, actor);
      });
    },
    async setHost(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = findVisible(state, id, actor);
        requirePresent(state, space, actor);
        if (space.id === PLAZA_ID || !can(actor, "host", space, { present: true })) throw new AppError(403, "Only the host or owner can hand over hosting.");
        const target = leaseOf(state, space.id, input.actorId, now());
        if (!target) throw new AppError(422, "Choose someone who is here.");
        space.hostId = target.actorId;
        events.push({ type: "host", spaceId: space.id, hostId: space.hostId });
        return { hostId: space.hostId };
      });
    },
    async decorate(token, id, items) {
      const actor = signedIn(await actorFor(token));
      return mutate((state) => {
        const space = findVisible(state, id, actor);
        requirePresent(state, space, actor);
        if (space.id === PLAZA_ID || !can(actor, "decorate", space, { present: true })) throw new AppError(403, "Only the host can decorate.");
        space.decor = validateDecor(items, worlds[space.worldId].map, space);
        space.decorVersion = (space.decorVersion || 0) + 1;
        return { decor: space.decor, version: space.decorVersion };
      });
    },
    async removePerson(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = findVisible(state, id, actor);
        requirePresent(state, space, actor);
        if (!can(actor, "moderate", space, { present: true })) throw new AppError(403, "Only the host can remove someone.");
        const target = leaseOf(state, space.id, input.actorId, now());
        const ids = target?.ids || [input.actorId];
        if (!ACTOR_ID.test(input.actorId || "") || ids.includes(space.ownerId) || ids.some((entry) => actor.ids.includes(entry))) throw new AppError(422, "This person can't be removed.");
        space.blocked = [...new Set([...space.blocked, ...ids])];
        if (space.visibility !== "listed") space.channelEpoch += 1;
        events.push(...leaveLease(state, space, input.actorId, now()), { type: "removed", spaceId: space.id, actorId: input.actorId });
        return { removed: true, ...access(space) };
      });
    },
    async invite(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      const uses = input.uses ?? 10, hours = input.hours ?? 72;
      if (!Number.isInteger(uses) || uses < 1 || uses > 100 || !Number.isInteger(hours) || hours < 1 || hours > 720) throw new AppError(422, "Choose 1 to 100 uses and 1 to 720 hours.");
      const raw = randomBytes(24).toString("base64url");
      return mutate((state) => {
        const space = findVisible(state, id, actor);
        if (system(space) || !can(actor, "invite", space)) throw new AppError(403, "Only the owner can invite people.");
        space.invitations = space.invitations.filter((entry) => entry.expiresAt > now() && entry.usesLeft > 0).slice(-49);
        const invitation = { id: randomUUID(), tokenHash: hash(raw), usesLeft: uses, expiresAt: now() + hours * 3600000, createdBy: actor.id, createdAt: new Date(now()).toISOString() };
        space.invitations.push(invitation);
        return { token: raw, path: "/stoa/s/" + space.id + "?invite=" + raw, usesLeft: uses, expiresAt: new Date(invitation.expiresAt).toISOString() };
      });
    },
    async addMember(token, id, memberId) {
      const actor = signedIn(await actorFor(token));
      if (!ACTOR_ID.test(memberId || "")) throw new AppError(422, "Choose a builder to add.");
      return mutate((state, events) => {
        const space = findVisible(state, id, actor);
        if (system(space) || !can(actor, "edit", space)) throw new AppError(403, "Only the owner can change members.");
        space.blocked = space.blocked.filter((entry) => entry !== memberId);
        if (!space.members.includes(memberId)) { space.members.push(memberId); events.push({ type: "member-added", spaceId: space.id, actorId: memberId }); }
        return { members: space.members };
      });
    },
    async removeMember(token, id, memberId) {
      const actor = signedIn(await actorFor(token));
      return mutate((state, events) => {
        const space = findVisible(state, id, actor);
        if (system(space) || !can(actor, "edit", space)) throw new AppError(403, "Only the owner can change members.");
        if (memberId === space.ownerId) throw new AppError(422, "The owner stays a member.");
        space.members = space.members.filter((entry) => entry !== memberId);
        if (space.visibility !== "listed") space.channelEpoch += 1;
        events.push(...leaveLease(state, space, memberId, now()), { type: "member-removed", spaceId: space.id, actorId: memberId });
        return { members: space.members };
      });
    },
    async signalingToken(token) {
      await ready();
      const actor = await actorFor(token);
      const state = await store.snapshot();
      const channels = [{ spaceId: PLAZA_ID, name: channelName(secret, find(state, PLAZA_ID)), write: Boolean(actor), key: null }];
      if (actor) for (const lease of state.spaceLeases.filter((entry) => entry.actorId === actor.id && entry.expiresAt > now() && entry.spaceId !== PLAZA_ID)) {
        const space = state.spaces.find((entry) => entry.id === lease.spaceId);
        if (space) channels.push({ spaceId: space.id, name: channelName(secret, space), write: true, key: spaceKey(secret, space) });
      }
      return { ...signaling.issue(signalingUser(actor), channels), channels };
    },
    async rtcToken(token, id, input = {}) {
      const actor = signedIn(await actorFor(token));
      await ready();
      const state = await store.snapshot();
      const space = findVisible(state, id, actor);
      if (space.id === PLAZA_ID) throw new AppError(422, "Calls happen inside rooms.");
      if (!present(state, space, actor)) throw new AppError(403, "Step into this space before joining its call.");
      return calls.issueSpace(space, actor, input);
    }
  };
  return spaces;
}
