import { api, el, state, notify, sessionReady, signIn, requestKey } from "./script.js";
const config = await api("/api/marketplaces").catch((error) => { notify(error.message); return null; });
if (config) {
  for (const marketplace of ["language", "speech"]) {
    document.querySelector("[data-marketplace-status=" + marketplace + "]").textContent = config[marketplace].ready ? "PROVIDER CONFIGURED" : "NOT CONNECTED YET";
    document.querySelector("[data-marketplace-status=" + marketplace + "]").classList.toggle("is-ready", config[marketplace].ready);
    const form = document.querySelector(marketplace === "language" ? "#llm-form" : "#speech-form");
    form.querySelector("[type=submit]").disabled = !config[marketplace].ready;
    const cost = config.credits?.costs[marketplace === "language" ? "chat" : "tts"] || 0;
    form.querySelector(".marketplace-note").textContent = config[marketplace].ready ? cost ? cost + " shared credits per request" : "Available without a credit charge" : "A provider needs to be connected before this marketplace is available.";
  }
  const offers = document.querySelector("#offers-list");
  if (config.offers.length) {
    offers.replaceChildren(...config.offers.map((offer) => el("a", { class: "offer-card", href: offer.url, target: "_blank", rel: "noopener noreferrer" }, [
      el("span", { class: "kicker", text: offer.provider }), el("h3", { text: offer.title }),
      el("p", { text: offer.description }), el("span", { class: "muted", text: offer.eligibility || "See provider for eligibility" }), el("span", { class: "inline-link", text: "View the offer ↗" })
    ])));
  }
}
document.querySelector("#llm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await sessionReady;
  if (!state.account) { notify("Sign in to use credits."); signIn(); return; }
  const button = event.currentTarget.querySelector("[type=submit]");
  const output = document.querySelector("#llm-output");
  button.disabled = true;
  output.textContent = "Thinking through it…";
  try { output.textContent = (await api("/api/marketplaces/chat", { method: "POST", headers: { "Idempotency-Key": requestKey() }, body: JSON.stringify({ message: document.querySelector("#llm-prompt").value }) })).answer; }
  catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
});
let audioUrl;
document.querySelector("#speech-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await sessionReady;
  if (!state.account) { notify("Sign in to use credits."); signIn(); return; }
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  button.disabled = true;
  const status = document.querySelector("#speech-status");
  status.textContent = "Generating speech…";
  try {
    const response = await fetch("/api/marketplaces/tts", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey() }, body: JSON.stringify({ text: form.elements.text.value, voice: form.elements.voice.value }) });
    if (!response.ok) throw new Error((await response.json()).error);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(await response.blob());
    const player = document.querySelector("#speech-audio");
    player.src = audioUrl;
    player.hidden = false;
    const download = document.querySelector("#speech-download");
    download.href = audioUrl;
    download.hidden = false;
    status.textContent = "Your AI-generated speech is ready.";
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});

// Credits belong to an account, so a browser-only guest sees why the forms ask them to sign in.
const guestNotice = async () => {
  await sessionReady;
  for (const note of document.querySelectorAll(".marketplace-note")) {
    note.dataset.base ??= note.textContent;
    note.textContent = state.account ? note.dataset.base : "Sign in to use credits.";
  }
};
guestNotice();
document.addEventListener("house:session", guestNotice);
