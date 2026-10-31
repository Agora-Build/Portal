// Business flows for Stations and integrations. Auth is called first and Portal writes its rows only after Auth answers
// success; every Auth change names the signed-in account as `actor`. Rows are never deleted (D19).
import { randomBytes, randomUUID } from "node:crypto";
import { TokenError } from "../idp.mjs";
import { builtInIntegrationLimit } from "../plans.mjs";
import { ACCOUNT_ID, AppError } from "../store.mjs";
import { ManageError } from "./auth-manage.mjs";
import { checkProof, createStationFetch, ProofError, stationOrigin, WELL_KNOWN_PATH } from "./proof.mjs";
import { AUTH_CURSOR } from "./repository.mjs";
import { effectiveState, REPORT_STATES, transition } from "./states.mjs";

const CHALLENGE_LIFETIME = 600000;
const CHALLENGES_PER_HOUR = 10;
const REPORT_KEY_MAX = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const SCOPES = ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal"];
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];
const R9_SVC = /^[0-9a-f]{64}$/;
// Control characters, and the bidirectional marks and overrides that could make a name read differently.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const STOPPED = ["revoking", "revoked"];
const REPORT_FIELDS = ["integrationId", "state", "reason"];
const PRINTABLE_REASON = /^[^\p{Cc}]{1,200}$/u;
const CURSOR = /^\d{1,15}$/;
const FEED_LIMIT = 500;
const CHANGES_PATH = "/agora-build/v1/changes";

const failure = (status, message, code, extra = {}) => new AppError(status, message, { code, ...extra });
const notFound = () => failure(404, "This Station or integration was not found.", "not_found");
const ownerOnly = () => failure(403, "Only the Station owner can do this.", "forbidden");
const unknownStation = () => failure(403, "This Station is not registered.", "station");
const expiredChallenge = () => failure(400, "This check has expired or was already used. Start again.", "challenge");
const SYSTEM = "system";
const BUILT_IN_FIXED = "The built-in Station is always there: it can't be removed, shared or left.";
const BUILT_IN_ORIGIN = "This is the built-in Station. Every account already has it.";
const NOT_SUPPORTED = "Integrations aren't available on the built-in Station yet.";
// Who paused a paused integration, as Auth records it (Auth D26 R27): its owner, its custom Station's owner, or an
// Agora.Build admin, whose pause only an admin lifts, on the admin site.
const PAUSED_BY = ["owner", "station", "admin"];
const ADMIN_PAUSED = "Agora.Build paused this integration. Only Agora.Build can resume it.";
const OWNER_DISABLED = "Agora.Build disabled this integration's owner account. It resumes when the account is enabled again.";
const adminPaused = () => failure(409, ADMIN_PAUSED, "admin_paused");
const ownerDisabled = () => failure(409, OWNER_DISABLED, "owner_disabled");
// Auth's change feed (Auth D26 R25): the kinds of entry and those about an owner's account (its cursor's shape is
// AUTH_CURSOR, shared with the repository).
const AUTH_KINDS = ["paused", "resumed", "revoked", "owner_disabled", "owner_enabled"];
const OWNER_KINDS = ["owner_disabled", "owner_enabled"];
const AUTH_REASON_MAX = 500;
// How the Station's feed and an integration's history name a change an Agora.Build admin made (spec §3.3.4): the admin
// and the reason they gave stay in the Portal's event (actor, reason) and in Auth's audit.
const AGORA_BUILD = "agora_build";

const MANAGE_CONFLICTS = {
  origin_taken: "This Station is already registered.",
  revoked: "This integration has been revoked.",
  duplicate_key: "This key is already registered.",
  built_in: BUILT_IN_FIXED,
  not_supported: NOT_SUPPORTED,
  admin_paused: ADMIN_PAUSED,
  owner_disabled: OWNER_DISABLED
};

// Turns Auth's management answer into the Portal's error; anything that is not a ManageError is rethrown unchanged.
export function fromManage(error) {
  if (!(error instanceof ManageError)) throw error;
  if (error.status === 400) return failure(400, "Auth refused this request.", error.code);
  if (error.status === 403) return ownerOnly();
  if (error.status === 404) return failure(404, "This Station or integration was not found.", "not_found");
  if (error.status === 409) return failure(409, MANAGE_CONFLICTS[error.code] || "Auth refused this request.", error.code);
  return failure(503, "Auth is unavailable. Try again shortly.", "unavailable");
}

async function viaAuth(call) {
  try {
    return await call();
  } catch (error) {
    throw fromManage(error);
  }
}

// Members are not shown the Station's report client; it is not secret, but they have no use for it. Nobody is shown a
// built-in Station's report client (its role is built_in).
function stationView(station, role) {
  const view = {
    id: station.id, origin: station.origin, role, ownerAccount: station.ownerAccount, status: station.status, createdAt: station.createdAt,
    builtIn: station.builtIn, name: station.name, integrationsEnabled: station.integrationsEnabled
  };
  if (role === "owner") view.reportClientId = station.reportClientId;
  return view;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function memberAccount(value) {
  if (typeof value !== "string" || !ACCOUNT_ID.test(value)) throw failure(400, "Enter an Agora Build account ID (ab…).", "account");
  return value;
}

function integrationName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  // Counted in UTF-16 units, as Auth counts it.
  if (!name || name.length > 80 || CONTROL.test(name)) throw failure(400, "Name the integration in 1 to 80 characters, without control characters.", "name");
  return name;
}

// Unique scopes from SCOPES; agent.view is always granted, so it is added when missing.
function integrationScopes(value) {
  if (!Array.isArray(value) || value.some((scope) => !SCOPES.includes(scope)) || new Set(value).size !== value.length) {
    throw failure(400, "Choose scopes from " + SCOPES.join(", ") + ", each at most once.", "scopes");
  }
  return value.includes("agent.view") ? [...value] : ["agent.view", ...value];
}

function wholeNumber(value, min, max, message, code) {
  if (!Number.isInteger(value) || value < min || value > max) throw failure(400, message, code);
  return value;
}

const expiryDays = (value) => wholeNumber(value, 1, 90, "Choose an expiry of 1 to 90 days.", "expiry");
const quota = (value) => wholeNumber(value, 1, 10000, "Choose a quota of 1 to 10000 token requests per second.", "quota");

// Auth checks that the key is usable; Portal only refuses what is not a JWK object or carries private members.
function publicKey(value) {
  if (!plainObject(value)) throw failure(400, "Send the public key as a JSON Web Key object.", "jwk");
  if (PRIVATE_MEMBERS.some((member) => Object.hasOwn(value, member))) throw failure(400, "Send only the public key.", "private_key");
  return value;
}

