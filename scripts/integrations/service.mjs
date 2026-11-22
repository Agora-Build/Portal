// Business flows for Stations and integrations. Auth is called first and Portal writes its rows only after Auth answers
// success; every Auth change names the signed-in account as `actor`. Rows are never deleted (D19).
import { randomBytes, randomUUID } from "node:crypto";
import { TokenError } from "../idp.mjs";
import { builtInIntegrationLimit } from "../plans.mjs";
import { ACCOUNT_ID, AppError } from "../store.mjs";
import { ManageError } from "./auth-manage.mjs";
import { checkProof, createStationFetch, ProofError, stationOrigin, WELL_KNOWN_PATH } from "./proof.mjs";
import { AUTH_CURSOR } from "./repository.mjs";
import { effectiveState, REPORT_STATES, transition } from "./states.mjs";

const CHALLENGE_LIFETIME = 600000;
const CHALLENGES_PER_HOUR = 10;
const REPORT_KEY_MAX = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const SCOPES = ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message", "agent.notify"];
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];
const R9_SVC = /^[0-9a-f]{64}$/;
// Control characters, and the bidirectional marks and overrides that could make a name read differently.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const STOPPED = ["revoking", "revoked"];
const REPORT_FIELDS = ["integrationId", "state", "reason"];
// With the setting on (D29 Phase B) a Station also sends two revocation reports, each with a reportId and its own fields:
// one per host that applied the revocation, and the final one, with how it ended.
const APPLIED_FIELDS = ["host", "recordId"];
const FINAL_FIELDS = ["outcome", "pendingHosts"];
const DELEGATED_REPORT_FIELDS = [...REPORT_FIELDS, "reportId", ...APPLIED_FIELDS, ...FINAL_FIELDS];
const OUTCOMES = ["all_applied", "deadline_passed"];
const PENDING_HOSTS_MAX = 100;
// The grammar of a reportId and of a host id (the one of Atem's device list), and a record's id: a lowercase UUID v4.
const ID_GRAMMAR = /^[A-Za-z0-9._:-]{1,128}$/;
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINTABLE_REASON = /^[^\p{Cc}]{1,200}$/u;
// The built-in Station's two binding reports (D29, the setting on). Each has its own fields, and neither names an integration.
const BINDING_REPORT_FIELDS = {
  binding_changed: ["state", "reportId", "account", "accountId", "genesisHash", "bindingId", "version", "bindingState"],
  binding_attempt: ["state", "reportId", "account", "accountId", "genesisHash", "reason", "attemptedAt"]
};
const GENESIS_HASH = /^[0-9a-f]{64}$/;
const BINDING_STATES = ["bound", "unbound", "released"];
const ATTEMPT_REASONS = ["bound_elsewhere", "owner_disabled"];
// A refused binding attempt is shown on the page of the account it protects for 30 days, the 50 newest at most. A report
// may be dated a little ahead of the Portal's clock (the Station's own runs ahead), an hour at most: a far-future time
// would otherwise keep its notice first on the page for good.
const ATTEMPTS_SHOWN_FOR = 30 * DAY;
const NOTICES_SHOWN = 50;
const ATTEMPT_CLOCK_SKEW = 3600000;
const CURSOR = /^\d{1,15}$/;
const FEED_LIMIT = 500;
// The Station directory (D29, GET /api/v1/stations): pages of at most 100 Stations, and a Station lost within 30 days (the
// Station records' own retention) is still listed, with the loss stated.
const DIRECTORY_PAGE = 100;
const DIRECTORY_LOST_FOR = 30 * DAY;
const LIMIT_DIGITS = /^[0-9]{1,3}$/;
const CURSOR_CHARACTERS = /^[A-Za-z0-9_-]{1,512}$/;
const CURSOR_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const CHANGES_PATH = "/agora-build/v1/changes";

const failure = (status, message, code, extra = {}) => new AppError(status, message, { code, ...extra });
const notFound = () => failure(404, "This Station or integration was not found.", "not_found");
const ownerOnly = () => failure(403, "Only the Station owner can do this.", "forbidden");
const unknownStation = () => failure(403, "This Station is not registered.", "station");
const expiredChallenge = () => failure(400, "This check has expired or was already used. Start again.", "challenge");
// D29: with the setting on, a revocation says whether to interrupt the tasks running on the owner's hosts.
const interruptRunningRequired = () => failure(400, "Say whether to interrupt running tasks: send interruptRunning as true or false.", "interrupt_running");
const REPORT_FORM = "Send a report as { integrationId, state, reason }.";
const DELEGATED_REPORT_FORMS = REPORT_FORM.slice(0, -1) + ', { integrationId, state: "revocation_applied", reportId, host, recordId } or { integrationId, state: "revoked", reportId, outcome, pendingHosts }.';
const IDENTIFIER = "1 to 128 characters of letters, digits, '.', '_', ':' or '-'.";
const reportIdInvalid = () => failure(400, "Send the reportId as " + IDENTIFIER, "report_id");
const BINDING_REPORT_FORMS = 'Send a binding report as { state: "binding_changed", reportId, account, accountId, genesisHash, bindingId, version, bindingState } or { state: "binding_attempt", reportId, account, accountId, genesisHash, reason, attemptedAt }.';
const bindingAccountInvalid = () => failure(400, "Name the account as ab and 26 letters or digits.", "account");
const bindingAccountIdInvalid = () => failure(400, "Send the accountId as " + IDENTIFIER, "account_id");
const genesisHashInvalid = () => failure(400, "Send the genesisHash as 64 lowercase hex characters.", "genesis_hash");
const bindingIdInvalid = () => failure(400, "Send the bindingId as " + IDENTIFIER, "binding_id");
const bindingVersionInvalid = () => failure(400, "Send the version as a positive whole number.", "version");
const bindingStateInvalid = () => failure(400, "Send the bindingState as bound, unbound or released.", "binding_state");
const attemptReasonInvalid = () => failure(400, "Send the reason as bound_elsewhere or owner_disabled.", "reason");
const attemptedAtInvalid = () => failure(400, "Send attemptedAt as an ISO time.", "attempted_at");
const builtInOnly = () => failure(403, "Only the built-in Station reports bindings.", "forbidden");
const bindingNotNewer = () => failure(409, "This binding's version is not newer than the one recorded.", "binding_version");
const hostInvalid = () => failure(400, "Name the host by its id: " + IDENTIFIER, "host");
const recordIdInvalid = () => failure(400, "Send the recordId as the record's lowercase UUID.", "record_id");
const outcomeInvalid = () => failure(400, "Send all_applied with no pendingHosts, or deadline_passed with the hosts that didn't confirm.", "outcome");
const limitInvalid = () => failure(400, "Choose a limit of 1 to 100.", "limit");
const cursorInvalid = () => failure(400, "Send the cursor this list gave you.", "cursor");
const reportIdReused = () => failure(409, "This reportId was already used for another report.", "report_id_reused");
const notRevokedYet = () => failure(409, "This integration isn't revoked.", "invalid_state");
const finalReported = () => failure(409, "This integration's revocation already has its final report.", "invalid_state");
const SYSTEM = "system";
const BUILT_IN_FIXED = "The built-in Station is always there: it can't be removed, shared or left.";
const BUILT_IN_ORIGIN = "This is the built-in Station. Every account already has it.";
const NOT_SUPPORTED = "Integrations aren't available on the built-in Station yet.";
// Who paused a paused integration, as Auth records it (Auth D26 R27): its owner, its custom Station's owner, or an
// Agora.Build admin, whose pause only an admin lifts, on the admin site.
const PAUSED_BY = ["owner", "station", "admin"];
const ADMIN_PAUSED = "Agora.Build paused this integration. Only Agora.Build can resume it.";
const OWNER_DISABLED = "Agora.Build disabled this integration's owner account. It resumes when the account is enabled again.";
const adminPaused = () => failure(409, ADMIN_PAUSED, "admin_paused");
const ownerDisabled = () => failure(409, OWNER_DISABLED, "owner_disabled");
// Auth's change feed (Auth D26 R25): the kinds of entry and those about an owner's account (its cursor's shape is
// AUTH_CURSOR, shared with the repository).
const AUTH_KINDS = ["paused", "resumed", "revoked", "owner_disabled", "owner_enabled"];
const OWNER_KINDS = ["owner_disabled", "owner_enabled"];
// With the setting on (D29) Auth's feed also has an admin's later interrupt of a revoked integration's running tasks, an
// admin's disabling or enabling of an account, and Auth's accounts baseline (written once Auth has corrected every
// account that differed from its latest entry): the account-level entries name no integration (clientId null) and are
// for the built-in Stations only. A baseline names no account either (owner null).
const ACCOUNT_KINDS = ["account_disabled", "account_enabled"];
const BASELINE_KIND = "accounts_baseline";
const ACCOUNT_LEVEL_KINDS = [...ACCOUNT_KINDS, BASELINE_KIND];
const DELEGATED_AUTH_KINDS = [...AUTH_KINDS, "interrupt_requested", ...ACCOUNT_LEVEL_KINDS];
// A built-in Station's change saying the Portal's view of the accounts is no longer complete (D29): until the next
// accounts_baseline change, an account missing from its disabled list is unknown. The Portal writes it; Auth never does.
const INCOMPLETE_KIND = "accounts_incomplete";
const STATION_ACCOUNT_KINDS = [...ACCOUNT_LEVEL_KINDS, INCOMPLETE_KIND];
const AUTH_REASON_MAX = 500;
// Logged while the Portal waits (D29): it skipped an account-level entry, and follows no more until the feed is read again
// from its first entry. Once by each read pass that skips one, and otherwise at the end of a read at most once an hour.
const WAITING_LINE = "Account availability waits for Auth's change feed to be read again from the start: reset the Portal's Auth cursor (docs/platform.md, \"Resetting The Portal's Auth Cursor\").";
const WAITING_AGAIN_MS = 3600000;
// "1 account", "2 accounts": the count in a counts-only line.
const accountsCount = (count) => count + (count === 1 ? " account" : " accounts");
const WAITING = Symbol("waiting");
// How the Station's feed and an integration's history name a change an Agora.Build admin made (spec §3.3.4): the admin
// and the reason they gave stay in the Portal's event (actor, reason) and in Auth's audit.
const AGORA_BUILD = "agora_build";
// Agora.Build disabling or enabling an integration's owner account is between Agora.Build and the owner (least
// disclosure): the Station's feed and the custom Station owner's history show it as Agora.Build's pause and lift, each
// with the state it recorded. integration_events and the owner's own history keep these kinds.
const OWNER_EVENTS = { integration_owner_disabled: "integration_paused", integration_owner_enabled: "integration_resumed" };

const MANAGE_CONFLICTS = {
  origin_taken: "This Station is already registered.",
  revoked: "This integration has been revoked.",
  duplicate_key: "This key is already registered.",
  built_in: BUILT_IN_FIXED,
  not_supported: NOT_SUPPORTED,
  admin_paused: ADMIN_PAUSED,
  owner_disabled: OWNER_DISABLED
};

// Turns Auth's management answer into the Portal's error; anything that is not a ManageError is rethrown unchanged.
export function fromManage(error) {
  if (!(error instanceof ManageError)) throw error;
  if (error.status === 400) return failure(400, "Auth refused this request.", error.code);
  if (error.status === 403) return ownerOnly();
  if (error.status === 404) return failure(404, "This Station or integration was not found.", "not_found");
  if (error.status === 409) return failure(409, MANAGE_CONFLICTS[error.code] || "Auth refused this request.", error.code);
  return failure(503, "Auth is unavailable. Try again shortly.", "unavailable");
}

async function viaAuth(call) {
  try {
    return await call();
  } catch (error) {
    throw fromManage(error);
  }
}

// Members are not shown the Station's report client; it is not secret, but they have no use for it. Nobody is shown a
// built-in Station's report client (its role is built_in).
function stationView(station, role) {
  const view = {
    id: station.id, origin: station.origin, role, ownerAccount: station.ownerAccount, status: station.status, createdAt: station.createdAt,
    builtIn: station.builtIn, name: station.name, integrationsEnabled: station.integrationsEnabled
  };
  if (role === "owner") view.reportClientId = station.reportClientId;
  return view;
}

// The directory's limit: a whole number from 1 to 100, as a number or the digits of one (it arrives in a query); 100 when
// it is not given.
function directoryLimit(value) {
  if (value === undefined || value === null) return DIRECTORY_PAGE;
  const size = typeof value === "string" && LIMIT_DIGITS.test(value) ? Number(value) : value;
  if (!Number.isInteger(size) || size < 1 || size > DIRECTORY_PAGE) throw limitInvalid();
  return size;
}

