import { roleAt, walkable } from "../world/map.js";
import { openPlace } from "./place.js";
import { createLease as realLease } from "./lease.js";

const inside = (rect, tile) => tile.x >= rect.x && tile.y >= rect.y && tile.x < rect.x + rect.width && tile.y < rect.y + rect.height;
// The plaza tile just outside a lot's door, where you stand after leaving the room.
export const outsideDoor = (map, lot) => [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => ({ x: lot.door.x + dx, y: lot.door.y + dy })).find((tile) => walkable(map, tile.x, tile.y) && !inside(lot.interior, tile)) || lot.door;

// Moves the person between the plaza, lot rooms, and user spaces: entry leases on the server, channels on Signaling.
const REFRESH_GAP = 5000;
// `live` may be null at first and attached later with attachLive, so the page never waits on the SDK.
export function createStage({ api, map, engine, panel, live: firstLive, self, plaza, onRoom = () => {}, onPeople = () => {}, onManage = () => {}, createLease = realLease, schedule = (callback) => typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : setTimeout(callback, 16), now = () => Date.now(), later = (callback, delay) => setTimeout(callback, delay) }) {
  let live = firstLive, places = [], lease = null, here = null, chain = Promise.resolve(), drawing = false, everyone = [], roomId = null, currentDecor = [], editing = false, manageNow = false;
  // State changes run strictly one at a time, each re-checking its preconditions when it starts.
  const transition = (task) => (chain = chain.then(task, task).catch((error) => panel.say(error.message || "Something went wrong.")));
  const doors = new Map(map.lots.map((lot) => [lot.door.x + "," + lot.door.y, lot]));
  const exits = new Map(map.lots.map((lot) => [lot.entry.x + "," + (lot.entry.y + 1), lot]));
  // Cell-ready: a space may later span several channels; people from all of them are merged by id.
  // Presence events can arrive in bursts, so the lists are rebuilt at most once per frame.
  const showPeople = () => {
    if (drawing) return;
    drawing = true;
    schedule(() => {
      drawing = false;
      const seen = new Map();
      for (const place of places) for (const person of place.people()) seen.set(person.id, person);
      const list = [...seen.values()];
      everyone = list;
      engine.setOthers(list);
      panel.setPeople(list, self.name);
      onPeople(list);
    });
  };
  const mine = (id) => Boolean(id) && (self.ids || [self.id]).includes(id);
  const canManage = () => Boolean(here && (here.kind === "lot" || here.kind === "space") && here.leased && self.signedIn && (mine(here.access?.hostId) || mine(here.space?.ownerId)));
  const checkManage = () => { const can = canManage(); if (can !== manageNow) { manageNow = can; onManage(can); } };
  const doorTiles = (rect) => { const tiles = []; for (let y = rect.y; y < rect.y + rect.height; y += 1) for (let x = rect.x; x < rect.x + rect.width; x += 1) if (roleAt(map, x, y) === "door") tiles.push({ x, y }); return tiles; };
  const showDecor = (items) => { currentDecor = items || []; if (!editing) engine.setDecor(currentDecor); };
  const showRoom = (space, hostId) => { panel.showRoom({ kicker: here?.kind === "lot" ? "LOT ROOM" : space.visibility === "private" ? "PRIVATE SPACE" : "UNLISTED SPACE", title: space.title, topic: space.topic, tags: space.tags || [], host: Boolean(self.id) && (mine(hostId) || mine(space.ownerId)), leaveLabel: here?.kind === "lot" ? "Back to the plaza" : "Leave this space", decorate: canManage() }); checkManage(); };

  // Every transition claims `here` before it awaits anything; a superseded one stops as soon as it notices.
  async function settle(next) {
    here = next;
    // The call and the decor editor belong to a room, so the page hears about room changes, not channel changes.
    const room = next.leased && (next.kind === "lot" || next.kind === "space") ? next.space : null;
    if ((room?.id || null) !== roomId) { roomId = room?.id || null; editing = false; onRoom(room); }
    showDecor(next.space?.decor);
    lease?.stop(); lease = null;
    const old = places; places = [];
    await Promise.all(old.map((place) => place.close().catch(() => {})));
    if (here !== next) return;
    if (next.start) engine.teleport(next.start);
    engine.setBounds(next.bounds || null);
    showPeople();
    if (live && next.access?.channel) {
      try {
        const place = await openPlace({ live, map, engine, self, quiet: Boolean(next.watch), channel: { name: next.access.channel, key: next.access.key || null, spaceId: next.space.id }, onPeople: showPeople, onSay: (entry) => { if (entry.failed) panel.say("That message didn't send."); else panel.addMessage(entry); }, onRefresh: (from) => { if (here === next && from && from === next.access?.hostId) refreshRoom(); }, onDecor: (from) => { if (here === next && from && (from === next.access?.hostId || from === next.space?.ownerId)) refreshRoom(); } });
        if (here !== next) { await place.close().catch(() => {}); return; }
        places = [place];
        place.setBlocked(next.access.blocked || []);
        showPeople();
      } catch (error) { if (here === next) panel.say("Live movement isn't available here (" + (error.message || "unknown error") + ")."); }
    }
    if (here !== next) return;
    if (next.leased) {
      const made = createLease({ api, spaceId: next.space.id, onAccess: (access) => { if (lease === made) onAccess(access, next); }, onLost: (error) => { transition(() => lost(made, error)); } });
      lease = made;
    }
    const talk = Boolean(next.leased) && self.signedIn;
    checkManage();
    panel.canTalk(talk, talk || !self.signedIn ? undefined : next.full ? "The plaza is full \u2014 you're watching." : next.kind === "left" ? "You're no longer in this space." : "You're watching.");
  }

  function onAccess(access, at) {
    if (here !== at) return;
    if (places[0] && access.channel !== places[0].channel) {
      transition(async () => {
        if (here !== at || !places[0] || places[0].channel === access.channel) return;
        await live?.renew().catch(() => {});
        if (here === at) await settle({ ...at, access: { ...at.access, ...access }, start: null });
      });
      return;
    }
    for (const place of places) place.setBlocked(access.blocked || []);
    if (here.kind !== "plaza" && access.hostId !== here.access.hostId) { here.access = { ...here.access, ...access }; checkManage(); refreshRoom(); }
  }

  // A lease the server dropped (410) gets one re-entry into the same place; removed or hidden (403, 404) does not.
  async function reenter(at) {
    if (at.kind === "lot") {
      const access = await api("/api/spaces/lot-" + at.lot.slug + "/enter", { method: "POST", body: "{}" });
      await live?.renew().catch(() => {});
      await settle({ kind: "lot", space: access.space, lot: at.lot, access, bounds: at.lot.interior, start: null, leased: true });
      showRoom(access.space, access.hostId);
    } else {
      const access = await api("/api/spaces/" + encodeURIComponent(at.space.id) + "/enter", { method: "POST", body: JSON.stringify(at.invite ? { invite: at.invite } : {}) });
      await live?.renew().catch(() => {});
      await settle({ kind: "space", space: access.space, access, invite: at.invite, bounds: null, start: null, leased: true });
      showRoom(access.space, access.hostId);
    }
  }

  async function lost(from, error) {
    if (!here || lease !== from) return;
    const at = here;
    if (error?.status === 410 && (at.kind === "lot" || at.kind === "space")) {
      try { await reenter(at); return; } catch { if (here !== at) return; }
    }
    if (here.kind === "lot") { const lot = here.lot; await toPlazaTask(outsideDoor(map, lot)); panel.say("You're no longer in " + lot.title + "."); }
    else if (here.kind === "space") { await settle({ kind: "left", space: here.space, bounds: here.bounds }); engine.setInteractive(false); panel.say("You're no longer in this space."); }
    else await toPlazaTask(null);
  }

  // Room refreshes are limited to one request at a time and one every few seconds; a refresh in between becomes one trailing request.
  let inflight = false, trailing = false, waiting = null, lastRefresh = -Infinity;
  function refreshRoom() {
    if (inflight) { trailing = true; return; }
    const wait = lastRefresh + REFRESH_GAP - now();
    if (wait > 0) { if (waiting === null) waiting = later(() => { waiting = null; refreshRoom(); }, wait); return; }
    inflight = true; lastRefresh = now();
    fetchRoom().finally(() => { inflight = false; if (trailing) { trailing = false; refreshRoom(); } });
  }
  async function fetchRoom() {
    const at = here;
    if (!at || at.kind === "plaza" || !at.space) return;
    try {
      const { space } = await api("/api/spaces/" + at.space.id + (at.invite ? "?invite=" + encodeURIComponent(at.invite) : ""));
      if (here === at) { here.space = { ...here.space, ...space }; if (here.access) here.access = { ...here.access, hostId: space.hostId }; showRoom(space, space.hostId); showDecor(space.decor); }
    } catch { /* the next heartbeat reports a lost lease */ }
  }

  async function toPlazaTask(start, welcome) {
    panel.showPlaza();
    panel.clearMessages();
    const watch = async (message, full) => {
      await settle({ kind: "plaza", space: { id: "plaza" }, access: plaza.channel ? { channel: plaza.channel, key: null, blocked: [] } : null, bounds: plaza.bounds, start, leased: false, watch: true, full });
      engine.setInteractive(false);
      panel.say(message);
    };
    if (!self.signedIn) return watch("You're watching the plaza. Sign in to walk and talk.");
    try {
      const access = await api("/api/spaces/plaza/enter", { method: "POST", body: "{}" });
      panel.hideOffer();
      await settle({ kind: "plaza", space: access.space, access, bounds: plaza.bounds, start, leased: true });
      engine.setInteractive(true);
      panel.say(welcome || "You're on the plaza. Walk to a room to see who's there.");
    } catch (error) {
      if (error.status === 409 && error.data?.full) { panel.showOffer(error.data.offer); return watch("The plaza is full right now. You can watch, or go to one of your spaces.", true); }
      return watch(error.message);
    }
  }

  async function enterLotTask(lot) {
    if (!here || here.kind !== "plaza" || !here.leased) return;
    const at = engine.position();
    if (at.x !== lot.door.x || at.y !== lot.door.y) return;
    try {
      const access = await api("/api/spaces/lot-" + lot.slug + "/enter", { method: "POST", body: "{}" });
      panel.clearMessages();
      await live?.renew().catch(() => {});
      await settle({ kind: "lot", space: access.space, lot, access, bounds: lot.interior, start: lot.entry, leased: true });
      showRoom(access.space, access.hostId);
      panel.say(access.firstIn ? "You're the first one in " + lot.title + ", so you're the host. Set a topic so people know what it's about." : "You stepped into " + lot.title + ".");
    } catch (error) { panel.say(error.status === 409 ? lot.title + " is full right now." : error.message); }
  }

  async function openSpaceTask(id, invite) {
    if (!self.signedIn) { engine.setInteractive(false); panel.say("Sign in to step into this space."); return; }
    try {
      const access = await api("/api/spaces/" + encodeURIComponent(id) + "/enter", { method: "POST", body: JSON.stringify(invite ? { invite } : {}) });
      panel.clearMessages();
      await live?.renew().catch(() => {});
      await settle({ kind: "space", space: access.space, access, invite, bounds: null, start: null, leased: true });
      engine.setInteractive(true);
      showRoom(access.space, access.hostId);
      panel.say("You're in " + access.space.title + ".");
    } catch (error) { engine.setInteractive(false); panel.say(error.message); }
  }

  async function leaveRoomTask() {
    if (!here || (here.kind !== "lot" && here.kind !== "space")) return;
    const { kind, lot } = here;
    await lease?.leave(); lease = null;
    if (kind === "lot") { await toPlazaTask(outsideDoor(map, lot)); panel.say("You're back on the plaza."); }
    else location.assign("/stoa/");
  }

  const enterLot = (lot) => {
    if (!self.signedIn) { panel.say("Sign in to step into " + lot.title + "."); return Promise.resolve(); }
    return transition(() => enterLotTask(lot));
  };
  const leaveRoom = () => transition(leaveRoomTask);

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
    toPlaza: (start, welcome) => transition(() => toPlazaTask(start, welcome)),
    enterLot,
    openSpace: (id, invite) => transition(() => openSpaceTask(id, invite)),
    leaveRoom,
    setTopic,
    people: () => everyone,
    canManage,
    decor: () => currentDecor,
    decorRegion() {
      if (here?.kind === "lot") return { area: here.lot.interior, start: here.lot.entry, protect: [here.lot.entry, ...doorTiles(here.lot.interior)] };
      if (here?.kind !== "space") return null;
      const area = { x: 0, y: 0, width: map.width, height: map.height };
      return { area, start: map.spawns[0], protect: [...map.spawns, ...doorTiles(area)] };
    },
    decorArea: () => here?.kind === "lot" ? here.lot.interior : here?.kind === "space" ? { x: 0, y: 0, width: map.width, height: map.height } : null,
    setEditing(value) { editing = Boolean(value); if (!editing) engine.setDecor(currentDecor); },
    async saveDecor(items) {
      const at = here;
      if (!canManage()) { panel.say("Only the host can decorate."); return false; }
      try {
        const result = await api("/api/spaces/" + encodeURIComponent(at.space.id) + "/decor", { method: "PUT", body: JSON.stringify({ items }) });
        if (!(here?.space?.id === at.space.id && here.leased)) return false;
        editing = false;
        here.space = { ...here.space, decor: result.decor };
        showDecor(result.decor);
        for (const place of places) place.decorChanged(result.version);
        panel.say("Decorations saved.");
        return true;
      } catch (error) { if (here?.space?.id === at.space.id) panel.say(error.message); return false; }
    },
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
    // Called when Signaling finishes connecting after the page started: reopens the current place's channel.
    attachLive: (next, plazaChannel) => transition(async () => {
      live = next;
      if (plaza && plazaChannel) plaza.channel = plazaChannel;
      const at = here;
      if (!at || at.kind === "left") return;
      const access = at.kind === "plaza" && !at.leased ? (plaza?.channel ? { channel: plaza.channel, key: null, blocked: [] } : null) : at.access;
      if (access?.channel) await settle({ ...at, access, start: null });
    }),
    unload() { lease?.leaveOnUnload(); }
  };
}
