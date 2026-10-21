import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { AppError, createStore, text } from "./store.mjs";
import { basicSearch, createModelClient, modelConfig } from "./models.mjs";
import { createActivityFeed } from "./activity.mjs";
import { createAgoraCalls } from "./calls.mjs";
import { createAuth } from "./auth.mjs";
import { createCredits } from "./credits.mjs";
import { createLedger } from "./ledger.mjs";
import { createBilling } from "./billing.mjs";
import { createConnections } from "./connections.mjs";
import { createPostgresPersistence } from "./persistence.mjs";
import { createSignaling, signalingConfig } from "./spaces/signaling.mjs";
import { createSpaces, loadWorlds } from "./spaces/service.mjs";
import { handleSpaces } from "./spaces/routes.mjs";
import { loadThemes } from "./spaces/themes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Vendored browser SDKs are served from node_modules in development and from dist/assets after a build.
const vendor = { "assets/agora-rtc.js": createRequire(import.meta.url).resolve("agora-rtc-sdk-ng"), "assets/agora-rtm.js": createRequire(import.meta.url).resolve("agora-rtm-sdk") };
const publicFiles = new Set(["index.html", "explore.html", "services.html", "radar.html", "account.html", "account.js", "stoa.html", "stoa.js", "world/map.js", "world/kinds.js", "world/themes.js", "world/camera.js", "world/motion.js", "world/renderer-canvas.js", "world/engine.js", "world/sdk.js", "world/rtc-client.js", "stoa/panel.js", "stoa/stage.js", "stoa/call.js", "stoa/decor.js", "stoa/place.js", "stoa/lease.js", "stoa/spaces.js", "world/protocol.js", "world/crypto.js", "world/signaling.js", "world/presence.js", "styles.css", "script.js", "people.js", "activity.js", "explore.js", "services.js", "radar.js", "assets/agora-rtc.js", "assets/agora-rtm.js", "assets/favicon.svg", "assets/guohai.jpg"]);
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
const session = (request) => request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("house_session="))?.slice(14) || "";
const cookieValue = (request, name) => request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1) || "";
const redirect = (response, location, cookies = []) => { response.writeHead(303, { Location: location, "Cache-Control": "no-store", ...(cookies.length ? { "Set-Cookie": cookies } : {}) }); response.end(); };
async function formBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) throw new AppError(415, "This callback requires form data.");
  let content = "";
  for await (const chunk of request) {
    content += chunk;
    if (Buffer.byteLength(content) > 16384) throw new AppError(413, "This callback is too large.");
  }
  return new URLSearchParams(content);
}

