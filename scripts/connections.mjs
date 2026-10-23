import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "./store.mjs";

// Agora SSO (sso2.agora.io), used only to authorise Console access for an account that is already signed in. The
// Portal is a confidential client: the code exchange and refresh send client_id and client_secret in the form body.
const DEFAULT_SCOPE = "basic_info,console";
const CONNECT_KIND = "agora-connect";
// Every Agora call uses these paths on AGORA_SSO_BASE_URL with the connection's bearer token.
export const AGORA_PATHS = {
  authorize: "/api/v0/oauth/authorize",
  token: "/api/v0/oauth/token",
  customerProjects: "/api/v0/customer/project",
  projects: "/api/v0/project",
  project: (vendorId) => "/api/v0/project/" + encodeURIComponent(vendorId),
  userAuth: "/api/v0/customer/user-auth",
  companyInfo: "/api/v0/customer/company/basic-info",
  companies: "/api/v0/account/companies"
};
const httpsEndpoint = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return url.href.replace(/\/$/, "");
  } catch { /* An invalid endpoint cannot receive credentials. */ }
  return "";
};
// A failed connect callback; `reason` is a short code that is safe to log.
export class ConnectError extends Error {
  constructor(reason) { super("Agora connect failed: " + reason); this.reason = reason; }
}

export function connectionsConfig(env = process.env) {
  // Encrypts stored Agora Console tokens.
  const key = Buffer.from(env.AGORA_CONSOLE_ENCRYPTION_KEY || "", "base64");
  const sso = {
    baseUrl: httpsEndpoint(String(env.AGORA_SSO_BASE_URL || "").trim() || "https://sso2.agora.io"),
    clientId: env.AGORA_SSO_CLIENT_ID || "",
    secret: env.AGORA_SSO_CLIENT_SECRET || "",
    scope: String(env.AGORA_SSO_SCOPE || "").trim() || DEFAULT_SCOPE
  };
  // The callback is on the Portal's public origin: https, or plain http on a loopback host (including *.localhost, as
  // for sign-in) for local development.
  let redirectUri = "";
  try {
    const url = new URL(env.SITE_URL);
    if (!url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost"))))) redirectUri = url.origin + "/connect/agora/callback";
  } catch { /* Connect stays unavailable until a public origin is configured. */ }
  // Stored connections can be opened and used while the key and the SSO host are valid.
  const ready = key.length === 32 && Boolean(sso.baseUrl);
  // Setting names (never values) that keep the connect flow unavailable.
  const missing = [
    [!sso.baseUrl, "AGORA_SSO_BASE_URL"], [!sso.clientId, "AGORA_SSO_CLIENT_ID"], [!sso.secret, "AGORA_SSO_CLIENT_SECRET"],
    [key.length !== 32, "AGORA_CONSOLE_ENCRYPTION_KEY"], [!redirectUri, "SITE_URL"]
  ].filter(([absent]) => absent).map(([, name]) => name);
  return { key, sso, ready, connect: { ready: missing.length === 0, missing, redirectUri } };
}

// Agora's response shapes are not documented, so everything Agora returns is read here, tolerantly.
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const first = (object, names) => {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
};
const clean = (value, max = 200) => (typeof value === "string" || typeof value === "number") ? String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
const timestamp = (value) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === "string" && value && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  return null;
};
// The array of projects in a list response: the top level, or under data/list/items/projects (one level of nesting).
function projectArray(body) {
  if (Array.isArray(body)) return body;
  const containers = ["data", "list", "items", "projects", "result", "records", "rows"];
  for (const name of containers) if (Array.isArray(body?.[name])) return body[name];
  for (const outer of ["data", "result"]) for (const name of containers) if (Array.isArray(body?.[outer]?.[name])) return body[outer][name];
  return null;
}
// One project in the Portal's shape. projectId is Agora's vendor ID, used for GET /api/v0/project/{vendorId}.
export function mapProject(item) {
  if (!isObject(item)) return null;
  const projectId = clean(first(item, ["vendorId", "vendor_id", "vid", "id", "projectId", "project_id"]), 128);
  if (!projectId) return null;
  const status = first(item, ["status", "state"]);
  return {
    projectId,
    name: clean(first(item, ["name", "projectName", "project_name", "vendorName"]), 120) || "Untitled project",
    appId: clean(first(item, ["appId", "app_id", "key", "vendorKey", "vendor_key"]), 128) || null,
    status: status === undefined ? null : typeof status === "boolean" ? String(status) : clean(status, 40) || null,
    createdAt: timestamp(first(item, ["createdAt", "created_at", "createTime", "create_time", "created"])),
    certificate: clean(first(item, ["certificate", "signKey", "sign_key", "appCertificate", "app_certificate", "primaryCertificate"]), 256) || null
  };
}
// A project list response as { projects }, or null when no project array is recognised.
export function mapProjects(body) {
  const items = projectArray(body);
  return items ? { projects: items.map(mapProject).filter(Boolean) } : null;
}
// A project details response: the project itself, or one wrapped in data/project/result.
export function mapProjectDetails(body) {
  const candidates = [body?.data?.project, body?.project, body?.result?.project, body?.data, body?.result, body];
  for (const candidate of candidates) { const project = mapProject(candidate); if (project) return project; }
  return null;
}
// A display name from the company basic-info or user-auth response.
export function mapName(body) {
  for (const object of [body?.data?.company, body?.company, body?.data?.user, body?.user, body?.data, body?.result, body]) {
    if (!isObject(object)) continue;
    const name = clean(first(object, ["companyName", "company_name", "displayName", "display_name", "name", "nickname", "nickName", "userName", "username"]), 80);
    if (name) return name;
  }
  return "";
}
// The key names of a response (never its values), for a log line when a shape is not recognised.
const keyNames = (body) => {
  if (Array.isArray(body)) return "a top-level array";
  if (!isObject(body)) return "no object";
  const names = Object.keys(body).slice(0, 12);
  const inner = isObject(body.data) ? "; data keys: " + Object.keys(body.data).slice(0, 12).join(", ") : "";
  return "keys: " + (names.join(", ") || "none") + inner;
};
const clip = (value) => value === undefined || value === null ? "none" : String(value).replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
// Non-secret facts about a token response, for a log line: its key names, token_type, scope and lifetime, and the
// access token's length and whether it looks like a JWT. Never a token value.
const tokenShape = (result) => {
  if (!isObject(result)) return "no object";
  const token = typeof result.access_token === "string" ? result.access_token : "";
  return keyNames(result) + "; token_type " + clip(result.token_type) + "; scope " + clip(result.scope) + "; expires_in " + clip(result.expires_in) + "; access token " + token.length + " characters" + (token.split(".").length === 3 ? ", JWT-shaped" : "");
};
// Why Agora refused a request, for a log line: the status, WWW-Authenticate and the body's error fields. It reads the
// body, so use it only on a response that is otherwise discarded.
const refusal = async (response) => {
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  const fields = isObject(body) ? ["statusCode", "code", "error", "error_description", "phrase", "message", "msg", "redirectToLoginPage"].filter((key) => key in body).map((key) => key + " " + clip(body[key])) : [];
  return response.status + "; WWW-Authenticate " + clip(response.headers?.get?.("www-authenticate")) + "; " + (fields.join(", ") || keyNames(body));
};

