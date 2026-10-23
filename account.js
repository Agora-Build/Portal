import { api, el, avatar, authConfigReady, state, notify, openJoin, refreshSession, samePath, sessionReady, signIn, requestKey } from "./script.js";

const status = document.querySelector("#account-status");
const purchaseStatus = document.querySelector("#purchase-status");
let cursor;
let catalog;
let renderVersion = 0;
const priceLabel = (product) => {
  const zeroDecimal = ["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"];
  return new Intl.NumberFormat(undefined, { style: "currency", currency: product.currency }).format(product.amount / (zeroDecimal.includes(product.currency) ? 1 : 100)) + (product.interval ? " / " + (product.intervalCount > 1 ? product.intervalCount + " " : "") + product.interval : "");
};
async function checkout(product, button) {
  if (!state.account) { signIn(); return; }
  button.disabled = true;
  const storageKey = "checkout:" + state.account.id + ":" + product.id;
  const key = sessionStorage.getItem(storageKey) || requestKey();
  sessionStorage.setItem(storageKey, key);
  purchaseStatus.textContent = "Opening secure checkout...";
  try {
    const result = await api("/api/billing/checkout", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ productId: product.id }) });
    location.assign(result.url);
  } catch (error) {
    purchaseStatus.textContent = error.message;
    if (error.status === 409) sessionStorage.removeItem(storageKey);
    button.disabled = false;
  }
}
function renderPlans() {
  if (!catalog) return;
  document.querySelector("#plan-list").replaceChildren(...catalog.plans.map((plan) => {
    const current = state.account?.plan === plan.id;
    const products = catalog.products.filter((product) => product.plan === plan.id);
    const actions = products.map((product) => {
      const button = el("button", { class: "button " + (product.interval === "year" ? "button-secondary" : ""), type: "button", text: priceLabel(product), ...(current ? { disabled: "" } : {}) });
      button.addEventListener("click", () => checkout(product, button));
      return button;
    });
    if (!actions.length) actions.push(el("p", { class: "plan-availability mono", text: plan.id === "basic" ? "Included with your account" : plan.purchasable ? "Purchases not connected yet" : "By community appointment" }));
    return el("article", { class: "plan-card" + (current ? " is-current" : "") }, [el("p", { class: "kicker", text: current ? "YOUR CURRENT PLAN" : "AGORA.BUILD MEMBERSHIP" }), el("h3", { text: plan.name }), el("p", { text: plan.summary }), el("ul", {}, plan.features.map((feature) => el("li", { text: feature }))), el("div", { class: "plan-actions" }, actions)]);
  }));
  document.querySelector("#pack-list").replaceChildren(...catalog.products.filter((product) => product.type === "credits").map((product) => {
    const button = el("button", { class: "button button-secondary", type: "button", text: "Purchase for " + priceLabel(product) });
    button.addEventListener("click", () => checkout(product, button));
    return el("article", { class: "account-card pack-card" }, [el("p", { class: "kicker", text: "SHARED SERVICE CREDITS" }), el("h3", { text: product.name }), el("p", { class: "pack-credits mono", text: product.credits.toLocaleString() + " credits" }), button]);
  }));
  if (!catalog.products.some((product) => product.type === "credits")) document.querySelector("#pack-list").replaceChildren(el("div", { class: "empty-panel" }, [el("h3", { text: "Credit purchases are not connected yet." }), el("p", { text: "Available credit packs and their prices will appear here when checkout is configured." })]));
  if (catalog.periodCredits) purchaseStatus.textContent = "Premium includes " + catalog.periodCredits.toLocaleString() + " credits per paid billing period.";
}
async function statement(append = false, version = renderVersion) {
  const panel = document.querySelector("#credit-statement");
  const result = await api("/api/credits/statement" + (append && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
  if (version !== renderVersion) return;
  if (!append) panel.replaceChildren();
  if (!result.entries.length && !append) panel.append(el("p", { class: "empty-panel", text: "No credit transactions yet. Purchases and service usage will appear here." }));
  for (const entry of result.entries) panel.append(el("div", { class: "statement-row" }, [el("div", {}, [el("strong", { text: entry.reason }), el("time", { datetime: entry.createdAt, text: new Date(entry.createdAt).toLocaleString() })]), el("span", { class: "mono " + (entry.amount > 0 ? "credit-positive" : ""), text: (entry.amount > 0 ? "+" : "") + entry.amount.toLocaleString() })]));
  cursor = result.nextCursor;
  document.querySelector("#more-statement").hidden = !cursor;
}
// The Agora Console details window: the connection, its projects, and each certificate on request. Shown certificates
// hide after 30 seconds, when the window closes, and when the page is hidden.
const agoraDialog = document.querySelector("#agora-dialog");
const shownCertificates = new Set();
let agora = null;
let projectsVersion = 0;
const hideAllCertificates = () => { for (const hide of [...shownCertificates]) hide(); };
const syncHideAll = () => { document.querySelector("#agora-hide-all").hidden = !shownCertificates.size; };
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); notify(label + " copied."); }
  catch { notify("Copying isn't available here. Select the text instead."); }
}
function projectRow(project, index) {
  const secretId = "agora-certificate-" + index;
  const secret = el("code", { class: "project-secret", id: secretId, hidden: "" });
  const toggle = el("button", { class: "inline-link", type: "button", text: "Show certificate", "aria-expanded": "false", "aria-controls": secretId });
  const copySecret = el("button", { class: "inline-link", type: "button", text: "Copy certificate", hidden: "" });
  let expiry, certificate = "";
  const hide = () => {
    certificate = ""; secret.textContent = ""; secret.hidden = true; copySecret.hidden = true;
    toggle.textContent = "Show certificate"; toggle.setAttribute("aria-expanded", "false");
    clearTimeout(expiry); shownCertificates.delete(hide); syncHideAll();
  };
  toggle.addEventListener("click", async () => {
    if (!secret.hidden) { hide(); return; }
    toggle.disabled = true;
    try {
      const result = await api("/api/connections/agora/certificate", { method: "POST", body: JSON.stringify({ projectId: project.projectId }) });
      if (!agoraDialog.open) return;
      certificate = result.certificate || "";
      secret.textContent = certificate || "No certificate is enabled for this project.";
      secret.hidden = false; copySecret.hidden = !certificate;
      toggle.textContent = "Hide certificate"; toggle.setAttribute("aria-expanded", "true");
      expiry = setTimeout(hide, 30000); shownCertificates.add(hide); syncHideAll();
    } catch (error) {
      notify(error.message);
      if (error.data?.reconnect) showDetailsReconnect(error.message);
    } finally { toggle.disabled = false; }
  });
  copySecret.addEventListener("click", () => { if (certificate) copy(certificate, "Certificate"); });
  const actions = [toggle, copySecret];
  if (project.appId) {
    const copyAppId = el("button", { class: "inline-link", type: "button", text: "Copy App ID" });
    copyAppId.addEventListener("click", () => copy(project.appId, "App ID"));
    const create = el("button", { class: "inline-link", type: "button", text: "Create token", "aria-controls": "agora-token-form" });
    create.addEventListener("click", () => openTokenForm(project));
    actions.unshift(copyAppId, create);
  }
  const facts = [project.status ? "Status " + project.status : "", project.createdAt ? "Created " + new Date(project.createdAt).toLocaleDateString() : ""].filter(Boolean).join(" · ");
  return el("article", { class: "agora-project" }, [
    el("h3", { text: project.name || "Untitled project" }),
    el("p", { class: "mono", text: project.appId ? "App ID: " + project.appId : "App ID unavailable" }),
    ...(facts ? [el("p", { class: "muted", text: facts })] : []),
    el("div", { class: "agora-project-actions" }, actions),
    secret
  ]);
}
// The Create token form, for one project at a time. agora.build signs the token with atem-core (the library Astation
// uses); the certificate never reaches this page. A token is shown until the form changes or the window closes.
const tokenForm = document.querySelector("#agora-token-form");
const tokenField = (name) => tokenForm.elements[name];
let tokenProject = null;
function clearTokenResult() {
  document.querySelector("#agora-token-value").textContent = "";
  document.querySelector("#agora-token-facts").textContent = "";
  document.querySelector("#agora-token-result").hidden = true;
  document.querySelector("#agora-token-error").textContent = "";
}
function syncTokenForm() {
  const type = tokenField("type").value, role = tokenField("role").value, account = tokenField("identity").value === "account";
  const shown = { rtc: type === "rtc", rtm: type === "rtm", explicit: role === "explicit", standard: role !== "explicit", "with-rtm": tokenField("withRtm").checked };
  for (const node of tokenForm.querySelectorAll("[data-for]")) node.hidden = !shown[node.dataset.for];
  document.querySelector("#agora-token-identity-label").replaceChildren(account ? "User account" : "UID", el("span", { class: "optional", text: account ? "up to 255 characters" : "0 allows any user" }));
  tokenField("identityValue").inputMode = account ? "text" : "numeric";
}
function openTokenForm(project) {
  tokenProject = project;
  document.querySelector("#agora-token-project").textContent = (project.name || "Untitled project") + " · " + project.appId;
  clearTokenResult();
  syncTokenForm();
  tokenForm.hidden = false;
  tokenForm.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  tokenField(tokenField("type").value === "rtm" ? "userId" : "channel").focus();
}
function closeTokenForm() { tokenProject = null; clearTokenResult(); tokenForm.hidden = true; }
// The request body for POST /api/connections/agora/token; a message string when the form can't be sent.
function tokenRequest() {
  const seconds = (name) => Number(tokenField(name).value);
  if (tokenField("type").value === "rtm") return { projectId: tokenProject.projectId, type: "rtm", userId: tokenField("userId").value.trim(), expire: seconds("expire") };
  const value = tokenField("identityValue").value.trim(), role = tokenField("role").value;
  const body = { projectId: tokenProject.projectId, type: "rtc", channel: tokenField("channel").value.trim(), role, tokenExpire: seconds("tokenExpire") };
  if (tokenField("identity").value === "account") body.account = value;
  else if (/^\d{1,10}$/.test(value) && Number(value) <= 4294967295) body.uid = Number(value);
  else return "Enter a UID from 0 to 4294967295, or choose User account.";
  if (role === "explicit") body.privileges = { join: seconds("join"), audio: seconds("audio"), video: seconds("video"), data: seconds("data") };
  else body.privilegeExpire = seconds("privilegeExpire");
  if (tokenField("withRtm").checked) body.rtm = { ...(tokenField("rtmUserId").value.trim() ? { userId: tokenField("rtmUserId").value.trim() } : {}), expire: seconds("rtmExpire") };
  return body;
}
tokenForm.addEventListener("change", () => { syncTokenForm(); clearTokenResult(); });
tokenForm.addEventListener("input", clearTokenResult);
tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!tokenProject) return;
  const body = tokenRequest(), error = document.querySelector("#agora-token-error"), submit = tokenForm.querySelector("[type=submit]");
  clearTokenResult();
  if (typeof body === "string") { error.textContent = body; return; }
  const project = tokenProject;
  submit.disabled = true;
  try {
    const result = await api("/api/connections/agora/token", { method: "POST", body: JSON.stringify(body) });
    if (!agoraDialog.open || tokenProject !== project) return;
    document.querySelector("#agora-token-value").textContent = result.token;
    const who = result.type === "rtm" ? "user " + result.userId : (result.account !== undefined ? "account " + result.account : result.uid === 0 ? "any UID" : "UID " + result.uid) + " in " + result.channel + ", " + result.role + (result.rtm ? ", with RTM login as " + result.rtm.userId : "");
    document.querySelector("#agora-token-facts").textContent = result.type.toUpperCase() + " token for " + who + ". Expires " + new Date(result.expiresAt).toLocaleString() + ".";
    document.querySelector("#agora-token-result").hidden = false;
  } catch (failure) {
    error.textContent = failure.message;
    if (failure.data?.reconnect) showDetailsReconnect(failure.message);
  } finally { submit.disabled = false; }
});
document.querySelector("#agora-token-copy").addEventListener("click", () => { const token = document.querySelector("#agora-token-value").textContent; if (token) copy(token, "Token"); });
document.querySelector("#agora-token-close").addEventListener("click", closeTokenForm);
function showDetailsReconnect(message) {
  document.querySelector("#agora-dialog-status").textContent = message || "Your Agora Console connection has expired. Reconnect to see your projects.";
  document.querySelector("#agora-dialog-reconnect").hidden = !agora?.connect;
  document.querySelector("#agora-refresh").hidden = true;
}
async function loadProjects() {
  const version = ++projectsVersion;
  const container = document.querySelector("#agora-projects");
  hideAllCertificates();
  closeTokenForm();
  document.querySelector("#agora-dialog-reconnect").hidden = true;
  document.querySelector("#agora-refresh").hidden = false;
  document.querySelector("#agora-dialog-status").textContent = "Connected to your Agora account" + (agora?.name ? " (" + agora.name + ")" : "") + ".";
  if (agora?.reconnect) { container.replaceChildren(); showDetailsReconnect(); return; }
  container.replaceChildren(el("p", { text: "Loading your Agora projects..." }));
  try {
    const result = await api("/api/connections/agora/projects");
    if (version !== projectsVersion) return;
    container.replaceChildren(...result.projects.map(projectRow));
    if (!result.projects.length) container.append(el("p", { class: "empty-panel", text: "No Agora projects were returned for this account." }));
    else document.querySelector("#agora-dialog-status").textContent += " " + result.projects.length + (result.projects.length === 1 ? " project." : " projects.");
  } catch (error) {
    if (version !== projectsVersion) return;
    container.replaceChildren(el("p", { class: "form-error", text: error.message }));
    // Agora refused to renew the connection: offer to reconnect.
    if (error.data?.reconnect) { showDetailsReconnect(error.message); showReconnect(agora?.connect); }
  }
}
function openDetails() {
  agoraDialog.showModal();
  loadProjects();
}
agoraDialog.addEventListener("close", () => { projectsVersion++; hideAllCertificates(); closeTokenForm(); document.querySelector("#agora-projects").replaceChildren(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) hideAllCertificates(); });
document.querySelector("#agora-details").addEventListener("click", openDetails);
document.querySelector("#agora-refresh").addEventListener("click", () => loadProjects());
document.querySelector("#agora-hide-all").addEventListener("click", hideAllCertificates);
document.querySelector("#agora-dialog-reconnect").addEventListener("click", () => { location.assign("/connect/agora"); });
async function loadAccount() {
  const version = ++renderVersion;
  const account = state.account;
  status.textContent = account ? "Signed in as " + (account.name || "your account") : "Sign in to manage your account, membership, and credits.";
  document.querySelector("#account-identity").replaceChildren(account ? el("div", { class: "account-person" }, [avatar({ name: account.name || "Account", avatar: account.avatar }), el("div", {}, [el("h3", { text: account.name || "Your account" }), el("p", { class: "account-user-id mono", text: account.id }), ...(account.email ? [el("p", { class: "muted", text: "Email (private): " + account.email })] : [])])]) : el("p", { text: state.profile ? "Your private account is separate from your public community profile. Sign in to use credits, membership, and connections." : "One Agora.Build account for your profile, services, subscription, and credits, on every device. It stays separate from your public community profile." }));
  renderSignInSection();
  document.querySelector("#account-logout").hidden = !account;
  const manage = document.querySelector("#manage-signin");
  manage.hidden = !account || !state.authConfig?.accountUrl;
  if (state.authConfig?.accountUrl) manage.href = state.authConfig.accountUrl;
  renderPlans();
  if (!account) {
    document.querySelector("#credit-balance").textContent = "--";
    document.querySelector("#credit-statement").replaceChildren(el("p", { class: "empty-panel", text: "Sign in to see your credit statement." }));
    agora = null;
    if (agoraDialog.open) agoraDialog.close();
    document.querySelector("#agora-details").hidden = true;
    document.querySelector("#manage-billing").hidden = true;
    document.querySelector("#disconnect-agora").hidden = true;
    document.querySelector("#connect-agora").hidden = true;
    document.querySelector("#agora-status").textContent = "Sign in to connect your Agora projects.";
    document.querySelector("#more-statement").hidden = true;
    document.querySelector("#subscription-status").textContent = "Basic starts with your account. Premium subscriptions are managed here.";
    return;
  }
  const results = await Promise.allSettled([api("/api/credits/balance"), api("/api/billing/account"), api("/api/connections"), statement(false, version)]);
  if (version !== renderVersion) return;
  if (results[0].status === "fulfilled") {
    const balance = results[0].value;
    document.querySelector("#credit-balance").textContent = balance.credits.toLocaleString();
    if (balance.adjustmentCredits) status.textContent += ". " + balance.adjustmentCredits.toLocaleString() + " credits from a refunded purchase need adjustment before further service use.";
  }
  if (results[1].status === "fulfilled") {
    const billing = results[1].value, subscription = billing.subscription;
    document.querySelector("#manage-billing").hidden = !billing.canManage;
    document.querySelector("#subscription-status").textContent = subscription ? "Premium subscription: " + subscription.status + ". " + (subscription.cancelAtPeriodEnd ? "Ends " : "Current period ends ") + new Date(subscription.currentPeriodEnd * 1000).toLocaleDateString() + "." : "Your current plan: " + billing.plan + ".";
  }
  if (results[2].status === "fulfilled") {
    agora = results[2].value.agora;
    const connectButton = document.querySelector("#connect-agora");
    document.querySelector("#agora-status").textContent = agora.connected ? "Connected to your Agora account" + (agora.name ? " (" + agora.name + ")" : "") + "." : agora.connect ? "Connect Agora to access your projects and App IDs." : "Agora Console connections are not available yet.";
    connectButton.textContent = "Connect Agora Console";
    connectButton.hidden = !agora.connect || agora.connected;
    document.querySelector("#disconnect-agora").hidden = !agora.connected;
    document.querySelector("#agora-details").hidden = !agora.connected;
    if (agora.connected && agora.reconnect) showReconnect(agora.connect);
    if (!agora.connected && agoraDialog.open) agoraDialog.close();
    else if (agoraDialog.open) loadProjects();
  }
  for (const result of results) if (result.status === "rejected") notify(result.reason.message);
}
// The stored connection can no longer be renewed; the account connects again to replace it.
function showReconnect(available = true) {
  const connectButton = document.querySelector("#connect-agora");
  document.querySelector("#agora-status").textContent = "Your Agora Console connection has expired. Reconnect to see your projects.";
  connectButton.textContent = "Reconnect Agora Console";
  connectButton.hidden = !available;
}
// Signed out or browser-only, the identity card is the sign-in: one link to auth.agora.build, or start with this browser.
function renderSignInSection() {
  const account = state.account, profile = state.profile, available = Boolean(state.authConfig?.issuer);
  const signinStatus = document.querySelector("#signin-status");
  document.querySelector("#account-login").hidden = Boolean(account);
  document.querySelector("#account-guest").hidden = Boolean(account || profile);
  document.querySelector("#signin-note").hidden = Boolean(account);
  signinStatus.textContent = account ? "" : !available ? "Sign-in is temporarily unavailable." + (profile ? "" : " You can start with this browser.") : profile ? "Sign in to keep this profile and its rooms across devices." : "";
  signinStatus.hidden = !signinStatus.textContent;
}
// After the browser-only profile is saved, go back to the page that sent the visitor here (same-site paths only).
document.querySelector("#account-guest").addEventListener("click", () => {
  const back = samePath(new URLSearchParams(location.search).get("returnTo"));
  openJoin(back ? () => location.assign(back) : null, true);
});
document.querySelector("#connect-agora").addEventListener("click", () => { location.assign("/connect/agora"); });
document.querySelector("#disconnect-agora").addEventListener("click", async () => {
  try { await api("/api/connections/agora", { method: "DELETE" }); if (agoraDialog.open) agoraDialog.close(); await refreshSession(); }
  catch (error) { notify(error.message); }
});
document.querySelector("#manage-billing").addEventListener("click", async () => {
  try { location.assign((await api("/api/billing/manage", { method: "POST" })).url); }
  catch (error) { notify(error.message); }
});
document.querySelector("#account-logout").addEventListener("click", async () => {
  try {
    const result = await api("/api/auth/logout", { method: "POST" });
    if (result.endSessionUrl) { location.assign(result.endSessionUrl); return; }
    await refreshSession(); notify("You are signed out.");
  } catch (error) { notify(error.message); }
});
document.querySelector("#more-statement").addEventListener("click", () => statement(true).catch((error) => notify(error.message)));
await sessionReady;
await authConfigReady;
try { catalog = await api("/api/billing/catalog"); }
catch (error) { purchaseStatus.textContent = error.message; }
await loadAccount();
document.addEventListener("house:session", () => loadAccount().catch((error) => notify(error.message)));
const checkoutResult = new URL(location.href).searchParams.get("checkout");
if (checkoutResult === "success") {
  purchaseStatus.textContent = "Checkout returned successfully. Your account updates after payment confirmation; refresh if it is still pending.";
  for (let attempt = 0; attempt < 5; attempt += 1) { await new Promise((done) => setTimeout(done, 2000)); await refreshSession(); }
} else if (checkoutResult === "cancelled") purchaseStatus.textContent = "Checkout was cancelled. You can return to the same checkout or choose another purchase.";

const connected = new URL(location.href).searchParams.get("connected");
if (connected) {
  const url = new URL(location.href);
  url.searchParams.delete("connected");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  notify(connected === "agora" ? "Agora Console is connected." : connected === "unavailable" ? "Connecting Agora Console is unavailable right now." : "Connecting Agora Console didn't complete. Try again.");
}