function notRevoked(row) {
  if (STOPPED.includes(row.state)) throw failure(409, MANAGE_CONFLICTS.revoked, "revoked");
}

// transition, except that resuming a paused row with no recorded prior state goes back to where approval left it.
function step(row, event, at) {
  if (event === "resume" && row.state === "paused" && row.resumeState == null) {
    return transition({ ...row, resumeState: row.approvedAt ? "provisioning" : "awaiting_approval" }, event, at);
  }
  return transition(row, event, at);
}

function reportReason(value) {
  if (typeof value !== "string" || !PRINTABLE_REASON.test(value)) throw failure(400, "Give the reason in 1 to 200 characters, without control characters.", "reason");
  return value;
}

// A report's body: only integrationId, state and reason; `error` needs a reason, any other report may carry one.
function reportBody(body) {
  if (!plainObject(body) || Object.keys(body).some((key) => !REPORT_FIELDS.includes(key))) {
    throw failure(400, "Send a report as { integrationId, state, reason }.", "report");
  }
  const { integrationId, state, reason } = body;
  if (state !== "error" && !REPORT_STATES.includes(state)) throw failure(400, "Report a state of " + [...REPORT_STATES, "error"].join(", ") + ".", "state");
  if (state === "error" || reason !== undefined) reportReason(reason);
  return { integrationId, state, reason: reason ?? null };
}

function feedCursor(value) {
  const cursor = typeof value === "string" && CURSOR.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw failure(400, "Send the cursor as a whole number of at least 0.", "cursor");
  return cursor;
}

// What a Station needs to act on an integration; the state is the effective one, so it may be "expired". ownerAccount
// lets the Station bind an integration to its owner before approval, when the integration itself has no token yet.
function feedIntegration(row, at) {
  return { ownerAccount: row.ownerAccount, state: effectiveState(row, at), scopes: row.scopes, r9Svc: row.r9Svc, expiresAt: row.expiresAt, quotaPerSecond: row.quotaPerSecond };
}

// Who stopped a paused integration, for the page: Auth's pausedBy while the row is paused, and "admin" while Agora.Build
// has its owner's account disabled (Auth then issues it no token, and the Station sees it paused). null otherwise.
function pausedByOf(row, state) {
  if (state !== "paused") return null;
  if (row.ownerDisabledAt != null) return "admin";
  return row.state === "paused" && PAUSED_BY.includes(row.pausedBy) ? row.pausedBy : null;
}

// What an entry of Auth's change feed does to the Portal's row: the event kind and the fields to write. Auth is
// authoritative, so following it is not held back by expiry: transitions are checked at time 0, as in reconcile. A
// stopped integration is revoked at Auth, which changes it no more, so an entry about it is older than that and is
// only recorded (Ruling R-A): it is not paused, resumed, disabled or enabled again. An owner's account being disabled
// is its own flag, not a pause of the row (effectiveState shows it as paused), so enabling it restores each
// integration as it was.
function authEffect(row, entry, at) {
  const stopped = STOPPED.includes(row.state);
  if (entry.kind === "revoked") return { kind: "integration_revoked", fields: stopped ? {} : { ...step(row, "revoke", 0), pausedBy: null } };
  if (stopped) return { kind: "integration_" + entry.kind, fields: {} };
  if (entry.kind === "paused") {
    const pausedBy = PAUSED_BY.includes(entry.pausedBy) ? entry.pausedBy : null;
    if (row.state !== "paused") return { kind: "integration_paused", fields: { ...step(row, "pause", 0), pausedBy } };
    return { kind: "integration_paused", fields: row.pausedBy === pausedBy ? {} : { pausedBy } };
  }
  if (entry.kind === "resumed") return { kind: "integration_resumed", fields: row.state === "paused" ? { ...step(row, "resume", 0), pausedBy: null } : {} };
  if (entry.kind === "owner_disabled") {
    const when = Date.parse(entry.at);
    return { kind: "integration_owner_disabled", fields: row.ownerDisabledAt ? {} : { ownerDisabledAt: Number.isFinite(when) ? when : at } };
  }
  return { kind: "integration_owner_enabled", fields: row.ownerDisabledAt ? { ownerDisabledAt: null } : {} };
}

