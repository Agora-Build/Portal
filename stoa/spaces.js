// Your own spaces: the list on the plaza, the create dialog, and the owner's manage dialog (settings, invites, members).
export const THEME_CHOICES = [["agora", "Agora"], ["minimal", "Minimal"], ["cyberpunk", "Cyberpunk"]];
const ACCESS_WORDS = { open: "anyone signed in", house: "house members", members: "members only" };
export function spacePayload(values) {
  const visibility = values.visibility === "private" ? "private" : "unlisted";
  const access = visibility === "private" ? "members" : Object.hasOwn(ACCESS_WORDS, values.access) ? values.access : "members";
  return { title: String(values.title || "").trim(), purpose: String(values.purpose || "").trim(), visibility, access, capacity: Number.parseInt(values.capacity, 10), themeId: THEME_CHOICES.some(([id]) => id === values.themeId) ? values.themeId : "agora" };
}
export const describeSpace = (space) => [space.visibility === "private" ? "Private" : "Unlisted", ACCESS_WORDS[space.access] || "members only", space.occupancy + " here"].join(" · ");
// Member ids look like account:<uuid>; the server matches the colon literally, so it must not be percent-encoded.
export const memberPath = (id) => encodeURIComponent(id).replace(/%3A/gi, ":");
export const inviteUrl = (origin, path) => new URL(path, origin).href;

