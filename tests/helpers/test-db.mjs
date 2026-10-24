import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDatabase } from "../../scripts/integrations/db.mjs";

// A migrated database in a throwaway schema, dropped when the test ends; null when PORTAL_TEST_DATABASE_URL is unset.
export async function testDatabase(t) {
  const url = process.env.PORTAL_TEST_DATABASE_URL;
  if (!url) return null;
  if (new URL(url).pathname !== "/agora_portal_test") throw new Error("PORTAL_TEST_DATABASE_URL must name the agora_portal_test database.");
  const schema = "t_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("CREATE SCHEMA " + schema);
  const db = createDatabase(url, { schema, max: 4 });
  t.after(async () => {
    await db.close();
    try { await admin.query("DROP SCHEMA " + schema + " CASCADE"); } finally { await admin.end(); }
  });
  await db.migrate();
  return db;
}

// For tests that run migrate() themselves: same schema handling, no migration, and a way to open more instances.
export async function emptySchema(t) {
  const url = process.env.PORTAL_TEST_DATABASE_URL;
  if (!url) return null;
  if (new URL(url).pathname !== "/agora_portal_test") throw new Error("PORTAL_TEST_DATABASE_URL must name the agora_portal_test database.");
  const schema = "t_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("CREATE SCHEMA " + schema);
  const opened = [];
  t.after(async () => {
    for (const db of opened) await db.close();
    try { await admin.query("DROP SCHEMA " + schema + " CASCADE"); } finally { await admin.end(); }
  });
  return () => {
    const db = createDatabase(url, { schema, max: 4 });
    opened.push(db);
    return db;
  };
}
