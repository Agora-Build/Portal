// Proof of control (station-tokens.md section B1) and the Portal's only outbound fetch to user-supplied hosts. The
// address check runs inside the connection's own DNS lookup, so it applies to the address actually connected to.
import dns from "node:dns";
import https from "node:https";
import { isIP, isIPv4, isIPv6 } from "node:net";
import { AppError } from "../store.mjs";

const ORIGIN_MESSAGE = "Enter the Station's address as https://host, without a path.";
const ORIGIN_MAX = 300;
export const WELL_KNOWN_PATH = "/.well-known/agora-build-station";

export class ProofError extends Error {
  constructor(reason) {
    super("Station fetch failed: " + reason);
    this.name = "ProofError";
    this.reason = reason;
  }
}

const unbracket = (hostname) => hostname.replace(/^\[(.*)\]$/, "$1");

export function stationOrigin(value) {
  const refuse = () => { throw new AppError(400, ORIGIN_MESSAGE); };
  if (typeof value !== "string" || !value || value.length > ORIGIN_MAX) refuse();
  let url;
  try { url = new URL(value); } catch { refuse(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) refuse();
  if (url.pathname !== "/" && url.pathname !== "") refuse();
  const origin = url.origin;
  // Host names are case-insensitive; anything else the URL parser rewrote (ports, IP forms, paths) is refused.
  const given = value.toLowerCase();
  if (given !== origin && given !== origin + "/") refuse();
  if (!url.hostname.includes(".") || isIP(unbracket(url.hostname))) refuse();
  return origin;
}

const IPV4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4], ["255.255.255.255", 32]
].map(([base, bits]) => [ipv4Number(base), bits]);

function ipv4Number(address) {
  return address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}

function blockedIPv4(address) {
  const number = ipv4Number(address);
  return IPV4_BLOCKS.some(([base, bits]) => Math.floor(number / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

// Eight 16-bit groups; a trailing dotted IPv4 part becomes the last two groups.
function ipv6Groups(address) {
  let text = address;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const number = ipv4Number(dotted[2]);
    text = dotted[1] + Math.floor(number / 65536).toString(16) + ":" + (number % 65536).toString(16);
  }
  const [head, tail] = text.split("::");
  const parse = (part) => part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
}

export function blockedAddress(address, family) {
  if (typeof address !== "string") return true;
  const plain = address.replace(/%.*$/, "");
  if (isIPv4(plain) && family !== 6 && family !== "IPv6") return blockedIPv4(plain);
  if (!isIPv6(plain)) return true;
  const groups = ipv6Groups(plain);
  const leadingZero = groups.slice(0, 5).every((group) => group === 0);
  if (leadingZero && groups[5] === 0xffff) return blockedIPv4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join("."));
  if (leadingZero && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) return true;
  const first = groups[0];
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

export function createStationFetch({ allowPrivate = false, lookup = dns.lookup, timeoutMs = 5000, maxBytes = 1024, agent } = {}) {
  // Node may ask for one address or, for family auto-selection, `all: true` lists; every address offered is checked,
  // and the answer is returned in the shape Node asked for.
  function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    lookup(hostname, options, (error, address, family) => {
      if (error) return callback(error);
      const entries = Array.isArray(address) ? address : address ? [{ address, family: family || isIP(address) }] : [];
      if (!entries.length) return callback(new ProofError("network"));
      if (!allowPrivate && entries.some((entry) => blockedAddress(entry.address, entry.family))) return callback(new ProofError("blocked_address"));
      if (options?.all) callback(null, entries);
      else callback(null, entries[0].address, entries[0].family);
    });
  }

  function send(method, target, payload) {
    let url;
    try { url = new URL(target); } catch { return Promise.reject(new ProofError("network")); }
    // IP literals never reach the lookup, so they are refused here rather than checked.
    if (url.protocol !== "https:" || isIP(unbracket(url.hostname))) return Promise.reject(new ProofError("blocked_address"));
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const headers = body ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length } : { Accept: "text/plain" };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error instanceof ProofError ? error : new ProofError("network"));
        else resolve(value);
      };
      // `agent: false` gives each request its own connection, so no pooled socket skips the lookup check.
      const request = https.request({
        method, protocol: "https:", hostname: unbracket(url.hostname), port: url.port || 443, path: url.pathname + url.search,
        servername: url.hostname, headers, lookup: guardedLookup, agent: agent ?? false
      }, (response) => {
        const status = response.statusCode;
        // Redirects are never followed and a non-2xx body is never needed; a POST only reports its status.
        if (method === "POST" || status < 200 || status > 299) {
          finish(null, method === "POST" ? { status } : { status, body: "" });
          response.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { finish(new ProofError("too_large")); request.destroy(); return; }
          chunks.push(chunk);
        });
        response.on("end", () => finish(null, { status, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", (error) => finish(error));
        response.on("aborted", () => finish(new ProofError("network")));
      });
      const timer = setTimeout(() => { finish(new ProofError("timeout")); request.destroy(); }, timeoutMs);
      request.on("error", (error) => finish(error));
      request.end(body);
    });
  }

  return {
    get: (url) => send("GET", url),
    post: (url, json) => send("POST", url, json)
  };
}

export async function checkProof(origin, value, { fetch }) {
  let reply;
  try {
    reply = await fetch.get(origin + WELL_KNOWN_PATH);
  } catch (error) {
    if (error instanceof ProofError) return { ok: false, reason: error.reason };
    throw error;
  }
  if (reply.status !== 200) return { ok: false, reason: "status_" + reply.status };
  if (reply.body === value || reply.body === value + "\n") return { ok: true };
  return { ok: false, reason: "mismatch" };
}
