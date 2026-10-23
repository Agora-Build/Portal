// Agora RTC and RTM tokens for a connected project, signed on agora.build with Atem's atem-core (scripts/atem-core.mjs),
// the library Astation uses, so the App Certificate never leaves the server. The request mirrors Astation's Token
// Tools: an RTC token for a channel and a numeric UID or a string account, publisher, subscriber or explicit
// privileges, optionally with an RTM login; or an RTM token for a user ID.
import { AppError } from "./store.mjs";
import { TokenError, buildRtcToken, buildRtmToken } from "./atem-core.mjs";

export const MAX_TOKEN_EXPIRE = 86400;
const DEFAULT_EXPIRE = 3600;

const expiry = (value, name) => {
  if (value === undefined || value === null) return DEFAULT_EXPIRE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TOKEN_EXPIRE) throw new AppError(422, name + " must be a whole number of seconds from 1 to " + MAX_TOKEN_EXPIRE + ".");
  return value;
};
const text = (value, name, max) => {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).length > max || value.includes("\0")) throw new AppError(422, name + " must be 1 to " + max + " bytes of text.");
  return value;
};

// Validates a request body into atem-core's inputs (without the App ID or certificate).
export function parseTokenRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError(422, "Send a token request.");
  if (input.type === "rtm") return { type: "rtm", userId: text(input.userId, "userId", 64), expire: expiry(input.expire, "expire") };
  if (input.type !== "rtc") throw new AppError(422, "type must be rtc or rtm.");
  const channel = text(input.channel, "channel", 64);
  if (input.account !== undefined && input.uid !== undefined) throw new AppError(422, "Send uid or account, not both.");
  const account = input.account === undefined ? null : text(input.account, "account", 255);
  const uid = input.uid === undefined ? 0 : input.uid;
  if (!Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) throw new AppError(422, "uid must be a whole number from 0 to 4294967295 (0 means any user).");
  const role = input.role === undefined ? "publisher" : input.role;
  if (!["publisher", "subscriber", "explicit"].includes(role)) throw new AppError(422, "role must be publisher, subscriber or explicit.");
  const request = { type: "rtc", channel, uid, account, role, tokenExpire: expiry(input.tokenExpire, "tokenExpire"), privilegeExpire: expiry(input.privilegeExpire, "privilegeExpire") };
  if (role === "explicit") {
    const privileges = input.privileges && typeof input.privileges === "object" ? input.privileges : {};
    for (const name of ["join", "audio", "video", "data"]) request[name] = expiry(privileges[name], "privileges." + name);
  }
  if (input.rtm !== undefined && input.rtm !== null && input.rtm !== false) {
    const rtm = input.rtm === true ? {} : input.rtm;
    if (typeof rtm !== "object" || Array.isArray(rtm)) throw new AppError(422, "rtm must be an object.");
    if (rtm.userId === undefined && account === null) throw new AppError(422, "rtm.userId is needed with a numeric uid.");
    request.rtm = { userId: rtm.userId === undefined ? null : text(rtm.userId, "rtm.userId", 64), expire: expiry(rtm.expire, "rtm.expire") };
  }
  return request;
}

// Signs `request` (from parseTokenRequest) for `project` ({ projectId, appId, certificate }). The reply never carries
// the certificate. Library errors become 422s with Astation's wording, never with the inputs.
export function signToken(project, request, { now = Date.now } = {}) {
  if (!project.appId) throw new AppError(409, "This Agora project has no App ID.");
  if (!project.certificate) throw new AppError(409, "This Agora project has no App Certificate enabled, so it can't sign tokens. Enable one in Agora Console.");
  const issuedAt = Math.floor(now() / 1000);
  let token;
  try {
    token = request.type === "rtm"
      ? buildRtmToken({ appId: project.appId, certificate: project.certificate, userId: request.userId, expire: request.expire, issuedAt })
      : buildRtcToken({ ...request, appId: project.appId, certificate: project.certificate, issuedAt });
  } catch (error) {
    if (error instanceof TokenError) throw new AppError(error.code === 99 ? 503 : 422, error.message);
    throw error;
  }
  const at = (seconds) => new Date((issuedAt + seconds) * 1000).toISOString();
  const reply = { projectId: project.projectId, appId: project.appId, type: request.type, token, issuedAt: at(0) };
  if (request.type === "rtm") return { ...reply, userId: request.userId, expiresAt: at(request.expire) };
  const privileges = request.role === "explicit" ? { join: at(request.join), audio: at(request.audio), video: at(request.video), data: at(request.data) } : { join: at(request.privilegeExpire), ...(request.role === "publisher" ? { audio: at(request.privilegeExpire), video: at(request.privilegeExpire), data: at(request.privilegeExpire) } : {}) };
  return {
    ...reply, channel: request.channel, ...(request.account === null ? { uid: request.uid } : { account: request.account }), role: request.role,
    expiresAt: at(request.tokenExpire), privileges,
    ...(request.rtm ? { rtm: { userId: request.rtm.userId ?? request.account, expiresAt: at(request.rtm.expire) } } : {})
  };
}
