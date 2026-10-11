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
  if (!response.ok) { const error = new Error(data.error || "Something went wrong."); error.status = response.status; throw error; }
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
  document.querySelectorAll("[data-join]").forEach((button) => {
    button.textContent = state.profile ? button.dataset.memberLabel || "Your profile" : button.dataset.guestLabel || "Join the house";
  });
  document.dispatchEvent(new CustomEvent("house:session", { detail: state.profile }));
  renderSignIn();
  return state.profile;
}
let afterJoin;
let providers = [];
const providerGrid = el("div", { class: "login-providers" });
const loginStatus = el("p", { class: "login-status", role: "status", text: "Checking sign-in options..." });
const guest = el("button", { class: "inline-link login-guest", type: "button", text: "Continue with this browser", onclick: () => { loginDialog.close(); openJoin(afterJoin, true); } });
const signOut = el("button", { class: "button button-secondary", type: "button", text: "Sign out", onclick: async () => {
  signOut.disabled = true;
  try { await api("/api/auth/logout", { method: "POST" }); await refreshSession(); loginDialog.close(); notify("You are signed out. Your public profile and rooms remain available."); }
  catch (error) { notify(error.message); }
  finally { signOut.disabled = false; }
} });
const loginDialog = el("dialog", { id: "login-dialog", "aria-labelledby": "login-title" }, [
  el("div", { class: "dialog-head" }, [el("span", { class: "kicker", text: "YOUR PLACE, ON EVERY DEVICE" }), el("button", { class: "close-button", type: "button", "data-close": "", "aria-label": "Close sign-in", text: "\u00d7" })]),
  el("h2", { id: "login-title", text: "A seat at the workbench." }),
  el("p", { class: "dialog-intro", text: "One Agora.Build account for your profile, services, subscription, and credits." }), providerGrid, loginStatus, el("a", { class: "inline-link", href: "/account.html", text: "Account, membership & credits" }), signOut, guest,
  el("p", { class: "form-note login-note", text: "Browser-only profiles stay linked to this browser. Connect a login later to keep access. Your email and login identity are never published." })
]);
document.body.append(loginDialog);
const manageLogin = el("button", { class: "inline-link profile-login-control", type: "button", text: "Connect a login", onclick: () => { document.querySelector("#join-dialog").close(); openSignIn(); } });
document.querySelector("#profile-form .dialog-actions").append(manageLogin);

function renderSignIn() {
  const account = state.account;
  manageLogin.textContent = account ? "Account & sign out" : "Connect a login";
  guest.hidden = Boolean(account || state.profile);
  signOut.hidden = !account;
  loginStatus.textContent = account ? "Signed in as " + account.name + ". Connect another provider to use the same profile." : state.profile ? "Connect a login to keep this profile and its rooms across devices." : providers.some((provider) => provider.ready) ? "Choose your sign-in provider, or start with this browser." : "Sign-in providers are not connected yet. You can start with this browser.";
  providerGrid.replaceChildren(...providers.map((provider) => {
    const connected = account?.providers.includes(provider.id);
    return el("button", { class: "login-provider", type: "button", ...(!provider.ready || connected ? { disabled: "" } : {}), onclick: () => {
      const url = new URL("/auth/" + provider.id, location.origin);
      url.searchParams.set("returnTo", location.pathname + location.search + location.hash);
      if (state.account || state.profile) url.searchParams.set("link", "1");
      location.href = url.href;
    } }, [el("span", { class: "login-provider-mark mono", "aria-hidden": "true", text: provider.id === "agora" ? "a_" : provider.name[0] }), el("span", { text: (account || state.profile ? "Connect " : "Continue with ") + provider.name }), el("small", { text: connected ? "Connected" : provider.ready ? "\u2197" : "Unavailable" })]);
  }));
}
export function openSignIn() { renderSignIn(); loginDialog.showModal(); }

