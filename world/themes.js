import { CORE_ROLES } from "./map.js";
import { THEMED_KINDS } from "./kinds.js";

// Themes are data only: patterns, shapes, and effects come from fixed catalogs the renderer implements.
export const PATTERNS = ["flat", "tiles", "path", "grass", "water", "wall", "column", "door", "table", "seat", "plant", "decor", "neon"];
export const EFFECTS = ["dust", "rain", "leaves", "neon-glow"];
export const UI_TOKENS = ["--paper", "--surface", "--ink", "--muted", "--line", "--accent", "--accent-dark", "--green"];
export const FONTS = ["IBM Plex Sans", "IBM Plex Mono", "Georgia", "system-ui"];
export const AVATAR_STYLES = ["token", "pawn"];
export const VIDEO_LAYOUTS = ["over-avatar", "strip", "grid"];
export const MANIFEST_LIMIT = 65536;
const COLOR = /^#[0-9a-f]{6}$/i;

export function validateTheme(theme) {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) return ["A theme must be an object."];
  const errors = [];
  const colors = (value, where, min = 1, max = 4) => { if (!Array.isArray(value) || value.length < min || value.length > max || !value.every((color) => typeof color === "string" && COLOR.test(color))) errors.push(where + " needs " + min + " to " + max + " colors like #a1b2c3."); };
  const checkKeys = (obj, allowed, where) => { if (obj) for (const key of Object.keys(obj)) if (!allowed.includes(key)) errors.push("The theme has an unknown field: " + where + "." + key + "."); };
  if (JSON.stringify(theme).length > MANIFEST_LIMIT) errors.push("The theme is larger than 64 KB.");
  if (typeof theme.id !== "string" || !/^[a-z0-9-]{2,40}$/.test(theme.id)) errors.push("The theme needs an id of 2 to 40 lowercase letters, digits, or dashes.");
  if (typeof theme.name !== "string" || theme.name.length < 2 || theme.name.length > 40) errors.push("The theme needs a name of 2 to 40 characters.");
  if (theme.version !== 1) errors.push("Only theme version 1 is supported.");
  checkKeys(theme, ["id", "name", "version", "roles", "decor", "avatar", "ui", "lighting", "effects", "video"], "");
  for (const role of CORE_ROLES) {
    const entry = theme.roles?.[role];
    if (!entry) { errors.push("The theme does not draw the " + role + " role."); continue; }
    checkKeys(entry, ["pattern", "colors"], "roles." + role);
    if (!PATTERNS.includes(entry.pattern)) errors.push("The " + role + " role uses an unknown pattern.");
    colors(entry.colors, "The " + role + " role");
  }
  for (const roleKey of Object.keys(theme.roles || {})) {
    if (!CORE_ROLES.includes(roleKey)) errors.push("The theme has an unknown field: roles." + roleKey + ".");
  }
  for (const kind of THEMED_KINDS) {
    const entry = theme.decor?.[kind];
    if (!entry) { errors.push("The theme does not draw the " + kind + " decoration."); continue; }
    checkKeys(entry, ["colors", "variants"], "decor." + kind);
    colors(entry.colors, "The " + kind + " decoration");
    if (entry.variants === undefined) continue;
    if (!Array.isArray(entry.variants) || entry.variants.length > 8) errors.push("The " + kind + " decoration may have up to 8 variants.");
    else entry.variants.forEach((variant, index) => colors(variant, "Variant " + index + " of " + kind));
  }
  for (const kindKey of Object.keys(theme.decor || {})) {
    if (!THEMED_KINDS.includes(kindKey)) errors.push("The theme has an unknown field: decor." + kindKey + ".");
  }
  if (!AVATAR_STYLES.includes(theme.avatar?.style)) errors.push("Choose an avatar style: token or pawn.");
  checkKeys(theme.avatar, ["style", "palette", "outline"], "avatar");
  colors(theme.avatar?.palette, "The avatar palette", 4, 12);
  colors([theme.avatar?.outline], "The avatar outline");
  for (const [token, value] of Object.entries(theme.ui || {})) {
    if (token === "font") { if (!FONTS.includes(value)) errors.push("Choose an available font."); }
    else if (!UI_TOKENS.includes(token)) errors.push("The ui token " + token + " is not allowed.");
    else if (typeof value !== "string" || !COLOR.test(value)) errors.push("The ui token " + token + " must be a color like #a1b2c3.");
  }
  checkKeys(theme.lighting, ["ambient", "tint"], "lighting");
  const ambient = theme.lighting?.ambient;
  if (!Number.isFinite(ambient) || ambient < 0 || ambient > 1) errors.push("Lighting ambient must be between 0 and 1.");
  colors([theme.lighting?.tint], "The lighting tint");
  if (!Array.isArray(theme.effects) || theme.effects.some((effect) => !EFFECTS.includes(effect))) errors.push("Effects must come from the built-in list.");
  if (!VIDEO_LAYOUTS.includes(theme.video)) errors.push("Choose a video layout: over-avatar, strip, or grid.");
  return errors;
}
