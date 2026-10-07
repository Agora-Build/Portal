import { api, el, state, notify, openSignIn, sessionReady, requestKey } from "./script.js";
const config = await api("/api/services").catch((error) => { notify(error.message); return null; });
if (config) {
  for (const service of ["language", "speech"]) {
    document.querySelector("[data-service-status=" + service + "]").textContent = config[service].ready ? "PROVIDER CONFIGURED" : "NOT CONNECTED YET";
    document.querySelector("[data-service-status=" + service + "]").classList.toggle("is-ready", config[service].ready);
    const form = document.querySelector(service === "language" ? "#llm-form" : "#speech-form");
    form.querySelector("[type=submit]").disabled = !config[service].ready;
    const cost = config.credits?.costs[service === "language" ? "chat" : "tts"] || 0;
    form.querySelector(".service-note").textContent = config[service].ready ? cost ? cost + " shared credits per request" : "Available without a credit charge" : "A provider needs to be connected before this service is available.";
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
  if (!state.profile && !state.account) { openSignIn(); return; }
  const button = event.currentTarget.querySelector("[type=submit]");
  const output = document.querySelector("#llm-output");
  button.disabled = true;
  output.textContent = "Thinking through it…";
  try { output.textContent = (await api("/api/services/chat", { method: "POST", headers: { "Idempotency-Key": requestKey() }, body: JSON.stringify({ message: document.querySelector("#llm-prompt").value }) })).answer; }
  catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
});
let audioUrl;
document.querySelector("#speech-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await sessionReady;
  if (!state.profile && !state.account) { openSignIn(); return; }
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  button.disabled = true;
  const status = document.querySelector("#speech-status");
  status.textContent = "Generating speech…";
  try {
    const response = await fetch("/api/services/tts", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey() }, body: JSON.stringify({ text: form.elements.text.value, voice: form.elements.voice.value }) });
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
