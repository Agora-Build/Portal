import { el, notify, sessionReady } from "./script.js";

// The Stations and Integrations sections of /account/. They show only for a signed-in account when the Portal has its
// integrations database. A key pair generated here stays in this browser: only the public JWK is sent, and the private
// JWK is offered once as a download.
const stationsSection = document.querySelector("#stations");
const integrationsSection = document.querySelector("#integrations");
const stationForm = document.querySelector("#station-form");
const integrationForm = document.querySelector("#integration-form");
const confirmDialog = document.querySelector("#integration-confirm");
const historyDialog = document.querySelector("#integration-history");
const ACCOUNT_ID = /^ab[0-9A-HJKMNP-TV-Z]{26}$/;
const STATE_LABELS = {
  awaiting_approval: "Awaiting approval in Astation",
  provisioning: "Provisioning",
  waiting_for_host: "Waiting for host",
  ready: "Ready",
  paused: "Paused",
  expired: "Expired",
  revoking: "Revoking",
  revoked: "Revoked"
};
const LIVE = ["awaiting_approval", "provisioning", "waiting_for_host", "ready"];
const STOPPED = ["revoking", "revoked"];
const STALE = "Showing saved details; Auth could not be reached.";
const NO_DETAILS = "This Station does not offer details yet.";
let me = null;
let stations = [];
let challenge = null;
let version = 0;

// Same-origin JSON calls; a failure carries the server's sentence and code.
async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || "Something went wrong."); error.status = response.status; error.code = data.code; throw error; }
  return data;
}
const segment = (value) => encodeURIComponent(value);
const date = (value) => value ? new Date(value).toLocaleDateString() : "";
const time = (value) => value ? new Date(value).toLocaleString() : "";
const stateLabel = (state) => STATE_LABELS[state] || String(state || "Unknown").replace(/_/g, " ");
const words = (value) => String(value || "").replace(/_/g, " ");
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); notify(label + " copied."); }
  catch { notify("Copying isn't available here. Select the text instead."); }
}
// A native confirmation; resolves true only when the account chooses the confirm button.
function confirmAction(title, text, action) {
  document.querySelector("#integration-confirm-title").textContent = title;
  document.querySelector("#integration-confirm-text").textContent = text;
  document.querySelector("#integration-confirm-ok").textContent = action;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  return new Promise((done) => confirmDialog.addEventListener("close", () => done(confirmDialog.returnValue === "confirm"), { once: true }));
}
// Runs an action from a button: disabled while it runs, its failure shown in `output` (or a toast). Focus the button
// had comes back to it afterwards, or, when its row was re-rendered meanwhile, to the same control of the new row.
async function act(button, output, run) {
  const focused = document.activeElement === button;
  const row = button.closest("[data-row]")?.dataset.row;
  button.disabled = true;
  if (output) output.textContent = "";
  try { await run(); }
  catch (error) { if (output) output.textContent = error.message; else notify(error.message); }
  finally {
    button.disabled = false;
    if (focused && (!document.activeElement || document.activeElement === document.body)) restoreFocus(button, row);
  }
}
function restoreFocus(button, row) {
  if (button.isConnected) { button.focus(); return; }
  const next = row && [...document.querySelectorAll("[data-row]")].find((node) => node.dataset.row === row);
  const controls = next ? [...next.querySelectorAll(".agora-project-actions button")] : [];
  (controls.find((control) => control.textContent === button.textContent) || controls[0])?.focus();
}
// Asks first, then runs the action, so the opener stays enabled while the dialog is open and takes focus back.
async function confirmed(button, output, question, run) {
  if (await confirmAction(...question)) await act(button, output, run);
}
function toggleForm(form, opener, open) {
  form.hidden = !open;
  opener.setAttribute("aria-expanded", String(open));
  if (open) form.querySelector("input, select, textarea")?.focus();
}

