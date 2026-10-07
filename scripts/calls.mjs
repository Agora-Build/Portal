import { randomBytes } from "node:crypto";
import agoraToken from "agora-token";
import { AppError } from "./store.mjs";

export function agoraConfig(env = process.env) {
  const appId = env.AGORA_APP_ID || "";
  const certificate = env.AGORA_APP_CERTIFICATE || "";
  const requested = Number(env.AGORA_TOKEN_TTL_SECONDS) || 3600;
  return { appId, certificate, ttl: Math.max(60, Math.min(3600, Math.floor(requested))), ready: /^[a-f0-9]{32}$/i.test(appId) && /^[a-f0-9]{32}$/i.test(certificate) };
}

export function createAgoraCalls(config = agoraConfig(), { now = Date.now } = {}) {
  return {
    ready: config.ready,
    issue(room, person, input = {}) {
      if (!room.participants.includes(person.id)) throw new AppError(403, "Join this room's roster before entering the call.");
      if (!config.ready) throw new AppError(503, "Agora calls are not connected yet.");
      const prefix = person.id.replace(/^member:/, "") + "_";
      // Each tab gets its own identity; renewals can only reuse this member's IDs.
      const uid = input.uid === undefined ? prefix + randomBytes(6).toString("hex") : input.uid;
      if (typeof uid !== "string" || !uid.startsWith(prefix) || !/^[a-f0-9]{12}$/.test(uid.slice(prefix.length))) throw new AppError(422, "This call identity does not belong to your profile.");
      const channel = "agora-build-" + room.id;
      const screenUid = uid + "_screen";
      const sign = (account) => agoraToken.RtcTokenBuilder.buildTokenWithUserAccount(config.appId, config.certificate, channel, account, agoraToken.RtcRole.PUBLISHER, config.ttl, config.ttl);
      return { provider: "agora", appId: config.appId, channel, uid, screenUid, token: sign(uid), screenToken: sign(screenUid), expiresAt: new Date(now() + config.ttl * 1000).toISOString() };
    }
  };
}
