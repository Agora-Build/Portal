import { api, el, state, notify, sessionReady } from "./script.js";
const content = document.querySelector("#radar-results");
const button = document.querySelector("#scan-radar");
let ready = false;
async function refresh() {
  await sessionReady;
  const result = await api("/api/radar");
  ready = result.ready;
  button.disabled = !ready || !state.profile;
  document.querySelector("#radar-intent").textContent = state.profile?.intent || "Share your real intent. Tell the house what you are trying to build, learn, or solve.";
  document.querySelector("#radar-status").textContent = !state.profile ? "YOUR INTENT STARTS THE RADAR" : !ready ? "WEB CONNECTION PENDING" : state.profile.monitor ? "WATCHING · EVERY " + result.intervalHours + " HOURS" : "MANUAL SCANS";
  document.querySelector("#radar-status").classList.toggle("is-ready", Boolean(ready && state.profile));
  document.querySelector("#radar-edit").textContent = state.profile ? "Update your intent" : "Set your intent";
  const items = result.result?.items || [];
  if (items.length) {
    content.replaceChildren(...items.map((item) => el("article", { class: "radar-card" }, [
      el("span", { class: "kicker", text: item.kind === "person" ? "A PERSON TO KNOW" : "A RESOURCE TO USE" }),
      el("h3", { text: item.title }), el("p", { text: item.reason }),
      el("a", { class: "inline-link", href: item.url, target: "_blank", rel: "noopener noreferrer", text: "View source · " + new URL(item.url).hostname + " ↗" })
    ])));
  } else content.replaceChildren(el("div", { class: "empty-panel" }, [
    el("span", { class: "empty-icon", "aria-hidden": "true", text: "+" }),
    el("h3", { text: !state.profile ? "Start with what matters to you." : !ready ? "Your intent is ready. The radar is next." : "No grounded matches in this scan." }),
    el("p", { text: result.result?.error || (!ready ? "People and resources will appear here when the web search service is connected. Every suggestion will include a source and a reason to follow up." : "Run a scan or refine your intent. The radar looks for useful public information, then brings the sources back here.") })
  ]));
  document.querySelector("#last-scan").textContent = result.result?.checkedAt ? "Last checked " + new Date(result.result.checkedAt).toLocaleString() : "No scan has run yet.";
}
button.addEventListener("click", async () => {
  button.disabled = true;
  button.textContent = "Looking across the web…";
  try { await api("/api/radar", { method: "POST" }); await refresh(); notify("Your radar has been updated."); }
  catch (error) { notify(error.message); }
  finally { button.textContent = "Run a scan ↗"; button.disabled = !ready || !state.profile; }
});
await refresh().catch((error) => notify(error.message));
document.addEventListener("house:session", () => refresh().catch((error) => notify(error.message)));
