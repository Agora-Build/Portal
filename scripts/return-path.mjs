// The site's pages, each served at /<name>/ from <name>.html; the home page is "/", and the Stoa has its own routes under /stoa/.
export const pages = ["explore", "services", "radar", "account"];
// Where an old (/<name>.html) or slash-less (/<name>) page address now lives, or null when it isn't one.
export function cleanPagePath(path) {
  if (path === "/index" || path === "/index.html") return "/";
  const match = /^\/([a-z]+)(\.html)?$/.exec(path);
  return match && (pages.includes(match[1]) || match[1] === "stoa") ? "/" + match[1] + "/" : null;
}

// Where a browser may be sent back to after signing in: same-site pages only, never another origin.
export function returnPath(value) {
  if (typeof value !== "string" || value.length > 1500 || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
  const url = new URL(value, "https://foundry.invalid");
  url.pathname = cleanPagePath(url.pathname) || url.pathname;
  const stoa = /^\/stoa\/(?:room\/[a-z0-9-]{2,40}|s\/[a-f0-9-]{36})?$/.test(url.pathname);
  if (url.pathname !== "/" && !pages.some((name) => url.pathname === "/" + name + "/") && !stoa && !/^\/meet\/[a-f0-9-]{36}$/.test(url.pathname)) return "/";
  url.searchParams.delete("signin");
  return url.pathname + url.search + url.hash;
}

// The same path with ?signin=<outcome>, keeping its other query parameters and fragment.
export function withSignin(path, outcome) {
  const url = new URL(returnPath(path), "https://foundry.invalid");
  url.searchParams.set("signin", outcome);
  return url.pathname + url.search + url.hash;
}
