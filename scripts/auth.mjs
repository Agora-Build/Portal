import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as oidc from "openid-client";
import { importPKCS8, SignJWT } from "jose";
import { AppError, safeUrl } from "./store.mjs";

const names = { google: "Google", github: "GitHub", apple: "Apple", agora: "Agora" };
const metadata = {
  google: { issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" },
  github: { issuer: "https://github.com", authorization_endpoint: "https://github.com/login/oauth/authorize", token_endpoint: "https://github.com/login/oauth/access_token" },
  apple: { issuer: "https://appleid.apple.com", authorization_endpoint: "https://appleid.apple.com/auth/authorize", token_endpoint: "https://appleid.apple.com/auth/token", jwks_uri: "https://appleid.apple.com/auth/keys" }
};
const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function authConfig(env = process.env) {
  let origin = "";
  try {
    const url = new URL(env.SITE_URL);
    if (!url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) origin = url.origin;
  } catch { /* Sign-in stays unavailable until a public origin is configured. */ }
  const providers = Object.fromEntries(Object.entries(names).map(([id, name]) => {
    const prefix = id === "agora" ? "AGORA_OIDC" : id.toUpperCase();
    const clientId = env[prefix + "_CLIENT_ID"] || "";
    const secret = env[prefix + "_CLIENT_SECRET"] || "";
    const value = { id, name, clientId, secret, issuer: metadata[id]?.issuer || env.AGORA_OIDC_ISSUER || "", ready: Boolean(origin && clientId && secret) };
    if (id === "apple") {
      Object.assign(value, { teamId: env.APPLE_TEAM_ID || "", keyId: env.APPLE_KEY_ID || "", keyFile: env.APPLE_PRIVATE_KEY_FILE || "" });
      value.ready = Boolean(origin.startsWith("https:") && clientId && value.teamId && value.keyId && value.keyFile && existsSync(value.keyFile));
    }
    if (id === "agora") {
      if (env.AGORA_OAUTH_CLIENT_ID) {
        Object.assign(value, { mode: "oauth", clientId: env.AGORA_OAUTH_CLIENT_ID, secret: env.AGORA_OAUTH_CLIENT_SECRET || "", issuer: env.AGORA_OAUTH_BASE_URL || "https://sso2.agora.io", userinfo: env.AGORA_OAUTH_USERINFO_URL || "", subjectField: env.AGORA_OAUTH_SUBJECT_FIELD || "sub" });
        try {
          const info = new URL(value.userinfo);
          value.ready = Boolean(origin && info.protocol === "https:" && !info.username && !info.password && ["sub", "user_id", "uid"].includes(value.subjectField));
        } catch { value.ready = false; }
      }
      try { const issuer = new URL(value.issuer); value.ready &&= issuer.protocol === "https:" && !issuer.username && !issuer.password; }
      catch { value.ready = false; }
    }
    return [id, value];
  }));
  return { origin, providers };
}

export function returnPath(value) {
  if (typeof value !== "string" || value.length > 1500 || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
  const url = new URL(value, "https://foundry.invalid");
  const stoa = /^\/stoa\/(?:room\/[a-z0-9-]{2,40}|s\/[a-f0-9-]{36})?$/.test(url.pathname);
  if (!["/", "/index.html", "/explore.html", "/radar.html", "/services.html", "/account.html", "/oauth/authorize"].includes(url.pathname) && !stoa && !/^\/meet\/[a-f0-9-]{36}$/.test(url.pathname)) return "/";
  url.searchParams.delete("signin");
  return url.pathname + url.search + url.hash;
}

// An email counts only when the provider says it verified it; stored lower-case so the same address matches across providers.
// Only plain ASCII addresses match, so no Unicode case-folding can make two mailboxes look alike.
const verifiedEmail = (value, verified) => verified && typeof value === "string" && value.length <= 254 && /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+\.[\x21-\x3f\x41-\x7e]+$/.test(value) ? value.toLowerCase() : null;

export function createAuth(config = authConfig(), { request = fetch, now = Date.now } = {}) {
  const pending = new Map();
  const clients = new Map();
  const clientRequest = (url, options = {}) => {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    return request(url, { ...options, headers, signal: AbortSignal.timeout(10000) });
  };
  const provider = (id) => {
    const value = config.providers[id];
    if (!value) throw new AppError(404, "This sign-in provider was not found.");
    if (!value.ready) throw new AppError(503, value.name + " sign-in is not connected yet.");
    return value;
  };
  async function agoraIdentity(accessToken) {
    const value = provider("agora");
    if (value.mode !== "oauth" || typeof accessToken !== "string" || !accessToken || accessToken.length > 4096 || /[\r\n]/.test(accessToken)) throw new AppError(400, "Agora token exchange is not available.");
    try {
      const response = await request(value.userinfo, { headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" }, signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!response.ok) throw new Error();
      const user = await response.json();
      const subject = user[value.subjectField];
      // loginId and email are mutable; only an explicitly configured immutable ID is accepted.
      if (!((typeof subject === "string" && subject.length > 0 && subject.length <= 255) || (Number.isSafeInteger(subject) && subject > 0))) throw new Error();
      return { provider: "agora", issuer: value.issuer, subject: String(subject), name: user.name || user.display_name || "Agora builder", avatar: safeUrl(user.picture), contact: "" };
    } catch { throw new AppError(401, "Agora could not provide a verified permanent user ID. Sign in through Agora.Build instead."); }
  }
  async function clientFor(value) {
    const cached = clients.get(value.id);
    if (cached && cached.until > now()) return cached.promise;
    const promise = (async () => {
      let secret = value.secret;
      if (value.id === "apple") {
        const key = await importPKCS8(await readFile(value.keyFile, "utf8"), "ES256");
        secret = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: value.keyId }).setIssuer(value.teamId).setSubject(value.clientId).setAudience(value.issuer).setIssuedAt().setExpirationTime("5m").sign(key);
      }
      const auth = secret ? oidc.ClientSecretPost(secret) : oidc.None();
      const agoraOAuth = value.mode === "oauth" ? { issuer: value.issuer, authorization_endpoint: value.issuer.replace(/\/$/, "") + "/api/v0/oauth/authorize", token_endpoint: value.issuer.replace(/\/$/, "") + "/api/v0/oauth/token" } : null;
      const client = value.id === "agora" && !agoraOAuth ? await oidc.discovery(new URL(value.issuer), value.clientId, undefined, auth, { [oidc.customFetch]: clientRequest, timeout: 10 }) : new oidc.Configuration(agoraOAuth || metadata[value.id], value.clientId, undefined, auth);
      client[oidc.customFetch] = clientRequest;
      client.timeout = 10;
      if (value.id !== "github" && !agoraOAuth) oidc.enableNonRepudiationChecks(client);
      return client;
    })();
    clients.set(value.id, { promise, until: now() + (value.id === "apple" ? 240000 : 3600000) });
    try { return await promise; } catch (error) { clients.delete(value.id); throw error; }
  }
  return {
    config,
    agoraIdentity,
    providers() { return Object.values(config.providers).map(({ id, name, ready }) => ({ id, name, ready })); },
    async begin(id, { returnTo, linkToken, pendingLink } = {}) {
      const value = provider(id);
      for (const [state, transaction] of pending) if (transaction.expiresAt <= now()) pending.delete(state);
      if (pending.size >= 500) throw new AppError(429, "There are too many sign-ins in progress. Try again shortly.");
      const client = await clientFor(value);
      const state = randomBytes(32).toString("base64url");
      const nonce = oidc.randomNonce();
      const verifier = id === "apple" ? undefined : oidc.randomPKCECodeVerifier();
      const redirect = config.origin + "/auth/" + id + "/callback";
      const parameters = { redirect_uri: redirect, response_type: "code", state, scope: value.mode === "oauth" ? "basic_info,console" : id === "github" ? "read:user user:email" : id === "apple" ? "openid name email" : "openid profile email" };
      if (id !== "github" && value.mode !== "oauth") parameters.nonce = nonce;
      if (verifier) { parameters.code_challenge = await oidc.calculatePKCECodeChallenge(verifier); parameters.code_challenge_method = "S256"; }
      if (id === "apple") parameters.response_mode = "form_post";
      pending.set(state, { id, nonce, verifier, redirect, returnTo: returnPath(returnTo), linkToken, pendingLink, expiresAt: now() + 600000 });
      return { url: oidc.buildAuthorizationUrl(client, parameters).href, state, formPost: id === "apple" };
    },
    async complete(id, parameters, browserState) {
      const state = parameters.get("state");
      const transaction = pending.get(state);
      if (!transaction || transaction.id !== id || transaction.expiresAt <= now() || !equal(state, browserState) || parameters.getAll("state").length !== 1) throw new AppError(400, "This sign-in expired or could not be verified. Start again.");
      pending.delete(state);
      if (parameters.has("error")) throw new AppError(400, "Sign-in was cancelled. You can try another provider.");
      const value = provider(id);
      try {
        const client = await clientFor(value);
        const url = new URL(transaction.redirect);
        url.search = parameters.toString();
        const tokens = await oidc.authorizationCodeGrant(client, url, { expectedState: state, ...(transaction.verifier ? { pkceCodeVerifier: transaction.verifier } : {}), ...(id !== "github" && value.mode !== "oauth" ? { expectedNonce: transaction.nonce, idTokenExpected: true } : {}) });
        let identity;
        if (value.mode === "oauth") identity = await agoraIdentity(tokens.access_token);
        else if (id === "github") {
          const response = await request("https://api.github.com/user", { headers: { Authorization: "Bearer " + tokens.access_token, Accept: "application/vnd.github+json", "User-Agent": "Agora-Build-Portal", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw new Error("GitHub profile unavailable");
          const user = await response.json();
          if (!Number.isSafeInteger(user.id) || user.id < 1 || typeof user.login !== "string" || !/^[a-z0-9-]+$/i.test(user.login)) throw new Error("Invalid GitHub identity");
          // The account email links logins only when GitHub has verified it; the public profile email is not used.
          // If GitHub can't be asked this time, the email is left undefined so the stored one is kept rather than cleared.
          const emails = await request("https://api.github.com/user/emails", { headers: { Authorization: "Bearer " + tokens.access_token, Accept: "application/vnd.github+json", "User-Agent": "Agora-Build-Portal", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(10000) }).then((reply) => reply.ok ? reply.json() : undefined).catch(() => undefined);
          const primary = Array.isArray(emails) ? emails.find((entry) => entry?.primary && entry.verified === true) : null;
          identity = { subject: String(user.id), name: user.name || user.login, avatar: safeUrl(user.avatar_url), contact: "https://github.com/" + user.login, email: Array.isArray(emails) ? verifiedEmail(primary?.email, true) : undefined };
        } else {
          const claims = tokens.claims();
          if (!claims?.sub) throw new Error("Missing identity");
          let name = claims.name || "";
          if (id === "apple" && parameters.has("user")) {
            try { const user = JSON.parse(parameters.get("user")); name = [user.name?.firstName, user.name?.lastName].filter((part) => typeof part === "string").join(" "); }
            catch { /* Apple returns the name only on the first authorization. */ }
          }
          identity = { subject: claims.sub, name, avatar: safeUrl(claims.picture), contact: "", email: verifiedEmail(claims.email, claims.email_verified === true || claims.email_verified === "true") };
        }
        return { identity: { ...identity, provider: id, issuer: value.issuer }, returnTo: transaction.returnTo, linkToken: transaction.linkToken, pendingLink: transaction.pendingLink, ...(value.mode === "oauth" ? { connection: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || "", expiresAt: now() + Math.min(Number(tokens.expires_in) || 300, 86400) * 1000 } } : {}) };
      } catch { throw new AppError(400, "Sign-in could not be verified. Please try again."); }
    }
  };
}