// The app key: generated here (the private JWK is offered as one download, then dropped) or pasted as a public JWK.
const sanitise = (name) => (String(name || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60)) || "integration";
function keyField(container, nameOf) {
  const textarea = el("textarea", { id: container.id + "-jwk", name: "publicJwk", rows: "5", spellcheck: "false", autocomplete: "off", placeholder: "{ \"kty\": \"EC\", \"crv\": \"P-256\", \"x\": \"…\", \"y\": \"…\" }" });
  const generate = el("button", { class: "button button-secondary button-small", type: "button", text: "Generate a key pair in this browser" });
  const download = el("div", { class: "key-download", hidden: "" });
  let release = null;
  let downloaded = false;
  // Revokes the object URL and removes the link; the private key is then gone from this page.
  const drop = () => { if (release) release(); release = null; downloaded = false; download.replaceChildren(); download.hidden = true; };
  generate.addEventListener("click", () => act(generate, null, async () => {
    drop();
    let pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    let privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    pair = null;
    publicJwk.alg = "ES256";
    privateJwk.alg = "ES256";
    let url = URL.createObjectURL(new Blob([JSON.stringify(privateJwk, null, 2)], { type: "application/json" }));
    privateJwk = null;
    const filename = sanitise(nameOf()) + ".private.jwk.json";
    const link = el("a", { class: "button", href: url, download: filename, text: "Download " + filename });
    release = () => { URL.revokeObjectURL(url); url = null; link.removeAttribute("href"); };
    // The link must stay in the page while its download starts; the URL is revoked a moment later.
    link.addEventListener("click", () => { downloaded = true; setTimeout(drop, 1000); notify("Private key downloaded. Keep it with your app."); }, { once: true });
    download.replaceChildren(link, el("p", { class: "form-note", text: "Agora.Build never receives this file. Keep it with your app." }));
    download.hidden = false;
    textarea.value = JSON.stringify(publicJwk, null, 2);
    link.focus();
  }));
  textarea.addEventListener("input", drop);
  container.replaceChildren(
    el("label", { for: textarea.id }, ["App public key ", el("span", { class: "optional", text: "paste a public JWK, or generate one" })]),
    textarea,
    el("div", { class: "key-actions" }, [generate]),
    download
  );
  return {
    // The public JWK object, or a sentence saying why it can't be sent yet.
    value() {
      if (release && !downloaded) return "Download the private key before continuing.";
      let jwk;
      try { jwk = JSON.parse(textarea.value); } catch { jwk = null; }
      if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) return "Paste the app's public key as JWK JSON, or generate one.";
      if (Object.hasOwn(jwk, "d")) return "That is a private key. Paste only the public key.";
      return jwk;
    },
    reset() { drop(); textarea.value = ""; }
  };
}

