// Reads Auth's change feed (GET /manage/v1/integration-changes; Agora.Build integrations design §3.3.4, "Owner
// decisions after the Auth review", D26): every change to an integration's access, whoever made it, oldest first.
// Right after a change the Portal did not make, Auth nudges it (POST /auth/integration-changes, scripts/serve.mjs);
// the Portal also reads every 30 seconds in case a nudge is lost, the push-plus-poll pattern the Stations use with the
// Portal's own feed. Each change goes to `apply` (service.applyAuthChange, which records it once and tells the
// Station). Auth's cursor is saved in the Portal database after each page, so a restart continues where it stopped.
//
// One read at a time. A request while one runs asks for exactly one more after it (the running read may have passed
// before the newer change committed); requests meanwhile collapse into that one, and reads start at least minGapMs
// apart, so a burst of nudges, forged or not, costs at most one read a second. A read takes up to pagesPerPull pages
// of pageSize; when every page was full it asks for another.
//
// Nothing here throws, and no failure stops the reader: the cursor stays where it was and the next poll tries again,
// however long it lasts (a 400, 401 or 403 from Auth; a 404, which means this Auth has no feed yet because the Portal
// was deployed first; the Portal database). A failure is logged when it starts, then at most once an hour while it
// lasts, and its end once. A cursor ahead of Auth's feed (409 cursor_ahead: Auth was restored from a backup) is
// forgotten with a warning and the feed read again from the start in the same read: applying is idempotent.
//
// Account availability (D29) depends on the feed being read in order, to its end. The reader says so through hooks, all
// optional: `startingOver` when a read begins from Auth's first entry (no saved cursor: a first start or a reset, the
// cursor was just forgotten because Auth's is behind it, or an older image moved it, below), and `caughtUp` when a read
// ends with nothing more waiting, that is, its last page was not full. A read that stops for pagesPerPull pages, for
// stop() or for a failure says neither. Each start-over raises an epoch (repository.authChangePlace, read with the
// cursor). A read pass begins in the epoch of its saved cursor, or in the one its start-over made, and hands that pass,
// { epoch }, to `apply` with every change and to `caughtUp`; the service refuses an account-level change from a pass
// whose epoch is no longer current (stale_pass), and the pass saves its cursor only while its epoch is current
// (moveAuthChangeCursor). Either way it stops there with the superseded line, which is no failure, and the next read
// goes on from the saved cursor in the new epoch. So no pass in flight when another replica started over can apply or
// skip anything on the new epoch's behalf.
//
// The guard against an older image. A Portal image from before migration 006 saves the cursor alone, and moves it past
// account-level entries without applying them. This one writes a copy with it, so a saved cursor that differs from its
// copy (`foreign`) was moved by such an image. A read that finds one asks `foreignCursor` what to do: true (the setting
// on) starts the read over, logged with OLDER_IMAGE; false (off: the service has moved to waiting) reads on from it.
import { ManageError } from "./auth-manage.mjs";

export const AUTH_CHANGES = Object.freeze({ pollMs: 30000, minGapMs: 1000, pageSize: 100, pagesPerPull: 10 });
// A failure that lasts is logged again this long after it last was.
const REPORT_AGAIN_MS = 3600000;

// A change `apply` refused (a database failure, or a stale pass): the read stops before its page's cursor is saved.
class NotApplied extends Error {
  constructor(cause) {
    super("Auth change not applied", { cause });
  }
}
// A page's cursor not saved because another replica started the feed over since this pass began (D29).
const stalePass = () => new NotApplied(Object.assign(new Error("The read pass's epoch is no longer current."), { code: "stale_pass" }));
const codeOf = (error) => error?.code || "error";
// A pass a start-over superseded (D29) is expected after a reset, so it is no failure: its own line, said each time, and
// nothing is said when the next read works.
const superseded = (error) => error instanceof NotApplied && codeOf(error.cause) === "stale_pass";
const SUPERSEDED = "Auth change pass superseded by a reset: read again.";
const OLDER_IMAGE = "Auth change feed cursor was moved by an older Portal image: account availability rebuilds.";
// The fixed message for what stopped a read: a reason code, never a cursor or a reason.
function failure(error) {
  if (error instanceof NotApplied) return "Auth change not applied: " + codeOf(error.cause) + ".";
  if (error instanceof ManageError) return (error.status === 404 ? "Auth change feed not available yet: " : "Auth change feed read failed: ") + error.code + ".";
  return "Auth change feed failed: " + codeOf(error) + ".";
}
const cursorAhead = (error) => error instanceof ManageError && error.status === 409 && error.code === "cursor_ahead";

