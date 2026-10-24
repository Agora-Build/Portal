// The Portal's OIDC client for auth.agora.build: sign-in (code + PKCE), RP-initiated and back-channel logout,
// and verification of the IdP's access tokens for API callers. Errors carry reasons only, never token values.
import { randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { createLocalJWKSet, createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";

export const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
const ACCOUNT_ID = /^ab[0-9A-HJKMNP-TV-Z]{26}$/;
const TRANSACTION_LIFETIME = 600000;
const DISCOVERY_RETRY = 30000;
const SCOPE = "openid profile email";
const KEY_BACKOFF = 30000;
// After a key rotation, a new kid may be refetched 5 s after the last JWKS fetch (jose's default is 30 s).
const KEY_COOLDOWN = 5000;
// Sign-in re-checks that the IdP answers when nothing has been heard from it for 30 s, with a short timeout.
const CONTACT_WINDOW = 30000;
const PROBE_TIMEOUT = 2000;
const SNAPSHOT_LIFETIME = 3600000;
// Codes from openid-client/oauth4webapi that mean the ID token failed validation. Anything else from the code
// exchange is labelled "exchange". OAUTH_INVALID_RESPONSE covers both, so its detail decides (labels only; both fail).
const ID_TOKEN_CODES = new Set(["OAUTH_JWT_CLAIM_COMPARISON_FAILED", "OAUTH_JWT_TIMESTAMP_CHECK_FAILED", "OAUTH_KEY_SELECTION_FAILED"]);
const idTokenFailure = (error) => ID_TOKEN_CODES.has(error?.code) || (error?.code === "OAUTH_INVALID_RESPONSE" && /JWT|id_token|"alg"/.test(String(error.cause?.message || "")));

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

// RFC 6749 section 2.3.1: client credentials are form-urlencoded before base64.
const formEncode = (value) => encodeURIComponent(value).replace(/%20/g, "+");

const SILENT_NO = new Set(["login_required", "interaction_required", "consent_required", "account_selection_required"]);

export function createIdp({ issuer: issuerSetting, clientId = "portal", clientSecret, siteUrl, audience: audienceSetting, request = fetch, now = Date.now } = {}) {
  // A single trailing slash is dropped, so "https://auth.agora.build/" matches the IdP's exact issuer.
  const issuer = typeof issuerSetting === "string" ? issuerSetting.replace(/\/$/, "") : issuerSetting;
  const issuerUrl = safeOrigin(issuer, "AUTH_ISSUER");
  if (!plainString(clientId, 200)) throw new TypeError("PORTAL_CLIENT_ID must be set");
  if (typeof clientSecret !== "string" || clientSecret.length < 32) throw new TypeError("PORTAL_CLIENT_SECRET must be at least 32 characters");
  const site = safeOrigin(siteUrl, "SITE_URL");
  // Access tokens for this Portal name its own origin as their audience (the resource apps request), e.g.
  // https://agora.build or https://dev.agora.build; PORTAL_API_AUDIENCE overrides it.
  const audience = audienceSetting === undefined ? site.origin : audienceSetting;
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
  // The last time the IdP answered (discovery, a token exchange or a JWKS fetch), and until when a failed probe
  // keeps sign-in unavailable. The cached keys stay usable for access tokens meanwhile.
  let lastContact = -Infinity;
  let unreachableUntil = -Infinity;
  let probing = null;
  // Discovery is cached once it succeeds; until then a new attempt is made at most every 30 s.
  function discover() {
    if (discovered) return Promise.resolve(discovered);
    if (pending) return pending;
    if (now() - lastAttempt < DISCOVERY_RETRY) return Promise.resolve(null);
    lastAttempt = now();
    pending = (async () => {
      try {
        const skew = clockSkew();
        const client = setUp(await oidc.discovery(issuerUrl, clientId, clientMetadata(skew), oidc.ClientSecretBasic(clientSecret), {
          [oidc.customFetch]: clientRequest,
          timeout: 10,
          ...(insecure ? { execute: [oidc.allowInsecureRequests] } : {})
        }));
        const { jwks_uri: jwksUri } = client.serverMetadata();
        if (!jwksUri) throw new Error("no jwks_uri");
        discovered = { client, skew, keys: keysFrom(new URL(jwksUri)) };
        lastContact = now();
        return discovered;
      } catch {
        return null;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  // openid-client checks ID token times against Date.now() plus a fixed skew, so the injected clock becomes a skew.
  // The client is rebuilt only when the skew changes (never, in production).
  const clockSkew = () => Math.round((now() - Date.now()) / 1000);
  const clientMetadata = (skew) => ({ id_token_signed_response_alg: "ES256", [oidc.clockSkew]: skew });
  function setUp(client) {
    client[oidc.customFetch] = clientRequest;
    client.timeout = 10;
    if (insecure) oidc.allowInsecureRequests(client);
    oidc.enableNonRepudiationChecks(client);
    return client;
  }
  function loginClient(state) {
    const skew = clockSkew();
    if (state.skew !== skew) Object.assign(state, { skew, client: setUp(new oidc.Configuration(state.client.serverMetadata(), clientId, clientMetadata(skew), oidc.ClientSecretBasic(clientSecret))) });
    return state.client;
  }

  // Keys come from the IdP JWKS (cached 60 s, refetched on an unknown kid). If a fetch fails, the last good key set
  // still verifies known keys, for at most 1 h after it was fetched, and the network is left alone for 30 s. An
  // unknown key while the IdP is unreachable is reported as unavailable (503), never as a valid token.
  function keysFrom(jwksUrl) {
    let fetchedAt, failedAt, failures = 0, snapshot = { at: undefined, keys: null };
    const jwksFetch = async (url, options) => {
      try {
        const response = await request(url, options);
        const body = response.status === 200 ? await response.clone().json().catch(() => null) : null;
        if (Array.isArray(body?.keys)) { fetchedAt = now(); lastContact = fetchedAt; }
        else { failedAt = now(); failures += 1; }
        return response;
      } catch (error) {
        failedAt = now();
        failures += 1;
        throw error;
      }
    };
    const remote = createRemoteJWKSet(jwksUrl, { [customFetch]: jwksFetch, cacheMaxAge: 60000, cooldownDuration: KEY_COOLDOWN, timeoutDuration: 5000 });
    const cached = async (header, token) => {
      const jwks = remote.jwks();
      if (!jwks || fetchedAt === undefined || now() - fetchedAt > SNAPSHOT_LIFETIME) throw new KeysUnavailable();
      if (snapshot.at !== fetchedAt) snapshot = { at: fetchedAt, keys: createLocalJWKSet(jwks) };
      try { return await snapshot.keys(header, token); }
      catch (error) { if (error instanceof errors.JWKSNoMatchingKey) throw new KeysUnavailable(); throw error; }
    };
    const keys = async (header, token) => {
      if (failedAt !== undefined && now() - failedAt < KEY_BACKOFF) return cached(header, token);
      const before = failures;
      try {
        return await remote(header, token);
      } catch (error) {
        if (failures === before) throw error;
        return cached(header, token);
      }
    };
    // Fetches the key set now (used at startup), so the first token doesn't wait for a cold JWKS fetch.
    keys.warm = async () => { await remote.reload(); if (fetchedAt === undefined) throw new Error("no keys"); };
    return keys;
  }

  // Fetches the discovery document (at most 2 s). On success the cached metadata is refreshed if it changed; on
  // failure sign-in is unavailable for the 30 s retry interval.
  function probe() {
    if (probing) return probing;
    probing = (async () => {
      try {
        const response = await request(new URL(".well-known/openid-configuration", issuerUrl.href.endsWith("/") ? issuerUrl.href : issuerUrl.href + "/").href, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(PROBE_TIMEOUT) });
        const metadata = response.status === 200 ? await response.json() : null;
        if (!metadata || metadata.issuer !== issuer || typeof metadata.jwks_uri !== "string" || !metadata.jwks_uri) throw new Error("invalid discovery");
        const state = discovered;
        if (JSON.stringify(metadata) !== JSON.stringify(state.client.serverMetadata())) {
          const client = setUp(new oidc.Configuration(metadata, clientId, clientMetadata(state.skew), oidc.ClientSecretBasic(clientSecret)));
          const keys = metadata.jwks_uri === state.client.serverMetadata().jwks_uri ? state.keys : keysFrom(new URL(metadata.jwks_uri));
          discovered = { client, skew: state.skew, keys };
        }
        lastContact = now();
        unreachableUntil = -Infinity;
        return true;
      } catch {
        unreachableUntil = now() + DISCOVERY_RETRY;
        return false;
      } finally {
        probing = null;
      }
    })();
    return probing;
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
    // Discovery and the JWKS, fetched at startup without blocking it, so the first back-channel logout or access
    // token doesn't wait for a cold 10 s discovery or 5 s JWKS fetch. Resolves to null, or a failure reason.
    async warm() {
      const state = await discover();
      if (!state) return "discovery";
      try { await state.keys.warm(); return null; } catch { return "jwks"; }
    },
    // Whether sign-in can start. Once discovery has succeeded, the IdP is probed again only when it hasn't answered
    // for 30 s, so a healthy IdP costs nothing here and a stopped one makes sign-in report itself unavailable.
    async available() {
      if (!discovered) return Boolean(await discover());
      if (now() - lastContact < CONTACT_WINDOW) return true;
      if (now() < unreachableUntil) return false;
      return probe();
    },
    // `silent` asks the IdP not to show any page (prompt=none): it answers at once, signed in or not.
    async beginLogin({ returnTo, silent = false } = {}) {
      const state = await discover();
      if (!state) throw new LoginError("unavailable");
      const transaction = {
        id: randomBytes(32).toString("base64url"),
        state: randomBytes(32).toString("base64url"),
        nonce: oidc.randomNonce(),
        verifier: oidc.randomPKCECodeVerifier(),
        returnTo: safeReturn(returnTo),
        silent: silent === true,
        createdAt: now()
      };
      const url = oidc.buildAuthorizationUrl(state.client, {
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: SCOPE,
        state: transaction.state,
        nonce: transaction.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier),
        code_challenge_method: "S256",
        ...(transaction.silent ? { prompt: "none" } : {})
      });
      return { url: url.href, transaction };
    },
    async completeLogin(callbackUrl, transaction) {
      let parameters;
      try { parameters = new URL(callbackUrl, config.redirectUri).searchParams; } catch { throw new LoginError("state"); }
      if (!transaction || typeof transaction.state !== "string" || typeof transaction.nonce !== "string" || typeof transaction.verifier !== "string") throw new LoginError("state");
      if (!Number.isFinite(transaction.createdAt) || transaction.createdAt + TRANSACTION_LIFETIME <= now()) throw new LoginError("expired");
      if (parameters.getAll("state").length !== 1 || parameters.get("state") !== transaction.state) throw new LoginError("state");
      // A silent check where the person isn't signed in at the IdP (OIDC Core 3.1.2.6) is an answer, not a failure.
      if (parameters.has("error")) throw new LoginError(transaction.silent === true && SILENT_NO.has(parameters.get("error")) ? "not_signed_in" : "idp_error");
      const state = await discover();
      if (!state) throw new LoginError("unavailable");
      // The token request's redirect_uri is always ours, whatever host the callback arrived on.
      const current = new URL(config.redirectUri);
      current.search = parameters.toString();
      let tokens;
      try {
        tokens = await oidc.authorizationCodeGrant(loginClient(state), current, { pkceCodeVerifier: transaction.verifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true });
        lastContact = now();
      } catch (error) {
        throw new LoginError(idTokenFailure(error) ? "id_token" : "exchange");
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
      const parameters = { post_logout_redirect_uri: config.postLogoutRedirectUri, ...(typeof idToken === "string" && idToken ? { id_token_hint: idToken } : {}) };
      if (discovered?.client.serverMetadata().end_session_endpoint) return oidc.buildEndSessionUrl(discovered.client, parameters).href;
      // Before discovery has succeeded, use Auth's fixed end-session route with the same parameters.
      const url = new URL(issuer.replace(/\/$/, "") + "/logout");
      url.search = new URLSearchParams({ client_id: clientId, ...parameters }).toString();
      return url.href;
    },
    // Trades the signed-in person's ID token for a 5-minute station.read token for one Station (RFC 8693). Not done
    // through openid-client, which has no generic token-exchange grant.
    async exchangeForStation(idToken, origin) {
      const state = await discover();
      const endpoint = state?.client.serverMetadata().token_endpoint;
      if (!endpoint) throw new TokenError(503, "unavailable");
      const form = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: idToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        resource: origin,
        scope: "station.read"
      });
      let response, json;
      try {
        response = await clientRequest(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(formEncode(clientId) + ":" + formEncode(clientSecret)).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
          },
          body: form.toString()
        });
        json = await response.json().catch(() => null);
      } catch {
        throw new TokenError(503, "unavailable");
      }
      lastContact = now();
      if (!response.ok) {
        if (response.status >= 500 || !plainString(json?.error, 100)) throw new TokenError(response.status >= 500 ? 503 : 401, response.status >= 500 ? "unavailable" : "response");
        throw new TokenError(401, json.error);
      }
      if (json?.issued_token_type !== "urn:ietf:params:oauth:token-type:access_token" || !plainString(json.access_token, 8192) || !(Number.isFinite(json.expires_in) && json.expires_in > 0)) throw new TokenError(401, "response");
      return { accessToken: json.access_token, expiresIn: json.expires_in };
    },
    async verifyLogoutToken(token) {
      const payload = await verify(token, { audience: clientId, typ: "logout+jwt", requiredClaims: ["iat", "jti"], maxTokenAge: 300 });
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