// Stations: the account's own and those shared with it.
async function stationDetails(station, output) {
  output.textContent = "Asking the Station...";
  try {
    const { accessToken } = await request("/api/stations/" + segment(station.id) + "/read-token", { method: "POST" });
    const url = new URL("/agora-build/v1/details", station.origin);
    if (url.protocol !== "https:") throw new Error("not https");
    const response = await fetch(url, { headers: { Authorization: "Bearer " + accessToken }, mode: "cors", credentials: "omit", cache: "no-store", redirect: "error" });
    if (!response.ok) throw new Error("status");
    const details = await response.json();
    const shown = ["label", "status"].filter((key) => typeof details?.[key] === "string" && details[key]).map((key) => details[key].slice(0, 200));
    if (!shown.length) throw new Error("empty");
    output.textContent = shown.join(" · ");
  } catch { output.textContent = NO_DETAILS; }
}
function membersPanel(station) {
  const panel = el("details", { class: "station-members" });
  const list = el("ul", { class: "member-list" });
  const output = el("p", { class: "form-note", role: "status" });
  const input = el("input", { name: "account", maxlength: "28", autocomplete: "off", spellcheck: "false", placeholder: "ab…" });
  const share = el("button", { class: "button button-secondary button-small", type: "submit", text: "Share" });
  const form = el("form", { class: "stack-form share-form", novalidate: "" }, [el("label", {}, ["Share with an account ID", input]), share]);
  async function load() {
    list.replaceChildren(el("li", { class: "muted", text: "Loading members..." }));
    try {
      const { members } = await request("/api/stations/" + segment(station.id) + "/members");
      list.replaceChildren(...members.map((member) => {
        const remove = el("button", { class: "inline-link", type: "button", text: "Remove", "aria-label": "Remove " + member.account });
        remove.addEventListener("click", () => confirmed(remove, output, ["Remove this member?", member.account + " loses this Station, and their integrations on it are revoked.", "Remove member"], async () => {
          await request("/api/stations/" + segment(station.id) + "/members/" + segment(member.account), { method: "DELETE" });
          notify("Member removed.");
          await Promise.all([load(), loadIntegrations()]);
        }));
        return el("li", {}, [el("span", { class: "mono", text: member.account }), el("span", { class: "muted", text: "Added " + date(member.addedAt) }), remove]);
      }));
      if (!members.length) list.replaceChildren(el("li", { class: "muted", text: "Not shared with anyone yet." }));
    } catch (error) { list.replaceChildren(el("li", { class: "form-error", text: error.message })); }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const account = input.value.trim();
    if (!ACCOUNT_ID.test(account)) { output.textContent = "Enter an Agora Build account ID (ab…)."; return; }
    act(share, output, async () => {
      await request("/api/stations/" + segment(station.id) + "/members/" + segment(account), { method: "PUT" });
      input.value = "";
      notify("Station shared.");
      await load();
    });
  });
  panel.addEventListener("toggle", () => { if (panel.open) load(); });
  panel.append(el("summary", { text: "Members and sharing" }), list, form, output);
  return panel;
}
function stationRow(station) {
  const owner = station.role === "owner";
  const output = el("p", { class: "station-details", role: "status" });
  const actions = el("div", { class: "agora-project-actions" });
  const details = el("button", { class: "inline-link", type: "button", text: "Details" });
  details.addEventListener("click", () => act(details, null, () => stationDetails(station, output)));
  actions.append(details);
  if (owner) {
    const remove = el("button", { class: "inline-link", type: "button", text: "Remove Station", "aria-haspopup": "dialog" });
    remove.addEventListener("click", () => confirmed(remove, output, ["Remove " + station.origin + "?", "Every integration on this Station is revoked and its members lose access. This can't be undone.", "Remove Station"], async () => {
      await request("/api/stations/" + segment(station.id), { method: "DELETE" });
      notify("Station removed.");
      await loadAll();
    }));
    actions.append(remove);
  } else {
    const leave = el("button", { class: "inline-link", type: "button", text: "Leave", "aria-haspopup": "dialog" });
    leave.addEventListener("click", () => confirmed(leave, output, ["Leave " + station.origin + "?", "You lose this Station, and your integrations on it are revoked.", "Leave Station"], async () => {
      await request("/api/stations/" + segment(station.id) + "/members/" + segment(me.account.id), { method: "DELETE" });
      notify("You left the Station.");
      await loadAll();
    }));
    actions.append(leave);
  }
  const facts = [owner ? "You own it" : "Shared with you", station.createdAt ? "Added " + date(station.createdAt) : "", station.status && station.status !== "active" ? words(station.status) : ""].filter(Boolean).join(" · ");
  return el("article", { class: "account-card station-item", "data-row": station.id }, [
    el("h3", { class: "mono", text: station.origin }),
    el("p", { class: "muted", text: facts }),
    actions,
    output,
    ...(owner ? [membersPanel(station)] : [])
  ]);
}
async function loadStations(current = version) {
  const list = document.querySelector("#station-list");
  try {
    const result = await request("/api/stations");
    if (current !== version) return;
    stations = result.stations;
    document.querySelector("#stations-stale").textContent = result.stale ? STALE : "";
    list.replaceChildren(...stations.map(stationRow));
    if (!stations.length) list.append(el("p", { class: "empty-panel", text: "No Stations yet. Add one to connect your apps to your agents." }));
  } catch (error) {
    if (current !== version) return;
    stations = [];
    list.replaceChildren(el("p", { class: "form-error", text: error.message }));
  }
  syncStationSelect();
}

