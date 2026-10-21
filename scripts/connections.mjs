import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "./store.mjs";

// Agora's OAuth (sso2.agora.io), used only to authorise Console access for an account that is already signed in.
const AGORA_SCOPE = "basic_info,console";
const CONNECT_KIND = "agora-connect";
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
  // Encrypts stored Agora Console tokens. CONNECTION_ENCRYPTION_KEY is the old name, still read so an existing deployment keeps its data.
  const key = Buffer.from(env.AGORA_CONSOLE_ENCRYPTION_KEY || env.CONNECTION_ENCRYPTION_KEY || "", "base64");
  const bffUrl = httpsEndpoint(env.AGORA_BFF_URL || "https://agora-cli.agora.io");
  // Agora's OAuth settings, used to connect an account to Agora Console and to renew that connection.
  const oauthBase = httpsEndpoint(env.AGORA_OAUTH_BASE_URL || "https://sso2.agora.io");
  const oauth = { clientId: env.AGORA_OAUTH_CLIENT_ID || "", secret: env.AGORA_OAUTH_CLIENT_SECRET || "", baseUrl: oauthBase, userinfo: env.AGORA_OAUTH_USERINFO_URL ? httpsEndpoint(env.AGORA_OAUTH_USERINFO_URL) : "" };
  // The callback is on the Portal's public origin: https, or plain http on a loopback host for local development.
  let redirectUri = "";
  try {
    const url = new URL(env.SITE_URL);
    if (!url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) redirectUri = url.origin + "/connect/agora/callback";
  } catch { /* Connect stays unavailable until a public origin is configured. */ }
  const ready = key.length === 32 && Boolean(bffUrl);
  // Setting names (never values) that keep the connect flow unavailable.
  const missing = [
    [key.length !== 32, "AGORA_CONSOLE_ENCRYPTION_KEY"], [!bffUrl, "AGORA_BFF_URL"], [!oauth.baseUrl, "AGORA_OAUTH_BASE_URL"],
    [!oauth.clientId, "AGORA_OAUTH_CLIENT_ID"], [!oauth.secret, "AGORA_OAUTH_CLIENT_SECRET"], [!redirectUri, "SITE_URL"]
  ].filter(([absent]) => absent).map(([, name]) => name);
  return { key, bffUrl, oauth, ready, connect: { ready: missing.length === 0, missing, redirectUri } };
}

