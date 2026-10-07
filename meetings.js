import { api, el, avatar, state, notify, openJoin, sessionReady } from "./script.js";
import { openCall } from "./call.js";
const grid = document.querySelector("#rooms-grid");
let revealedInvite = false;
async function refresh() {
  await sessionReady;
  const [result, people] = await Promise.all([api("/api/rooms"), api("/api/people")]);
  state.people = people.people;
  document.querySelector("#meeting-availability").textContent = result.calls.ready ? "Agora calls are configured. Open a room when you are ready." : "Agora calls are being connected. Create a room and share its invite in the meantime.";
  const directRoom = /^\/meet\/([a-f0-9-]{36})$/.exec(location.pathname)?.[1];
  const sharedRoom = directRoom || new URLSearchParams(location.search).get("room");
  const rooms = directRoom ? result.rooms.filter((room) => room.id === directRoom) : result.rooms;
  const invited = result.rooms.find((room) => room.id === sharedRoom);
  if (state.profile && invited && sessionStorage.getItem("foundry-room-join") === invited.id) {
    sessionStorage.removeItem("foundry-room-join");
    await api("/api/rooms/" + invited.id + "/join", { method: "POST" });
    await refresh(); return;
  }
  document.querySelector("#room-count").textContent = rooms.length + (rooms.length === 1 ? " room" : " rooms");
  document.querySelector("#rooms-empty").hidden = rooms.length > 0;
  if (directRoom && invited) {
    document.title = invited.title + " | Agora Build";
    document.querySelector(".meeting-intro h1").textContent = invited.title;
    document.querySelector(".meeting-intro > div > p:last-child").textContent = invited.intent;
  }
  grid.replaceChildren(...rooms.map((room) => {
    const members = room.participants.map((id) => state.people.find((person) => person.id === id)).filter(Boolean);
    const joined = state.profile && room.participants.includes(state.profile.id);
    return el("article", { class: "room-card" + (sharedRoom === room.id ? " is-highlighted" : ""), id: "room-" + room.id }, [
      el("div", { class: "room-top" }, [el("span", { class: "kicker", text: "GROUP ROOM" }), el("span", { class: "room-provider", text: "AGORA RTC" })]),
      el("h3", { text: room.title }), el("p", { class: "room-intent", text: room.intent }),
      el("a", { class: "room-url mono", href: room.path, text: new URL(room.path, location.origin).href }),
      el("div", { class: "room-roster" }, [el("div", { class: "avatar-stack" }, members.slice(0, 5).map((person) => el("button", { class: "roster-person", type: "button", "data-profile-id": person.id, "aria-label": "View " + person.name + " profile", title: person.name }, [avatar(person, "avatar-small")]))), el("span", { class: "muted", text: members.length + (members.length === 1 ? " person on the roster" : " people on the roster") })]),
      el("div", { class: "room-actions" }, [
        joined ? el("button", { class: "button", type: "button", text: "Open call", onclick: () => openCall(room, result.calls.ready) }) : el("button", { class: "button", type: "button", text: "Join the room", onclick: async () => {
          if (!state.profile) {
            sessionStorage.setItem("foundry-room-join", room.id);
            openJoin(() => refresh().catch((error) => notify(error.message))); return;
          }
          try { await api("/api/rooms/" + room.id + "/join", { method: "POST" }); await refresh(); notify("You are on the room roster. Open the call when you are ready."); } catch (error) { notify(error.message); }
        } }),
        el("button", { class: "button button-secondary", type: "button", text: "Copy invite link", onclick: async () => {
          const link = new URL(room.path, location.origin).href;
          try {
            if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(link);
            else {
              const input = el("textarea", { class: "copy-buffer", text: link });
              document.body.append(input); input.select();
              const copied = document.execCommand("copy"); input.remove();
              if (!copied) throw new Error();
            }
            notify("Room invite link copied.");
          } catch { window.prompt("Copy this room invite link:", link); }
        } })
      ])
    ]);
  }));
  if (!revealedInvite && sharedRoom && result.rooms.some((room) => room.id === sharedRoom)) {
    document.querySelector("#room-" + sharedRoom)?.scrollIntoView({ block: "nearest" });
    revealedInvite = true;
    if (state.profile && invited?.participants.includes(state.profile.id)) openCall(invited, result.calls.ready);
  }
}
await refresh().catch((error) => notify(error.message));
document.addEventListener("house:session", () => refresh().catch((error) => notify(error.message)));
const rosterTimer = setInterval(() => {
  if (!document.hidden) refresh().catch(() => {});
}, 15000);
window.addEventListener("pagehide", () => clearInterval(rosterTimer), { once: true });
