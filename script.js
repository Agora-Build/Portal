export const state = { profile: null, account: null, people: [] };
export const requestKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child !== null && child !== undefined) node.append(typeof child === "string" ? document.createTextNode(child) : child);
  return node;
}
export function avatar(person, size = "") {
  if (person.avatar) return el("img", { class: "avatar " + size, src: person.avatar.startsWith("assets/") ? "/" + person.avatar : person.avatar, alt: person.name, loading: "lazy", width: "48", height: "48" });
  return el("span", { class: "avatar avatar-initials " + size, "aria-hidden": "true", text: person.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase() });
}
export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || "Something went wrong."); error.status = response.status; error.data = data; throw error; }
  return data;
}
let toastTimer;
export function notify(message) {
  const output = document.querySelector("#toast");
  output.textContent = message;
  output.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => output.classList.remove("is-visible"), 4500);
}
export async function refreshSession() {
  const result = await api("/api/me");
  state.profile = result.profile;
  state.account = result.account;
  state.sessionLoaded = true;
  document.querySelectorAll("[data-join]").forEach((button) => {
    button.textContent = state.profile ? button.dataset.memberLabel || "Your profile" : button.dataset.guestLabel || "Join the house";
  });
  document.dispatchEvent(new CustomEvent("house:session", { detail: state.profile }));
  renderSignIn();
  return state.profile;
}
let afterJoin;
state.authConfig = null;
// A same-site path ("/..." but never "//host" or a backslash trick), or null.
export const samePath = (value) => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\\r\n]/.test(value) ? value : null;
// Where sign-in returns to: this page, or on the account page the page that sent the visitor there.
export const returnTarget = () => (location.pathname === "/account/" && samePath(new URLSearchParams(location.search).get("returnTo"))) || location.pathname + location.search;
// Sign in is one step: straight to auth.agora.build through /auth/login. The account page also offers the browser-only choice.
export const signInHref = () => "/auth/login?returnTo=" + encodeURIComponent(returnTarget());
export const seatHref = () => "/account/?returnTo=" + encodeURIComponent(location.pathname + location.search);
const signInUnavailable = () => Boolean(state.authConfig) && !state.authConfig.issuer;
export function signIn() {
  if (signInUnavailable()) { notify("Sign-in is temporarily unavailable. Try again in a little while."); return; }
  location.assign(signInHref());
}
// Links marked data-signin go to the IdP; data-signin="seat" goes to the account page, where a visitor can also continue with this browser.
export function syncSignInLinks() {
  for (const link of document.querySelectorAll("a[data-signin]")) {
    const seat = link.dataset.signin === "seat";
    link.href = seat ? seatHref() : signInHref();
    const disabled = !seat && signInUnavailable();
    if (disabled) link.setAttribute("aria-disabled", "true"); else link.removeAttribute("aria-disabled");
    link.classList.toggle("is-disabled", disabled);
  }
}
// The address can change without a reload (the Stoa rewrites it), so a link's returnTo is refreshed just before it is used.
for (const type of ["pointerdown", "focusin"]) document.addEventListener(type, (event) => { if (event.target.closest?.("a[data-signin]")) syncSignInLinks(); }, true);
document.addEventListener("click", (event) => { if (event.target.closest("a[data-signin][aria-disabled=true]")) event.preventDefault(); });
const manageLogin = el("a", { class: "inline-link profile-login-control", href: "/account/", text: "Sign in" });
document.querySelector("#profile-form .dialog-actions").append(manageLogin);

function renderSignIn() {
  const account = state.account;
  manageLogin.textContent = account ? "Account & sign out" : "Sign in";
  if (account) { manageLogin.removeAttribute("data-signin"); manageLogin.removeAttribute("aria-disabled"); manageLogin.classList.remove("is-disabled"); manageLogin.href = "/account/"; }
  else manageLogin.setAttribute("data-signin", "");
  syncSignInLinks();
}
export const authConfigReady = api("/api/auth/config").catch(() => ({ issuer: null, accountUrl: null })).then((result) => { state.authConfig = result; renderSignIn(); return result; });

