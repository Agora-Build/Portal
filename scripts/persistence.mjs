import pg from "pg";

export function createPostgresPersistence(connectionString, { pool = new pg.Pool({ connectionString }) } = {}) {
  let initialized;
  const ready = () => initialized ||= (async () => {
    const client = await pool.connect();
    let releaseError;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agora_build_schema'))");
      await client.query("CREATE TABLE IF NOT EXISTS agora_build_state (id integer PRIMARY KEY CHECK (id = 1), document jsonb NOT NULL)");
      await client.query("INSERT INTO agora_build_state (id, document) VALUES (1, '{}') ON CONFLICT DO NOTHING");
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    }
    finally { client.release(releaseError); }
  })().catch((error) => { initialized = undefined; throw error; });
  return {
    async read() {
      await ready();
      const result = await pool.query("SELECT document FROM agora_build_state WHERE id = 1");
      return result.rows[0].document;
    },
    async update(change) {
      await ready();
      const client = await pool.connect();
      let releaseError;
      try {
        await client.query("BEGIN");
        // One locked aggregate keeps identities, sessions, payments and ledger changes atomic.
        const result = await client.query("SELECT document FROM agora_build_state WHERE id = 1 FOR UPDATE");
        const state = result.rows[0].document;
        const value = await change(state);
        await client.query("UPDATE agora_build_state SET document = $1 WHERE id = 1", [JSON.stringify(state)]);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch (rollbackError) { releaseError = rollbackError; }
        throw error;
      }
      finally { client.release(releaseError); }
    },
    close() { return pool.end(); }
  };
}
