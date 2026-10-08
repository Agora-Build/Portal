import { importKey, open, seal } from "./crypto.js";

// One Agora Signaling login with space channels joined as needed. Keyed (unlisted and private) channels are encrypted
// end to end; presence events are normalized into snapshot, join, leave, and state changes per channel.
export function createLive({ AgoraRTM, fetchToken, onStatus = () => {} }) {
  let client = null, userId = null, queue = Promise.resolve();
  const channels = new Map();
  const guest = () => String(userId).startsWith("g-");
  // Events are handled one at a time so decryption never reorders presence or messages.
  const enqueue = (kind, task) => { queue = queue.then(task).catch((error) => onStatus(kind, error)); };
  async function statesOf(channel, states) {
    if (!channel.key) return states || {};
    const text = await open(channel.key, states?.s);
    if (text === null) return null;
    try { const value = JSON.parse(text); return value && typeof value === "object" ? value : null; } catch { return null; }
  }
  async function people(channel, list) {
    const entries = await Promise.all((list || []).map(async (entry) => ({ userId: entry.userId, states: await statesOf(channel, entry.states) })));
    return entries.filter((entry) => entry.userId !== userId && entry.states);
  }
  async function onPresence(event) {
    const channel = channels.get(event.channelName);
    if (!channel) return;
    const emit = (change) => { if (channels.get(event.channelName) === channel) channel.handlers.presence(change); };
    if (event.eventType === "SNAPSHOT") emit({ type: "snapshot", people: await people(channel, event.snapshot) });
    else if (event.eventType === "REMOTE_JOIN") { if (event.publisher !== userId) emit({ type: "join", userId: event.publisher }); }
    else if (event.eventType === "REMOTE_LEAVE" || event.eventType === "REMOTE_TIMEOUT") { if (event.publisher !== userId) emit({ type: "leave", userId: event.publisher }); }
    else if (event.eventType === "REMOTE_STATE_CHANGED") {
      if (event.publisher === userId) return;
      const states = await statesOf(channel, event.stateChanged);
      if (states) emit({ type: "state", userId: event.publisher, states });
    } else if (event.eventType === "INTERVAL") {
      const interval = event.interval || {};
      for (const id of [...(interval.leave?.users || []), ...(interval.timeout?.users || [])]) if (id !== userId) emit({ type: "leave", userId: id });
      for (const entry of await people(channel, interval.userStateList)) emit({ type: "state", userId: entry.userId, states: entry.states });
    }
  }
  async function onMessage(event) {
    const channel = channels.get(event.channelName);
    if (!channel || typeof event.message !== "string" || event.publisher === userId) return;
    const text = channel.key ? await open(channel.key, event.message) : event.message;
    if (text !== null && channels.get(event.channelName) === channel) channel.handlers.message(event.publisher, text);
  }
  async function renew() { const access = await fetchToken(); await client.renewToken(access.token); return access; }
  return {
    get userId() { return userId; },
    get guest() { return guest(); },
    async connect() {
      const access = await fetchToken();
      userId = access.userId;
      client = new AgoraRTM.RTM(access.appId, userId, { presenceTimeout: 30 });
      client.addEventListener("message", (event) => enqueue("message", () => onMessage(event)));
      client.addEventListener("presence", (event) => enqueue("presence", () => onPresence(event)));
      client.addEventListener("tokenPrivilegeWillExpire", () => { renew().catch((error) => onStatus("token", error)); });
      client.addEventListener("linkState", (event) => onStatus(event?.reasonCode === "SAME_UID_LOGIN" ? "duplicate" : "link", event));
      await client.login({ token: access.token });
      return access;
    },
    renew,
    async join(name, { spaceId, key = null, quiet = false }, handlers) {
      channels.set(name, { spaceId, key: key ? await importKey(key) : null, handlers });
      try { await client.subscribe(name, { withMessage: true, withPresence: true, beQuiet: guest() || Boolean(quiet) }); }
      catch (error) { channels.delete(name); throw error; }
    },
    async leave(name) { if (!channels.delete(name)) return; await client.unsubscribe(name).catch(() => {}); },
    async publish(name, text) {
      if (guest()) throw new Error("Guests cannot publish.");
      const channel = channels.get(name);
      if (!channel) throw new Error("Not in channel " + name + ".");
      await client.publish(name, channel.key ? await seal(channel.key, text) : text);
    },
    async setState(name, state) {
      if (guest()) throw new Error("Guests cannot publish.");
      const channel = channels.get(name);
      if (!channel) return;
      await client.presence.setState(name, "MESSAGE", channel.key ? { s: await seal(channel.key, JSON.stringify(state)) } : state);
    },
    async who(name) {
      const channel = channels.get(name);
      if (!channel) return [];
      const list = [];
      let page = "";
      for (let count = 0; count < 50; count += 1) {
        const result = await client.presence.whoNow(name, "MESSAGE", { includedUserId: true, includedState: true, ...(page ? { page } : {}) });
        list.push(...await people(channel, result.occupants));
        page = result.nextPage;
        if (!page) break;
      }
      return list;
    },
    async close() { channels.clear(); await client?.logout().catch(() => {}); client = null; }
  };
}
