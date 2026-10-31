import { ManageError } from "../../scripts/integrations/auth-manage.mjs";

const DAY = 86400000;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];
// The report client a seeded built-in Station gets at Auth: s- and 26 lower-case Crockford characters.
export const BUILT_IN_REPORT_CLIENT = "s-" + "0".repeat(24) + "bs";

// An in-memory Auth /manage/v1 following the actor rules of Auth's docs/integrating.md, including built-in Stations
// (seedBuiltIn): listed first for every account, with no owner or members (409 built_in), integrations only while
// switched on (409 not_supported), and admins who may pause or revoke others' integrations on them. `failNext` makes
// the next call of that name fail with the given status and code (after the gate, so the call is still recorded).
export function fakeManage({ now = Date.now } = {}) {
  const stations = [];
  const integrations = [];
  let next = 0;
  let nextIntegration = 0;
  const valid = (account) => typeof account === "string" && /^ab[0-9A-HJKMNP-TV-Z]{26}$/.test(account);
  const fail = (status, code) => { throw new ManageError(status, code); };
  const uses = (station, account) => station.builtIn || station.owner === account || station.members.some((member) => member.account === account);
  const notBuiltIn = (station) => { if (station.builtIn) fail(409, "built_in"); return station; };
  const listedStation = ({ id, origin, owner, status, reportClientId, createdAt, builtIn, access, integrations: enabled, name }) => ({ id, origin, owner, status, reportClientId, createdAt, builtIn, access, integrations: enabled, name });
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
    // A built-in Station as Auth seeds it from its clients file. Not a management call, so it is not recorded.
    seedBuiltIn({ id = "stbuiltin", origin = "https://station.agora.test", name = "Agora Station", integrations: enabled = false, admins = [], reportClientId = BUILT_IN_REPORT_CLIENT } = {}) {
      const station = { id, origin, owner: null, status: "active", reportClientId, createdAt: new Date(now() - 2000).toISOString(), members: [], builtIn: true, access: "any_account", integrations: enabled, name, admins: [...admins] };
      stations.push(station);
      return station;
    },
    async registerStation({ origin, owner, reportKey, actor }) {
      await auth.gate("registerStation", actor, owner);
      if (actor !== owner) fail(403, "forbidden");
      if (!reportKey || typeof reportKey !== "object") fail(400, "jwk");
      if (stations.some((entry) => entry.origin === origin && entry.status === "active")) fail(409, "origin_taken");
      next += 1;
      const station = { id: "st" + next, origin, owner, status: "active", reportClientId: "s-st" + next, createdAt: new Date(Date.now() - 1000).toISOString(), members: [], builtIn: false, access: "members", integrations: true, name: null };
      stations.push(station);
      return { id: station.id, origin, owner, status: "active", reportClientId: station.reportClientId };
    },
    async stations(account) {
      await auth.gate("stations", account);
      const active = stations.filter((entry) => entry.status === "active");
      return [...active.filter((entry) => entry.builtIn), ...active.filter((entry) => !entry.builtIn && uses(entry, account))].map(listedStation);
    },
    async removeStation(id, actor) {
      await auth.gate("removeStation", actor);
      const station = notBuiltIn(auth.find(id));
      if (station.owner !== actor) fail(403, "forbidden");
      station.status = "removed";
      auth.revokeWhere((integration) => integration.stationId === id);
    },
    async members(id, actor) {
      await auth.gate("members", actor);
      const station = notBuiltIn(auth.find(id));
      if (!uses(station, actor)) fail(403, "forbidden");
      return { owner: station.owner, members: station.members.map((member) => ({ ...member })) };
    },
    async addMember(id, account, actor) {
      await auth.gate("addMember", actor, account);
      const station = notBuiltIn(auth.find(id));
      if (station.owner !== actor) fail(403, "forbidden");
      if (!station.members.some((member) => member.account === account)) station.members.push({ account, addedAt: new Date().toISOString() });
    },
    async removeMember(id, account, actor) {
      await auth.gate("removeMember", actor, account);
      const station = notBuiltIn(auth.find(id));
      if (station.owner !== actor && account !== actor) fail(403, "forbidden");
      station.members = station.members.filter((member) => member.account !== account);
      auth.revokeWhere((integration) => integration.stationId === id && integration.owner === account);
    },
    async createIntegration({ owner, stationId, name, scopes, publicJwk, r9Svc = null, quotaPerSecond = 200, expiresAt, actor }) {
      await auth.gate("createIntegration", actor, owner);
      if (actor !== owner) fail(403, "forbidden");
      const station = stations.find((entry) => entry.id === stationId && entry.status === "active");
      if (station?.builtIn && !station.integrations) fail(409, "not_supported");
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
      const station = stations.find((entry) => entry.id === integration.stationId);
      // The Station-owner rights: the owner of a custom Station, the configured admins of a built-in one.
      const stationRights = station.builtIn ? station.admins : [station.owner];
      const mayStop = (status === "paused" || status === "revoked") && !others;
      if (integration.owner !== actor && !(mayStop && stationRights.includes(actor))) fail(403, "forbidden");
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