export function createAuthChanges({
  repository, manage, apply, startingOver = async () => {}, caughtUp = async () => {}, foreignCursor = async () => false,
  log = () => {}, settings = AUTH_CHANGES, now = Date.now
}) {
  const { pollMs, minGapMs, pageSize, pagesPerPull } = { ...AUTH_CHANGES, ...settings };
  let started = false;
  let running = null;
  let again = false;
  // The next read: when, and whether a request asked for it (soon) or it is the poll.
  let timer = null;
  let lastStart = -Infinity;
  // The failures logged since the last read that worked, each with when it was last logged.
  const failing = new Map();

  function report(message) {
    const last = failing.get(message);
    if (last !== undefined && now() - last < REPORT_AGAIN_MS) return;
    failing.set(message, now());
    log(message);
  }

  function recovered() {
    if (!failing.size) return;
    failing.clear();
    log("Auth change feed read again.");
  }

  // A requested read waits at most minGapMs and the poll at most pollMs, so a wall clock stepped back (which puts the
  // last read in the "future") never holds reads back by the size of the step.
  function schedule(at, soon) {
    if (timer) clearTimeout(timer.handle);
    const delay = Math.min(Math.max(0, at - now()), soon ? minGapMs : pollMs);
    const handle = setTimeout(run, delay);
    handle.unref?.();
    timer = { handle, at: now() + delay, soon };
  }

  function request() {
    if (!started) return;
    if (running) {
      again = true;
      return;
    }
    const at = Math.max(now(), lastStart + minGapMs);
    if (timer && timer.at <= at) return;
    schedule(at, true);
  }

  // One read: pages from the saved cursor until a short page, or pagesPerPull of them. Returns whether more may wait;
  // throws what stopped it. After stop() it returns before the next page: the cursor of every page applied is saved.
  async function read() {
    let { cursor, epoch, foreign } = await repository.authChangePlace();
    // The pass this read is: the epoch it began in, which a start-over replaces with the one it made.
    const beginAgain = async () => {
      await startingOver();
      return { epoch: (await repository.authChangePlace()).epoch };
    };
    let pass;
    if (foreign && (await foreignCursor())) {
      log(OLDER_IMAGE);
      cursor = null;
      pass = await beginAgain();
    } else pass = cursor === null ? await beginAgain() : { epoch };
    let reset = false;
    let pages = 0;
    while (pages < pagesPerPull) {
      if (!started) return false;
      let page;
      try {
        page = await manage.integrationChanges({ after: cursor ?? undefined, limit: pageSize });
      } catch (error) {
        // Once per read, so an Auth that answers it even from the start cannot keep this read going.
        if (!cursorAhead(error) || cursor === null || reset) throw error;
        log("Auth change feed cursor is ahead of Auth (restored from a backup?): reading the feed again from the start.");
        await repository.saveAuthChangeCursor(null);
        cursor = null;
        reset = true;
        pass = await beginAgain();
        continue;
      }
      pages += 1;
      const { changes, nextCursor } = page;
      // Changes always move the cursor; a page of them that did not would be read again and again.
      if (changes.length && (nextCursor === null || nextCursor === cursor)) throw new ManageError(200, "bad_response");
      for (const change of changes) {
        try {
          await apply(change, pass);
        } catch (error) {
          throw new NotApplied(error);
        }
      }
      // Saved only once the whole page is applied: a failure or a crash before reads the page again. Only the epoch is
      // compared, so two Portal replicas in one epoch may save their cursors out of order and move it back; that is
      // harmless because applying is idempotent (repository.authChangeApplied): the worst case is reading a page again.
      if (nextCursor !== null && nextCursor !== cursor) {
        if (!(await repository.moveAuthChangeCursor(nextCursor, pass.epoch))) throw stalePass();
        cursor = nextCursor;
      }
      if (changes.length < pageSize) {
        await caughtUp(pass);
        return false;
      }
    }
    return true;
  }

  function run() {
    timer = null;
    again = false;
    lastStart = now();
    running = (async () => {
      let more = false;
      try {
        more = await read();
        recovered();
      } catch (error) {
        if (superseded(error)) log(SUPERSEDED);
        else report(failure(error));
      }
      running = null;
      if (!started) return;
      if (more || again) request();
      else schedule(now() + pollMs, false);
    })();
  }

  return {
    // Reads at once, then as above.
    start() {
      if (started) return;
      started = true;
      request();
    },
    // Asks for a read soon (Auth's nudge; a resume answered admin_paused). Nothing before start() or after stop().
    request,
    // No more reads; resolves once the one in flight, if any, has finished.
    stop() {
      started = false;
      if (timer) clearTimeout(timer.handle);
      timer = null;
      return running ?? Promise.resolve();
    },
    // For tests: resolves once no read is in flight or asked for (only the poll may be waiting).
    async idle() {
      for (;;) {
        if (running) await running;
        else if (timer?.soon) await new Promise((resolve) => setTimeout(resolve, Math.max(0, timer.at - now()) + 5));
        else return;
      }
    }
  };
}
