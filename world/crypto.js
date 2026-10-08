// End-to-end payload encryption for unlisted and private spaces. The server derives one key per space and channel epoch.
const toBytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const toBase64 = (bytes) => { let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };

export const importKey = (base64) => globalThis.crypto.subtle.importKey("raw", toBytes(base64), "AES-GCM", false, ["encrypt", "decrypt"]);

export async function seal(key, text) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv); out.set(sealed, 12);
  return "e1." + toBase64(out);
}

export async function open(key, value) {
  if (typeof value !== "string" || !value.startsWith("e1.")) return null;
  try {
    const data = toBytes(value.slice(3));
    if (data.length < 29) return null;
    return new TextDecoder().decode(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12)));
  } catch { return null; }
}
