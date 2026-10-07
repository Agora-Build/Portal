import { readFile } from "node:fs/promises";
import { safeUrl } from "./store.mjs";

const endpoint = "https://api.github.com/orgs/Agora-Build/events?per_page=30";
const interval = 120000;

export function githubEvents(events, projects) {
  const repositories = new Set(projects.map((project) => "Agora-Build/" + project.name));
  const seen = new Set();
  return events.flatMap((event) => {
    const repo = event?.repo?.name;
    const actor = event?.actor?.login;
    if (!repositories.has(repo) || !actor || event.public === false || !event.id || seen.has(event.id) || !Number.isFinite(Date.parse(event.created_at))) return [];
    const payload = event.payload || {};
    const base = "https://github.com/" + repo;
    const entry = { id: "github:" + event.id, source: "github", actorId: "github:" + actor, actorName: actor, actorLogin: actor, subject: repo.split("/")[1], createdAt: event.created_at, url: base, detail: "" };
    if (event.type === "PushEvent") {
      entry.kind = "push";
      entry.action = "pushed code to";
      entry.detail = typeof payload.ref === "string" ? payload.ref.replace(/^refs\/heads\//, "").slice(0, 100) : "";
      if (/^[a-f0-9]{40}$/i.test(payload.head)) entry.url = base + "/commit/" + payload.head;
    } else if (event.type === "PullRequestEvent" || event.type === "IssuesEvent") {
      const item = event.type === "PullRequestEvent" ? payload.pull_request : payload.issue;
      if (!item || !["opened", "closed", "reopened"].includes(payload.action)) return [];
      entry.kind = event.type === "PullRequestEvent" ? "pull-request" : "issue";
      entry.action = (item.merged ? "merged" : payload.action) + (entry.kind === "issue" ? " an issue in" : " a pull request in");
      entry.detail = typeof item.title === "string" ? item.title.slice(0, 140) : "";
      const link = safeUrl(item.html_url);
      if (link && link.startsWith(base + "/")) entry.url = link;
    } else if (event.type === "ReleaseEvent" && payload.action === "published") {
      entry.kind = "release";
      entry.action = "published a release for";
      entry.detail = String(payload.release?.tag_name || "").slice(0, 100);
      const link = safeUrl(payload.release?.html_url);
      if (link && link.startsWith(base + "/")) entry.url = link;
    } else return [];
    seen.add(event.id);
    return [entry];
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function createActivityFeed({ store, projectsFile, snapshotFile, request = fetch, now = Date.now }) {
  let entries = [];
  let checkedAt = null;
  let status = "pending";
  let nextCheck = 0;
  let etag = "";
  let inFlight;
  const ready = (async () => {
    if (!snapshotFile) return;
    try {
      const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
      const projects = JSON.parse(await readFile(projectsFile, "utf8"));
      entries = githubEvents(snapshot.events, projects);
      checkedAt = snapshot.checkedAt;
      status = "cached";
    } catch { /* The live feed also works without a saved snapshot. */ }
  })();

  async function refresh() {
    await ready;
    // All browsers share one upstream request and one cache window.
    if (inFlight) return inFlight;
    if (now() < nextCheck) return;
    inFlight = (async () => {
      nextCheck = now() + interval;
      try {
        const response = await request(endpoint, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Agora-Build-Portal", ...(etag ? { "If-None-Match": etag } : {}) }, signal: AbortSignal.timeout(8000) });
        if (response.status !== 304) {
          if (!response.ok) {
            if ([403, 429].includes(response.status)) {
              const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
              if (Number.isFinite(reset)) nextCheck = Math.max(nextCheck, Math.min(reset, now() + 3600000));
            }
            throw new Error("GitHub unavailable");
          }
          const events = await response.json();
          if (!Array.isArray(events)) throw new Error("Invalid event feed");
          const projects = JSON.parse(await readFile(projectsFile, "utf8"));
          entries = githubEvents(events, projects);
          etag = response.headers.get("etag") || "";
        }
        checkedAt = new Date(now()).toISOString();
        status = "fresh";
      } catch { status = "unavailable"; }
    })();
    try { await inFlight; } finally { inFlight = undefined; }
  }

  return {
    async get() {
      await refresh();
      const [people, community] = await Promise.all([store.people(), store.activity()]);
      const names = new Map(people.filter((person) => person.username).map((person) => [person.username, person.name]));
      const profileIds = new Set(people.map((person) => person.id));
      const github = entries.map((entry) => ({ ...entry, actorName: names.get(entry.actorLogin) || entry.actorName }));
      return { items: [...github, ...community].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 18).map((entry) => ({ ...entry, canViewProfile: profileIds.has(entry.actorId) })), github: { status, checkedAt }, pollAfterSeconds: 60 };
    }
  };
}