// A directory cursor is base64url (unpadded) of JSON.stringify([builtIn, createdAt, id]) of the last Station on a page,
// createdAt as the page showed it. Only exactly that is accepted: one spelling of the base64, the JSON as stringify writes
// it, a boolean, a time as toISOString writes it (a four-digit year), and an identifier. Anything else is 400 cursor, so
// a cursor is only ever one this list gave. It names a place in the order, not a Station: the Station need not be there
// any more.
function directoryCursor(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !CURSOR_CHARACTERS.test(value)) throw cursorInvalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw cursorInvalid();
  const text = bytes.toString("utf8");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw cursorInvalid(); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || JSON.stringify(parsed) !== text) throw cursorInvalid();
  const [builtIn, createdAt, id] = parsed;
  if (typeof builtIn !== "boolean" || typeof createdAt !== "string" || !CURSOR_TIME.test(createdAt) || typeof id !== "string" || !ID_GRAMMAR.test(id)) throw cursorInvalid();
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== createdAt) throw cursorInvalid();
  return { builtIn, createdAt, id };
}
const directoryCursorFor = (entry) => Buffer.from(JSON.stringify([entry.builtIn, entry.createdAt, entry.id])).toString("base64url");

// A Station as the directory shows it: routing and availability only, never its report client, its owner or its members.
// integrationsEnabled says whether an integration can be created there now: not on a removed Station, and not by a member
// whose membership ended.
function directoryEntry(row) {
  return {
    id: row.id, origin: row.origin, name: row.name, builtIn: row.builtIn, access: row.access, role: row.role, status: row.status,
    removedAt: row.removedAt, membership: row.membership, membershipEndedAt: row.membershipEndedAt,
    integrationsEnabled: row.status === "active" && row.integrationsEnabled && (row.role !== "member" || row.membership === "current"),
    createdAt: row.createdAt
  };
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function memberAccount(value) {
  if (typeof value !== "string" || !ACCOUNT_ID.test(value)) throw failure(400, "Enter an Agora Build account ID (ab…).", "account");
  return value;
}

function integrationName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  // Counted in UTF-16 units, as Auth counts it.
  if (!name || name.length > 80 || CONTROL.test(name)) throw failure(400, "Name the integration in 1 to 80 characters, without control characters.", "name");
  return name;
}

// Unique scopes from SCOPES; agent.view is always granted, so it is added when missing. agent.notify needs
// agent.message and agent.prompt, as Auth requires.
function integrationScopes(value) {
  if (!Array.isArray(value) || value.some((scope) => !SCOPES.includes(scope)) || new Set(value).size !== value.length) {
    throw failure(400, "Choose scopes from " + SCOPES.join(", ") + ", each at most once.", "scopes");
  }
  const scopes = value.includes("agent.view") ? [...value] : ["agent.view", ...value];
  if (scopes.includes("agent.notify") && !(scopes.includes("agent.message") && scopes.includes("agent.prompt"))) {
    throw failure(400, "agent.notify needs agent.message and agent.prompt.", "scopes");
  }
  return scopes;
}

function wholeNumber(value, min, max, message, code) {
  if (!Number.isInteger(value) || value < min || value > max) throw failure(400, message, code);
  return value;
}

const expiryDays = (value) => wholeNumber(value, 1, 90, "Choose an expiry of 1 to 90 days.", "expiry");
const quota = (value) => wholeNumber(value, 1, 10000, "Choose a quota of 1 to 10000 token requests per second.", "quota");

// Auth checks that the key is usable; Portal only refuses what is not a JWK object or carries private members.
function publicKey(value) {
  if (!plainObject(value)) throw failure(400, "Send the public key as a JSON Web Key object.", "jwk");
  if (PRIVATE_MEMBERS.some((member) => Object.hasOwn(value, member))) throw failure(400, "Send only the public key.", "private_key");
  return value;
}

function notRevoked(row) {
  if (STOPPED.includes(row.state)) throw failure(409, MANAGE_CONFLICTS.revoked, "revoked");
}

// transition, except that resuming a paused row with no recorded prior state goes back to where approval left it.
function step(row, event, at) {
  if (event === "resume" && row.state === "paused" && row.resumeState == null) {
    return transition({ ...row, resumeState: row.approvedAt ? "provisioning" : "awaiting_approval" }, event, at);
  }
  return transition(row, event, at);
}

function reportReason(value) {
  if (typeof value !== "string" || !PRINTABLE_REASON.test(value)) throw failure(400, "Give the reason in 1 to 200 characters, without control characters.", "reason");
  return value;
}

// A binding report (the setting on): the built-in Station's binding_changed or binding_attempt, validated in this order: its
// shape (exactly its form's fields: no integrationId, and none of another report's), the reportId, then the fields as the
// contract lists them. The reason is a code here, not the free text of today's report reason. `now` is the Portal's clock,
// for the latest time an attempt may be dated.
function bindingBody(body, now) {
  if (Object.keys(body).some((key) => !BINDING_REPORT_FIELDS[body.state].includes(key))) throw failure(400, BINDING_REPORT_FORMS, "report");
  const { state, reportId, account, accountId, genesisHash } = body;
  if (typeof reportId !== "string" || !ID_GRAMMAR.test(reportId)) throw reportIdInvalid();
  if (typeof account !== "string" || !ACCOUNT_ID.test(account)) throw bindingAccountInvalid();
  if (typeof accountId !== "string" || !ID_GRAMMAR.test(accountId)) throw bindingAccountIdInvalid();
  if (typeof genesisHash !== "string" || !GENESIS_HASH.test(genesisHash)) throw genesisHashInvalid();
  if (state === "binding_changed") {
    const { bindingId, version, bindingState } = body;
    if (typeof bindingId !== "string" || !ID_GRAMMAR.test(bindingId)) throw bindingIdInvalid();
    if (!Number.isSafeInteger(version) || version < 1) throw bindingVersionInvalid();
    if (!BINDING_STATES.includes(bindingState)) throw bindingStateInvalid();
    return { state, reportId, account, accountId, genesisHash, bindingId, version, bindingState };
  }
  const { reason, attemptedAt } = body;
  if (!ATTEMPT_REASONS.includes(reason)) throw attemptReasonInvalid();
  // As toISOString writes it, in the four-digit years the database holds without a doubt, and no more than an hour after
  // the Portal's clock.
  if (typeof attemptedAt !== "string" || !CURSOR_TIME.test(attemptedAt) || !authTime(attemptedAt) || Date.parse(attemptedAt) > now + ATTEMPT_CLOCK_SKEW) throw attemptedAtInvalid();
  return { state, reportId, account, accountId, genesisHash, reason, attemptedAt };
}

// A report's body: only integrationId, state and reason; `error` needs a reason, any other report may carry one. With the
// setting on (`delegated`, D29 Phase B) a report with a reportId is one of the two revocation reports, validated in this
// order: its shape (which fields may come together, and with which state), the state, the reportId, then the kind's
// fields. What comes back is the normalised report, which is also what is kept and compared when the same reportId
// comes again. The two binding reports (bindingBody) have their own form, and are told apart by their state first.
function reportBody(body, { delegated = false, now = 0 } = {}) {
  const forms = () => failure(400, delegated ? DELEGATED_REPORT_FORMS : REPORT_FORM, "report");
  if (delegated && plainObject(body) && typeof body.state === "string" && Object.hasOwn(BINDING_REPORT_FIELDS, body.state)) return bindingBody(body, now);
  if (!plainObject(body) || Object.keys(body).some((key) => !(delegated ? DELEGATED_REPORT_FIELDS : REPORT_FIELDS).includes(key))) throw forms();
  const { integrationId, state, reason, reportId } = body;
  const given = (names) => names.some((name) => body[name] !== undefined);
  // The new fields come with a reportId, never with a reason, and never from both kinds at once.
  if (delegated && (reportId === undefined ? given([...APPLIED_FIELDS, ...FINAL_FIELDS]) : reason !== undefined || (given(APPLIED_FIELDS) && given(FINAL_FIELDS)))) throw forms();
  const states = delegated ? [...REPORT_STATES, "revocation_applied"] : REPORT_STATES;
  if (state !== "error" && !states.includes(state)) throw failure(400, "Report a state of " + [...states, "error"].join(", ") + ".", "state");
  // The state is known, so the fields must fit it (the early check above caught what no state allows): a per-host report
  // carries no final's fields, a final no per-host fields, and any other report no reportId.
  if (delegated && (state === "revocation_applied" ? given(FINAL_FIELDS) : state === "revoked" ? given(APPLIED_FIELDS) : reportId !== undefined)) throw forms();
  if (!delegated || (reportId === undefined && state !== "revocation_applied")) {
    if (state === "error" || reason !== undefined) reportReason(reason);
    return { integrationId, state, reason: reason ?? null };
  }
  if (typeof reportId !== "string" || !ID_GRAMMAR.test(reportId)) throw reportIdInvalid();
  if (state === "revocation_applied") {
    const { host, recordId } = body;
    if (typeof host !== "string" || !ID_GRAMMAR.test(host)) throw hostInvalid();
    if (typeof recordId !== "string" || !RECORD_ID.test(recordId)) throw recordIdInvalid();
    return { integrationId, state, reportId, host, recordId };
  }
  const { outcome } = body;
  if (!OUTCOMES.includes(outcome) || !Array.isArray(body.pendingHosts)) throw outcomeInvalid();
  const pendingHosts = [...body.pendingHosts];
  if (pendingHosts.some((host) => typeof host !== "string" || !ID_GRAMMAR.test(host))) throw hostInvalid();
  // all_applied leaves none pending; deadline_passed names the ones that didn't confirm, each once.
  const fitting = outcome === "all_applied" ? pendingHosts.length === 0 : pendingHosts.length >= 1 && pendingHosts.length <= PENDING_HOSTS_MAX;
  if (!fitting || new Set(pendingHosts).size !== pendingHosts.length) throw outcomeInvalid();
  return { integrationId, state, reportId, outcome, pendingHosts };
}

// A body as one string whatever order its keys come in: jsonb does not keep them in the order they were sent.
const canonical = (value) => JSON.stringify(value, (key, member) => (plainObject(member) ? Object.fromEntries(Object.entries(member).sort(([one], [other]) => (one < other ? -1 : 1))) : member));

function feedCursor(value) {
  const cursor = typeof value === "string" && CURSOR.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw failure(400, "Send the cursor as a whole number of at least 0.", "cursor");
  return cursor;
}

// What a Station needs to act on an integration; the state is the effective one, so it may be "expired". ownerAccount
// lets the Station bind an integration to its owner before approval, when the integration itself has no token yet. A
// stopped one also says whether its revocation interrupts running tasks (delegated, D29).
function feedIntegration(row, at, delegated = false) {
  const entry = { ownerAccount: row.ownerAccount, state: effectiveState(row, at), scopes: row.scopes, r9Svc: row.r9Svc, expiresAt: row.expiresAt, quotaPerSecond: row.quotaPerSecond };
  if (delegated && STOPPED.includes(row.state)) entry.interruptRunning = row.interruptRunning;
  return entry;
}

// Who stopped a paused integration, for the page: Auth's pausedBy while the row is paused, and "admin" while Agora.Build
// has its owner's account disabled (Auth then issues it no token, and the Station sees it paused). null otherwise.
function pausedByOf(row, state) {
  if (state !== "paused") return null;
  if (row.ownerDisabledAt != null) return "admin";
  return row.state === "paused" && PAUSED_BY.includes(row.pausedBy) ? row.pausedBy : null;
}

