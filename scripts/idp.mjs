// The Portal's OIDC client for auth.agora.build: sign-in (code + PKCE), RP-initiated and back-channel logout,
// and verification of the IdP's access tokens for API callers. Errors carry reasons only, never token values.
import { randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { createLocalJWKSet, createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";

export const DEFAULT_AUDIENCE = "https://api.agora.build";
export const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
const ACCOUNT_ID = /^acct_[0-9A-HJKMNP-TV-Z]{26}$/;
const TRANSACTION_LIFETIME = 600000;
const DISCOVERY_RETRY = 30000;
const SCOPE = "openid profile email";
// Codes from openid-client/oauth4webapi meaning the token endpoint itself failed, as opposed to the ID token.
const EXCHANGE_CODES = new Set(["OAUTH_RESPONSE_BODY_ERROR", "OAUTH_RESPONSE_IS_NOT_JSON", "OAUTH_RESPONSE_IS_NOT_CONFORM", "OAUTH_HTTP_REQUEST_FORBIDDEN", "OAUTH_WWW_AUTHENTICATE_CHALLENGE", "OAUTH_REQUEST_PROTOCOL_FORBIDDEN"]);

export class LoginError extends Error {
  constructor(reason) {
    super("Sign-in failed: " + reason);
    this.name = "LoginError";
    this.reason = reason;
  }
}

export class TokenError extends Error {
  constructor(status, reason) {
    super(status === 503 ? "The identity provider's keys are unreachable" : "Invalid token: " + reason);
    this.name = "TokenError";
    this.status = status;
    this.reason = reason;
  }
}

class KeysUnavailable extends Error {}

const localHost = (hostname) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname) || hostname.endsWith(".localhost");
function safeOrigin(value, name, { allowPath = true } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(name + " must be a URL"); }
  if (url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== "/")) throw new TypeError(name + " must be a plain URL without credentials, query or fragment");
  if (!(url.protocol === "https:" || (url.protocol === "http:" && localHost(url.hostname)))) throw new TypeError(name + " must use https (http only for localhost)");
  return url;
}
const safeReturn = (value) => typeof value === "string" && value.length <= 1500 && value.startsWith("/") && !value.startsWith("//") && !/[\\\r\n]/.test(value) ? value : "/";
const safePicture = (value) => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try { return new URL(value).protocol === "https:" ? value : null; } catch { return null; }
};
// Only plain ASCII addresses the IdP has verified are kept, lower-cased.
const verifiedEmail = (value, verified) => verified === true && typeof value === "string" && value.length <= 254 && /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+\.[\x21-\x3f\x41-\x7e]+$/.test(value) ? value.toLowerCase() : null;
const plainString = (value, max = 255) => typeof value === "string" && value.length > 0 && value.length <= max;

