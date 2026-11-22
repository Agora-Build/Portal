// The reader of Auth's change feed (scripts/integrations/auth-changes.mjs), with an in-memory cursor and feed: no
// database needed.
import assert from "node:assert/strict";
import test from "node:test";
import { ManageError } from "../scripts/integrations/auth-manage.mjs";
import { AUTH_CHANGES, createAuthChanges } from "../scripts/integrations/auth-changes.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// An array whose reached(n) resolves once it holds n items, so a test waits on what the reader did, not for a time.
// Its timer only fails a reader that never gets there; being ref'd, unlike the reader's own timers, it also keeps the
// event loop alive meanwhile. Both are non-enumerable: the array still compares equal to a plain one.
function watched(list = []) {
  const waiting = [];
  Object.defineProperties(list, {
    push: { value: (...items) => {
      const length = Array.prototype.push.apply(list, items);
      for (const wait of waiting.filter((entry) => length >= entry.count)) {
        waiting.splice(waiting.indexOf(wait), 1);
        wait.resolve();
      }
      return length;
    } },
    reached: { value: (count) => new Promise((resolve, reject) => {
      if (list.length >= count) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(wait), 1);
        reject(new Error("never reached " + count + " (" + list.length + ")"));
      }, 5000);
      const wait = { count, resolve: () => { clearTimeout(timer); resolve(); } };
      waiting.push(wait);
    }) }
  });
  return list;
}
const HOUR = 3600000;
const RECOVERED = "Auth change feed read again.";
const CURSOR_AHEAD = "Auth change feed cursor is ahead of Auth (restored from a backup?): reading the feed again from the start.";
// The Portal's saved cursor and the epoch it is in (D29: a start-over raises it); `fail` makes reading them throw. A
// page's cursor is saved only in the epoch the read pass began in, as repository.moveAuthChangeCursor does; `saved` has
// every cursor saved, the resets included.
function memoryCursor(cursor = null, epoch = 0) {
  const repository = {
    cursor,
    epoch,
    saved: [],
    fail: null,
    async authChangePlace() { if (repository.fail) throw repository.fail; return { cursor: repository.cursor, epoch: repository.epoch }; },
    async saveAuthChangeCursor(next) { repository.cursor = next; repository.saved.push(next); },
    async moveAuthChangeCursor(next, passEpoch) {
      if (passEpoch !== repository.epoch) return false;
      repository.cursor = next;
      repository.saved.push(next);
      return true;
    }
  };
  return repository;
}
// Auth's feed with `count` entries c1, c2, …; each read is recorded with its cursor and start time (reads.reached(n)
// waits for the nth), and `most` is the most reads it ever had in flight at once. `hold` makes reads wait until it
// resolves; `fail` makes them throw. A cursor it never handed out is beyond its newest change, as after Auth was
// restored from a backup: 409 cursor_ahead.
function feedOf(count) {
  const entry = (n) => ({ cursor: "c" + n, kind: "paused", clientId: "i-" + n });
  let inFlight = 0;
  const manage = {
    entries: Array.from({ length: count }, (_, index) => entry(index + 1)),
    reads: watched(),
    most: 0,
    hold: null,
    fail: null,
    add() { manage.entries.push(entry(manage.entries.length + 1)); },
    async integrationChanges({ after, limit }) {
      inFlight += 1;
      manage.most = Math.max(manage.most, inFlight);
      try {
        manage.reads.push({ after: after ?? null, at: Date.now() });
        if (manage.hold) await manage.hold;
        if (manage.fail) throw manage.fail;
        const place = manage.entries.findIndex((item) => item.cursor === after);
        if (after !== undefined && place < 0) throw new ManageError(409, "cursor_ahead");
        const changes = manage.entries.slice(place + 1, place + 1 + limit);
        return { changes, nextCursor: changes.length ? changes.at(-1).cursor : after ?? null };
      } finally {
        inFlight -= 1;
      }
    }
  };
  return manage;
}
const QUICK = { pollMs: 3600000, minGapMs: 20, pageSize: 2, pagesPerPull: 3 };
function reader(t, { manage, repository = memoryCursor(), apply, log = () => {}, settings = {}, now, startingOver, caughtUp }) {
  const applied = [];
  const feed = createAuthChanges({
    repository, manage, log, settings: { ...QUICK, ...settings }, apply: apply ?? (async (change) => { applied.push(change.cursor); }),
    ...(now ? { now } : {}), ...(startingOver ? { startingOver } : {}), ...(caughtUp ? { caughtUp } : {})
  });
  t.after(() => feed.stop());
  return { feed, applied, repository };
}
// A clock the test moves by hand; the reader's timers still run on real time.
function fakeClock() {
  const clock = { at: Date.parse("2026-10-31T10:00:00.000Z"), now: () => clock.at };
  return clock;
}

