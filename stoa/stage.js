import { walkable } from "../world/map.js";
import { openPlace } from "./place.js";
import { createLease } from "./lease.js";

const inside = (rect, tile) => tile.x >= rect.x && tile.y >= rect.y && tile.x < rect.x + rect.width && tile.y < rect.y + rect.height;
// The plaza tile just outside a lot's door, where you stand after leaving the room.
export const outsideDoor = (map, lot) => [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => ({ x: lot.door.x + dx, y: lot.door.y + dy })).find((tile) => walkable(map, tile.x, tile.y) && !inside(lot.interior, tile)) || lot.door;

// Moves the person between the plaza, lot rooms, and user spaces: entry leases on the server, channels on Signaling.
export function createStage({ api, map, engine, panel, live, self, plaza }) {
  let places = [], lease = null, here = null, busy = false;
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

  async function settle(next) {
    lease?.stop(); lease = null;
    const old = places; places = [];
    await Promise.all(old.map((place) => place.close().catch(() => {})));
    here = next;
    if (next.start) engine.teleport(next.start);
    engine.setBounds(next.bounds || null);
    showPeople();
    if (live && next.access?.channel) {
      try {
        const place = await openPlace({ live, map, engine, self, channel: { name: next.access.channel, key: next.access.key || null, spaceId: next.space.id }, onPeople: showPeople, onSay: panel.addMessage, onRefresh: () => { refreshRoom(); } });
        if (here !== next) { await place.close(); return; }
        places = [place];
        place.setBlocked(next.access.blocked || []);
        showPeople();
      } catch (error) { panel.say("Live movement isn't available here (" + (error.message || "unknown error") + ")."); }
    }
    if (next.leased) lease = createLease({ api, spaceId: next.space.id, onAccess, onLost: lost });
  }

  async function onAccess(access) {
    if (!here?.leased) return;
    if (places[0] && access.channel !== places[0].channel) { await settle({ ...here, access: { ...here.access, ...access }, start: null }); return; }
    for (const place of places) place.setBlocked(access.blocked || []);
    if (here.kind !== "plaza" && access.hostId !== here.access.hostId) { here.access = { ...here.access, ...access }; refreshRoom(); }
  }

  async function lost() {
    if (!here) return;
    if (here.kind === "lot") { const lot = here.lot; await toPlaza(outsideDoor(map, lot)); panel.say("You're no longer in " + lot.title + "."); }
    else if (here.kind === "space") { await settle({ kind: "left", space: here.space, bounds: here.bounds }); engine.setInteractive(false); panel.say("You're no longer in this space."); }
    else await toPlaza(null);
  }

  async function refreshRoom() {
    if (!here || here.kind === "plaza" || !here.space) return;
    try {
      const { space } = await api("/api/spaces/" + here.space.id + (here.invite ? "?invite=" + encodeURIComponent(here.invite) : ""));
      showRoom(space, space.hostId);
    } catch { /* the next heartbeat reports a lost lease */ }
  }

  async function toPlaza(start) {
    panel.showPlaza();
    panel.clearMessages();
    const watch = async (message) => {
      await settle({ kind: "plaza", space: { id: "plaza" }, access: plaza.channel ? { channel: plaza.channel, key: null, blocked: [] } : null, bounds: plaza.bounds, start, leased: false });
      engine.setInteractive(false);
      if (message) panel.say(message);
    };
    if (!self.signedIn) return watch("You're watching the plaza. Sign in to walk and talk.");
    try {
      const access = await api("/api/spaces/plaza/enter", { method: "POST", body: "{}" });
      panel.hideOffer();
      await settle({ kind: "plaza", space: access.space, access, bounds: plaza.bounds, start, leased: true });
      engine.setInteractive(true);
    } catch (error) {
      if (error.status === 409 && error.data?.full) { panel.showOffer(error.data.offer); return watch("The plaza is full right now. You can watch, or go to one of your spaces."); }
      return watch(error.message);
    }
  }

  async function enterLot(lot) {
    if (busy) return;
    if (!self.signedIn) { panel.say("Sign in to step into " + lot.title + "."); return; }
    busy = true;
    try {
      const access = await api("/api/spaces/lot-" + lot.slug + "/enter", { method: "POST", body: "{}" });
      panel.clearMessages();
      await settle({ kind: "lot", space: access.space, lot, access, bounds: lot.interior, start: lot.entry, leased: true });
      live?.renew().catch(() => {});
      showRoom(access.space, access.hostId);
      panel.say(access.firstIn ? "You're the first one in " + lot.title + ", so you're the host. Set a topic so people know what it's about." : "You stepped into " + lot.title + ".");
    } catch (error) { panel.say(error.status === 409 ? lot.title + " is full right now." : error.message); }
    finally { busy = false; }
  }

  async function openSpace(id, invite) {
    if (!self.signedIn) { engine.setInteractive(false); panel.say("Sign in to step into this space."); return; }
    try {
      const access = await api("/api/spaces/" + encodeURIComponent(id) + "/enter", { method: "POST", body: JSON.stringify(invite ? { invite } : {}) });
      panel.clearMessages();
      await settle({ kind: "space", space: access.space, access, invite, bounds: null, start: null, leased: true });
      live?.renew().catch(() => {});
      engine.setInteractive(true);
      showRoom(access.space, access.hostId);
      panel.say("You're in " + access.space.title + ".");
    } catch (error) { engine.setInteractive(false); panel.say(error.message); }
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
    if (!here || here.kind === "plaza") return;
    try {
      const tags = String(tagsText || "").split(",").map((tag) => tag.trim()).filter(Boolean);
      const { space } = await api("/api/spaces/" + here.space.id + "/topic", { method: "POST", body: JSON.stringify({ topic, tags }) });
      showRoom(space, space.hostId);
      for (const place of places) place.refresh();
      panel.say("Topic set: " + space.topic + ".");
    } catch (error) { panel.say(error.message); }
  }

  return {
    toPlaza, enterLot, openSpace, leaveRoom, setTopic,
    say(text) {
      if (!places.length) { panel.say(self.signedIn ? "Messages need the live connection." : "Sign in to talk."); return false; }
      if (places[0].say(text)) return true;
      panel.say("That message wasn't sent. Wait a moment between messages.");
      return false;
    },
    onArrive(tile) {
      const key = tile.x + "," + tile.y;
      if (here?.kind === "plaza" && here.leased && doors.has(key)) enterLot(doors.get(key));
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
