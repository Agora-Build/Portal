import { test } from "node:test";
import assert from "node:assert/strict";
import { createPanel, peopleKey } from "../stoa/panel.js";

// A minimal document: just enough of the element API for the panel to build lists and wire forms.
class Element {
  constructor(tag) { Object.assign(this, { tagName: tag, children: [], listeners: {}, attrs: {}, hidden: false, textContent: "", className: "", replaced: 0, elements: { topic: { value: "" }, tags: { value: "" } } }); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this.replaced += 1; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attrs[name] = value; }
  get firstElementChild() { return this.children[0]; }
  remove() {}
}
function fakeDocument() {
  const registry = new Map();
  return { registry, querySelector: (selector) => { if (!registry.has(selector)) registry.set(selector, new Element(selector)); return registry.get(selector); }, createElement: (tag) => new Element(tag), createTextNode: (text) => ({ text }) };
}
const lots = [{ slug: "agents", title: "AI agents", capacity: 8 }, { slug: "voice", title: "Voice", capacity: 6 }];

test("room rows are created once and updated in place, so focus survives polling", () => {
  const doc = fakeDocument(), panel = createPanel(doc), rooms = doc.registry.get("#stoa-rooms");
  panel.setRooms(lots, new Map());
  const [first, second] = rooms.children, button = first.children[2];
  assert.equal(first.children[1].textContent, "Open · 0 of 8 here");
  panel.setRooms(lots, new Map([["agents", { topic: "Evals", occupancy: 3, capacity: 8 }]]));
  assert.deepEqual(rooms.children, [first, second]);
  assert.equal(rooms.children[0].children[2], button, "the same Go to button stays in the page");
  assert.equal(first.children[1].textContent, "Evals · 3 of 8 here");
  assert.equal(rooms.replaced, 1, "the list was built once");
});
test("people are rebuilt only when who is here or a name changes", () => {
  const doc = fakeDocument(), panel = createPanel(doc), list = doc.registry.get("#stoa-people");
  const ada = { id: "account:1", name: "Ada", walk: {} };
  panel.setPeople([ada], "Me");
  panel.setPeople([{ ...ada, walk: { moved: true } }], "Me");
  assert.equal(list.replaced, 1, "walking changes nothing visible in the list");
  panel.setPeople([{ ...ada, name: "Ada L." }], "Me");
  assert.equal(list.replaced, 2);
  panel.setPeople([{ ...ada, name: "Ada L." }, { id: "account:2", name: "Bo" }], "Me");
  assert.equal(list.replaced, 3);
  assert.equal(peopleKey([{ id: "b", name: "B" }, { id: "a", name: "A" }], "Me"), peopleKey([{ id: "a", name: "A" }, { id: "b", name: "B" }], "Me"));
});
test("a reason replaces the sign-in prompt for people who are signed in", () => {
  const doc = fakeDocument(), panel = createPanel(doc), signin = doc.registry.get("#stoa-signin"), button = doc.registry.get("#stoa-signin-button"), text = doc.registry.get("#stoa-signin-text");
  panel.canTalk(false);
  assert.deepEqual([signin.hidden, button.hidden, text.textContent], [false, false, "Sign in to walk and talk."]);
  panel.canTalk(false, "The plaza is full — you're watching.");
  assert.deepEqual([signin.hidden, button.hidden, text.textContent], [false, true, "The plaza is full — you're watching."]);
  panel.canTalk(true);
  assert.equal(signin.hidden, true);
});

test("the Decorate button shows only for the host and calls the decorate handler", () => {
  const doc = fakeDocument(), panel = createPanel(doc);
  let opened = 0;
  panel.on({ decorate: () => { opened += 1; } });
  panel.showRoom({ kicker: "LOT ROOM", title: "AI agents", topic: null, tags: [], host: false, leaveLabel: "Back" });
  assert.equal(doc.querySelector("#stoa-decor-open").hidden, true);
  panel.showRoom({ kicker: "LOT ROOM", title: "AI agents", topic: null, tags: [], host: true, leaveLabel: "Back" });
  assert.equal(doc.querySelector("#stoa-decor-open").hidden, false);
  doc.querySelector("#stoa-decor-open").listeners.click();
  assert.equal(opened, 1);
});
