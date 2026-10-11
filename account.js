import { api, el, state, notify, openSignIn, refreshSession, sessionReady, requestKey } from "./script.js";

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
  if (!state.account) { openSignIn(); return; }
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
async function loadProjects(version) {
  const container = document.querySelector("#agora-projects");
  container.replaceChildren(el("p", { text: "Loading your Agora projects..." }));
  try {
    const result = await api("/api/connections/agora/projects");
    if (version !== renderVersion) return;
    container.replaceChildren(...result.projects.map((project) => {
      const secret = el("code", { class: "project-secret", hidden: "" });
      const button = el("button", { class: "inline-link", type: "button", text: "Reveal certificate", "aria-expanded": "false" });
      let expiry;
      const hide = () => { secret.textContent = ""; secret.hidden = true; button.textContent = "Reveal certificate"; button.setAttribute("aria-expanded", "false"); clearTimeout(expiry); };
      button.addEventListener("click", async () => {
        if (!secret.hidden) { hide(); return; }
        button.disabled = true;
        try {
          const result = await api("/api/connections/agora/certificate", { method: "POST", body: JSON.stringify({ projectId: project.projectId }) });
          secret.textContent = result.certificate || "No certificate is available for this project.";
          secret.hidden = false; button.textContent = "Hide certificate"; button.setAttribute("aria-expanded", "true"); expiry = setTimeout(hide, 30000);
        } catch (error) { notify(error.message); }
        finally { button.disabled = false; }
      });
      document.addEventListener("visibilitychange", () => { if (document.hidden) hide(); });
      return el("article", { class: "agora-project" }, [el("h4", { text: project.name }), el("p", { class: "mono", text: "App ID: " + project.appId }), button, secret]);
    }));
    if (!result.projects.length) container.append(el("p", { text: "No Agora projects were returned for this account." }));
  } catch (error) { if (version === renderVersion) container.replaceChildren(el("p", { class: "form-error", text: error.message })); }
}
async function loadAccount() {
  const version = ++renderVersion;
  const account = state.account;
  status.textContent = account ? "Signed in as " + account.name : "Sign in to manage your account, membership, and credits.";
  document.querySelector("#account-identity").replaceChildren(account ? el("div", {}, [el("h3", { text: account.name }), el("p", { class: "account-user-id mono", text: account.id }), el("p", { text: "Logins: " + (account.providers.join(", ") || "Connected application") }), ...(account.emails?.length ? [el("p", { class: "muted", text: "Verified email" + (account.emails.length > 1 ? "s" : "") + " (private): " + account.emails.join(", ") })] : [])]) : el("p", { text: "Your private account is separate from your public community profile." }));
  document.querySelector("#logout-everywhere").hidden = !account;
  renderPlans();
  if (!account) {
    document.querySelector("#credit-balance").textContent = "--";
    document.querySelector("#credit-statement").replaceChildren(el("p", { class: "empty-panel", text: "Sign in to see your credit statement." }));
    document.querySelector("#agora-projects").replaceChildren();
    document.querySelector("#manage-billing").hidden = true;
    document.querySelector("#disconnect-agora").hidden = true;
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
    const agora = results[2].value.agora;
    document.querySelector("#agora-status").textContent = agora.connected ? "Connected to your Agora account." : agora.ready ? "Connect Agora to access your projects and App IDs." : "Agora Console connections are not configured yet.";
    document.querySelector("#disconnect-agora").hidden = !agora.connected;
    document.querySelector("#connect-agora").textContent = agora.connected ? "Reconnect Agora" : "Connect Agora";
    if (agora.connected) await loadProjects(version);
  }
  for (const result of results) if (result.status === "rejected") notify(result.reason.message);
}
document.querySelector("#account-login").addEventListener("click", openSignIn);
document.querySelector("#connect-agora").addEventListener("click", async () => {
  try {
    const { providers } = await api("/api/auth/providers");
    if (!providers.find((provider) => provider.id === "agora")?.ready) { notify("Agora sign-in is not connected yet."); return; }
    location.assign("/auth/agora?returnTo=%2Faccount.html" + (state.account ? "&link=1" : ""));
  } catch (error) { notify(error.message); }
});
document.querySelector("#disconnect-agora").addEventListener("click", async () => {
  try { await api("/api/connections/agora", { method: "DELETE" }); document.querySelector("#agora-projects").replaceChildren(); await refreshSession(); }
  catch (error) { notify(error.message); }
});
document.querySelector("#manage-billing").addEventListener("click", async () => {
  try { location.assign((await api("/api/billing/manage", { method: "POST" })).url); }
  catch (error) { notify(error.message); }
});
document.querySelector("#logout-everywhere").addEventListener("click", async () => {
  try { await api("/api/auth/logout-all", { method: "POST" }); await refreshSession(); notify("Your Agora.Build sessions are signed out across connected apps."); }
  catch (error) { notify(error.message); }
});
document.querySelector("#more-statement").addEventListener("click", () => statement(true).catch((error) => notify(error.message)));
await sessionReady;
try { catalog = await api("/api/billing/catalog"); }
catch (error) { purchaseStatus.textContent = error.message; }
await loadAccount();
document.addEventListener("house:session", () => loadAccount().catch((error) => notify(error.message)));
const checkoutResult = new URL(location.href).searchParams.get("checkout");
if (checkoutResult === "success") {
  purchaseStatus.textContent = "Checkout returned successfully. Your account updates after payment confirmation; refresh if it is still pending.";
  for (let attempt = 0; attempt < 5; attempt += 1) { await new Promise((done) => setTimeout(done, 2000)); await refreshSession(); }
} else if (checkoutResult === "cancelled") purchaseStatus.textContent = "Checkout was cancelled. You can return to the same checkout or choose another purchase.";
