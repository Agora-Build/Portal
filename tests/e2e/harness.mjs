// End-to-end harness: the real auth.agora.build (loaded from an Agora-Build/Auth checkout through its own test
// helpers) and the real Portal server, talking to each other and to a cookie-jar browser over real HTTP.
//
// Network layout for one stack:
//   browser ──HTTP──▶ http://auth.localhost:<P>  (a forwarding listener: the IdP's public address, standing in for the
//                                                 TLS proxy in front of auth.agora.build) ──HTTP──▶ the IdP app
//   browser ──HTTP──▶ http://127.0.0.1:<Q>       (the Portal, scripts/serve.mjs createAppServer)
//   Portal  ──HTTP──▶ http://auth.localhost:<P>  (discovery, token exchange, JWKS; no injected request function)
//   IdP     ──HTTP──▶ http://127.0.0.1:<Q>/auth/backchannel-logout
// Only GitHub and Google are stand-ins (Auth's fake upstream), as in Auth's own tests.
//
// With { integrations: true } the Portal also runs Stations and integrations: its own PostgreSQL schema (in
// PORTAL_TEST_DATABASE_URL), Auth's management API and token exchange, and a Station fetch that reaches
// https://station.test:<port> on 127.0.0.1 and trusts tests/fixtures/tls/station-test.crt. Auth never connects to a
// Station, so only the Portal needs that name resolved.
import dns from "node:dns";
import { createServer, request as httpRequest } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import pg from "pg";
import { createAppServer } from "../../scripts/serve.mjs";
import { createStore } from "../../scripts/store.mjs";
import { modelConfig } from "../../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../../scripts/calls.mjs";
import { createSignaling, signalingConfig } from "../../scripts/spaces/signaling.mjs";
import { createStationFetch } from "../../scripts/integrations/proof.mjs";

export const portalRoot = fileURLToPath(new URL("../../", import.meta.url));
export const authRepo = resolve(portalRoot, process.env.AUTH_REPO || "../Auth");
// The Portal API audience. The test Portal's port is random, so it is set with PORTAL_API_AUDIENCE instead of the
// default (the Portal's own origin).
export const API = "https://portal.e2e.test";
const SAMPLE_REDIRECT = "https://sample.test/callback";
// The Station stub's host name: the one the test certificate names. The Portal's Station fetch resolves it to
// 127.0.0.1 (any port).
export const STATION_HOST = "station.test";
export const stationTls = () => ({ key: readFileSync(resolve(portalRoot, "tests/fixtures/tls/station-test.key")), cert: readFileSync(resolve(portalRoot, "tests/fixtures/tls/station-test.crt")) });

// Why the suite cannot run here, or null. Never includes a connection string.
export async function skipReason() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 18)) return "auth.agora.build needs Node 22 (at least 20.18); run `source ~/.nvm/nvm.sh && nvm use 22` first";
  if (!existsSync(resolve(authRepo, "tests/helpers/server.mjs"))) return "no Agora-Build/Auth checkout at " + authRepo + " (set AUTH_REPO)";
  if (!existsSync(resolve(authRepo, "node_modules/oidc-provider"))) return "the Auth checkout at " + authRepo + " has no node_modules (run npm ci there)";
  if (!process.env.TEST_DATABASE_URL) return "TEST_DATABASE_URL is not set (a PostgreSQL database Auth's tests may create schemas in; see Auth's README)";
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  try { await client.connect(); await client.query("SELECT 1"); }
  catch { return "the database named by TEST_DATABASE_URL is unreachable"; }
  finally { await client.end().catch(() => {}); }
  return null;
}

// Why the Stations and integrations flows cannot run (beyond skipReason()), or null. Never includes a connection string.
export async function integrationsSkipReason() {
  const url = process.env.PORTAL_TEST_DATABASE_URL;
  if (!url) return "PORTAL_TEST_DATABASE_URL is not set (the Portal's own throwaway PostgreSQL database, agora_portal_test)";
  if (new URL(url).pathname !== "/agora_portal_test") return "PORTAL_TEST_DATABASE_URL must name the agora_portal_test database";
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); await client.query("SELECT 1"); }
  catch { return "the database named by PORTAL_TEST_DATABASE_URL is unreachable"; }
  finally { await client.end().catch(() => {}); }
  return null;
}

