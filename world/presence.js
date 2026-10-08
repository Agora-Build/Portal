import { positionAt } from "./motion.js";
import { actorFromUser, readMessage, readState, shared, stopAt, straightPath, trusted } from "./protocol.js";

// Other people on one channel: resting places from presence state, live walks from messages, and short speech bubbles.
export const BUBBLE_MS = 8000;
export function createPresence({ map, self, now = () => Date.now() }) {
  const people = new Map();
  let blocked = new Set();
  const tileOf = (person, time) => { const position = positionAt(person.walk, time); return { x: Math.round(position.x), y: Math.round(position.y), dir: position.dir }; };
  function state(userId, states) {
    const id = actorFromUser(userId);
    if (!id || userId === self || blocked.has(id)) return;
    const value = readState(states, map);
    if (!value) return;
    const time = now(), person = people.get(userId);
    if (person && !positionAt(person.walk, time).done) { person.name = value.name; return; }
    people.set(userId, { id, userId, name: value.name, walk: { path: [{ x: value.x, y: value.y }], startedAt: time, dir: value.dir }, bubble: person?.bubble || null });
  }
  return {
    snapshot(list) { people.clear(); for (const entry of list) state(entry.userId, entry.states); },
    state,
    leave(userId) { people.delete(userId); },
    message(publisher, text) {
      if (!trusted(publisher, { self, present: new Set(people.keys()), blocked })) return null;
      const message = readMessage(text, map);
      if (!message) return null;
      const person = people.get(publisher), time = now();
      if (message.t === "move") person.walk = { path: message.path, startedAt: shared(message.startedAt, time) };
      else if (message.t === "walk") person.walk = { path: straightPath(map, message.from, message.dir), startedAt: shared(message.startedAt, time), dir: message.dir };
      else if (message.t === "stop") person.walk = stopAt(person.walk, message.at) || { path: [message.at], startedAt: time, dir: tileOf(person, time).dir };
      else if (message.t === "face") { const tile = tileOf(person, time); person.walk = { path: [{ x: tile.x, y: tile.y }], startedAt: time, dir: message.dir }; }
      else if (message.t === "say") person.bubble = { text: message.text, until: time + BUBBLE_MS };
      return { ...message, from: { id: person.id, name: person.name } };
    },
    setBlocked(list) { blocked = new Set(list); for (const [userId, person] of people) if (blocked.has(person.id)) people.delete(userId); },
    list() { return [...people.values()].map(({ id, name, walk, bubble }) => ({ id, name, walk, bubble })); }
  };
}
