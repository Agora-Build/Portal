// Canvas 2D renderer. It draws semantic roles and kinds from the theme's data and a fixed catalog of shapes,
// so a WebGL renderer can replace it later by implementing the same resize/setTheme/draw interface.
export const hashTile = (x, y) => (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0;
export const hashText = (text) => [...String(text)].reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) >>> 0, 7);
export function shade(hex, amount) {
  const value = parseInt(hex.slice(1), 16), channel = (shift) => Math.max(0, Math.min(255, Math.round(((value >> shift) & 255) + amount * 255)));
  return "#" + [16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("");
}
const box = (ctx, color, x, y, width, height) => { ctx.fillStyle = color; ctx.fillRect(x, y, width, height); };
const dot = (ctx, color, x, y, radius) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); };

export const PATTERN_DRAW = {
  flat(ctx, x, y, s, [a]) { box(ctx, a, x, y, s, s); },
  tiles(ctx, x, y, s, [a, b = shade(a, -0.08)]) { box(ctx, a, x, y, s, s); ctx.strokeStyle = b; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1); },
  path(ctx, x, y, s, [a, b = shade(a, -0.1)], tile) { box(ctx, a, x, y, s, s); const h = hashTile(tile.x, tile.y); for (let i = 0; i < 3; i += 1) box(ctx, b, x + 3 + ((h >>> (i * 5)) % (s - 8)), y + 3 + ((h >>> (i * 7 + 3)) % (s - 8)), 4, 2); },
  grass(ctx, x, y, s, [a, b = shade(a, -0.12)], tile) {
    box(ctx, a, x, y, s, s); ctx.strokeStyle = b; ctx.lineWidth = 1.2;
    const h = hashTile(tile.x, tile.y);
    for (let i = 0; i < 4; i += 1) { const px = x + 4 + ((h >>> (i * 4)) % (s - 8)), py = y + 6 + ((h >>> (i * 6 + 2)) % (s - 12)); ctx.beginPath(); ctx.moveTo(px, py + 5); ctx.lineTo(px + 1.5, py); ctx.stroke(); }
  },
  water(ctx, x, y, s, [a, b = shade(a, 0.15)], tile, time) {
    box(ctx, a, x, y, s, s); ctx.strokeStyle = b; ctx.lineWidth = 1.5;
    const phase = time / 450 + tile.x + tile.y;
    for (const row of [0.35, 0.72]) { ctx.beginPath(); for (let i = 0; i <= s; i += 4) ctx.lineTo(x + i, y + s * row + Math.sin(phase + i / 5) * 1.5); ctx.stroke(); }
  },
  wall(ctx, x, y, s, [a, b = shade(a, -0.15), c = shade(a, 0.1)]) { box(ctx, a, x, y, s, s); box(ctx, c, x, y, s, 4); box(ctx, b, x, y + s / 3, s, 1); box(ctx, b, x, y + (2 * s) / 3, s, 1); box(ctx, b, x + s / 2, y + 4, 1, s / 3 - 4); },
  column(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 5, y + s - 7, s - 10, 4); box(ctx, a, x + 9, y + 7, s - 18, s - 14); box(ctx, b, x + 6, y + 3, s - 12, 4); },
  door(ctx, x, y, s, [a, b = shade(a, -0.25)]) { box(ctx, b, x + 2, y, s - 4, s); box(ctx, a, x + 5, y + 3, s - 10, s - 3); },
  table(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 1, y + 4, s - 2, s - 4); box(ctx, a, x + 1, y + 1, s - 2, s - 6); },
  seat(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 8, y + 12, s - 16, s - 18); box(ctx, a, x + 8, y + 8, s - 16, s - 20); },
  plant(ctx, x, y, s, [a, b = "#8a5a3c"]) { box(ctx, b, x + 11, y + s - 11, s - 22, 9); dot(ctx, a, x + s / 2, y + s / 2 - 2, s / 4); dot(ctx, shade(a, 0.08), x + s / 2 - 5, y + s / 2 + 1, s / 6); dot(ctx, shade(a, -0.06), x + s / 2 + 5, y + s / 2, s / 6); },
  decor(ctx, x, y, s, [a]) { ctx.fillStyle = a; ctx.beginPath(); ctx.moveTo(x + s / 2, y + 6); ctx.lineTo(x + s - 6, y + s / 2); ctx.lineTo(x + s / 2, y + s - 6); ctx.lineTo(x + 6, y + s / 2); ctx.fill(); },
  neon(ctx, x, y, s, [a, b = "#00e5ff"]) { box(ctx, a, x, y, s, s); ctx.globalAlpha = 0.35; ctx.strokeStyle = b; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1); ctx.globalAlpha = 1; }
};

