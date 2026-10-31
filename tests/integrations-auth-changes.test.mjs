// The reader of Auth's change feed (scripts/integrations/auth-changes.mjs), with an in-memory cursor and feed: no
// database needed.
import assert from "node:assert/strict";
import test from "node:test";
import { ManageError } from "../scripts/integrations/auth-manage.mjs";
import { AUTH_CHANGES, createAuthChanges } from "../scripts/integrations/auth-changes.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 3600000;
const RECOVERED = "Auth change feed read again.";
const CURSOR_AHEAD = "Auth change feed cursor is ahead of Auth (restored from a backup?): reading the feed again from the start.";
// The Portal's saved cursor; `fail` makes reading it throw.
function memoryCursor(cursor = null) {
  const repository = {
    cursor,
    saved: [],
    fail: null,
    async authChangeCursor() { if (repository.fail) throw repository.fail; return repository.cursor; },
    async saveAuthChangeCursor(next) { repository.cursor = next; repository.saved.push(next); }
  };
  return repository;
}
// Auth's feed with `count` entries c1, c2, …; each read is recorded with its cursor and start time. `hold` makes
// reads wait until it resolves; `fail` makes them throw. A cursor it never handed out is beyond its newest change, as
// after Auth was restored from a backup: 409 cursor_ahead.
function feedOf(count) {
  const entry = (n) => ({ cursor: "c" + n, kind: "paused", clientId: "i-" + n });
  const manage = {
    entries: Array.from({ length: count }, (_, index) => entry(index + 1)),
    reads: [],
    hold: null,
    fail: null,
    add() { manage.entries.push(entry(manage.entries.length + 1)); },
    async integrationChanges({ after, limit }) {
      manage.reads.push({ after: after ?? null, at: Date.now() });
      if (manage.hold) await manage.hold;
      if (manage.fail) throw manage.fail;
      const place = manage.entries.findIndex((item) => item.cursor === after);
      if (after !== undefined && place < 0) throw new ManageError(409, "cursor_ahead");
      const changes = manage.entries.slice(place + 1, place + 1 + limit);
      return { changes, nextCursor: changes.length ? changes.at(-1).cursor : after ?? null };
    }
  };
  return manage;
}
const QUICK = { pollMs: 3600000, minGapMs: 20, pageSize: 2, pagesPerPull: 3 };
function reader(t, { manage, repository = memoryCursor(), apply, log = () => {}, settings = {}, now }) {
  const applied = [];
  const feed = createAuthChanges({
    repository, manage, log, settings: { ...QUICK, ...settings }, apply: apply ?? (async (change) => { applied.push(change.cursor); }),
    ...(now ? { now } : {})
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
  await sleep(10);
  assert.equal(manage.reads.length, 1, "the first read is in flight");
  for (let index = 0; index < 20; index += 1) feed.request();
  await sleep(10);
  assert.equal(manage.reads.length, 1, "nothing more while it runs");
  manage.hold = null;
  release();
  await feed.idle();
  assert.equal(manage.reads.length, 2, "twenty requests during the read made one more");
  assert.ok(manage.reads[1].at - manage.reads[0].at >= 55, "spaced by minGapMs");
  for (let index = 0; index < 20; index += 1) feed.request();
  await feed.idle();
  assert.equal(manage.reads.length, 3, "a burst after it makes one read");
  assert.ok(manage.reads[2].at - manage.reads[1].at >= 55);
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
  const logs = [];
  const { feed, applied, repository } = reader(t, { manage, log: (line) => logs.push(line), settings: { pollMs: 25, pageSize: 10 } });
  feed.start();
  await sleep(120);
  assert.ok(manage.reads.length >= 3, "the poll kept trying");
  assert.deepEqual(logs, ["Auth change feed read failed: unavailable."]);
  assert.deepEqual([applied, repository.saved], [[], []]);
  manage.fail = null;
  await sleep(60);
  await feed.idle();
  assert.deepEqual(applied, ["c1", "c2"]);
  assert.deepEqual(logs, ["Auth change feed read failed: unavailable.", RECOVERED], "the end of the failure is logged once");
  manage.fail = new ManageError(404, "not_found");
  await sleep(60);
  manage.fail = null;
  repository.fail = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
  await sleep(60);
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
