// Keeps an entry lease alive and reports when it ends. Leaving on page close uses a beacon so it still reaches the server.
export function createLease({ api, spaceId, onAccess = () => {}, onLost = () => {}, every = 20000, repeat = (callback, delay) => setInterval(callback, delay), stopRepeat = (handle) => clearInterval(handle), beacon = (url) => navigator.sendBeacon?.(url) }) {
  const base = "/api/spaces/" + spaceId;
  let timer = null;
  const stop = () => { if (timer !== null) { stopRepeat(timer); timer = null; } };
  timer = repeat(async () => {
    try { onAccess(await api(base + "/heartbeat", { method: "POST" })); }
    catch (error) { if ([403, 404, 410].includes(error.status)) { stop(); onLost(error); } }
  }, every);
  return {
    stop,
    async leave() { stop(); try { await api(base + "/leave", { method: "POST" }); } catch { /* the lease expires on its own */ } },
    leaveOnUnload() { stop(); beacon(base + "/leave"); }
  };
}
