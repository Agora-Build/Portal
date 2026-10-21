// A stand-in for Agora's OAuth (sso2.agora.io /api/v0/oauth/*) and the Console BFF project list, served through an
// injectable `request`. It speaks the protocol the Portal used before: authorization code with PKCE (S256), scope
// `basic_info,console`, client_secret_post at the token endpoint, refresh-token rotation, and a userinfo endpoint.
import { createHash, randomBytes } from "node:crypto";

export function createFakeAgora({ base = "https://sso.agora.example", bff = "https://bff.agora.example", userinfo = "https://sso.agora.example/api/v0/oauth/userinfo", clientId = "portal-agora", clientSecret = "test-only-agora-client-value", expiresIn = 7200 } = {}) {
  const codes = new Map(), access = new Map(), refresh = new Map();
  const counts = { code: 0, refresh: 0, userinfo: 0, projects: 0 };
  const issued = [];
  const state = { down: false, expiresIn, user: { name: "Agora Builder", sub: "agora-user-1" } };
  const items = [{ projectId: "project-1", name: "Private project", appId: "agora-app-id", signKey: "private-test-certificate", status: "active" }];
  const tokens = (user) => {
    const accessToken = "agora-access-" + randomBytes(16).toString("hex"), refreshToken = "agora-refresh-" + randomBytes(16).toString("hex");
    access.set(accessToken, user); refresh.set(refreshToken, user); issued.push(accessToken, refreshToken);
    return Response.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: state.expiresIn, token_type: "bearer" });
  };
  const bearer = (options) => access.get(String(options?.headers?.Authorization || "").replace(/^Bearer /, ""));
  async function request(input, options = {}) {
    const url = new URL(String(input));
    if (state.down) throw new TypeError("fetch failed");
    if (url.href === base + "/api/v0/oauth/token" && options.method === "POST") {
      const body = new URLSearchParams(options.body);
      if (body.get("client_id") !== clientId || body.get("client_secret") !== clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (body.get("grant_type") === "authorization_code") {
        counts.code++;
        const entry = codes.get(body.get("code"));
        codes.delete(body.get("code"));
        const challenge = createHash("sha256").update(body.get("code_verifier") || "").digest("base64url");
        if (!entry || entry.redirectUri !== body.get("redirect_uri") || entry.challenge !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return tokens(entry.user);
      }
      if (body.get("grant_type") === "refresh_token") {
        counts.refresh++;
        const user = refresh.get(body.get("refresh_token"));
        refresh.delete(body.get("refresh_token"));
        if (!user) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return tokens(user);
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (url.href === userinfo) {
      counts.userinfo++;
      const user = bearer(options);
      return user ? Response.json(user) : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (url.href === bff + "/api/cli/v1/projects") {
      counts.projects++;
      return bearer(options) ? Response.json({ items }) : Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return new Response("not found", { status: 404 });
  }
  return {
    request, counts, issued, state, items, clientId, clientSecret, base, bff, userinfo,
    env: (extra = {}) => ({ AGORA_CONSOLE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), AGORA_BFF_URL: bff, AGORA_OAUTH_BASE_URL: base, AGORA_OAUTH_CLIENT_ID: clientId, AGORA_OAUTH_CLIENT_SECRET: clientSecret, AGORA_OAUTH_USERINFO_URL: userinfo, ...extra }),
    // Plays Agora's consent page: checks the request and returns the callback URL with a single-use code (or an error).
    authorize(authorizationUrl, { error } = {}) {
      const url = new URL(authorizationUrl);
      const query = url.searchParams;
      if (url.origin + url.pathname !== base + "/api/v0/oauth/authorize") throw new Error("not Agora's authorize endpoint");
      if (query.get("response_type") !== "code" || query.get("client_id") !== clientId || query.get("scope") !== "basic_info,console" || query.get("code_challenge_method") !== "S256" || !query.get("code_challenge")) throw new Error("invalid authorize request");
      const back = new URL(query.get("redirect_uri"));
      back.searchParams.set("state", query.get("state"));
      if (error) back.searchParams.set("error", error);
      else {
        const code = "agora-code-" + randomBytes(12).toString("hex");
        codes.set(code, { redirectUri: query.get("redirect_uri"), challenge: query.get("code_challenge"), user: { ...state.user } });
        back.searchParams.set("code", code);
      }
      return back.href;
    }
  };
}