test("the defaults: a poll every 30 seconds, reads at least a second apart, up to 10 pages of 100", () => {
  assert.deepEqual(AUTH_CHANGES, { pollMs: 30000, minGapMs: 1000, pageSize: 100, pagesPerPull: 10 });
});

test("start reads Auth's feed at once from the saved cursor, applies each change in order and saves the cursor after each page", async (t) => {
  const manage = feedOf(3);
  const { feed, applied, repository } = reader(t, { manage, repository: memoryCursor("c1") });
  feed.start();
  await feed.idle();
  assert.deepEqual(applied, ["c2", "c3"]);
  assert.deepEqual(manage.reads.map((read) => read.after), ["c1", "c3"], "a full page is followed by the next at once");
  assert.deepEqual(repository.saved, ["c3"], "an empty page leaves the cursor as it was");
});

test("without requests the reader polls every pollMs", async (t) => {
  const manage = feedOf(0);
  const { feed, applied } = reader(t, { manage, settings: { pollMs: 40 } });
  feed.start();
  await feed.idle();
  manage.add();
  await sleep(150);
  await feed.idle();
  assert.deepEqual(applied, ["c1"]);
  assert.ok(manage.reads.length >= 3, "it read again on its own (" + manage.reads.length + " reads)");
});

test("requests coalesce: one read at a time, requests during it make exactly one more, and reads start minGapMs apart", async (t) => {
  const manage = feedOf(0);
  let release;
  manage.hold = new Promise((resolve) => { release = resolve; });
  const { feed } = reader(t, { manage, settings: { minGapMs: 60 } });
  feed.start();
  await manage.reads.reached(1); // the first read is in flight, held
  for (let index = 0; index < 20; index += 1) feed.request();
  // Held past minGapMs, so a read started beside it would have started by now. A loaded machine only waits longer,
  // which can never make a reader that keeps to one read at a time fail.
  await sleep(120);
  assert.equal(manage.reads.length, 1, "nothing more while it runs");
  manage.hold = null;
  release();
  await feed.idle();
  assert.equal(manage.reads.length, 2, "twenty requests during the read made one more");
  for (let index = 0; index < 20; index += 1) feed.request();
  await feed.idle();
  assert.equal(manage.reads.length, 3, "a burst after it makes one read");
  assert.ok(manage.reads[2].at - manage.reads[1].at >= 55, "spaced by minGapMs from the read before");
  assert.equal(manage.most, 1, "never two reads at once");
});

