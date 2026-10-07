import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresPersistence } from "../scripts/persistence.mjs";
import { createStore } from "../scripts/store.mjs";
import { createLedger } from "../scripts/ledger.mjs";

const databaseUrl = process.env.PORTAL_TEST_DATABASE_URL;
test("two PostgreSQL-backed server instances preserve identities and serialize concurrent money transactions", { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.pathname, "/agora_portal_test", "Use the dedicated agora_portal_test database.");
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query("DROP TABLE IF EXISTS agora_build_state");
  const persistenceA = createPostgresPersistence(databaseUrl), persistenceB = createPostgresPersistence(databaseUrl);
  const storeA = createStore(new URL("../data/people.json", import.meta.url), "unused", { persistence: persistenceA });
  const storeB = createStore(new URL("../data/people.json", import.meta.url), "unused", { persistence: persistenceB });
  try {
    const identity = { provider: "github", issuer: "https://github.com", subject: "db-builder", name: "Database builder" };
    // Initialize before launching parallel creators; schema DDL is a deployment operation.
    await persistenceA.read(); await persistenceB.read();
    const [loginA, loginB] = await Promise.all([storeA.login(identity), storeB.login(identity)]);
    assert.equal(loginA.account.id, loginB.account.id);
    const ledgerA = createLedger(storeA), ledgerB = createLedger(storeB);
    await Promise.all([ledgerA.deposit(loginA.account.id, 10, "Paid test credits", "paid-1"), ledgerB.deposit(loginA.account.id, 10, "Paid test credits", "paid-1")]);
    assert.equal((await ledgerA.balance(loginA.account.id)).credits, 10);
    const spends = await Promise.allSettled([ledgerA.reserve(loginA.account.id, "first:work", 7, "request-1"), ledgerB.reserve(loginA.account.id, "second:work", 7, "request-2")]);
    assert.equal(spends.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await ledgerB.balance(loginA.account.id)).credits, 3);
    const reservation = spends.find((result) => result.status === "fulfilled").value;
    await ledgerB.settle(loginA.account.id, reservation.id, "release");
    assert.equal((await ledgerA.balance(loginA.account.id)).credits, 10);
    await assert.rejects(storeA.transaction((state) => { state.accounts = []; throw new Error("Rollback"); }));
    assert.equal((await storeB.session(loginB.token)).account.id, loginA.account.id);
    const snapshot = await persistenceB.read();
    assert.equal(snapshot.ledger.entries.reduce((sum, entry) => sum + entry.amount, 0), 0);
  } finally {
    await persistenceA.close(); await persistenceB.close();
    await admin.query("DROP TABLE IF EXISTS agora_build_state"); await admin.end();
  }
});
