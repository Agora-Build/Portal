import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const migrationsDirectory = new URL("../../migrations/", import.meta.url);

function monthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function nextMonth(start) {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

function partitionName(start) {
  return "integration_events_y" + start.getUTCFullYear() + "m" + String(start.getUTCMonth() + 1).padStart(2, "0");
}

export function createDatabase(connectionString, { schema, max = 10, log = () => {} } = {}) {
  if (schema !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid schema name.");
  const options = "-c statement_timeout=30000" + (schema ? " -c search_path=" + schema : "");
  const pool = new pg.Pool({ connectionString, max, options, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
  // An idle client lost its connection; the next query opens a new one.
  pool.on("error", () => log("Portal database pool error."));

  async function transaction(work) {
    const client = await pool.connect();
    // A connection that drops mid-transaction must fail the query, not crash the process.
    const onError = () => log("Portal database connection lost during a transaction.");
    client.on("error", onError);
    let releaseError;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally {
      client.removeListener("error", onError);
      client.release(releaseError);
    }
  }

  // Applies migrations/NNN_name.sql in order, once each, in one transaction under an advisory lock.
  async function migrate() {
    const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
    const stray = names.find((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name));
    if (stray) throw new Error("Migration file name must look like 001_name.sql: " + stray);
    const files = names.sort();
    return transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agora_portal_migrations'))");
      await client.query("CREATE TABLE IF NOT EXISTS portal_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const applied = new Set((await client.query("SELECT version FROM portal_migrations")).rows.map((row) => row.version));
      const ran = [];
      for (const file of files) {
        if (applied.has(file)) continue;
        await client.query(await readFile(new URL(file, migrationsDirectory), "utf8"));
        await client.query("INSERT INTO portal_migrations (version) VALUES ($1)", [file]);
        ran.push(file);
      }
      return ran;
    });
  }

  // Creates the monthly integration_events partitions for this month and the next (months in all) when missing. Rows
  // already in the default partition for such a month move into it, in the same transaction. Idempotent and safe
  // across replicas. Returns the names it created.
  async function ensureEventPartitions({ months = 2, now = new Date() } = {}) {
    const created = [];
    let start = monthStart(now);
    for (let index = 0; index < months; index += 1) {
      const end = nextMonth(start);
      const name = partitionName(start);
      const made = await transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('portal_event_partitions'))");
        if ((await client.query("SELECT to_regclass($1) AS found", [name])).rows[0].found) return false;
        // The name and the bounds come from dates, never from input; partition bounds must be literals.
        await client.query("CREATE TABLE " + name + " (LIKE integration_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS)");
        await client.query("WITH moved AS (DELETE FROM integration_events_default WHERE at >= $1 AND at < $2 RETURNING *) INSERT INTO " + name + " SELECT * FROM moved", [start, end]);
        await client.query("ALTER TABLE integration_events ATTACH PARTITION " + name + " FOR VALUES FROM ('" + start.toISOString() + "') TO ('" + end.toISOString() + "')");
        return true;
      });
      if (made) created.push(name);
      start = end;
    }
    return created;
  }

  return { pool, transaction, migrate, ensureEventPartitions, close: () => pool.end() };
}
