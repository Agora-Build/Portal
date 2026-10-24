// Business flows for Stations and integrations. Auth is called first and Portal writes its rows only after Auth answers
// success; every Auth change names the signed-in account as `actor`. Rows are never deleted (D19).
import { randomBytes, randomUUID } from "node:crypto";
import { TokenError } from "../idp.mjs";
import { ACCOUNT_ID, AppError } from "../store.mjs";
import { ManageError } from "./auth-manage.mjs";
import { checkProof, createStationFetch, ProofError, stationOrigin, WELL_KNOWN_PATH } from "./proof.mjs";
import { effectiveState, REPORT_STATES, transition } from "./states.mjs";

const CHALLENGE_LIFETIME = 600000;
const CHALLENGES_PER_HOUR = 10;
const REPORT_KEY_MAX = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const SCOPES = ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal"];
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];
const R9_SVC = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
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

const MANAGE_CONFLICTS = {
  origin_taken: "This Station is already registered.",
  revoked: "This integration has been revoked.",
  duplicate_key: "This key is already registered."
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

// Members are not shown the Station's report client; it is not secret, but they have no use for it.
function stationView(station, role) {
  const view = { id: station.id, origin: station.origin, role, ownerAccount: station.ownerAccount, status: station.status, createdAt: station.createdAt };
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

// What a Station needs to act on an integration; the state is the effective one, so it may be "expired".
function feedIntegration(row, at) {
  return { state: effectiveState(row, at), scopes: row.scopes, r9Svc: row.r9Svc, expiresAt: row.expiresAt, quotaPerSecond: row.quotaPerSecond };
}

export function createIntegrationService({
  repository, db, manage, stationFetch, exchange, now = Date.now, log = () => {}, ids = randomUUID,
  challengeValue = () => randomBytes(32).toString("base64url"), pushFetch = createStationFetch({ timeoutMs: 3000 }), notify
}) {
  // Every transaction here appends events, so each takes the event lock before any row lock (see lockEvents).
  const appending = (work) => db.transaction(async (client) => {
    await repository.lockEvents(client);
    return work(client);
  });

  // Per Station: the push in flight and whether another change arrived while it ran.
  const pushes = new Map();

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
      const next = direct ? { state: "revoked", resumeState: null } : transition(row, "revoke", at);
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
    await repository.appendEvent({ stationId: stale.id, accountId: stale.ownerAccount, actor: "system", kind: "station_removed", reason: "reconciled" }, client);
    return stale.id;
  }

  function retired(stationId) {
    if (!stationId) return;
    log("Station removed in Portal: its origin belongs to another Station at Auth.");
    changed(stationId);
  }

  // The active Station as this account has it in Portal (with its role, "owner" or "member"). An account that neither
  // owns it nor is a current member gets the same 404 as for an unknown ID, before Auth is asked, so nothing about the
  // Station is revealed (as for integrations, Ruling T7-8).
  async function usable(accountId, stationId) {
    const station = typeof stationId === "string" && stationId ? (await repository.stationsFor(accountId)).find((entry) => entry.id === stationId) : null;
    if (!station) throw notFound();
    return station;
  }

  // For changes only the Station's owner may make; a member sees the Station, so it is told why.
  async function ownStation(accountId, stationId) {
    const station = await usable(accountId, stationId);
    if (station.role !== "owner") throw ownerOnly();
    return station;
  }

  // Brings Portal's rows in line with Auth's list for this account; Auth is authoritative. Removals run first, so a
  // Station Auth has replaced at the same origin is retired before its successor is added.
  async function reconcile(accountId, listed) {
    const known = new Set(listed.map((station) => station.id));
    for (const station of await repository.stationsFor(accountId)) {
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
      if (!(await repository.station(entry.id))) {
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

  function integrationView(row, role, origin) {
    return {
      id: row.id, kind: row.kind, name: row.name, stationId: row.stationId, stationOrigin: origin, scopes: row.scopes,
      state: effectiveState(row, now()), pausedFrom: row.resumeState, r9Svc: row.r9Svc, quotaPerSecond: row.quotaPerSecond,
      expiresAt: row.expiresAt, approvedAt: row.approvedAt, lastError: row.lastError, createdAt: row.createdAt, role
    };
  }

  async function viewOf(row, role) {
    return integrationView(row, role, (await repository.station(row.stationId))?.origin ?? null);
  }

  // The row and the account's part in it: "owner", "station_owner" (it owns the integration's Station) or null.
  async function access(accountId, id) {
    const row = typeof id === "string" && id ? await repository.integration(id) : null;
    if (!row) throw notFound();
    if (row.ownerAccount === accountId) return { row, role: "owner" };
    const station = await repository.station(row.stationId);
    return { row, role: station?.ownerAccount === accountId ? "station_owner" : null };
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
    if (role === "station_owner") throw failure(403, "Only the integration's owner can do this.", "forbidden");
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

  // pause and revoke: the integration's owner or its Station's owner; anyone else is told nothing about it.
  async function stop(accountId, id, event) {
    const { row, role } = await visible(accountId, id);
    step(row, event, now());
    if (event === "revoke" && STOPPED.includes(row.state)) return viewOf(row, role);
    await viaAuth(() => manage.changeIntegration(id, { status: event === "pause" ? "paused" : "revoked" }, accountId));
    const kind = event === "pause" ? "integration_paused" : "integration_revoked";
    const updated = await commit(id, (current) => {
      if (event === "revoke" && STOPPED.includes(current.state)) return null;
      return { fields: step(current, event, now()), event: { actor: accountId, kind, reason: role } };
    });
    return viewOf(updated, role);
  }

  // What following Auth's entry changes on Portal's row: the fields to write and the status event ([transition, kind])
  // or null. Auth is authoritative, so following it is not held back by expiry: transitions are checked at time 0.
  function difference(row, entry) {
    const fields = {};
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() !== new Date(row.expiresAt).getTime()) fields.expiresAt = entry.expiresAt;
    if (entry.quotaPerSecond !== undefined && entry.quotaPerSecond !== row.quotaPerSecond) fields.quotaPerSecond = entry.quotaPerSecond;
    if ((entry.r9Svc ?? null) !== row.r9Svc) fields.r9Svc = entry.r9Svc ?? null;
    let event = null;
    if (entry.status === "revoked" && !STOPPED.includes(row.state)) event = ["revoke", "integration_revoked"];
    else if (entry.status === "paused" && row.state !== "paused" && !STOPPED.includes(row.state)) event = ["pause", "integration_paused"];
    else if (entry.status === "active" && row.state === "paused") event = ["resume", "integration_resumed"];
    const settings = Object.keys(fields);
    if (event) Object.assign(fields, step(row, event[0], 0));
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
        if (event) await repository.appendEvent({ ...recorded, kind: event[1], state: fields.state }, client);
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

  return {
    async createChallenge(accountId, originInput) {
      const origin = stationOrigin(originInput);
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
      const proof = await checkProof(origin, value, { fetch: stationFetch });
      if (!proof.ok) {
        log("Station proof of control failed: " + proof.reason + ".");
        throw failure(422, "The Station did not serve the check value at " + origin + WELL_KNOWN_PATH + ".", "proof", { reason: proof.reason });
      }
      const registered = await viaAuth(() => manage.registerStation({ origin, owner: accountId, reportKey, actor: accountId }));
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
      await usable(accountId, stationId);
      const answer = await viaAuth(() => manage.members(stationId, accountId));
      return { owner: answer.owner, members: (answer.members || []).map(({ account, addedAt }) => ({ account, addedAt })) };
    },

    async share(accountId, stationId, member) {
      memberAccount(member);
      const station = await ownStation(accountId, stationId);
      if (member === station.ownerAccount) throw failure(400, "The owner already has this Station.", "account");
      await viaAuth(() => manage.addMember(stationId, member, accountId));
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
      const station = await usable(accountId, stationId);
      if (station.role !== "owner" && member !== accountId) throw ownerOnly();
      await viaAuth(() => manage.removeMember(stationId, member, accountId));
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
      await viaAuth(() => manage.removeStation(stationId, accountId));
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

    async createIntegration(accountId, { stationId, name, scopes = [], publicJwk, quotaPerSecond = 200, expiresInDays = 30 } = {}) {
      const fields = { name: integrationName(name), scopes: integrationScopes(scopes), quotaPerSecond: quota(quotaPerSecond) };
      expiryDays(expiresInDays);
      publicKey(publicJwk);
      const station = await usable(accountId, stationId);
      const expiresAt = new Date(now() + expiresInDays * DAY).toISOString();
      const created = await viaAuth(() => manage.createIntegration({ owner: accountId, stationId, ...fields, publicJwk, expiresAt, actor: accountId }));
      await appending(async (client) => {
        await repository.insertIntegration({ id: created.clientId, ownerAccount: accountId, stationId, kind: "custom_app", ...fields, expiresAt: created.expiresAt ?? expiresAt }, client);
        await repository.appendEvent({ stationId, integrationId: created.clientId, accountId, actor: accountId, kind: "integration_created", state: "awaiting_approval", details: { scopes: fields.scopes, name: fields.name } }, client);
      });
      changed(stationId);
      return integrationView(await repository.integration(created.clientId), "owner", station.origin);
    },

    // The account's own integrations (reconciled with Auth's list of them) and, read from Portal only, the others on
    // Stations it owns, which it may pause or revoke.
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
      await viaAuth(() => manage.changeIntegration(id, { r9Svc }, accountId));
      // A pause committed in between fails the re-check after Auth stored r9Svc; the owner approves again after resuming.
      const updated = await commit(id, (current) => ({
        fields: { ...step(current, "approve", now()), r9Svc, approvedBy: accountId, approvedAt: now() },
        event: { actor: accountId, kind: "integration_approved" }
      }));
      return viewOf(updated, "owner");
    },

    pause: (accountId, id) => stop(accountId, id, "pause"),
    revoke: (accountId, id) => stop(accountId, id, "revoke"),

    async resume(accountId, id) {
      const row = await owned(accountId, id);
      step(row, "resume", now());
      await viaAuth(() => manage.changeIntegration(id, { status: "active" }, accountId));
      const updated = await commit(id, (current) => ({ fields: step(current, "resume", now()), event: { actor: accountId, kind: "integration_resumed", reason: "owner" } }));
      return viewOf(updated, "owner");
    },

    async renew(accountId, id, { expiresInDays } = {}) {
      const row = await owned(accountId, id);
      expiryDays(expiresInDays);
      step(row, "renew", now());
      const changedAt = await viaAuth(() => manage.changeIntegration(id, { expiresAt: new Date(now() + expiresInDays * DAY).toISOString() }, accountId));
      const updated = await commit(id, (current) => {
        step(current, "renew", now());
        return { fields: { expiresAt: changedAt.expiresAt }, event: { actor: accountId, kind: "integration_renewed", details: { expiresAt: changedAt.expiresAt } } };
      });
      return viewOf(updated, "owner");
    },

    // Allowed on an expired integration, as Auth allows it: the owner may tune it before renewing.
    async settings(accountId, id, { quotaPerSecond } = {}) {
      const row = await owned(accountId, id);
      quota(quotaPerSecond);
      notRevoked(row);
      const answer = await viaAuth(() => manage.changeIntegration(id, { quotaPerSecond }, accountId));
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
      const { kid, overlapEndsAt } = await viaAuth(() => manage.addKey(id, publicJwk, accountId));
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
      const { role, ...view } = integrationView(updated, null, station.origin);
      return view;
    },

    // This Station's changes after `cursor`, oldest first, each with its integration's current settings. From cursor 0
    // the answer also lists every integration on the Station, so a Station starting fresh has a snapshot.
    async changes(clientId, cursorInput) {
      const station = await reportingStation(clientId);
      const cursor = feedCursor(cursorInput);
      const events = await repository.changesSince(station.id, cursor, FEED_LIMIT);
      const rows = await repository.integrationsOnStation(station.id);
      const at = now();
      const current = new Map(rows.map((row) => [row.id, row]));
      const changes = events.map(({ id, at: when, integrationId, kind, state, reason }) => {
        const change = { id, at: when, integrationId, kind, state, reason };
        const row = integrationId ? current.get(integrationId) : null;
        if (row) change.integration = feedIntegration(row, at);
        return change;
      });
      const answer = { changes, cursor: events.length ? events.at(-1).id : cursor };
      if (cursor === 0) answer.integrations = rows.map((row) => ({ id: row.id, ...feedIntegration(row, at) }));
      return answer;
    },

    notify: (stationId) => changed(stationId),

    // For tests: resolves once no push is in flight.
    async _pushesIdle() {
      while (pushes.size) await Promise.all([...pushes.values()].map((entry) => entry.done));
    },

    async history(accountId, id) {
      const { row } = await visible(accountId, id);
      const events = await repository.eventsFor(row.id);
      return { events: events.map(({ at, kind, state, reason, actor }) => ({ at, kind, state, reason, actor: actor === accountId ? "you" : actor })) };
    }
  };
}