const authModule = (path) => import(pathToFileURL(resolve(authRepo, path)).href);
export async function loadAuth() {
  // openid-client comes from the Auth checkout too: its relyingParty() builds Configurations of that copy.
  const [server, flows, admin, keys, policy, oidc] = await Promise.all([
    authModule("tests/helpers/server.mjs"), authModule("tests/helpers/flows.mjs"),
    authModule("src/admin.mjs"), authModule("src/keys.mjs"), authModule("src/policy.mjs"), authModule("node_modules/openid-client/build/index.js")
  ]);
  return { ...server, ...flows, oidc, keysCommand: admin.keysCommand, createKeyStore: keys.createKeyStore, createAudit: policy.createAudit };
}

const secret = () => randomBytes(36).toString("base64url");
const listen = (server, port, host) => new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(port, host, () => { server.off("error", fail); done(); });
});
const shut = (server) => new Promise((done) => {
  if (!server?.listening) { done(); return; }
  server.close(() => done());
  server.closeAllConnections();
});
async function freePort() {
  const probe = createServer();
  await listen(probe, 0, "127.0.0.1");
  const { port } = probe.address();
  await shut(probe);
  return port;
}

// The IdP's public address. It forwards to the in-process IdP with the X-Forwarded-* headers its TLS proxy adds
// (the same ones Auth's startAuth() fetch adds), so the IdP sees each browser's own address.
function createFront() {
  let target = null;
  const handler = (incoming, outgoing) => {
    if (!target) { outgoing.writeHead(502).end(); return; }
    const headers = { ...incoming.headers };
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-host"] = incoming.headers.host;
    headers["x-forwarded-for"] = incoming.headers["x-forwarded-for"] || incoming.socket.remoteAddress.replace(/^::ffff:/, "");
    const upstream = httpRequest(target + incoming.url, { method: incoming.method, headers }, (answer) => {
      outgoing.writeHead(answer.statusCode, answer.rawHeaders);
      answer.pipe(outgoing);
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  };
  const servers = [createServer(handler), createServer(handler)];
  let port = 0;
  return {
    get port() { return port; },
    point(origin) { target = origin; },
    async start(wanted = 0) {
      await listen(servers[0], wanted, "127.0.0.1");
      port = servers[0].address().port;
      // auth.localhost resolves to ::1 as well; answer there too when the address is free.
      await listen(servers[1], port, "::1").catch(() => {});
    },
    async stop() { await Promise.all(servers.map(shut)); },
    async restart() {
      for (const [index, host] of [[0, "127.0.0.1"], [1, "::1"]]) {
        servers[index] = createServer(handler);
        await listen(servers[index], port, host).catch((error) => { if (index === 0) throw error; });
      }
    }
  };
}

// Auth's clients document (its testClients() format) for one Portal: §3.6 of the Portal spec plus the apps the
// flows need. Secrets are named by setting; the values are random per run and stay in this process.
// With `integrations` the Portal client may manage Stations and exchange ID tokens for station.read, the API carries the
// Station report and approval scopes, and a native "astation" app (device flow) may list and approve integrations.
function clientsDocument(site, { integrations = false } = {}) {
  const document = {
    resources: [
      { indicator: API, name: "Agora Build API", scopes: ["credits", "agora:projects", "agora:certificates"] },
      { indicator: "https://api.sample.test", name: "Sample API", scopes: ["sample:read"] }
    ],
    clients: [
      { id: "portal", name: "Agora Build", type: "web", firstParty: true, secretEnv: "PORTAL_CLIENT_SECRET", redirectUris: [site + "/auth/callback"], postLogoutRedirectUris: [site + "/"], backchannelLogoutUri: site + "/auth/backchannel-logout", homeUrl: site + "/", grants: ["authorization_code"], scopes: ["openid", "profile", "email"] },
      { id: "sample", name: "Sample app", type: "web", firstParty: true, secretEnv: "SAMPLE_CLIENT_SECRET", redirectUris: [SAMPLE_REDIRECT], postLogoutRedirectUris: ["https://sample.test/signed-out"], homeUrl: "https://sample.test/", grants: ["authorization_code", "refresh_token"], scopes: ["openid", "profile", "email", "offline_access", "sample:read"], resources: ["https://api.sample.test"] },
      { id: "vox", name: "Vox", type: "web", firstParty: true, secretEnv: "VOX_CLIENT_SECRET", authMethod: "client_secret_post", redirectUris: ["https://vox.test/callback"], grants: ["authorization_code"], scopes: ["openid", "profile", "email", "credits"], resources: [API] },
      { id: "atem", name: "Atem", type: "native", firstParty: true, grants: ["device_code"], scopes: ["openid", "profile", "credits", "agora:projects"], resources: [API] },
      { id: "notes", name: "Third Party Notes", type: "web", secretEnv: "NOTES_CLIENT_SECRET", redirectUris: ["https://notes.test/callback"], homeUrl: "https://notes.test/", grants: ["authorization_code"], scopes: ["openid", "profile", "credits"], resources: [API] }
    ]
  };
  if (!integrations) return document;
  document.resources[0].scopes.push("station.report", "integrations:read", "integrations:approve");
  Object.assign(document.clients[0], { manage: true, exchange: true, stationScopes: ["station.read"] });
  document.clients.push({ id: "astation", name: "Astation", type: "native", firstParty: true, grants: ["device_code"], scopes: ["openid", "integrations:read", "integrations:approve"], resources: [API] });
  return document;
}

// The Portal's Station fetches for the stack: station.test resolves to 127.0.0.1, which the production fetch refuses
// (allowPrivate), over TLS trusting only the test certificate.
function stationFetches() {
  const lookup = (hostname, options, callback) => {
    if (hostname !== STATION_HOST) return dns.lookup(hostname, options, callback);
    if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  };
  const agent = new HttpsAgent({ ca: stationTls().cert });
  return { stationFetch: createStationFetch({ allowPrivate: true, lookup, agent }), pushFetch: createStationFetch({ allowPrivate: true, lookup, agent, timeoutMs: 3000 }) };
}

// A fresh schema in PORTAL_TEST_DATABASE_URL for one Portal; the URL selects it through the connection's options.
async function portalDatabase() {
  const url = process.env.PORTAL_TEST_DATABASE_URL;
  const schema = "e2e_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("CREATE SCHEMA " + schema);
  const scoped = new URL(url);
  scoped.searchParams.set("options", "-c statement_timeout=30000 -c search_path=" + schema);
  return {
    url: scoped.href,
    async drop() {
      try { await admin.query("DROP SCHEMA " + schema + " CASCADE"); } finally { await admin.end(); }
    }
  };
}

// The Portal's settings are read from process.env by scripts/serve.mjs (idpFromEnv, loadBillingClients,
// connections); they are set only while the server is built, and restored afterwards.
function withEnv(values, build) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try { return build(); }
  finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}

const models = { config: modelConfig({}), chat: async () => "unused", speak: async () => Buffer.from(""), research: async () => ({ items: [] }), search: async (people) => people };
const signalingEnv = { AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), SPACES_SIGNALING_SECRET: randomBytes(24).toString("hex") };

