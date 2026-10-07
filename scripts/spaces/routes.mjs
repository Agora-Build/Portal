import { AppError } from "../store.mjs";

const SPACE = /^\/api\/spaces\/(plaza|lot-[a-z0-9-]{2,40}|[a-f0-9-]{36})(?:\/(enter|leave|heartbeat|topic|host|decor|remove|invitations|members|rtc-token)(?:\/((?:member|account):[a-f0-9-]{36}))?)?$/;

// Maps HTTP requests to the spaces service. Returns null when the request is not a spaces route.
export async function handleSpaces({ path, method, url, token, read: readBody, spaces, worlds, limit, ip }) {
  const read = async () => { const data = await readBody(); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; };
  if (path === "/api/spaces" && method === "GET") return { status: 200, body: await spaces.list({ q: url.searchParams.get("q") || "" }) };
  if (path === "/api/spaces" && method === "POST") { limit("spaces:" + ip, 20, 3600000); return { status: 201, body: { space: await spaces.create(token, await read()) } }; }
  if (path === "/api/signaling/token" && method === "POST") { limit("signaling:" + ip, 30, 60000); return { status: 200, body: await spaces.signalingToken(token) }; }
  const world = /^\/api\/worlds\/([a-z]+)$/.exec(path);
  if (world && method === "GET") {
    if (!Object.hasOwn(worlds, world[1])) throw new AppError(404, "This world was not found.");
    return { status: 200, body: worlds[world[1]].source };
  }
  const match = SPACE.exec(path);
  if (!match) return null;
  const [, id, action, memberId] = match;
  limit("space:" + ip, 240, 60000);
  if (!action) {
    if (method === "GET") return { status: 200, body: { space: await spaces.get(token, id, url.searchParams.get("invite")) } };
    if (method === "PUT") return { status: 200, body: { space: await spaces.update(token, id, await read()) } };
    if (method === "DELETE") return { status: 200, body: await spaces.destroy(token, id) };
    return null;
  }
  if (memberId) return action === "members" && method === "DELETE" ? { status: 200, body: await spaces.removeMember(token, id, memberId) } : null;
  if (action === "decor" && method === "PUT") return { status: 200, body: await spaces.decorate(token, id, (await read()).items) };
  if (method !== "POST") return null;
  // Leaving and heartbeats carry no body, so navigator.sendBeacon can call them.
  if (action === "leave") return { status: 200, body: await spaces.leave(token, id) };
  if (action === "heartbeat") return { status: 200, body: await spaces.heartbeat(token, id) };
  const input = await read();
  if (action === "enter") return { status: 200, body: await spaces.enter(token, id, input.invite) };
  if (action === "topic") return { status: 200, body: { space: await spaces.topic(token, id, input) } };
  if (action === "host") return { status: 200, body: await spaces.setHost(token, id, input) };
  if (action === "remove") return { status: 200, body: await spaces.removePerson(token, id, input) };
  if (action === "invitations") return { status: 201, body: await spaces.invite(token, id, input) };
  if (action === "members") return { status: 200, body: await spaces.addMember(token, id, input.memberId) };
  if (action === "rtc-token") return { status: 200, body: await spaces.rtcToken(token, id, input) };
  return null;
}
