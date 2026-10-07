import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { AppError } from "./store.mjs";

const scopesAllowed = ["identity", "credits", "services", "agora:projects", "agora:certificates"];
export const secretEqual = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};
const secureUrl = (value) => {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Client URLs require HTTPS or local loopback HTTP.");
  return url.href;
};

export function identityConfig(env = process.env) {
  const clients = env.IDENTITY_CLIENTS_FILE ? JSON.parse(readFileSync(env.IDENTITY_CLIENTS_FILE, "utf8")) : [];
  if (!Array.isArray(clients)) throw new Error("IDENTITY_CLIENTS_FILE must contain a client array.");
  if (env.VOX_IDENTITY_CLIENT_SECRET && env.VOX_IDENTITY_REDIRECT_URI) clients.push({ id: "vox", name: "Vox", secret: env.VOX_IDENTITY_CLIENT_SECRET, redirects: [env.VOX_IDENTITY_REDIRECT_URI], scopes: ["identity", "credits", "services"], identityLookup: true });
  if (env.ASTATION_IDENTITY_ENABLED === "true") clients.push({ id: "astation", name: "Astation", loopback: true, scopes: ["identity", "credits", "services", "agora:projects"] });
  const ids = new Set();
  for (const client of clients) {
    if (client.secretEnv) client.secret = env[client.secretEnv] || "";
    if (!/^[a-z][a-z0-9-]{1,60}$/.test(client.id) || ids.has(client.id) || typeof client.name !== "string" || client.name.length > 80) throw new Error("Invalid or duplicate identity client.");
    ids.add(client.id);
    client.scopes ||= ["identity"];
    if (!Array.isArray(client.scopes) || client.scopes.some((scope) => !scopesAllowed.includes(scope))) throw new Error("Invalid identity client scopes.");
    client.rates ||= {};
    if (typeof client.rates !== "object" || Array.isArray(client.rates) || Object.entries(client.rates).some(([name, price]) => !/^[a-z][a-z0-9-]{1,40}$/.test(name) || !Number.isSafeInteger(price) || price < 1)) throw new Error("Invalid registered service prices.");
    if (client.loopback) {
      if (client.secret || client.identityLookup) throw new Error("Native clients cannot receive server privileges.");
    } else {
      if (typeof client.secret !== "string" || client.secret.length < 32 || !Array.isArray(client.redirects) || !client.redirects.length) throw new Error("Web clients require a 32-character secret and exact redirect URLs.");
      client.redirects = client.redirects.map(secureUrl);
    }
  }
  return { clients };
}

export function createIdentity(store, config = identityConfig()) {
  const clientFor = (id) => {
    const client = config.clients.find((client) => client.id === id);
    if (!client) throw new AppError(400, "This application is not registered with Agora.Build.");
    return client;
  };
  const authenticate = (parameters) => {
    const client = clientFor(parameters.get("client_id"));
    if (client.secret && !secretEqual(client.secret, parameters.get("client_secret"))) throw new AppError(401, "Invalid application credentials.");
    return client;
  };
  return {
    config,
    authenticate,
    authorization(parameters) {
      for (const key of ["client_id", "redirect_uri", "state", "scope", "response_type", "code_challenge", "code_challenge_method"]) if (parameters.getAll(key).length > 1) throw new AppError(400, "Duplicate authorization parameter.");
      const client = clientFor(parameters.get("client_id"));
      const redirectUri = parameters.get("redirect_uri");
      let url;
      try { url = new URL(secureUrl(redirectUri)); } catch { throw new AppError(400, "Invalid callback URL."); }
      const loopback = client.loopback && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === "/oauth/callback" && !url.search;
      if (!loopback && !client.redirects?.includes(redirectUri)) throw new AppError(400, "This callback URL is not registered.");
      const state = parameters.get("state"), challenge = parameters.get("code_challenge");
      if (parameters.get("response_type") !== "code" || parameters.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge || "") || typeof state !== "string" || state.length < 16 || state.length > 256 || /[\r\n]/.test(state)) throw new AppError(400, "A code flow with state and S256 PKCE is required.");
      const scopes = [...new Set((parameters.get("scope") || "identity").split(" ").filter(Boolean))];
      if (!scopes.includes("identity") || scopes.some((scope) => !client.scopes.includes(scope))) throw new AppError(400, "This application cannot request those permissions.");
      return { client, clientId: client.id, redirectUri, state, challenge, scopes };
    },
    async token(parameters) {
      for (const [key] of parameters) if (parameters.getAll(key).length !== 1) throw new AppError(400, "Duplicate token parameter.");
      const client = authenticate(parameters);
      if (parameters.get("grant_type") === "authorization_code") {
        const verifier = parameters.get("code_verifier") || "";
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(parameters.get("code") || "")) throw new AppError(400, "Invalid code or PKCE verifier.");
        return store.exchangeCode({ clientId: client.id, code: parameters.get("code"), redirectUri: parameters.get("redirect_uri"), verifier });
      }
      if (parameters.get("grant_type") === "refresh_token") {
        const result = await store.refreshGrant(client.id, parameters.get("refresh_token") || "");
        if (!result) throw new AppError(400, "Invalid or revoked refresh token. Sign in again.");
        return result;
      }
      throw new AppError(400, "Unsupported grant type.");
    },
    serviceClient(request) {
      const client = clientFor(request.headers["x-agora-client-id"]);
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      if (!client.secret || !client.identityLookup || !secretEqual(client.secret, token)) throw new AppError(403, "This application cannot resolve account identities.");
      return client;
    },
    async billingClient(request) {
      const client = clientFor(request.headers["x-agora-client-id"]);
      if (!client.secret || !secretEqual(client.secret, request.headers.authorization?.replace(/^Bearer /, ""))) throw new AppError(401, "Invalid service credentials.");
      const user = await store.access(request.headers["x-agora-user-token"], "credits");
      if (user.clientId !== client.id) throw new AppError(403, "This user token belongs to another application.");
      return { client, user };
    }
  };
}