export const DECOR_DRAW = {
  plant: (ctx, x, y, s, colors) => PATTERN_DRAW.plant(ctx, x, y, s, colors),
  lamp(ctx, x, y, s, [a, b = shade(a, -0.3)]) { box(ctx, b, x + s / 2 - 1, y + 10, 2, s - 14); box(ctx, b, x + 10, y + s - 5, s - 20, 3); dot(ctx, a, x + s / 2, y + 9, 6); },
  rug(ctx, x, y, s, [a, b = shade(a, -0.15)]) { box(ctx, b, x + 2, y + 6, s - 4, s - 12); box(ctx, a, x + 5, y + 9, s - 10, s - 18); },
  sofa(ctx, x, y, s, [a, b = shade(a, -0.18)]) { box(ctx, b, x + 3, y + 8, s - 6, s - 14); box(ctx, a, x + 6, y + 13, s - 12, s - 22); },
  chair(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 9, y + 7, s - 18, 6); box(ctx, a, x + 9, y + 13, s - 18, s - 22); },
  table: (ctx, x, y, s, colors) => PATTERN_DRAW.table(ctx, x, y, s, colors),
  whiteboard(ctx, x, y, s, [a, b = shade(a, -0.4)]) { box(ctx, b, x + 3, y + 5, s - 6, s - 14); box(ctx, a, x + 5, y + 7, s - 10, s - 18); box(ctx, b, x + 8, y + s - 9, 2, 6); box(ctx, b, x + s - 10, y + s - 9, 2, 6); },
  bookshelf(ctx, x, y, s, [a, b = shade(a, -0.25), c = shade(a, 0.25)]) { box(ctx, b, x + 4, y + 3, s - 8, s - 6); for (let i = 0; i < 5; i += 1) { box(ctx, i % 2 ? a : c, x + 7 + i * 4, y + 6, 3, s / 2 - 6); box(ctx, i % 2 ? c : a, x + 7 + i * 4, y + s / 2 + 1, 3, s / 2 - 7); } },
  screen(ctx, x, y, s, [a, b = "#111318"]) { box(ctx, b, x + 3, y + 6, s - 6, s - 15); box(ctx, a, x + 5, y + 8, s - 10, s - 19); box(ctx, b, x + s / 2 - 2, y + s - 9, 4, 6); },
  banner(ctx, x, y, s, [a, b = shade(a, -0.3)]) { box(ctx, b, x + 9, y + 3, 2, s - 6); ctx.fillStyle = a; ctx.beginPath(); ctx.moveTo(x + 11, y + 4); ctx.lineTo(x + s - 7, y + 4); ctx.lineTo(x + s - 7, y + s / 2 + 4); ctx.lineTo(x + (s + 4) / 2, y + s / 2 - 1); ctx.lineTo(x + 11, y + s / 2 + 4); ctx.fill(); },
  poster(ctx, x, y, s, [a, b = shade(a, -0.35)]) { box(ctx, b, x + 7, y + 5, s - 14, s - 10); box(ctx, a, x + 9, y + 7, s - 18, s - 14); },
  statue(ctx, x, y, s, [a, b = shade(a, -0.2)]) { box(ctx, b, x + 7, y + s - 10, s - 14, 7); box(ctx, a, x + 12, y + 11, s - 24, s - 21); dot(ctx, a, x + s / 2, y + 9, 5); },
  fountain(ctx, x, y, s, [a, b = "#7fa3a8"]) { dot(ctx, a, x + s / 2, y + s / 2, s / 2 - 2); dot(ctx, b, x + s / 2, y + s / 2, s / 2 - 6); dot(ctx, a, x + s / 2, y + s / 2, 3); },
  noticeboard(ctx, x, y, s, [a, b = shade(a, -0.3), c = "#fffef9"]) { box(ctx, b, x + 7, y + s - 10, 3, 9); box(ctx, b, x + s - 10, y + s - 10, 3, 9); box(ctx, b, x + 3, y + 4, s - 6, s - 13); box(ctx, a, x + 5, y + 6, s - 10, s - 17); box(ctx, c, x + 8, y + 9, 6, 5); box(ctx, c, x + 17, y + 11, 6, 4); }
};

const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase();

function label(ctx, text, cx, top, font, theme) {
  ctx.font = "500 10px " + font;
  const width = ctx.measureText(text).width + 8;
  ctx.globalAlpha = 0.85; box(ctx, theme.ui?.["--ink"] || "#272d28", cx - width / 2, top, width, 14); ctx.globalAlpha = 1;
  ctx.fillStyle = theme.ui?.["--surface"] || "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, cx, top + 7.5);
}

