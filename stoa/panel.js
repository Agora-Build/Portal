const $ = (selector) => document.querySelector(selector);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };

// The Stoa side panel: everything the canvas offers, as plain controls for keyboard and screen reader users.
export function createPanel() {
  const status = $("#stoa-status"), here = $("#stoa-here"), topicForm = $("#stoa-topic-form"), offer = $("#stoa-offer"), roomsSection = $("#stoa-rooms-section"), rooms = $("#stoa-rooms"), people = $("#stoa-people"), messages = $("#stoa-messages"), sayForm = $("#stoa-say"), sayInput = $("#stoa-say-text"), signin = $("#stoa-signin");
  const handlers = { go() {}, say() { return false; }, topic() {}, leave() {}, start() {}, signin() {} };
  sayForm.addEventListener("submit", (event) => { event.preventDefault(); if (handlers.say(sayInput.value)) sayInput.value = ""; });
  topicForm.addEventListener("submit", (event) => { event.preventDefault(); handlers.topic(topicForm.elements.topic.value, topicForm.elements.tags.value); });
  $("#stoa-leave").addEventListener("click", () => handlers.leave());
  $("#stoa-start").addEventListener("click", () => handlers.start());
  $("#stoa-signin-button").addEventListener("click", () => handlers.signin());
  return {
    on(next) { Object.assign(handlers, next); },
    say(message) { status.textContent = message; },
    setRooms(lots, summaries) {
      rooms.replaceChildren(...lots.map((lot) => {
        const room = summaries.get(lot.slug) || { topic: null, occupancy: 0, capacity: lot.capacity };
        const entry = node("li", "", "stoa-room"), go = node("button", "Go to", "button button-secondary button-small");
        go.type = "button";
        go.setAttribute("aria-label", "Walk to " + lot.title);
        go.addEventListener("click", () => handlers.go(lot));
        entry.append(node("strong", lot.title), node("span", (room.topic || "Open") + " · " + room.occupancy + " of " + room.capacity + " here"), go);
        return entry;
      }));
    },
    setPeople(list, selfName) { people.replaceChildren(node("li", selfName + " (you)"), ...list.map((person) => node("li", person.name))); },
    addMessage({ name, text, self }) {
      const entry = node("li", "", self ? "is-self" : "");
      entry.append(node("strong", name), document.createTextNode(" " + text));
      messages.append(entry);
      while (messages.children.length > 50) messages.firstElementChild.remove();
    },
    clearMessages() { messages.replaceChildren(); },
    canTalk(allowed) { sayForm.hidden = !allowed; signin.hidden = allowed; },
    showRoom({ kicker, title, topic, tags = [], host, leaveLabel }) {
      here.hidden = false; roomsSection.hidden = true;
      $("#stoa-here-kicker").textContent = kicker;
      $("#stoa-here-title").textContent = title;
      $("#stoa-here-topic").textContent = topic ? topic + (tags.length ? " · " + tags.join(", ") : "") : host ? "You're the host. Set a topic so people know what this room is about." : "No topic yet.";
      topicForm.hidden = !host;
      $("#stoa-leave").textContent = leaveLabel;
      sayInput.placeholder = "Say something to the room";
    },
    showPlaza() { here.hidden = true; topicForm.hidden = true; roomsSection.hidden = false; sayInput.placeholder = "Say something on the plaza"; },
    showOffer({ spaces = [], canCreate = false } = {}) {
      offer.hidden = false;
      $("#stoa-offer-list").replaceChildren(...spaces.map((space) => { const item = node("li"), link = node("a", space.title); link.href = space.path; item.append(link); return item; }));
      $("#stoa-start").hidden = !canCreate;
    },
    hideOffer() { offer.hidden = true; }
  };
}
