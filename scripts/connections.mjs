import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./store.mjs";

export function connectionsConfig(env = process.env) {
  const key = Buffer.from(env.CONNECTION_ENCRYPTION_KEY || "", "base64");
  let bffUrl = "";
  try {
    const url = new URL(env.AGORA_BFF_URL || "https://agora-cli.agora.io");
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) bffUrl = url.href.replace(/\/$/, "");
  } catch { /* Invalid endpoints cannot receive credentials. */ }
  return { key, bffUrl, ready: key.length === 32 && Boolean(bffUrl) };
}

export function createConnections(store, auth, config = connectionsConfig(), { request = fetch, now = Date.now } = {}) {
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
  async function withProjects(userId, select) {
    if (!config.ready) throw new AppError(503, "Agora Console connections are not configured yet.");
    return store.transaction(async (state) => {
      const account = state.accounts.find((account) => account.id === userId);
      const connection = account?.connections?.agora;
      if (!connection) throw new AppError(403, "Connect your Agora account to access its projects.");
      const tokens = open(connection, userId);
      if (tokens.expiresAt < now() + 60000) {
        const provider = auth.config.providers.agora;
        if (!tokens.refreshToken || provider.mode !== "oauth") throw new AppError(401, "Reconnect Agora to renew its Console access.");
        const parameters = new URLSearchParams({ grant_type: "refresh_token", client_id: provider.clientId, refresh_token: tokens.refreshToken });
        if (provider.secret) parameters.set("client_secret", provider.secret);
        let response;
        try { response = await request(provider.issuer.replace(/\/$/, "") + "/api/v0/oauth/token", { method: "POST", body: parameters, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000), redirect: "error" }); }
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
  return {
    config,
    async save(userId, tokens) {
      if (!config.ready) return;
      if (!tokens?.accessToken) throw new AppError(422, "Invalid Agora connection.");
      await store.transaction((state) => {
        const account = state.accounts.find((account) => account.id === userId);
        if (!account?.identities.some((identity) => identity.provider === "agora")) throw new AppError(403, "Verify your Agora login before connecting Console resources.");
        account.connections ||= {}; account.connections.agora = seal(tokens, userId);
      });
    },
    async status(userId) {
      const account = (await store.snapshot()).accounts.find((account) => account.id === userId);
      return { agora: { ready: config.ready, connected: Boolean(account?.connections?.agora) } };
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
