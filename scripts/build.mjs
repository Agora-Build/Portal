import { mkdir, copyFile, cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const output = new URL("dist/", root);
// Start clean so stale private state under dist/ can never be packaged.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(["index.html", "explore.html", "services.html", "radar.html", "meetings.html", "account.html", "account.js", "stoa.html", "stoa.js", "styles.css", "script.js", "people.js", "activity.js", "explore.js", "services.js", "radar.js", "meetings.js", "call.js", "package.json", "package-lock.json", ".env.example"].map((file) => copyFile(new URL(file, root), new URL(file, output))));
await cp(new URL("assets/", root), new URL("assets/", output), { recursive: true });
await copyFile(createRequire(import.meta.url).resolve("agora-rtc-sdk-ng"), new URL("assets/agora-rtc.js", output));
await copyFile(createRequire(import.meta.url).resolve("agora-rtm-sdk"), new URL("assets/agora-rtm.js", output));
await cp(new URL("data/", root), new URL("data/", output), { recursive: true });
await mkdir(new URL("scripts/", output), { recursive: true });
await Promise.all(["serve.mjs", "store.mjs", "models.mjs", "activity.mjs", "calls.mjs", "auth.mjs", "identity.mjs", "credits.mjs", "ledger.mjs", "billing.mjs", "plans.mjs", "persistence.mjs", "connections.mjs", "platform-admin.mjs"].map((file) => copyFile(new URL("scripts/" + file, root), new URL("scripts/" + file, output))));
await cp(new URL("scripts/spaces/", root), new URL("scripts/spaces/", output), { recursive: true });
await cp(new URL("world/", root), new URL("world/", output), { recursive: true });
await cp(new URL("stoa/", root), new URL("stoa/", output), { recursive: true });
await cp(new URL("worlds/", root), new URL("worlds/", output), { recursive: true });
await cp(new URL("themes/", root), new URL("themes/", output), { recursive: true });
console.log("House app built in dist/. Run with: node dist/scripts/serve.mjs");
