// HTTP routes for Stations and integrations, and the stack behind them (the Portal database, Auth's management API and
// the service). The browser calls /api/stations… and /api/integrations…; apps and Stations call the /api/v1 routes.
import { ACCOUNT_ID, AppError } from "../store.mjs";
import { TokenError } from "../idp.mjs";
import { createManageClient } from "./auth-manage.mjs";
import { createDatabase } from "./db.mjs";
import { createStationFetch } from "./proof.mjs";
import { createRepository } from "./repository.mjs";
import { createIntegrationService } from "./service.mjs";

const ID = "[A-Za-z0-9_-]{1,64}";
const STATION = new RegExp("^/api/stations/(" + ID + ")(?:/(members|read-token)(?:/([^/]+))?)?$");
const INTEGRATION = new RegExp("^/api/integrations/(" + ID + ")/(keys|pause|resume|revoke|renew|settings|events|approval)$");
const PARTITION_INTERVAL = 3600000;

export const integrationPath = (path) => /^\/api\/(stations|integrations)(\/|$)/.test(path);

// The stack for a ready service (tests): nothing to prepare or close.
export const readyIntegrations = (service) => ({ service, ready: async () => service, close: async () => {} });

// The service over `db`. ready() migrates and creates the event partitions before the first request, once; a failure
// answers 503 and the next request tries again. The partitions are then kept up hourly. `stationFetch` (proof of
// control) and `pushFetch` (change nudges) are only given by tests; production uses the guarded defaults.
export function createIntegrationStack({ db, manage, idp, log, stationFetch = createStationFetch(), pushFetch }) {
  const exchange = (idToken, origin) => idp ? idp.exchangeForStation(idToken, origin) : Promise.reject(new TokenError(503, "unavailable"));
  const service = createIntegrationService({ repository: createRepository(db), db, manage, stationFetch, pushFetch, exchange, log });
  let pending = null;
  let prepared = false;
  const partitions = setInterval(() => {
    if (prepared) db.ensureEventPartitions().catch((error) => log("Integration event partitions failed: " + (error.code || "error") + "."));
  }, PARTITION_INTERVAL);
  partitions.unref();
  function ready() {
    pending ||= (async () => {
      await db.migrate();
      await db.ensureEventPartitions();
      prepared = true;
      return service;
    })().catch((error) => {
      pending = null;
      log("Portal database is not ready: " + (error.code || "error") + ".");
      throw new AppError(503, "Stations and integrations are unavailable right now. Try again shortly.");
    });
    return pending;
  }
  return { service, ready, close: async () => { clearInterval(partitions); await db.close(); } };
}

// The stack from the environment: only with DATABASE_URL, and null (logged once, by setting name) when Auth's settings
// are missing or invalid. Tests may pass `stationFetch` and `pushFetch` (see createIntegrationStack).
export function integrationsFromEnv(env, { idp, log, stationFetch, pushFetch }) {
  if (!env.DATABASE_URL) return null;
  let manage;
  try {
    const missing = ["AUTH_ISSUER", "PORTAL_CLIENT_SECRET"].filter((name) => !env[name]);
    if (missing.length) throw new TypeError("set " + missing.join(", "));
    manage = createManageClient({ issuer: env.AUTH_ISSUER, clientId: env.PORTAL_CLIENT_ID || "portal", clientSecret: env.PORTAL_CLIENT_SECRET });
  } catch (error) {
    log("Stations and integrations are unavailable: " + (error instanceof TypeError ? error.message : "their settings are invalid") + ".");
    return null;
  }
  return createIntegrationStack({ db: createDatabase(env.DATABASE_URL, { log }), manage, idp, log, stationFetch, pushFetch });
}

