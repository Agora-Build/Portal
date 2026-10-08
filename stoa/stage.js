import { walkable } from "../world/map.js";
import { openPlace } from "./place.js";
import { createLease as realLease } from "./lease.js";

const inside = (rect, tile) => tile.x >= rect.x && tile.y >= rect.y && tile.x < rect.x + rect.width && tile.y < rect.y + rect.height;
// The plaza tile just outside a lot's door, where you stand after leaving the room.
export const outsideDoor = (map, lot) => [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => ({ x: lot.door.x + dx, y: lot.door.y + dy })).find((tile) => walkable(map, tile.x, tile.y) && !inside(lot.interior, tile)) || lot.door;

// Moves the person between the plaza, lot rooms, and user spaces: entry leases on the server, channels on Signaling.
export function createStage({ api, map, engine, panel, live, self, plaza, createLease = realLease }) {
  let places = [], lease = null, here = null, busy = false, turn = 0;
  const doors = new Map(map.lots.map((lot) => [lot.door.x + "," + lot.door.y, lot]));
  const exits = new Map(map.lots.map((lot) => [lot.entry.x + "," + (lot.entry.y + 1), lot]));
  // Cell-ready: a space may later span several channels; people from all of them are merged by id.
  const showPeople = () => {
    const seen = new Map();
    for (const place of places) for (const person of place.people()) seen.set(person.id, person);
    const list = [...seen.values()];
    engine.setOthers(list);
    panel.setPeople(list, self.name);
  };
  const showRoom = (space, hostId) => panel.showRoom({ kicker: here?.kind === "lot" ? "LOT ROOM" : space.visibility === "private" ? "PRIVATE SPACE" : "UNLISTED SPACE", title: space.title, topic: space.topic, tags: space.tags || [], host: Boolean(self.id) && hostId === self.id, leaveLabel: here?.kind === "lot" ? "Back to the plaza" : "Leave this space" });

  // Every transition claims `here` before it awaits anything; a superseded one stops as soon as it notices.
  async function settle(next) {
    here = next;
    lease?.stop(); lease = null;
    const old = places; places = [];
    await Promise.all(old.map((place) => place.close().catch(() => {})));
    if (here !== next) return;
    if (next.start) engine.teleport(next.start);
    engine.setBounds(next.bounds || null);
    showPeople();
    if (live && next.access?.channel) {
      try {
        const place = await openPlace({ live, map, engine, self, quiet: Boolean(next.watch), channel: { name: next.access.channel, key: next.access.key || null, spaceId: next.space.id }, onPeople: showPeople, onSay: panel.addMessage, onRefresh: () => { refreshRoom(); } });
        if (here !== next) { await place.close().catch(() => {}); return; }
        places = [place];
        place.setBlocked(next.access.blocked || []);
        showPeople();
      } catch (error) { if (here === next) panel.say("Live movement isn't available here (" + (error.message || "unknown error") + ")."); }
    }
    if (here !== next) return;
    if (next.leased) {
      const made = createLease({ api, spaceId: next.space.id, onAccess: (access) => { if (lease === made) onAccess(access); }, onLost: () => { if (lease === made) lost(); } });
      lease = made;
    }
    panel.canTalk(next.leased ? self.signedIn : false);
  }

  async function onAccess(access) {
    if (!here?.leased) return;
    if (places[0] && access.channel !== places[0].channel) {
      const next = { ...here, access: { ...here.access, ...access }, start: null };
      here = next;
      await live?.renew().catch(() => {});
      if (here === next) await settle(next);
      return;
    }
    for (const place of places) place.setBlocked(access.blocked || []);
    if (here.kind !== "plaza" && access.hostId !== here.access.hostId) { here.access = { ...here.access, ...access }; refreshRoom(); }
  }

  async function lost() {
    if (!here) return;
    if (here.kind === "lot") { const lot = here.lot; await toPlaza(outsideDoor(map, lot)); panel.say("You're no longer in " + lot.title + "."); }
    else if (here.kind === "space") { const at = here; await settle({ kind: "left", space: here.space, bounds: here.bounds }); if (here.kind === "left" && here.space === at.space) { engine.setInteractive(false); panel.say("You're no longer in this space."); } }
    else await toPlaza(null);
  }

  async function refreshRoom() {
    const at = here;
    if (!at || at.kind === "plaza" || !at.space) return;
    try {
      const { space } = await api("/api/spaces/" + at.space.id + (at.invite ? "?invite=" + encodeURIComponent(at.invite) : ""));
      if (here === at) showRoom(space, space.hostId);
    } catch { /* the next heartbeat reports a lost lease */ }
  }

  async function toPlaza(start, welcome) {
    const mine = ++turn;
    panel.showPlaza();
    panel.clearMessages();
    const watch = async (message, full) => {
      await settle({ kind: "plaza", space: { id: "plaza" }, access: plaza.channel ? { channel: plaza.channel, key: null, blocked: [] } : null, bounds: plaza.bounds, start, leased: false, watch: true, full });
      engine.setInteractive(false);
      if (mine === turn) panel.say(message);
    };
    if (!self.signedIn) return watch("You're watching the plaza. Sign in to walk and talk.");
    try {
      const access = await api("/api/spaces/plaza/enter", { method: "POST", body: "{}" });
      if (mine !== turn) { api("/api/spaces/plaza/leave", { method: "POST" }).catch(() => {}); return; }
      panel.hideOffer();
      await settle({ kind: "plaza", space: access.space, access, bounds: plaza.bounds, start, leased: true });
      if (mine !== turn) return;
      engine.setInteractive(true);
      panel.say(welcome || "You're on the plaza. Walk to a room to see who's there.");
    } catch (error) {
      if (mine !== turn) return;
      if (error.status === 409 && error.data?.full) { panel.showOffer(error.data.offer); return watch("The plaza is full right now. You can watch, or go to one of your spaces.", true); }
      return watch(error.message);
    }
  }

  async function enterLot(lot) {
    if (busy) return;
    if (!self.signedIn) { panel.say("Sign in to step into " + lot.title + "."); return; }
    busy = true;
    const mine = ++turn;
    try {
      const access = await api("/api/spaces/lot-" + lot.slug + "/enter", { method: "POST", body: "{}" });
      if (mine !== turn) { api("/api/spaces/lot-" + lot.slug + "/leave", { method: "POST" }).catch(() => {}); return; }
      panel.clearMessages();
      await live?.renew().catch(() => {});
      if (mine !== turn) return;
      await settle({ kind: "lot", space: access.space, lot, access, bounds: lot.interior, start: lot.entry, leased: true });
      if (mine !== turn) return;
      showRoom(access.space, access.hostId);
      panel.say(access.firstIn ? "You're the first one in " + lot.title + ", so you're the host. Set a topic so people know what it's about." : "You stepped into " + lot.title + ".");
    } catch (error) { if (mine === turn) panel.say(error.status === 409 ? lot.title + " is full right now." : error.message); }
    finally { busy = false; }
  }

  async function openSpace(id, invite) {
    if (!self.signedIn) { engine.setInteractive(false); panel.say("Sign in to step into this space."); return; }
    const mine = ++turn;
    try {
      const access = await api("/api/spaces/" + encodeURIComponent(id) + "/enter", { method: "POST", body: JSON.stringify(invite ? { invite } : {}) });
      if (mine !== turn) { api("/api/spaces/" + encodeURIComponent(id) + "/leave", { method: "POST" }).catch(() => {}); return; }
      panel.clearMessages();
      await live?.renew().catch(() => {});
      if (mine !== turn) return;
      await settle({ kind: "space", space: access.space, access, invite, bounds: null, start: null, leased: true });
      if (mine !== turn) return;
      engine.setInteractive(true);
      showRoom(access.space, access.hostId);
      panel.say("You're in " + access.space.title + ".");
    } catch (error) { if (mine === turn) { engine.setInteractive(false); panel.say(error.message); } }
  }

  async function leaveRoom() {
    if (!here || here.kind === "plaza" || busy) return;
    busy = true;
    try {
      const { kind, lot } = here;
      await lease?.leave(); lease = null;
      if (kind === "lot") { await toPlaza(outsideDoor(map, lot)); panel.say("You're back on the plaza."); }
      else location.assign("/stoa/");
    } finally { busy = false; }
  }

  async function setTopic(topic, tagsText) {
    const at = here;
    if (!at || at.kind === "plaza") return;
    try {
      const tags = String(tagsText || "").split(",").map((tag) => tag.trim()).filter(Boolean);
      const { space } = await api("/api/spaces/" + at.space.id + "/topic", { method: "POST", body: JSON.stringify({ topic, tags }) });
      if (here !== at) return;
      showRoom(space, space.hostId);
      for (const place of places) place.refresh();
      panel.say("Topic set: " + space.topic + ".");
    } catch (error) { if (here === at) panel.say(error.message); }
  }

  return {
    toPlaza, enterLot, openSpace, leaveRoom, setTopic,
    say(text) {
      if (here?.kind === "left") { panel.say("You're no longer in this space."); return false; }
      if (!places.length) { panel.say(self.signedIn ? "Messages need the live connection." : "Sign in to talk."); return false; }
      if (places[0].say(text)) return true;
      panel.say("That message wasn't sent. Wait a moment between messages.");
      return false;
    },
    // Why walking to a room isn't possible right now, or null when it is.
    watchNotice(lot) {
      if (here?.kind !== "plaza" || here.leased) return null;
      return self.signedIn ? "The plaza is full \u2014 you can watch or go to one of your spaces." : "Sign in to walk to " + lot.title + ".";
    },
    onArrive(tile) {
      const key = tile.x + "," + tile.y;
      if (here?.kind === "plaza" && here.leased && doors.has(key)) enterLot(doors.get(key));
      else if (here?.kind === "plaza" && !self.signedIn && doors.has(key)) panel.say("Sign in to step into " + doors.get(key).title + ".");
      else if (here?.kind === "lot" && exits.get(key) === here.lot) leaveRoom();
    },
    async poll() {
      const listing = await api("/api/spaces");
      if (here?.kind === "plaza") for (const place of places) place.setBlocked(listing.plaza.blocked || []);
      return listing;
    },
    unload() { lease?.leaveOnUnload(); }
  };
}
