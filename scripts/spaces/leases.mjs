import { AppError } from "../store.mjs";
import { PLAZA_ID } from "./model.mjs";

// Leases count who is inside a space; capacity and hosting are decided only from active leases.
export const LEASE_MS = 60000;
const mine = (lease, id) => lease.actorId === id || lease.ids.includes(id);
export const leasesFor = (state, spaceId, now) => state.spaceLeases.filter((lease) => lease.spaceId === spaceId && lease.expiresAt > now);
export const leaseOf = (state, spaceId, actorId, now) => (actorId && leasesFor(state, spaceId, now).find((lease) => mine(lease, actorId))) || null;

function settle(state, space, now, events) {
  const present = leasesFor(state, space.id, now).sort((a, b) => a.enteredAt - b.enteredAt);
  if (space.id !== PLAZA_ID) {
    const keep = space.hostId && present.some((lease) => mine(lease, space.hostId));
    const next = keep ? space.hostId : (present.find((lease) => lease.ids.includes(space.ownerId)) || present[0])?.actorId || null;
    if (next !== space.hostId) { space.hostId = next; events.push({ type: "host", spaceId: space.id, hostId: next }); }
  }
  if (!present.length && space.lot) { Object.assign(space, { topic: null, tags: [], decor: [], blocked: [] }); events.push({ type: "emptied", spaceId: space.id }); }
}

export function enter(state, space, actor, now) {
  const events = [];
  const current = leaseOf(state, space.id, actor.id, now);
  if (current) { current.expiresAt = now + LEASE_MS; return { lease: current, firstIn: false, events }; }
  const present = leasesFor(state, space.id, now);
  if (present.length >= space.capacity) throw new AppError(409, "This space is full right now.");
  const lease = { spaceId: space.id, actorId: actor.id, ids: actor.ids, name: actor.name, enteredAt: now, expiresAt: now + LEASE_MS };
  state.spaceLeases.push(lease);
  events.push({ type: "entered", spaceId: space.id, actorId: actor.id });
  const hostPresent = space.hostId && present.some((entry) => mine(entry, space.hostId));
  if (space.id !== PLAZA_ID && (actor.ids.includes(space.ownerId) || !hostPresent) && space.hostId !== actor.id) { space.hostId = actor.id; events.push({ type: "host", spaceId: space.id, hostId: actor.id }); }
  return { lease, firstIn: present.length === 0, events };
}

export function leave(state, space, actorId, now) {
  const events = [];
  const gone = state.spaceLeases.filter((lease) => lease.spaceId === space.id && mine(lease, actorId));
  if (!gone.length) return events;
  state.spaceLeases = state.spaceLeases.filter((lease) => !gone.includes(lease));
  for (const lease of gone) events.push({ type: "left", spaceId: space.id, actorId: lease.actorId });
  settle(state, space, now, events);
  return events;
}

export function heartbeat(state, space, actorId, now) {
  const lease = leaseOf(state, space.id, actorId, now);
  if (!lease) throw new AppError(410, "You are no longer in this space.");
  lease.expiresAt = now + LEASE_MS;
  return lease;
}

export function sweep(state, now) {
  const events = [];
  const expired = state.spaceLeases.filter((lease) => lease.expiresAt <= now);
  if (!expired.length) return events;
  state.spaceLeases = state.spaceLeases.filter((lease) => lease.expiresAt > now);
  for (const lease of expired) events.push({ type: "left", spaceId: lease.spaceId, actorId: lease.actorId });
  for (const id of new Set(expired.map((lease) => lease.spaceId))) {
    const space = state.spaces.find((entry) => entry.id === id);
    if (space) settle(state, space, now, events);
  }
  return events;
}