// Add Station: the origin gets a single-use value to serve, then the Station's report key registers it.
const stationStatus = document.querySelector("#station-status");
function resetChallenge({ keepKey = false } = {}) {
  challenge = null;
  document.querySelector("#station-challenge").hidden = true;
  document.querySelector("#station-challenge-value").textContent = "";
  document.querySelector("#station-challenge-url").textContent = "";
  document.querySelector("#station-challenge-expiry").textContent = "";
  if (!keepKey) stationForm.elements.reportKey.value = "";
  document.querySelector("#station-submit").textContent = "Get the check value";
}
function closeStationForm() { resetChallenge(); stationForm.elements.origin.value = ""; stationStatus.textContent = ""; toggleForm(stationForm, document.querySelector("#station-add"), false); }
document.querySelector("#station-add").addEventListener("click", () => { if (stationForm.hidden) toggleForm(stationForm, document.querySelector("#station-add"), true); else closeStationForm(); });
document.querySelector("#station-cancel").addEventListener("click", closeStationForm);
stationForm.elements.origin.addEventListener("input", () => { if (challenge) resetChallenge(); });
document.querySelector("#station-challenge-copy").addEventListener("click", () => { if (challenge) copy(challenge.value, "Value"); });
stationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = document.querySelector("#station-submit");
  if (!challenge) {
    const origin = stationForm.elements.origin.value.trim();
    if (!origin) { stationStatus.textContent = "Enter the Station's HTTPS address."; return; }
    act(submit, stationStatus, async () => {
      challenge = await request("/api/stations/challenges", { method: "POST", body: { origin } });
      document.querySelector("#station-challenge-url").textContent = challenge.url;
      document.querySelector("#station-challenge-value").textContent = challenge.value;
      document.querySelector("#station-challenge-expiry").textContent = "This value works once, for 10 minutes (until " + new Date(challenge.expiresAt).toLocaleTimeString() + ").";
      document.querySelector("#station-challenge").hidden = false;
      submit.textContent = "Verify and register";
      stationForm.elements.reportKey.focus();
    });
    return;
  }
  let reportKey;
  try { reportKey = JSON.parse(stationForm.elements.reportKey.value); } catch { reportKey = null; }
  if (!reportKey || typeof reportKey !== "object" || Array.isArray(reportKey)) { stationStatus.textContent = "Paste the Station's report public key as JWK JSON."; return; }
  act(submit, stationStatus, async () => {
    try { await request("/api/stations", { method: "POST", body: { challengeId: challenge.challengeId, reportKey } }); }
    // The Portal spends the value before it fetches the proof; only a refused report key leaves it unused.
    catch (error) {
      if (error.code !== "report_key") { resetChallenge({ keepKey: true }); if (error.code !== "challenge") error.message += " Get a new check value and try again."; }
      throw error;
    }
    closeStationForm();
    notify("Station registered.");
    await loadAll();
  });
});