export function createIdp({ issuer, clientId = "portal", clientSecret, siteUrl, audience = DEFAULT_AUDIENCE, request = fetch, now = Date.now } = {}) {
  const issuerUrl = safeOrigin(issuer, "AUTH_ISSUER");
  if (!plainString(clientId, 200)) throw new TypeError("PORTAL_CLIENT_ID must be set");
  if (typeof clientSecret !== "string" || clientSecret.length < 32) throw new TypeError("PORTAL_CLIENT_SECRET must be at least 32 characters");
  const site = safeOrigin(siteUrl, "SITE_URL");
  if (!plainString(audience, 500)) throw new TypeError("PORTAL_API_AUDIENCE must be set");
  const config = {
    issuer,
    clientId,
    redirectUri: site.origin + "/auth/callback",
    postLogoutRedirectUri: site.origin + "/",
    accountUrl: issuer.replace(/\/$/, "") + "/account"
  };
  const insecure = issuerUrl.protocol === "http:";
  const clientRequest = (url, options = {}) => request(url, { ...options, signal: options.signal || AbortSignal.timeout(10000) });

  let discovered = null;
  let pending = null;
  let lastAttempt = -Infinity;
  // Discovery is cached once it succeeds; until then a new attempt is made at most every 30 s.
  function discover() {
    if (discovered) return Promise.resolve(discovered);
    if (pending) return pending;
    if (now() - lastAttempt < DISCOVERY_RETRY) return Promise.resolve(null);
    lastAttempt = now();
    pending = (async () => {
      try {
        const client = await oidc.discovery(issuerUrl, clientId, { id_token_signed_response_alg: "ES256" }, oidc.ClientSecretBasic(clientSecret), {
          [oidc.customFetch]: clientRequest,
          timeout: 10,
          ...(insecure ? { execute: [oidc.allowInsecureRequests] } : {})
        });
        client[oidc.customFetch] = clientRequest;
        client.timeout = 10;
        oidc.enableNonRepudiationChecks(client);
        const { jwks_uri: jwksUri } = client.serverMetadata();
        if (!jwksUri) throw new Error("no jwks_uri");
        const remote = createRemoteJWKSet(new URL(jwksUri), { [customFetch]: request, cacheMaxAge: 60000, timeoutDuration: 5000 });
        discovered = { client, keys: keysFrom(remote) };
        return discovered;
      } catch {
        return null;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  // Keys come from the IdP JWKS (cached, refetched on an unknown kid). If the IdP can't be reached, keys already
  // seen still verify; an unknown key is reported as unavailable (503), never as a valid token.
  function keysFrom(remote) {
    return async (header, token) => {
      try {
        return await remote(header, token);
      } catch (error) {
        if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys || error instanceof errors.JOSENotSupported) throw error;
        const snapshot = remote.jwks();
        if (snapshot) {
          try { return await createLocalJWKSet(snapshot)(header, token); }
          catch (inner) { if (!(inner instanceof errors.JWKSNoMatchingKey)) throw inner; }
        }
        throw new KeysUnavailable();
      }
    };
  }

  async function verify(token, options) {
    if (typeof token !== "string" || !token || token.length > 8192) throw new TokenError(401, "malformed");
    const state = await discover();
    if (!state) throw new TokenError(503, "unavailable");
    try {
      const { payload } = await jwtVerify(token, state.keys, { issuer, algorithms: ["ES256"], currentDate: new Date(now()), clockTolerance: 30, ...options });
      return payload;
    } catch (error) {
      if (error instanceof KeysUnavailable) throw new TokenError(503, "unavailable");
      throw new TokenError(401, error?.code || "invalid");
    }
  }

  return {
    config,
    async available() {
      return Boolean(await discover());
    },
    async beginLogin({ returnTo } = {}) {
      const state = await discover();
      if (!state) throw new LoginError("unavailable");
      const transaction = {
        id: randomBytes(32).toString("base64url"),
        state: randomBytes(32).toString("base64url"),
        nonce: oidc.randomNonce(),
        verifier: oidc.randomPKCECodeVerifier(),
        returnTo: safeReturn(returnTo),
        createdAt: now()
      };
      const url = oidc.buildAuthorizationUrl(state.client, {
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: SCOPE,
        state: transaction.state,
        nonce: transaction.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier),
        code_challenge_method: "S256"
      });
      return { url: url.href, transaction };
    },
    async completeLogin(callbackUrl, transaction) {
      let parameters;
      try { parameters = new URL(callbackUrl, config.redirectUri).searchParams; } catch { throw new LoginError("state"); }
      if (!transaction || typeof transaction.state !== "string" || typeof transaction.nonce !== "string" || typeof transaction.verifier !== "string") throw new LoginError("state");
      if (!Number.isFinite(transaction.createdAt) || transaction.createdAt + TRANSACTION_LIFETIME <= now()) throw new LoginError("expired");
      if (parameters.getAll("state").length !== 1 || parameters.get("state") !== transaction.state) throw new LoginError("state");
      if (parameters.has("error")) throw new LoginError("idp_error");
      const state = await discover();
      if (!state) throw new LoginError("unavailable");
      // The token request's redirect_uri is always ours, whatever host the callback arrived on.
      const current = new URL(config.redirectUri);
      current.search = parameters.toString();
      let tokens;
      try {
        tokens = await oidc.authorizationCodeGrant(state.client, current, { pkceCodeVerifier: transaction.verifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true });
      } catch (error) {
        const exchange = error instanceof oidc.ResponseBodyError || error instanceof TypeError || error?.name === "TimeoutError" || error?.name === "AbortError" || EXCHANGE_CODES.has(error?.code);
        throw new LoginError(exchange ? "exchange" : "id_token");
      }
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== "string" || !ACCOUNT_ID.test(claims.sub) || typeof tokens.id_token !== "string") throw new LoginError("id_token");
      return {
        sub: claims.sub,
        sid: plainString(claims.sid) ? claims.sid : null,
        name: plainString(claims.name, 200) ? claims.name : null,
        picture: safePicture(claims.picture),
        email: verifiedEmail(claims.email, claims.email_verified),
        idToken: tokens.id_token
      };
    },
    endSessionUrl({ idToken } = {}) {
      if (!discovered?.client.serverMetadata().end_session_endpoint) return config.postLogoutRedirectUri;
      return oidc.buildEndSessionUrl(discovered.client, { post_logout_redirect_uri: config.postLogoutRedirectUri, ...(typeof idToken === "string" && idToken ? { id_token_hint: idToken } : {}) }).href;
    },
    async verifyLogoutToken(token) {
      const payload = await verify(token, { audience: clientId, typ: "logout+jwt", requiredClaims: ["iat"], maxTokenAge: 300 });
      const event = payload.events?.[LOGOUT_EVENT];
      if (!payload.events || typeof payload.events !== "object" || !event || typeof event !== "object" || Array.isArray(event)) throw new TokenError(401, "events");
      if (payload.nonce !== undefined) throw new TokenError(401, "nonce");
      if (payload.sid !== undefined && !plainString(payload.sid)) throw new TokenError(401, "sid");
      if (payload.sub !== undefined && !(typeof payload.sub === "string" && ACCOUNT_ID.test(payload.sub))) throw new TokenError(401, "sub");
      if (payload.sid === undefined && payload.sub === undefined) throw new TokenError(401, "subject");
      return { sub: payload.sub, sid: payload.sid };
    },
    async verifyAccessToken(token) {
      const payload = await verify(token, { audience, typ: "at+jwt", requiredClaims: ["exp", "sub"] });
      if (typeof payload.sub !== "string" || !ACCOUNT_ID.test(payload.sub)) throw new TokenError(401, "sub");
      if (!plainString(payload.client_id, 200)) throw new TokenError(401, "client_id");
      const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
      return { sub: payload.sub, clientId: payload.client_id, scopes };
    }
  };
}
