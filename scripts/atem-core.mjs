// Agora AccessToken2 (RTC and RTM) through Atem's atem-core, the library Astation signs tokens with. The WebAssembly
// module (scripts/vendor/atem-core.wasm, built from native/atem-core-wasm at the Atem revision Astation pins) exports
// atem-core-ffi's C ABI 1 unchanged; this file lays out its parameter structs and C strings in the module's memory,
// exactly as Astation's Swift does natively. The host always supplies the issue time and a random non-zero salt, and
// fills the module's random requests (env.portal_random) from node:crypto.
import { readFileSync } from "node:fs";
import { randomFillSync, randomInt } from "node:crypto";

export const ATEM_CORE_ABI_VERSION = 1;
export const ROLES = { explicit: 0, publisher: 1, subscriber: 2 };
const OK = 0;
// Struct sizes on wasm32, where pointers and u32 are both 4 bytes (include/atem_core.h).
const RTC_FIELDS = ["struct_size", "app_id", "app_certificate", "channel", "uid", "user_account", "role", "token_expire", "privilege_expire", "join_channel_expire", "publish_audio_expire", "publish_video_expire", "publish_data_expire", "with_rtm", "rtm_user_id", "rtm_expire", "issued_at", "salt"];
const RTM_FIELDS = ["struct_size", "app_id", "app_certificate", "user_id", "expire", "issued_at", "salt"];
// The same wording Astation shows for each status code (AgoraTokenService.swift). The library's own message is never
// passed on, so no input can reach a reply or a log through it.
const MESSAGES = {
  10: "The App ID must contain 32 hexadecimal characters.",
  11: "This project needs a valid App Certificate to generate or verify tokens.",
  12: "Enter a channel name between 1 and 64 UTF-8 bytes.",
  13: "Enter a user account between 1 and 255 UTF-8 bytes.",
  14: "Enter an RTM user ID between 1 and 64 UTF-8 bytes.",
  15: "Every expiry must be at least one second.",
  20: "Only AccessToken2 tokens beginning with 007 are supported.",
  21: "This token could not be decoded. Check that you pasted the complete token."
};

export class TokenError extends Error {
  constructor(code, message = MESSAGES[code] || "The token operation failed. Please try again.") { super(message); this.code = code; }
}

const wasmUrl = new URL("./vendor/atem-core.wasm", import.meta.url);
let module, instance;
function core() {
  if (!instance) {
    module ||= new WebAssembly.Module(readFileSync(wasmUrl));
    let memory;
    const env = { portal_random: (pointer, length) => { try { randomFillSync(new Uint8Array(memory.buffer, pointer, length)); return 0; } catch { return 1; } } };
    instance = new WebAssembly.Instance(module, { env });
    memory = instance.exports.memory;
    if (instance.exports.atem_core_abi_version() !== ATEM_CORE_ABI_VERSION) { instance = null; throw new TokenError(99, "The token library is incompatible with this server."); }
  }
  return instance.exports;
}

// Runs one call with its own allocations, freed afterwards. A trap discards the instance so the next call starts clean.
function withMemory(work) {
  const exports = core(), allocations = [];
  const alloc = (size) => {
    const pointer = exports.portal_alloc(size);
    if (!pointer) throw new TokenError(99);
    allocations.push([pointer, size]);
    return pointer;
  };
  const cString = (value) => {
    if (value === null || value === undefined) return 0;
    const text = String(value);
    if (text.includes("\0")) throw new TokenError(4, "Token fields cannot contain a NUL character.");
    const bytes = new TextEncoder().encode(text);
    const pointer = alloc(bytes.length + 1);
    new Uint8Array(exports.memory.buffer, pointer, bytes.length + 1).set([...bytes, 0]);
    return pointer;
  };
  const readCString = (pointer) => {
    const bytes = new Uint8Array(exports.memory.buffer);
    let end = pointer;
    while (bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(pointer, end));
  };
  const struct = (fields, values) => {
    const pointer = alloc(fields.length * 4), view = new DataView(exports.memory.buffer);
    fields.forEach((field, index) => view.setUint32(pointer + index * 4, field === "struct_size" ? fields.length * 4 : values[field] ?? 0, true));
    return pointer;
  };
  // Calls fn(...args, out, outError); returns the result string, which atem_core_string_free releases.
  const call = (fn, ...args) => {
    const slots = alloc(8), view = () => new DataView(exports.memory.buffer);
    const status = exports[fn](...args, slots, slots + 4);
    const value = view().getUint32(slots, true), error = view().getUint32(slots + 4, true);
    const text = status === OK && value ? readCString(value) : null;
    exports.atem_core_string_free(value); exports.atem_core_string_free(error);
    if (status !== OK || text === null) throw new TokenError(status || 99);
    return text;
  };
  try { return work({ exports, cString, struct, call, alloc }); }
  catch (error) { if (error instanceof WebAssembly.RuntimeError) { instance = null; throw new TokenError(99); } throw error; }
  finally { if (instance) for (const [pointer, size] of allocations) exports.portal_free(pointer, size); }
}