export function createSpacesUi({ onSaved = () => {}, doc = document, api, say = () => {}, navigate = (path) => location.assign(path), confirm = (text) => window.confirm(text), copy = (text) => navigator.clipboard.writeText(text), origin = location.origin }) {
  const $ = (selector) => doc.querySelector(selector);
  const node = (tag, text, className) => { const element = doc.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
  const createDialog = $("#space-dialog"), createForm = $("#space-form"), manageDialog = $("#manage-dialog"), manageForm = $("#manage-form");
  let managing = null;
  // Private spaces admit members and invited people only, so the access choice is locked to members.
  const lockAccess = (form) => { const priv = form.elements.visibility.value === "private"; if (priv) form.elements.access.value = "members"; form.elements.access.disabled = priv; };
  for (const form of [createForm, manageForm]) form.elements.visibility.addEventListener("change", () => lockAccess(form));
  const fill = (form, space) => { for (const field of ["title", "purpose", "visibility", "access", "capacity", "themeId"]) form.elements[field].value = space[field] ?? ""; lockAccess(form); };
  const values = (form) => spacePayload(Object.fromEntries(["title", "purpose", "visibility", "access", "capacity", "themeId"].map((field) => [field, form.elements[field].value])));

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = createForm.querySelector("[type=submit]"), error = $("#space-error");
    button.disabled = true; error.textContent = "";
    try { const { space } = await api("/api/spaces", { method: "POST", body: JSON.stringify(values(createForm)) }); navigate("/stoa/s/" + space.id); }
    catch (failure) { error.textContent = failure.message; }
    finally { button.disabled = false; }
  });

  // `keep` is a person who gets no button: the server keeps the owner a member.
  function people(list, selector, label, action, keep = null) {
    $(selector).replaceChildren(...list.map((person) => {
      const item = node("li", "", "manage-person");
      item.append(node("span", person.name));
      if (action && person.id !== keep) { const button = node("button", label, "button button-secondary button-small"); button.type = "button"; button.setAttribute("aria-label", label + ": " + person.name); button.addEventListener("click", () => action(person)); item.append(button); }
      return item;
    }));
    if (!list.length) $(selector).replaceChildren(node("li", "Nobody yet.", "muted"));
  }
  async function load(id) {
    const { space } = await api("/api/spaces/" + encodeURIComponent(id));
    managing = space;
    fill(manageForm, space);
    $("#manage-title").textContent = "Manage " + space.title;
    people(space.roster || [], "#manage-members", "Remove", async (person) => {
      if (!confirm("Remove " + person.name + " from the members of " + space.title + "?")) return;
      $("#manage-error").textContent = "";
      try { await api("/api/spaces/" + encodeURIComponent(space.id) + "/members/" + memberPath(person.id), { method: "DELETE" }); await load(space.id); say(person.name + " is no longer a member."); }
      catch (error) { $("#manage-error").textContent = error.message; }
    }, space.ownerId);
    people(space.blockedRoster || [], "#manage-blocked", "Allow back", async (person) => {
      $("#manage-error").textContent = "";
      try { await api("/api/spaces/" + encodeURIComponent(space.id) + "/members", { method: "POST", body: JSON.stringify({ memberId: person.id }) }); await load(space.id); say(person.name + " can come back."); }
      catch (error) { $("#manage-error").textContent = error.message; }
    });
  }
  manageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("#manage-error"), button = manageForm.querySelector("[type=submit]");
    error.textContent = ""; button.disabled = true;
    try { const { space } = await api("/api/spaces/" + encodeURIComponent(managing.id), { method: "PUT", body: JSON.stringify(values(manageForm)) }); const themeChanged = space.themeId !== managing.themeId; managing = { ...managing, ...space }; say("Space settings saved."); onSaved(managing, themeChanged); }
    catch (failure) { error.textContent = failure.message; }
    finally { button.disabled = false; }
  });
  $("#manage-invite").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    $("#manage-error").textContent = ""; button.disabled = true;
    try {
      const invite = await api("/api/spaces/" + encodeURIComponent(managing.id) + "/invitations", { method: "POST", body: "{}" });
      const field = $("#manage-invite-url");
      field.value = inviteUrl(origin, invite.path);
      field.hidden = false; $("#manage-copy").hidden = false;
      $("#manage-invite-note").textContent = (invite.usesLeft === 1 ? "Works once" : "Works " + invite.usesLeft + " times") + " until " + new Date(invite.expiresAt).toLocaleString() + ". Anyone with it can join as a member.";
    } catch (error) { $("#manage-error").textContent = error.message; }
    finally { button.disabled = false; }
  });
  $("#manage-copy").addEventListener("click", async () => {
    $("#manage-error").textContent = "";
    try { await copy($("#manage-invite-url").value); say("Invite link copied."); }
    catch { $("#manage-invite-url").select?.(); say("Copy the selected link."); }
  });
  $("#manage-delete").addEventListener("click", async () => {
    if (!managing || !confirm("Delete " + managing.title + " for everyone? This can't be undone.")) return;
    $("#manage-error").textContent = "";
    try { await api("/api/spaces/" + encodeURIComponent(managing.id), { method: "DELETE" }); navigate("/stoa/"); }
    catch (error) { $("#manage-error").textContent = error.message; }
  });

  return {
    showMine({ spaces = [], canCreate = false, owned = 0, limit = 0 } = {}) {
      $("#stoa-mine").replaceChildren(...(spaces.length ? spaces.map((space) => {
        const item = node("li", "", "stoa-room"), link = node("a", space.title);
        link.href = space.path;
        item.append(link, node("span", describeSpace(space) + (space.owner ? "" : " · member")));
        return item;
      }) : [node("li", "You don't have any spaces yet.", "muted")]));
      $("#stoa-new").disabled = !canCreate;
      $("#stoa-mine-note").textContent = canCreate ? "" : "You own " + owned + " of " + limit + " spaces your plan allows.";
    },
    openCreate(prefill = {}) {
      createForm.reset();
      fill(createForm, { title: "", purpose: "", visibility: "unlisted", access: "members", capacity: 12, themeId: "agora", ...prefill });
      $("#space-error").textContent = "";
      createDialog.showModal();
    },
    async openManage(id) {
      $("#manage-error").textContent = "";
      $("#manage-invite-url").hidden = true; $("#manage-copy").hidden = true; $("#manage-invite-note").textContent = "";
      try { await load(id); manageDialog.showModal(); }
      catch (error) { say(error.message); }
    }
  };
}
