// The Portal's client for Auth's management API (/manage/v1). Errors carry Auth's error code and status only, never
// request bodies or credentials.
export class ManageError extends Error {
  constructor(status, code) {
    super("Auth management request failed: " + code + " (" + status + ")");
    this.name = "ManageError";
    this.status = status;
    this.code = code;
  }
}

// RFC 6749 section 2.3.1: both parts are form-urlencoded before base64.
const formEncode = (value) => encodeURIComponent(value).replace(/%20/g, "+");
const segment = encodeURIComponent;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/;

export function createManageClient({ issuer: issuerSetting, clientId, clientSecret, request = fetch, timeoutMs = 10000 } = {}) {
  const issuer = typeof issuerSetting === "string" ? issuerSetting.replace(/\/$/, "") : issuerSetting;
  let url;
  try { url = new URL(issuer); } catch { throw new TypeError("AUTH_ISSUER must be a URL"); }
  if (!(url.protocol === "https:" || url.protocol === "http:")) throw new TypeError("AUTH_ISSUER must be an http(s) URL");
  if (typeof clientId !== "string" || !clientId) throw new TypeError("PORTAL_CLIENT_ID must be set");
  if (typeof clientSecret !== "string" || clientSecret.length < 32) throw new TypeError("PORTAL_CLIENT_SECRET must be at least 32 characters");
  const base = issuer + "/manage/v1";
  const authorization = "Basic " + Buffer.from(formEncode(clientId) + ":" + formEncode(clientSecret)).toString("base64");

  async function call(method, path, { query, body } = {}) {
    const target = base + path + (query ? "?" + new URLSearchParams(query).toString() : "");
    const headers = { Authorization: authorization, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    let response, text;
    try {
      response = await request(target, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
      text = await response.text();
    } catch {
      throw new ManageError(503, "unavailable");
    }
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (response.status >= 200 && response.status < 300) {
      if (response.status === 204) return undefined;
      if (!json || typeof json !== "object") throw new ManageError(response.status, "bad_response");
      return json;
    }
    // Auth's codes are short snake_case words; anything else is not echoed or logged.
    if (typeof json?.error === "string" && ERROR_CODE.test(json.error)) throw new ManageError(response.status, json.error);
    throw new ManageError(response.status >= 500 ? 503 : response.status, response.status >= 500 ? "unavailable" : "bad_response");
  }
  const list = (json, name) => {
    if (!Array.isArray(json[name])) throw new ManageError(200, "bad_response");
    return json[name];
  };

  return {
    registerStation: ({ origin, owner, reportKey, actor }) => call("POST", "/stations", { body: { origin, owner, reportKey, actor } }),
    async stations(account) { return list(await call("GET", "/stations", { query: { account } }), "stations"); },
    // The active built-in Stations, naming no account (D26): the Portal's startup and hourly sync.
    async builtInStations() { return list(await call("GET", "/built-in-stations"), "stations"); },
    async removeStation(id, actor) { await call("DELETE", "/stations/" + segment(id), { query: { actor } }); },
    members: (id, actor) => call("GET", "/stations/" + segment(id) + "/members", { query: { actor } }),
    async addMember(id, account, actor) { await call("PUT", "/stations/" + segment(id) + "/members/" + segment(account), { query: { actor } }); },
    async removeMember(id, account, actor) { await call("DELETE", "/stations/" + segment(id) + "/members/" + segment(account), { query: { actor } }); },
    createIntegration: ({ owner, stationId, name, scopes, publicJwk, r9Svc, quotaPerSecond, expiresAt, actor }) =>
      call("POST", "/integrations", { body: { owner, stationId, name, scopes, publicJwk, r9Svc, quotaPerSecond, expiresAt, actor } }),
    async integrations(account) { return list(await call("GET", "/integrations", { query: { account } }), "integrations"); },
    addKey: (id, publicJwk, actor) => call("POST", "/integrations/" + segment(id) + "/keys", { body: { publicJwk, actor } }),
    changeIntegration: (id, { status, r9Svc, quotaPerSecond, expiresAt } = {}, actor) =>
      call("PATCH", "/integrations/" + segment(id), { body: { status, r9Svc, quotaPerSecond, expiresAt, actor } })
  };
}
