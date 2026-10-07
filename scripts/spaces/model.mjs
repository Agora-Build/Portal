import { AppError } from "../store.mjs";
import { validCombination } from "./permissions.mjs";

export const DECOR_KINDS = ["plant", "lamp", "rug", "sofa", "chair", "table", "whiteboard", "bookshelf", "screen", "banner", "poster", "statue", "fountain"];
export const THEMES = ["agora", "minimal", "cyberpunk"];
export const PLAZA_ID = "plaza";
export const PLAZA_CAPACITY = 1000;
export const lotSpaceId = (slug) => "lot-" + slug;
const pick = (input, field, fallback) => input[field] === undefined ? fallback : input[field];

export function spaceInput(input, current = {}) {
  const value = { title: pick(input, "title", current.title), purpose: pick(input, "purpose", current.purpose ?? ""), visibility: pick(input, "visibility", current.visibility ?? "unlisted"), access: pick(input, "access", current.access ?? "members"), capacity: pick(input, "capacity", current.capacity ?? 12), themeId: pick(input, "themeId", current.themeId ?? "agora") };
  if (typeof value.title !== "string" || value.title.trim().length < 2 || value.title.trim().length > 80) throw new AppError(422, "Add a title of 2 to 80 characters.");
  if (typeof value.purpose !== "string" || value.purpose.trim().length > 300) throw new AppError(422, "Keep the purpose under 300 characters.");
  if (!["unlisted", "private"].includes(value.visibility)) throw new AppError(422, "Your spaces are unlisted or private.");
  if (!validCombination(value.visibility, value.access)) throw new AppError(422, "A private space admits members and invited people only.");
  if (!Number.isInteger(value.capacity) || value.capacity < 2 || value.capacity > 50) throw new AppError(422, "Choose a capacity from 2 to 50.");
  if (!THEMES.includes(value.themeId)) throw new AppError(422, "Choose an available theme.");
  return { ...value, title: value.title.trim(), purpose: value.purpose.trim() };
}

export function normalizeTags(value = []) {
  if (!Array.isArray(value) || value.length > 5 || value.some((tag) => typeof tag !== "string")) throw new AppError(422, "Add up to 5 tags.");
  const tags = [...new Set(value.map((tag) => tag.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean))];
  if (tags.some((tag) => tag.length > 30)) throw new AppError(422, "Keep each tag under 30 characters.");
  return tags;
}

const runtime = () => ({ invitations: [], blocked: [], channelEpoch: 0, hostId: null, topic: null, tags: [], decor: [], decorVersion: 0 });

export function newSpace(fields, { id, ownerId, now }) {
  const at = new Date(now).toISOString();
  return { id, type: "stoa", worldId: "room", ...fields, ownerId, members: [ownerId], ...runtime(), createdAt: at, updatedAt: at };
}

export function systemSpaces(plazaMap, now, plazaCapacity = PLAZA_CAPACITY) {
  const at = new Date(now).toISOString();
  const base = { type: "stoa", worldId: "plaza", themeId: "agora", visibility: "listed", access: "open", ownerId: null, members: [], ...runtime(), purpose: "", createdAt: at, updatedAt: at };
  return [{ ...base, id: PLAZA_ID, title: "The plaza", capacity: plazaCapacity }, ...plazaMap.lots.map((lot) => ({ ...base, id: lotSpaceId(lot.slug), slug: lot.slug, lot: { worldId: "plaza", lotId: lot.lotId }, title: lot.title, capacity: lot.capacity }))];
}

export function migratedRoom(room, now) {
  const space = newSpace({ title: String(room.title || "Meeting room").slice(0, 80), purpose: String(room.intent || "").slice(0, 300), visibility: "unlisted", access: "members", capacity: 12, themeId: "agora" }, { id: room.id, ownerId: room.ownerId, now });
  return { ...space, members: [...new Set([room.ownerId, ...(room.participants || [])])], createdAt: room.createdAt || space.createdAt };
}

export function publicSpace(space, { occupants = [], manage = false } = {}) {
  const { invitations, blocked, members, channelEpoch, ...rest } = space;
  return { ...rest, occupancy: occupants.length, occupants, ...(manage ? { members, blocked, invitations: invitations.map(({ tokenHash, ...entry }) => entry) } : {}) };
}