export function openJoin(callback, browserOnly = false) {
  afterJoin = typeof callback === "function" ? callback : null;
  if (!state.profile && !state.account && !browserOnly) {
    // Not here yet: the account page offers Sign in and Continue with this browser.
    const here = document.querySelector("#account-login:not([hidden])");
    if (here) here.focus(); else location.assign(seatHref());
    return;
  }
  const form = document.querySelector("#profile-form");
  const person = state.profile;
  form.reset();
  document.querySelector("#join-title").textContent = person ? "Your place in the house." : "Pull up a chair.";
  for (const field of ["name", "bio", "intent", "lookingFor", "location", "contact"]) form.elements[field].value = person?.[field] || (["name", "contact"].includes(field) ? state.account?.[field] : "") || "";
  form.elements.skills.value = person?.skills.join(", ") || "";
  form.elements.monitor.checked = person ? person.monitor : false;
  document.querySelector("#profile-submit").textContent = person ? "Save your profile" : "Join the house";
  document.querySelector("#profile-delete").hidden = !person;
  document.querySelector("#profile-error").textContent = "";
  document.querySelector("#join-dialog").showModal();
}
// Rooms are Stoa spaces now: starting one opens the Stoa's create dialog.
export function newRoom(person, title = "") {
  location.assign("/stoa/?start=" + encodeURIComponent(person ? "Connect with " + person.name : title));
}
export async function openProfile(id) {
  let person = state.people.find((person) => person.id === id);
  if (!person) {
    state.people = (await api("/api/people")).people;
    person = state.people.find((person) => person.id === id);
  }
  if (!person) { notify("This profile was not found."); return; }
  const content = document.querySelector("#profile-content");
  const projects = person.projects.map((project) => el("a", { class: "profile-project", href: project.url, target: "_blank", rel: "noopener noreferrer" }, [
    el("span", { text: project.name }), el("span", { "aria-hidden": "true", text: "↗" })
  ]));
  content.replaceChildren(
    el("div", { class: "profile-identity" }, [avatar(person, "avatar-large"), el("div", {}, [el("span", { class: "kicker", text: person.source === "github" ? "PUBLIC GITHUB CONTRIBUTOR" : "HOUSE MEMBER" }), el("h2", { id: "person-title", text: person.name }), el("p", { class: "muted", text: person.location || "Location not shared" })])]),
    el("p", { class: "profile-bio", text: person.bio }),
    el("div", { class: "tags" }, person.skills.map((skill) => el("span", { text: skill }))),
    el("div", { class: "intent-block" }, [el("span", { class: "kicker", text: "REAL INTENT" }), el("p", { text: person.intent || "This is a public contributor profile. Their intent has not been shared with the house." })]),
    ...(person.lookingFor ? [el("div", { class: "intent-block" }, [el("span", { class: "kicker", text: "WOULD LIKE TO MEET" }), el("p", { text: person.lookingFor })])] : []),
    ...(projects.length ? [el("div", { class: "profile-projects" }, [el("span", { class: "kicker", text: "PUBLIC PROJECTS" }), ...projects])] : []),
    el("div", { class: "dialog-actions" }, [
      el("a", { class: "button", href: person.contact, target: "_blank", rel: "noopener noreferrer", text: person.source === "github" ? "View on GitHub ↗" : "Get in touch ↗" }),
      el("button", { class: "button button-secondary", type: "button", text: "Start a space", onclick: () => { document.querySelector("#person-dialog").close(); newRoom(person); } })
    ])
  );
  document.querySelector("#person-dialog").showModal();
}