// Integrations: the account's own, and others on Stations it owns (which it may pause or revoke).
const integrationStatus = document.querySelector("#integration-status");
const createKey = keyField(document.querySelector("#integration-key"), () => integrationForm.elements.name.value);
function syncStationSelect() {
  const select = integrationForm.elements.stationId;
  const chosen = select.value;
  const usable = stations.filter((station) => !station.status || station.status === "active");
  select.replaceChildren(...usable.map((station) => el("option", { value: station.id, text: station.origin })));
  if (usable.some((station) => station.id === chosen)) select.value = chosen;
  document.querySelector("#integration-submit").disabled = !usable.length;
  if (!usable.length && !integrationForm.hidden) integrationStatus.textContent = "Add a Station first.";
}
function closeIntegrationForm() {
  integrationForm.reset();
  createKey.reset();
  integrationStatus.textContent = "";
  toggleForm(integrationForm, document.querySelector("#integration-add"), false);
}
document.querySelector("#integration-add").addEventListener("click", () => {
  if (!integrationForm.hidden) { closeIntegrationForm(); return; }
  toggleForm(integrationForm, document.querySelector("#integration-add"), true);
  syncStationSelect();
});
document.querySelector("#integration-cancel").addEventListener("click", closeIntegrationForm);
integrationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = integrationForm.elements;
  const name = fields.name.value.trim();
  const quotaPerSecond = Number(fields.quotaPerSecond.value), expiresInDays = Number(fields.expiresInDays.value);
  const publicJwk = createKey.value();
  const problem = !name ? "Name the integration." : !fields.stationId.value ? "Add a Station first." : !Number.isInteger(quotaPerSecond) || quotaPerSecond < 1 || quotaPerSecond > 10000 ? "Choose a quota of 1 to 10000 token requests per second." : !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90 ? "Choose an expiry of 1 to 90 days." : typeof publicJwk === "string" ? publicJwk : "";
  if (problem) { integrationStatus.textContent = problem; return; }
  const scopes = ["agent.view", ...[...integrationForm.querySelectorAll("input[name=scope]:checked:not(:disabled)")].map((input) => input.value)];
  act(document.querySelector("#integration-submit"), integrationStatus, async () => {
    await request("/api/integrations", { method: "POST", body: { name, stationId: fields.stationId.value, scopes, quotaPerSecond, expiresInDays, publicJwk } });
    closeIntegrationForm();
    notify("Integration created. Approve it in Astation.");
    await loadIntegrations();
  });
});
async function openHistory(integration) {
  const list = document.querySelector("#integration-events");
  const output = document.querySelector("#integration-history-status");
  document.querySelector("#integration-history-title").textContent = integration.name;
  list.replaceChildren();
  output.textContent = "Loading history...";
  historyDialog.showModal();
  try {
    const { events } = await request("/api/integrations/" + segment(integration.id) + "/events");
    output.textContent = events.length ? "" : "No events yet.";
    list.replaceChildren(...events.map((entry) => el("li", { class: "statement-row" }, [
      el("div", {}, [el("strong", { text: words(entry.kind) }), el("time", { datetime: entry.at, text: time(entry.at) })]),
      el("span", { class: "muted", text: [entry.state ? stateLabel(entry.state) : "", entry.reason ? words(entry.reason) : "", entry.actor ? "by " + entry.actor : ""].filter(Boolean).join(" · ") })
    ])));
  } catch (error) { output.textContent = error.message; }
}
// A small inline form inside a <details>: one number field and a button.
function numberAction(summary, label, attrs, button, run) {
  const input = el("input", { type: "number", step: "1", required: "", ...attrs });
  const output = el("p", { class: "form-note", role: "status" });
  const submit = el("button", { class: "button button-secondary button-small", type: "submit", text: button });
  const form = el("form", { class: "stack-form inline-action", novalidate: "" }, [el("label", {}, [label, input]), submit, output]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < Number(attrs.min) || value > Number(attrs.max)) { output.textContent = "Choose a whole number from " + attrs.min + " to " + attrs.max + "."; return; }
    act(submit, output, () => run(value));
  });
  return el("details", { class: "integration-action" }, [el("summary", { text: summary }), form]);
}
// The key fields of the rendered integration rows; released (any pending private-key URL revoked and its link removed)
// before the rows are re-rendered or hidden.
let rotateKeys = [];
function releaseRotateKeys() {
  for (const key of rotateKeys) key.reset();
  rotateKeys = [];
}
function rotatePanel(integration) {
  const container = el("div", { class: "key-field", id: "rotate-" + integration.id });
  const key = keyField(container, () => integration.name);
  rotateKeys.push(key);
  const output = el("p", { class: "form-note", role: "status" });
  const submit = el("button", { class: "button button-secondary button-small", type: "submit", text: "Add key" });
  const form = el("form", { class: "stack-form inline-action", novalidate: "" }, [container, submit, output]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const publicJwk = key.value();
    if (typeof publicJwk === "string") { output.textContent = publicJwk; return; }
    act(submit, output, async () => {
      const result = await request("/api/integrations/" + segment(integration.id) + "/keys", { method: "POST", body: { publicJwk } });
      key.reset();
      output.textContent = "New key added." + (result.overlapEndsAt ? " The previous key keeps working until " + time(result.overlapEndsAt) + "." : "");
    });
  });
  const panel = el("details", { class: "integration-action" }, [el("summary", { text: "Rotate key" }), form]);
  panel.addEventListener("toggle", () => { if (!panel.open) key.reset(); });
  return panel;
}
function integrationRow(integration) {
  const owner = integration.role === "owner";
  const state = integration.state;
  const path = "/api/integrations/" + segment(integration.id) + "/";
  const output = el("p", { class: "form-note", role: "status" });
  const actions = el("div", { class: "agora-project-actions" });
  const change = async (action) => { await request(path + action, { method: "POST" }); await loadIntegrations(); };
  if (LIVE.includes(state)) {
    const pause = el("button", { class: "inline-link", type: "button", text: "Pause" });
    pause.addEventListener("click", () => act(pause, output, () => change("pause")));
    actions.append(pause);
  }
  if (owner && state === "paused") {
    const resume = el("button", { class: "inline-link", type: "button", text: "Resume" });
    resume.addEventListener("click", () => act(resume, output, () => change("resume")));
    actions.append(resume);
  }
  if (!STOPPED.includes(state)) {
    const revoke = el("button", { class: "inline-link", type: "button", text: "Revoke", "aria-haspopup": "dialog" });
    revoke.addEventListener("click", () => confirmed(revoke, output, ["Revoke " + integration.name + "?", "The app loses access through this integration for good. This can't be undone.", "Revoke integration"], () => change("revoke")));
    actions.append(revoke);
  }
  const history = el("button", { class: "inline-link", type: "button", text: "History", "aria-haspopup": "dialog" });
  history.addEventListener("click", () => openHistory(integration));
  actions.append(history);
  const panels = [];
  if (owner && !STOPPED.includes(state)) {
    panels.push(
      numberAction("Renew", "Expires after (days)", { min: "1", max: "90", value: "30" }, "Renew", async (expiresInDays) => { await request(path + "renew", { method: "POST", body: { expiresInDays } }); notify("Integration renewed."); await loadIntegrations(); }),
      numberAction("Quota", "Token requests per second", { min: "1", max: "10000", value: String(integration.quotaPerSecond ?? 200) }, "Save quota", async (quotaPerSecond) => { await request(path + "settings", { method: "POST", body: { quotaPerSecond } }); notify("Quota saved."); await loadIntegrations(); }),
      rotatePanel(integration)
    );
  }
  const badge = el("span", { class: "state-badge state-badge--" + String(state).replace(/[^a-z_]/g, "").replace(/_/g, "-"), text: stateLabel(state) });
  const fact = (term, value) => value ? [el("dt", { text: term }), el("dd", { text: value })] : [];
  return el("article", { class: "account-card integration-item", "data-row": integration.id }, [
    el("div", { class: "integration-heading" }, [el("h3", { text: integration.name }), badge]),
    ...(owner ? [] : [el("p", { class: "muted", text: "Another account's integration on your Station. You can pause or revoke it." })]),
    el("dl", { class: "integration-facts" }, [
      ...fact("Station", integration.stationOrigin || ""),
      ...fact("Scopes", (integration.scopes || []).join(", ")),
      ...fact("Quota", integration.quotaPerSecond ? integration.quotaPerSecond.toLocaleString() + " token requests / s" : ""),
      ...fact(state === "expired" ? "Expired" : "Expires", time(integration.expiresAt)),
      ...fact("Last error", integration.lastError || "")
    ]),
    actions,
    output,
    ...(panels.length ? [el("div", { class: "integration-panels" }, panels)] : [])
  ]);
}
async function loadIntegrations(current = version) {
  const list = document.querySelector("#integration-list");
  try {
    const result = await request("/api/integrations");
    if (current !== version) return;
    document.querySelector("#integrations-stale").textContent = result.stale ? STALE : "";
    releaseRotateKeys();
    list.replaceChildren(...result.integrations.map(integrationRow));
    if (!result.integrations.length) list.append(el("p", { class: "empty-panel", text: "No integrations yet. Create one to let an app act for you." }));
  } catch (error) {
    if (current !== version) return;
    releaseRotateKeys();
    list.replaceChildren(el("p", { class: "form-error", text: error.message }));
  }
}
async function loadAll() {
  const current = version;
  await Promise.all([loadStations(current), loadIntegrations(current)]);
}

// Shown only for a signed-in account, and only when the Portal has its integrations database.
async function refresh() {
  const current = ++version;
  try { me = await request("/api/me"); } catch { me = null; }
  if (current !== version) return;
  const shown = Boolean(me?.account && me.integrationsAvailable);
  stationsSection.hidden = !shown;
  integrationsSection.hidden = !shown;
  if (!shown) {
    stations = [];
    closeStationForm();
    closeIntegrationForm();
    for (const dialog of [confirmDialog, historyDialog]) if (dialog.open) dialog.close();
    document.querySelector("#station-list").replaceChildren();
    releaseRotateKeys();
    document.querySelector("#integration-list").replaceChildren();
    return;
  }
  await loadAll();
  if (current === version && ["#stations", "#integrations"].includes(location.hash)) document.querySelector(location.hash).scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
historyDialog.addEventListener("close", () => document.querySelector("#integration-events").replaceChildren());
// The first session event has fired by the time sessionReady settles; later ones (sign-out, refreshes) re-check.
await sessionReady;
document.addEventListener("house:session", () => { refresh(); });
await refresh();
