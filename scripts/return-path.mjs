// Where a browser may be sent back to after signing in: same-site pages only, never another origin.
export function returnPath(value) {
  if (typeof value !== "string" || value.length > 1500 || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
  const url = new URL(value, "https://foundry.invalid");
  const stoa = /^\/stoa\/(?:room\/[a-z0-9-]{2,40}|s\/[a-f0-9-]{36})?$/.test(url.pathname);
  if (!["/", "/index.html", "/explore.html", "/radar.html", "/services.html", "/account.html"].includes(url.pathname) && !stoa && !/^\/meet\/[a-f0-9-]{36}$/.test(url.pathname)) return "/";
  url.searchParams.delete("signin");
  return url.pathname + url.search + url.hash;
}

// The same path with ?signin=<outcome>, keeping its other query parameters and fragment.
export function withSignin(path, outcome) {
  const url = new URL(returnPath(path), "https://foundry.invalid");
  url.searchParams.set("signin", outcome);
  return url.pathname + url.search + url.hash;
}
