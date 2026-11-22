// All SQL for Stations, members, challenges, integrations and the event log / change feed. Parameterised throughout.

const updatable = {
  state: "state",
  resumeState: "resume_state",
  r9Svc: "r9_svc",
  quotaPerSecond: "quota_per_second",
  expiresAt: "expires_at",
  approvedBy: "approved_by",
  approvedAt: "approved_at",
  lastError: "last_error",
  pausedBy: "paused_by",
  ownerDisabledAt: "owner_disabled_at",
  revokedAt: "revoked_at",
  interruptRunning: "interrupt_running",
  revocationOutcome: "revocation_outcome",
  revocationPendingHosts: "revocation_pending_hosts"
};

function iso(value) {
  return value === null || value === undefined ? value : new Date(value).toISOString();
}

function when(now) {
  return new Date(now === undefined ? Date.now() : now);
}

function cursorNumber(cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("Cursor must be a non-negative integer.");
  return cursor;
}

// Auth's change feed cursor: opaque to the Portal, base64url as Auth hands it out.
export const AUTH_CURSOR = /^[A-Za-z0-9_-]{1,64}$/;

// A cursor of Auth's feed that is kept as a key: a missing or malformed one is a mistake, not "no cursor".
function authCursorOf(cursor) {
  if (typeof cursor !== "string" || !AUTH_CURSOR.test(cursor)) throw new TypeError("An Auth change cursor is 1 to 64 base64url characters.");
  return cursor;
}

// A time that has to be given, as a Date. when() reads a missing time as now, which would make a key or a window
// something the caller never said.
function timeOf(value, name) {
  const date = value === undefined || value === null ? null : new Date(value);
  if (date === null || Number.isNaN(date.getTime())) throw new TypeError(name + " must be a time.");
  return date;
}

// A time as toISOString writes it, which is all the Portal keeps in an event's details (authAt, which applyAuthChange
// takes only in that form, and seenAt): latestStatus casts only such strings, so a stored value can't make it fail.
const ISO_TIME = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$";
const STATUS_KINDS = ["integration_paused", "integration_resumed", "integration_revoked"];

function stationRow(row) {
  return {
    id: row.id,
    origin: row.origin,
    ownerAccount: row.owner_account,
    reportClientId: row.report_client_id,
    status: row.status,
    createdAt: iso(row.created_at),
    verifiedAt: iso(row.verified_at),
    removedAt: iso(row.removed_at),
    builtIn: row.built_in === true,
    access: row.access ?? "members",
    integrationsEnabled: row.integrations_enabled !== false,
    name: row.name ?? null
  };
}

