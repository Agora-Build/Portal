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
  ownerDisabledAt: "owner_disabled_at"
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
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function eventRow(row) {
  return {
    id: Number(row.id),
    at: iso(row.at),
    integrationId: row.integration_id,
    kind: row.kind,
    state: row.state,
    reason: row.reason,
    details: row.details
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
    async countLiveIntegrations(stationId, ownerAccount, now, client) {
      const { rows } = await run(client,
        "SELECT count(*)::int AS n FROM integrations WHERE station_id = $1 AND owner_account = $2 AND state <> 'revoked' AND expires_at > $3",
        [stationId, ownerAccount, when(now)]);
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
        // when() reads undefined as now, and a set owner-disabled time makes Stations deny tokens: only on purpose.
        if (key === "ownerDisabledAt" && value === undefined) throw new TypeError("ownerDisabledAt must be a time, or null to clear it.");
        values.push(key === "expiresAt" || key === "approvedAt" || key === "ownerDisabledAt" ? (value === null ? null : when(value)) : value);
        assignments.push(updatable[key] + " = $" + values.length);
      }
      assignments.push("updated_at = now()");
      await run(client, "UPDATE integrations SET " + assignments.join(", ") + " WHERE id = $1", values);
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
      await client.query("SELECT pg_advisory_xact_lock(hashtext('portal_integration_events'))");
      const { rows } = await client.query(
        "INSERT INTO integration_events (station_id, integration_id, account_id, actor, kind, state, reason, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, at",
        [stationId, integrationId, accountId, actor, kind, state, reason, JSON.stringify(details)]);
      return { id: Number(rows[0].id), at: iso(rows[0].at) };
    },

    async changesSince(stationId, cursor, limit = 500, client) {
      const { rows } = await run(client, "SELECT id, at, integration_id, kind, state, reason, details FROM integration_events WHERE station_id = $1 AND id > $2 ORDER BY id LIMIT $3", [stationId, cursorNumber(cursor), limit]);
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
    }
  };
}
