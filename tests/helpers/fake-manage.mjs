import { ManageError } from "../../scripts/integrations/auth-manage.mjs";

const DAY = 86400000;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];
// The report client a seeded built-in Station gets at Auth: s- and 26 lower-case Crockford characters.
export const BUILT_IN_REPORT_CLIENT = "s-" + "0".repeat(24) + "bs";

// An in-memory Auth /manage/v1 following the actor rules of Auth's docs/integrating.md, including built-in Stations
// (seedBuiltIn): listed first for every account, with no owner or members (409 built_in), integrations only while
// switched on (409 not_supported), and admins, who have no rights on them through the Portal (Auth D26 R12). `feed` is
// Auth's change feed (integrationChanges): every status change and owner account change, whoever made it; adminChange,
// systemRevoke and setOwnerDisabled stand in for the admin site's calls and Auth's own changes, and call `onNudge` as
// Auth nudges the Portal (Auth D26 Task 13). `failNext` makes the next call of that name fail with the given status and
// code (after the gate, so the call is still recorded).
export function fakeManage({ now = Date.now } = {}) {
  const stations = [];
  const integrations = [];
  // Accounts an admin has disabled (setOwnerDisabled): Auth refuses them as actor.
  const disabledAccounts = new Set();
  let next = 0;
  let nextIntegration = 0;
  const valid = (account) => typeof account === "string" && /^ab[0-9A-HJKMNP-TV-Z]{26}$/.test(account);
  const fail = (status, code) => { throw new ManageError(status, code); };
  const uses = (station, account) => station.builtIn || station.owner === account || station.members.some((member) => member.account === account);
  const notBuiltIn = (station) => { if (station.builtIn) fail(409, "built_in"); return station; };
  const listedStation = ({ id, origin, owner, status, reportClientId, createdAt, builtIn, access, integrations: enabled, name }) => ({ id, origin, owner, status, reportClientId, createdAt, builtIn, access, integrations: enabled, name });
  const listed = ({ keys, ...integration }) => ({ ...integration, scopes: [...integration.scopes], pausedBy: integration.status === "paused" ? integration.pausedBy ?? null : null });
  const checkKey = (publicJwk) => {
    if (!publicJwk || typeof publicJwk !== "object") fail(400, "jwk");
    if (PRIVATE_MEMBERS.some((member) => Object.hasOwn(publicJwk, member))) fail(400, "private_key");
  };
  const checkExpiry = (expiresAt) => {
    const at = new Date(expiresAt).getTime();
    if (!Number.isFinite(at) || at <= now() || at > now() + 90 * DAY) fail(400, "expiry");
    return new Date(at).toISOString();
  };
  // Auth's change feed (Auth D26 R25): one entry per change to an integration's access, oldest first, with an opaque
  // cursor as Auth hands it out.
  const feed = [];
  const feedCursor = (n) => Buffer.from("c" + n, "utf8").toString("base64url");
  function recordChange(integration, kind, { actor = null, reason = null, admin = false } = {}) {
    feed.push({
      cursor: feedCursor(feed.length + 1), at: new Date(now()).toISOString(), kind, clientId: integration.clientId, stationId: integration.stationId,
      owner: integration.owner, status: integration.status, pausedBy: integration.status === "paused" ? integration.pausedBy ?? null : null,
      actorAccountId: actor, reason, admin
    });
  }
  const statusKind = (status) => (status === "paused" ? "paused" : status === "revoked" ? "revoked" : "resumed");
  const auth = {
    down: false,
    calls: [],
    failNext: {},
    records: stations,
    integrationRecords: integrations,
    feed,
    onNudge: null,
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
    // A management call: recorded, refused while Auth is down, then `check` (the actor rules), then a failNext.
    async open(name, check = () => {}) {
      auth.calls.push(name);
      if (auth.down) fail(503, "unavailable");
      check();
      const failure = auth.failNext[name];
      if (failure) {
        delete auth.failNext[name];
        fail(failure.status, failure.code);
      }
    },
    // A call naming an actor (and maybe other accounts): each must be well-formed, and the actor not disabled, or Auth
    // answers 400 invalid_request.
    async gate(name, actor, ...accounts) {
      await auth.open(name, () => { if (![actor, ...accounts].every(valid) || disabledAccounts.has(actor)) fail(400, "invalid_request"); });
    },
    // A listing for an account (?account=), which Auth answers for a disabled account too.
    async listing(name, account) {
      await auth.open(name, () => { if (!valid(account)) fail(400, "invalid_request"); });
    },
    revokeWhere(pick, by = {}) {
      for (const integration of integrations) {
        if (!pick(integration) || integration.status === "revoked") continue;
        integration.status = "revoked";
        integration.pausedBy = null;
        recordChange(integration, "revoked", by);
      }
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
      await auth.listing("stations", account);
      const active = stations.filter((entry) => entry.status === "active");
      return [...active.filter((entry) => entry.builtIn), ...active.filter((entry) => !entry.builtIn && uses(entry, account))].map(listedStation);
    },
    // GET /manage/v1/built-in-stations: the active built-in Stations, for any management client, naming no account.
    async builtInStations() {
      await auth.open("builtInStations");
      return stations.filter((entry) => entry.builtIn && entry.status === "active").map(listedStation);
    },
    async removeStation(id, actor) {
      await auth.gate("removeStation", actor);
      const station = notBuiltIn(auth.find(id));
      if (station.owner !== actor) fail(403, "forbidden");
      station.status = "removed";
      auth.revokeWhere((integration) => integration.stationId === id, { actor, reason: "station_removed" });
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
      // As at Auth, the account's integrations there are revoked only if it was a member.
      const member = station.members.some((entry) => entry.account === account);
      station.members = station.members.filter((entry) => entry.account !== account);
      if (member) auth.revokeWhere((integration) => integration.stationId === id && integration.owner === account, { actor, reason: "member_removed" });
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
      await auth.listing("integrations", account);
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
      // The Station-owner right: the owner of a custom Station may pause or revoke. A built-in Station's admins act
      // through Auth's admin client only (Auth D26 R12): through the Portal an admin is just another account.
      const stationRights = station.builtIn ? [] : [station.owner];
      const mayStop = (status === "paused" || status === "revoked") && !others;
      if (integration.owner !== actor && !(mayStop && stationRights.includes(actor))) fail(403, "forbidden");
      // An admin's pause locks (Auth D26 R28): resuming it is 409 admin_paused for anyone but an admin, with or without
      // other fields; only Auth's admin client lifts it.
      if (status === "active" && integration.status === "paused" && integration.pausedBy === "admin") fail(409, "admin_paused");
      if (integration.status === "revoked") {
        if (status === "revoked" && !others) return listed(integration);
        fail(409, "revoked");
      }
      if (status !== undefined && !["active", "paused", "revoked"].includes(status)) fail(400, "invalid_request");
      if (r9Svc !== undefined && r9Svc !== null && !/^[0-9a-f]{64}$/.test(r9Svc)) fail(400, "invalid_request");
      if (quotaPerSecond !== undefined && !(Number.isInteger(quotaPerSecond) && quotaPerSecond >= 1 && quotaPerSecond <= 10000)) fail(400, "invalid_request");
      const expiry = expiresAt === undefined ? undefined : checkExpiry(expiresAt);
      // Who paused it (Auth D26 R27): its owner or its custom Station's owner; pausing an admin's pause changes nothing.
      if (status !== undefined && status !== integration.status) {
        integration.status = status;
        integration.pausedBy = status === "paused" ? (integration.owner === actor ? "owner" : "station") : null;
        recordChange(integration, statusKind(status), { actor });
      }
      if (r9Svc !== undefined) integration.r9Svc = r9Svc;
      if (quotaPerSecond !== undefined) integration.quotaPerSecond = quotaPerSecond;
      if (expiry !== undefined) integration.expiresAt = expiry;
      return listed(integration);
    },
    // An Agora.Build admin's change through Auth's admin client (the admin site): pause, revoke, or lift an admin's
    // pause, on a built-in Station the admin administers, with a reason; in the feed with admin: true, then Auth's
    // nudge. Resuming an active integration and revoking a revoked one change nothing, as at Auth. Not a Portal call,
    // so it is not recorded in calls.
    adminChange(id, { status, actor, reason = "Admin test" }) {
      const integration = auth.findIntegration(id);
      const station = stations.find((entry) => entry.id === integration.stationId);
      const lifts = status === "active" && ((integration.status === "paused" && integration.pausedBy === "admin") || integration.status === "active");
      if (!station.builtIn || !station.admins.includes(actor) || !(status === "paused" || status === "revoked" || lifts)) fail(403, "forbidden");
      if (integration.status === "revoked") {
        if (status === "revoked") return listed(integration);
        fail(409, "revoked");
      }
      const converts = status === "paused" && integration.status === "paused" && integration.pausedBy !== "admin";
      if (status === integration.status && !converts) return listed(integration);
      integration.status = status;
      integration.pausedBy = status === "paused" ? "admin" : null;
      recordChange(integration, statusKind(status), { actor, reason, admin: true });
      auth.onNudge?.();
      return listed(integration);
    },
    // Auth's own change (no actor): a built-in Station retired by its clients file revokes its integrations.
    systemRevoke(id, reason = "configuration") {
      const integration = auth.findIntegration(id);
      if (integration.status === "revoked") return;
      integration.status = "revoked";
      integration.pausedBy = null;
      recordChange(integration, "revoked", { reason });
      auth.onNudge?.();
    },
    // An admin disabling or enabling an account: Auth then refuses it as actor, or accepts it again, and writes one
    // owner_disabled or owner_enabled entry per integration it owns that is not revoked, each with that integration's
    // status (Auth D26 R24).
    setOwnerDisabled(account, disabled, { actor = null, reason = null } = {}) {
      if (disabled) disabledAccounts.add(account);
      else disabledAccounts.delete(account);
      let written = 0;
      for (const integration of integrations) {
        if (integration.owner !== account || integration.status === "revoked") continue;
        recordChange(integration, disabled ? "owner_disabled" : "owner_enabled", { actor, reason, admin: actor !== null });
        written += 1;
      }
      if (written) auth.onNudge?.();
    },
    // GET /manage/v1/integration-changes (the Portal only): oldest first, after a cursor it handed out. As at Auth, the
    // newest cursor answers no changes and itself, and one beyond the newest change (Auth restored from an earlier
    // backup) is 409 cursor_ahead.
    async integrationChanges({ after, limit = 100 } = {}) {
      await auth.open("integrationChanges");
      let start = 0;
      if (after !== undefined && after !== null) {
        const place = /^c([1-9][0-9]*)$/.exec(Buffer.from(String(after), "base64url").toString("utf8"));
        if (!place || feedCursor(Number(place[1])) !== after) fail(400, "invalid_request");
        start = Number(place[1]);
        if (start > feed.length) fail(409, "cursor_ahead");
      }
      const changes = feed.slice(start, start + limit).map((entry) => ({ ...entry }));
      return { changes, nextCursor: changes.length ? changes.at(-1).cursor : after ?? null };
    }
  };
  return auth;
}