// authChanged() asks the stack to read Auth's change feed soon (Auth refused a resume as admin_paused).
export function createIntegrationService({
  repository, db, manage, stationFetch, exchange, now = Date.now, log = () => {}, ids = randomUUID,
  challengeValue = () => randomBytes(32).toString("base64url"), pushFetch = createStationFetch({ timeoutMs: 3000 }), notify, authChanged = () => {}
}) {
  // Every transaction here appends events, so each takes the event lock before any row lock (see lockEvents).
  const appending = (work) => db.transaction(async (client) => {
    await repository.lockEvents(client);
    return work(client);
  });

  // Per Station: the push in flight and whether another change arrived while it ran.
  const pushes = new Map();

  // Per account and built-in Station: the creation or renewal in flight, so the next one waits for
  // its count (plan limits).
  const creations = new Map();
  function oneAtATime(key, work) {
    const run = (creations.get(key) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    creations.set(key, settled);
    settled.then(() => { if (creations.get(key) === settled) creations.delete(key); });
    return run;
  }

  // Refuses at the plan limit, counting the account's live integrations on a built-in Station. Call it inside
  // oneAtATime for that account and Station.
  async function underPlanLimit(accountId, stationId, plan) {
    const limit = builtInIntegrationLimit(plan);
    if (limit !== null && await repository.countLiveIntegrations(stationId, accountId, now()) >= limit) {
      throw failure(403, "Your plan allows " + limit + " integrations on the built-in Station. Revoke one, upgrade, or use your own Station.", "plan_limit", { limit });
    }
  }

  // Nudges the Station to read its change feed. The nudge carries no authority, only the latest cursor; the Station
  // learns what changed by polling with its own token. At most one push per Station is in flight; calls meanwhile
  // collapse into one more push, sent once it ends with the then-latest cursor. Never throws; failures are logged.
  function push(stationId) {
    const running = pushes.get(stationId);
    if (running) {
      running.pending = true;
      return;
    }
    const entry = { pending: false, done: null };
    pushes.set(stationId, entry);
    entry.done = (async () => {
      try {
        do {
          entry.pending = false;
          await pushOnce(stationId);
        } while (entry.pending);
      } finally {
        pushes.delete(stationId);
      }
    })();
  }

  async function pushOnce(stationId) {
    try {
      // A removed Station is still pushed to once, so it learns to stop.
      const station = await repository.station(stationId);
      if (!station) return;
      const cursor = await repository.latestCursor(stationId);
      const reply = await pushFetch.post(station.origin + CHANGES_PATH, { cursor });
      if (reply.status < 200 || reply.status > 299) log("Station change push failed: status_" + reply.status + ".");
    } catch (error) {
      log("Station change push failed: " + (error instanceof ProofError ? error.reason : "error") + ".");
    }
  }

  async function reportingStation(clientId) {
    const station = typeof clientId === "string" && clientId ? await repository.stationByReportClient(clientId) : null;
    if (!station) throw unknownStation();
    return station;
  }

  // Tells the Station about a committed change; a failed nudge never fails the change itself.
  function changed(stationId) {
    try {
      const result = (notify ?? push)(stationId);
      if (typeof result?.catch === "function") result.catch(() => log("Station notify failed."));
    } catch {
      log("Station notify failed.");
    }
  }

  // For the event of a pause, resume or revocation the Portal saw at Auth (its own call's answer, or an owner's
  // listing): when it saw it, on the Portal's clock, which is no earlier than Auth made it (Ruling R-A).
  const seen = () => ({ seenAt: new Date(now()).toISOString() });

  // A management call naming accountId as actor. Auth refuses one whose actor is disabled (400 invalid_request), so a
  // call it accepts proves the account enabled (Ruling R-D): an owner-disabled flag the account's integrations already
  // had before the call is stale (its owner_enabled was missed, or not read yet) and is cleared, and the Station told.
  // A flag the feed set or changed while the call ran may be a newer disable, so it stays.
  async function byActor(accountId, call) {
    const flagged = await repository.ownerDisabledIntegrations(accountId);
    const answer = await viaAuth(call);
    if (flagged.length) {
      try {
        await ownerEnabled(flagged);
      } catch {
        log("Owner-disabled flag not cleared: error.");
      }
    }
    return answer;
  }

  async function ownerEnabled(flagged) {
    const stations = new Set();
    for (const { id, ownerDisabledAt } of flagged) {
      const stationId = await appending(async (client) => {
        const row = await repository.integrationForUpdate(id, client);
        if (!row || row.ownerDisabledAt !== ownerDisabledAt || STOPPED.includes(row.state)) return null;
        await repository.updateIntegration(id, { ownerDisabledAt: null }, client);
        await repository.appendEvent({ stationId: row.stationId, integrationId: id, accountId: row.ownerAccount, actor: SYSTEM, kind: "integration_owner_enabled", state: row.state, reason: "reconciled" }, client);
        return row.stationId;
      });
      if (stationId) stations.add(stationId);
    }
    if (!stations.size) return;
    log("Owner-disabled flag cleared: Auth accepted a call by the owner.");
    for (const stationId of stations) changed(stationId);
  }

  // Revokes, inside the caller's transaction, each integration `pick` selects on the Station; already revoking or
  // revoked ones are left as they are. `direct` sets revoked at once (Auth has already removed the Station). Returns
  // how many it revoked.
  async function revokeOn(client, stationId, pick, { actor, reason, direct = false }) {
    const at = now();
    let revoked = 0;
    for (const listed of await repository.integrationsOnStation(stationId, client)) {
      if (!pick(listed) || listed.state === "revoking" || listed.state === "revoked") continue;
      const row = await repository.integrationForUpdate(listed.id, client);
      if (row.state === "revoking" || row.state === "revoked") continue;
      // A revoked integration is no longer paused by anyone.
      const next = { ...(direct ? { state: "revoked", resumeState: null } : transition(row, "revoke", at)), pausedBy: null };
      await repository.updateIntegration(row.id, next, client);
      await repository.appendEvent({ stationId, integrationId: row.id, accountId: row.ownerAccount, actor, kind: "integration_revoked", state: next.state, reason }, client);
      revoked += 1;
    }
    return revoked;
  }

  // Inside the caller's transaction, retires an active Portal Station at `origin` other than `id`: Auth has given the
  // origin to `id`, so the old Station is gone there, with its integrations. Returns the retired Station's ID or null.
  async function retireStale(client, origin, id) {
    const stale = await repository.activeStationAt(origin, client);
    if (!stale || stale.id === id) return null;
    await repository.markStationRemoved(stale.id, now(), client);
    await revokeOn(client, stale.id, () => true, { actor: "system", reason: "reconciled", direct: true });
    await repository.appendEvent({ stationId: stale.id, accountId: stale.ownerAccount ?? SYSTEM, actor: SYSTEM, kind: "station_removed", reason: "reconciled" }, client);
    return stale.id;
  }

  function retired(stationId) {
    if (!stationId) return;
    log("Station removed in Portal: its origin belongs to another Station at Auth.");
    changed(stationId);
  }

  // The active Station as this account has it in Portal (with its role, "built_in", "owner" or "member"). An account
  // that neither owns a custom Station nor is a current member gets the same 404 as for an unknown ID, before Auth is
  // asked, so nothing about the Station is revealed (as for integrations, Ruling T7-8). Every account has the built-in.
  async function usable(accountId, stationId) {
    const station = typeof stationId === "string" && stationId ? (await repository.stationsFor(accountId)).find((entry) => entry.id === stationId) : null;
    if (!station) throw notFound();
    return station;
  }

  // Remove, share, leave and the member list don't exist for a built-in Station; refused here as Auth refuses them
  // (409 built_in), without asking Auth.
  function notBuiltIn(station) {
    if (station.builtIn) throw failure(409, BUILT_IN_FIXED, "built_in");
    return station;
  }

  // Auth answers 409 origin_taken for a built-in Station's origin; Portal says so before a check is issued or fetched.
  async function notBuiltInOrigin(origin) {
    if ((await repository.builtInStations()).some((station) => station.origin === origin)) throw failure(409, BUILT_IN_ORIGIN, "origin_taken");
  }

  // For changes only the Station's owner may make; a member sees the Station, so it is told why.
  async function ownStation(accountId, stationId) {
    const station = notBuiltIn(await usable(accountId, stationId));
    if (station.role !== "owner") throw ownerOnly();
    return station;
  }

  // Brings Portal's rows in line with Auth's list for this account; Auth is authoritative. Removals run first, so a
  // Station Auth has replaced at the same origin is retired before its successor is added.
  async function reconcile(accountId, listed) {
    const known = new Set(listed.map((station) => station.id));
    for (const station of await repository.stationsFor(accountId)) {
      // A built-in Station is every account's: a listing without it never removes it or revokes anything (D24).
      if (station.builtIn) {
        if (!known.has(station.id)) log("Built-in Station absent from Auth's listing: left as it is.");
        continue;
      }
      if (known.has(station.id)) continue;
      if (station.role === "owner") {
        await appending(async (client) => {
          await repository.markStationRemoved(station.id, now(), client);
          await revokeOn(client, station.id, () => true, { actor: "system", reason: "reconciled", direct: true });
          await repository.appendEvent({ stationId: station.id, accountId, actor: "system", kind: "station_removed", reason: "reconciled" }, client);
        });
        log("Station removed in Portal: absent from Auth.");
        changed(station.id);
        continue;
      }
      // Auth no longer counts this account a member (and has revoked its integrations there); Portal follows.
      const removed = await appending(async (client) => {
        if (!(await repository.removeMember(station.id, accountId, "system", now(), client))) return false;
        await revokeOn(client, station.id, (row) => row.ownerAccount === accountId, { actor: "system", reason: "member_removed" });
        await repository.appendEvent({ stationId: station.id, accountId, actor: "system", kind: "member_removed", reason: "reconciled" }, client);
        return true;
      });
      if (removed) {
        log("Station member removed in Portal: absent from Auth.");
        changed(station.id);
      }
    }
    for (const entry of listed) {
      if (entry.builtIn) {
        await reconcileBuiltIn(entry);
        continue;
      }
      const existing = await repository.station(entry.id);
      // A built-in Station is only ever reconciled as one: it never gains an owner or members here.
      if (existing?.builtIn) {
        log("Built-in Station listed by Auth as a custom Station: left as it is.");
        continue;
      }
      // Auth still lists a Station Portal has removed (its integrations already revoked here); restoring it is left to
      // an operator, so it is logged.
      if (existing?.status === "removed") log("Station listed by Auth is removed in Portal: not restored.");
      if (!existing) {
        // The insert's own answer gates the event, so concurrent listings record the Station once.
        const { added, stale } = await appending(async (client) => {
          const stale = await retireStale(client, entry.origin, entry.id);
          if (!(await repository.insertStation({ id: entry.id, origin: entry.origin, ownerAccount: entry.owner, reportClientId: entry.reportClientId, verifiedAt: entry.createdAt }, client))) return { added: false, stale };
          await repository.appendEvent({ stationId: entry.id, accountId: entry.owner, actor: "system", kind: "station_reconciled" }, client);
          return { added: true, stale };
        });
        retired(stale);
        if (added) {
          log("Station reconciled from Auth: missing in Portal.");
          changed(entry.id);
        }
      }
      if (entry.owner !== accountId && !(await repository.currentMembers(entry.id)).some((member) => member.accountId === accountId)) {
        const added = await appending(async (client) => {
          if (!(await repository.addMember(entry.id, accountId, "system", now(), client))) return false;
          await repository.appendEvent({ stationId: entry.id, accountId, actor: "system", kind: "member_added", reason: "reconciled" }, client);
          return true;
        });
        if (added) {
          log("Station member reconciled from Auth: missing in Portal.");
          changed(entry.id);
        }
      }
    }
  }

  // Inserts a built-in Station Auth lists (no owner, no members) or follows its name and integrations setting. A new
  // Station at the origin of an older one retires the older one, as for custom Stations.
  async function reconcileBuiltIn(entry) {
    const existing = await repository.station(entry.id);
    if (existing?.status === "removed") {
      log("Built-in Station listed by Auth is removed in Portal: not restored.");
      return;
    }
    const settings = { name: entry.name, integrationsEnabled: entry.integrations === true };
    if (existing) {
      if (await repository.updateBuiltInStation(entry.id, settings)) log("Built-in Station settings followed from Auth.");
      return;
    }
    const { added, stale } = await appending(async (client) => {
      const stale = await retireStale(client, entry.origin, entry.id);
      if (!(await repository.insertStation({ id: entry.id, origin: entry.origin, reportClientId: entry.reportClientId, verifiedAt: entry.createdAt, builtIn: true, ...settings }, client))) return { added: false, stale };
      await repository.appendEvent({ stationId: entry.id, accountId: SYSTEM, actor: SYSTEM, kind: "station_reconciled", reason: "built_in" }, client);
      return { added: true, stale };
    });
    retired(stale);
    if (added) {
      log("Built-in Station added from Auth.");
      changed(entry.id);
    }
  }

  function integrationView(row, role, origin) {
    const state = effectiveState(row, now());
    return {
      id: row.id, kind: row.kind, name: row.name, stationId: row.stationId, stationOrigin: origin, scopes: row.scopes,
      state, pausedFrom: row.resumeState, pausedBy: pausedByOf(row, state), r9Svc: row.r9Svc, quotaPerSecond: row.quotaPerSecond,
      expiresAt: row.expiresAt, approvedAt: row.approvedAt, lastError: row.lastError, createdAt: row.createdAt, role
    };
  }

  async function viewOf(row, role) {
    return integrationView(row, role, (await repository.station(row.stationId))?.origin ?? null);
  }

  // The row and the account's part in it: "owner", "station_owner" (it owns the integration's custom Station) or null.
  // A built-in Station has no owner, so only the integration's owner finds it here: Agora.Build admins act on the
  // admin site through Auth, never through the Portal (spec §3.3.4, D26).
  async function access(accountId, id) {
    const row = typeof id === "string" && id ? await repository.integration(id) : null;
    if (!row) throw notFound();
    if (row.ownerAccount === accountId) return { row, role: "owner" };
    const station = await repository.station(row.stationId);
    return { row, role: station && !station.builtIn && station.ownerAccount === accountId ? "station_owner" : null };
  }

  // An account that neither owns the integration nor its Station gets the same 404 as for an unknown ID, before any
  // state check, so nothing about the integration is revealed.
  async function visible(accountId, id) {
    const found = await access(accountId, id);
    if (!found.role) throw notFound();
    return found;
  }

  // For changes only the integration's owner may make; a Station owner sees the integration, so it is told why.
  async function owned(accountId, id) {
    const { row, role } = await visible(accountId, id);
    if (role !== "owner") throw failure(403, "Only the integration's owner can do this.", "forbidden");
    return row;
  }

  // The Portal half of a change Auth has already made: under the row lock `apply` re-checks the current row and returns
  // `{ fields, event }` (or null for nothing to do). The Station is notified after commit unless `push` is false.
  async function commit(id, apply, { push = true } = {}) {
    const result = await appending(async (client) => {
      const current = await repository.integrationForUpdate(id, client);
      if (!current) throw notFound();
      const change = apply(current);
      if (!change) return { row: current, done: false };
      const { fields = {}, event } = change;
      if (Object.keys(fields).length) await repository.updateIntegration(id, fields, client);
      if (event) {
        await repository.appendEvent({ stationId: current.stationId, integrationId: id, accountId: current.ownerAccount, state: fields.state ?? current.state, ...event }, client);
      }
      return { row: await repository.integration(id, client), done: true };
    });
    if (result.done && push) changed(result.row.stationId);
    return result.row;
  }

  // pause and revoke: the integration's owner or its Station's owner; anyone else is told nothing about it. A pause
  // records who paused it as Auth answers (an admin's pause already there stays the admin's: Auth never lowers it), or
  // by role from an Auth without the admin pause lock. A revocation clears it.
  async function stop(accountId, id, event) {
    const { row, role } = await visible(accountId, id);
    step(row, event, now());
    if (event === "revoke" && STOPPED.includes(row.state)) return viewOf(row, role);
    const answer = await byActor(accountId, () => manage.changeIntegration(id, { status: event === "pause" ? "paused" : "revoked" }, accountId));
    const kind = event === "pause" ? "integration_paused" : "integration_revoked";
    const pausedBy = event !== "pause" ? null : PAUSED_BY.includes(answer?.pausedBy) ? answer.pausedBy : role === "owner" ? "owner" : "station";
    const updated = await commit(id, (current) => {
      if (event === "revoke" && STOPPED.includes(current.state)) return null;
      return { fields: { ...step(current, event, now()), pausedBy }, event: { actor: accountId, kind, reason: role, details: seen() } };
    });
    return viewOf(updated, role);
  }

  // What following Auth's entry changes on Portal's row: the fields to write, the status event ([transition, kind]) or
  // null, and the settings that changed. Auth is authoritative, so following it is not held back by expiry:
  // transitions are checked at time 0. Who paused it (pausedBy, from Auth's admin pause lock on) goes with a status
  // change, and on its own while both sides have it paused.
  function difference(row, entry) {
    const fields = {};
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() !== new Date(row.expiresAt).getTime()) fields.expiresAt = entry.expiresAt;
    if (entry.quotaPerSecond !== undefined && entry.quotaPerSecond !== row.quotaPerSecond) fields.quotaPerSecond = entry.quotaPerSecond;
    if ((entry.r9Svc ?? null) !== row.r9Svc) fields.r9Svc = entry.r9Svc ?? null;
    let event = null;
    if (entry.status === "revoked" && !STOPPED.includes(row.state)) event = ["revoke", "integration_revoked"];
    else if (entry.status === "paused" && row.state !== "paused" && !STOPPED.includes(row.state)) event = ["pause", "integration_paused"];
    else if (entry.status === "active" && row.state === "paused") event = ["resume", "integration_resumed"];
    const pausedBy = entry.status === "paused" && PAUSED_BY.includes(entry.pausedBy) ? entry.pausedBy : null;
    if (!event && row.state === "paused" && entry.status === "paused" && entry.pausedBy !== undefined && pausedBy !== row.pausedBy) fields.pausedBy = pausedBy;
    const settings = Object.keys(fields);
    if (event) Object.assign(fields, step(row, event[0], 0), { pausedBy: event[0] === "pause" ? pausedBy : null });
    return { fields, event, settings };
  }

  // Brings Portal's integrations in line with Auth's list of the account's own. Rows are compared first without a
  // lock, so a listing that changes nothing locks nothing. A change of settings alone (expiry, quota, R9 binding) is
  // recorded as integration_reconciled, so the Station's feed carries the new values.
  async function reconcileIntegrations(listed) {
    for (const entry of listed) {
      const id = entry.clientId;
      let touched = false;
      let row = await repository.integration(id);
      if (!row) {
        if (!(await repository.station(entry.stationId))) {
          log("Integration not reconciled: its Station is unknown to Portal.");
          continue;
        }
        if (!entry.expiresAt) log("Integration reconciled without an expiry at Auth: Portal shows its 30-day default.");
        touched = await appending(async (client) => {
          const expiresAt = entry.expiresAt ?? new Date(now() + 30 * DAY).toISOString();
          if (!(await repository.insertIntegration({ id, ownerAccount: entry.owner, stationId: entry.stationId, kind: "custom_app", name: entry.name, scopes: entry.scopes, quotaPerSecond: entry.quotaPerSecond ?? 200, expiresAt }, client))) return false;
          await repository.appendEvent({ stationId: entry.stationId, integrationId: id, accountId: entry.owner, actor: "system", kind: "integration_reconciled", state: "awaiting_approval" }, client);
          return true;
        });
        if (touched) log("Integration reconciled from Auth: missing in Portal.");
        row = await repository.integration(id);
        if (!row) continue;
      }
      const followed = Object.keys(difference(row, entry).fields).length > 0 && await appending(async (client) => {
        const current = await repository.integrationForUpdate(id, client);
        const { fields, event, settings } = difference(current, entry);
        if (!Object.keys(fields).length) return false;
        await repository.updateIntegration(id, fields, client);
        const recorded = { stationId: current.stationId, integrationId: id, accountId: current.ownerAccount, actor: "system", reason: "reconciled" };
        if (event) await repository.appendEvent({ ...recorded, kind: event[1], state: fields.state, details: seen() }, client);
        else {
          const details = { changed: settings, ...Object.fromEntries(settings.map((name) => [name, fields[name]])) };
          await repository.appendEvent({ ...recorded, kind: "integration_reconciled", state: current.state, details }, client);
        }
        return true;
      });
      if (followed) log("Integration reconciled from Auth: changed in Auth.");
      if (touched || followed) changed(entry.stationId);
    }
  }

  async function create(accountId, station, fields, publicJwk, expiresInDays) {
    const stationId = station.id;
    const expiresAt = new Date(now() + expiresInDays * DAY).toISOString();
    const created = await byActor(accountId, () => manage.createIntegration({ owner: accountId, stationId, ...fields, publicJwk, expiresAt, actor: accountId }));
    await appending(async (client) => {
      await repository.insertIntegration({ id: created.clientId, ownerAccount: accountId, stationId, kind: "custom_app", ...fields, expiresAt: created.expiresAt ?? expiresAt }, client);
      await repository.appendEvent({ stationId, integrationId: created.clientId, accountId, actor: accountId, kind: "integration_created", state: "awaiting_approval", details: { scopes: fields.scopes, name: fields.name } }, client);
    });
    changed(stationId);
    return integrationView(await repository.integration(created.clientId), "owner", station.origin);
  }

  return {
    async createChallenge(accountId, originInput) {
      const origin = stationOrigin(originInput);
      await notBuiltInOrigin(origin);
      // A soft limit: check, then insert, so concurrent requests may pass it by a few.
      const since = new Date(now() - 3600000);
      if (await repository.challengesSince(accountId, since) >= CHALLENGES_PER_HOUR) throw new AppError(429, "Too many Station checks. Try again later.");
      const challengeId = ids();
      const value = challengeValue();
      const expiresAt = new Date(now() + CHALLENGE_LIFETIME).toISOString();
      await repository.createChallenge({ id: challengeId, accountId, origin, value, expiresAt, createdAt: now() });
      return { challengeId, origin, value, url: origin + WELL_KNOWN_PATH, expiresAt };
    },

    async registerStation(accountId, { challengeId, reportKey } = {}) {
      // Auth validates the key itself; Portal only refuses what cannot be one, before the challenge is used.
      if (!plainObject(reportKey) || Buffer.byteLength(JSON.stringify(reportKey)) > REPORT_KEY_MAX) {
        throw failure(400, "Send the Station's report key as a JSON object of at most 4 KB.", "report_key");
      }
      if (typeof challengeId !== "string" || !UUID.test(challengeId)) throw expiredChallenge();
      const challenge = await repository.takeChallenge(challengeId, accountId, now());
      if (!challenge) throw expiredChallenge();
      const { origin, value } = challenge;
      await notBuiltInOrigin(origin);
      const proof = await checkProof(origin, value, { fetch: stationFetch });
      if (!proof.ok) {
        log("Station proof of control failed: " + proof.reason + ".");
        throw failure(422, "The Station did not serve the check value at " + origin + WELL_KNOWN_PATH + ".", "proof", { reason: proof.reason });
      }
      const registered = await byActor(accountId, () => manage.registerStation({ origin, owner: accountId, reportKey, actor: accountId }));
      const stale = await appending(async (client) => {
        const stale = await retireStale(client, origin, registered.id);
        await repository.insertStation({ id: registered.id, origin, ownerAccount: accountId, reportClientId: registered.reportClientId, verifiedAt: now() }, client);
        await repository.appendEvent({ stationId: registered.id, accountId, actor: accountId, kind: "station_registered" }, client);
        return stale;
      });
      retired(stale);
      return stationView(await repository.station(registered.id), "owner");
    },

    async stations(accountId) {
      let listed;
      try {
        listed = await manage.stations(accountId);
      } catch (error) {
        if (!(error instanceof ManageError) || fromManage(error).status !== 503) throw fromManage(error);
        log("Station list served from Portal: Auth " + error.code + ".");
      }
      if (listed) await reconcile(accountId, listed);
      const stations = (await repository.stationsFor(accountId)).map((station) => stationView(station, station.role));
      return { stations, stale: !listed };
    },

    async members(accountId, stationId) {
      notBuiltIn(await usable(accountId, stationId));
      const answer = await byActor(accountId, () => manage.members(stationId, accountId));
      return { owner: answer.owner, members: (answer.members || []).map(({ account, addedAt }) => ({ account, addedAt })) };
    },

    async share(accountId, stationId, member) {
      memberAccount(member);
      const station = await ownStation(accountId, stationId);
      if (member === station.ownerAccount) throw failure(400, "The owner already has this Station.", "account");
      await byActor(accountId, () => manage.addMember(stationId, member, accountId));
      const added = await appending(async (client) => {
        if (!(await repository.addMember(stationId, member, accountId, now(), client))) return false;
        await repository.appendEvent({ stationId, accountId: member, actor: accountId, kind: "member_added" }, client);
        return true;
      });
      if (added) changed(stationId);
    },

    // The owner removes anyone; a member removes only themself. Auth removes the member and revokes their integrations
    // on the Station; Portal follows in one transaction, recording the removal only when it had the member.
    async unshare(accountId, stationId, member) {
      memberAccount(member);
      const station = notBuiltIn(await usable(accountId, stationId));
      if (station.role !== "owner" && member !== accountId) throw ownerOnly();
      await byActor(accountId, () => manage.removeMember(stationId, member, accountId));
      const wrote = await appending(async (client) => {
        const removed = await repository.removeMember(stationId, member, accountId, now(), client);
        const revoked = await revokeOn(client, stationId, (row) => row.ownerAccount === member, { actor: accountId, reason: "member_removed" });
        if (removed) await repository.appendEvent({ stationId, accountId: member, actor: accountId, kind: "member_removed" }, client);
        return removed || revoked > 0;
      });
      if (wrote) changed(stationId);
    },

    async removeStation(accountId, stationId) {
      const station = await ownStation(accountId, stationId);
      await byActor(accountId, () => manage.removeStation(stationId, accountId));
      await appending(async (client) => {
        await repository.markStationRemoved(stationId, now(), client);
        await revokeOn(client, stationId, () => true, { actor: accountId, reason: "station_removed" });
        await repository.appendEvent({ stationId, accountId: station.ownerAccount, actor: accountId, kind: "station_removed" }, client);
      });
      changed(stationId);
    },

    // A 5-minute station.read token for the browser to send to a Station this account owns or belongs to.
    async readToken(accountId, idToken, stationId) {
      const station = await usable(accountId, stationId);
      if (!idToken) throw new AppError(401, "Sign in again to read this Station's details.");
      try {
        const { accessToken, expiresIn } = await exchange(idToken, station.origin);
        return { accessToken, expiresIn, origin: station.origin };
      } catch (error) {
        if (!(error instanceof TokenError)) throw error;
        log("Station read token refused: " + error.reason + ".");
        if (error.status === 503) throw failure(503, "Auth is unavailable. Try again shortly.", "unavailable");
        throw failure(403, "Auth did not allow reading this Station.", "exchange");
      }
    },

    // On a built-in Station: only while Agora.Build has integrations on there, and within the account's plan limit
    // (Basic 4, Premium 10, Principal and Fellow none). Custom Stations are never capped.
    async createIntegration(accountId, { stationId, name, scopes = [], publicJwk, quotaPerSecond = 200, expiresInDays = 30 } = {}, { plan = "basic" } = {}) {
      const fields = { name: integrationName(name), scopes: integrationScopes(scopes), quotaPerSecond: quota(quotaPerSecond) };
      expiryDays(expiresInDays);
      publicKey(publicJwk);
      const station = await usable(accountId, stationId);
      if (!station.builtIn) return create(accountId, station, fields, publicJwk, expiresInDays);
      if (!station.integrationsEnabled) throw failure(409, NOT_SUPPORTED, "not_supported");
      return oneAtATime(accountId + " " + station.id, async () => {
        await underPlanLimit(accountId, station.id, plan);
        return create(accountId, station, fields, publicJwk, expiresInDays);
      });
    },

    // The account's own integrations (reconciled with Auth's list of them) and, read from Portal only, the others on
    // custom Stations it owns, which it may pause or revoke. The same for a browser session and an app's token.
    async integrations(accountId) {
      let listed;
      try {
        listed = await manage.integrations(accountId);
      } catch (error) {
        if (!(error instanceof ManageError) || fromManage(error).status !== 503) throw fromManage(error);
        log("Integration list served from Portal: Auth " + error.code + ".");
      }
      if (listed) await reconcileIntegrations(listed);
      const views = [];
      for (const row of await repository.integrationsFor(accountId)) views.push(await viewOf(row, "owner"));
      for (const station of await repository.stationsFor(accountId)) {
        if (station.role !== "owner") continue;
        for (const row of await repository.integrationsOnStation(station.id)) {
          if (row.ownerAccount !== accountId) views.push(integrationView(row, "station_owner", station.origin));
        }
      }
      return { integrations: views, stale: !listed };
    },

    // Called for a native app holding integrations:approve for the owner, so only the owner's integrations exist here.
    async approve(accountId, id, { r9Svc } = {}) {
      const row = typeof id === "string" && id ? await repository.integration(id) : null;
      if (!row || row.ownerAccount !== accountId) throw notFound();
      if (typeof r9Svc !== "string" || !R9_SVC.test(r9Svc)) throw failure(400, "Send the R9 service fingerprint as 64 lower-case hex characters.", "r9_svc");
      step(row, "approve", now());
      await byActor(accountId, () => manage.changeIntegration(id, { r9Svc }, accountId));
      // A pause committed in between fails the re-check after Auth stored r9Svc; the owner approves again after resuming.
      const updated = await commit(id, (current) => ({
        fields: { ...step(current, "approve", now()), r9Svc, approvedBy: accountId, approvedAt: now() },
        event: { actor: accountId, kind: "integration_approved" }
      }));
      return viewOf(updated, "owner");
    },

    pause: (accountId, id) => stop(accountId, id, "pause"),
    revoke: (accountId, id) => stop(accountId, id, "revoke"),

    // The owner only, never while Agora.Build has the owner's account disabled, and never out of an Agora.Build admin's
    // pause, which only an admin lifts on the admin site. Auth holds the lock too: its own 409 admin_paused means the
    // Portal has not read that change yet, so the stack is asked to read Auth's change feed now.
    async resume(accountId, id) {
      const row = await owned(accountId, id);
      if (row.ownerDisabledAt != null && effectiveState(row, now()) === "paused") throw ownerDisabled();
      if (row.state === "paused" && row.pausedBy === "admin") throw adminPaused();
      step(row, "resume", now());
      try {
        await byActor(accountId, () => manage.changeIntegration(id, { status: "active" }, accountId));
      } catch (error) {
        if (error.details?.code === "admin_paused") authChanged();
        throw error;
      }
      const updated = await commit(id, (current) => ({ fields: { ...step(current, "resume", now()), pausedBy: null }, event: { actor: accountId, kind: "integration_resumed", reason: "owner", details: seen() } }));
      return viewOf(updated, "owner");
    },

    // Renewing an expired integration on a built-in Station brings one back, so it counts as adding one (plan limit,
    // where the expired one is not counted yet); renewing a live one never changes the count. Every renewal there runs
    // one at a time with the account's creations on that Station and decides "expired" only once it holds that turn,
    // so a creation racing a renewal just before expiry waits and then counts the renewed one.
    async renew(accountId, id, { expiresInDays } = {}, { plan = "basic" } = {}) {
      const row = await owned(accountId, id);
      expiryDays(expiresInDays);
      step(row, "renew", now());
      const renewing = async () => {
        const changedAt = await byActor(accountId, () => manage.changeIntegration(id, { expiresAt: new Date(now() + expiresInDays * DAY).toISOString() }, accountId));
        const updated = await commit(id, (current) => {
          step(current, "renew", now());
          return { fields: { expiresAt: changedAt.expiresAt }, event: { actor: accountId, kind: "integration_renewed", details: { expiresAt: changedAt.expiresAt } } };
        });
        return viewOf(updated, "owner");
      };
      if (!(await repository.station(row.stationId))?.builtIn) return renewing();
      return oneAtATime(accountId + " " + row.stationId, async () => {
        const current = await repository.integration(id);
        if (!current) throw notFound();
        step(current, "renew", now());
        if (effectiveState(current, now()) === "expired") await underPlanLimit(accountId, row.stationId, plan);
        return renewing();
      });
    },

    // Allowed on an expired integration, as Auth allows it: the owner may tune it before renewing.
    async settings(accountId, id, { quotaPerSecond } = {}) {
      const row = await owned(accountId, id);
      quota(quotaPerSecond);
      notRevoked(row);
      const answer = await byActor(accountId, () => manage.changeIntegration(id, { quotaPerSecond }, accountId));
      const updated = await commit(id, (current) => {
        notRevoked(current);
        return { fields: { quotaPerSecond: answer.quotaPerSecond }, event: { actor: accountId, kind: "integration_settings_changed", details: { quotaPerSecond: answer.quotaPerSecond } } };
      });
      return viewOf(updated, "owner");
    },

    // Allowed on an expired integration, as Auth allows it: the owner may rotate before renewing.
    async rotateKey(accountId, id, { publicJwk } = {}) {
      const row = await owned(accountId, id);
      publicKey(publicJwk);
      notRevoked(row);
      const { kid, overlapEndsAt } = await byActor(accountId, () => manage.addKey(id, publicJwk, accountId));
      await commit(id, (current) => {
        notRevoked(current);
        return { event: { actor: accountId, kind: "integration_key_added", details: { kid, overlapEndsAt } } };
      });
      return { kid, overlapEndsAt };
    },

    // An authenticated Station's report about one of its integrations. Only these reports move an integration into
    // waiting_for_host, ready or revoked (Portal never sets ready itself); `error` records lastError and keeps the state.
    async report(clientId, body) {
      const station = await reportingStation(clientId);
      const { integrationId, state, reason } = reportBody(body);
      const row = typeof integrationId === "string" && integrationId ? await repository.integration(integrationId) : null;
      // Integrations of other Stations get the same answer as unknown ones.
      if (!row || row.stationId !== station.id) throw notFound();
      const apply = (current) => {
        const event = { actor: "station", kind: "integration_reported", reason };
        if (state === "error") {
          if (current.state === "revoked") throw failure(409, "This integration is revoked and cannot take that action.", "invalid_state");
          if (current.lastError === reason) return null;
          return { fields: { lastError: reason }, event };
        }
        if (current.state === state || (current.state === "paused" && current.resumeState === state)) return null;
        return { fields: { ...transition(current, "report:" + state, now()), lastError: null }, event };
      };
      apply(row);
      // The Station made this change itself, so it is not pushed back to it.
      const updated = await commit(row.id, apply, { push: false });
      // As in its feed, the Station is not told who paused an integration.
      const { role, pausedBy, ...view } = integrationView(updated, null, station.origin);
      return view;
    },

    // This Station's changes after `cursor`, oldest first, each with its integration's current settings. From cursor 0
    // the answer also lists every integration on the Station, so a Station starting fresh has a snapshot.
    async changes(clientId, cursorInput) {
      const station = await reportingStation(clientId);
      const cursor = feedCursor(cursorInput);
      // A cursor this Station's history never reached (the Portal's database was restored from an older backup) can't
      // be served from: the Station must start again from cursor 0, whose snapshot is the current state.
      if (cursor > 0 && cursor > await repository.latestCursor(station.id)) throw failure(409, "This cursor is ahead of the Portal's history. Read the feed again from cursor 0.", "cursor_ahead");
      const events = await repository.changesSince(station.id, cursor, FEED_LIMIT);
      const rows = await repository.integrationsOnStation(station.id);
      const at = now();
      const current = new Map(rows.map((row) => [row.id, row]));
      const changes = events.map(({ id, at: when, integrationId, kind, state, reason, details }) => {
        // Agora.Build's changes say only that: the admin and their reason stay in the Portal's event (spec §3.3.4).
        const change = { id, at: when, integrationId, kind, state, reason: details?.admin === true ? AGORA_BUILD : reason };
        const row = integrationId ? current.get(integrationId) : null;
        if (row) change.integration = feedIntegration(row, at);
        return change;
      });
      const answer = { changes, cursor: events.length ? events.at(-1).id : cursor };
      if (cursor === 0) answer.integrations = rows.map((row) => ({ id: row.id, ...feedIntegration(row, at) }));
      return answer;
    },

    // The built-in Stations as Auth lists them naming no account (GET /manage/v1/built-in-stations, spec §3.3.4), so
    // their report clients are known before anyone signs in. Only the built-in part of reconcile runs: nothing is
    // removed or revoked on absence. Never throws; returns whether it synced. Run by the stack at ready(), hourly, and
    // a minute after a failure.
    async syncBuiltIn() {
      try {
        const listed = (await manage.builtInStations()).filter((entry) => entry.builtIn === true);
        const known = new Set(listed.map((entry) => entry.id));
        for (const station of await repository.builtInStations()) {
          if (!known.has(station.id)) log("Built-in Station absent from Auth's listing: left as it is.");
        }
        for (const entry of listed) await reconcileBuiltIn(entry);
        return true;
      } catch (error) {
        log("Built-in Station sync failed: " + (error instanceof ManageError ? error.code : error.code || "error") + ".");
        return false;
      }
    },

    // One entry of Auth's change feed (GET /manage/v1/integration-changes, read by auth-changes.mjs): Auth's change to
    // an integration's access, followed on the Portal's row (authEffect), recorded in integration_events with the
    // account that made it and its reason (an Agora.Build admin and the reason they gave; spec §3.3.4), then appended
    // to the Station's feed and pushed to it. Changes the Portal made itself (an account's pause, resume or revoke
    // through these routes) are already recorded and are skipped, as are integrations the Portal does not know (their
    // owner's next listing brings them in). Each entry is applied once: its cursor and time are kept in the event's
    // details. Returns "applied" or "skipped"; only a database failure throws, so the reader reads it again.
    //
    // The feed may be read after the Portal already followed a newer change (an owner's listing, the owner's own call,
    // or a revocation). Such an entry is still recorded, and a pause or revocation still applies: a pause that is out
    // of date errs on the safe side, and the owner's next listing follows Auth again. A resume applies only if it is not older
    // than the newest pause, resume or revocation the row has recorded (repository.latestStatusAt); otherwise the row
    // keeps its state and the event says so (details.superseded), so a resume read late never undoes a newer pause
    // (Ruling R-A). Auth's clock and the Portal's are compared here, so they are kept in sync.
    async applyAuthChange(entry) {
      if (!plainObject(entry) || !AUTH_KINDS.includes(entry.kind) || typeof entry.clientId !== "string" || typeof entry.cursor !== "string" || !AUTH_CURSOR.test(entry.cursor) || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at))) {
        log("Auth change skipped: not a change entry.");
        return "skipped";
      }
      const ours = !OWNER_KINDS.includes(entry.kind) && entry.admin !== true && entry.actorAccountId !== null;
      if (ours) return "skipped";
      if (!(await repository.integration(entry.clientId))) {
        log("Auth change skipped: the integration is unknown to Portal.");
        return "skipped";
      }
      const actor = typeof entry.actorAccountId === "string" && ACCOUNT_ID.test(entry.actorAccountId) ? entry.actorAccountId : SYSTEM;
      const reason = typeof entry.reason === "string" && entry.reason ? [...entry.reason].slice(0, AUTH_REASON_MAX).join("") : null;
      const applied = await appending(async (client) => {
        const row = await repository.integrationForUpdate(entry.clientId, client);
        if (!row || await repository.authChangeApplied(row.id, entry.cursor, entry.at, client)) return null;
        const effect = authEffect(row, entry, now());
        let superseded = false;
        if (entry.kind === "resumed" && Object.keys(effect.fields).length) {
          const latest = await repository.latestStatusAt(row.id, client);
          superseded = latest !== null && Date.parse(latest) > Date.parse(entry.at);
        }
        const fields = superseded ? {} : effect.fields;
        if (Object.keys(fields).length) await repository.updateIntegration(row.id, fields, client);
        const after = { ...row, ...fields };
        await repository.appendEvent({
          stationId: row.stationId, integrationId: row.id, accountId: row.ownerAccount, actor, kind: effect.kind,
          state: effectiveState(after, 0), reason,
          details: {
            authCursor: entry.cursor, authAt: entry.at, admin: entry.admin === true,
            ...(after.state === "paused" && PAUSED_BY.includes(after.pausedBy) ? { pausedBy: after.pausedBy } : {}),
            ...(superseded ? { superseded: true } : {})
          }
        }, client);
        return { stationId: row.stationId, superseded };
      });
      if (!applied) return "skipped";
      if (applied.superseded) log("Auth change recorded without its state change: the Portal has a newer one.");
      changed(applied.stationId);
      return "applied";
    },

    notify: (stationId) => changed(stationId),

    // For tests: resolves once no push is in flight.
    async _pushesIdle() {
      while (pushes.size) await Promise.all([...pushes.values()].map((entry) => entry.done));
    },

    // Newest first. The reader's own changes show as "you". An Agora.Build admin's change shows as Agora.Build's: the
    // admin's account and their reason stay in the event, for the audit (spec §3.3.4).
    async history(accountId, id) {
      const { row } = await visible(accountId, id);
      const events = await repository.eventsFor(row.id);
      return { events: events.map(({ at, kind, state, reason, actor, details }) => details?.admin === true
        ? { at, kind, state, reason: null, actor: AGORA_BUILD }
        : { at, kind, state, reason, actor: actor === accountId ? "you" : actor }) };
    }
  };
}