export function createConnections(store, config = connectionsConfig(), { request = fetch, now = Date.now, log = (line) => console.log(line) } = {}) {
  const seal = (value, userId) => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", config.key, iv);
    cipher.setAAD(Buffer.from("agora:" + userId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  };
  const open = (value, userId) => {
    try {
      const cipher = createDecipheriv("aes-256-gcm", config.key, Buffer.from(value.iv, "base64"));
      cipher.setAAD(Buffer.from("agora:" + userId));
      cipher.setAuthTag(Buffer.from(value.tag, "base64"));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.ciphertext, "base64")), cipher.final()]));
    } catch { throw new AppError(503, "The Agora connection could not be opened. Check the server encryption key."); }
  };
  const same = (a, b) => { const left = Buffer.from(String(a)), right = Buffer.from(String(b)); return left.length === right.length && timingSafeEqual(left, right); };
  const reconnectError = () => new AppError(401, "Reconnect Agora Console to renew its access.", { reconnect: true });
  const lifetime = (result) => now() + Math.min(Number(result.expires_in) || 300, 86400) * 1000;
  // POST /api/v0/oauth/token with client_secret_post.
  async function tokenRequest(parameters) {
    const body = new URLSearchParams({ ...parameters, client_id: config.sso.clientId, client_secret: config.sso.secret });
    return request(config.sso.baseUrl + AGORA_PATHS.token, { method: "POST", body, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000), redirect: "error" });
  }
  // The connection's access token, renewed first when it is about to expire or when `stale` (the token Agora just
  // refused) is still the stored one. Renewal runs inside the store transaction, so concurrent calls renew once. A
  // refused renewal marks the connection as needing a reconnect.
  async function accessToken(userId, stale) {
    if (!config.ready) throw new AppError(503, "Agora Console connections are not configured yet.");
    const outcome = await store.transaction(async (state) => {
      const account = state.accounts.find((account) => account.id === userId);
      const connection = account?.connections?.agora;
      if (!connection) throw new AppError(403, "Connect your Agora account to access its projects.");
      const tokens = open(connection, userId);
      if (tokens.reconnect) return { reconnect: true };
      if (!(tokens.expiresAt < now() + 60000 || (stale && tokens.accessToken === stale))) return { token: tokens.accessToken };
      if (!config.sso.clientId || !config.sso.secret) return { reconnect: true };
      if (!tokens.refreshToken) { account.connections.agora = seal({ ...tokens, reconnect: true }, userId); return { reconnect: true }; }
      let response;
      try { response = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }); }
      catch { return { unreachable: true }; }
      let result = null;
      if (response.ok) { try { result = await response.json(); } catch { result = null; } }
      else log("Agora token renewal refused: " + await refusal(response) + ".");
      if (response.status >= 500) return { unreachable: true };
      if (typeof result?.access_token !== "string" || !result.access_token) {
        account.connections.agora = seal({ ...tokens, reconnect: true }, userId);
        return { reconnect: true };
      }
      const renewed = { ...tokens, accessToken: result.access_token, refreshToken: typeof result.refresh_token === "string" && result.refresh_token ? result.refresh_token : tokens.refreshToken, expiresAt: lifetime(result) };
      account.connections.agora = seal(renewed, userId);
      return { token: renewed.accessToken };
    });
    if (outcome.unreachable) throw new AppError(503, "Agora could not renew this connection.");
    if (outcome.reconnect) throw reconnectError();
    return outcome.token;
  }
  const bearerRequest = (token, path, method = "GET") => request(config.sso.baseUrl + path, { method, headers: { Authorization: "Bearer " + token, Accept: "application/json" }, signal: AbortSignal.timeout(10000), redirect: "error" });
  const readBody = async (response) => { try { return await response.json(); } catch { return undefined; } };
  // One Agora call with the connection's bearer token; a 401 renews the token once and retries.
  async function agoraCall(userId, path, method = "GET") {
    let token = await accessToken(userId), response;
    try {
      response = await bearerRequest(token, path, method);
      if (response.status === 401) {
        log("Agora refused " + method + " " + path + ": " + await refusal(response) + ".");
        token = await accessToken(userId, token);
        response = await bearerRequest(token, path, method);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, "Agora could not be reached.");
    }
    if (response.status === 401) {
      log("Agora refused " + method + " " + path + " after renewal: " + await refusal(response) + ".");
      throw reconnectError();
    }
    return { status: response.status, ok: response.ok, body: await readBody(response) };
  }
  // The project list: GET /api/v0/customer/project, or GET /api/v0/project where the first is not found.
  async function listProjects(userId) {
    let result = await agoraCall(userId, AGORA_PATHS.customerProjects), path = AGORA_PATHS.customerProjects;
    if (result.status === 404) { path = AGORA_PATHS.projects; result = await agoraCall(userId, path); }
    if (!result.ok) { log("Agora project list failed: GET " + path + " answered " + result.status + "."); throw new AppError(503, "Agora projects could not be loaded. You may need to reconnect."); }
    const mapped = mapProjects(result.body);
    if (!mapped) { log("Agora project list not recognised: GET " + path + " answered " + result.status + " with " + keyNames(result.body) + "."); throw new AppError(503, "Agora returned a project list the Portal does not recognise yet."); }
    return mapped.projects;
  }
  // The Agora account's display name: the company name, else the authorised user's name. Any failure leaves it out.
  async function agoraName(token) {
    for (const path of [AGORA_PATHS.companyInfo, AGORA_PATHS.userAuth]) {
      try {
        const response = await bearerRequest(token, path);
        if (!response.ok) { log("Agora name lookup GET " + path + " answered " + await refusal(response) + "."); continue; }
        const name = mapName(await readBody(response));
        if (name) return name;
      } catch { /* Try the next source. */ }
    }
    return "";
  }
  async function save(userId, tokens) {
    if (!config.ready) return;
    if (!tokens?.accessToken) throw new AppError(422, "Invalid Agora connection.");
    await store.transaction((state) => {
      const account = state.accounts.find((account) => account.id === userId);
      if (!account) throw new AppError(403, "Sign in before connecting Agora Console resources.");
      account.connections ||= {}; account.connections.agora = seal(tokens, userId);
    });
  }
  const withoutCertificate = ({ certificate, ...project }) => project;
  return {
    config,
    save,
    // Used by scripts/agora-shapes.mjs: a raw GET with the stored token (status and parsed body), never logged.
    get: (userId, path) => agoraCall(userId, path),
    async status(userId) {
      const connection = (await store.snapshot()).accounts.find((account) => account.id === userId)?.connections?.agora;
      const status = { ready: config.ready, connect: Boolean(config.connect?.ready), connected: Boolean(connection) };
      if (connection) {
        // The Agora account name is display metadata only; it never identifies the Portal account.
        let tokens = null;
        try { tokens = open(connection, userId); } catch { /* An unreadable connection shows no name and needs a reconnect. */ }
        status.name = tokens?.name || null;
        status.reconnect = !tokens || Boolean(tokens.reconnect);
      }
      return { agora: status };
    },
    // Starts Agora's authorization-code flow for a signed-in account. No PKCE: Agora refuses it for confidential clients
    // ("PKCE is not supported for confidential client"); the client secret and the single-use, account-bound state protect the code. The caller stores the transaction,
    // which is bound to the account, and keeps its ID in a short-lived cookie.
    beginConnect(accountId) {
      if (!config.connect?.ready) throw new ConnectError("unavailable");
      const transaction = { id: randomBytes(32).toString("base64url"), kind: CONNECT_KIND, accountId, state: randomBytes(32).toString("base64url"), createdAt: now() };
      const url = new URL(config.sso.baseUrl + AGORA_PATHS.authorize);
      for (const [name, value] of Object.entries({ response_type: "code", client_id: config.sso.clientId, redirect_uri: config.connect.redirectUri, scope: config.sso.scope, state: transaction.state })) url.searchParams.set(name, value);
      return { url: url.href, transaction };
    },
    // Completes the flow: the transaction must be a connect transaction for this same signed-in account, with the
    // state Agora returned. The code is redeemed only after those checks; the tokens are stored sealed.
    async completeConnect(transaction, parameters, accountId) {
      if (!config.connect?.ready) throw new ConnectError("unavailable");
      if (!transaction || transaction.kind !== CONNECT_KIND || typeof transaction.state !== "string") throw new ConnectError("transaction");
      if (!accountId || transaction.accountId !== accountId) throw new ConnectError("account");
      const states = parameters.getAll("state");
      if (states.length !== 1 || !same(states[0], transaction.state)) throw new ConnectError("state");
      if (parameters.has("error")) throw new ConnectError("agora_error");
      const code = parameters.get("code");
      if (!code || code.length > 4096) throw new ConnectError("code");
      let result;
      try {
        const response = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: config.connect.redirectUri });
        if (!response.ok) { log("Agora code exchange refused: " + await refusal(response) + "."); throw new Error("refused"); }
        result = await response.json();
      } catch { throw new ConnectError("token"); }
      log("Agora code exchange answered " + tokenShape(result) + ".");
      if (typeof result?.access_token !== "string" || !result.access_token || result.access_token.length > 8192) throw new ConnectError("token");
      const tokens = { accessToken: result.access_token, refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : "", expiresAt: lifetime(result) };
      const name = await agoraName(result.access_token);
      if (name) tokens.name = name;
      await save(accountId, tokens);
    },
    // Lists omit certificates.
    async projects(userId) { return { projects: (await listProjects(userId)).map(withoutCertificate) }; },
    // A project's certificate, from GET /api/v0/project/{vendorId}, only on explicit request; never cached.
    async certificate(userId, projectId) {
      if (typeof projectId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(projectId)) throw new AppError(422, "Choose a project.");
      const result = await agoraCall(userId, AGORA_PATHS.project(projectId));
      if (result.status === 404 || result.status === 403) throw new AppError(404, "This Agora project was not found in your account.");
      if (!result.ok) { log("Agora project details failed: GET /api/v0/project/{vendorId} answered " + result.status + "."); throw new AppError(503, "Agora project details could not be loaded."); }
      let project = mapProjectDetails(result.body);
      if (!project) log("Agora project details not recognised: GET /api/v0/project/{vendorId} answered " + result.status + " with " + keyNames(result.body) + ".");
      // Some lists carry the certificate when the details do not.
      if (!project?.certificate) {
        try { project = (await listProjects(userId)).find((entry) => entry.projectId === projectId) || project; }
        catch { /* The details are enough to answer. */ }
      }
      if (!project) throw new AppError(404, "This Agora project was not found in your account.");
      return { projectId, appId: project.appId, certificate: project.certificate || null };
    },
    // Revokes the authorization at Agora (DELETE /api/v0/customer/user-auth, best effort), then forgets it.
    async disconnect(userId) {
      try {
        const result = await agoraCall(userId, AGORA_PATHS.userAuth, "DELETE");
        if (!result.ok) log("Agora authorization removal answered " + result.status + "; the connection is removed anyway.");
      } catch (error) { if (error.status !== 403) log("Agora authorization removal failed; the connection is removed anyway."); }
      return store.transaction((state) => {
        const account = state.accounts.find((account) => account.id === userId);
        if (account?.connections) delete account.connections.agora;
      });
    }
  };
}
