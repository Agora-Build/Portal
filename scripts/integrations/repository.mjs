// All SQL for Stations, members, challenges, integrations and the event log / change feed. Parameterised throughout.

const updatable = {
  state: "state",
  resumeState: "resume_state",
  r9Svc: "r9_svc",
  quotaPerSecond: "quota_per_second",
  expiresAt: "expires_at",
  approvedBy: "approved_by",
  approvedAt: "approved_at",
  lastError: "last_error"
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

function stationRow(row) {
  return {
    id: row.id,
    origin: row.origin,
    ownerAccount: row.owner_account,
    reportClientId: row.report_client_id,
    status: row.status,
    createdAt: iso(row.created_at),
    verifiedAt: iso(row.verified_at),
    removedAt: iso(row.removed_at)
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
    async createChallenge({ id, accountId, origin, value, expiresAt }, client) {
      await run(client, "INSERT INTO station_challenges (id, account_id, origin, value, expires_at) VALUES ($1, $2, $3, $4, $5)", [id, accountId, origin, value, when(expiresAt)]);
    },

    async takeChallenge(id, accountId, now, client) {
      const { rows } = await run(client, "UPDATE station_challenges SET used_at = $3 WHERE id = $1 AND account_id = $2 AND used_at IS NULL AND expires_at > $3 RETURNING origin, value", [id, accountId, when(now)]);
      return rows[0] ? { origin: rows[0].origin, value: rows[0].value } : null;
    },

    async challengesSince(accountId, since, client) {
      const { rows } = await run(client, "SELECT count(*)::int AS n FROM station_challenges WHERE account_id = $1 AND created_at > $2", [accountId, when(since)]);
      return rows[0].n;
    },

    async insertStation({ id, origin, ownerAccount, reportClientId, verifiedAt }, client) {
      await run(client, "INSERT INTO stations (id, origin, owner_account, report_client_id, status, verified_at) VALUES ($1, $2, $3, $4, 'active', $5) ON CONFLICT (id) DO NOTHING", [id, origin, ownerAccount, reportClientId, when(verifiedAt)]);
    },

    async station(id, client) {
      const { rows } = await run(client, "SELECT * FROM stations WHERE id = $1", [id]);
      return rows[0] ? stationRow(rows[0]) : null;
    },

    async stationByReportClient(clientId, client) {
      const { rows } = await run(client, "SELECT * FROM stations WHERE report_client_id = $1 AND status = 'active'", [clientId]);
      return rows[0] ? stationRow(rows[0]) : null;
    },

    async stationsFor(accountId, client) {
      const { rows } = await run(client,
        "SELECT s.*, CASE WHEN s.owner_account = $1 THEN 'owner' ELSE 'member' END AS role FROM stations s WHERE s.status = 'active' AND (s.owner_account = $1 OR EXISTS (SELECT 1 FROM station_members m WHERE m.station_id = s.id AND m.account_id = $1 AND m.removed_at IS NULL)) ORDER BY s.created_at, s.id",
        [accountId]);
      return rows.map((row) => ({ ...stationRow(row), role: row.role }));
    },

    async markStationRemoved(id, now, client) {
      await run(client, "UPDATE stations SET status = 'removed', removed_at = $2 WHERE id = $1 AND status = 'active'", [id, when(now)]);
    },

    async addMember(stationId, accountId, addedBy, now, client) {
      await run(client, "INSERT INTO station_members (station_id, account_id, added_by, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [stationId, accountId, addedBy, when(now)]);
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
      await run(client, "INSERT INTO integrations (id, owner_account, station_id, kind, name, scopes, state, quota_per_second, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_approval', $7, $8) ON CONFLICT (id) DO NOTHING", [id, ownerAccount, stationId, kind, name, scopes, quotaPerSecond, when(expiresAt)]);
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

    async integrationsOnStation(stationId, client) {
      const { rows } = await run(client, "SELECT * FROM integrations WHERE station_id = $1 ORDER BY created_at, id", [stationId]);
      return rows.map(integrationRow);
    },

    async updateIntegration(id, fields, client) {
      const assignments = [];
      const values = [id];
      for (const [key, value] of Object.entries(fields)) {
        if (!Object.hasOwn(updatable, key)) throw new TypeError("Cannot update integration field " + key + ".");
        values.push(key === "expiresAt" || key === "approvedAt" ? (value === null ? null : when(value)) : value);
        assignments.push(updatable[key] + " = $" + values.length);
      }
      assignments.push("updated_at = now()");
      await run(client, "UPDATE integrations SET " + assignments.join(", ") + " WHERE id = $1", values);
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

    async eventsFor(integrationId, limit = 100, client) {
      const { rows } = await run(client, "SELECT id, at, integration_id, kind, state, reason, details FROM integration_events WHERE integration_id = $1 ORDER BY id DESC LIMIT $2", [integrationId, limit]);
      return rows.map(eventRow);
    },

    async latestCursor(stationId, client) {
      const { rows } = await run(client, "SELECT COALESCE(MAX(id), 0) AS cursor FROM integration_events WHERE station_id = $1", [stationId]);
      return Number(rows[0].cursor);
    }
  };
}
