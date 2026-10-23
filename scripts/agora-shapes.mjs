// A temporary, opt-in probe of Agora SSO and BFF response shapes, so the project and name mappers in connections.mjs can be
// adapted. It reads the store with the server's settings, opens one account's stored Agora connection in-process
// (renewing its token if needed), calls each GET endpoint the Portal uses or may use and prints ONLY the key structure of each
// response: key names and value types. Values (tokens, App IDs, certificates, names, IDs) are never printed.
//
//   node scripts/agora-shapes.mjs <account-id>
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGORA_PATHS, connectionsConfig, createConnections } from "./connections.mjs";

// A key that looks like data (an ID used as a map key, say) is printed as <key>.
const printableKey = (key) => /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(key) && !/^[0-9a-f]{16,}$/i.test(key) && (key.match(/[0-9]/g) || []).length <= 3;
const typeOf = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
// The structure of a JSON value as lines of "path: type". Array elements are merged under "[]".
export function describeShape(value) {
  const types = new Map();
  const visit = (node, path) => {
    const type = typeOf(node);
    if (!types.has(path)) types.set(path, new Set());
    types.get(path).add(type === "array" ? (node.length ? "array" : "array (empty)") : type);
    if (type === "array") for (const item of node) visit(item, path + "[]");
    else if (type === "object") for (const key of Object.keys(node)) visit(node[key], (path ? path + "." : "") + (printableKey(key) ? key : "<key>"));
  };
  visit(value, "");
  return [...types].map(([path, set]) => (path || "(top level)") + ": " + [...set].sort().join(" | "));
}

// Probes every documented GET endpoint for one account; `write` receives each output line.
export async function probeShapes(connections, userId, write = (line) => console.log(line)) {
  const show = async (label, path, options) => {
    let result;
    try { result = await connections.get(userId, path, options); }
    catch (error) { write("GET " + label + ": failed (" + (error.status || "error") + ")"); return undefined; }
    write("GET " + label + ": " + result.status);
    for (const line of result.body === undefined ? ["(no JSON body)"] : describeShape(result.body)) write("  " + line);
    return result;
  };
  await show(AGORA_PATHS.userAuth, AGORA_PATHS.userAuth);
  await show(AGORA_PATHS.companyInfo, AGORA_PATHS.companyInfo);
  await show(AGORA_PATHS.companies, AGORA_PATHS.companies);
  await show("BFF " + AGORA_PATHS.bffProjects, AGORA_PATHS.bffProjects, { bff: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  if (existsSync(new URL(".env", root))) process.loadEnvFile(fileURLToPath(new URL(".env", root)));
  const { createStore } = await import("./store.mjs");
  const { createPostgresPersistence } = await import("./persistence.mjs");
  const persistence = process.env.DATABASE_URL ? createPostgresPersistence(process.env.DATABASE_URL) : null;
  const userId = process.argv[2];
  try {
    if (!userId) throw new Error("Usage: node scripts/agora-shapes.mjs <account-id>");
    // Renewing a token writes the store; like platform-admin, a local file store needs the portal stopped.
    if (!persistence && process.env.PORTAL_OFFLINE_ADMIN !== "true") throw new Error("Local file stores require the portal to be stopped and PORTAL_OFFLINE_ADMIN=true. Use PostgreSQL to probe online.");
    const store = createStore(fileURLToPath(new URL("data/people.json", root)), fileURLToPath(new URL(".data/community.json", root)), { persistence, log: () => {} });
    const config = connectionsConfig();
    if (!config.ready) throw new Error("Agora connections are not configured: check AGORA_CONSOLE_ENCRYPTION_KEY and AGORA_SSO_BASE_URL.");
    // Shape mismatches are reported here as structure, so the connections log stays quiet.
    await probeShapes(createConnections(store, config, { log: () => {} }), userId);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await persistence?.close(); }
}
