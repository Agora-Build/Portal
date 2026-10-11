// Keeps an entry lease alive and reports when it ends. Leaving on page close uses a beacon so it still reaches the server.
export function createLease({ api, spaceId, onAccess = () => {}, onLost = () => {}, every = 20000, repeat = (callback, delay) => setInterval(callback, delay), stopRepeat = (handle) => clearInterval(handle), beacon = (url) => navigator.sendBeacon?.(url), now = () => Date.now(), later = (callback, delay) => setTimeout(callback, delay), cancel = (handle) => clearTimeout(handle) }) {
  const base = "/api/spaces/" + spaceId;
  let timer = null, stopped = false, quick = null, lastQuick = -Infinity, again = false, againForced = false, waiting = null;
  const stop = () => { stopped = true; if (timer !== null) { stopRepeat(timer); timer = null; } if (waiting !== null) { cancel(waiting); waiting = null; } };
  const beat = async () => {
    try { const access = await api(base + "/heartbeat", { method: "POST" }); if (!stopped) onAccess(access); }
    catch (error) { if (!stopped && [401, 403, 404, 410].includes(error.status)) { stop(); onLost(error); } }
  };
  timer = repeat(beat, every);
  function beatNow({ force = false } = {}) {
    if (stopped) return Promise.resolve();
    if (quick) { again = true; againForced ||= force; return quick; }
    const wait = force ? 0 : lastQuick + 2000 - now();
    if (wait > 0) { if (waiting === null) waiting = later(() => { waiting = null; beatNow({ force: true }); }, wait); return Promise.resolve(); }
    if (waiting !== null) { cancel(waiting); waiting = null; }
    lastQuick = now();
    return (quick = beat().finally(() => { quick = null; if (again) { const forced = againForced; again = againForced = false; beatNow({ force: forced }); } }));
  }
  return {
    stop,
    // An extra heartbeat right away, for when access has changed. One runs at a time and, unless forced, at most one every two seconds,
    // so a flood of rekey notices costs little; a request that has to wait is kept as one trailing beat, never dropped.
    beatNow,
    async leave() { stop(); try { await api(base + "/leave", { method: "POST" }); } catch { /* the lease expires on its own */ } },
    leaveOnUnload() { stop(); beacon(base + "/leave"); }
  };
}
