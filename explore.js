const cards = Array.from(document.querySelectorAll(".directory-card"));
const categoryButtons = Array.from(document.querySelectorAll("[data-directory-filter]"));
const searchInput = document.querySelector("#project-search");
const sortSelect = document.querySelector("#project-sort");
const count = document.querySelector("#directory-count");
const heading = document.querySelector("#category-heading");
const emptyState = document.querySelector("#empty-state");
const grid = document.querySelector(".directory-grid");
const categoryNames = {
  all: "All projects",
  rtc: "Real-time communication",
  ai: "Real-time AI",
  tools: "Developer tools",
  experiments: "Samples & experiments"
};
let activeCategory = "all";

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  const category = params.get("category");
  activeCategory = Object.hasOwn(categoryNames, category) ? category : "all";
  searchInput.value = params.get("q") || "";
  const sort = params.get("sort");
  sortSelect.value = ["featured", "name", "activity"].includes(sort) ? sort : "featured";
}

function render(updateUrl = true) {
  const terms = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchesSearch = (card) => terms.every((term) => card.dataset.search.includes(term));
  const hasCategory = (card, category) => category === "all" || card.dataset.directoryCategory.split(" ").includes(category);
  let visibleCount = 0;

  for (const card of cards) {
    card.hidden = !(matchesSearch(card) && hasCategory(card, activeCategory));
    if (!card.hidden) visibleCount += 1;
  }

  for (const button of categoryButtons) {
    const category = button.dataset.directoryFilter;
    const active = category === activeCategory;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.querySelector("[data-category-count]").textContent = cards.filter((card) => matchesSearch(card) && hasCategory(card, category)).length;
  }

  const sorted = [...cards].sort((first, second) => {
    if (sortSelect.value === "name") return first.dataset.name.localeCompare(second.dataset.name, "en");
    const key = sortSelect.value === "activity" ? "activity" : "featured";
    return Number(first.dataset[key]) - Number(second.dataset[key]);
  });
  const fragment = document.createDocumentFragment();
  for (const card of sorted) fragment.append(card);
  grid.append(fragment);

  heading.textContent = categoryNames[activeCategory];
  count.textContent = visibleCount + (visibleCount === 1 ? " project" : " projects");
  emptyState.hidden = visibleCount !== 0;

  // Keep search and category links shareable without reloading the page.
  if (updateUrl) {
    const url = new URL(window.location.href);
    if (activeCategory === "all") url.searchParams.delete("category");
    else url.searchParams.set("category", activeCategory);
    if (searchInput.value.trim()) url.searchParams.set("q", searchInput.value.trim());
    else url.searchParams.delete("q");
    if (sortSelect.value === "featured") url.searchParams.delete("sort");
    else url.searchParams.set("sort", sortSelect.value);
    window.history.replaceState(null, "", url);
  }
}

for (const button of categoryButtons) {
  button.addEventListener("click", () => {
    activeCategory = button.dataset.directoryFilter;
    render();
  });
}
searchInput.addEventListener("input", () => render());
sortSelect.addEventListener("change", () => render());
document.querySelector("#reset-search").addEventListener("click", () => {
  activeCategory = "all";
  searchInput.value = "";
  sortSelect.value = "featured";
  render();
  searchInput.focus();
});
window.addEventListener("popstate", () => {
  readUrl();
  render(false);
});
readUrl();
render(false);