const u32 = (value, fallback) => {
  const number = value === undefined ? fallback : value;
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) throw new TokenError(4, "Token numbers must be whole numbers from 0 to 4294967295.");
  return number;
};
// The salt is drawn from 1..99,999,998, the range atem-core and Agora's own builders use.
const issue = ({ issuedAt, salt } = {}) => ({ issued_at: u32(issuedAt, Math.floor(Date.now() / 1000)), salt: salt === undefined ? randomInt(1, 99999999) : u32(salt) });

// An RTC token. `account` (a string) or `uid` (a number; 0 means any user). `role` is "publisher", "subscriber" or
// "explicit" (with `join`, `audio`, `video`, `data` expiries). `rtm: { userId?, expire }` adds an RTM login, reusing
// the account when no userId is given. Expiries are seconds after issue.
export function buildRtcToken({ appId, certificate, channel, uid = 0, account = null, role = "publisher", tokenExpire = 3600, privilegeExpire = 3600, join = 0, audio = 0, video = 0, data = 0, rtm = null, issuedAt, salt }) {
  if (!(role in ROLES)) throw new TokenError(4, "Choose publisher, subscriber or explicit privileges.");
  return withMemory(({ cString, struct, call }) => call("atem_core_build_rtc_token", struct(RTC_FIELDS, {
    app_id: cString(appId), app_certificate: cString(certificate), channel: cString(channel),
    uid: account === null ? u32(uid) : 0, user_account: cString(account), role: ROLES[role],
    token_expire: u32(tokenExpire), privilege_expire: u32(privilegeExpire),
    join_channel_expire: u32(join), publish_audio_expire: u32(audio), publish_video_expire: u32(video), publish_data_expire: u32(data),
    with_rtm: rtm ? 1 : 0, rtm_user_id: cString(rtm?.userId ?? null), rtm_expire: rtm ? u32(rtm.expire, 3600) : 0,
    ...issue({ issuedAt, salt })
  })));
}

// An RTM login token for `userId`.
export function buildRtmToken({ appId, certificate, userId, expire = 3600, issuedAt, salt }) {
  return withMemory(({ cString, struct, call }) => call("atem_core_build_rtm_token", struct(RTM_FIELDS, {
    app_id: cString(appId), app_certificate: cString(certificate), user_id: cString(userId), expire: u32(expire), ...issue({ issuedAt, salt })
  })));
}

// The fields of an AccessToken2 token (decoding does not establish authenticity).
export function decodeToken(token) {
  if (typeof token !== "string" || token.length > 65536) throw new TokenError(21);
  return JSON.parse(withMemory(({ cString, call }) => call("atem_core_decode_token", cString(token))));
}

// Whether `certificate` signed `token`. Says nothing about expiry or privileges.
export function verifyTokenSignature(token, certificate) {
  if (typeof token !== "string" || token.length > 65536) throw new TokenError(21);
  return withMemory(({ exports, cString, alloc }) => {
    const slots = alloc(8), status = exports.atem_core_verify_token_signature(cString(token), cString(certificate), slots, slots + 4);
    const view = new DataView(exports.memory.buffer), valid = view.getInt32(slots, true);
    exports.atem_core_string_free(view.getUint32(slots + 4, true));
    if (status !== OK) throw new TokenError(status);
    return valid === 1;
  });
}
