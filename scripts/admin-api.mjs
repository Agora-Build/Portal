// The Portal admin API (D27, docs/integrations.md §3.3.5): /api/admin/v1, for the admin site. It takes nothing but a
// 60-second portal.admin token Auth's admin client exchanges from an admin's passkey step-up, never a cookie, and an admin
// token works on no other route (serve.mjs). It exists only with the Portal database (the Stations and integrations stack)
// and PORTAL_ADMIN_CLIENT_ID; otherwise every path here is today's 404. The actor of every change is the token's sub.
import { AppError } from "./store.mjs";
import { STATION_CLIENT_ID, TokenError } from "./idp.mjs";

export const ADMIN_API = "/api/admin/v1";
export const ADMIN_SCOPE = "portal.admin";
const MFA = "urn:agora:mfa";
// How old the passkey sign-in a token rests on may be (auth_time, whole seconds): 15 minutes for a read, 5 for a change.
const READ_AUTH_SECONDS = 900;
const CHANGE_AUTH_SECONDS = 300;
// An auth_time up to this far ahead of the Portal's clock is clock skew; further is not a sign-in that happened.
const AUTH_TIME_SKEW = 30;
const READS_PER_MINUTE = 120;
const CHANGES_PER_MINUTE = 30;
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const TODAY_NOT_FOUND = "This page or service was not found.";

// Every refusal here carries its code, and some a header, which serve.mjs answers as { error, code }.
const failure = (status, message, code, headers) => Object.assign(new AppError(status, message, { code }), headers ? { headers } : {});
const tokenInvalid = () => failure(401, "A valid Agora.Build admin token is required.", "token", { "WWW-Authenticate": 'Bearer error="invalid_token"' });
const scopeInsufficient = () => failure(403, "This token is not an Agora.Build admin token.", "insufficient_scope",
  { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="' + ADMIN_SCOPE + '"' });
const notAdmin = () => failure(403, "This account is not an Agora.Build admin.", "not_admin");
// RFC 9470's step-up challenge: the admin site answers it with a fresh passkey sign-in, as for Auth's own step-up.
const mfaRequired = (maxAge) => failure(401, "Sign in again with your passkey to continue.", "mfa_required", {
  "WWW-Authenticate": 'Bearer error="insufficient_user_authentication", error_description="A more recent passkey sign-in is required", max_age=' + maxAge
});
const rateLimited = () => failure(429, "Too many admin requests. Try again in a minute.", "rate_limited", { "Retry-After": "60" });
const unavailable = () => failure(503, "The admin API is unavailable right now. Try again shortly.", "unavailable");
const routeNotFound = () => failure(404, "This admin route was not found.", "not_found");

// Why a failure is logged: its code when it has a plain one, never a message (those can name a host or carry a value).
const reasonOf = (error) => (typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(error.code) ? error.code : "error");

export const adminApiPath = (path) => path === ADMIN_API || path.startsWith(ADMIN_API + "/");

// PORTAL_ADMIN_CLIENT_ID: the ID of Auth's admin client, or null (unset or empty: the admin API is off). A value that can't
// be the admin client's ID turns it off too, logged by the setting's name and the reason only, never the value: one that
// isn't a client ID at all, this Portal's own client ID (every ordinary app token would then count as an admin token and
// be refused) or a Station report client's (the same for that Station's report tokens).
export function adminClientIdFrom(value, log = () => {}, portalClientId = null) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return null;
  const reason = !CLIENT_ID.test(id) ? "is not a client ID"
    : id === portalClientId ? "is this Portal's own client ID"
    : STATION_CLIENT_ID.test(id) ? "is a Station report client ID" : null;
  if (reason) {
    log("The admin API is off: PORTAL_ADMIN_CLIENT_ID " + reason + ".");
    return null;
  }
  return id;
}

// An admin token anywhere but the admin API: one with the portal.admin scope, or (with the setting) any of the admin client.
export const isAdminToken = (caller, adminClientId) => caller.scopes.includes(ADMIN_SCOPE) || (adminClientId !== null && caller.clientId === adminClientId);
export const adminTokenOnly = () => new AppError(403, "An Agora.Build admin token works only on the admin API, " + ADMIN_API + ".");

// The admin API's routes. Slice 1's (releasing R9 bindings) come with the release; until then there is none, so a request
// that passes the gate is 404 not_found. null: no route here.
async function route() {
  return null;
}

// One request to the admin API: the gate, then its route. A GET is a read; any other method is a change. The checks, in
// order: a bearer token (401 token; a cookie is never read), the usual token checks (401 token), the admin client,
// portal.admin and the MFA level (403 insufficient_scope), a whole-number auth_time not ahead (401 token), sub one of
// the admins (403 not_admin), auth_time recent enough for a read or a change (401 mfa_required), and the admin's limits
// (429 rate_limited), which count only requests that passed every token check. Returns { status, body }. `limit` is
// serve.mjs's limiter and `now` its clock. The service is ready once and cached, so a database that goes down later
// surfaces as a raw error from its first query: that is 503 unavailable too, not a 500, logged by its code only. Any
// route that queries the database (Task 4's) answers the same way.
export async function handleAdmin({ method, path, url, authorization, read, idp, integrations, adminClientId, delegatedHostWork = false, limit, now = Date.now, log = () => {} }) {
  if (!adminClientId || !integrations) throw new AppError(404, TODAY_NOT_FOUND);
  const change = method !== "GET";
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!bearer) throw tokenInvalid();
  if (!idp) throw unavailable();
  let caller;
  try {
    caller = await idp.verifyAdminToken(bearer);
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    throw error.status === 503 ? unavailable() : tokenInvalid();
  }
  if (caller.clientId !== adminClientId || !caller.scopes.includes(ADMIN_SCOPE) || caller.acr !== MFA) throw scopeInsufficient();
  const seconds = Math.floor(now() / 1000);
  if (caller.authTime === null || caller.authTime < 0 || caller.authTime > seconds + AUTH_TIME_SKEW) throw tokenInvalid();
  let service;
  try {
    service = await integrations.ready();
  } catch (error) {
    if (error?.status === 503) throw unavailable();
    throw error;
  }
  let admin;
  try {
    admin = await service.isPortalAdmin(caller.sub);
  } catch (error) {
    if (error instanceof AppError) throw error;
    log("The admin API could not check the admins: " + reasonOf(error) + ".");
    throw unavailable();
  }
  if (!admin) throw notAdmin();
  const window = change ? CHANGE_AUTH_SECONDS : READ_AUTH_SECONDS;
  if (seconds - caller.authTime > window) throw mfaRequired(window);
  try {
    limit((change ? "admin-change:" : "admin-read:") + caller.sub, change ? CHANGES_PER_MINUTE : READS_PER_MINUTE, 60000);
  } catch (error) {
    if (error?.status === 429) throw rateLimited();
    throw error;
  }
  const handled = await route({ method, path, url, read, service, actor: caller.sub, delegatedHostWork });
  if (!handled) throw routeNotFound();
  return handled;
}
