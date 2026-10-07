import { api, el } from "./script.js";

const feed = document.querySelector("#activity-feed");
const status = document.querySelector("#activity-status");
const button = document.querySelector("#refresh-activity");
let entries = [];
let loading = false;
let signature = "";

function timeLabel(date) {
  const seconds = Math.max(0, (Date.now() - Date.parse(date)) / 1000);
  if (seconds < 60) return "under a minute ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}

function row(entry) {
  const external = entry.source === "github";
  const person = entry.canViewProfile ? el("button", { class: "activity-person", type: "button", "data-profile-id": entry.actorId, text: entry.actorName }) : el("strong", { text: entry.actorName });
  return el("li", { class: "activity-item" }, [
    el("span", { class: "activity-glyph mono", "aria-hidden": "true", text: entry.kind === "push" ? ">_" : entry.kind === "room" || entry.kind === "room-join" ? "[ ]" : "+" }),
    el("div", { class: "activity-copy" }, [
      el("p", {}, [person, " " + entry.action + " ", el("a", { href: entry.url, ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}), text: entry.subject })]),
      el("div", { class: "activity-meta" }, [el("span", { class: "activity-source mono", text: external ? "GITHUB" : "FOUNDRY" }), ...(entry.detail ? [el("span", { class: "activity-detail", text: entry.detail })] : [])])
    ]),
    el("time", { datetime: entry.createdAt, title: new Date(entry.createdAt).toLocaleString(), "data-event-time": entry.createdAt, text: timeLabel(entry.createdAt) })
  ]);
}

async function refresh() {
  if (loading) return;
  loading = true;
  button.disabled = true;
  try {
    const result = await api("/api/activity");
    entries = result.items.slice(0, 5);
    const nextSignature = JSON.stringify(entries);
    // Keep focused source links intact when a poll returns the same events.
    if (signature !== nextSignature) {
      feed.replaceChildren(...(entries.length ? entries.map(row) : [el("li", { class: "activity-placeholder", text: "No public activity yet. Open a room or share your intent to put something in motion." })]));
      signature = nextSignature;
    }
    const github = result.github;
    status.textContent = github.status === "fresh" ? "PUBLIC LOG / AUTO-REFRESHING" : github.status === "unavailable" ? "GITHUB SYNC PENDING / SAVED EVENTS" : "PUBLIC LOG / SAVED SNAPSHOT";
    status.classList.toggle("is-fresh", github.status === "fresh");
    const checked = github.checkedAt ? "GitHub checked " + new Date(github.checkedAt).toLocaleString() + ". " : "";
    document.querySelector("#activity-note").textContent = checked + "Public events may arrive with a delay. Room activity reflects the roster, not call attendance.";
  } catch {
    status.textContent = "ACTIVITY CONNECTION UNAVAILABLE";
    status.classList.remove("is-fresh");
    if (!entries.length) feed.replaceChildren(el("li", { class: "activity-placeholder", text: "The public log could not be loaded. Try refreshing in a moment." }));
  } finally { loading = false; button.disabled = false; }
}

button.addEventListener("click", refresh);
document.addEventListener("house:people", refresh);
const timer = setInterval(() => {
  if (document.hidden) return;
  for (const time of feed.querySelectorAll("[data-event-time]")) time.textContent = timeLabel(time.dataset.eventTime);
  refresh();
}, 60000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
await refresh();