// Starts a Portal server on `port` against `issuer`, with a temp data file and a billing file.
async function startPortal({ issuer, port, directory, clientSecret, logs, databaseUrl }) {
  const site = "http://127.0.0.1:" + port;
  const billingFile = resolve(directory, "billing-" + port + ".json");
  await writeFile(billingFile, JSON.stringify({ vox: { services: { evaluation: { credits: 3, maxUnits: 5 } } } }));
  const store = createStore(resolve(portalRoot, "data/people.json"), resolve(directory, "community-" + port + ".json"), { log: (line) => logs.push(line) });
  const server = withEnv({
    AUTH_ISSUER: issuer, PORTAL_CLIENT_ID: "portal", PORTAL_CLIENT_SECRET: clientSecret, SITE_URL: site, PORTAL_API_AUDIENCE: API,
    PORTAL_BILLING_FILE: billingFile, AGORA_CONSOLE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PLATFORM_ADMINS: "",
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {})
  }, () => createAppServer(portalRoot, {
    monitor: false, store, log: (line) => logs.push(line), models, modelLimit: 1000,
    calls: createAgoraCalls(agoraConfig(signalingEnv)), signaling: createSignaling(signalingConfig(signalingEnv)), channelSecret: signalingEnv.SPACES_SIGNALING_SECRET,
    ...(databaseUrl ? { integrationOptions: stationFetches() } : {})
  }));
  await listen(server, port, "127.0.0.1");
  return { site, store, server, close: () => shut(server) };
}

