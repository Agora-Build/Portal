// Business flows for Stations and integrations. Auth is called first and Portal writes its rows only after Auth answers
// success; every Auth change names the signed-in account as `actor`. Rows are never deleted (D19).
import { randomBytes, randomUUID } from "node:crypto";
import { TokenError } from "../idp.mjs";
import { ACCOUNT_ID, AppError } from "../store.mjs";
import { ManageError } from "./auth-manage.mjs";
import { checkProof, stationOrigin, WELL_KNOWN_PATH } from "./proof.mjs";
import { transition } from "./states.mjs";

const CHALLENGE_LIFETIME = 600000;
const CHALLENGES_PER_HOUR = 10;
const REPORT_KEY_MAX = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const failure = (status, message, code, extra = {}) => new AppError(status, message, { code, ...extra });
const notFound = () => failure(404, "This Station or integration was not found.", "not_found");
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
  if (error.status === 403) return failure(403, "Only the Station owner can do this.", "forbidden");
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

export function createIntegrationService({
  repository, db, manage, stationFetch, exchange, now = Date.now, log = () => {}, ids = randomUUID,
  challengeValue = () => randomBytes(32).toString("base64url")
}) {
  // Revokes, inside the caller's transaction, each integration `pick` selects on the Station; already revoking or
  // revoked ones are left as they are. `direct` sets revoked at once (Auth has already removed the Station).
  async function revokeOn(client, stationId, pick, { actor, reason, direct = false }) {
    const at = now();
    for (const listed of await repository.integrationsOnStation(stationId, client)) {
      if (!pick(listed) || listed.state === "revoking" || listed.state === "revoked") continue;
      const row = await repository.integrationForUpdate(listed.id, client);
      if (row.state === "revoking" || row.state === "revoked") continue;
      const next = direct ? { state: "revoked", resumeState: null } : transition(row, "revoke", at);
      await repository.updateIntegration(row.id, next, client);
      await repository.appendEvent({ stationId, integrationId: row.id, accountId: row.ownerAccount, actor, kind: "integration_revoked", state: next.state, reason }, client);
    }
  }

  async function activeStation(stationId) {
    const station = typeof stationId === "string" && stationId ? await repository.station(stationId) : null;
    if (!station || station.status !== "active") throw notFound();
    return station;
  }

  // Brings Portal's rows in line with Auth's list for this account; Auth is authoritative.
  async function reconcile(accountId, listed) {
    const known = new Set(listed.map((station) => station.id));
    for (const entry of listed) {
      if (!(await repository.station(entry.id))) {
        await db.transaction(async (client) => {
          await repository.insertStation({ id: entry.id, origin: entry.origin, ownerAccount: entry.owner, reportClientId: entry.reportClientId, verifiedAt: entry.createdAt }, client);
          await repository.appendEvent({ stationId: entry.id, accountId: entry.owner, actor: "system", kind: "station_reconciled" }, client);
        });
        log("Station reconciled from Auth: missing in Portal.");
      }
      if (entry.owner !== accountId && !(await repository.currentMembers(entry.id)).some((member) => member.accountId === accountId)) {
        await db.transaction(async (client) => {
          await repository.addMember(entry.id, accountId, "system", now(), client);
          await repository.appendEvent({ stationId: entry.id, accountId, actor: "system", kind: "member_added", reason: "reconciled" }, client);
        });
        log("Station member reconciled from Auth: missing in Portal.");
      }
    }
    for (const station of await repository.stationsFor(accountId)) {
      if (station.role !== "owner" || known.has(station.id)) continue;
      await db.transaction(async (client) => {
        await repository.markStationRemoved(station.id, now(), client);
        await revokeOn(client, station.id, () => true, { actor: "system", reason: "reconciled", direct: true });
        await repository.appendEvent({ stationId: station.id, accountId, actor: "system", kind: "station_removed", reason: "reconciled" }, client);
      });
      log("Station removed in Portal: absent from Auth.");
    }
  }

  return {
    async createChallenge(accountId, originInput) {
      const origin = stationOrigin(originInput);
      const since = new Date(now() - 3600000);
      if (await repository.challengesSince(accountId, since) >= CHALLENGES_PER_HOUR) throw new AppError(429, "Too many Station checks. Try again later.");
      const challengeId = ids();
      const value = challengeValue();
      const expiresAt = new Date(now() + CHALLENGE_LIFETIME).toISOString();
      await repository.createChallenge({ id: challengeId, accountId, origin, value, expiresAt });
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
      await db.transaction(async (client) => {
        await repository.insertStation({ id: registered.id, origin, ownerAccount: accountId, reportClientId: registered.reportClientId, verifiedAt: now() }, client);
        await repository.appendEvent({ stationId: registered.id, accountId, actor: accountId, kind: "station_registered" }, client);
      });
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
      const answer = await viaAuth(() => manage.members(stationId, accountId));
      return { owner: answer.owner, members: (answer.members || []).map(({ account, addedAt }) => ({ account, addedAt })) };
    },

    async share(accountId, stationId, member) {
      memberAccount(member);
      const station = await activeStation(stationId);
      if (member === station.ownerAccount) throw failure(400, "The owner already has this Station.", "account");
      await viaAuth(() => manage.addMember(stationId, member, accountId));
      await db.transaction(async (client) => {
        await repository.addMember(stationId, member, accountId, now(), client);
        await repository.appendEvent({ stationId, accountId: member, actor: accountId, kind: "member_added" }, client);
      });
    },

    // Auth removes the member and revokes their integrations on the Station; Portal follows in one transaction.
    async unshare(accountId, stationId, member) {
      memberAccount(member);
      await viaAuth(() => manage.removeMember(stationId, member, accountId));
      await db.transaction(async (client) => {
        await repository.removeMember(stationId, member, accountId, now(), client);
        await revokeOn(client, stationId, (row) => row.ownerAccount === member, { actor: accountId, reason: "member_removed" });
        await repository.appendEvent({ stationId, accountId: member, actor: accountId, kind: "member_removed" }, client);
      });
    },

    async removeStation(accountId, stationId) {
      await viaAuth(() => manage.removeStation(stationId, accountId));
      const station = await repository.station(stationId);
      await db.transaction(async (client) => {
        await repository.markStationRemoved(stationId, now(), client);
        await revokeOn(client, stationId, () => true, { actor: accountId, reason: "station_removed" });
        await repository.appendEvent({ stationId, accountId: station?.ownerAccount ?? accountId, actor: accountId, kind: "station_removed" }, client);
      });
    },

    // A 5-minute station.read token for the browser to send to a Station this account owns or belongs to.
    async readToken(accountId, idToken, stationId) {
      const station = (await repository.stationsFor(accountId)).find((entry) => entry.id === stationId);
      if (!station) throw notFound();
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
    }
  };
}
