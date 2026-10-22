// Server-side prices for platform billing clients (PORTAL_BILLING_FILE). A client may hold and settle credits only if
// it is listed here, and only for its listed services; the charge is always computed from these prices, never sent.
import { readFileSync } from "node:fs";
import { AppError } from "./store.mjs";

const CLIENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SERVICE = /^[a-z][a-z0-9-]{1,40}$/;
const MAX_CHARGE = 1000000000;
const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const whole = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;

// Validates a registry `{ <client id>: { services: { <service>: { credits, maxUnits } } } }` into a Map.
export function billingClients(registry) {
  if (!plainObject(registry)) throw new TypeError("The billing registry must be an object of clients.");
  const clients = new Map();
  for (const [id, client] of Object.entries(registry)) {
    if (!CLIENT.test(id) || !plainObject(client) || !plainObject(client.services)) throw new TypeError("Each billing client needs a valid ID and a services object.");
    const services = new Map();
    for (const [name, price] of Object.entries(client.services)) {
      if (!SERVICE.test(name) || !plainObject(price) || !whole(price.credits, MAX_CHARGE) || !whole(price.maxUnits, MAX_CHARGE) || price.credits * price.maxUnits > MAX_CHARGE) throw new TypeError("Each billing service needs whole credits and maxUnits within the ledger's limit.");
      services.set(name, { credits: price.credits, maxUnits: price.maxUnits });
    }
    clients.set(id, services);
  }
  return clients;
}

// Reads the registry from a file; null (billing off) when the setting is unset or the file is unreadable or invalid.
export function loadBillingClients(file, log = (line) => console.log(line)) {
  if (!file) { log("Platform billing is off: PORTAL_BILLING_FILE is not set."); return null; }
  try { return billingClients(JSON.parse(readFileSync(file, "utf8"))); }
  catch { log("Platform billing is off: the file named by PORTAL_BILLING_FILE is missing or invalid."); return null; }
}

// The charge for `units` (default 1) of a client's service.
export function priceFor(clients, clientId, service, units = 1) {
  const price = typeof service === "string" ? clients.get(clientId)?.get(service) : undefined;
  if (!price) throw new AppError(422, "This service has no registered price.");
  if (!Number.isSafeInteger(units) || units < 1 || units > price.maxUnits) throw new AppError(422, "Use 1 to " + price.maxUnits + " whole units for this service.");
  return price.credits * units;
}