export function createAppServer(directory = root, options = {}) {
  const dataDirectory = options.dataDirectory || resolve(directory, "data");
  const persistence = !options.store && !options.storageFile && process.env.DATABASE_URL ? createPostgresPersistence(process.env.DATABASE_URL) : null;
  const store = options.store || createStore(resolve(dataDirectory, "people.json"), options.storageFile || resolve(root, ".data/community.json"), { persistence });
  const calls = options.calls || createAgoraCalls();
  const auth = options.auth || createAuth();
  const ledger = createLedger(store);
  const credits = options.credits || createCredits(undefined, { ledger });
  const billing = options.billing || createBilling(store);
  const connections = options.connections || createConnections(store, auth);
  const models = options.models || createModelClient(modelConfig());
  const activity = options.activity || createActivityFeed({ store, projectsFile: resolve(dataDirectory, "projects.json"), snapshotFile: resolve(dataDirectory, "activity.json") });
  const worlds = options.worlds || loadWorlds(directory);
  const themes = options.themes || loadThemes(directory);
  const signaling = options.signaling || createSignaling(signalingConfig());
  const spaces = options.spaces || createSpaces({ store, worlds, signaling, calls, secret: options.channelSecret ?? signalingConfig().secret, admins: (process.env.PLATFORM_ADMINS || "").split(",").map((id) => id.trim()).filter(Boolean), plazaCapacity: options.plazaCapacity });
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
    if (request) limit("model:" + request.socket.remoteAddress, 6, 60000);
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
      const path = requestUrl.pathname;
      const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
      const cookieToken = session(request);
      const token = cookieToken && await store.browserToken(cookieToken) ? cookieToken : "";
      const secure = auth.config.origin.startsWith("https:") || Boolean(request.socket.encrypted);
      const sessionCookie = (value, maxAge = 30 * 86400) => "house_session=" + value + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + maxAge + (secure ? "; Secure" : "");
      if (path === "/api/billing/webhook" && request.method === "POST") {
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 262144) throw new AppError(413, "Payment event too large."); chunks.push(chunk); }
        json(response, 200, await billing.apply(billing.verify(Buffer.concat(chunks), request.headers["stripe-signature"])));
        return;
      }
      // The Portal is no longer an identity provider or an OAuth server; sign-in comes from auth.agora.build.
      if (path.startsWith("/oauth/") || /^\/auth\/(google|github|apple|agora)(\/callback)?$/.test(path)) throw new AppError(410, "Sign-in has moved to auth.agora.build.");
      if (path.startsWith("/api/")) {
        if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) throw new AppError(405, "This method is not supported.");
        if (request.method !== "GET" && request.headers.origin) {
          let host;
          try { host = new URL(request.headers.origin).host; } catch { throw new AppError(403, "Use this feature from the house website."); }
          if (host !== request.headers.host) throw new AppError(403, "Use this feature from the house website.");
        }
        if (request.method !== "GET" && request.headers["sec-fetch-site"] === "cross-site") throw new AppError(403, "Use this feature from the Agora.Build website.");
        // The Portal's own app tokens are gone; auth.agora.build access tokens are accepted once its routes are wired.
        if (bearer) throw new AppError(401, "This access token is not accepted.");
        if (path.startsWith("/api/identity/") || ["/api/auth/pending-link", "/api/auth/logout-all"].includes(path)) throw new AppError(410, "Logins and devices are managed on auth.agora.build.");
        const member = async () => {
          const person = await store.me(token);
          if (!person) throw new AppError(401, "Join the house to use this feature.");
          return person;
        };
        const serviceUser = async () => {
          const current = await store.session(token);
          if (!current.account && !current.profile) throw new AppError(401, "Sign in to use builder services.");
          return current.account?.id || null;
        };
        const portalUser = async () => {
          const current = await store.session(token);
          if (!current.account) throw new AppError(401, "Sign in to manage your Agora.Build account.");
          return current.account.id;
        };

        if (path === "/api/people" && request.method === "GET") json(response, 200, { people: await store.people(), smartSearch: models.config.language.ready });
        else if (path === "/api/activity" && request.method === "GET") json(response, 200, await activity.get());
        else if (path === "/api/me" && request.method === "GET") json(response, 200, await store.session(token));
        else if (path === "/api/auth/providers" && request.method === "GET") json(response, 200, { providers: auth.providers() });
        else if (path === "/api/billing/catalog" && request.method === "GET") json(response, 200, await billing.catalog());
        else if (path === "/api/billing/account" && request.method === "GET") json(response, 200, await billing.account(await portalUser()));
        else if (path === "/api/billing/checkout" && request.method === "POST") {
          const userId = await portalUser(); limit("checkout:" + userId, 10, 60000);
          const input = await body(request);
          json(response, 200, await billing.checkout(userId, input.productId, request.headers["idempotency-key"]));
        }
        else if (path === "/api/billing/manage" && request.method === "POST") json(response, 200, await billing.manage(await portalUser()));
        else if (path === "/api/connections" && request.method === "GET") {
          json(response, 200, await connections.status(await portalUser()));
        }
        else if (path === "/api/connections/agora/projects" && request.method === "GET") {
          json(response, 200, await connections.projects(await portalUser()));
        }
        else if (path === "/api/connections/agora/certificate" && request.method === "POST") {
          const userId = await portalUser(); limit("certificates:" + userId, 20, 60000);
          json(response, 200, await connections.certificate(userId, (await body(request)).projectId));
        }
        else if (path === "/api/connections/agora" && request.method === "DELETE") { await connections.disconnect(await portalUser()); json(response, 200, { disconnected: true }); }
        else if (["/api/credits/balance", "/api/credits/statement"].includes(path) && request.method === "GET") {
          const userId = await serviceUser();
          if (!userId) throw new AppError(401, "Connect a login to use shared credits.");
          json(response, 200, path.endsWith("balance") ? await credits.balance(userId) : await credits.statement(userId, requestUrl.searchParams.get("cursor")));
        }
        else if (["/api/platform/credits/reserve", "/api/platform/credits/settle"].includes(path) && request.method === "POST") throw new AppError(401, "Platform credit calls need an auth.agora.build access token.");
        else if (path === "/api/auth/logout" && request.method === "POST") {
          await store.endSession(token);
          json(response, 200, { signedOut: true }, { "Set-Cookie": sessionCookie("", 0) });
        }
        else if (path === "/api/profile" && request.method === "POST") {
          if (await store.me(token)) throw new AppError(409, "You already have a profile. Edit it instead.");
          limit("join:" + request.socket.remoteAddress, 10, 3600000);
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
        else if (path === "/api/services" && request.method === "GET") {
          const offers = JSON.parse(await readFile(resolve(dataDirectory, "offers.json"), "utf8"));
          json(response, 200, { language: { ready: models.config.language.ready, model: models.config.language.model }, speech: { ready: models.config.speech.ready, model: models.config.speech.model }, radar: { ready: models.config.radar.ready }, credits: { ready: credits.config.ready, costs: credits.config.costs }, offers: offers.filter((offer) => !offer.expiresAt || Date.parse(offer.expiresAt) > Date.now()) });
        } else if (["/api/services/chat", "/api/services/tts"].includes(path) && request.method === "POST") {
          const speech = path.endsWith("tts");
          if (!(speech ? models.config.speech.ready : models.config.language.ready)) throw new AppError(503, "This service is not available yet. A provider connection is needed.");
          const userId = await serviceUser();
          const data = await body(request);
          const input = text(data, speech ? "text" : "message", speech ? 1200 : 3000);
          allowance(request);
          const service = speech ? "tts" : "chat";
          if (credits.config.costs[service] && !userId) throw new AppError(401, "Connect a login to pay with shared credits.");
          const run = (action) => credits.run(userId, service, request.headers["idempotency-key"], action);
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
        else {
          const handled = await handleSpaces({ path, method: request.method, url: requestUrl, token, read: () => body(request), spaces, worlds, themes, limit, ip: request.socket.remoteAddress });
          if (!handled) throw new AppError(404, "This page or service was not found.");
          json(response, handled.status, handled.body);
        }
        return;
      }
      if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed"); return; }
      const meeting = /^\/meet\/([a-f0-9-]{36})$/.exec(path);
      if (meeting) { response.writeHead(308, { Location: "/stoa/s/" + meeting[1] + requestUrl.search }).end(); return; }
      if (path === "/meetings.html") { const room = requestUrl.searchParams.get("room"); response.writeHead(308, { Location: /^[a-f0-9-]{36}$/.test(room || "") ? "/stoa/s/" + room : "/stoa/" }).end(); return; }
      const stoa = /^\/stoa(?:\/|\/room\/([a-z0-9-]{2,40})|\/s\/([a-f0-9-]{36}))$/.exec(path);
      if (stoa && ((stoa[1] && !worlds.plaza.map.lots.some((lot) => lot.slug === stoa[1])) || (stoa[2] && !(await spaces.visible(token, stoa[2], requestUrl.searchParams.get("invite")))))) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("This space was not found."); return; }
      const filename = stoa ? "stoa.html" : path === "/" ? "index.html" : path.slice(1);
      if (!publicFiles.has(filename)) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found"); return; }
      const file = resolve(directory, filename);
      const content = await readFile(Object.hasOwn(vendor, filename) && !existsSync(file) ? vendor[filename] : file);
      response.writeHead(200, { "Content-Type": types[extname(filename)], "X-Content-Type-Options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      json(response, error.code === "ENOENT" ? 404 : error.status || 500, { error: error.code === "ENOENT" ? "This page was not found." : error.status ? error.message : "The house could not complete this request. Please try again.", ...(error.status && error.details ? error.details : {}) });
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
