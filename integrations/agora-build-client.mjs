import { createHash, randomBytes } from "node:crypto";

// Server-side client. Keep the transaction and returned tokens in private app storage.
export function createAgoraBuildClient({ origin, clientId, clientSecret, redirectUri, request = fetch }) {
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Use HTTPS for Agora.Build.");
  const base = url.origin;
  async function send(path, options = {}) {
    const response = await request(base + path, { ...options, signal: AbortSignal.timeout(10000), redirect: "error" });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Agora.Build request failed");
    return data;
  }
  const tokenRequest = (body) => send("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), ...body }) });
  return {
    begin(scopes = ["identity", "credits", "services"]) {
      const state = randomBytes(24).toString("base64url"), verifier = randomBytes(32).toString("base64url");
      const parameters = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, response_type: "code", scope: scopes.join(" "), code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
      return { url: base + "/oauth/authorize?" + parameters, transaction: { state, verifier, expiresAt: Date.now() + 600000 } };
    },
    complete(callbackUrl, transaction) {
      const callback = new URL(callbackUrl), expected = new URL(redirectUri);
      if (!transaction || transaction.expiresAt < Date.now() || callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== transaction.state || callback.searchParams.has("error") || callback.searchParams.getAll("code").length !== 1) throw new Error("Invalid or expired login callback");
      return tokenRequest({ grant_type: "authorization_code", code: callback.searchParams.get("code"), code_verifier: transaction.verifier, redirect_uri: redirectUri });
    },
    refresh(refreshToken) { return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }); },
    user(accessToken) { return send("/oauth/userinfo", { headers: { Authorization: "Bearer " + accessToken } }); },
    balance(accessToken) { return send("/api/credits/balance", { headers: { Authorization: "Bearer " + accessToken } }); },
    reserve(accessToken, service, key) { return send("/api/platform/credits/reserve", { method: "POST", headers: { Authorization: "Bearer " + clientSecret, "X-Agora-Client-Id": clientId, "X-Agora-User-Token": accessToken, "Content-Type": "application/json" }, body: JSON.stringify({ service, idempotencyKey: key }) }); },
    settle(accessToken, service, reservationId, outcome) { return send("/api/platform/credits/settle", { method: "POST", headers: { Authorization: "Bearer " + clientSecret, "X-Agora-Client-Id": clientId, "X-Agora-User-Token": accessToken, "Content-Type": "application/json" }, body: JSON.stringify({ service, reservationId, outcome }) }); },
    revoke(token) { return send("/oauth/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), token }) }); }
  };
}