test("a read whose pages were all full asks for another read, after the gap", async (t) => {
  const manage = feedOf(7);
  const { feed, applied, repository } = reader(t, { manage, settings: { pagesPerPull: 2 } });
  feed.start();
  await feed.idle();
  assert.deepEqual(applied, ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  assert.deepEqual(manage.reads.map((read) => read.after), [null, "c2", "c4", "c6"]);
  assert.deepEqual(repository.saved, ["c2", "c4", "c6", "c7"]);
  assert.ok(manage.reads[2].at - manage.reads[0].at >= 15, "the second read waited for the gap");
});

test("a failed read is logged when it starts and once when reads work again; the cursor stays and the next poll tries again", async (t) => {
  const manage = feedOf(2);
  manage.fail = new ManageError(503, "unavailable");
  const logs = watched();
  const { feed, applied, repository } = reader(t, { manage, log: (line) => logs.push(line), settings: { pollMs: 25, pageSize: 10 } });
  // The next read: each poll's read reaches Auth's feed (the reads before it ended with the failure set before it).
  const nextRead = async () => {
    await manage.reads.reached(manage.reads.length + 1);
    await feed.idle();
  };
  feed.start();
  await manage.reads.reached(3); // the poll kept trying
  await feed.idle();
  assert.deepEqual(logs, ["Auth change feed read failed: unavailable."]);
  assert.deepEqual([applied, repository.saved], [[], []]);
  manage.fail = null;
  await nextRead();
  assert.deepEqual(applied, ["c1", "c2"]);
  assert.deepEqual(logs, ["Auth change feed read failed: unavailable.", RECOVERED], "the end of the failure is logged once");
  manage.fail = new ManageError(404, "not_found");
  await nextRead();
  manage.fail = null;
  repository.fail = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
  await logs.reached(4); // that read fails before it reaches Auth's feed
  assert.deepEqual(logs, ["Auth change feed read failed: unavailable.", RECOVERED, "Auth change feed not available yet: not_found.", "Auth change feed failed: ECONNREFUSED."]);
});

test("a lasting 400, 401 or 403 never stops the reader: every poll tries again, and it is logged once an hour while it lasts", async (t) => {
  for (const [status, code] of [[400, "invalid_request"], [401, "invalid_client"], [403, "forbidden"]]) {
    const clock = fakeClock();
    const manage = feedOf(1);
    manage.fail = new ManageError(status, code);
    const logs = [];
    const { feed, applied } = reader(t, { manage, now: clock.now, log: (line) => logs.push(line), settings: { pollMs: 15 } });
    const failed = "Auth change feed read failed: " + code + ".";
    feed.start();
    await sleep(80);
    const tried = manage.reads.length;
    assert.ok(tried >= 3, status + ": the poll kept trying (" + tried + " reads)");
    assert.deepEqual(logs, [failed], status + ": logged when it started");
    clock.at += HOUR - 1000;
    await sleep(50);
    assert.deepEqual(logs, [failed], status + ": not again within the hour");
    clock.at += 1000;
    await sleep(50);
    assert.deepEqual(logs, [failed, failed], status + ": again an hour later");
    assert.ok(manage.reads.length > tried + 2, status + ": still trying");
    manage.fail = null;
    await sleep(50);
    await feed.idle();
    assert.deepEqual(applied, ["c1"], status + ": read once Auth accepts it again");
    assert.deepEqual(logs, [failed, failed, RECOVERED]);
    await sleep(50);
    assert.equal(logs.length, 3, status + ": nothing more while reads work");
    await feed.stop();
  }
});

test("a 404 means Auth has no change feed yet (the Portal was deployed first): the reader keeps polling quietly, logging it once an hour", async (t) => {
  const clock = fakeClock();
  const manage = feedOf(2);
  manage.fail = new ManageError(404, "not_found");
  const logs = [];
  const { feed, applied, repository } = reader(t, { manage, now: clock.now, log: (line) => logs.push(line), settings: { pollMs: 15, pageSize: 10 } });
  const missing = "Auth change feed not available yet: not_found.";
  feed.start();
  await sleep(80);
  assert.ok(manage.reads.length >= 3, "the poll kept trying (" + manage.reads.length + " reads)");
  assert.deepEqual([logs, applied, repository.saved], [[missing], [], []]);
  clock.at += HOUR / 2;
  await sleep(50);
  assert.deepEqual(logs, [missing], "quiet within the hour");
  clock.at += HOUR / 2;
  await sleep(50);
  assert.deepEqual(logs, [missing, missing], "logged again an hour later");
  manage.fail = null; // Auth now has its feed
  await sleep(50);
  await feed.idle();
  assert.deepEqual([applied, repository.cursor, logs], [["c1", "c2"], "c2", [missing, missing, RECOVERED]]);
});

test("a cursor ahead of Auth's feed (409 cursor_ahead: Auth restored from a backup) is reset with one warning and the feed read again from the start", async (t) => {
  const manage = feedOf(3);
  const logs = [];
  const { feed, applied, repository } = reader(t, { manage, repository: memoryCursor("c9"), log: (line) => logs.push(line) });
  feed.start();
  await feed.idle();
  assert.deepEqual(manage.reads.map((read) => read.after), ["c9", null, "c2"], "in the same read, from the start");
  assert.deepEqual(repository.saved, [null, "c2", "c3"], "the cursor is reset before the feed is read again");
  assert.deepEqual(applied, ["c1", "c2", "c3"]);
  assert.deepEqual(logs, [CURSOR_AHEAD]);
  // An Auth that answers cursor_ahead even from the start: the cursor is reset once per read, then the read fails.
  const stuck = feedOf(0);
  stuck.fail = new ManageError(409, "cursor_ahead");
  const stuckLogs = [];
  const second = reader(t, { manage: stuck, repository: memoryCursor("c1"), log: (line) => stuckLogs.push(line) });
  second.feed.start();
  await second.feed.idle();
  assert.deepEqual(stuck.reads.map((read) => read.after), ["c1", null]);
  assert.deepEqual([second.repository.saved, stuckLogs], [[null], [CURSOR_AHEAD, "Auth change feed read failed: cursor_ahead."]]);
});

test("a page of changes that does not move Auth's cursor is a bad answer: nothing of it is applied and the next poll tries again", async (t) => {
  const manage = feedOf(2);
  const honest = manage.integrationChanges;
  manage.integrationChanges = async (query) => ({ ...(await honest(query)), nextCursor: query.after ?? null });
  const logs = [];
  const { feed, applied, repository } = reader(t, { manage, log: (line) => logs.push(line) });
  feed.start();
  await feed.idle();
  assert.deepEqual([manage.reads.length, applied, repository.saved, logs], [1, [], [], ["Auth change feed read failed: bad_response."]]);
});

test("a change that cannot be applied stops the read before its page's cursor is saved; the next read starts there again", async (t) => {
  const manage = feedOf(3);
  let failing = true;
  const logs = [];
  const seen = [];
  const { feed, repository } = reader(t, { manage, log: (line) => logs.push(line), settings: { pageSize: 10, pollMs: 30 }, apply: async (change) => {
    seen.push(change.cursor);
    if (change.cursor === "c2" && failing) throw Object.assign(new Error("statement timeout"), { code: "57014" });
  } });
  feed.start();
  await feed.idle();
  assert.deepEqual([seen, repository.saved, logs], [["c1", "c2"], [], ["Auth change not applied: 57014."]]);
  failing = false;
  await sleep(80);
  await feed.idle();
  assert.deepEqual(seen.slice(0, 5), ["c1", "c2", "c1", "c2", "c3"], "the page is read again from the saved cursor; applying is idempotent");
  assert.equal(repository.cursor, "c3");
  assert.deepEqual(logs, ["Auth change not applied: 57014.", RECOVERED]);
});

test("stop() cancels the next read and waits for the one in flight; requests after it read nothing", async (t) => {
  const manage = feedOf(0);
  let release;
  manage.hold = new Promise((resolve) => { release = resolve; });
  const { feed } = reader(t, { manage, settings: { pollMs: 20 } });
  feed.start();
  await sleep(10);
  let stopped = false;
  const stopping = feed.stop().then(() => { stopped = true; });
  await sleep(10);
  assert.equal(stopped, false, "it waits for the read in flight");
  manage.hold = null;
  release();
  await stopping;
  feed.request();
  await sleep(60);
  assert.equal(manage.reads.length, 1);
});

test("stop() during a catch-up returns after the page being applied: its cursor is saved and no further page is fetched", async (t) => {
  const manage = feedOf(7);
  let release;
  const holding = new Promise((resolve) => { release = resolve; });
  let applying = false;
  const applied = [];
  const { feed, repository } = reader(t, { manage, apply: async (change) => {
    if (change.cursor === "c1") { applying = true; await holding; }
    applied.push(change.cursor);
  } });
  feed.start();
  while (!applying) await sleep(5); // the reader's own timers are unref'd
  const stopping = feed.stop();
  release();
  await stopping;
  assert.deepEqual([manage.reads.map((read) => read.after), applied, repository.saved], [[null], ["c1", "c2"], ["c2"]]);
  await sleep(60);
  assert.equal(manage.reads.length, 1, "nothing read after stop()");
});

test("a wall clock stepped back never delays a requested read beyond minGapMs", async (t) => {
  const clock = fakeClock();
  const manage = feedOf(0);
  const { feed } = reader(t, { manage, now: clock.now, settings: { minGapMs: 40 } });
  feed.start();
  await feed.idle();
  assert.equal(manage.reads.length, 1);
  clock.at -= 5000; // e.g. an NTP step: the last read now seems 5 seconds in the future
  feed.request();
  await sleep(90);
  assert.equal(manage.reads.length, 2, "read within minGapMs, not 5 seconds later");
  manage.add();
  feed.request();
  await feed.idle();
  assert.equal(manage.reads.length, 3);
});

// Account availability (D29): the reader tells the service when it starts over from Auth's first entry (a first start, or
// a reset) and when a read has caught up with the end of the feed; the service decides what that means.
function hooked() {
  const events = watched();
  return {
    events,
    apply: async (change) => { events.push("apply " + change.cursor); },
    startingOver: async () => { events.push("starting over"); },
    caughtUp: async () => { events.push("caught up"); }
  };
}

test("a read that begins with no saved cursor says it is starting over before its first page, and one that ends on a short page says it has caught up", async (t) => {
  const manage = feedOf(3);
  const hooks = hooked();
  const { feed } = reader(t, { manage, ...hooks });
  feed.start();
  await feed.idle();
  assert.deepEqual(hooks.events, ["starting over", "apply c1", "apply c2", "apply c3", "caught up"]);
  // The next read begins at the saved cursor: nothing starts over, and an empty page is a short one.
  manage.add();
  feed.request();
  await feed.idle();
  assert.deepEqual(hooks.events.slice(5), ["apply c4", "caught up"]);
});

test("with a saved cursor a read does not start over, and a read of full pages that is not at the end says nothing until the page that is short", async (t) => {
  const manage = feedOf(7);
  const hooks = hooked();
  const { feed } = reader(t, { manage, repository: memoryCursor("c1"), settings: { pagesPerPull: 2 }, ...hooks });
  feed.start();
  await feed.idle();
  // c2..c7 is three pages of two; the read of two pages ends with more waiting, the next read ends on an empty page.
  assert.deepEqual(hooks.events, ["apply c2", "apply c3", "apply c4", "apply c5", "apply c6", "apply c7", "caught up"]);
  assert.deepEqual(manage.reads.map((read) => read.after), ["c1", "c3", "c5", "c7"]);
});

test("a cursor ahead of Auth's feed is a reset, and the read says it is starting over before it reads again from the start", async (t) => {
  const manage = feedOf(2);
  const hooks = hooked();
  const { feed } = reader(t, { manage, repository: memoryCursor("c9"), settings: { pageSize: 5 }, ...hooks });
  feed.start();
  await feed.idle();
  assert.deepEqual(hooks.events, ["starting over", "apply c1", "apply c2", "caught up"]);
  assert.deepEqual(manage.reads.map((read) => read.after), ["c9", null]);
});

test("a read stopped before it reaches the end of the feed does not say it has caught up", async (t) => {
  const manage = feedOf(6);
  let release;
  const holding = new Promise((resolve) => { release = resolve; });
  let applying = false;
  const hooks = hooked();
  const { feed } = reader(t, { manage, ...hooks, apply: async (change) => {
    if (change.cursor === "c1") { applying = true; await holding; }
    await hooks.apply(change);
  } });
  feed.start();
  while (!applying) await sleep(5);
  const stopping = feed.stop();
  release();
  await stopping;
  assert.deepEqual(hooks.events, ["starting over", "apply c1", "apply c2"]);
});

test("a hook that fails fails the read, logged by its code: starting over stops it before any change, and caught up is said again by the next read", async (t) => {
  const manage = feedOf(2);
  const logs = watched();
  const hooks = hooked();
  let failing = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
  const { feed, repository } = reader(t, { manage, log: (line) => logs.push(line), settings: { pollMs: 25, pageSize: 5 }, ...hooks,
    startingOver: async () => { if (failing) throw failing; await hooks.startingOver(); } });
  feed.start();
  await logs.reached(1);
  assert.deepEqual(logs, ["Auth change feed failed: ECONNREFUSED."]);
  assert.deepEqual([hooks.events.slice(), repository.saved], [[], []], "nothing applied");
  failing = null;
  await hooks.events.reached(4);
  await feed.idle();
  assert.deepEqual(hooks.events.slice(0, 4), ["starting over", "apply c1", "apply c2", "caught up"]);

  // The same for caught up: the page is applied and its cursor saved, and the next read says it again.
  const second = feedOf(2);
  const more = hooked();
  const secondLogs = watched();
  let fail = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
  const other = reader(t, { manage: second, log: (line) => secondLogs.push(line), settings: { pollMs: 25, pageSize: 5 }, ...more,
    caughtUp: async () => { if (fail) throw fail; await more.caughtUp(); } });
  other.feed.start();
  await secondLogs.reached(1);
  assert.deepEqual(secondLogs, ["Auth change feed failed: ECONNREFUSED."]);
  assert.deepEqual([more.events.slice(), other.repository.saved], [["starting over", "apply c1", "apply c2"], ["c2"]]);
  fail = null;
  await more.events.reached(4);
  assert.deepEqual(more.events.slice(0, 4), ["starting over", "apply c1", "apply c2", "caught up"]);
});

// A read pass and its epoch (D29): every start-over raises the epoch, and a pass hands the epoch it began in to `apply`
// with each change and to `caughtUp`, so the service can refuse what a pass that began before another replica's
// start-over does.
test("a read pass hands each change and its end the epoch it began in: the saved cursor's, or the one its start-over made", async (t) => {
  const passes = [];
  const record = (name) => async (change, pass) => { passes.push([name, change?.cursor ?? null, pass]); };
  // From a saved cursor: the saved epoch, the same pass throughout.
  const manage = feedOf(4);
  const saved = memoryCursor("c1", 4);
  const { feed } = reader(t, { manage, repository: saved, apply: record("apply"), caughtUp: (pass) => record("caught up")(null, pass) });
  feed.start();
  await feed.idle();
  assert.deepEqual(passes.map(([name, cursor, pass]) => [name, cursor, pass]), [["apply", "c2", { epoch: 4 }], ["apply", "c3", { epoch: 4 }], ["apply", "c4", { epoch: 4 }], ["caught up", null, { epoch: 4 }]]);
  assert.equal(new Set(passes.map(([, , pass]) => pass)).size, 1, "one pass for the whole read, both its pages and its end");

  // With no saved cursor, the epoch the start-over made (read after it), and the same after a cursor ahead of Auth's.
  for (const [cursor, epoch] of [[null, 0], ["c9", 7]]) {
    passes.length = 0;
    const fresh = memoryCursor(cursor, epoch);
    const started = reader(t, { manage: feedOf(2), repository: fresh, settings: { pageSize: 5 }, apply: record("apply"), caughtUp: (pass) => record("caught up")(null, pass),
      startingOver: async () => { fresh.epoch += 1; } });
    started.feed.start();
    await started.feed.idle();
    assert.deepEqual(passes.map(([name, at, pass]) => [name, at, pass.epoch]), [["apply", "c1", epoch + 1], ["apply", "c2", epoch + 1], ["caught up", null, epoch + 1]], String(cursor));
  }
});

test("a page's cursor is not saved once another replica has started the feed over: the read stops there with the stale-pass line, before its next page and its end; the next read goes on in the new epoch", async (t) => {
  const manage = feedOf(6);
  const logs = [];
  const hooks = hooked();
  const repository = memoryCursor("c1", 1);
  let moved = false;
  const { feed } = reader(t, { manage, repository, log: (line) => logs.push(line), settings: { pageSize: 2 }, ...hooks, apply: async (change) => {
    await hooks.apply(change);
    // Another replica starts over while this pass applies its first page.
    if (change.cursor === "c3" && !moved) {
      moved = true;
      repository.epoch = 2;
    }
  } });
  feed.start();
  await feed.idle();
  assert.deepEqual([hooks.events.slice(), repository.saved, manage.reads.length, logs], [["apply c2", "apply c3"], [], 1, ["Auth change not applied: stale_pass."]]);
  feed.request();
  await feed.idle();
  assert.deepEqual(hooks.events.slice(2), ["apply c2", "apply c3", "apply c4", "apply c5", "apply c6", "caught up"]);
  assert.deepEqual(repository.saved, ["c3", "c5", "c6"]);
  assert.deepEqual(logs, ["Auth change not applied: stale_pass.", RECOVERED]);
});

test("a change the service refuses as from a stale pass stops the read before its page's cursor is saved, logged by its code", async (t) => {
  const manage = feedOf(3);
  const logs = [];
  const { feed, repository } = reader(t, { manage, log: (line) => logs.push(line), settings: { pageSize: 10 }, apply: async (change) => {
    if (change.cursor === "c2") throw Object.assign(new Error("stale"), { code: "stale_pass" });
  } });
  feed.start();
  await feed.idle();
  assert.deepEqual([repository.saved, logs], [[], ["Auth change not applied: stale_pass."]]);
});