const navigation = document.querySelector("#site-nav");
const toggle = document.querySelector(".nav-toggle");
function closeNav() {
  if (navigation.contains(document.activeElement) && window.matchMedia("(max-width: 1000px)").matches) toggle.focus();
  navigation.classList.remove("is-open");
  navigation.inert = window.matchMedia("(max-width: 1000px)").matches;
  toggle.setAttribute("aria-expanded", "false");
}
toggle.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") !== "true";
  navigation.classList.toggle("is-open", open);
  navigation.inert = !open;
  toggle.setAttribute("aria-expanded", String(open));
});
window.matchMedia("(min-width: 1001px)").addEventListener("change", closeNav);
closeNav();
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeNav(); });
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-join]")) openJoin();
  const close = event.target.closest("[data-close]");
  if (close) close.closest("dialog").close();
  const profile = event.target.closest("[data-profile-id]");
  if (profile) openProfile(profile.dataset.profileId).catch((error) => notify(error.message));
  const roomTrigger = event.target.closest("[data-new-room]");
  if (roomTrigger) newRoom(undefined, roomTrigger.dataset.roomTitle || "");
  if (event.target.closest(".site-nav a")) closeNav();
  if (!event.target.closest(".site-nav, .nav-toggle")) closeNav();
});
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("click", (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
document.querySelector("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = document.querySelector("#profile-submit");
  submit.disabled = true;
  document.querySelector("#profile-error").textContent = "";
  const data = Object.fromEntries(new FormData(form));
  data.skills = data.skills.split(",").map((skill) => skill.trim()).filter(Boolean);
  data.monitor = form.elements.monitor.checked;
  try {
    const result = await api("/api/profile", { method: state.profile ? "PUT" : "POST", body: JSON.stringify(data) });
    state.profile = result.profile;
    state.people = [];
    await refreshSession();
    document.querySelector("#join-dialog").close();
    notify("Your profile is saved. Welcome to the house.");
    document.dispatchEvent(new Event("house:people"));
    if (afterJoin) { const callback = afterJoin; afterJoin = null; callback(); }
  } catch (error) { document.querySelector("#profile-error").textContent = error.message; }
  finally { submit.disabled = false; }
});
document.querySelector("#profile-delete").addEventListener("click", async () => {
  if (!window.confirm("Remove your profile, personal radar, and meeting rooms you created from the house?")) return;
  try {
    await api("/api/profile", { method: "DELETE" });
    state.people = [];
    await refreshSession();
    document.querySelector("#join-dialog").close();
    document.dispatchEvent(new Event("house:people"));
    notify("Your profile has been removed.");
  } catch (error) { document.querySelector("#profile-error").textContent = error.message; }
});
export const sessionReady = refreshSession().catch((error) => { notify(error.message); return null; });
// Once per browser session, a page without an account asks auth.agora.build quietly (prompt=none) whether the person is
// already signed in there, for example through Astation or another tab. If so they come back signed in; if not, to the
// same page, unchanged and without a message. A session cookie, shared by the tabs, keeps it to one check per browser
// session, and signing out sets it so the person isn't signed straight back in.
const SSO_CHECKED = "ab_sso_checked";
export const markSsoChecked = () => { document.cookie = SSO_CHECKED + "=1; Path=/; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : ""); };
Promise.all([sessionReady, authConfigReady]).then(() => {
  if (!state.sessionLoaded || state.account || !state.authConfig?.issuer) return;
  if (document.cookie.split("; ").includes(SSO_CHECKED + "=1") || new URL(location.href).searchParams.has("signin")) return;
  markSsoChecked();
  location.replace("/auth/login?prompt=none&returnTo=" + encodeURIComponent(returnTarget()));
});
sessionReady.then(() => {
  const url = new URL(location.href);
  const result = url.searchParams.get("signin");
  if (!result) return;
  url.searchParams.delete("signin");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  if (result === "failed") { notify("Sign-in didn't complete. Try again."); return; }
  if (result === "unavailable") { notify("Sign-in is temporarily unavailable. Try again in a little while."); return; }
  if (result !== "success") return;
  if (state.account && !state.profile && location.pathname !== "/account/" && location.pathname !== "/marketplaces/") {
    openJoin();
  } else notify("You are signed in. Your profile and spaces are ready.");
});