// One IdP + one Portal. Returns everything a flow needs; close() tears it all down. `integrations` turns on Stations
// and integrations (see the top of this file); it needs PORTAL_TEST_DATABASE_URL (integrationsSkipReason()).
export async function startStack(lib, { integrations = false } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "portal-e2e-"));
  const front = createFront();
  await front.start();
  const issuer = "http://auth.localhost:" + front.port;
  const portalPort = await freePort();
  const site = "http://127.0.0.1:" + portalPort;
  const secrets = { PORTAL_CLIENT_SECRET: secret(), SAMPLE_CLIENT_SECRET: secret(), VOX_CLIENT_SECRET: secret(), NOTES_CLIENT_SECRET: secret() };
  const auth = await lib.startAuth({ issuer, clients: clientsDocument(site, { integrations }), env: secrets });
  front.point(auth.origin);
  const logs = [];
  const database = integrations ? await portalDatabase() : null;
  const portal = await startPortal({ issuer, port: portalPort, directory, clientSecret: secrets.PORTAL_CLIENT_SECRET, logs, databaseUrl: database?.url });
  // What the relying-party helpers need: the issuer, reached over real HTTP through its public address.
  const idp = { issuer, fake: auth.fake, fetch: (input, init) => fetch(input, init) };
  const closers = [];
  return {
    issuer, site, auth, idp, front, portal, store: portal.store, logs, secrets, directory,
    // Another Portal against the same issuer (for example one started while the IdP is down).
    async extraPortal() {
      const extra = await startPortal({ issuer, port: await freePort(), directory, clientSecret: secrets.PORTAL_CLIENT_SECRET, logs });
      closers.push(extra.close);
      return extra;
    },
    async close() {
      for (const close of closers) await close();
      await portal.close();
      await database?.drop();
      await front.stop();
      await auth.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

let nextAddress = 0;
// A browser for one person: a cookie jar per host name (cookies ignore ports, as browsers do), redirects followed
// across the IdP and the Portal, and the headers browsers send on same-origin form and fetch posts. Relative URLs
// resolve against the IdP, so Auth's signInThrough() helpers work with it.
export function createBrowser(stack, { reachable = [] } = {}) {
  const ip = "198.51.100." + (1 + (nextAddress++ % 250));
  const jar = new Map();
  const origins = new Set([stack.issuer, stack.site, ...reachable]);
  const history = [];
  function remember(host, headers) {
    for (const header of headers) {
      const [pair, ...attributes] = header.split(";").map((part) => part.trim());
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const path = attributes.find((attribute) => /^path=/i.test(attribute))?.slice(5) || "/";
      const key = host + "|" + name + "|" + path;
      const expired = value === "" || attributes.some((attribute) => /^max-age=(0|-\d+)$/i.test(attribute) || /^expires=thu, 01 jan 1970/i.test(attribute));
      if (expired) jar.delete(key);
      else jar.set(key, { host, name, value, path });
    }
  }
  const cookieHeader = (url) => [...jar.values()]
    .filter((cookie) => cookie.host === url.hostname && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : cookie.path + "/")))
    .map((cookie) => cookie.name + "=" + cookie.value).join("; ");

  async function request(url, { method = "GET", form, json, headers = {} } = {}) {
    const target = new URL(url, stack.issuer);
    history.push(target.href);
    const merged = new Headers(headers);
    merged.set("User-Agent", "PortalE2EBrowser/1.0");
    // The IdP sits behind a TLS proxy that records the client address; the forwarding listener passes this on.
    if (target.origin === stack.issuer) merged.set("X-Forwarded-For", ip);
    if (!merged.has("Accept")) merged.set("Accept", json === undefined ? "text/html,application/xhtml+xml,*/*;q=0.8" : "application/json");
    const cookies = cookieHeader(target);
    if (cookies) merged.set("Cookie", cookies);
    let body;
    if (form || json !== undefined) {
      body = form ? new URLSearchParams(form).toString() : JSON.stringify(json);
      merged.set("Content-Type", form ? "application/x-www-form-urlencoded" : "application/json");
      if (!merged.has("Origin")) merged.set("Origin", target.origin);
      if (!merged.has("Sec-Fetch-Site")) merged.set("Sec-Fetch-Site", merged.get("Origin") === target.origin ? "same-origin" : "cross-site");
      if (!merged.has("Sec-Fetch-Mode")) merged.set("Sec-Fetch-Mode", form ? "navigate" : "cors");
      if (method === "GET") method = "POST";
    }
    const response = await fetch(target, { method, headers: merged, body, redirect: "manual" });
    remember(target.hostname, response.headers.getSetCookie());
    const location = response.headers.get("location");
    const text = await response.text();
    return { status: response.status, location: location ? new URL(location, target).href : null, text, headers: response.headers, url: target.href, json: () => JSON.parse(text) };
  }
  const redirected = (response) => [301, 302, 303, 307, 308].includes(response.status) && response.location;
  // Follows redirects inside the IdP and stops at the first page, or at a redirect leaving it (Auth's semantics).
  async function follow(url, options) {
    let response = await request(url, options);
    while (redirected(response) && new URL(response.location).origin === stack.issuer) response = await request(response.location);
    return response;
  }
  // Follows redirects anywhere this browser can reach (the IdP and the Portal); stops at a page, or at a redirect to
  // an app that isn't running here (sample.test, vox.test), returning that location.
  async function visit(url, options) {
    let response = await request(url, options);
    let hops = 0;
    while (redirected(response) && origins.has(new URL(response.location).origin)) {
      if (++hops > 20) throw new Error("too many redirects");
      response = await request(response.location);
    }
    return response;
  }
  // Same-origin fetch() from a Portal page.
  const api = (path, { method = "GET", json } = {}) => request(new URL(path, stack.site).href, { method, ...(json !== undefined ? { json } : {}), headers: { Accept: "application/json" } });
  const hasCookie = (host, name) => [...jar.values()].some((cookie) => cookie.host === host && cookie.name === name);
  return { ip, request, follow, visit, api, history, hasCookie, cookies: () => [...jar.values()] };
}

