import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ACCOUNT_ID, AppError, createStore, text } from "./store.mjs";
import { basicSearch, createModelClient, modelConfig } from "./models.mjs";
import { createActivityFeed } from "./activity.mjs";
import { createAgoraCalls } from "./calls.mjs";
import { createIdp, LoginError, TokenError } from "./idp.mjs";
import { cleanPagePath, pages, returnPath, withSignin } from "./return-path.mjs";
import { billingClients as parseBillingClients, loadBillingClients, priceFor } from "./billing-clients.mjs";
import { createCredits } from "./credits.mjs";
import { createLedger } from "./ledger.mjs";
import { createBilling } from "./billing.mjs";
import { ConnectError, createConnections } from "./connections.mjs";
import { createPostgresPersistence } from "./persistence.mjs";
import { createSignaling, signalingConfig } from "./spaces/signaling.mjs";
import { createSpaces, loadWorlds } from "./spaces/service.mjs";
import { handleSpaces } from "./spaces/routes.mjs";
import { handleIntegrations, integrationPath, integrationsFromEnv, readyIntegrations } from "./integrations/routes.mjs";
import { loadThemes } from "./spaces/themes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Vendored browser SDKs are served from node_modules in development and from dist/assets after a build.
const vendor = { "assets/agora-rtc.js": createRequire(import.meta.url).resolve("agora-rtc-sdk-ng"), "assets/agora-rtm.js": createRequire(import.meta.url).resolve("agora-rtm-sdk") };
const publicFiles = new Set(["index.html", "explore.html", "marketplaces.html", "radar.html", "account.html", "account.js", "integrations.js", "stoa.html", "stoa.js", "world/map.js", "world/kinds.js", "world/themes.js", "world/camera.js", "world/motion.js", "world/renderer-canvas.js", "world/engine.js", "world/sdk.js", "world/rtc-client.js", "stoa/panel.js", "stoa/stage.js", "stoa/call.js", "stoa/decor.js", "stoa/place.js", "stoa/lease.js", "stoa/spaces.js", "world/protocol.js", "world/crypto.js", "world/signaling.js", "world/presence.js", "styles.css", "script.js", "people.js", "activity.js", "explore.js", "marketplaces.js", "radar.js", "assets/agora-rtc.js", "assets/agora-rtm.js", "assets/favicon.svg", "assets/guohai.jpg"]);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg" };

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  response.end(JSON.stringify(body));
}
async function body(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new AppError(415, "Send JSON for this request.");
  if (Number(request.headers["content-length"]) > 16384) throw new AppError(413, "This request is too large.");
  let content = "";
  for await (const chunk of request) {
    content += chunk;
    if (Buffer.byteLength(content) > 16384) throw new AppError(413, "This request is too large.");
  }
  try {
    const data = JSON.parse(content);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new AppError(400, "This request is not valid JSON."); }
}
const cookieValue = (request, name) => request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1) || "";
const redirect = (response, location, cookies = []) => { response.writeHead(303, { Location: location, "Cache-Control": "no-store", ...(cookies.length ? { "Set-Cookie": cookies } : {}) }); response.end(); };
async function formBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) throw new AppError(400, "This request requires form data.");
  let content = "";
  for await (const chunk of request) {
    content += chunk;
    if (Buffer.byteLength(content) > 16384) throw new AppError(413, "This request is too large.");
  }
  return new URLSearchParams(content);
}
// Bearer failures carry RFC 6750 WWW-Authenticate headers.
const invalidToken = (message = "A valid auth.agora.build access token is required.") => Object.assign(new AppError(401, message), { headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } });
const insufficientScope = (scope) => Object.assign(new AppError(403, "This access token needs the " + scope + " scope."), { headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="' + scope + '"' } });
const browserOnly = () => new AppError(403, "This feature needs a browser session on the Agora.Build website; access tokens are not accepted here.");
// Reads that need no caller; a valid access token is allowed on them but changes nothing.
const publicRoutes = new Set(["GET /api/people", "GET /api/activity", "GET /api/projects", "GET /api/marketplaces", "GET /api/billing/catalog", "GET /api/auth/config", "POST /api/people/search", "GET /api/themes"]);
// Routes that accept an auth.agora.build access token (each checks its own scope). Apps call them under /api/v1/, the
// versioned API (https://agora.build/api/v1/...): v1 may gain fields but never loses or renames any; a breaking change
// becomes /api/v2/. The browser calls the same handlers at /api/..., which carry no version and accept no tokens here.
export const API_V1 = "/api/v1/";
const bearerRoutes = new Set(["GET /api/me", "GET /api/credits/balance", "GET /api/credits/statement", "POST /api/marketplaces/chat", "POST /api/marketplaces/tts", "GET /api/connections", "GET /api/connections/agora/projects", "POST /api/connections/agora/certificate", "POST /api/connections/agora/token", "DELETE /api/connections/agora", "POST /api/platform/credits/reserve", "POST /api/platform/credits/settle", "GET /api/integrations", "POST /api/stations/reports", "GET /api/stations/changes"]);
const bearerPatterns = [/^POST \/api\/integrations\/[A-Za-z0-9_-]{1,64}\/approval$/];
const isBearerRoute = (route) => bearerRoutes.has(route) || bearerPatterns.some((pattern) => pattern.test(route));
// Routes that exist for the browser session only; a bearer token there gets 403, and on any other path 404.
const browserRoutes = new Set(["GET /api/billing/account", "POST /api/billing/checkout", "POST /api/billing/manage", "POST /api/profile", "PUT /api/profile", "DELETE /api/profile", "GET /api/radar", "POST /api/radar", "POST /api/auth/logout", "POST /api/signaling/token"]);
// Over https the session cookie was renamed from house_session to __Host-house_session. Until this date a guest's
// legacy cookie (a guest browser-profile session, never an account session) is accepted once and re-issued under the
// new name; after it, the legacy cookie is ignored. Accounts' sessions started empty with this change, so none exist.
export const LEGACY_GUEST_COOKIE_UNTIL = Date.parse("2027-01-31T00:00:00Z");
const browserRoute = (route, path) => browserRoutes.has(route) || path === "/api/spaces" || path.startsWith("/api/spaces/") || path.startsWith("/api/worlds/") || integrationPath(path);
// The auth.agora.build client from the environment, or null (logged once, by setting name) when its settings are missing or invalid.

// PLATFORM_ADMINS lists auth.agora.build account IDs (ab…). Anything else, such as an old acct_… ID, is ignored and
// counted in the log, never echoed.
export function platformAdmins(value = "", log = () => {}) {
  const listed = String(value || "").split(",").map((id) => id.trim()).filter(Boolean);
  const admins = listed.filter((id) => ACCOUNT_ID.test(id));
  if (admins.length < listed.length) log("PLATFORM_ADMINS: ignored " + (listed.length - admins.length) + " entr" + (listed.length - admins.length === 1 ? "y" : "ies") + " that are not auth.agora.build account IDs.");
  return admins;
}
export function idpFromEnv(env = process.env, log = (line) => console.log(line)) {
  try {
    return createIdp({ issuer: env.AUTH_ISSUER, clientId: env.PORTAL_CLIENT_ID || "portal", clientSecret: env.PORTAL_CLIENT_SECRET, siteUrl: env.SITE_URL, audience: env.PORTAL_API_AUDIENCE || undefined });
  } catch (error) {
    log("Sign-in through auth.agora.build is unavailable: " + (error instanceof TypeError ? error.message : "its settings are invalid") + ".");
    return null;
  }
}

export function createAppServer(directory = root, options = {}) {
  const dataDirectory = options.dataDirectory || resolve(directory, "data");
  const persistence = !options.store && !options.storageFile && process.env.DATABASE_URL ? createPostgresPersistence(process.env.DATABASE_URL) : null;
  const store = options.store || createStore(resolve(dataDirectory, "people.json"), options.storageFile || resolve(root, ".data/community.json"), { persistence });
  const calls = options.calls || createAgoraCalls();
  const log = options.log || ((line) => console.log(line));
  const idp = "idp" in options ? options.idp : idpFromEnv(process.env, log);
  // Discovery and the JWKS are fetched now, without blocking startup, so a back-channel logout (one POST with a 2.5 s
  // timeout, never retried) doesn't wait for a cold fetch. Failures are logged by reason only.
  idp?.warm?.().then((reason) => { if (reason) log("auth.agora.build warm-up failed: " + reason + "."); }, () => log("auth.agora.build warm-up failed: error."));
  const siteUrl = options.siteUrl ?? process.env.SITE_URL ?? "";
  const clock = options.now || Date.now;
  // Behind a proxy that appends X-Forwarded-For (TRUST_PROXY=1), the client is the last hop, the one that proxy added;
  // anything before it is client-supplied. Otherwise it is the socket address. Every IP-keyed limit uses this.
  const trustProxy = (options.trustProxy ?? process.env.TRUST_PROXY) === "1";
  const clientAddress = (request) => (trustProxy && String(request.headers["x-forwarded-for"] || "").split(",").map((hop) => hop.trim()).filter(Boolean).at(-1)) || request.socket.remoteAddress;
  // Platform billing clients and their server-side prices; null turns platform billing off.
  const billingClients = "billingClients" in options ? (options.billingClients && parseBillingClients(options.billingClients)) : loadBillingClients(process.env.PORTAL_BILLING_FILE, log);
  const ledger = createLedger(store);
  const credits = options.credits || createCredits(undefined, { ledger });
  const billing = options.billing || createBilling(store);
  const connections = options.connections || createConnections(store, undefined, { log });
  // Connecting Agora Console needs the AGORA_SSO_* settings; without them it is unavailable, logged by setting name only.
  if (connections.config.connect && !connections.config.connect.ready) log("Agora Console connect is unavailable: set " + connections.config.connect.missing.join(", ") + ".");
  const models = options.models || createModelClient(modelConfig());
  const activity = options.activity || createActivityFeed({ store, projectsFile: resolve(dataDirectory, "projects.json"), snapshotFile: resolve(dataDirectory, "activity.json") });
  const worlds = options.worlds || loadWorlds(directory);
  const themes = options.themes || loadThemes(directory);
  const signaling = options.signaling || createSignaling(signalingConfig());
  const spaces = options.spaces || createSpaces({ store, worlds, signaling, calls, secret: options.channelSecret ?? signalingConfig().secret, admins: platformAdmins(process.env.PLATFORM_ADMINS, log), plazaCapacity: options.plazaCapacity });
  // Stations and integrations: a ready service (tests), null (off), or built from DATABASE_URL; without it every
  // integration route answers 503.
  const integrations = "integrations" in options ? (options.integrations && readyIntegrations(options.integrations)) : integrationsFromEnv(process.env, { idp, log });
  const windows = new Map();
  const scanning = new Set();
  const radarHours = Math.max(1, Number(process.env.RADAR_INTERVAL_HOURS) || 24);
  let globalWindow = { start: Date.now(), count: 0 };

  function limit(key, max, duration) {
    const now = Date.now();
    if (windows.size > 1000) for (const [id, bucket] of windows) if (now > bucket.end) windows.delete(id);
    const bucket = windows.get(key);
    if (!bucket || now >= bucket.end) windows.set(key, { count: 1, end: now + duration });
    else if (bucket.count >= max) throw new AppError(429, "A few too many requests. Please try again in a moment.");
    else bucket.count += 1;
  }
  function allowance(request) {
    if (request) limit("model:" + clientAddress(request), 6, 60000);
    if (Date.now() - globalWindow.start >= 3600000) globalWindow = { start: Date.now(), count: 0 };
    if (globalWindow.count >= (options.modelLimit || Number(process.env.MODEL_REQUESTS_PER_HOUR) || 60)) throw new AppError(429, "The house has used its service allowance for this hour. Please try again later.");
    globalWindow.count += 1;
  }
  async function scan(person) {
    if (scanning.has(person.id)) throw new AppError(409, "Your radar is already looking. Give it a moment.");
    scanning.add(person.id);
    try {
      return await store.saveRadar(person.id, await models.research(person), person.intent);
    } catch (error) {
      await store.saveRadar(person.id, { items: [], error: error.status ? error.message : "The radar could not complete its scan." }, person.intent);
      throw error;
    } finally { scanning.delete(person.id); }
  }

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://localhost");
      // /api/v1/<route> is the versioned app API: only the bearer routes exist there, served by the /api/<route> handlers.
      const versioned = requestUrl.pathname.startsWith(API_V1);
      const path = versioned ? "/api/" + requestUrl.pathname.slice(API_V1.length) : requestUrl.pathname;
      if (versioned && !isBearerRoute(request.method + " " + path)) throw new AppError(404, "This API was not found. See https://github.com/Agora-Build/Portal/blob/main/docs/platform.md for the /api/v1 routes.");
      const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7).trim() : "";
      const secure = siteUrl.startsWith("https:") || Boolean(request.socket.encrypted);
      const sessionName = secure ? "__Host-house_session" : "house_session";
      let cookieToken = cookieValue(request, sessionName);
      const sessionCookie = (value, maxAge = 30 * 86400) => sessionName + "=" + value + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + maxAge + (secure ? "; Secure" : "");
      if (secure && !cookieToken && clock() < LEGACY_GUEST_COOKIE_UNTIL) {
        const legacy = cookieValue(request, "house_session");
        if (legacy && await store.guestToken(legacy)) {
          cookieToken = legacy;
          // The upgrade cookies go first, so a cookie the route sets for the same name wins.
          const upgrade = [sessionCookie(legacy), "house_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure"];
          const writeHead = response.writeHead.bind(response);
          response.writeHead = (status, headers = {}) => writeHead(status, { ...headers, "Set-Cookie": [...upgrade, ...[].concat(headers["Set-Cookie"] || [])] });
        }
      }
      const browserToken = cookieToken && await store.browserToken(cookieToken) ? cookieToken : "";
      const transactionName = secure ? "__Host-portal_auth" : "portal_auth";
      const transactionCookie = (value, maxAge = 600) => transactionName + "=" + value + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + maxAge + (secure ? "; Secure" : "");
      // A connect in progress has its own cookie, so it never collides with a sign-in in progress.
      const connectName = secure ? "__Host-portal_connect" : "portal_connect";
      const connectCookie = (value, maxAge = 600) => connectName + "=" + value + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + maxAge + (secure ? "; Secure" : "");
      if (path === "/api/billing/webhook" && request.method === "POST") {
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 262144) throw new AppError(413, "Payment event too large."); chunks.push(chunk); }
        json(response, 200, await billing.apply(billing.verify(Buffer.concat(chunks), request.headers["stripe-signature"])));
        return;
      }
      if (path === "/auth/login" && request.method === "GET") {
        limit("login:" + clientAddress(request), 20, 60000);
        const returnTo = returnPath(requestUrl.searchParams.get("returnTo") || "/");
        // prompt=none is the pages' once-per-browser-session check: signed in at auth.agora.build already, or not.
        const silent = requestUrl.searchParams.get("prompt") === "none";
        let started = null;
        if (idp && await idp.available()) {
          try { started = await idp.beginLogin({ returnTo, silent }); }
          catch (error) { if (!(error instanceof LoginError)) throw error; }
        }
        if (!started) { redirect(response, silent ? returnTo : withSignin(returnTo, "unavailable")); return; }
        await store.saveAuthTransaction(started.transaction);
        redirect(response, started.url, [transactionCookie(started.transaction.id)]);
        return;
      }
      if (path === "/auth/callback" && request.method === "GET") {
        // The transaction is consumed whatever happens next, and its cookie is cleared on every path.
        const clear = transactionCookie("", 0);
        let transaction = null;
        try {
          transaction = await store.takeAuthTransaction(cookieValue(request, transactionName));
          if (!idp) throw new LoginError("unavailable");
          const result = await idp.completeLogin(request.url, transaction);
          const { token } = await store.signIn({ sub: result.sub, sid: result.sid, name: result.name, picture: result.picture ?? undefined, email: result.email, idToken: result.idToken, guestToken: cookieToken || undefined });
          redirect(response, transaction.silent ? transaction.returnTo : withSignin(transaction.returnTo, "success"), [clear, sessionCookie(token)]);
        } catch (error) {
          // A silent check never shows a message: not signed in at the IdP is the usual answer, and any other failure
          // leaves the page as it was, with the Sign in button.
          if (!(transaction?.silent && error instanceof LoginError && error.reason === "not_signed_in")) log((transaction?.silent ? "Silent sign-in failed: " : "Sign-in failed: ") + (error instanceof LoginError ? error.reason : "error") + ".");
          redirect(response, transaction?.silent ? transaction.returnTo : withSignin(transaction?.returnTo || "/", "failed"), [clear]);
        }
        return;
      }
      if (path === "/connect/agora" && request.method === "GET") {
        // Authorises Console access for the signed-in account; it never signs anyone in. Browser account sessions only.
        if (request.headers.authorization) throw browserOnly();
        const accountId = (await store.session(browserToken)).account?.id;
        if (!accountId) { redirect(response, "/auth/login?returnTo=%2Faccount%2F"); return; }
        limit("connect:" + accountId, 10, 60000);
        if (!connections.config.connect?.ready) { redirect(response, "/account/?connected=unavailable"); return; }
        const started = connections.beginConnect(accountId);
        await store.saveAuthTransaction(started.transaction);
        redirect(response, started.url, [connectCookie(started.transaction.id)]);
        return;
      }
      if (path === "/connect/agora/callback" && request.method === "GET") {
        // The transaction is consumed whatever happens next, and its cookie is cleared on every path.
        const clear = connectCookie("", 0);
        try {
          const transaction = await store.takeAuthTransaction(cookieValue(request, connectName));
          const accountId = (await store.session(browserToken)).account?.id;
          await connections.completeConnect(transaction, requestUrl.searchParams, accountId);
          redirect(response, "/account/?connected=agora", [clear]);
        } catch (error) {
          log("Agora connect failed: " + (error instanceof ConnectError ? error.reason : "error") + ".");
          redirect(response, "/account/?connected=failed", [clear]);
        }
        return;
      }
      if (path === "/auth/backchannel-logout") {
        // A server-to-server POST from the IdP, so it is the one exemption from the same-origin checks below.
        if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end("Method not allowed"); return; }
        let status = 200;
        try {
          if (!idp) throw new TokenError(503, "unavailable");
          const { sid, sub } = await idp.verifyLogoutToken((await formBody(request)).get("logout_token"));
          if (sid) await store.endSessionsBySid(sid, sub);
          else await store.endSessionsBySub(sub);
        } catch (error) {
          if (!(error instanceof TokenError || error.status)) throw error;
          status = error.status === 503 ? 503 : 400;
          log("Back-channel logout refused: " + (error instanceof TokenError ? error.reason : "request") + ".");
        }
        response.writeHead(status, { "Cache-Control": "no-store" }).end();
        return;
      }
      if (path.startsWith("/api/")) {
        if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) throw new AppError(405, "This method is not supported.");
        // Bearer tokens are not ambient credentials, so only cookie requests need the same-origin checks.
        const withBearer = Boolean(request.headers.authorization?.startsWith("Bearer "));
        if (request.method !== "GET" && !withBearer && request.headers.origin) {
          let host;
          try { host = new URL(request.headers.origin).host; } catch { throw new AppError(403, "Use this feature from the house website."); }
          if (host !== request.headers.host) throw new AppError(403, "Use this feature from the house website.");
        }
        if (request.method !== "GET" && !withBearer && request.headers["sec-fetch-site"] === "cross-site") throw new AppError(403, "Use this feature from the Agora.Build website.");
        // An access token from auth.agora.build; a request that carries one never falls back to the browser cookie.
        let caller = null;
        if (withBearer) {
          if (!idp) throw new AppError(503, "Access tokens can't be checked right now. Try again shortly.");
          try { caller = await idp.verifyAccessToken(bearer); }
          catch (error) {
            if (!(error instanceof TokenError)) throw error;
            if (error.status === 503) throw new AppError(503, "Access tokens can't be checked right now. Try again shortly.");
            throw invalidToken();
          }
        }
        const token = caller ? "" : browserToken;
        const route = request.method + " " + path;
        if (caller && !publicRoutes.has(route) && !isBearerRoute(route)) throw browserRoute(route, path) ? browserOnly() : new AppError(404, "This page or service was not found.");
        if (caller && !versioned && isBearerRoute(route)) throw new AppError(404, "Access tokens use the versioned API: " + API_V1 + path.slice("/api/".length) + ".");
        // Only after the route gate, so a token that reaches a 404, browser-only or public route creates nothing.
        if (caller && isBearerRoute(route)) caller.account = await store.ensureAccount(caller.sub);
        const scoped = (scope) => { if (!caller.scopes.includes(scope)) throw insufficientScope(scope); return caller.sub; };
        const member = async () => {
          const person = await store.me(token);
          if (!person) throw new AppError(401, "Join the house to use this feature.");
          return person;
        };
        // A browser account session; guests are refused.
        const portalUser = async (message = "Sign in to manage your Agora.Build account.") => {
          const current = await store.session(token);
          if (!current.account) throw new AppError(401, message);
          return current.account.id;
        };
        // A browser account session, or a bearer token with the scope.
        const accountUser = (scope, message) => caller ? scoped(scope) : portalUser(message);
        const browserUser = (message) => { if (caller) throw browserOnly(); return portalUser(message); };

        if (path === "/api/people" && request.method === "GET") json(response, 200, { people: await store.people(), smartSearch: models.config.language.ready });
        else if (path === "/api/activity" && request.method === "GET") json(response, 200, await activity.get());
        else if (path === "/api/me" && request.method === "GET") {
          // The email is shown only to the browser session; bearer callers get the account without it.
          if (caller) { const { email, ...account } = caller.account; json(response, 200, { profile: await store.accountProfile(caller.sub), account }); }
          else json(response, 200, { ...await store.session(token), integrationsAvailable: Boolean(integrations) });
        }
        else if (path === "/api/auth/config" && request.method === "GET") json(response, 200, { issuer: idp?.config.issuer || null, accountUrl: idp?.config.accountUrl || null });
        else if (path === "/api/billing/catalog" && request.method === "GET") json(response, 200, await billing.catalog());
        else if (path === "/api/billing/account" && request.method === "GET") json(response, 200, await billing.account(await browserUser()));
        else if (path === "/api/billing/checkout" && request.method === "POST") {
          const userId = await browserUser(); limit("checkout:" + userId, 10, 60000);
          const input = await body(request);
          json(response, 200, await billing.checkout(userId, input.productId, request.headers["idempotency-key"]));
        }
        else if (path === "/api/billing/manage" && request.method === "POST") json(response, 200, await billing.manage(await browserUser()));
        else if (path === "/api/connections" && request.method === "GET") {
          json(response, 200, await connections.status(await accountUser("agora:projects")));
        }
        else if (path === "/api/connections/agora/projects" && request.method === "GET") {
          json(response, 200, await connections.projects(await accountUser("agora:projects")));
        }
        else if (path === "/api/connections/agora/certificate" && request.method === "POST") {
          const userId = await accountUser("agora:certificates"); limit("certificates:" + userId, 20, 60000);
          json(response, 200, await connections.certificate(userId, (await body(request)).projectId));
        }
        else if (path === "/api/connections/agora/token" && request.method === "POST") {
          const userId = await accountUser("agora:tokens"); limit("agora-tokens:" + userId, 60, 60000);
          json(response, 200, await connections.token(userId, await body(request)));
        }
        else if (path === "/api/connections/agora" && request.method === "DELETE") { await connections.disconnect(await accountUser("agora:projects")); json(response, 200, { disconnected: true }); }
        else if (["/api/credits/balance", "/api/credits/statement"].includes(path) && request.method === "GET") {
          const userId = await accountUser("credits", "Sign in to use shared credits.");
          json(response, 200, path.endsWith("balance") ? await credits.balance(userId) : await credits.statement(userId, requestUrl.searchParams.get("cursor")));
        }
        else if (["/api/platform/credits/reserve", "/api/platform/credits/settle"].includes(path) && request.method === "POST") {
          // Only an allowlisted billing client's access token, with the credits scope, can hold or settle credits.
          // Prices come from the server's billing file; the client names a service and a number of units, never a charge.
          if (!caller) throw invalidToken("Platform credit calls need an auth.agora.build access token.");
          const userId = scoped("credits");
          if (!billingClients) throw new AppError(503, "Platform billing is not configured.");
          if (!billingClients.has(caller.clientId)) throw new AppError(403, "This application is not allowed to charge credits.");
          const reserving = path.endsWith("reserve");
          if (reserving) limit("reserve:" + userId, 60, 60000);
          const input = await body(request);
          const charge = priceFor(billingClients, caller.clientId, input.service, reserving ? input.units : 1);
          const name = caller.clientId + ":" + input.service;
          if (reserving) {
            if (!/^[A-Za-z0-9:_-]{16,120}$/.test(input.idempotencyKey || "")) throw new AppError(422, "Provide a valid idempotency key.");
            json(response, 200, await credits.reserve(userId, name, charge, input.idempotencyKey));
          } else {
            if (!["capture", "release"].includes(input.outcome) || !/^[a-f0-9-]{36}$/.test(input.reservationId || "")) throw new AppError(422, "Invalid settlement.");
            json(response, 200, await credits.settle(userId, input.reservationId, input.outcome, name));
          }
        }
        else if (path === "/api/auth/logout" && request.method === "POST") {
          // A guest has no IdP session, so only an account gets the IdP's end-session URL to follow.
          const signedIn = (await store.actor(token)).kind === "account";
          const { idToken } = await store.endSession(token);
          json(response, 200, { signedOut: true, endSessionUrl: signedIn && idp ? idp.endSessionUrl({ idToken }) : null }, { "Set-Cookie": sessionCookie("", 0) });
        }
        else if (path === "/api/profile" && request.method === "POST") {
          if (await store.me(token)) throw new AppError(409, "You already have a profile. Edit it instead.");
          limit("join:" + clientAddress(request), 10, 3600000);
          const { person, token: nextToken } = await store.join(await body(request), token);
          json(response, 201, { profile: person }, { "Set-Cookie": sessionCookie(nextToken) });
        } else if (path === "/api/profile" && request.method === "PUT") json(response, 200, { profile: await store.edit(token, await body(request)) });
        else if (path === "/api/profile" && request.method === "DELETE") {
          await store.remove(token);
          const current = await store.session(token);
          json(response, 200, { removed: true }, current.account ? {} : { "Set-Cookie": sessionCookie("", 0) });
        } else if (path === "/api/people/search" && request.method === "POST") {
          const data = await body(request);
          if (typeof data.query !== "string" || data.query.length > 1000) throw new AppError(422, "Keep your search under 1,000 characters.");
          const query = data.query.trim();
          const skill = typeof data.skill === "string" && data.skill.length <= 50 ? data.skill : "all";
          const people = await store.people();
          let matches;
          if (query && models.config.language.ready) { allowance(request); matches = await models.search(people, query, skill); }
          else matches = basicSearch(people, query, skill);
          json(response, 200, { people: matches, mode: query && models.config.language.ready ? "llm" : "basic" });
        } else if (path === "/api/projects" && request.method === "GET") json(response, 200, { projects: JSON.parse(await readFile(resolve(dataDirectory, "projects.json"), "utf8")) });
        else if (path === "/api/marketplaces" && request.method === "GET") {
          const offers = JSON.parse(await readFile(resolve(dataDirectory, "offers.json"), "utf8"));
          json(response, 200, { language: { ready: models.config.language.ready, model: models.config.language.model }, speech: { ready: models.config.speech.ready, model: models.config.speech.model }, radar: { ready: models.config.radar.ready }, credits: { ready: credits.config.ready, costs: credits.config.costs }, offers: offers.filter((offer) => !offer.expiresAt || Date.parse(offer.expiresAt) > Date.now()) });
        } else if (["/api/marketplaces/chat", "/api/marketplaces/tts"].includes(path) && request.method === "POST") {
          const speech = path.endsWith("tts");
          if (!(speech ? models.config.speech.ready : models.config.language.ready)) throw new AppError(503, "This marketplace is not available yet. A provider connection is needed.");
          const userId = await accountUser("credits", "Sign in to use the marketplaces.");
          const data = await body(request);
          const input = text(data, speech ? "text" : "message", speech ? 1200 : 3000);
          allowance(request);
          const marketplace = speech ? "tts" : "chat";
          const run = (action) => credits.run(userId, marketplace, request.headers["idempotency-key"], action);
          if (speech) {
            const audio = await run(() => models.speak(input, typeof data.voice === "string" ? data.voice : "coral"));
            response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            response.end(audio);
          } else json(response, 200, { answer: await run(() => models.chat(input)) });
        } else if (path === "/api/radar" && request.method === "GET") {
          const person = await store.me(token);
          json(response, 200, { ready: models.config.radar.ready, intervalHours: radarHours, result: person ? await store.radar(person.id) : null });
        } else if (path === "/api/radar" && request.method === "POST") {
          if (!models.config.radar.ready) throw new AppError(503, "The web radar is not connected yet.");
          const person = await member();
          if (!person.intent) throw new AppError(422, "Add your real intent to your profile first.");
          limit("radar:" + person.id, 1, 60000);
          allowance(request);
          json(response, 200, { result: await scan(person) });
        } else if (path === "/api/rooms" || path.startsWith("/api/rooms/")) throw new AppError(410, "Meeting rooms are now Stoa spaces. Start one from the Stoa.");
        else if (integrationPath(path)) {
          const handled = await handleIntegrations({ path, method: request.method, url: requestUrl, read: () => body(request), service: integrations && await integrations.ready(), caller, scoped, invalidToken, portalUser, idToken: () => store.sessionIdToken(token), limit });
          if (!handled) throw new AppError(404, "This page or service was not found.");
          json(response, handled.status, handled.body);
        } else {
          const handled = await handleSpaces({ path, method: request.method, url: requestUrl, token, read: () => body(request), spaces, worlds, themes, limit, ip: clientAddress(request) });
          if (!handled) throw new AppError(404, "This page or service was not found.");
          json(response, handled.status, handled.body);
        }
        return;
      }
      if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed"); return; }
      const meeting = /^\/meet\/([a-f0-9-]{36})$/.exec(path);
      if (meeting) { response.writeHead(308, { Location: "/stoa/s/" + meeting[1] + requestUrl.search }).end(); return; }
      if (path === "/meetings.html") { const room = requestUrl.searchParams.get("room"); response.writeHead(308, { Location: /^[a-f0-9-]{36}$/.test(room || "") ? "/stoa/s/" + room : "/stoa/" }).end(); return; }
      // Pages live at clean URLs ending in "/": /<name> and /<name>.html redirect there, keeping the query string.
      const clean = cleanPagePath(path);
      if (clean) { response.writeHead(308, { Location: clean + requestUrl.search }).end(); return; }
      const page = /^\/([a-z]+)\/$/.exec(path);
      const stoa = /^\/stoa(?:\/|\/room\/([a-z0-9-]{2,40})|\/s\/([a-f0-9-]{36}))$/.exec(path);
      if (stoa && ((stoa[1] && !worlds.plaza.map.lots.some((lot) => lot.slug === stoa[1])) || (stoa[2] && !(await spaces.visible(browserToken, stoa[2], requestUrl.searchParams.get("invite")))))) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("This space was not found."); return; }
      const filename = stoa ? "stoa.html" : path === "/" ? "index.html" : page && pages.includes(page[1]) ? page[1] + ".html" : path.endsWith(".html") ? "" : path.slice(1);
      if (!publicFiles.has(filename)) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found"); return; }
      const file = resolve(directory, filename);
      const content = await readFile(Object.hasOwn(vendor, filename) && !existsSync(file) ? vendor[filename] : file);
      response.writeHead(200, { "Content-Type": types[extname(filename)], "X-Content-Type-Options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      json(response, error.code === "ENOENT" ? 404 : error.status || 500, { error: error.code === "ENOENT" ? "This page was not found." : error.status ? error.message : "The house could not complete this request. Please try again.", ...(error.status && error.details ? error.details : {}) }, error.status && error.headers ? error.headers : {});
    }
  });

  let monitor;
  if (options.monitor !== false && models.config.radar.ready) {
    let running = false;
    monitor = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        for (const person of await store.people()) {
          if (person.source !== "community" || !person.monitor || !person.intent) continue;
          const previous = await store.radar(person.id);
          if (previous && Date.now() - Date.parse(previous.checkedAt) < radarHours * 3600000) continue;
          try { allowance(); await scan(person); } catch (error) { if (error.status === 429) break; }
        }
      } catch { /* A later scan can retry after a temporary storage or provider error. */ }
      finally { running = false; }
    }, options.monitorIntervalMs || 15 * 60000);
    monitor.unref();
  }
  server.on("close", () => clearInterval(monitor));
  const expiry = setInterval(() => { ledger.expire().catch(() => {}); }, 5 * 60000);
  expiry.unref();
  server.on("close", () => { clearInterval(expiry); persistence?.close().catch(() => {}); });
  const spaceSweep = setInterval(() => { spaces.sweep().catch(() => {}); }, 15000);
  spaceSweep.unref();
  server.on("close", () => clearInterval(spaceSweep));
  server.on("close", () => { integrations?.close().catch(() => {}); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = resolve(root, ".env");
  if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
  const portIndex = process.argv.indexOf("--port");
  const directoryIndex = process.argv.indexOf("--dir");
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 3002);
  const directory = directoryIndex >= 0 ? resolve(root, process.argv[directoryIndex + 1]) : root;
  const host = process.env.HOST || "0.0.0.0";
  const server = createAppServer(directory);
  server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log("Agora Build hacker house is listening on " + host + ":" + port));
}