export function createConnections(store, config = connectionsConfig(), { request = fetch, now = Date.now } = {}) {
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
  async function withProjects(userId, select) {
    if (!config.ready) throw new AppError(503, "Agora Console connections are not configured yet.");
    return store.transaction(async (state) => {
      const account = state.accounts.find((account) => account.id === userId);
      const connection = account?.connections?.agora;
      if (!connection) throw new AppError(403, "Connect your Agora account to access its projects.");
      const tokens = open(connection, userId);
      if (tokens.expiresAt < now() + 60000) {
        const { oauth } = config;
        if (!tokens.refreshToken || !oauth?.clientId || !oauth.baseUrl) throw new AppError(401, "Reconnect Agora to renew its Console access.");
        const parameters = new URLSearchParams({ grant_type: "refresh_token", client_id: oauth.clientId, refresh_token: tokens.refreshToken });
        if (oauth.secret) parameters.set("client_secret", oauth.secret);
        let response;
        try { response = await request(oauth.baseUrl + "/api/v0/oauth/token", { method: "POST", body: parameters, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000), redirect: "error" }); }
        catch { throw new AppError(503, "Agora could not renew this connection."); }
        if (!response.ok) throw new AppError(401, "Reconnect Agora to renew its Console access.");
        const result = await response.json();
        if (!result.access_token || !result.refresh_token) throw new AppError(401, "Agora did not return renewable credentials.");
        Object.assign(tokens, { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: now() + Math.min(Number(result.expires_in) || 300, 86400) * 1000 });
        account.connections.agora = seal(tokens, userId);
      }
      return tokens.accessToken;
    }).then(async (accessToken) => {
      let response;
      try { response = await request(config.bffUrl + "/api/cli/v1/projects", { headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" }, signal: AbortSignal.timeout(10000), redirect: "error" }); }
      catch { throw new AppError(503, "Agora projects could not be reached."); }
      if (!response.ok) throw new AppError(response.status === 401 ? 401 : 503, "Agora projects could not be loaded. You may need to reconnect.");
      const envelope = await response.json();
      if (!Array.isArray(envelope.items)) throw new AppError(503, "Agora returned an invalid project list.");
      return select(envelope.items);
    });
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
  // The Agora account's display name, from the optional AGORA_OAUTH_USERINFO_URL; any failure just leaves it out.
  async function agoraName(accessToken) {
    if (!config.oauth.userinfo) return "";
    try {
      const response = await request(config.oauth.userinfo, { headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" }, signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!response.ok) return "";
      const user = await response.json();
      const name = [user?.name, user?.display_name, user?.username].find((value) => typeof value === "string" && value.trim());
      return name ? name.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) : "";
    } catch { return ""; }
  }
  return {
    config,
    save,
    async status(userId) {
      const connection = (await store.snapshot()).accounts.find((account) => account.id === userId)?.connections?.agora;
      const status = { ready: config.ready, connect: Boolean(config.connect?.ready), connected: Boolean(connection) };
      if (connection) {
        // The Agora account name is display metadata only; it never identifies the Portal account.
        let name = null;
        try { name = open(connection, userId).name || null; } catch { /* An unreadable connection shows no name. */ }
        status.name = name;
      }
      return { agora: status };
    },
    // Starts Agora's authorization-code flow (PKCE S256) for a signed-in account. The caller stores the transaction,
    // which is bound to the account, and keeps its ID in a short-lived cookie.
    beginConnect(accountId) {
      if (!config.connect?.ready) throw new ConnectError("unavailable");
      const transaction = { id: randomBytes(32).toString("base64url"), kind: CONNECT_KIND, accountId, state: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url"), createdAt: now() };
      const url = new URL(config.oauth.baseUrl + "/api/v0/oauth/authorize");
      for (const [name, value] of Object.entries({ response_type: "code", client_id: config.oauth.clientId, redirect_uri: config.connect.redirectUri, scope: AGORA_SCOPE, state: transaction.state, code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url"), code_challenge_method: "S256" })) url.searchParams.set(name, value);
      return { url: url.href, transaction };
    },
    // Completes the flow: the transaction must be a connect transaction for this same signed-in account, with the
    // state Agora returned. The code is redeemed only after those checks; the tokens are stored sealed.
    async completeConnect(transaction, parameters, accountId) {
      if (!config.connect?.ready) throw new ConnectError("unavailable");
      if (!transaction || transaction.kind !== CONNECT_KIND || typeof transaction.state !== "string" || typeof transaction.verifier !== "string") throw new ConnectError("transaction");
      if (!accountId || transaction.accountId !== accountId) throw new ConnectError("account");
      const states = parameters.getAll("state");
      if (states.length !== 1 || !same(states[0], transaction.state)) throw new ConnectError("state");
      if (parameters.has("error")) throw new ConnectError("agora_error");
      const code = parameters.get("code");
      if (!code || code.length > 4096) throw new ConnectError("code");
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.connect.redirectUri, client_id: config.oauth.clientId, client_secret: config.oauth.secret, code_verifier: transaction.verifier });
      let result;
      try {
        const response = await request(config.oauth.baseUrl + "/api/v0/oauth/token", { method: "POST", body, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000), redirect: "error" });
        if (!response.ok) throw new Error("refused");
        result = await response.json();
      } catch { throw new ConnectError("token"); }
      if (typeof result?.access_token !== "string" || !result.access_token || result.access_token.length > 8192) throw new ConnectError("token");
      const tokens = { accessToken: result.access_token, refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : "", expiresAt: now() + Math.min(Number(result.expires_in) || 300, 86400) * 1000 };
      const name = await agoraName(result.access_token);
      if (name) tokens.name = name;
      await save(accountId, tokens);
    },
    projects(userId) { return withProjects(userId, (items) => ({ projects: items.map(({ projectId, name, appId, status }) => ({ projectId, name, appId, status })) })); },
    certificate(userId, projectId) {
      if (typeof projectId !== "string" || !projectId || projectId.length > 128) throw new AppError(422, "Choose a project.");
      return withProjects(userId, (items) => {
        const project = items.find((project) => project.projectId === projectId);
        if (!project) throw new AppError(404, "This Agora project was not found in your account.");
        return { projectId, appId: project.appId, certificate: project.signKey || null };
      });
    },
    async disconnect(userId) {
      return store.transaction((state) => {
        const account = state.accounts.find((account) => account.id === userId);
        if (account?.connections) delete account.connections.agora;
      });
    }
  };
}