export const person = (id, name) => ({ id, login: name.toLowerCase(), name, avatar_url: "https://avatars.example/" + id, emails: [{ email: name.toLowerCase() + "@example.com", primary: true, verified: true }] });
export const interactionUid = (url) => new URL(url).pathname.split("/")[2];

const consentPage = (page) => /action="\/interaction\/[^"]+\/consent"/.test(page.text);
// Continues from an IdP page: on the sign-in page picks GitHub and approves at the stand-in GitHub as `user`; gives
// consent if the app asks; and follows the redirects back (into the Portal when it is the app).
export async function completeSignIn(browser, stack, page, user) {
  if (!consentPage(page)) {
    if (!page.text.includes('/upstream/github"')) throw new Error("expected the IdP sign-in page at " + new URL(page.url).pathname);
    const start = await browser.request("/interaction/" + interactionUid(page.url) + "/upstream/github", { form: {} });
    page = await browser.visit(stack.idp.fake.approve(start.location, user));
  }
  if (!page.location && consentPage(page)) page = await browser.visit("/interaction/" + interactionUid(page.url) + "/consent", { form: {} });
  return page;
}

// A fresh browser signs in to the Portal through the IdP as `user`.
export async function portalSignIn(stack, user, { browser = createBrowser(stack), returnTo = "/account/" } = {}) {
  const page = await browser.visit(stack.site + "/auth/login?returnTo=" + encodeURIComponent(returnTo));
  const done = page.location ? page : await completeSignIn(browser, stack, page, user);
  return { browser, page: done };
}

export const bearer = (stack, path, token, { method = "GET", json } = {}) => fetch(stack.site + path, {
  method,
  headers: { Authorization: "Bearer " + token, Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
  ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  redirect: "manual"
});

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export async function eventually(check, { timeout = 5000, every = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value || Date.now() >= deadline) return value;
    await sleep(every);
  }
}
