// A stand-in for auth.agora.build: discovery, JWKS and the token endpoint, served through an injectable `request`.
// Token formats follow Agora-Build/Auth docs/integrating.md: ES256 keys, ID tokens with nonce and sid,
// RFC 9068 access tokens (`typ: at+jwt`, `client_id`, `scope`), and back-channel logout tokens (`typ: logout+jwt`).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
export const API_AUDIENCE = "https://api.agora.build";
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const accountId = () => "ab" + Array.from(randomBytes(26), (byte) => crockford[byte % 32]).join("");

async function newKey() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const kid = "key-" + randomBytes(6).toString("hex");
  return { kid, ...pair, jwk: { ...await exportJWK(pair.publicKey), kid, use: "sig", alg: "ES256" } };
}

export async function createFakeIdp({ issuer = "https://auth.example", clientId = "portal", clientSecret } = {}) {
  const base = issuer.replace(/\/$/, "");
  const metadata = {
    issuer,
    authorization_endpoint: base + "/authorize",
    token_endpoint: base + "/token",
    userinfo_endpoint: base + "/userinfo",
    jwks_uri: base + "/jwks",
    end_session_endpoint: base + "/logout",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["ES256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    authorization_response_iss_parameter_supported: true,
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
    scopes_supported: ["openid", "profile", "email", "offline_access"]
  };
  const keys = [await newKey()];
  const codes = new Map();
  const counts = { attempts: 0, discovery: 0, jwks: 0, token: 0 };
  let down = false;
  let customToken = null;

  const active = () => keys[keys.length - 1];
  async function sign(header, payload, opts = {}) {
    const key = opts.key || active();
    const alg = opts.alg || "ES256";
    if (alg === "none") {
      const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return part({ ...header, alg: "none" }) + "." + part(payload) + ".";
    }
    const signingKey = alg === "HS256" ? (opts.secret || new TextEncoder().encode("s".repeat(32))) : key.privateKey;
    const protectedHeader = { alg, ...(alg === "HS256" ? {} : { kid: opts.kid ?? key.kid }), ...header, ...(opts.header || {}) };
    for (const name of Object.keys(protectedHeader)) if (protectedHeader[name] === undefined) delete protectedHeader[name];
    return new SignJWT(payload).setProtectedHeader(protectedHeader).sign(signingKey);
  }
  const seconds = () => Math.floor(Date.now() / 1000);
  const shape = (defaults, claims, opts) => {
    const payload = { ...defaults, ...claims };
    for (const name of opts.omit || []) delete payload[name];
    for (const name of Object.keys(payload)) if (payload[name] === undefined) delete payload[name];
    return payload;
  };

  // opts: { alg, kid, key, header, omit: [claim names], typ }
  const fake = {
    issuer,
    clientId,
    metadata,
    counts,
    get keys() { return keys; },
    accountId,
    issueIdToken(claims = {}, opts = {}) {
      const now = seconds();
      return sign({ typ: opts.typ }, shape({ iss: issuer, sub: accountId(), aud: clientId, iat: now, exp: now + 3600, auth_time: now }, claims, opts), opts);
    },
    issueAccessToken(claims = {}, opts = {}) {
      const now = seconds();
      return sign({ typ: "typ" in opts ? opts.typ : "at+jwt" }, shape({ iss: issuer, sub: accountId(), aud: API_AUDIENCE, client_id: clientId, scope: "credits", iat: now, exp: now + 900, jti: randomUUID() }, claims, opts), opts);
    },
    issueLogoutToken(claims = {}, opts = {}) {
      const now = seconds();
      return sign({ typ: "typ" in opts ? opts.typ : "logout+jwt" }, shape({ iss: issuer, sub: accountId(), aud: clientId, iat: now, exp: now + 120, jti: randomUUID(), sid: randomUUID(), events: { [LOGOUT_EVENT]: {} } }, claims, opts), opts);
    },
    // Adds a new active signing key. `{ drop: true }` removes the old keys from JWKS (an emergency rotation).
    async rotate({ drop = false } = {}) {
      const key = await newKey();
      if (drop) keys.splice(0, keys.length);
      keys.push(key);
      return key;
    },
    setDown(value) { down = Boolean(value); },
    // `fn({ body, grant })` returns a Response or a JSON object for the token endpoint; null restores the default.
    tokenResponse(fn) { customToken = fn || null; },
    // Plays the IdP's /authorize: records the request and returns the callback URL with a single-use code.
    authorize(authorizationUrl, claims = {}) {
      const url = new URL(authorizationUrl);
      const code = randomBytes(16).toString("base64url");
      codes.set(code, {
        clientId: url.searchParams.get("client_id"),
        redirectUri: url.searchParams.get("redirect_uri"),
        nonce: url.searchParams.get("nonce"),
        challenge: url.searchParams.get("code_challenge"),
        method: url.searchParams.get("code_challenge_method"),
        scope: url.searchParams.get("scope"),
        claims
      });
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.search = new URLSearchParams({ code, state: url.searchParams.get("state"), iss: issuer }).toString();
      return callback.href;
    },
    async request(value, options = {}) {
      counts.attempts += 1;
      if (down) throw new TypeError("fetch failed");
      const url = new URL(value);
      if (url.origin !== new URL(issuer).origin) throw new TypeError("fetch failed: unexpected host " + url.origin);
      if (url.pathname === new URL(issuer).pathname.replace(/\/$/, "") + "/.well-known/openid-configuration") {
        counts.discovery += 1;
        return Response.json(metadata);
      }
      if (url.href === metadata.jwks_uri) {
        counts.jwks += 1;
        return Response.json({ keys: keys.map((key) => key.jwk) }, { headers: { "Content-Type": "application/jwk-set+json" } });
      }
      if (url.href === metadata.token_endpoint && (options.method || "GET").toUpperCase() === "POST") {
        counts.token += 1;
        const body = new URLSearchParams(typeof options.body === "string" ? options.body : options.body?.toString() || "");
        const fail = (error, status = 400) => Response.json({ error }, { status });
        const authorization = new Headers(options.headers).get("authorization") || "";
        const [id, secret] = authorization.startsWith("Basic ") ? Buffer.from(authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent) : [body.get("client_id"), body.get("client_secret")];
        if (id !== clientId || (clientSecret !== undefined && secret !== clientSecret)) return fail("invalid_client", 401);
        if (body.get("grant_type") !== "authorization_code") return fail("unsupported_grant_type");
        const grant = codes.get(body.get("code"));
        codes.delete(body.get("code"));
        if (customToken) {
          const reply = await customToken({ body, grant });
          if (reply instanceof Response) return reply;
          return Response.json(reply);
        }
        if (!grant || grant.clientId !== id || grant.redirectUri !== body.get("redirect_uri")) return fail("invalid_grant");
        const verifier = body.get("code_verifier") || "";
        if (grant.method !== "S256" || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return fail("invalid_grant");
        const idToken = await fake.issueIdToken({ nonce: grant.nonce ?? undefined, sid: randomUUID(), name: "Test builder", picture: "https://avatars.example/builder.png", ...grant.claims });
        return Response.json({ access_token: randomBytes(24).toString("base64url"), token_type: "Bearer", expires_in: 3600, scope: grant.scope, id_token: idToken });
      }
      return new Response("Not found", { status: 404 });
    }
  };
  return fake;
}
