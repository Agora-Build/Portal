import { createHmac, randomBytes } from "node:crypto";
import agoraToken from "agora-token";
import { buildRtmToken } from "../atem-core.mjs";
import { AppError } from "../store.mjs";

// Signaling tokens grant login only. Isolation comes from secret-derived channel names and per-space keys;
// AGORA_RTM_PERMISSIONS=true adds Agora's per-channel permissions on top when Agora enables them. Login tokens are signed
// with atem-core (the library Astation uses); permission tokens still use agora-token, as atem-core doesn't build them.
// SPACES_SIGNALING_SECRET derives unlisted and private spaces' channel names and keys. SPACE_CHANNEL_SECRET is its old name, still read.
export function signalingConfig(env = process.env) {
  const appId = env.AGORA_APP_ID || "", certificate = env.AGORA_APP_CERTIFICATE || "", secret = env.SPACES_SIGNALING_SECRET || env.SPACE_CHANNEL_SECRET || "";
  return { appId, certificate, secret, permissions: env.AGORA_RTM_PERMISSIONS === "true", ttl: 900, ready: /^[a-f0-9]{32}$/i.test(appId) && /^[a-f0-9]{32}$/i.test(certificate) && secret.length >= 32 };
}

const mac = (secret, value) => createHmac("sha256", secret).update(value).digest();
export const channelName = (secret, space) => "ab-" + space.type + "-" + (space.visibility === "listed" ? space.slug || space.id : mac(secret, "channel:" + space.id + ":" + (space.channelEpoch || 0)).toString("hex").slice(0, 24));
export const spaceKey = (secret, space) => space.visibility === "listed" ? null : mac(secret, "key:" + space.id + ":" + (space.channelEpoch || 0)).toString("base64");
export const signalingUser = (actor) => actor ? actor.id.replace(/^member:/, "m-") : "g-" + randomBytes(8).toString("hex");

export function createSignaling(config = signalingConfig(), { now = Date.now } = {}) {
  const { RtmTokenBuilder, Rtm2Permissions } = agoraToken;
  return {
    ready: config.ready,
    issue(userId, channels) {
      if (!config.ready) throw new AppError(503, "Live movement and messages are not connected yet.");
      let token;
      if (config.permissions) {
        const permissions = new Rtm2Permissions();
        permissions.add(Rtm2Permissions.kMessageChannels, Rtm2Permissions.kRead, channels.map((channel) => channel.name));
        const writable = channels.filter((channel) => channel.write).map((channel) => channel.name);
        if (writable.length) permissions.add(Rtm2Permissions.kMessageChannels, Rtm2Permissions.kWrite, writable);
        token = RtmTokenBuilder.buildTokenWithPermissions(config.appId, config.certificate, userId, permissions, config.ttl);
      } else token = buildRtmToken({ appId: config.appId, certificate: config.certificate, userId, expire: config.ttl, issuedAt: Math.floor(now() / 1000) });
      return { appId: config.appId, userId, token, expiresAt: new Date(now() + config.ttl * 1000).toISOString() };
    }
  };
}
