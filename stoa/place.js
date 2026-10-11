import { createPresence } from "../world/presence.js";
import { createLimiter, writeMessage, writeState } from "../world/protocol.js";

// One channel's live layer: who is there, what they say, and your own movement published within the budget.
// The caller merges people from every open place, so a space can later span several area-of-interest cells.
export async function openPlace({ live, map, engine, self, channel, onPeople = () => {}, onSay = () => {}, onRefresh = () => {}, onDecor = () => {}, onRekey = () => {}, quiet = false, now = () => Date.now(), later }) {
  const guest = live.guest || quiet;
  const presence = createPresence({ map, self: live.userId, now });
  const moves = createLimiter({ perSecond: 4, burst: 4, now, later }), chats = createLimiter({ perSecond: 1, burst: 3, now, later });
  let open = true;
  const show = () => onPeople(presence.list());
  await live.join(channel.name, { spaceId: channel.spaceId, key: channel.key, quiet }, {
    message(publisher, text) {
      if (!open) return;
      const message = presence.message(publisher, text);
      if (!message) return;
      if (message.t === "say") onSay({ name: message.from.name, text: message.text, self: false });
      if (message.t === "refresh") onRefresh(message.from.id);
      if (message.t === "decor") onDecor(message.from.id, message.version);
      if (message.t === "rekey") onRekey(message.from.id);
      show();
    },
    presence(change) {
      if (!open) return;
      if (change.type === "snapshot") presence.snapshot(change.people);
      else if (change.type === "leave") presence.leave(change.userId);
      else if (change.type === "state") presence.state(change.userId, change.states);
      show();
    }
  });
  try { presence.snapshot(await live.who(channel.name)); }
  catch (error) { open = false; await live.leave(channel.name).catch(() => {}); throw error; }
  show();
  const publish = (message) => open ? live.publish(channel.name, writeMessage(message)).catch(() => false).then((result) => result !== false) : Promise.resolve(false);
  const rest = () => { const at = engine.position(); live.setState(channel.name, writeState({ x: at.x, y: at.y, dir: engine.facing(), name: self.name })).catch(() => {}); };
  const stops = guest ? [] : [
    engine.on("move", (route) => moves.send(() => publish({ t: "move", path: route.path, startedAt: route.startedAt }), { latest: true })),
    engine.on("walk", (walk) => moves.send(() => publish({ t: "walk", from: walk.from, dir: walk.dir, startedAt: walk.startedAt }), { latest: true })),
    engine.on("stop", (stop) => moves.send(() => publish({ t: "stop", at: stop.at }), { latest: true })),
    engine.on("face", (face) => moves.send(() => publish({ t: "face", dir: face.dir, at: face.at }), { latest: true })),
    engine.on("arrive", (at) => { moves.send(() => publish({ t: "stop", at: { x: at.x, y: at.y } }), { latest: true }); rest(); })
  ];
  if (!guest) rest();
  return {
    channel: channel.name,
    people: () => presence.list(),
    say(text) {
      const clean = String(text).trim().slice(0, 500);
      if (guest || !open || !clean) return false;
      if (!chats.send(() => { publish({ t: "say", text: clean }).then((sent) => { if (!sent && open) onSay({ name: self.name, text: clean, self: true, failed: true }); }); })) return false;
      engine.say(clean);
      onSay({ name: self.name, text: clean, self: true });
      return true;
    },
    refresh() { if (!guest) publish({ t: "refresh" }); },
    decorChanged(version) { if (!guest) publish({ t: "decor", version }); },
    rekey() { return guest ? Promise.resolve(false) : publish({ t: "rekey" }); },
    setBlocked(list) { presence.setBlocked(list); show(); },
    async close() { open = false; for (const stop of stops) stop(); await live.leave(channel.name); }
  };
}