// A login whose verified email already has an account is held by the server; these dialogs read it from there, never from the URL.
const PROVIDER_NAMES = { google: "Google", github: "GitHub", apple: "Apple", agora: "Agora" };
const nameOf = (id) => PROVIDER_NAMES[id] || "another login";
function linkDialog(kicker, title, intro, actions, note) {
  const dialog = el("dialog", { id: "link-dialog", "aria-labelledby": "link-title" }, [
    el("div", { class: "dialog-head" }, [el("span", { class: "kicker", text: kicker }), el("button", { class: "close-button", type: "button", "data-close": "", "aria-label": "Close", text: "\u00d7" })]),
    el("h2", { id: "link-title", text: title }), el("p", { class: "dialog-intro", text: intro }), ...actions, el("p", { class: "form-note", text: note })
  ]);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
const resolveLink = async (action) => api("/api/auth/pending-link", { method: "POST", body: JSON.stringify({ action }) });
async function confirmLink() {
  let held;
  try { held = await api("/api/auth/pending-link"); } catch { notify("That sign-in request expired. Sign in again."); return; }
  const choices = held.providers.filter((id) => Object.hasOwn(PROVIDER_NAMES, id));
  const separate = el("button", { class: "inline-link", type: "button", text: "Create a separate account instead", onclick: async () => {
    try { await resolveLink("separate"); location.reload(); } catch (error) { notify(error.message); }
  } });
  const dialog = linkDialog("ONE ACCOUNT, MANY LOGINS", "This email already has an account.", "Your " + nameOf(held.provider) + " login (" + held.email + ") matches an Agora.Build account that signs in with " + choices.map(nameOf).join(" or ") + ". Sign in with it to connect " + nameOf(held.provider) + ", so both open the same account.", [
    el("div", { class: "login-providers" }, choices.map((id) => el("button", { class: "login-provider", type: "button", onclick: () => {
      const url = new URL("/auth/" + id, location.origin);
      url.searchParams.set("returnTo", location.pathname + location.search + location.hash);
      url.searchParams.set("confirmLink", "1");
      location.href = url.href;
    } }, [el("span", { class: "login-provider-mark mono", "aria-hidden": "true", text: id === "agora" ? "a_" : nameOf(id)[0] }), el("span", { text: "Continue with " + nameOf(id) })]))),
    separate
  ], "Not you? Close this and nothing is connected. The request expires in ten minutes.");
  dialog.addEventListener("cancel", () => { resolveLink("discard").catch(() => {}); });
}
async function confirmConnect() {
  let held;
  try { held = await api("/api/auth/pending-link"); } catch { notify("The request to connect that login expired. Sign in with it again to retry."); return; }
  if (!held.ready) { notify("Sign in to the matching account to connect that login."); return; }
  let dialog;
  const choose = (action) => async () => {
    try { const result = await resolveLink(action); dialog.close(); await refreshSession(); notify(result.linked ? nameOf(result.linked) + " is now connected. Either login opens this account." : "Nothing was connected."); }
    catch (error) { dialog.close(); notify(error.message); }
  };
  dialog = linkDialog("CONNECT A LOGIN", "Connect " + nameOf(held.provider) + " to this account?", nameOf(held.provider) + " (" + held.email + ") will sign in to this account from now on.", [
    el("div", { class: "dialog-actions" }, [el("button", { class: "button", type: "button", text: "Connect " + nameOf(held.provider), onclick: choose("connect") }), el("button", { class: "button button-secondary", type: "button", text: "Don't connect", onclick: choose("discard") })])
  ], "Only connect a login you own.");
}api("/api/auth/providers").then((result) => { providers = result.providers; renderSignIn(); }).catch(() => { loginStatus.textContent = "Sign-in options could not load. You can continue with this browser."; });

export function openJoin(callback, browserOnly = false) {
  afterJoin = typeof callback === "function" ? callback : null;
  if (!state.profile && !state.account && !browserOnly) { openSignIn(); return; }
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
export function newRoom(person, title = "") {
  if (!state.profile) {
    sessionStorage.setItem("foundry-room-draft", JSON.stringify({ title: person ? "Connect with " + person.name : title }));
    openJoin(() => newRoom(person, title)); return;
  }
  sessionStorage.removeItem("foundry-room-draft");
  const form = document.querySelector("#room-form");
  form.reset();
  form.elements.title.value = person ? "Connect with " + person.name : title;
  form.elements.intent.value = state.profile.intent.slice(0, 300);
  document.querySelector("#room-error").textContent = "";
  document.querySelector("#room-dialog").showModal();
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
      el("button", { class: "button button-secondary", type: "button", text: "Start a room", onclick: () => { document.querySelector("#person-dialog").close(); newRoom(person); } })
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
document.querySelector("#room-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/rooms", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    window.location.href = result.room.path;
  } catch (error) { document.querySelector("#room-error").textContent = error.message; }
  finally { button.disabled = false; }
});
export const sessionReady = refreshSession().catch((error) => { notify(error.message); return null; });
sessionReady.then(() => {
  const url = new URL(location.href);
  const result = url.searchParams.get("signin");
  if (!result) return;
  url.searchParams.delete("signin");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  if (result === "failed") { notify("Sign-in could not be completed. Please try again."); return; }
  if (result === "confirm-link") { confirmLink(); return; }
  if (result === "confirm-connect") { confirmConnect(); return; }
  const linkNotices = { "link-mismatch": "You signed in to a different account, so the new login was not connected.", "link-expired": "The request to connect that login expired. Sign in with it again to retry." };
  if (Object.hasOwn(linkNotices, result)) { notify(linkNotices[result]); return; }
  if (state.account && !state.profile && location.pathname !== "/account.html" && location.pathname !== "/services.html") {
    let draft;
    try { draft = JSON.parse(sessionStorage.getItem("foundry-room-draft")); } catch { sessionStorage.removeItem("foundry-room-draft"); }
    openJoin(draft ? () => newRoom(undefined, draft.title || "") : undefined);
  }
  else if (state.profile && sessionStorage.getItem("foundry-room-draft")) {
    try { newRoom(undefined, JSON.parse(sessionStorage.getItem("foundry-room-draft")).title || ""); }
    catch { sessionStorage.removeItem("foundry-room-draft"); }
  } else notify("You are signed in. Your profile and rooms are ready.");
});
