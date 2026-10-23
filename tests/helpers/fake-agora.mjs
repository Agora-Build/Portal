// A stand-in for Agora SSO (sso2.agora.io) and the Agora CLI BFF (agora-cli.agora.io), served through an injectable
// `request`. SSO: GET /api/v0/oauth/authorize (played by `authorize`), POST /api/v0/oauth/token (authorization_code and
// refresh_token, client_secret_post, PKCE refused), and the bearer APIs /api/v0/customer/user-auth (GET, DELETE),
// /api/v0/customer/company/basic-info and /api/v0/account/companies. Like the real sso2, its project paths refuse these
// tokens. BFF: GET /api/cli/v1/projects answers { items } (the shape can be swapped) with certificates as signKey.
import { randomBytes } from "node:crypto";

const projects = [{ projectId: "vendor-1", name: "Private project", appId: "agora-app-id", signKey: "private-test-certificate", status: "1", createdAt: "2023-11-14T22:13:20.000Z", vid: 1001 }];
export const listShapes = {
  dataList: (items) => ({ code: 0, data: { list: items } }),
  topLevel: (items) => items,
  items: (items) => ({ items }),
  dataArray: (items) => ({ data: items })
};

export function createFakeAgora({ base = "https://sso.agora.example", bff = "https://bff.agora.example", clientId = "portal-agora", clientSecret = "test-only-agora-client-value", expiresIn = 7200, scope = "basic_info,console" } = {}) {
  const codes = new Map(), access = new Map(), refresh = new Map();
  const counts = { code: 0, refresh: 0, bffProjects: 0, revoke: 0, companyInfo: 0, userAuth: 0 };
  const issued = [], calls = [];
  const state = {
    down: false, expiresIn, refuseRefresh: false, listShape: listShapes.items,
    user: { name: "agora-user-1" }, company: { companyName: "Agora Builder" }, items: structuredClone(projects)
  };
  const tokens = (user) => {
    const accessToken = "agora-access-" + randomBytes(16).toString("hex"), refreshToken = "agora-refresh-" + randomBytes(16).toString("hex");
    access.set(accessToken, user); refresh.set(refreshToken, user); issued.push(accessToken, refreshToken);
    return Response.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: state.expiresIn, token_type: "bearer" });
  };
  const bearer = (options) => access.get(String(options?.headers?.Authorization || "").replace(/^Bearer /, ""));
  const unauthorized = () => Response.json({ code: 401, msg: "unauthorized" }, { status: 401 });
  async function request(input, options = {}) {
    const url = new URL(String(input)), method = options.method || "GET";
    if (state.down) throw new TypeError("fetch failed");
    if (url.origin === bff) {
      calls.push("BFF " + method + " " + url.pathname);
      if (url.pathname !== "/api/cli/v1/projects" || method !== "GET") return new Response("not found", { status: 404 });
      counts.bffProjects++;
      const header = String(options?.headers?.Authorization || "");
      if (!header.startsWith("Bearer ")) return Response.json({ code: "UNAUTHORIZED", message: "Missing bearer token" }, { status: 401 });
      return bearer(options) ? Response.json(state.listShape(state.items)) : Response.json({ code: "UNAUTHORIZED", message: "Invalid access token" }, { status: 401 });
    }
    if (url.origin !== base) return new Response("not found", { status: 404 });
    calls.push(method + " " + url.pathname);
    if (url.pathname === "/api/v0/oauth/token" && method === "POST") {
      const body = new URLSearchParams(options.body);
      if (body.get("client_id") !== clientId || body.get("client_secret") !== clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (body.get("grant_type") === "authorization_code") {
        counts.code++;
        const entry = codes.get(body.get("code"));
        codes.delete(body.get("code"));
        // Like the real Agora SSO: a confidential client must not use PKCE.
        if (body.has("code_verifier")) return Response.json({ error: "invalid_request", error_description: "PKCE is not supported for confidential client" }, { status: 400 });
        if (!entry || entry.redirectUri !== body.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return tokens(entry.user);
      }
      if (body.get("grant_type") === "refresh_token") {
        counts.refresh++;
        const user = refresh.get(body.get("refresh_token"));
        refresh.delete(body.get("refresh_token"));
        if (!user || state.refuseRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return tokens(user);
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    // The real sso2 answers its project paths with its login-page 401 for these tokens.
    if (/^\/api\/v0\/(customer\/)?project(\/|$)/.test(url.pathname)) return Response.json({ statusCode: 401, redirectToLoginPage: true, phrase: "[Error] Unauthorized" }, { status: 401 });
    if (url.pathname === "/api/v0/customer/user-auth") {
      const user = bearer(options);
      if (method === "DELETE") {
        counts.revoke++;
        if (!user) return unauthorized();
        const token = String(options.headers.Authorization).replace(/^Bearer /, "");
        for (const map of [access, refresh]) for (const [key, value] of map) if (value === user) map.delete(key);
        access.delete(token);
        return Response.json({ code: 0 });
      }
      counts.userAuth++;
      return user ? Response.json({ code: 0, data: { ...state.user } }) : unauthorized();
    }
    if (url.pathname === "/api/v0/customer/company/basic-info" && method === "GET") {
      counts.companyInfo++;
      return bearer(options) ? Response.json({ code: 0, data: { ...state.company } }) : unauthorized();
    }
    if (url.pathname === "/api/v0/account/companies" && method === "GET") return bearer(options) ? Response.json({ code: 0, data: [{ id: 42, companyName: state.company.companyName }] }) : unauthorized();
    return new Response("not found", { status: 404 });
  }
  return {
    request, counts, calls, issued, state, clientId, clientSecret, base, bff,
    // Makes every issued access token invalid, as if it had expired at Agora before its stated lifetime.
    expireAccessTokens() { access.clear(); },
    env: (extra = {}) => ({ AGORA_CONSOLE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), AGORA_SSO_BASE_URL: base, AGORA_BFF_URL: bff, AGORA_SSO_CLIENT_ID: clientId, AGORA_SSO_CLIENT_SECRET: clientSecret, ...extra }),
    // Plays Agora's consent page: checks the request and returns the callback URL with a single-use code (or an error).
    authorize(authorizationUrl, { error } = {}) {
      const url = new URL(authorizationUrl);
      const query = url.searchParams;
      if (url.origin + url.pathname !== base + "/api/v0/oauth/authorize") throw new Error("not Agora's authorize endpoint");
      if (query.get("response_type") !== "code" || query.get("client_id") !== clientId || query.get("scope") !== scope || !query.get("state") || query.has("toPage")) throw new Error("invalid authorize request");
      // The real Agora SSO answers "Invalid request: PKCE is not supported for confidential client".
      if (query.has("code_challenge") || query.has("code_challenge_method")) throw new Error("Invalid request: PKCE is not supported for confidential client");
      const back = new URL(query.get("redirect_uri"));
      back.searchParams.set("state", query.get("state"));
      if (error) back.searchParams.set("error", error);
      else {
        const code = "agora-code-" + randomBytes(12).toString("hex");
        codes.set(code, { redirectUri: query.get("redirect_uri"), user: { ...state.user } });
        back.searchParams.set("code", code);
      }
      return back.href;
    }
  };
}
