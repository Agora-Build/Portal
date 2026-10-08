// People are rebuilt only when who is here (or a name) changes, so a busy plaza doesn't churn the page.
export const peopleKey = (list, selfName) => selfName + "\n" + list.map((person) => person.id + "\u0000" + person.name).sort().join("\n");

// The Stoa side panel: everything the canvas offers, as plain controls for keyboard and screen reader users.
export function createPanel(doc = document) {
  const $ = (selector) => doc.querySelector(selector);
  const node = (tag, text, className) => { const element = doc.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
  const status = $("#stoa-status"), here = $("#stoa-here"), topicForm = $("#stoa-topic-form"), offer = $("#stoa-offer"), roomsSection = $("#stoa-rooms-section"), rooms = $("#stoa-rooms"), people = $("#stoa-people"), messages = $("#stoa-messages"), sayForm = $("#stoa-say"), sayInput = $("#stoa-say-text"), signin = $("#stoa-signin"), signinText = $("#stoa-signin-text"), signinButton = $("#stoa-signin-button");
  let shownPeople = null;
  const roomRows = new Map();
  const handlers = { go() {}, say() { return false; }, topic() {}, leave() {}, start() {}, signin() {} };
  sayForm.addEventListener("submit", (event) => { event.preventDefault(); if (handlers.say(sayInput.value)) sayInput.value = ""; });
  topicForm.addEventListener("submit", (event) => { event.preventDefault(); handlers.topic(topicForm.elements.topic.value, topicForm.elements.tags.value); });
  $("#stoa-leave").addEventListener("click", () => handlers.leave());
  $("#stoa-start").addEventListener("click", () => handlers.start());
  signinButton.addEventListener("click", () => handlers.signin());
  return {
    on(next) { Object.assign(handlers, next); },
    say(message) { status.textContent = message; },
    // Rows are created once per room and updated in place, so a focused Go to button keeps focus across polls.
    setRooms(lots, summaries) {
      const wanted = [];
      for (const lot of lots) {
        const room = summaries.get(lot.slug) || { topic: null, occupancy: 0, capacity: lot.capacity };
        let row = roomRows.get(lot.slug);
        if (!row) {
          const entry = node("li", "", "stoa-room"), status = node("span"), go = node("button", "Go to", "button button-secondary button-small");
          go.type = "button";
          go.setAttribute("aria-label", "Walk to " + lot.title);
          go.addEventListener("click", () => handlers.go(lot));
          entry.append(node("strong", lot.title), status, go);
          row = { entry, status };
          roomRows.set(lot.slug, row);
        }
        const text = (room.topic || "Open") + " \u00b7 " + room.occupancy + " of " + room.capacity + " here";
        if (row.status.textContent !== text) row.status.textContent = text;
        wanted.push(row.entry);
      }
      for (const slug of [...roomRows.keys()]) if (!lots.some((lot) => lot.slug === slug)) roomRows.delete(slug);
      const now = [...rooms.children];
      if (now.length !== wanted.length || wanted.some((entry, index) => entry !== now[index])) rooms.replaceChildren(...wanted);
    },
    setPeople(list, selfName) {
      const key = peopleKey(list, selfName);
      if (key === shownPeople) return;
      shownPeople = key;
      people.replaceChildren(node("li", selfName + " (you)"), ...list.map((person) => node("li", person.name)));
    },
    addMessage({ name, text, self }) {
      const entry = node("li", "", self ? "is-self" : "");
      entry.append(node("strong", name), document.createTextNode(" " + text));
      messages.append(entry);
      while (messages.children.length > 50) messages.firstElementChild.remove();
    },
    clearMessages() { messages.replaceChildren(); },
    // When talking isn't possible, a reason (for someone already signed in) replaces the sign-in prompt.
    canTalk(allowed, reason = "") { sayForm.hidden = !allowed; signin.hidden = allowed; signinText.textContent = reason || "Sign in to walk and talk."; signinButton.hidden = Boolean(reason); },
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
