import { api, el, avatar, state, notify, sessionReady } from "./script.js";

const grid = document.querySelector("#people-grid");
const form = document.querySelector("#people-search");
const input = document.querySelector("#people-query");
const count = document.querySelector("#people-count");
const searchMode = document.querySelector("#search-mode");
const submit = form.querySelector("[type=submit]");
let skill = "all";
let requestNumber = 0;

function card(person) {
  const profileButton = el("button", { class: "profile-name", type: "button", "data-profile-id": person.id, text: person.name });
  const projectLinks = person.projects.slice(0, 3).map((project) => el("a", { href: project.url, target: "_blank", rel: "noopener noreferrer", text: project.name }));
  return el("article", { class: "person-card" }, [
    el("div", { class: "person-top" }, [avatar(person), el("div", {}, [profileButton, el("span", { class: "person-handle", text: person.username ? "@" + person.username : person.location || "House member" })]), el("span", { class: "source-mark", text: person.source === "github" ? "GITHUB" : "MEMBER" })]),
    el("p", { class: "person-bio", text: person.bio }),
    el("div", { class: "tags" }, person.skills.slice(0, 4).map((tag) => el("span", { text: tag }))),
    el("div", { class: "person-intent" }, [el("span", { class: "kicker", text: person.intent ? "WORKING TOWARD" : "FROM THE WORKSHOP" }), person.intent ? el("p", { text: person.intent }) : el("div", { class: "person-projects" }, projectLinks)]),
    ...(person.matchReason ? [el("p", { class: "match-reason", text: person.matchReason })] : []),
    el("div", { class: "person-bottom" }, [el("span", { class: "muted", text: person.location || "Remote / location not shared" }), el("button", { class: "inline-link", type: "button", "data-profile-id": person.id, text: "Meet " + person.name.split(" ")[0] + " ↗" })])
  ]);
}
function invitation() {
  return el("article", { class: "join-card" }, [
    el("span", { class: "join-symbol", "aria-hidden": "true", text: "+" }),
    el("span", { class: "kicker", text: "AN OPEN SEAT" }),
    el("h3", { text: "A seat with your name on it." }),
    el("p", { text: "Bring your work in progress. Share what you want to make happen. Give the right people a reason to find you." }),
    el("button", { class: "button", type: "button", "data-join": "", "data-guest-label": "Take a seat", text: state.profile ? "Your profile" : "Take a seat" })
  ]);
}
async function search() {
  const current = ++requestNumber;
  submit.disabled = true;
  form.setAttribute("aria-busy", "true");
  const query = input.value.trim();
  try {
    const [result, directory] = await Promise.all([
      api("/api/people/search", { method: "POST", body: JSON.stringify({ query, skill }) }),
      api("/api/people")
    ]);
    if (current !== requestNumber) return;
    state.people = directory.people;
    document.querySelector("#builder-total").textContent = String(directory.people.length).padStart(2, "0");
    grid.replaceChildren(...result.people.map(card));
    if (!state.profile && !query && skill === "all") grid.append(invitation());
    count.textContent = result.people.length + (result.people.length === 1 ? " builder" : " builders");
    document.querySelector("#people-empty").hidden = result.people.length !== 0;
    document.querySelector("#people-heading").textContent = query ? "People for your next move." : "Find your people.";
    document.querySelector("#result-mode").textContent = query ? result.mode === "llm" ? "MODEL-RANKED · WITH REASONS" : "BASIC SEARCH · PROFILE + PROJECT MATCHES" : "02 / PEOPLE BEHIND THE WORK";
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
    if (skill === "all") url.searchParams.delete("skill"); else url.searchParams.set("skill", skill);
    history.replaceState(null, "", url);
  } catch (error) { notify(error.message); document.querySelector("#result-mode").textContent = "SEARCH UNAVAILABLE · TRY AGAIN"; }
  finally { if (current === requestNumber) { submit.disabled = false; form.removeAttribute("aria-busy"); } }
}
form.addEventListener("submit", (event) => { event.preventDefault(); search(); });
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => { input.value = button.dataset.prompt; input.focus(); search(); }));
document.querySelectorAll("[data-skill]").forEach((button) => button.addEventListener("click", () => {
  skill = button.dataset.skill;
  document.querySelectorAll("[data-skill]").forEach((item) => { const active = item === button; item.classList.toggle("is-active", active); item.setAttribute("aria-pressed", String(active)); });
  search();
}));
document.querySelector("#clear-people").addEventListener("click", () => { input.value = ""; skill = "all"; document.querySelector("[data-skill=all]").click(); input.focus(); });
document.addEventListener("house:people", () => search());
const params = new URLSearchParams(window.location.search);
input.value = params.get("q") || "";
const initialSkill = params.get("skill");
const initialButton = [...document.querySelectorAll("[data-skill]")].find((button) => button.dataset.skill === initialSkill);
if (initialButton) { skill = initialSkill; document.querySelectorAll("[data-skill]").forEach((button) => { const active = button === initialButton; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); }); }
try {
  await sessionReady;
  const [people, projects] = await Promise.all([api("/api/people"), api("/api/projects")]);
  state.people = people.people;
  document.querySelector("#builder-total").textContent = String(people.people.length).padStart(2, "0");
  document.querySelector("#project-total").textContent = String(projects.projects.length).padStart(2, "0");
  searchMode.textContent = people.smartSearch ? "NATURAL-LANGUAGE SEARCH" : "DESCRIBE A PERSON · BASIC SEARCH AVAILABLE";
  await search();
} catch (error) { notify(error.message); }