// A time exactly as Auth writes it (toISOString): with the cursor it tells feed entries apart, and it is safe to cast
// in SQL (repository.latestStatus).
function authTime(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

// Whether an entry of Auth's change feed is one this Portal follows: a kind it knows, a cursor and a time as Auth writes
// them, and the subject the kind has. An integration's entry names its integration (clientId); an account entry (the
// setting on, D29) names no integration (clientId null) and an account (owner), and the accounts baseline names neither.
function changeEntry(entry, delegated) {
  if (!plainObject(entry) || !(delegated ? DELEGATED_AUTH_KINDS : AUTH_KINDS).includes(entry.kind)) return false;
  if (typeof entry.cursor !== "string" || !AUTH_CURSOR.test(entry.cursor) || !authTime(entry.at)) return false;
  if (entry.kind === BASELINE_KIND) return entry.clientId === null && entry.owner === null;
  if (ACCOUNT_KINDS.includes(entry.kind)) return entry.clientId === null && typeof entry.owner === "string" && ACCOUNT_ID.test(entry.owner);
  return typeof entry.clientId === "string";
}

// What an entry of Auth's change feed does to the Portal's row: the event kind and the fields to write. Auth is
// authoritative, so following it is not held back by expiry: transitions are checked at time 0, as in reconcile. A
// stopped integration is revoked at Auth, which changes it no more, so an entry about it is older than that and is
// only recorded (Ruling R-A): it is not paused, resumed, disabled or enabled again. An owner's account being disabled
// is its own flag, not a pause of the row (effectiveState shows it as paused), so enabling it restores each
// integration as it was. The flag holds the time of the latest disable, written again by every disable, so a flag
// the Portal saw before an owner's call (byActor) is told apart from one that came after it.
//
// With the setting on (`delegated`, D29) a revocation that says it interrupts running tasks sets the row's choice, on a
// stopped row too (the owner revoked first): it only ever goes from false to true. An admin's later interrupt sets it
// too, whatever the row's state: Auth writes one only for a revoked integration.
function authEffect(row, entry, { delegated = false } = {}) {
  const stopped = STOPPED.includes(row.state);
  const interrupt = delegated && !row.interruptRunning ? { interruptRunning: true } : {};
  if (delegated && entry.kind === "interrupt_requested") return { kind: "integration_interrupt_requested", fields: interrupt };
  if (entry.kind === "revoked") {
    // A live row's revocation is dated as Auth dated it.
    const revoke = stopped ? {} : { ...step(row, "revoke", 0), pausedBy: null, revokedAt: entry.at };
    return { kind: "integration_revoked", fields: entry.interruptRunning === true ? { ...revoke, ...interrupt } : revoke };
  }
  if (stopped) return { kind: "integration_" + entry.kind, fields: {} };
  if (entry.kind === "paused") {
    const pausedBy = PAUSED_BY.includes(entry.pausedBy) ? entry.pausedBy : null;
    if (row.state !== "paused") return { kind: "integration_paused", fields: { ...step(row, "pause", 0), pausedBy } };
    return { kind: "integration_paused", fields: row.pausedBy === pausedBy ? {} : { pausedBy } };
  }
  if (entry.kind === "resumed") return { kind: "integration_resumed", fields: row.state === "paused" ? { ...step(row, "resume", 0), pausedBy: null } : {} };
  if (entry.kind === "owner_disabled") return { kind: "integration_owner_disabled", fields: row.ownerDisabledAt === entry.at ? {} : { ownerDisabledAt: entry.at } };
  return { kind: "integration_owner_enabled", fields: row.ownerDisabledAt ? { ownerDisabledAt: null } : {} };
}

// authChanged() asks the stack to read Auth's change feed soon (a resume answered 409 admin_paused). delegatedHostWork
// (DELEGATED_HOST_WORK=1, D29) is off by default: off is today's behaviour.
export function createIntegrationService({
  repository, db, manage, stationFetch, exchange, now = Date.now, log = () => {}, ids = randomUUID,
  challengeValue = () => randomBytes(32).toString("base64url"), pushFetch = createStationFetch({ timeoutMs: 3000 }), notify, authChanged = () => {},
  delegatedHostWork = false
}) {
  // The Station's checkpoint (D29), all read in one repeatable read, read-only transaction, so it is one snapshot: the
  // newest event id is the cursor, and everything else is the state those events (and no later one) left. A writer that
  // appends under the event lock commits its event and its rows together, so a change is in the snapshot with its
  // event or in neither, and every change committed later has a larger id (ids are taken in commit order, appendEvent).
  // It takes no lock, so it never waits for a writer. Each integration is in the feed's shape (the effective state as of
  // `at`) with its id, and a stopped one says when it was revoked. Only the built-in Station has the accounts (whether
  // the Portal's view is complete, and the disabled ones) and the bindings it last reported.
  async function checkpointOf(station) {
    const snapshot = await db.transaction(async (client) => ({
      cursor: await repository.latestCursor(station.id, client),
      rows: await repository.integrationsOnStation(station.id, client),
      ...(station.builtIn ? {
        complete: await repository.baselineApplied(client),
        disabled: await repository.disabledAccountList(client),
        bindings: await repository.bindingsOn(station.id, client)
      } : {})
    }), { isolation: "repeatable read", readOnly: true });
    const at = now();
    const checkpoint = {
      at: new Date(at).toISOString(),
      integrations: snapshot.rows.map((row) => ({ id: row.id, ...feedIntegration(row, at, true), ...(STOPPED.includes(row.state) ? { revokedAt: row.revokedAt } : {}) }))
    };
    if (station.builtIn) {
      checkpoint.accounts = { complete: snapshot.complete, disabled: snapshot.disabled };
      checkpoint.bindings = snapshot.bindings.map((row) => ({ account: row.accountId, accountId: row.r9AccountId, genesisHash: row.genesisHash, bindingId: row.bindingId, version: row.version, bindingState: row.bindingState }));
    }
    return { changes: [], cursor: snapshot.cursor, checkpoint };
  }

  // Every transaction here appends events, so each takes the event lock before any row lock (see lockEvents).
  const appending = (work) => db.transaction(async (client) => {
    await repository.lockEvents(client);
    return work(client);
  });

  // Per Station: the push in flight and whether another change arrived while it ran.
  const pushes = new Map();

  // Per account and built-in Station: the creation or renewal in flight, so the next one waits for
  // its count (plan limits).
  const creations = new Map();
  function oneAtATime(key, work) {
    const run = (creations.get(key) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    creations.set(key, settled);
    settled.then(() => { if (creations.get(key) === settled) creations.delete(key); });
    return run;
  }

  // Refuses at the plan limit, counting the account's live integrations on a built-in Station. With the setting on
  // (D29 Phase B) a revoking one isn't live: Auth has revoked it already, and it may wait a day or more for its
  // Station's final report. Call it inside oneAtATime for that account and Station.
  async function underPlanLimit(accountId, stationId, plan) {
    const limit = builtInIntegrationLimit(plan);
    if (limit !== null && await repository.countLiveIntegrations(stationId, accountId, now(), undefined, { revokingHoldsPlace: !delegatedHostWork }) >= limit) {
      throw failure(403, "Your plan allows " + limit + " integrations on the built-in Station. Revoke one, upgrade, or use your own Station.", "plan_limit", { limit });
    }
  }

  // Nudges the Station to read its change feed. The nudge carries no authority, only the latest cursor; the Station
  // learns what changed by polling with its own token. At most one push per Station is in flight; calls meanwhile
  // collapse into one more push, sent once it ends with the then-latest cursor. Never throws; failures are logged.
  function push(stationId) {
    const running = pushes.get(stationId);
    if (running) {
      running.pending = true;
      return;
    }
    const entry = { pending: false, done: null };
    pushes.set(stationId, entry);
    entry.done = (async () => {
      try {
        do {
          entry.pending = false;
          await pushOnce(stationId);
        } while (entry.pending);
      } finally {
        pushes.delete(stationId);
      }
    })();
  }

  async function pushOnce(stationId) {
    try {
      // A removed Station is still pushed to once, so it learns to stop.
      const station = await repository.station(stationId);
      if (!station) return;
      const cursor = await repository.latestCursor(stationId);
      const reply = await pushFetch.post(station.origin + CHANGES_PATH, { cursor });
      if (reply.status < 200 || reply.status > 299) log("Station change push failed: status_" + reply.status + ".");
    } catch (error) {
      log("Station change push failed: " + (error instanceof ProofError ? error.reason : "error") + ".");
    }
  }

  async function reportingStation(clientId) {
    const station = typeof clientId === "string" && clientId ? await repository.stationByReportClient(clientId) : null;
    if (!station) throw unknownStation();
    return station;
  }

  // Tells the Station about a committed change; a failed nudge never fails the change itself.
  function changed(stationId) {
    try {
      const result = (notify ?? push)(stationId);
      if (typeof result?.catch === "function") result.catch(() => log("Station notify failed."));
    } catch {
      log("Station notify failed.");
    }
  }

  // For the event of a pause, resume or revocation the Portal saw at Auth (its own call's answer, or an owner's
  // listing): when it saw it, on the Portal's clock, which is no earlier than Auth made it (Ruling R-A).
  const seen = () => ({ seenAt: new Date(now()).toISOString() });

  // A management call naming accountId as actor. Auth refuses one whose actor is disabled (400 invalid_request), so a
  // call it accepts proves the account was enabled at some moment after the call began (Ruling R-D). An owner-disabled
  // flag the Portal already had before the call is older than that moment, so it is stale (its owner_enabled was
  // missed, or is not read yet): it is cleared, and the Station told. A flag is cleared only while it still holds the
  // disable time read before the call. Every disable the feed applies writes its own time, so a disable read after
  // that (while the call ran, or before the clear) changes the flag and stays; one read after the clear sets it again.
  async function byActor(accountId, call) {
    const flagged = await repository.ownerDisabledIntegrations(accountId);
    const answer = await viaAuth(call);
    if (flagged.length) {
      try {
        await ownerEnabled(flagged);
      } catch {
        log("Owner-disabled flag not cleared: error.");
      }
    }
    return answer;
  }

  async function ownerEnabled(flagged) {
    const stations = new Set();
    for (const { id, ownerDisabledAt } of flagged) {
      const stationId = await appending(async (client) => {
        const row = await repository.integrationForUpdate(id, client);
        if (!row || row.ownerDisabledAt !== ownerDisabledAt || STOPPED.includes(row.state)) return null;
        await repository.updateIntegration(id, { ownerDisabledAt: null }, client);
        await repository.appendEvent({ stationId: row.stationId, integrationId: id, accountId: row.ownerAccount, actor: SYSTEM, kind: "integration_owner_enabled", state: row.state, reason: "reconciled" }, client);
        return row.stationId;
      });
      if (stationId) stations.add(stationId);
    }
    if (!stations.size) return;
    log("Owner-disabled flag cleared: Auth accepted a call by the owner.");
    for (const stationId of stations) changed(stationId);
  }

  // Revokes, inside the caller's transaction, each integration `pick` selects on the Station; already revoking or
  // revoked ones are left as they are. `direct` sets revoked at once (Auth has already removed the Station). An
  // indirect revocation never interrupts running tasks (delegated, D29). Returns how many it revoked.
  async function revokeOn(client, stationId, pick, { actor, reason, direct = false }) {
    const at = now();
    let revoked = 0;
    for (const listed of await repository.integrationsOnStation(stationId, client)) {
      if (!pick(listed) || listed.state === "revoking" || listed.state === "revoked") continue;
      const row = await repository.integrationForUpdate(listed.id, client);
      if (row.state === "revoking" || row.state === "revoked") continue;
      // A revoked integration is no longer paused by anyone.
      const next = { ...(direct ? { state: "revoked", resumeState: null } : transition(row, "revoke", at)), pausedBy: null, revokedAt: at };
      await repository.updateIntegration(row.id, next, client);
      await repository.appendEvent({ stationId, integrationId: row.id, accountId: row.ownerAccount, actor, kind: "integration_revoked", state: next.state, reason, ...(delegatedHostWork ? { details: { interruptRunning: false } } : {}) }, client);
      revoked += 1;
    }
    return revoked;
  }

  // Inside the caller's transaction, retires an active Portal Station at `origin` other than `id`: Auth has given the
  // origin to `id`, so the old Station is gone there, with its integrations. Returns the retired Station's ID or null.
  async function retireStale(client, origin, id) {
    const stale = await repository.activeStationAt(origin, client);
    if (!stale || stale.id === id) return null;
    await repository.markStationRemoved(stale.id, now(), client);
    await revokeOn(client, stale.id, () => true, { actor: "system", reason: "reconciled", direct: true });
    await repository.appendEvent({ stationId: stale.id, accountId: stale.ownerAccount ?? SYSTEM, actor: SYSTEM, kind: "station_removed", reason: "reconciled" }, client);
    return stale.id;
  }

  function retired(stationId) {
    if (!stationId) return;
    log("Station removed in Portal: its origin belongs to another Station at Auth.");
    changed(stationId);
  }

  // The active Station as this account has it in Portal (with its role, "built_in", "owner" or "member"). An account
  // that neither owns a custom Station nor is a current member gets the same 404 as for an unknown ID, before Auth is
  // asked, so nothing about the Station is revealed (as for integrations, Ruling T7-8). Every account has the built-in.
  async function usable(accountId, stationId) {
    const station = typeof stationId === "string" && stationId ? (await repository.stationsFor(accountId)).find((entry) => entry.id === stationId) : null;
    if (!station) throw notFound();
    return station;
  }

  // Remove, share, leave and the member list don't exist for a built-in Station; refused here as Auth refuses them
  // (409 built_in), without asking Auth.
  function notBuiltIn(station) {
    if (station.builtIn) throw failure(409, BUILT_IN_FIXED, "built_in");
    return station;
  }

  // Auth answers 409 origin_taken for a built-in Station's origin; Portal says so before a check is issued or fetched.
  async function notBuiltInOrigin(origin) {
    if ((await repository.builtInStations()).some((station) => station.origin === origin)) throw failure(409, BUILT_IN_ORIGIN, "origin_taken");
  }

  // For changes only the Station's owner may make; a member sees the Station, so it is told why.
  async function ownStation(accountId, stationId) {
    const station = notBuiltIn(await usable(accountId, stationId));
    if (station.role !== "owner") throw ownerOnly();
    return station;
  }

  // Reads Auth's list of the account's Stations and reconciles Portal's rows with it. False when Auth is unreachable (503):
  // the Portal's own rows are then all there is to show, and the answer says so (stale). Any other refusal is an error.
  async function reconcileWithAuth(accountId) {
    let listed;
    try {
      listed = await manage.stations(accountId);
    } catch (error) {
      if (!(error instanceof ManageError) || fromManage(error).status !== 503) throw fromManage(error);
      log("Station list served from Portal: Auth " + error.code + ".");
    }
    if (listed) await reconcile(accountId, listed);
    return Boolean(listed);
  }

  // Brings Portal's rows in line with Auth's list for this account; Auth is authoritative. Removals run first, so a
  // Station Auth has replaced at the same origin is retired before its successor is added.
  async function reconcile(accountId, listed) {
    const known = new Set(listed.map((station) => station.id));
    for (const station of await repository.stationsFor(accountId)) {
      // A built-in Station is every account's: a listing without it never removes it or revokes anything (D24).
      if (station.builtIn) {
        if (!known.has(station.id)) log("Built-in Station absent from Auth's listing: left as it is.");
        continue;
      }
      if (known.has(station.id)) continue;
      if (station.role === "owner") {
        await appending(async (client) => {
          await repository.markStationRemoved(station.id, now(), client);
          await revokeOn(client, station.id, () => true, { actor: "system", reason: "reconciled", direct: true });
          await repository.appendEvent({ stationId: station.id, accountId, actor: "system", kind: "station_removed", reason: "reconciled" }, client);
        });
        log("Station removed in Portal: absent from Auth.");
        changed(station.id);
        continue;
      }
      // Auth no longer counts this account a member (and has revoked its integrations there); Portal follows.
      const removed = await appending(async (client) => {
        if (!(await repository.removeMember(station.id, accountId, "system", now(), client))) return false;
        await revokeOn(client, station.id, (row) => row.ownerAccount === accountId, { actor: "system", reason: "member_removed" });
        await repository.appendEvent({ stationId: station.id, accountId, actor: "system", kind: "member_removed", reason: "reconciled" }, client);
        return true;
      });
      if (removed) {
        log("Station member removed in Portal: absent from Auth.");
        changed(station.id);
      }
    }
    for (const entry of listed) {
      if (entry.builtIn) {
        await reconcileBuiltIn(entry);
        continue;
      }
      const existing = await repository.station(entry.id);
      // A built-in Station is only ever reconciled as one: it never gains an owner or members here.
      if (existing?.builtIn) {
        log("Built-in Station listed by Auth as a custom Station: left as it is.");
        continue;
      }
      // Auth still lists a Station Portal has removed (its integrations already revoked here); restoring it is left to
      // an operator, so it is logged.
      if (existing?.status === "removed") log("Station listed by Auth is removed in Portal: not restored.");
      if (!existing) {
        // The insert's own answer gates the event, so concurrent listings record the Station once.
        const { added, stale } = await appending(async (client) => {
          const stale = await retireStale(client, entry.origin, entry.id);
          if (!(await repository.insertStation({ id: entry.id, origin: entry.origin, ownerAccount: entry.owner, reportClientId: entry.reportClientId, verifiedAt: entry.createdAt }, client))) return { added: false, stale };
          await repository.appendEvent({ stationId: entry.id, accountId: entry.owner, actor: "system", kind: "station_reconciled" }, client);
          return { added: true, stale };
        });
        retired(stale);
        if (added) {
          log("Station reconciled from Auth: missing in Portal.");
          changed(entry.id);
        }
      }
      if (entry.owner !== accountId && !(await repository.currentMembers(entry.id)).some((member) => member.accountId === accountId)) {
        const added = await appending(async (client) => {
          if (!(await repository.addMember(entry.id, accountId, "system", now(), client))) return false;
          await repository.appendEvent({ stationId: entry.id, accountId, actor: "system", kind: "member_added", reason: "reconciled" }, client);
          return true;
        });
        if (added) {
          log("Station member reconciled from Auth: missing in Portal.");
          changed(entry.id);
        }
      }
    }
  }

  // Inserts a built-in Station Auth lists (no owner, no members) or follows its name and integrations setting. A new
  // Station at the origin of an older one retires the older one, as for custom Stations.
  async function reconcileBuiltIn(entry) {
    const existing = await repository.station(entry.id);
    if (existing?.status === "removed") {
      log("Built-in Station listed by Auth is removed in Portal: not restored.");
      return;
    }
    const settings = { name: entry.name, integrationsEnabled: entry.integrations === true };
    if (existing) {
      if (await repository.updateBuiltInStation(entry.id, settings)) log("Built-in Station settings followed from Auth.");
      return;
    }
    const { added, stale } = await appending(async (client) => {
      const stale = await retireStale(client, entry.origin, entry.id);
      if (!(await repository.insertStation({ id: entry.id, origin: entry.origin, reportClientId: entry.reportClientId, verifiedAt: entry.createdAt, builtIn: true, ...settings }, client))) return { added: false, stale };
      await repository.appendEvent({ stationId: entry.id, accountId: SYSTEM, actor: SYSTEM, kind: "station_reconciled", reason: "built_in" }, client);
      return { added: true, stale };
    });
    retired(stale);
    if (added) {
      log("Built-in Station added from Auth.");
      changed(entry.id);
    }
  }

  // How the Portal follows Auth's accounts (D29, the setting on). It is in one of three modes, kept with its place in
  // Auth's feed (repository.accountSync):
  // * rebuilding: from the feed's first entry, into tables of its own (a first start, a reset, or Auth restored). The
  //   live table and the built-in Stations are left alone; at the end of the feed the rebuild is adopted, and the
  //   Stations hear only how it differs from the live table (accountsCaughtUp).
  // * live: each entry as it comes, in Auth's order, to the live table and, a disable or enable, to every active built-in
  //   Station.
  // * waiting: an account-level entry was skipped (the setting off, or one it can't apply), so what it applied since could
  //   not be trusted to be all of Auth's feed. Nothing more is applied until the feed is read again from the start.
  // Every start-over raises an epoch. A read pass hands the service the epoch it began in, and an account-level entry or
  // the end of a read from an earlier epoch is refused under the event lock before it does anything (stale_pass), so a
  // pass in flight when another replica started over never applies anything to the new epoch's rebuild.
  //
  // The view is complete (account_baseline.complete, the checkpoint's accounts.complete) only while live, from a
  // baseline applied in order on. Each time it stops being complete with the setting on, every active built-in Station
  // gets one accounts_incomplete change; when it stopped with the setting off, the Stations are owed it, and get it the
  // next time the Portal runs with the setting on.

  // Read passes the waiting line was logged for, and when this process last logged it. A pass that skips an account-level
  // entry says it once (sayWaiting); the end of a read that skipped none says it at most once an hour (stillWaiting), so a
  // Portal that waits says so however quiet Auth's feed is.
  const waitingSaid = new WeakSet();
  let waitingLoggedAt = -Infinity;
  function sayWaiting(pass) {
    if (waitingSaid.has(pass)) return;
    waitingSaid.add(pass);
    waitingLoggedAt = now();
    log(WAITING_LINE);
  }
  function stillWaiting(pass) {
    if (waitingSaid.has(pass) || now() - waitingLoggedAt < WAITING_AGAIN_MS) return;
    sayWaiting(pass);
  }

  // The fence: an account-level step of a read pass is done only in the epoch the pass began in. Called under the event
  // lock, which a start-over takes too. A pass is a must here: one missing is a mistake, not a pass to let through.
  function fenced(sync, pass) {
    if (!plainObject(pass) || !Number.isSafeInteger(pass.epoch)) throw new TypeError("Account-level work needs the read pass it is part of: { epoch }.");
    if (pass.epoch !== sync.epoch) throw Object.assign(new Error("This read pass began before the feed was started over."), { code: "stale_pass" });
  }

  // Appends one account-level event to each Station: a disable, an enable, the baseline or the incomplete signal.
  async function tell(stations, { kind, accountId = null, actor = SYSTEM, reason = null, details }, client) {
    for (const station of stations) {
      await repository.appendEvent({ stationId: station.id, integrationId: null, accountId, actor, kind, state: null, reason, details }, client);
    }
  }

  // The view stops being complete (a start-over, or a move to waiting, with the setting on): the mark is cleared and, if
  // the Stations were told it was complete (it was, or they are owed the news), each active built-in Station gets one
  // accounts_incomplete change. Returns null when nobody was told, and otherwise { mode, stations } for toldIncomplete
  // once the transaction has committed.
  async function becameIncomplete(sync, mode, client) {
    const was = await repository.markBaselineIncomplete(client);
    if (!was && !sync.incompleteOwed) return null;
    if (sync.incompleteOwed) await repository.setAccountsIncompleteOwed(false, client);
    const stations = await repository.builtInStations(client);
    await tell(stations, { kind: INCOMPLETE_KIND, details: { admin: false, mode } }, client);
    return { mode, stations };
  }

  // After the commit: the counts-only line, and the push to each Station told.
  function toldIncomplete(told) {
    if (!told) return;
    log("Account availability incomplete: " + told.mode + ".");
    for (const station of told.stations) changed(station.id);
  }

  // An account-level entry of Auth's change feed (D29, the setting on): an admin disabled or enabled an account, or Auth
  // wrote its accounts baseline, applied in one transaction as the mode says. Live, the entry is marked applied (once,
  // whatever is read again) and the account's availability written, or the baseline recorded; a disable or enable is
  // recorded as an event on each active built-in Station, so a Station learns of each change (and a cursor-0 read lists
  // the accounts disabled now); a baseline that completes the view gives each one accounts_baseline change. A custom
  // Station never gets one, since an admin's action against a person isn't disclosed to a third-party operator (design
  // III.5). The Stations are pushed after the commit, and a failure anywhere rolls all of it back, so the reader's next
  // read applies the entry once. With no built-in Station the tables are still updated. Rebuilding, the entry goes to the
  // rebuild's tables only and nobody is told. Waiting, it is skipped and not recorded. Order is the feed's: the reader
  // applies entries in Auth's order under the event lock, and availability is whatever the entry applied last says,
  // never judged by Auth's clock. Returns "applied", or "skipped" when it was applied before or the Portal waits.
  async function accountChange(entry, actor, reason, pass) {
    const baseline = entry.kind === BASELINE_KIND;
    const applied = { cursor: entry.cursor, at: entry.at, account: entry.owner, kind: entry.kind };
    const done = await appending(async (client) => {
      const sync = await repository.accountSync(client);
      fenced(sync, pass);
      if (sync.mode === "waiting") return WAITING;
      if (sync.mode === "rebuilding") {
        if (!(await repository.applyRebuildEntry(applied, client))) return null;
        if (baseline) await repository.setRebuildBaseline(entry.cursor, entry.at, client);
        else await repository.setRebuildAvailability(entry.owner, entry.kind === "account_disabled", entry.cursor, entry.at, client);
        return { stations: [] };
      }
      if (!(await repository.applyAccountEntry(applied, client))) return null;
      const active = await repository.builtInStations(client);
      if (baseline) {
        // Live, everything before it was applied in order: from here the view is complete.
        await repository.setBaseline(entry.cursor, entry.at, client);
        if (!(await repository.markBaselineComplete(client))) return { stations: [] };
        await tell(active, { kind: BASELINE_KIND, details: { authCursor: entry.cursor, authAt: entry.at, admin: false } }, client);
        return { stations: active, completed: true };
      }
      await repository.setAvailability(entry.owner, entry.kind === "account_disabled", entry.cursor, entry.at, client);
      await tell(active, { kind: entry.kind, accountId: entry.owner, actor, reason, details: { authCursor: entry.cursor, authAt: entry.at, admin: entry.admin === true } }, client);
      return { stations: active, unheard: !active.length };
    });
    if (done === WAITING) {
      sayWaiting(pass);
      return "skipped";
    }
    if (done === null) return "skipped";
    if (done.unheard) log("Auth account change skipped: no built-in Station.");
    if (done.completed) log("Account availability complete.");
    for (const station of done.stations) changed(station.id);
    return "applied";
  }

  // The Portal skipped an account-level entry: its setting is off, or (on) the entry is malformed or a person's own,
  // which Auth never writes. It moves to waiting, in one transaction: nothing is forgotten, nothing else changes, and the
  // view is no longer complete. With the setting on that is after the fence, and each active built-in Station is told
  // now (becameIncomplete); with it off nothing is written to a Station, so they are owed the news instead.
  async function accountsWait(pass) {
    if (!delegatedHostWork) {
      await appending((client) => waitUnheard(client));
      return;
    }
    const told = await appending(async (client) => {
      const sync = await repository.accountSync(client);
      fenced(sync, pass);
      await repository.setAccountsMode("waiting", client);
      return becameIncomplete(sync, "waiting", client);
    });
    toldIncomplete(told);
    sayWaiting(pass);
  }

  // The setting-off move to waiting: the mark is cleared and, if the Stations were told the view was complete, they are
  // owed the news, since nothing is written to a Station with the setting off.
  async function waitUnheard(client) {
    await repository.setAccountsMode("waiting", client);
    if (await repository.markBaselineIncomplete(client)) await repository.setAccountsIncompleteOwed(true, client);
  }

  // Shown as paused while its own state is not: its owner's account is disabled.
  const shownPaused = (row) => row.state !== "paused" && effectiveState(row, now()) === "paused";

  // How a stopped integration's revocation went, as counts (D29 Phase B): the hosts that applied it, its final outcome, and
  // with deadline_passed how many of the hosts that didn't confirm have not applied it since. Host names are never shown.
  function revocationCounts(row, hosts) {
    const pending = row.revocationOutcome === "deadline_passed" ? row.revocationPendingHosts ?? [] : null;
    return { appliedHosts: hosts.size, outcome: row.revocationOutcome, unconfirmedHosts: pending ? pending.filter((host) => !hosts.has(host)).length : null };
  }

  // The hosts recorded for a stopped integration's revocation, read only when a view shows them (the setting on).
  const revocationHostsOf = (row) => (delegatedHostWork && STOPPED.includes(row.state) ? repository.revocationHosts(row.id) : undefined);

  // `hosts` (revocationHostsOf) is for a view that shows the revocation's counts; a Station's own answer and a new
  // integration are given none.
  function integrationView(row, role, station, hosts) {
    const state = effectiveState(row, now());
    const view = {
      id: row.id, kind: row.kind, name: row.name, stationId: row.stationId, stationOrigin: station?.origin ?? null, scopes: row.scopes,
      // An integration shown as paused because its owner's account is disabled reads like an admin's pause: what it was
      // paused from is its own state.
      state, pausedFrom: state === "paused" && row.state !== "paused" ? row.state : row.resumeState, pausedBy: pausedByOf(row, state), r9Svc: row.r9Svc, quotaPerSecond: row.quotaPerSecond,
      expiresAt: row.expiresAt, approvedAt: row.approvedAt, lastError: row.lastError, createdAt: row.createdAt, role
    };
    // When it was revoked and whether that interrupts running tasks (delegated, D29), and, for one whose Station has been
    // removed, that: the Station never reads its feed again, so an interrupt could reach no host and none is offered.
    if (delegatedHostWork && STOPPED.includes(state)) {
      Object.assign(view, { revokedAt: row.revokedAt, interruptRunning: row.interruptRunning });
      if (station?.status === "removed") view.stationRemoved = true;
      if (hosts) view.revocation = revocationCounts(row, hosts);
    }
    return view;
  }

  async function viewOf(row, role) {
    return integrationView(row, role, await repository.station(row.stationId), await revocationHostsOf(row));
  }

  // The row and the account's part in it: "owner", "station_owner" (it owns the integration's custom Station) or null.
  // A built-in Station has no owner, so only the integration's owner finds it here: Agora.Build admins act on the
  // admin site through Auth, never through the Portal (spec §3.3.4, D26).
  async function access(accountId, id) {
    const row = typeof id === "string" && id ? await repository.integration(id) : null;
    if (!row) throw notFound();
    if (row.ownerAccount === accountId) return { row, role: "owner" };
    const station = await repository.station(row.stationId);
    return { row, role: station && !station.builtIn && station.ownerAccount === accountId ? "station_owner" : null };
  }

  // An account that neither owns the integration nor its Station gets the same 404 as for an unknown ID, before any
  // state check, so nothing about the integration is revealed.
  async function visible(accountId, id) {
    const found = await access(accountId, id);
    if (!found.role) throw notFound();
    return found;
  }

  // For changes only the integration's owner may make; a Station owner sees the integration, so it is told why.
  async function owned(accountId, id) {
    const { row, role } = await visible(accountId, id);
    if (role !== "owner") throw failure(403, "Only the integration's owner can do this.", "forbidden");
    return row;
  }

  // A refusal names the state the Station is shown: paused, for an integration whose owner's account is disabled.
  function shownRefusal(error, row) {
    return error.details?.code === "invalid_state" && shownPaused(row) ? failure(409, "This integration is paused and cannot take that action.", "invalid_state") : error;
  }

  // The answer to an accepted report: the integration as its Station sees it. As in its feed, the Station is not told who
  // paused an integration, nor (the setting on, D29) when it was revoked or the counts of its revocation (the Station
  // sent those), nor whether that interrupts running tasks: the feed says the latter, and the answer stays as it is today.
  function reportAnswer(row, station) {
    const { role, pausedBy, revokedAt, interruptRunning, stationRemoved, revocation, ...view } = integrationView(row, null, station);
    return view;
  }

  // A binding report (D29), in the transaction of identifiedReport, which has found no report under its id. A binding_attempt
  // is kept as it is for the account it protects. A binding_changed is the Station's newest word on its R9 account at a
  // genesis only if its version is higher than the recorded one; the same version with the identical binding (account,
  // bindingId, bindingState) is the same news again and changes nothing, and any other not-newer one is refused, which
  // rolls the transaction back (its id stays free). The answer is the recorded binding. Neither is an event or a push: the
  // checkpoint reads the bindings, and the page reads the attempts.
  async function recordBinding(station, report, client) {
    if (report.state === "binding_attempt") {
      await repository.saveBindingAttempt({ stationId: station.id, reportId: report.reportId, accountId: report.account, r9AccountId: report.accountId, genesisHash: report.genesisHash, reason: report.reason, attemptedAt: report.attemptedAt }, client);
      return { recorded: true };
    }
    const recorded = await repository.binding(station.id, report.accountId, report.genesisHash, client);
    if (!recorded || recorded.version < report.version) {
      await repository.saveBinding({ stationId: station.id, r9AccountId: report.accountId, genesisHash: report.genesisHash, accountId: report.account, bindingId: report.bindingId, version: report.version, bindingState: report.bindingState, reportId: report.reportId }, client);
    } else if (recorded.version !== report.version || recorded.accountId !== report.account || recorded.bindingId !== report.bindingId || recorded.bindingState !== report.bindingState) {
      throw bindingNotNewer();
    }
    return { accountId: report.accountId, genesisHash: report.genesisHash, bindingId: report.bindingId, version: report.version, bindingState: report.bindingState };
  }

  // A report with a reportId (the setting on, D29 Phase B): `revocation_applied` for one host, or the final `revoked` with
  // how the revocation ended; and, from the built-in Station only (403 before anything is recorded), a binding report
  // (recordBinding), which names no integration. Ids are per Station and kept forever with the report and its answer: the
  // same id with the same body answers what was recorded and changes nothing, with another body it is refused. All of it
  // runs in one transaction under the event lock, so a retry racing itself waits for the first and then finds its answer,
  // and a refused report (the transaction rolls back) records nothing. Nobody is pushed: the Station made the change itself.
  function identifiedReport(station, report) {
    const { integrationId, reportId } = report;
    const binding = Object.hasOwn(BINDING_REPORT_FIELDS, report.state);
    if (binding && !station.builtIn) throw builtInOnly();
    return appending(async (client) => {
      const kept = await repository.stationReport(station.id, reportId, client);
      if (kept) {
        if (canonical(kept.body) !== canonical(report)) throw reportIdReused();
        return kept.answer;
      }
      if (binding) {
        const answer = await recordBinding(station, report, client);
        await repository.saveStationReport({ stationId: station.id, reportId, integrationId: null, body: report, answer }, client);
        return answer;
      }
      const found = typeof integrationId === "string" && integrationId ? await repository.integration(integrationId, client) : null;
      if (!found || found.stationId !== station.id) throw notFound();
      let row = await repository.integrationForUpdate(integrationId, client);
      if (report.state === "revocation_applied") {
        // A host counts once: the first report for it stands, and a later one (late ones too) is only kept under its own id.
        if (!STOPPED.includes(row.state)) throw notRevokedYet();
        await repository.recordRevocationHost({ integrationId, host: report.host, recordId: report.recordId, reportId }, client);
      } else {
        if (row.revocationOutcome != null) throw finalReported();
        // From revoking it revokes, as today's report does; on a revoked integration (a legacy report came first) it only
        // records the outcome.
        let fields = {};
        if (row.state !== "revoked") {
          try {
            fields = { ...transition(row, "report:revoked", now()), lastError: null };
          } catch (error) {
            throw shownRefusal(error, row);
          }
        }
        await repository.updateIntegration(integrationId, { ...fields, revocationOutcome: report.outcome, revocationPendingHosts: report.pendingHosts }, client);
        if (row.state !== "revoked") {
          await repository.appendEvent({ stationId: row.stationId, integrationId, accountId: row.ownerAccount, actor: "station", kind: "integration_reported", state: "revoked", details: { outcome: report.outcome, unconfirmedHosts: report.pendingHosts.length } }, client);
        }
        row = await repository.integration(integrationId, client);
      }
      const answer = reportAnswer(row, station);
      await repository.saveStationReport({ stationId: station.id, reportId, integrationId, body: report, answer }, client);
      return answer;
    });
  }

  // The Portal half of a change Auth has already made: under the row lock `apply` re-checks the current row and returns
  // `{ fields, event }` (or null for nothing to do). The Station is notified after commit unless `push` is false.
  async function commit(id, apply, { push = true } = {}) {
    const result = await appending(async (client) => {
      const current = await repository.integrationForUpdate(id, client);
      if (!current) throw notFound();
      const change = apply(current);
      if (!change) return { row: current, done: false };
      const { fields = {}, event } = change;
      if (Object.keys(fields).length) await repository.updateIntegration(id, fields, client);
      if (event) {
        await repository.appendEvent({ stationId: current.stationId, integrationId: id, accountId: current.ownerAccount, state: fields.state ?? current.state, ...event }, client);
      }
      return { row: await repository.integration(id, client), done: true };
    });
    if (result.done && push) changed(result.row.stationId);
    return result.row;
  }

  // pause and revoke: the integration's owner or its Station's owner; anyone else is told nothing about it. A pause
  // records who paused it as Auth answers (an admin's pause already there stays the admin's: Auth never lowers it), or
  // by role from an Auth without the admin pause lock. A revocation clears it, and is dated (revokedAt) whatever the
  // setting. With the setting on a revocation must say whether to interrupt the tasks running on the owner's hosts
  // (D29): that is checked first, so a malformed call is refused the same for everyone. The row and the event keep the
  // choice either way, but Auth is sent it only when it is true: an unticked revoke is then exactly today's call, and
  // survives an Auth whose own setting is still off (which refuses the field), while Auth records a missing one as
  // false. `details` is added to the event's; `mineOnly` refuses the Station's owner (404), as approval does. A revoke
  // of an integration that is already stopped changes nothing, except that a true (the setting on) adds the interrupt
  // as Interrupt does (addInterrupt: Auth is not asked), so a mirror of "revoke and interrupt" converges after another
  // revocation came first: before this call reached Auth, or while it was there (the commit finds the row stopped).
  // A false never undoes a true.
  async function stop(accountId, id, event, { interruptRunning, details, mineOnly = false } = {}) {
    const choice = delegatedHostWork && event === "revoke";
    if (choice && typeof interruptRunning !== "boolean") throw interruptRunningRequired();
    const { row, role } = await visible(accountId, id);
    if (mineOnly && role !== "owner") throw notFound();
    // Shown as paused (its owner's account disabled): a pause is refused as for any paused integration, before Auth.
    step(shownPaused(row) ? { ...row, state: "paused", resumeState: row.state } : row, event, now());
    if (event === "revoke" && STOPPED.includes(row.state)) return choice && interruptRunning ? addInterrupt(accountId, row, role, details) : viewOf(row, role);
    const answer = await byActor(accountId, () => manage.changeIntegration(id, { status: event === "pause" ? "paused" : "revoked", ...(choice && interruptRunning ? { interruptRunning: true } : {}) }, accountId));
    const kind = event === "pause" ? "integration_paused" : "integration_revoked";
    const pausedBy = event !== "pause" ? null : PAUSED_BY.includes(answer?.pausedBy) ? answer.pausedBy : role === "owner" ? "owner" : "station";
    const updated = await commit(id, (current) => {
      if (event === "revoke" && STOPPED.includes(current.state)) return null;
      const fields = { ...step(current, event, now()), pausedBy };
      if (event === "revoke") Object.assign(fields, { revokedAt: now() }, choice ? { interruptRunning } : {});
      return { fields, event: { actor: accountId, kind, reason: role, details: { ...seen(), ...(choice ? { interruptRunning } : {}), ...details } } };
    });
    // Another revocation committed first, while this call was at Auth: the choice is still added.
    if (choice && interruptRunning && STOPPED.includes(updated.state) && !updated.interruptRunning) return addInterrupt(accountId, updated, role, details);
    return viewOf(updated, role);
  }

  // Interrupt running tasks (D29), for Interrupt itself and for a revoke that asks for it of an integration that is
  // already stopped (stop): within 24 hours of the revocation, whoever made it, the interrupt that wasn't asked for at
  // first is added. The Portal's own record (Auth is not asked), pushed to the Station; once made it can't be undone,
  // and asking again, even after the 24 hours or the Station's removal, answers the same and changes nothing. A request
  // that would change something is refused for an integration whose Station has been removed: it reads its feed no more,
  // so the record would reach no host. `row` is the integration as the caller saw it and `role` theirs; `details` is
  // added to the event's (the native route's clientId).
  async function addInterrupt(accountId, row, role, details = {}) {
    if (row.interruptRunning) return viewOf(row, role);
    if ((await repository.station(row.stationId))?.status === "removed") throw failure(409, "This integration's Station has been removed, so its running tasks can't be interrupted here.", "station_removed");
    // True when there is something to record. A row that was never dated (revoked before revokedAt) is too late.
    const check = (current) => {
      if (!STOPPED.includes(current.state)) throw failure(409, "Only a revoked integration's running tasks can be interrupted.", "invalid_state");
      if (current.interruptRunning) return false;
      if (!current.revokedAt || now() - Date.parse(current.revokedAt) > DAY) throw failure(409, "Running tasks can be interrupted only within 24 hours of the revocation.", "too_late");
      return true;
    };
    if (!check(row)) return viewOf(row, role);
    const updated = await commit(row.id, (current) => check(current) ? { fields: { interruptRunning: true }, event: { actor: accountId, kind: "integration_interrupt_requested", reason: role, details: { interruptRunning: true, ...details } } } : null);
    return viewOf(updated, role);
  }

  // What following Auth's entry changes on Portal's row: the fields to write, the status event ([transition, kind]) or
  // null, and the settings that changed. Auth is authoritative, so following it is not held back by expiry:
  // transitions are checked at time 0. Who paused it (pausedBy, from Auth's admin pause lock on) goes with a status
  // change, and on its own while both sides have it paused. With status false, only the settings are followed.
  function difference(row, entry, { status = true } = {}) {
    const fields = {};
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() !== new Date(row.expiresAt).getTime()) fields.expiresAt = entry.expiresAt;
    if (entry.quotaPerSecond !== undefined && entry.quotaPerSecond !== row.quotaPerSecond) fields.quotaPerSecond = entry.quotaPerSecond;
    if ((entry.r9Svc ?? null) !== row.r9Svc) fields.r9Svc = entry.r9Svc ?? null;
    if (!status) return { fields, event: null, settings: Object.keys(fields) };
    let event = null;
    if (entry.status === "revoked" && !STOPPED.includes(row.state)) event = ["revoke", "integration_revoked"];
    else if (entry.status === "paused" && row.state !== "paused" && !STOPPED.includes(row.state)) event = ["pause", "integration_paused"];
    else if (entry.status === "active" && row.state === "paused") event = ["resume", "integration_resumed"];
    const pausedBy = entry.status === "paused" && PAUSED_BY.includes(entry.pausedBy) ? entry.pausedBy : null;
    if (!event && row.state === "paused" && entry.status === "paused" && entry.pausedBy !== undefined && pausedBy !== row.pausedBy) fields.pausedBy = pausedBy;
    const settings = Object.keys(fields);
    if (event) Object.assign(fields, step(row, event[0], 0), { pausedBy: event[0] === "pause" ? pausedBy : null }, event[0] === "revoke" ? { revokedAt: now() } : {});
    return { fields, event, settings };
  }

  // Brings Portal's integrations in line with Auth's list of the account's own. Rows are compared first without a
  // lock, so a listing that changes nothing locks nothing. A change of settings alone (expiry, quota, R9 binding) is
  // recorded as integration_reconciled, so the Station's feed carries the new values. The listing is Auth's state when
  // it was fetched: a pause, resume or revocation recorded after listedAfter (the newest event before the fetch; the
  // feed's, or the owner's own call) may be newer, so that row's status and who paused it are left as they are, and
  // only its settings are followed. The feed and the next listing bring the rest.
  async function reconcileIntegrations(listed, listedAfter) {
    for (const entry of listed) {
      const id = entry.clientId;
      let touched = false;
      let row = await repository.integration(id);
      if (!row) {
        if (!(await repository.station(entry.stationId))) {
          log("Integration not reconciled: its Station is unknown to Portal.");
          continue;
        }
        if (!entry.expiresAt) log("Integration reconciled without an expiry at Auth: Portal shows its 30-day default.");
        touched = await appending(async (client) => {
          const expiresAt = entry.expiresAt ?? new Date(now() + 30 * DAY).toISOString();
          if (!(await repository.insertIntegration({ id, ownerAccount: entry.owner, stationId: entry.stationId, kind: "custom_app", name: entry.name, scopes: entry.scopes, quotaPerSecond: entry.quotaPerSecond ?? 200, expiresAt }, client))) return false;
          await repository.appendEvent({ stationId: entry.stationId, integrationId: id, accountId: entry.owner, actor: "system", kind: "integration_reconciled", state: "awaiting_approval" }, client);
          return true;
        });
        if (touched) log("Integration reconciled from Auth: missing in Portal.");
        row = await repository.integration(id);
        if (!row) continue;
      }
      const followed = Object.keys(difference(row, entry).fields).length > 0 && await appending(async (client) => {
        const current = await repository.integrationForUpdate(id, client);
        const newer = ((await repository.latestStatus(id, client)).id ?? 0) > listedAfter;
        const { fields, event, settings } = difference(current, entry, { status: !newer });
        if (!Object.keys(fields).length) return false;
        await repository.updateIntegration(id, fields, client);
        const recorded = { stationId: current.stationId, integrationId: id, accountId: current.ownerAccount, actor: "system", reason: "reconciled" };
        if (event) await repository.appendEvent({ ...recorded, kind: event[1], state: fields.state, details: seen() }, client);
        else {
          const details = { changed: settings, ...Object.fromEntries(settings.map((name) => [name, fields[name]])) };
          await repository.appendEvent({ ...recorded, kind: "integration_reconciled", state: current.state, details }, client);
        }
        return true;
      });
      if (followed) log("Integration reconciled from Auth: changed in Auth.");
      if (touched || followed) changed(entry.stationId);
    }
  }

  async function create(accountId, station, fields, publicJwk, expiresInDays) {
    const stationId = station.id;
    const expiresAt = new Date(now() + expiresInDays * DAY).toISOString();
    const created = await byActor(accountId, () => manage.createIntegration({ owner: accountId, stationId, ...fields, publicJwk, expiresAt, actor: accountId }));
    await appending(async (client) => {
      await repository.insertIntegration({ id: created.clientId, ownerAccount: accountId, stationId, kind: "custom_app", ...fields, expiresAt: created.expiresAt ?? expiresAt }, client);
      await repository.appendEvent({ stationId, integrationId: created.clientId, accountId, actor: accountId, kind: "integration_created", state: "awaiting_approval", details: { scopes: fields.scopes, name: fields.name } }, client);
    });
    changed(stationId);
    return integrationView(await repository.integration(created.clientId), "owner", station);
  }

  return {
    async createChallenge(accountId, originInput) {
      const origin = stationOrigin(originInput);
      await notBuiltInOrigin(origin);
      // A soft limit: check, then insert, so concurrent requests may pass it by a few.
      const since = new Date(now() - 3600000);
      if (await repository.challengesSince(accountId, since) >= CHALLENGES_PER_HOUR) throw new AppError(429, "Too many Station checks. Try again later.");
      const challengeId = ids();
      const value = challengeValue();
      const expiresAt = new Date(now() + CHALLENGE_LIFETIME).toISOString();
      await repository.createChallenge({ id: challengeId, accountId, origin, value, expiresAt, createdAt: now() });
      return { challengeId, origin, value, url: origin + WELL_KNOWN_PATH, expiresAt };
    },

    async registerStation(accountId, { challengeId, reportKey } = {}) {
      // Auth validates the key itself; Portal only refuses what cannot be one, before the challenge is used.
      if (!plainObject(reportKey) || Buffer.byteLength(JSON.stringify(reportKey)) > REPORT_KEY_MAX) {
        throw failure(400, "Send the Station's report key as a JSON object of at most 4 KB.", "report_key");
      }
      if (typeof challengeId !== "string" || !UUID.test(challengeId)) throw expiredChallenge();
      const challenge = await repository.takeChallenge(challengeId, accountId, now());
      if (!challenge) throw expiredChallenge();
      const { origin, value } = challenge;
      await notBuiltInOrigin(origin);
      const proof = await checkProof(origin, value, { fetch: stationFetch });
      if (!proof.ok) {
        log("Station proof of control failed: " + proof.reason + ".");
        throw failure(422, "The Station did not serve the check value at " + origin + WELL_KNOWN_PATH + ".", "proof", { reason: proof.reason });
      }
      const registered = await byActor(accountId, () => manage.registerStation({ origin, owner: accountId, reportKey, actor: accountId }));
      const stale = await appending(async (client) => {
        const stale = await retireStale(client, origin, registered.id);
        await repository.insertStation({ id: registered.id, origin, ownerAccount: accountId, reportClientId: registered.reportClientId, verifiedAt: now() }, client);
        await repository.appendEvent({ stationId: registered.id, accountId, actor: accountId, kind: "station_registered" }, client);
        return stale;
      });
      retired(stale);
      return stationView(await repository.station(registered.id), "owner");
    },

    // The browser's list. With the setting on it also carries the account's notices (D29): the binding attempts the
    // built-in Station refused for it in the last 30 days, the 50 newest, newest first. Each names the R9 account, in its
    // own id, and nothing of the other Agora.Build account the attempt came from or went to.
    async stations(accountId) {
      const fresh = await reconcileWithAuth(accountId);
      const stations = (await repository.stationsFor(accountId)).map((station) => stationView(station, station.role));
      if (!delegatedHostWork) return { stations, stale: !fresh };
      const attempts = await repository.bindingAttemptsFor(accountId, now() - ATTEMPTS_SHOWN_FOR, undefined, { limit: NOTICES_SHOWN });
      const notices = attempts.map(({ r9AccountId, genesisHash, reason, attemptedAt }) => ({ kind: "binding_attempt", accountId: r9AccountId, genesisHash, reason, attemptedAt }));
      return { stations, stale: !fresh, notices };
    },

    // The Station directory for Astation (D29, the setting on; GET /api/v1/stations): a page of the Stations the account
    // can use now and those it lost in the last 30 days, built-in first, then by creation and id. The limit and the cursor
    // are checked before Auth is asked. The list is reconciled with Auth as the browser's is; when Auth is unreachable
    // (503) it is the Portal's last copy and `stale`. `complete` is true only on the last page of a list that is not stale:
    // anything else must not be taken to mean a Station is gone.
    async directory(accountId, { cursor, limit } = {}) {
      if (!delegatedHostWork) throw notFound();
      const size = directoryLimit(limit);
      const after = directoryCursor(cursor);
      const fresh = await reconcileWithAuth(accountId);
      // One more than the page, to know whether there is a next page.
      const rows = await repository.directoryFor(accountId, { lostSince: now() - DIRECTORY_LOST_FOR, after, limit: size });
      const stations = rows.slice(0, size).map(directoryEntry);
      const nextCursor = rows.length > size ? directoryCursorFor(stations.at(-1)) : null;
      return { stations, nextCursor, stale: !fresh, complete: fresh && nextCursor === null };
    },

    async members(accountId, stationId) {
      notBuiltIn(await usable(accountId, stationId));
      const answer = await byActor(accountId, () => manage.members(stationId, accountId));
      return { owner: answer.owner, members: (answer.members || []).map(({ account, addedAt }) => ({ account, addedAt })) };
    },

    async share(accountId, stationId, member) {
      memberAccount(member);
      const station = await ownStation(accountId, stationId);
      if (member === station.ownerAccount) throw failure(400, "The owner already has this Station.", "account");
      await byActor(accountId, () => manage.addMember(stationId, member, accountId));
      const added = await appending(async (client) => {
        if (!(await repository.addMember(stationId, member, accountId, now(), client))) return false;
        await repository.appendEvent({ stationId, accountId: member, actor: accountId, kind: "member_added" }, client);
        return true;
      });
      if (added) changed(stationId);
    },

    // The owner removes anyone; a member removes only themself. Auth removes the member and revokes their integrations
    // on the Station; Portal follows in one transaction, recording the removal only when it had the member.
    async unshare(accountId, stationId, member) {
      memberAccount(member);
      const station = notBuiltIn(await usable(accountId, stationId));
      if (station.role !== "owner" && member !== accountId) throw ownerOnly();
      await byActor(accountId, () => manage.removeMember(stationId, member, accountId));
      const wrote = await appending(async (client) => {
        const removed = await repository.removeMember(stationId, member, accountId, now(), client);
        const revoked = await revokeOn(client, stationId, (row) => row.ownerAccount === member, { actor: accountId, reason: "member_removed" });
        if (removed) await repository.appendEvent({ stationId, accountId: member, actor: accountId, kind: "member_removed" }, client);
        return removed || revoked > 0;
      });
      if (wrote) changed(stationId);
    },

    async removeStation(accountId, stationId) {
      const station = await ownStation(accountId, stationId);
      await byActor(accountId, () => manage.removeStation(stationId, accountId));
      await appending(async (client) => {
        await repository.markStationRemoved(stationId, now(), client);
        await revokeOn(client, stationId, () => true, { actor: accountId, reason: "station_removed" });
        await repository.appendEvent({ stationId, accountId: station.ownerAccount, actor: accountId, kind: "station_removed" }, client);
      });
      changed(stationId);
    },

    // A 5-minute station.read token for the browser to send to a Station this account owns or belongs to.
    async readToken(accountId, idToken, stationId) {
      const station = await usable(accountId, stationId);
      if (!idToken) throw new AppError(401, "Sign in again to read this Station's details.");
      try {
        const { accessToken, expiresIn } = await exchange(idToken, station.origin);
        return { accessToken, expiresIn, origin: station.origin };
      } catch (error) {
        if (!(error instanceof TokenError)) throw error;
        log("Station read token refused: " + error.reason + ".");
        if (error.status === 503) throw failure(503, "Auth is unavailable. Try again shortly.", "unavailable");
        throw failure(403, "Auth did not allow reading this Station.", "exchange");
      }
    },

    // On a built-in Station: only while Agora.Build has integrations on there, and within the account's plan limit
    // (Basic 4, Premium 10, Principal and Fellow none). Custom Stations are never capped.
    async createIntegration(accountId, { stationId, name, scopes = [], publicJwk, quotaPerSecond = 200, expiresInDays = 30 } = {}, { plan = "basic" } = {}) {
      const fields = { name: integrationName(name), scopes: integrationScopes(scopes), quotaPerSecond: quota(quotaPerSecond) };
      expiryDays(expiresInDays);
      publicKey(publicJwk);
      const station = await usable(accountId, stationId);
      if (!station.builtIn) return create(accountId, station, fields, publicJwk, expiresInDays);
      if (!station.integrationsEnabled) throw failure(409, NOT_SUPPORTED, "not_supported");
      return oneAtATime(accountId + " " + station.id, async () => {
        await underPlanLimit(accountId, station.id, plan);
        return create(accountId, station, fields, publicJwk, expiresInDays);
      });
    },

    // The account's own integrations (reconciled with Auth's list of them) and, read from Portal only, the others on
    // custom Stations it owns, which it may pause or revoke. The same for a browser session and an app's token.
    async integrations(accountId) {
      let listed;
      const listedAfter = await repository.latestEventId();
      try {
        listed = await manage.integrations(accountId);
      } catch (error) {
        if (!(error instanceof ManageError) || fromManage(error).status !== 503) throw fromManage(error);
        log("Integration list served from Portal: Auth " + error.code + ".");
      }
      if (listed) await reconcileIntegrations(listed, listedAfter);
      const views = [];
      for (const row of await repository.integrationsFor(accountId)) views.push(await viewOf(row, "owner"));
      for (const station of await repository.stationsFor(accountId)) {
        if (station.role !== "owner") continue;
        for (const row of await repository.integrationsOnStation(station.id)) {
          if (row.ownerAccount !== accountId) views.push(integrationView(row, "station_owner", station, await revocationHostsOf(row)));
        }
      }
      return { integrations: views, stale: !listed };
    },

    // Called for a native app holding integrations:approve for the owner, so only the owner's integrations exist here.
    async approve(accountId, id, { r9Svc } = {}) {
      const row = typeof id === "string" && id ? await repository.integration(id) : null;
      if (!row || row.ownerAccount !== accountId) throw notFound();
      if (typeof r9Svc !== "string" || !R9_SVC.test(r9Svc)) throw failure(400, "Send the R9 service fingerprint as 64 lower-case hex characters.", "r9_svc");
      step(row, "approve", now());
      await byActor(accountId, () => manage.changeIntegration(id, { r9Svc }, accountId));
      // A pause committed in between fails the re-check after Auth stored r9Svc; the owner approves again after resuming.
      const updated = await commit(id, (current) => ({
        fields: { ...step(current, "approve", now()), r9Svc, approvedBy: accountId, approvedAt: now() },
        event: { actor: accountId, kind: "integration_approved" }
      }));
      return viewOf(updated, "owner");
    },

    pause: (accountId, id) => stop(accountId, id, "pause"),
    // `interruptRunning` is read only with the setting on, where it is required (D29).
    revoke: (accountId, id, { interruptRunning } = {}) => stop(accountId, id, "revoke", { interruptRunning }),

    // Astation's revoke, for the owner's own integrations only, as approve is (the setting on only): recorded with the
    // app as the client.
    async revokeNative(accountId, id, { interruptRunning, clientId } = {}) {
      if (!delegatedHostWork) throw notFound();
      return stop(accountId, id, "revoke", { interruptRunning, mineOnly: true, details: { clientId } });
    },

    // Interrupt running tasks (D29): within 24 hours of the revocation, the owner or the custom Station's owner adds the
    // interrupt they didn't ask for at first (addInterrupt, which a revoke that asks for it uses too). The setting on only.
    async interrupt(accountId, id) {
      if (!delegatedHostWork) throw notFound();
      const { row, role } = await visible(accountId, id);
      return addInterrupt(accountId, row, role);
    },

    // The owner only, never while Agora.Build has the owner's account disabled, and never out of an Agora.Build admin's
    // pause, which only an admin lifts on the admin site. Auth holds the lock too: its own 409 admin_paused means the
    // Portal has not read that change yet. An admin's pause the feed applied after Auth accepted this resume is newer
    // than it, so the row keeps it. Each 409 admin_paused, the Portal's own included (a lift it missed then heals), asks
    // the stack to read Auth's change feed now.
    async resume(accountId, id) {
      const row = await owned(accountId, id);
      if (row.ownerDisabledAt != null && effectiveState(row, now()) === "paused") throw ownerDisabled();
      try {
        if (row.state === "paused" && row.pausedBy === "admin") throw adminPaused();
        step(row, "resume", now());
        await byActor(accountId, () => manage.changeIntegration(id, { status: "active" }, accountId));
        const updated = await commit(id, (current) => {
          if (current.state === "paused" && current.pausedBy === "admin") throw adminPaused();
          return { fields: { ...step(current, "resume", now()), pausedBy: null }, event: { actor: accountId, kind: "integration_resumed", reason: "owner", details: seen() } };
        });
        return viewOf(updated, "owner");
      } catch (error) {
        if (error.details?.code === "admin_paused") authChanged();
        throw error;
      }
    },

    // Renewing an expired integration on a built-in Station brings one back, so it counts as adding one (plan limit,
    // where the expired one is not counted yet); renewing a live one never changes the count. Every renewal there runs
    // one at a time with the account's creations on that Station and decides "expired" only once it holds that turn,
    // so a creation racing a renewal just before expiry waits and then counts the renewed one.
    async renew(accountId, id, { expiresInDays } = {}, { plan = "basic" } = {}) {
      const row = await owned(accountId, id);
      expiryDays(expiresInDays);
      step(row, "renew", now());
      const renewing = async () => {
        const changedAt = await byActor(accountId, () => manage.changeIntegration(id, { expiresAt: new Date(now() + expiresInDays * DAY).toISOString() }, accountId));
        const updated = await commit(id, (current) => {
          step(current, "renew", now());
          return { fields: { expiresAt: changedAt.expiresAt }, event: { actor: accountId, kind: "integration_renewed", details: { expiresAt: changedAt.expiresAt } } };
        });
        return viewOf(updated, "owner");
      };
      if (!(await repository.station(row.stationId))?.builtIn) return renewing();
      return oneAtATime(accountId + " " + row.stationId, async () => {
        const current = await repository.integration(id);
        if (!current) throw notFound();
        step(current, "renew", now());
        if (effectiveState(current, now()) === "expired") await underPlanLimit(accountId, row.stationId, plan);
        return renewing();
      });
    },

    // Allowed on an expired integration, as Auth allows it: the owner may tune it before renewing.
    async settings(accountId, id, { quotaPerSecond } = {}) {
      const row = await owned(accountId, id);
      quota(quotaPerSecond);
      notRevoked(row);
      const answer = await byActor(accountId, () => manage.changeIntegration(id, { quotaPerSecond }, accountId));
      const updated = await commit(id, (current) => {
        notRevoked(current);
        return { fields: { quotaPerSecond: answer.quotaPerSecond }, event: { actor: accountId, kind: "integration_settings_changed", details: { quotaPerSecond: answer.quotaPerSecond } } };
      });
      return viewOf(updated, "owner");
    },

    // Allowed on an expired integration, as Auth allows it: the owner may rotate before renewing.
    async rotateKey(accountId, id, { publicJwk } = {}) {
      const row = await owned(accountId, id);
      publicKey(publicJwk);
      notRevoked(row);
      const { kid, overlapEndsAt } = await byActor(accountId, () => manage.addKey(id, publicJwk, accountId));
      await commit(id, (current) => {
        notRevoked(current);
        return { event: { actor: accountId, kind: "integration_key_added", details: { kid, overlapEndsAt } } };
      });
      return { kid, overlapEndsAt };
    },

    // An authenticated Station's report about one of its integrations. Only these reports move an integration into
    // waiting_for_host, ready or revoked (Portal never sets ready itself); `error` records lastError and keeps the state.
    // With the setting on, a report with a reportId is one of the two revocation reports or one of the two binding reports
    // (identifiedReport).
    async report(clientId, body) {
      const station = await reportingStation(clientId);
      const parsed = reportBody(body, { delegated: delegatedHostWork, now: now() });
      if (parsed.reportId !== undefined) return identifiedReport(station, parsed);
      const { integrationId, state, reason } = parsed;
      const row = typeof integrationId === "string" && integrationId ? await repository.integration(integrationId) : null;
      // Integrations of other Stations get the same answer as unknown ones.
      if (!row || row.stationId !== station.id) throw notFound();
      const apply = (current) => {
        const event = { actor: "station", kind: "integration_reported", reason };
        if (state === "error") {
          if (current.state === "revoked") throw failure(409, "This integration is revoked and cannot take that action.", "invalid_state");
          if (current.lastError === reason) return null;
          return { fields: { lastError: reason }, event };
        }
        if (current.state === state || (current.state === "paused" && current.resumeState === state)) return null;
        return { fields: { ...transition(current, "report:" + state, now()), lastError: null }, event };
      };
      // The Station made this change itself, so it is not pushed back to it.
      let updated;
      try {
        apply(row);
        updated = await commit(row.id, apply, { push: false });
      } catch (error) {
        throw shownRefusal(error, row);
      }
      return reportAnswer(updated, station);
    },

    // This Station's changes after `cursor`, oldest first, each with its integration's current settings. From cursor 0
    // the answer also lists every integration on the Station, so a Station starting fresh has a snapshot.
    //
    // With the setting on and `checkpoint` (D29, ?checkpoint=1) the answer is the Station's state at one exact cursor
    // instead, whatever cursor was sent (its shape is still checked, and "ahead" doesn't apply: the cursor is the Station's
    // own newest event). Resuming at it with the feed delivers every later change and no earlier one. With the setting
    // off the parameter is ignored: the answer is today's.
    async changes(clientId, cursorInput, { checkpoint = false } = {}) {
      const station = await reportingStation(clientId);
      const cursor = feedCursor(cursorInput);
      if (delegatedHostWork && checkpoint) return checkpointOf(station);
      // A cursor this Station's history never reached (the Portal's database was restored from an older backup) can't
      // be served from: the Station must start again from cursor 0, whose snapshot is the current state.
      if (cursor > 0 && cursor > await repository.latestCursor(station.id)) throw failure(409, "This cursor is ahead of the Portal's history. Read the feed again from cursor 0.", "cursor_ahead");
      const events = await repository.changesSince(station.id, cursor, FEED_LIMIT);
      const rows = await repository.integrationsOnStation(station.id);
      const at = now();
      const current = new Map(rows.map((row) => [row.id, row]));
      const changes = events.map(({ id, at: when, integrationId, accountId, kind, state, reason, details }) => {
        // An admin's disabling or enabling of an account: the admin and their reason stay in the Portal's event. Served as
        // recorded, as Auth does, even if the setting has been turned off since. The baseline and the incomplete signal
        // name no account.
        if (STATION_ACCOUNT_KINDS.includes(kind)) return { id, at: when, integrationId: null, kind, state: null, reason: AGORA_BUILD, account: ACCOUNT_KINDS.includes(kind) ? accountId : null };
        // Agora.Build's changes say only that: the admin and their reason stay in the Portal's event (spec §3.3.4).
        const masked = Object.hasOwn(OWNER_EVENTS, kind);
        const change = { id, at: when, integrationId, kind: masked ? OWNER_EVENTS[kind] : kind, state, reason: masked || details?.admin === true ? AGORA_BUILD : reason };
        // A revocation recorded without the choice (before the setting) means "don't interrupt"; the later interrupt is one.
        if (delegatedHostWork && kind === "integration_revoked") change.interruptRunning = details?.interruptRunning === true;
        if (delegatedHostWork && kind === "integration_interrupt_requested") change.interruptRunning = true;
        const row = integrationId ? current.get(integrationId) : null;
        if (row) change.integration = feedIntegration(row, at, delegatedHostWork);
        return change;
      });
      const answer = { changes, cursor: events.length ? events.at(-1).id : cursor };
      if (cursor === 0) {
        answer.integrations = rows.map((row) => ({ id: row.id, ...feedIntegration(row, at, delegatedHostWork) }));
        // A built-in Station's snapshot includes every account disabled now (design III.5), as the availability table has it.
        if (delegatedHostWork && station.builtIn) answer.disabledAccounts = await repository.disabledAccountList();
      }
      return answer;
    },

    // The built-in Stations as Auth lists them naming no account (GET /manage/v1/built-in-stations, spec §3.3.4), so
    // their report clients are known before anyone signs in. Only the built-in part of reconcile runs: nothing is
    // removed or revoked on absence. Never throws; returns whether it synced. Run by the stack at ready(), hourly, and
    // a minute after a failure.
    async syncBuiltIn() {
      try {
        const listed = (await manage.builtInStations()).filter((entry) => entry.builtIn === true);
        const known = new Set(listed.map((entry) => entry.id));
        for (const station of await repository.builtInStations()) {
          if (!known.has(station.id)) log("Built-in Station absent from Auth's listing: left as it is.");
        }
        for (const entry of listed) await reconcileBuiltIn(entry);
        return true;
      } catch (error) {
        log("Built-in Station sync failed: " + (error instanceof ManageError ? error.code : error.code || "error") + ".");
        return false;
      }
    },

    // One entry of Auth's change feed (GET /manage/v1/integration-changes, read by auth-changes.mjs): Auth's change to
    // an integration's access, followed on the Portal's row (authEffect), recorded in integration_events with the
    // account that made it and its reason (an Agora.Build admin and the reason they gave; spec §3.3.4), then appended
    // to the Station's feed and pushed to it. Changes the Portal made itself (an account's pause, resume or revoke
    // through these routes) are already recorded and are skipped, as are integrations the Portal does not know (their
    // owner's next listing brings them in). Each entry is applied once: its cursor and time are kept in the event's
    // details. Returns "applied" or "skipped"; only a database failure throws, so the reader reads it again.
    //
    // With the setting on (D29) an admin's interrupt_requested entry is followed the same way, and an account-level entry
    // (account_disabled, account_enabled or accounts_baseline; no integration) is applied once, as the Portal's mode says,
    // in the read pass `pass` ({ epoch }, from the reader) and only in that pass's epoch (accountChange). With it off,
    // such an entry is skipped like any other kind this Portal does not follow, and first moves the Portal to waiting
    // (accountsWait), as does one that is malformed or a person's own with the setting on.
    //
    // The feed may be read after the Portal already followed a newer change (an owner's listing, the owner's own call,
    // or a revocation). Such an entry is still recorded, and a pause or revocation still applies: a pause that is out
    // of date errs on the safe side, and the owner's next listing follows Auth again. A resume applies only if it is not older
    // than the newest pause, resume or revocation the row has recorded (repository.latestStatus); otherwise the row
    // keeps its state and the event says so (details.superseded), so a resume read late never undoes a newer pause
    // (Ruling R-A). Auth's clock and the Portal's are compared here, so they are kept in sync.
    async applyAuthChange(entry, pass) {
      // An account-level entry this Portal skips (the setting is off, or the entry is malformed or a person's own) leaves
      // it unable to follow Auth's accounts: whatever the entry's shape, a kind of this sort is one (D29, accountsWait).
      const accountLevel = plainObject(entry) && ACCOUNT_LEVEL_KINDS.includes(entry.kind);
      if (!changeEntry(entry, delegatedHostWork)) {
        if (accountLevel) await accountsWait(pass);
        log("Auth change skipped: not a change entry.");
        return "skipped";
      }
      const ours = !OWNER_KINDS.includes(entry.kind) && entry.admin !== true && entry.actorAccountId !== null;
      if (ours) {
        if (accountLevel) await accountsWait(pass);
        return "skipped";
      }
      const actor = typeof entry.actorAccountId === "string" && ACCOUNT_ID.test(entry.actorAccountId) ? entry.actorAccountId : SYSTEM;
      const reason = typeof entry.reason === "string" && entry.reason ? [...entry.reason].slice(0, AUTH_REASON_MAX).join("") : null;
      if (ACCOUNT_LEVEL_KINDS.includes(entry.kind)) return accountChange(entry, actor, reason, pass);
      if (!(await repository.integration(entry.clientId))) {
        log("Auth change skipped: the integration is unknown to Portal.");
        return "skipped";
      }
      const applied = await appending(async (client) => {
        const row = await repository.integrationForUpdate(entry.clientId, client);
        if (!row || await repository.authChangeApplied(row.id, entry.cursor, entry.at, client)) return null;
        const effect = authEffect(row, entry, { delegated: delegatedHostWork });
        let superseded = false;
        if (entry.kind === "resumed" && Object.keys(effect.fields).length) {
          const { at: latest } = await repository.latestStatus(row.id, client);
          superseded = latest !== null && Date.parse(latest) > Date.parse(entry.at);
        }
        const fields = superseded ? {} : effect.fields;
        if (Object.keys(fields).length) await repository.updateIntegration(row.id, fields, client);
        const after = { ...row, ...fields };
        await repository.appendEvent({
          stationId: row.stationId, integrationId: row.id, accountId: row.ownerAccount, actor, kind: effect.kind,
          state: effectiveState(after, 0), reason,
          details: {
            authCursor: entry.cursor, authAt: entry.at, admin: entry.admin === true,
            // The choice the entry states, as the Portal's own revocation and interrupt record it (D29).
            ...(delegatedHostWork && entry.kind === "revoked" ? { interruptRunning: entry.interruptRunning === true } : {}),
            ...(delegatedHostWork && entry.kind === "interrupt_requested" ? { interruptRunning: true } : {}),
            ...(after.state === "paused" && PAUSED_BY.includes(after.pausedBy) ? { pausedBy: after.pausedBy } : {}),
            ...(superseded ? { superseded: true } : {})
          }
        }, client);
        return { stationId: row.stationId, superseded };
      });
      if (!applied) return "skipped";
      if (applied.superseded) log("Auth change recorded without its state change: the Portal has a newer one.");
      changed(applied.stationId);
      return "applied";
    },

    // The reader of Auth's feed (auth-changes.mjs) starts it over from its first entry: a first start, a reset (an
    // operator emptied the cursor), or Auth's cursor is behind the Portal's (Auth was restored). With the setting on (D29),
    // in one transaction: the epoch is raised (fencing every read pass that began before), the Portal starts rebuilding
    // its view of the accounts from the feed's first entry into tables of its own (the live table is left alone), the
    // cursor is emptied with it, and the view is no longer complete; if the Stations were told it was (or are owed the
    // news), each active built-in Station gets one accounts_incomplete change, pushed after the commit. Returns the new
    // epoch; with the setting off it does nothing.
    async accountsStartingOver() {
      if (!delegatedHostWork) return undefined;
      const { epoch, told } = await appending(async (client) => {
        const sync = await repository.accountSync(client);
        const raised = await repository.startAccountsOver(client);
        return { epoch: raised, told: await becameIncomplete(sync, "rebuilding", client) };
      });
      toldIncomplete(told);
      return epoch;
    },

    // The reader found Auth's cursor moved by a Portal image from before migration 006 (auth-changes.mjs, the guard): that
    // image skips account-level entries unrecorded, so what this Portal holds may miss some. With the setting on (D29) the
    // answer is true, and the reader starts over (accountsStartingOver). With it off, the Portal moves to waiting as a
    // skipped entry makes it (waitUnheard), takes the cursor as it is, and answers false: the reader reads on from it, and
    // logs nothing new.
    async accountsForeignCursor() {
      if (delegatedHostWork) return true;
      await appending(async (client) => {
        await waitUnheard(client);
        await repository.acceptAuthChangeCursor(client);
      });
      return false;
    },

    // A read pass of Auth's feed reached its end (its last page wasn't full). With the setting on (D29) and the pass's
    // epoch still current, in one transaction:
    // * rebuilding, the Portal adopts the rebuild: for each account whose state differs from the live table (one in
    //   either only included; an account with no row is enabled), each active built-in Station gets one account_disabled
    //   or account_enabled change; the live table and applied entries become the rebuild's; if the rebuild applied a
    //   baseline, it is recorded, the view is complete and each Station gets one accounts_baseline change (otherwise the
    //   next baseline applied live completes it); and the Portal is live.
    // * waiting, the Stations get the accounts_incomplete change they are owed, if they are, once, and the WAITING line is
    //   logged unless this pass said it, at most once an hour (stillWaiting).
    // * live, there is nothing to do.
    // The Stations are pushed after the commit, and a failure rolls all of it back, so the next read does it. Several
    // replicas may call it at once: the event lock serializes them, and only the first finds anything to do. Adopting
    // logs the number of accounts that changed, never which. Returns whether this call did something; a stale pass, or
    // the setting off, does nothing.
    async accountsCaughtUp(pass) {
      if (!delegatedHostWork) return false;
      const done = await appending(async (client) => {
        const sync = await repository.accountSync(client);
        try {
          fenced(sync, pass);
        } catch (error) {
          if (error.code === "stale_pass") return null;
          throw error;
        }
        if (sync.mode === "waiting") return { waiting: true, told: sync.incompleteOwed ? await becameIncomplete(sync, "waiting", client) : null };
        if (sync.mode !== "rebuilding") return null;
        const differences = await repository.availabilityDifferences(client);
        await repository.adoptRebuild(client);
        const active = await repository.builtInStations(client);
        for (const { account, disabled, cursor, at } of differences) {
          await tell(active, {
            kind: disabled ? "account_disabled" : "account_enabled", accountId: account,
            details: { ...(cursor === null ? {} : { authCursor: cursor, authAt: at }), admin: false, rebuilt: true }
          }, client);
        }
        let completed = false;
        if (sync.rebuildBaseline) {
          await repository.setBaseline(sync.rebuildBaseline.cursor, sync.rebuildBaseline.at, client);
          completed = (await repository.markBaselineComplete(client)) !== null;
          if (completed) await tell(active, { kind: BASELINE_KIND, details: { authCursor: sync.rebuildBaseline.cursor, authAt: sync.rebuildBaseline.at, admin: false } }, client);
        }
        await repository.setAccountsMode("live", client);
        return { stations: differences.length || completed ? active : [], changed: differences.length, completed };
      });
      if (done === null) return false;
      if (done.waiting) {
        toldIncomplete(done.told);
        stillWaiting(pass);
        return done.told !== null;
      }
      log("Account availability rebuilt: " + accountsCount(done.changed) + " changed" + (done.completed ? "; complete." : "."));
      for (const station of done.stations) changed(station.id);
      return true;
    },

    notify: (stationId) => changed(stationId),

    // For tests: resolves once no push is in flight.
    async _pushesIdle() {
      while (pushes.size) await Promise.all([...pushes.values()].map((entry) => entry.done));
    },

    // Newest first. The reader's own changes show as "you". An Agora.Build admin's change shows as Agora.Build's: the
    // admin's account and their reason stay in the event, for the audit (spec §3.3.4). The custom Station's owner sees
    // the owner's account being disabled or enabled as Agora.Build's pause and lift (OWNER_EVENTS).
    async history(accountId, id) {
      const { row, role } = await visible(accountId, id);
      const events = await repository.eventsFor(row.id);
      return { events: events.map(({ at, kind, state, reason, actor, details }) => {
        if (role === "station_owner" && Object.hasOwn(OWNER_EVENTS, kind)) return { at, kind: OWNER_EVENTS[kind], state, reason: null, actor: AGORA_BUILD };
        return details?.admin === true ? { at, kind, state, reason: null, actor: AGORA_BUILD } : { at, kind, state, reason, actor: actor === accountId ? "you" : actor };
      }) };
    }
  };
}