function integrationRow(row) {
  return {
    id: row.id,
    ownerAccount: row.owner_account,
    stationId: row.station_id,
    kind: row.kind,
    name: row.name,
    scopes: row.scopes,
    state: row.state,
    resumeState: row.resume_state,
    r9Svc: row.r9_svc,
    quotaPerSecond: row.quota_per_second,
    expiresAt: iso(row.expires_at),
    approvedBy: row.approved_by,
    approvedAt: iso(row.approved_at),
    lastError: row.last_error,
    pausedBy: row.paused_by ?? null,
    ownerDisabledAt: iso(row.owner_disabled_at) ?? null,
    revokedAt: iso(row.revoked_at) ?? null,
    interruptRunning: row.interrupt_running === true,
    revocationOutcome: row.revocation_outcome ?? null,
    revocationPendingHosts: row.revocation_pending_hosts ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function eventRow(row) {
  return {
    id: Number(row.id),
    at: iso(row.at),
    integrationId: row.integration_id,
    // An account-level event such as accounts_baseline names no account.
    accountId: row.account_id ?? null,
    kind: row.kind,
    state: row.state,
    reason: row.reason,
    details: row.details
  };
}

// A built-in Station's recorded binding. `accountId` is the Agora.Build account that owns it (the report's `account`) and
// `r9AccountId` the R9 account (the report's `accountId`). The version is a bigint: it is read back as a number, which is
// exact because only a safe integer is saved.
function bindingRow(row) {
  return {
    stationId: row.station_id,
    r9AccountId: row.r9_account_id,
    genesisHash: row.genesis_hash,
    accountId: row.account_id,
    bindingId: row.binding_id,
    version: Number(row.version),
    bindingState: row.binding_state,
    reportId: row.report_id,
    updatedAt: iso(row.updated_at)
  };
}

function bindingAttemptRow(row) {
  return {
    stationId: row.station_id,
    reportId: row.report_id,
    accountId: row.account_id,
    r9AccountId: row.r9_account_id,
    genesisHash: row.genesis_hash,
    reason: row.reason,
    attemptedAt: iso(row.attempted_at),
    recordedAt: iso(row.recorded_at)
  };
}

export function createRepository(db) {
  const run = (client, text, values) => (client || db.pool).query(text, values);

  return {
    async createChallenge({ id, accountId, origin, value, expiresAt, createdAt }, client) {
      await run(client, "INSERT INTO station_challenges (id, account_id, origin, value, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [id, accountId, origin, value, when(expiresAt), when(createdAt)]);
    },

    async takeChallenge(id, accountId, now, client) {
      const { rows } = await run(client, "UPDATE station_challenges SET used_at = $3 WHERE id = $1 AND account_id = $2 AND used_at IS NULL AND expires_at > $3 RETURNING origin, value", [id, accountId, when(now)]);
      return rows[0] ? { origin: rows[0].origin, value: rows[0].value } : null;
    },

    async challengesSince(accountId, since, client) {
      const { rows } = await run(client, "SELECT count(*)::int AS n FROM station_challenges WHERE account_id = $1 AND created_at > $2", [accountId, when(since)]);
      return rows[0].n;
    },

    async insertStation({ id, origin, ownerAccount = null, reportClientId, verifiedAt, builtIn = false, integrationsEnabled = true, name = null }, client) {
      const { rowCount } = await run(client,
        "INSERT INTO stations (id, origin, owner_account, report_client_id, status, verified_at, built_in, access, integrations_enabled, name) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING",
        [id, origin, ownerAccount, reportClientId, when(verifiedAt), builtIn, builtIn ? "any_account" : "members", integrationsEnabled, name]);
      return rowCount > 0;
    },

    async station(id, client) {
      const { rows } = await run(client, "SELECT * FROM stations WHERE id = $1", [id]);
      return rows[0] ? stationRow(rows[0]) : null;
    },

    // The active Station at an origin, locked for the caller's transaction.
    async activeStationAt(origin, client) {
      if (!client) throw new TypeError("activeStationAt needs a transaction client.");
      const { rows } = await client.query("SELECT * FROM stations WHERE origin = $1 AND status = 'active' FOR UPDATE", [origin]);
      return rows[0] ? stationRow(rows[0]) : null;
    },

    async stationByReportClient(clientId, client) {
      const { rows } = await run(client, "SELECT * FROM stations WHERE report_client_id = $1 AND status = 'active'", [clientId]);
      return rows[0] ? stationRow(rows[0]) : null;
    },

    // The active Stations this account may use: every built-in Station (role built_in), its own (owner) and those
    // shared with it (member). Built-in Stations come first, as in Auth's listing.
    async stationsFor(accountId, client) {
      const { rows } = await run(client,
        "SELECT s.*, CASE WHEN s.built_in THEN 'built_in' WHEN s.owner_account = $1 THEN 'owner' ELSE 'member' END AS role FROM stations s WHERE s.status = 'active' AND (s.built_in OR s.owner_account = $1 OR EXISTS (SELECT 1 FROM station_members m WHERE m.station_id = s.id AND m.account_id = $1 AND m.removed_at IS NULL)) ORDER BY s.built_in DESC, s.created_at, s.id",
        [accountId]);
      return rows.map((row) => ({ ...stationRow(row), role: row.role }));
    },

    // The Station directory of one account (GET /api/v1/stations): the active Stations it can use now, as stationsFor has
    // them, and the ones it lost at or after `lostSince`, each saying so. Rows are in the directory's order, the
    // built-in Stations first, then by createdAt and id, and carry stationRow's fields with `role`, `membership` and
    // `membershipEndedAt` added:
    //   - the built-in Station: role built_in, no membership (it has no members), and for every account: a removed one is
    //     listed as lost too, with status removed, for the window;
    //   - a Station the account owns: role owner, no membership (an owner is not a member), even with a stray member row;
    //   - any other Station it has a member row on: role member; membership "current" while a row of it is current,
    //     and "ended" with the latest end otherwise.
    // A Station is lost to the account when it is removed (status removed, removedAt: for an owner, or a member, current or
    // not) or its membership ended (status active, membership ended). The loss is dated when the account lost it: the
    // removal, or for a member whose membership ended, the earlier of the end and the removal. A Station removed after a
    // member left it is still listed as removed, for as long as that departure is inside the window; for one with both,
    // the removal is the status and the end is still given.
    //
    // Paging is a keyset on (built_in DESC, createdAt, id): `after` is { builtIn, createdAt, id } of the last row of the
    // page before (as that row gave them), or absent for the first page. The order and the keyset use createdAt as the
    // rows show it, to the millisecond, so a cursor made from a row's own createdAt continues exactly after it however
    // many microseconds the stored time has. The query asks for `limit + 1` rows: more than `limit` rows means there is a
    // next page, which the caller cuts off.
    async directoryFor(accountId, { lostSince, after = null, limit } = {}, client) {
      const since = timeOf(lostSince, "lostSince");
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a whole number, 1 or more.");
      const values = [accountId, since, limit + 1];
      let keyset = "";
      if (after !== null && after !== undefined) {
        if (typeof after !== "object" || Array.isArray(after) || typeof after.builtIn !== "boolean" || typeof after.id !== "string") throw new TypeError("after must be { builtIn, createdAt, id } of a listed Station.");
        values.push(after.builtIn, timeOf(after.createdAt, "after.createdAt"), after.id);
        keyset = " WHERE (d.built_in < $4 OR (d.built_in = $4 AND (d.created_ms, d.id) > ($5::timestamptz, $6::text)))";
      }
      const { rows } = await run(client,
        "WITH mine AS (SELECT station_id, bool_or(removed_at IS NULL) AS is_current, max(removed_at) AS ended_at FROM station_members WHERE account_id = $1 GROUP BY station_id), " +
        "listed AS (SELECT s.*, date_trunc('milliseconds', s.created_at) AS created_ms, " +
        "CASE WHEN s.built_in THEN 'built_in' WHEN s.owner_account = $1 THEN 'owner' ELSE 'member' END AS role, " +
        "CASE WHEN s.built_in OR s.owner_account = $1 THEN NULL WHEN m.is_current THEN 'current' ELSE 'ended' END AS membership, " +
        "CASE WHEN s.built_in OR s.owner_account = $1 OR m.is_current THEN NULL ELSE m.ended_at END AS membership_ended_at " +
        "FROM stations s LEFT JOIN mine m ON m.station_id = s.id WHERE CASE " +
        "WHEN s.built_in THEN (s.status = 'active' OR (s.status = 'removed' AND s.removed_at >= $2)) " +
        "WHEN s.owner_account = $1 THEN (s.status = 'active' OR (s.status = 'removed' AND s.removed_at >= $2)) " +
        "WHEN m.station_id IS NULL THEN false " +
        "WHEN s.status = 'active' THEN (m.is_current OR m.ended_at >= $2) " +
        "WHEN m.is_current THEN s.removed_at >= $2 " +
        "ELSE LEAST(s.removed_at, m.ended_at) >= $2 END) " +
        "SELECT d.* FROM listed d" + keyset + " ORDER BY d.built_in DESC, d.created_ms, d.id LIMIT $3",
        values);
      return rows.map((row) => ({ ...stationRow(row), role: row.role, membership: row.membership ?? null, membershipEndedAt: iso(row.membership_ended_at) ?? null }));
    },

    async builtInStations(client) {
      const { rows } = await run(client, "SELECT * FROM stations WHERE built_in AND status = 'active' ORDER BY created_at, id");
      return rows.map(stationRow);
    },

    // Follows Auth's listing of a built-in Station: its name and whether integrations may be created on it. Returns
    // whether anything changed; custom Stations are never touched.
    async updateBuiltInStation(id, { name, integrationsEnabled }, client) {
      const { rowCount } = await run(client,
        "UPDATE stations SET name = $2, integrations_enabled = $3 WHERE id = $1 AND built_in AND status = 'active' AND (name IS DISTINCT FROM $2 OR integrations_enabled IS DISTINCT FROM $3)",
        [id, name, integrationsEnabled]);
      return rowCount > 0;
    },

    // The account's integrations on a Station that count against a plan limit: every state but revoked, not expired.
    // With revokingHoldsPlace false (the setting on, D29 Phase B) a revoking one doesn't count either: Auth has revoked
    // it and issues it no token, though it may stay revoking for a day or more until its Station's final report.
    async countLiveIntegrations(stationId, ownerAccount, now, client, { revokingHoldsPlace = true } = {}) {
      const { rows } = await run(client,
        "SELECT count(*)::int AS n FROM integrations WHERE station_id = $1 AND owner_account = $2 AND state <> 'revoked' AND ($4 OR state <> 'revoking') AND expires_at > $3",
        [stationId, ownerAccount, when(now), revokingHoldsPlace]);
      return rows[0].n;
    },

    async markStationRemoved(id, now, client) {
      await run(client, "UPDATE stations SET status = 'removed', removed_at = $2 WHERE id = $1 AND status = 'active'", [id, when(now)]);
    },

    async addMember(stationId, accountId, addedBy, now, client) {
      const { rowCount } = await run(client, "INSERT INTO station_members (station_id, account_id, added_by, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [stationId, accountId, addedBy, when(now)]);
      return rowCount > 0;
    },

    async removeMember(stationId, accountId, removedBy, now, client) {
      const { rowCount } = await run(client, "UPDATE station_members SET removed_at = $4, removed_by = $3 WHERE station_id = $1 AND account_id = $2 AND removed_at IS NULL", [stationId, accountId, removedBy, when(now)]);
      return rowCount > 0;
    },

    async currentMembers(stationId, client) {
      const { rows } = await run(client, "SELECT account_id, added_by, added_at FROM station_members WHERE station_id = $1 AND removed_at IS NULL ORDER BY added_at, account_id", [stationId]);
      return rows.map((row) => ({ accountId: row.account_id, addedBy: row.added_by, addedAt: iso(row.added_at) }));
    },

    async insertIntegration({ id, ownerAccount, stationId, kind, name, scopes, quotaPerSecond, expiresAt }, client) {
      const { rowCount } = await run(client, "INSERT INTO integrations (id, owner_account, station_id, kind, name, scopes, state, quota_per_second, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_approval', $7, $8) ON CONFLICT (id) DO NOTHING", [id, ownerAccount, stationId, kind, name, scopes, quotaPerSecond, when(expiresAt)]);
      return rowCount > 0;
    },

    async integration(id, client) {
      const { rows } = await run(client, "SELECT * FROM integrations WHERE id = $1", [id]);
      return rows[0] ? integrationRow(rows[0]) : null;
    },

    async integrationForUpdate(id, client) {
      if (!client) throw new TypeError("integrationForUpdate needs a transaction client.");
      const { rows } = await client.query("SELECT * FROM integrations WHERE id = $1 FOR UPDATE", [id]);
      return rows[0] ? integrationRow(rows[0]) : null;
    },

    async integrationsFor(accountId, client) {
      const { rows } = await run(client, "SELECT * FROM integrations WHERE owner_account = $1 ORDER BY created_at, id", [accountId]);
      return rows.map(integrationRow);
    },

    // The account's integrations that are not revoked and that Auth's change feed has as owner-disabled:
    // [{ id, ownerDisabledAt }].
    async ownerDisabledIntegrations(accountId, client) {
      const { rows } = await run(client, "SELECT id, owner_disabled_at FROM integrations WHERE owner_account = $1 AND owner_disabled_at IS NOT NULL AND state NOT IN ('revoking', 'revoked') ORDER BY created_at, id", [accountId]);
      return rows.map((row) => ({ id: row.id, ownerDisabledAt: iso(row.owner_disabled_at) }));
    },

    async integrationsOnStation(stationId, client) {
      const { rows } = await run(client, "SELECT * FROM integrations WHERE station_id = $1 ORDER BY created_at, id", [stationId]);
      return rows.map(integrationRow);
    },

    async updateIntegration(id, fields, client) {
      const assignments = [];
      const values = [id];
      for (const [key, value] of Object.entries(fields)) {
        if (!Object.hasOwn(updatable, key)) throw new TypeError("Cannot update integration field " + key + ".");
        // when() reads undefined as now, and a set owner-disabled time makes Stations deny tokens, a set revocation time starts the
        // interrupt window: only on purpose.
        if ((key === "ownerDisabledAt" || key === "revokedAt") && value === undefined) throw new TypeError(key + " must be a time, or null to clear it.");
        // A silent null would clear a recorded final outcome or its list of hosts: only on purpose.
        if ((key === "revocationOutcome" || key === "revocationPendingHosts") && value === undefined) throw new TypeError(key + " must be a value, or null to clear it.");
        // The pending hosts are jsonb: written as JSON, and null stays an SQL null (JSON.stringify would make it a JSON null).
        values.push(key === "expiresAt" || key === "approvedAt" || key === "ownerDisabledAt" || key === "revokedAt" ? (value === null ? null : when(value)) : key === "revocationPendingHosts" && value !== null ? JSON.stringify(value) : value);
        assignments.push(updatable[key] + " = $" + values.length);
      }
      assignments.push("updated_at = now()");
      await run(client, "UPDATE integrations SET " + assignments.join(", ") + " WHERE id = $1", values);
    },

    // A Station's report by its id: { integrationId, body, answer }, or null (service.report). Ids are per Station and
    // kept forever, with the body and the answer they got.
    async stationReport(stationId, reportId, client) {
      const { rows } = await run(client, "SELECT integration_id, body, answer FROM station_reports WHERE station_id = $1 AND report_id = $2", [stationId, reportId]);
      return rows[0] ? { integrationId: rows[0].integration_id, body: rows[0].body, answer: rows[0].answer } : null;
    },

    // Keeps an accepted report. The caller has found no report under this id (stationReport, in the same transaction
    // under the event lock); a second one with the same id is refused by the key, not replaced.
    async saveStationReport({ stationId, reportId, integrationId, body, answer }, client) {
      await run(client, "INSERT INTO station_reports (station_id, report_id, integration_id, body, answer) VALUES ($1, $2, $3, $4, $5)", [stationId, reportId, integrationId, JSON.stringify(body), JSON.stringify(answer)]);
    },

    // Records that `host` applied the integration's revocation; returns false when it was already recorded (the first
    // report's record and report ids stand).
    async recordRevocationHost({ integrationId, host, recordId, reportId }, client) {
      const { rowCount } = await run(client, "INSERT INTO revocation_hosts (integration_id, host, record_id, report_id) VALUES ($1, $2, $3, $4) ON CONFLICT (integration_id, host) DO NOTHING", [integrationId, host, recordId, reportId]);
      return rowCount > 0;
    },

    // The hosts recorded for a revocation, as a Set of names.
    async revocationHosts(integrationId, client) {
      const { rows } = await run(client, "SELECT host FROM revocation_hosts WHERE integration_id = $1", [integrationId]);
      return new Set(rows.map((row) => row.host));
    },

    // The lock appendEvent takes. A transaction that will append takes it first, before any row lock, so two of them
    // never hold a row lock each while waiting for the other's (taking it again in the same transaction is free).
    async lockEvents(client) {
      if (!client) throw new TypeError("lockEvents needs a transaction client.");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'))");
    },

    // One advisory lock serialises appenders until commit, so id order is commit order and a feed cursor never skips.
    async appendEvent({ stationId, integrationId = null, accountId, actor, kind, state = null, reason = null, details = {} }, client) {
      if (!client) throw new TypeError("appendEvent needs a transaction client.");
      // The column takes null for an account-level event that names no account (accounts_baseline); a missing account
      // is a mistake, which the column's NOT NULL used to catch.
      if (accountId === undefined) throw new TypeError("appendEvent needs an accountId, or null for an event that names none.");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'))");
      const { rows } = await client.query(
        "INSERT INTO integration_events (station_id, integration_id, account_id, actor, kind, state, reason, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, at",
        [stationId, integrationId, accountId, actor, kind, state, reason, JSON.stringify(details)]);
      return { id: Number(rows[0].id), at: iso(rows[0].at) };
    },

    async changesSince(stationId, cursor, limit = 500, client) {
      const { rows } = await run(client, "SELECT id, at, integration_id, account_id, kind, state, reason, details FROM integration_events WHERE station_id = $1 AND id > $2 ORDER BY id LIMIT $3", [stationId, cursorNumber(cursor), limit]);
      return rows.map(eventRow);
    },

    // Unlike the feed, an integration's own history names who acted.
    async eventsFor(integrationId, limit = 100, client) {
      const { rows } = await run(client, "SELECT id, at, integration_id, actor, kind, state, reason, details FROM integration_events WHERE integration_id = $1 ORDER BY id DESC LIMIT $2", [integrationId, limit]);
      return rows.map((row) => ({ ...eventRow(row), actor: row.actor }));
    },

    async latestCursor(stationId, client) {
      const { rows } = await run(client, "SELECT COALESCE(MAX(id), 0) AS cursor FROM integration_events WHERE station_id = $1", [stationId]);
      return Number(rows[0].cursor);
    },

    // Where the Portal is in Auth's change feed (auth-changes.mjs): Auth's opaque cursor, or null before the first page.
    async authChangeCursor(client) {
      const { rows } = await run(client, "SELECT cursor FROM auth_change_feed WHERE id");
      return rows[0]?.cursor ?? null;
    },

    // null resets it, to read Auth's feed again from the start. The row is created when it is missing.
    async saveAuthChangeCursor(cursor, client) {
      if (cursor !== null && (typeof cursor !== "string" || !AUTH_CURSOR.test(cursor))) throw new TypeError("An Auth change cursor is 1 to 64 base64url characters, or null.");
      await run(client, "INSERT INTO auth_change_feed (id, cursor) VALUES (true, $1) ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()", [cursor]);
    },

    // Whether an entry of Auth's change feed was already applied to this integration: its cursor and time are kept in
    // the details of the event it wrote (service.applyAuthChange). The time tells apart a cursor Auth hands out again
    // after its database was restored from a backup.
    async authChangeApplied(integrationId, cursor, at, client) {
      const { rows } = await run(client, "SELECT 1 FROM integration_events WHERE integration_id = $1 AND details->>'authCursor' = $2 AND details->>'authAt' = $3 LIMIT 1", [integrationId, cursor, at]);
      return rows.length > 0;
    },

    // The pauses, resumes and revocations recorded for the integration: { at, id }, both null when there is none.
    // `at` is the newest time of one, as an ISO string (service.applyAuthChange, Ruling R-A): an entry of Auth's change
    // feed counts at Auth's time (details.authAt); a change the Portal saw through its own call or an owner's listing
    // at the time it saw it (details.seenAt), which is no earlier than Auth made it; an older event without either at
    // the time it was recorded. `id` is the newest one's event ID, which latestEventId orders (a listing's
    // reconcile).
    async latestStatus(integrationId, client) {
      const { rows } = await run(client,
        "SELECT max(CASE WHEN details ? 'authCursor' AND details->>'authAt' ~ $3 THEN (details->>'authAt')::timestamptz WHEN details->>'seenAt' ~ $3 THEN (details->>'seenAt')::timestamptz ELSE at END) AS latest, max(id) AS id FROM integration_events WHERE integration_id = $1 AND kind = ANY($2)",
        [integrationId, STATUS_KINDS, ISO_TIME]);
      return { at: iso(rows[0].latest), id: rows[0].id === null ? null : Number(rows[0].id) };
    },

    // The newest event ID of all, or 0. Events are appended under one lock, so any event committed later has a
    // greater ID.
    async latestEventId(client) {
      const { rows } = await run(client, "SELECT COALESCE(MAX(id), 0) AS id FROM integration_events");
      return Number(rows[0].id);
    },

    // Records an account-level entry of Auth's feed as applied, once: its cursor and time are the key (the time tells
    // apart a cursor Auth hands out again after its database was restored). Returns false when it was already applied,
    // and then nothing is recorded; the caller (service.accountChange) applies the entry only on true, in the same
    // transaction. `account` is null for an accounts_baseline.
    async applyAccountEntry({ cursor, at, account = null, kind }, client) {
      const { rowCount } = await run(client, "INSERT INTO auth_account_entries (auth_cursor, auth_at, account_id, kind) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [authCursorOf(cursor), timeOf(at, "at"), account, kind]);
      return rowCount > 0;
    },

    // An account's availability as the entry applied last says: one row per account, replaced by each entry. Order comes
    // from Auth's feed, which the reader applies in order under the event lock, not from the entries' times (Auth's
    // nodes' clocks may disagree).
    async setAvailability(account, disabled, cursor, at, client) {
      if (typeof disabled !== "boolean") throw new TypeError("disabled must be true or false.");
      await run(client,
        "INSERT INTO account_availability (account_id, disabled, auth_cursor, auth_at) VALUES ($1, $2, $3, $4) ON CONFLICT (account_id) DO UPDATE SET disabled = EXCLUDED.disabled, auth_cursor = EXCLUDED.auth_cursor, auth_at = EXCLUDED.auth_at, updated_at = now()",
        [account, disabled, authCursorOf(cursor), timeOf(at, "at")]);
    },

    // The accounts that are disabled, in order: the "disabled" of a checkpoint and a built-in Station's cursor-0 snapshot.
    async disabledAccountList(client) {
      const { rows } = await run(client, "SELECT account_id FROM account_availability WHERE disabled ORDER BY account_id COLLATE \"C\"");
      return rows.map((row) => row.account_id);
    },

    // Records that an accounts_baseline was applied: its cursor and time, replacing the one before. A new row starts
    // incomplete; an existing one keeps its mark, since a baseline applied while the Portal is already complete (or
    // replaying) says nothing about whether it has caught up.
    async setBaseline(cursor, at, client) {
      await run(client,
        "INSERT INTO account_baseline (id, auth_cursor, auth_at) VALUES (true, $1, $2) ON CONFLICT (id) DO UPDATE SET auth_cursor = EXCLUDED.auth_cursor, auth_at = EXCLUDED.auth_at, applied_at = now()",
        [authCursorOf(cursor), timeOf(at, "at")]);
    },

    // Marks the recorded baseline complete: the Portal has caught up with Auth's feed since it was applied, so Auth's
    // feed alone is authoritative for every account. Returns the baseline's { cursor, at } when this call completed it,
    // and null when none is recorded or it already was: of several replicas, only the first one gets an answer.
    async markBaselineComplete(client) {
      const { rows } = await run(client, "UPDATE account_baseline SET complete = true WHERE NOT complete RETURNING auth_cursor, auth_at");
      return rows[0] ? { cursor: rows[0].auth_cursor, at: iso(rows[0].auth_at) } : null;
    },

    // The feed is read from its start again (a first start, or a reset): the accounts are unknown until the Portal has
    // caught up. The baseline stays recorded.
    async markBaselineIncomplete(client) {
      await run(client, "UPDATE account_baseline SET complete = false WHERE complete");
    },

    // Clears the mark: the Portal skipped an account-level entry, so availability is unknown again and the baseline must
    // be applied again.
    async clearBaseline(client) {
      await run(client, "DELETE FROM account_baseline");
    },

    // Forgets every applied account-level entry, so the next read of the feed applies each again, in Auth's order
    // (service.applyAuthChange: an entry was skipped, so what was applied before it can no longer be trusted to be all).
    async forgetAccountEntries(client) {
      await run(client, "DELETE FROM auth_account_entries");
    },

    // Whether the accounts are complete: a baseline was applied and the Portal has caught up with the feed since. An
    // account missing from disabledAccountList() is then enabled (or doesn't exist); until then it is unknown.
    async baselineApplied(client) {
      const { rows } = await run(client, "SELECT EXISTS (SELECT 1 FROM account_baseline WHERE complete) AS applied");
      return rows[0].applied === true;
    },

    // The built-in Station's last reported binding of an R9 account at a genesis, or null (service.report, the
    // checkpoint). Names follow the table: accountId is the Agora.Build owner, r9AccountId the R9 account.
    async binding(stationId, r9AccountId, genesisHash, client) {
      const { rows } = await run(client, "SELECT * FROM station_bindings WHERE station_id = $1 AND r9_account_id = $2 AND genesis_hash = $3", [stationId, r9AccountId, genesisHash]);
      return rows[0] ? bindingRow(rows[0]) : null;
    },

    // Records the binding as the Station's latest for its R9 account and genesis, replacing the one before. The caller
    // has applied the version rules (service.report, under the event lock); this writes what it is given.
    async saveBinding({ stationId, r9AccountId, genesisHash, accountId, bindingId, version, bindingState, reportId }, client) {
      if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("version must be a positive whole number.");
      await run(client,
        "INSERT INTO station_bindings (station_id, r9_account_id, genesis_hash, account_id, binding_id, version, binding_state, report_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) " +
        "ON CONFLICT (station_id, r9_account_id, genesis_hash) DO UPDATE SET account_id = EXCLUDED.account_id, binding_id = EXCLUDED.binding_id, version = EXCLUDED.version, binding_state = EXCLUDED.binding_state, report_id = EXCLUDED.report_id, updated_at = now()",
        [stationId, r9AccountId, genesisHash, accountId, bindingId, version, bindingState, reportId]);
    },

    // Every binding the Station has reported, by R9 account and then genesis (byte order, so the checkpoint reads the
    // same whatever the database's locale).
    async bindingsOn(stationId, client) {
      const { rows } = await run(client, "SELECT * FROM station_bindings WHERE station_id = $1 ORDER BY r9_account_id COLLATE \"C\", genesis_hash COLLATE \"C\"", [stationId]);
      return rows.map(bindingRow);
    },

    // Keeps a refused binding attempt. The caller has found no report under this id (service.report); a second one with
    // the same id on a Station is refused by the key, not replaced.
    async saveBindingAttempt({ stationId, reportId, accountId, r9AccountId, genesisHash, reason, attemptedAt }, client) {
      await run(client,
        "INSERT INTO binding_attempts (station_id, report_id, account_id, r9_account_id, genesis_hash, reason, attempted_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [stationId, reportId, accountId, r9AccountId, genesisHash, reason, timeOf(attemptedAt, "attemptedAt")]);
    },

    // The attempts reported for this account (the one the Station says to alert) made at or after `since`, newest first.
    // Only that account's: another account's attempt, and the other account named in one, are never read here.
    async bindingAttemptsFor(accountId, since, client) {
      const { rows } = await run(client, "SELECT * FROM binding_attempts WHERE account_id = $1 AND attempted_at >= $2 ORDER BY attempted_at DESC, station_id, report_id", [accountId, timeOf(since, "since")]);
      return rows.map(bindingAttemptRow);
    }
  };
}
