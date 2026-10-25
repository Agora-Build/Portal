import { ManageError } from "../../scripts/integrations/auth-manage.mjs";

const DAY = 86400000;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];

// An in-memory Auth /manage/v1 following the actor rules of Auth's docs/integrating.md. `failNext` makes the next call
// of that name fail with the given status and code (after the gate, so the call is still recorded).
export function fakeManage({ now = Date.now } = {}) {
  const stations = [];
  const integrations = [];
  let next = 0;
  let nextIntegration = 0;
  const valid = (account) => typeof account === "string" && /^ab[0-9A-HJKMNP-TV-Z]{26}$/.test(account);
  const fail = (status, code) => { throw new ManageError(status, code); };
  const uses = (station, account) => station.owner === account || station.members.some((member) => member.account === account);
  const listed = ({ keys, ...integration }) => ({ ...integration, scopes: [...integration.scopes] });
  const checkKey = (publicJwk) => {
    if (!publicJwk || typeof publicJwk !== "object") fail(400, "jwk");
    if (PRIVATE_MEMBERS.some((member) => Object.hasOwn(publicJwk, member))) fail(400, "private_key");
  };
  const checkExpiry = (expiresAt) => {
    const at = new Date(expiresAt).getTime();
    if (!Number.isFinite(at) || at <= now() || at > now() + 90 * DAY) fail(400, "expiry");
    return new Date(at).toISOString();
  };
  const auth = {
    down: false,
    calls: [],
    failNext: {},
    records: stations,
    integrationRecords: integrations,
    find(id) {
      const station = stations.find((entry) => entry.id === id && entry.status === "active");
      if (!station) fail(404, "not_found");
      return station;
    },
    findIntegration(id) {
      const integration = integrations.find((entry) => entry.clientId === id);
      if (!integration || !stations.some((entry) => entry.id === integration.stationId && entry.status === "active")) fail(404, "not_found");
      return integration;
    },
    async gate(name, actor, ...accounts) {
      auth.calls.push(name);
      if (auth.down) fail(503, "unavailable");
      if (![actor, ...accounts].every(valid)) fail(400, "invalid_request");
      const failure = auth.failNext[name];
      if (failure) {
        delete auth.failNext[name];
        fail(failure.status, failure.code);
      }
    },
    revokeWhere(pick) {
      for (const integration of integrations) if (pick(integration)) integration.status = "revoked";
    },
    async registerStation({ origin, owner, reportKey, actor }) {
      await auth.gate("registerStation", actor, owner);
      if (actor !== owner) fail(403, "forbidden");
      if (!reportKey || typeof reportKey !== "object") fail(400, "jwk");
      if (stations.some((entry) => entry.origin === origin && entry.status === "active")) fail(409, "origin_taken");
      next += 1;
      const station = { id: "st" + next, origin, owner, status: "active", reportClientId: "s-st" + next, createdAt: new Date(Date.now() - 1000).toISOString(), members: [] };
      stations.push(station);
      return { id: station.id, origin, owner, status: "active", reportClientId: station.reportClientId };
    },
    async stations(account) {
      await auth.gate("stations", account);
      return stations.filter((entry) => entry.status === "active" && uses(entry, account))
        .map(({ id, origin, owner, status, reportClientId, createdAt }) => ({ id, origin, owner, status, reportClientId, createdAt }));
    },
    async removeStation(id, actor) {
      await auth.gate("removeStation", actor);
      const station = auth.find(id);
      if (station.owner !== actor) fail(403, "forbidden");
      station.status = "removed";
      auth.revokeWhere((integration) => integration.stationId === id);
    },
    async members(id, actor) {
      await auth.gate("members", actor);
      const station = auth.find(id);
      if (!uses(station, actor)) fail(403, "forbidden");
      return { owner: station.owner, members: station.members.map((member) => ({ ...member })) };
    },
    async addMember(id, account, actor) {
      await auth.gate("addMember", actor, account);
      const station = auth.find(id);
      if (station.owner !== actor) fail(403, "forbidden");
      if (!station.members.some((member) => member.account === account)) station.members.push({ account, addedAt: new Date().toISOString() });
    },
    async removeMember(id, account, actor) {
      await auth.gate("removeMember", actor, account);
      const station = auth.find(id);
      if (station.owner !== actor && account !== actor) fail(403, "forbidden");
      station.members = station.members.filter((member) => member.account !== account);
      auth.revokeWhere((integration) => integration.stationId === id && integration.owner === account);
    },
    async createIntegration({ owner, stationId, name, scopes, publicJwk, r9Svc = null, quotaPerSecond = 200, expiresAt, actor }) {
      await auth.gate("createIntegration", actor, owner);
      if (actor !== owner) fail(403, "forbidden");
      const station = stations.find((entry) => entry.id === stationId && entry.status === "active");
      if (!station || !uses(station, owner)) fail(400, "invalid_request");
      if (!Array.isArray(scopes) || !scopes.includes("agent.view") || !scopes.every((scope) => /^agent\.[a-z]+$/.test(scope))) fail(400, "scopes");
      checkKey(publicJwk);
      const expiry = expiresAt === undefined ? new Date(now() + 30 * DAY).toISOString() : checkExpiry(expiresAt);
      nextIntegration += 1;
      const integration = {
        clientId: "i-" + String(nextIntegration).padStart(26, "0"), kind: "integration", owner, stationId, name, scopes: [...scopes], r9Svc,
        quotaPerSecond, status: "active", expiresAt: expiry, createdAt: new Date(now()).toISOString(), keys: [JSON.stringify(publicJwk)]
      };
      integrations.push(integration);
      return { clientId: integration.clientId, status: integration.status, expiresAt: integration.expiresAt };
    },
    async integrations(account) {
      await auth.gate("integrations", account);
      return integrations.filter((entry) => entry.owner === account).map(listed);
    },
    async addKey(id, publicJwk, actor) {
      await auth.gate("addKey", actor);
      const integration = auth.findIntegration(id);
      if (integration.owner !== actor) fail(403, "forbidden");
      if (integration.status === "revoked") fail(409, "revoked");
      checkKey(publicJwk);
      if (integration.keys.includes(JSON.stringify(publicJwk))) fail(409, "duplicate_key");
      integration.keys.push(JSON.stringify(publicJwk));
      return { kid: "kid-" + integration.keys.length, overlapEndsAt: new Date(now() + 600000).toISOString() };
    },
    async changeIntegration(id, { status, r9Svc, quotaPerSecond, expiresAt } = {}, actor) {
      await auth.gate("changeIntegration", actor);
      const integration = auth.findIntegration(id);
      const others = [r9Svc, quotaPerSecond, expiresAt].some((value) => value !== undefined);
      const stationOwner = stations.find((entry) => entry.id === integration.stationId).owner;
      const mayStop = (status === "paused" || status === "revoked") && !others;
      if (integration.owner !== actor && !(mayStop && stationOwner === actor)) fail(403, "forbidden");
      if (integration.status === "revoked") {
        if (status === "revoked" && !others) return listed(integration);
        fail(409, "revoked");
      }
      if (status !== undefined && !["active", "paused", "revoked"].includes(status)) fail(400, "invalid_request");
      if (r9Svc !== undefined && r9Svc !== null && !/^[0-9a-f]{64}$/.test(r9Svc)) fail(400, "invalid_request");
      if (quotaPerSecond !== undefined && !(Number.isInteger(quotaPerSecond) && quotaPerSecond >= 1 && quotaPerSecond <= 10000)) fail(400, "invalid_request");
      const expiry = expiresAt === undefined ? undefined : checkExpiry(expiresAt);
      if (status !== undefined) integration.status = status;
      if (r9Svc !== undefined) integration.r9Svc = r9Svc;
      if (quotaPerSecond !== undefined) integration.quotaPerSecond = quotaPerSecond;
      if (expiry !== undefined) integration.expiresAt = expiry;
      return listed(integration);
    }
  };
  return auth;
}
