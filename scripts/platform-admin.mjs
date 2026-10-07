import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";
import { createLedger } from "./ledger.mjs";
import { createPostgresPersistence } from "./persistence.mjs";

const root = new URL("../", import.meta.url);
if (existsSync(new URL(".env", root))) process.loadEnvFile(fileURLToPath(new URL(".env", root)));
const persistence = process.env.DATABASE_URL ? createPostgresPersistence(process.env.DATABASE_URL) : null;
const store = createStore(fileURLToPath(new URL("data/people.json", root)), fileURLToPath(new URL(".data/community.json", root)), { persistence });
const [command, userId, value, key, ...reason] = process.argv.slice(2);
try {
  if (!persistence && process.env.PORTAL_OFFLINE_ADMIN !== "true") throw new Error("Local file administration requires the portal to be stopped and PORTAL_OFFLINE_ADMIN=true. Use PostgreSQL for online administration.");
  if (command === "grant-credits") {
    if (!reason.length) throw new Error("Include a reason for the ledger.");
    await createLedger(store).deposit(userId, Number(value), reason.join(" "), key);
    console.log("Credit grant recorded.");
  } else if (command === "assign-role" && ["basic", "principal", "fellow"].includes(value)) {
    await store.transaction((state) => {
      const account = state.accounts.find((account) => account.id === userId);
      if (!account) throw new Error("Portal user not found.");
      account.assignedPlan = value === "basic" ? null : value;
    });
    console.log("Community role updated. Paid subscriptions are managed in Stripe.");
  } else if (command === "import-json" && persistence) {
    const snapshot = JSON.parse(await readFile(new URL(".data/community.json", root), "utf8"));
    await persistence.update((state) => {
      if (Object.keys(state).length) throw new Error("Import requires an empty portal database.");
      Object.assign(state, snapshot);
    });
    console.log("Existing portal state imported without changing IDs or balances.");
  } else throw new Error("Usage: node scripts/platform-admin.mjs grant-credits <user-id> <credits> <unique-key> <reason> | assign-role <user-id> <basic|principal|fellow> | import-json");
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await persistence?.close(); }