function drawAvatar(ctx, avatar, s, theme, font) {
  const color = theme.avatar.palette[hashText(avatar.id) % theme.avatar.palette.length];
  const cx = (avatar.x + 0.5) * s, cy = (avatar.y + 0.5) * s;
  ctx.lineWidth = 2; ctx.strokeStyle = theme.avatar.outline;
  if (theme.avatar.style === "pawn") {
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(cx, cy + 6, 9, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    dot(ctx, color, cx, cy - 6, 6); ctx.beginPath(); ctx.arc(cx, cy - 6, 6, 0, Math.PI * 2); ctx.stroke();
  } else {
    dot(ctx, color, cx, cy, s * 0.36); ctx.beginPath(); ctx.arc(cx, cy, s * 0.36, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#ffffff"; ctx.font = "600 10px " + font; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(initials(avatar.name), cx, cy + 0.5);
  }
  if (avatar.self) { ctx.strokeStyle = theme.ui?.["--accent"] || theme.avatar.outline; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2); ctx.stroke(); }
  label(ctx, avatar.name, cx, cy + s * 0.62, font, theme);
}

function drawEffects(ctx, theme, width, height, time) {
  for (const effect of theme.effects) {
    if (effect === "dust") {
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      for (let i = 0; i < 40; i += 1) { const h = hashTile(i, 7); ctx.fillRect(((h % 1000) / 1000) * width + Math.sin(time / 3000 + i) * 12, ((((h >>> 10) % 1000) / 1000) * height + (time / 80) * (((i % 3) + 1) * 0.2)) % height, 2, 2); }
    } else if (effect === "rain") {
      ctx.strokeStyle = "rgba(160, 220, 255, 0.35)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 0; i < 90; i += 1) { const h = hashTile(i, 3), x = ((((h % 1000) / 1000) * (width + 40) + time / 6) % (width + 40)) - 20, y = ((((h >>> 10) % 1000) / 1000) * height + time / 2.5) % height; ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 12); }
      ctx.stroke();
    } else if (effect === "leaves") {
      ctx.fillStyle = theme.decor.plant.colors[0];
      for (let i = 0; i < 18; i += 1) { const h = hashTile(i, 11); ctx.beginPath(); ctx.ellipse(((((h % 1000) / 1000) * width + Math.sin(time / 900 + i) * 20) + width) % width, ((((h >>> 10) % 1000) / 1000) * height + time / 40) % height, 4, 2, (time / 500 + i) % Math.PI, 0, Math.PI * 2); ctx.fill(); }
    }
  }
}

export function createCanvasRenderer(canvas, { map, theme }) {
  const ctx = canvas.getContext("2d"), s = map.tileSize;
  let current = theme, viewport = { width: 1, height: 1, ratio: 1 };
  function tile(role, x, y, time) {
    const entry = current.roles[role];
    const glow = current.effects.includes("neon-glow") && (role === "door" || entry.pattern === "neon");
    if (glow) { ctx.shadowColor = current.roles.door.colors[0]; ctx.shadowBlur = 10; }
    PATTERN_DRAW[entry.pattern](ctx, x * s, y * s, s, entry.colors, { x, y }, time);
    if (glow) ctx.shadowBlur = 0;
  }
  function decorItem(item) {
    const entry = current.decor[item.kind];
    if (!entry) return;
    ctx.save(); ctx.translate((item.x + 0.5) * s, (item.y + 0.5) * s); ctx.rotate(((item.rotation || 0) * Math.PI) / 180); ctx.translate(-s / 2, -s / 2);
    DECOR_DRAW[item.kind](ctx, 0, 0, s, entry.variants?.[item.variant || 0] || entry.colors);
    ctx.restore();
  }
  return {
    resize(width, height, ratio = 1) { viewport = { width, height, ratio }; canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); },
    setTheme(next) { current = next; },
    draw({ camera, time = 0, avatars = [], decor = [], labels = [], motion = true }) {
      const { width, height, ratio } = viewport, font = current.ui?.font || "IBM Plex Sans", t = motion ? time : 0;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      box(ctx, current.ui?.["--paper"] || "#111111", 0, 0, width, height);
      ctx.save(); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
      const x0 = Math.max(0, Math.floor(camera.x / s)), y0 = Math.max(0, Math.floor(camera.y / s));
      const x1 = Math.min(map.width - 1, Math.floor((camera.x + width / camera.zoom) / s)), y1 = Math.min(map.height - 1, Math.floor((camera.y + height / camera.zoom) / s));
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
        const index = y * map.width + x, role = map.roles[index], ground = map.ground[index];
        if (ground && ground !== role) tile(ground, x, y, t);
        if (role) tile(role, x, y, t);
      }
      for (const item of map.interactables) decorItem(item);
      for (const item of decor) decorItem(item);
      for (const entry of labels) label(ctx, entry.text, (entry.x + 0.5) * s, entry.y * s + 4, font, current);
      for (const avatar of [...avatars].sort((a, b) => a.y - b.y)) drawAvatar(ctx, avatar, s, current, font);
      ctx.restore();
      if (current.lighting.ambient < 1) { ctx.globalAlpha = (1 - current.lighting.ambient) * 0.6; box(ctx, current.lighting.tint, 0, 0, width, height); ctx.globalAlpha = 1; }
      if (motion) drawEffects(ctx, current, width, height, time);
    }
  };
}