// Maps HTTP requests to the integration service. Returns null when the request is not an integration route. `caller`
// is the verified bearer (only ever on the v1 routes; serve.mjs refuses it elsewhere), `scoped(scope)` checks its scope
// and returns its account, and `idToken()` reads the browser session's ID token.
export async function handleIntegrations({ path, method, url, read, service, caller, scoped, invalidToken, portalUser, idToken, limit }) {
  if (!integrationPath(path)) return null;
  if (!service) throw new AppError(503, "Stations and integrations need the Portal database.");
  const ok = (body) => ({ status: 200, body });
  // A Station's own client: the station.report scope, then a Station report client ID (s-…).
  const reporter = () => {
    if (!caller) throw invalidToken("Station reports need an auth.agora.build access token.");
    scoped("station.report");
    if (!caller.clientId.startsWith("s-")) throw new AppError(403, "This token is not a Station report token.");
    return caller.clientId;
  };

  if (path === "/api/stations/reports" && method === "POST") {
    const clientId = reporter(); limit("reports:" + clientId, 600, 60000);
    return ok(await service.report(clientId, await read()));
  }
  if (path === "/api/stations/changes" && method === "GET") {
    const clientId = reporter(); limit("changes:" + clientId, 120, 60000);
    return ok(await service.changes(clientId, url.searchParams.get("cursor") ?? "0"));
  }
  if (path === "/api/integrations" && method === "GET") return ok(await service.integrations(caller ? scoped("integrations:read") : await portalUser()));
  const integration = INTEGRATION.exec(path);
  if (integration?.[2] === "approval" && method === "POST") {
    if (!caller) throw invalidToken("Approving an integration needs an auth.agora.build access token.");
    const accountId = scoped("integrations:approve");
    return ok(await service.approve(accountId, integration[1], { r9Svc: (await read()).r9Svc }));
  }

  // Everything below is for the browser session only.
  if (path === "/api/stations" && method === "GET") return ok(await service.stations(await portalUser()));
  if (path === "/api/stations/challenges" && method === "POST") {
    const accountId = await portalUser();
    return { status: 201, body: await service.createChallenge(accountId, (await read()).origin) };
  }
  if (path === "/api/stations" && method === "POST") {
    const accountId = await portalUser(); limit("stations:" + accountId, 10, 60000);
    const { challengeId, reportKey } = await read();
    return { status: 201, body: await service.registerStation(accountId, { challengeId, reportKey }) };
  }
  if (path === "/api/integrations" && method === "POST") {
    const accountId = await portalUser(); limit("integrations:" + accountId, 20, 60000);
    return { status: 201, body: await service.createIntegration(accountId, await read()) };
  }
  const station = STATION.exec(path);
  if (station) {
    const [, id, action, member] = station;
    if (member !== undefined) {
      if (action !== "members" || !ACCOUNT_ID.test(member)) return null;
      if (method === "PUT") { await service.share(await portalUser(), id, member); return ok({ shared: true }); }
      if (method === "DELETE") { await service.unshare(await portalUser(), id, member); return ok({ unshared: true }); }
      return null;
    }
    if (!action && method === "DELETE") { await service.removeStation(await portalUser(), id); return ok({ removed: true }); }
    if (action === "members" && method === "GET") return ok(await service.members(await portalUser(), id));
    if (action === "read-token" && method === "POST") {
      const accountId = await portalUser(); limit("read-token:" + accountId, 30, 60000);
      return ok(await service.readToken(accountId, await idToken(), id));
    }
    return null;
  }
  if (!integration) return null;
  const [, id, action] = integration;
  if (action === "events") return method === "GET" ? ok(await service.history(await portalUser(), id)) : null;
  if (method !== "POST") return null;
  const accountId = await portalUser();
  if (action === "pause" || action === "resume" || action === "revoke") return ok(await service[action](accountId, id));
  if (action === "keys") return { status: 201, body: await service.rotateKey(accountId, id, { publicJwk: (await read()).publicJwk }) };
  if (action === "renew") return ok(await service.renew(accountId, id, { expiresInDays: (await read()).expiresInDays }));
  if (action === "settings") return ok(await service.settings(accountId, id, { quotaPerSecond: (await read()).quotaPerSecond }));
  return null;
}
