import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createAppServer } from "../scripts/serve.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";

const root = new URL("../", import.meta.url).pathname;
const read = (name) => readFile(resolve(root, name), "utf8");
const close = (instance) => new Promise((done) => { instance.close(done); instance.closeIdleConnections(); });

async function served(t) {
  const temporary = await mkdtemp(resolve(tmpdir(), "agora-integrations-page-"));
  const instance = createAppServer(root, { monitor: false, storageFile: resolve(temporary, "store.json"), models: createModelClient(modelConfig({})), calls: createAgoraCalls(agoraConfig({})), idp: null });
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  t.after(async () => { await close(instance); await rm(temporary, { recursive: true, force: true }); });
  return "http://127.0.0.1:" + instance.address().port;
}

test("/account/ carries the Stations and Integrations sections, hidden by default, with accessible names", async (t) => {
  const html = await (await fetch((await served(t)) + "/account/")).text();
  const stations = html.match(/<section id="stations"[^>]*>/)?.[0] || "";
  const integrations = html.match(/<section id="integrations"[^>]*>/)?.[0] || "";
  assert.match(stations, /class="membership-section"/);
  assert.match(stations, /aria-labelledby="stations-title"/);
  assert.match(stations, /\shidden[\s>]/);
  assert.match(integrations, /aria-labelledby="integrations-title"/);
  assert.match(integrations, /\shidden[\s>]/);
  assert.match(html, /06 \/ STATIONS/);
  assert.match(html, /<h2 id="stations-title">Your relays and Stations\.<\/h2>/);
  assert.match(html, /07 \/ INTEGRATIONS/);
  assert.match(html, /<h2 id="integrations-title">Apps that act for you\.<\/h2>/);
  assert.match(html, /08 \/ STATEMENT/);
  assert.doesNotMatch(html, /06 \/ STATEMENT/);
  const order = ["05 / CONNECTIONS", "06 / STATIONS", "07 / INTEGRATIONS", "08 / STATEMENT"].map((part) => html.indexOf(part));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /<script type="module" src="\/integrations\.js"><\/script>/);
  const dialogs = html.match(/<dialog id="(station|integration)-[^"]*"[^>]*>/g) || [];
  assert.ok(dialogs.length);
  for (const dialog of dialogs) assert.match(dialog, /aria-labelledby="/, dialog);
});

test("the integration form offers agent.launch, agent.message and agent.notify and says they need an upgraded Atem", async () => {
  const html = await read("account.html");
  const fieldset = html.match(/<fieldset class="token-choice scope-choice"[^>]*>[\s\S]*?<\/fieldset>/)?.[0] || "";
  const values = [...fieldset.matchAll(/name="scope" value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ["agent.view", "agent.prompt", "agent.approve", "agent.interrupt", "agent.terminal", "agent.launch", "agent.message", "agent.notify"]);
  const note = html.match(/<p class="form-note" id="scope-note">[\s\S]*?<\/p>/)?.[0] || "";
  assert.match(note, /agent\.launch<\/strong>: Start new agent sessions on your hosts, only from profiles you approved there\./);
  assert.match(note, /agent\.message<\/strong>: Send messages, context and attachments to your hosts and projects\. On their own, messages never make an agent act\./);
  assert.match(note, /agent\.notify<\/strong>: Let this app's messages become work for an agent, handed to it when the agent is free\. Also needs agent\.message and agent\.prompt, and your approval of the route on the host\./);
  assert.match(note, /All three need an upgraded Atem on the host\./);
  assert.match(fieldset, /aria-describedby="scope-note"/);
});

test("/integrations.js is served as JavaScript", async (t) => {
  const response = await fetch((await served(t)) + "/integrations.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/javascript/);
  assert.equal(await response.text(), await read("integrations.js"));
});

test("the script generates keys in the browser and never stores or logs the private key", async () => {
  const script = await read("integrations.js");
  assert.match(script, /crypto\.subtle\.generateKey\(\{ name: "ECDSA", namedCurve: "P-256" \}, true, \["sign", "verify"\]\)/);
  assert.match(script, /\.private\.jwk\.json/);
  assert.match(script, /URL\.revokeObjectURL/);
  // Re-rendering or hiding the integration rows first releases any private-key URL their key fields still hold.
  assert.equal((script.match(/releaseRotateKeys\(\);\n\s*(document\.querySelector\("#integration-list"\)|list)\.replaceChildren\(/g) || []).length, 3);
  assert.match(script, /panel\.addEventListener\("toggle", \(\) => \{ if \(!panel\.open\) key\.reset\(\); \}\)/, "closing a rotate panel releases its key");
  assert.match(script, /Agora\.Build never receives this file\. Keep it with your app\./);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.doesNotMatch(script, /console\./);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /credentials: "same-origin"/);
  assert.match(script, /mode: "cors", credentials: "omit"/);
  assert.match(script, /This Station does not offer details yet\./);
  assert.match(script, /integrationsAvailable/);
  for (const label of ["Awaiting approval in Astation", "Provisioning", "Waiting for host", "Ready", "Paused", "Expired", "Revoking", "Revoked"]) assert.match(script, new RegExp("\"" + label + "\""), label);
  assert.match(script, /Showing saved details; Auth could not be reached\./);
});

test("the build copies integrations.js and the server lists it as public", async () => {
  assert.match(await read("scripts/build.mjs"), /"account\.js", "integrations\.js"/);
  assert.match(await read("scripts/serve.mjs"), /"account\.js", "integrations\.js"/);
  assert.match(await read("tests/server.test.mjs"), /"account\.js", "integrations\.js"/);
});

test("confirmations ask before the action runs, so the opener stays enabled and gets focus back", async () => {
  const script = await read("integrations.js");
  // A button disabled while its <dialog> is open can't take focus back when the dialog closes (Escape or Keep it).
  assert.doesNotMatch(script, /act\([^\n]*\n?\s*if \(!await confirmAction/);
  assert.equal((script.match(/confirmed\(\w+, output, \[/g) || []).length, 5, "Remove member, Remove Station, Leave, Revoke and Interrupt running tasks confirm first");
  // After the rows re-render, focus that was on the action's button moves to the same control of the new row.
  assert.match(script, /data-row/);
  assert.match(script, /function restoreFocus\(button, row\)/);
});

test("a failed Station check drops the used value so the form asks for a new one", async () => {
  const script = await read("integrations.js");
  // The Portal spends the check value before it fetches the proof; only a refused report key leaves it unused.
  assert.match(script, /if \(error\.code !== "report_key"\) \{ resetChallenge\(\{ keepKey: true \}\);/);
  assert.match(script, /Get a new check value and try again\./);
});

test("closing a form that held focus hands it back to the button that opened it", async () => {
  const script = await read("integrations.js");
  assert.match(script, /else if \(form\.contains\(document\.activeElement\) \|\| document\.activeElement === document\.body\) opener\.focus\(\);/);
  // A hidden button is still connected; focus goes back to it only when it is rendered.
  assert.match(script, /button\.isConnected && button\.getClientRects\(\)\.length/);
});

test("the built-in Station shows as Built in with Details only, and is offered for integrations only while enabled", async () => {
  const script = await read("integrations.js");
  assert.match(script, /if \(station\.builtIn\) return builtInRow\(station\);/);
  const row = script.slice(script.indexOf("function builtInRow("), script.indexOf("function stationRow("));
  assert.ok(row.length > 0, "builtInRow comes right before stationRow");
  assert.match(row, /text: "Built in"/);
  assert.match(row, /text: "Details"/);
  assert.doesNotMatch(row, /Remove|Share|Leave|membersPanel|confirmed\(/);
  assert.match(script, /\(!station\.builtIn \|\| station\.integrationsEnabled\)/);
  assert.match(script, /Integrations aren't available on the built-in Station yet\. Add your own Station to create one\./);
  assert.doesNotMatch(script, /station_admin|As an Agora\.Build admin/, "admins act on the admin site, never here (D26)");
  assert.match(await read("account.html"), /Every account has the built-in Agora Station/);
  assert.match(await read("styles.css"), /\.state-badge--built-in \{/);
});

test("an integration Agora.Build paused shows Paused by Agora.Build, offers no Resume, and its history names Agora.Build", async () => {
  const script = await read("integrations.js");
  assert.match(script, /const PAUSED_BY_AGORA = "Paused by Agora\.Build";/);
  assert.match(script, /const locked = state === "paused" && integration\.pausedBy === "admin";/);
  assert.match(script, /if \(owner && state === "paused" && !locked\) \{/);
  assert.match(script, /text: locked \? PAUSED_BY_AGORA : stateLabel\(state\)/);
  assert.match(script, /Agora\.Build paused this integration\. Only Agora\.Build can resume it; you can still revoke it\./);
  // A resume refused because Agora.Build paused it meanwhile says so and shows the list as it is now.
  assert.match(script, /if \(error\.code !== "admin_paused" && error\.code !== "owner_disabled"\) throw error;/);
  assert.match(script, /entry\.actor === "agora_build" \? "Agora\.Build" : entry\.actor/);
  assert.equal((script.match(/confirmed\(\w+, output, \[/g) || []).length, 5, "the only new confirmation is Interrupt running tasks (D29)");
});

test("with the setting on the page offers the revoke choice, Interrupt running tasks and the notes; with it off none of it shows (D29)", async () => {
  const html = await read("account.html");
  const script = await read("integrations.js");
  const exact = (name, text) => "const " + name + " = " + JSON.stringify(text) + ";";
  // The exact copy of the design (I.9).
  assert.ok(script.includes(exact("INTERRUPT_CHOICE", "Also interrupt the tasks running on your hosts now?")));
  assert.ok(script.includes(exact("EXPIRY_NOTE", "Expiry stops new work and queries. Work already accepted on your hosts runs until its deadline, at most 24 hours. Revoke to cancel work that hasn't started.")));
  assert.ok(script.includes(exact("PAUSE_NOTE", "Paused: new work is refused, and accepted work that hasn't started waits. Work running now continues.")));
  // Not "from each revoked integration": after Remove Station its owner no longer sees the members' integrations.
  assert.ok(script.includes(exact("INDIRECT_NOTE", "Tasks already running on hosts continue. Within 24 hours, the owner of each revoked integration can still interrupt them.")));
  // The Portal records a request; it can't know the outcome on the hosts.
  assert.ok(script.includes(exact("INTERRUPTED_NOTE", "Running tasks: an interrupt was requested.")));
  // A removed Station never reads its feed again, so its removal offers no interrupt: only that running tasks continue.
  assert.ok(script.includes(exact("REMOVED_NOTE", "Tasks already running on hosts continue.")));
  // The checkbox sits in the confirmation before its form, hidden and unticked; the host-senders line follows the description.
  const checkbox = "<label id=\"integration-confirm-option\" class=\"checkbox-label\" hidden><input id=\"integration-confirm-check\" type=\"checkbox\"><span id=\"integration-confirm-option-text\"></span></label>";
  const dialog = html.match(/<dialog id="integration-confirm"[\s\S]*?<\/dialog>/)?.[0] || "";
  assert.ok(dialog.includes(checkbox), "the checkbox markup");
  assert.ok(dialog.indexOf(checkbox) < dialog.indexOf("<form method=\"dialog\""), "the checkbox comes before the form");
  const note = "<p id=\"host-senders-note\" class=\"form-note\" hidden>Host-to-host senders are managed in Astation.</p>";
  const section = html.match(/<section id="integrations"[\s\S]*?<\/section>/)?.[0] || "";
  assert.ok(section.includes(note), "the host-senders line is in the Integrations section, hidden");
  assert.ok(section.indexOf("class=\"section-description\"") < section.indexOf(note) && section.indexOf(note) < section.indexOf("id=\"integrations-stale\""), "after the description");
  // confirmAction(title, text, action, option): with an option it shows the checkbox unticked with that text; without, it hides it.
  assert.match(script, /function confirmAction\(title, text, action, option\) \{/);
  assert.match(script, /document\.querySelector\("#integration-confirm-option"\)\.hidden = !option;/);
  assert.match(script, /document\.querySelector\("#integration-confirm-check"\)\.checked = false;/);
  assert.match(script, /document\.querySelector\("#integration-confirm-option-text"\)\.textContent = option \|\| "";/);
  // The revoke asks the choice and sends the answer; the setting off sends no body, as today.
  assert.match(script, /const hostWork = Boolean\(me\?\.delegatedHostWork\);/);
  assert.match(script, /const change = async \(action, body\) => \{ await request\(path \+ action, \{ method: "POST", body \}\); await loadIntegrations\(\); \};/);
  assert.match(script, /"Revoke integration", \.\.\.\(hostWork \? \[INTERRUPT_CHOICE\] : \[\]\)\], \(\) => change\("revoke", hostWork \? \{ interruptRunning: document\.querySelector\("#integration-confirm-check"\)\.checked \} : undefined\)\)\);/);
  // Interrupt running tasks: on a stopped integration still within its 24 hours, behind its own confirmation.
  assert.match(script, /if \(hostWork && STOPPED\.includes\(state\) && interruptible\(integration\) && !integration\.stationRemoved\) \{/);
  assert.match(script, /el\("button", \{ class: "inline-link", type: "button", text: "Interrupt running tasks", "aria-haspopup": "dialog" \}\)/);
  assert.match(script, /confirmed\(interrupt, output, \["Interrupt running tasks\?", "Tasks from " \+ integration\.name \+ " that are still running on the hosts are interrupted now\. This can't be undone\.", "Interrupt running tasks"\], \(\) => change\("interrupt"\)\)/);
  // The button comes after History in the row's actions, so focus after a revoke (the row is re-rendered without
  // Revoke) goes back to History, the first control, as before.
  const historyAt = script.indexOf("actions.append(history);");
  assert.ok(historyAt > 0 && historyAt < script.indexOf("if (hostWork && STOPPED.includes(state) && interruptible(integration) && !integration.stationRemoved) {"), "Interrupt running tasks comes after History");
  assert.ok(script.indexOf("actions.append(interrupt);") > historyAt, "Interrupt running tasks is appended after History");
  // The 24-hour check is one named function, as the server's: a revokedAt of null (never dated) is too late.
  const day = script.match(/^const DAY = .*;$/m)?.[0] || "";
  const check = script.match(/^const interruptible = .*;$/m)?.[0] || "";
  assert.equal(day, "const DAY = 24 * 60 * 60 * 1000;");
  assert.equal(check, "const interruptible = (integration) => !integration.interruptRunning && Boolean(integration.revokedAt) && Date.now() - Date.parse(integration.revokedAt) <= DAY;");
  const now = Date.parse("2026-11-11T12:00:00.000Z");
  const interruptible = new Function("Date", day + "\n" + check + "\nreturn interruptible;")({ now: () => now, parse: Date.parse });
  const ago = (hours) => new Date(now - hours * 3600000).toISOString();
  assert.equal(interruptible({ interruptRunning: false, revokedAt: ago(1) }), true);
  assert.equal(interruptible({ interruptRunning: false, revokedAt: ago(24) }), true, "exactly 24 hours is still allowed, as at the server");
  assert.equal(interruptible({ interruptRunning: false, revokedAt: ago(24.01) }), false);
  assert.equal(interruptible({ interruptRunning: false, revokedAt: null }), false, "never dated: too late");
  assert.equal(interruptible({ interruptRunning: false, revokedAt: "not a date" }), false);
  assert.equal(interruptible({ interruptRunning: true, revokedAt: ago(1) }), false, "already asked for");
  // The notes: pause and expiry, and that running tasks were interrupted, as muted notes after the Agora.Build lock note.
  assert.match(script, /const notes = !hostWork \? \[\] : \[state === "paused" && PAUSE_NOTE, state === "expired" && EXPIRY_NOTE, STOPPED\.includes\(state\) && integration\.interruptRunning && INTERRUPTED_NOTE, appliedNote\(integration\), unconfirmedNote\(integration\)\]\.filter\(Boolean\);/);
  assert.match(script, /\.\.\.\(owner && locked \? \[el\("p", \{ class: "muted", text: LOCKED_NOTE \}\)\] : \[\]\),\n\s*\.\.\.notes\.map\(\(note\) => el\("p", \{ class: "muted", text: note \}\)\),/);
  // How a revocation went on the hosts (the `revocation` on a stopped integration's view), one named function per sentence:
  // a revoking integration says how many hosts applied it; a revoked one whose final report said deadline_passed says how
  // many didn't confirm. No host names; any other outcome, or nothing to say, is no note.
  const count = script.match(/^const hostCount = .*;$/m)?.[0] || "";
  const applied = script.match(/^const appliedNote = .*;$/m)?.[0] || "";
  const unconfirmed = script.match(/^const unconfirmedNote = .*;$/m)?.[0] || "";
  assert.ok(applied.startsWith("const appliedNote = (integration) =>") && unconfirmed.startsWith("const unconfirmedNote = (integration) =>"), "one small named function for each sentence");
  const appliedNote = new Function(count + "\n" + applied + "\nreturn appliedNote;")();
  const unconfirmedNote = new Function(count + "\n" + unconfirmed + "\nreturn unconfirmedNote;")();
  const revocation = (state, fields) => ({ state, revocation: { appliedHosts: 0, outcome: null, unconfirmedHosts: null, ...fields } });
  assert.equal(appliedNote(revocation("revoking", { appliedHosts: 1 })), "Applied on 1 host");
  assert.equal(appliedNote(revocation("revoking", { appliedHosts: 2 })), "Applied on 2 hosts");
  assert.equal(appliedNote(revocation("revoking", { appliedHosts: 64 })), "Applied on 64 hosts");
  assert.equal(appliedNote(revocation("revoking", { appliedHosts: 0 })), "", "no host has applied it yet: no note");
  assert.equal(appliedNote({ state: "revoking" }), "", "no revocation object (the setting off, or a view from before): no note");
  assert.equal(appliedNote({ state: "revoking", revocation: null }), "");
  assert.equal(appliedNote(revocation("revoked", { appliedHosts: 3, outcome: "all_applied" })), "", "only a revoking row says it");
  assert.equal(appliedNote(revocation("paused", { appliedHosts: 3 })), "");
  assert.equal(unconfirmedNote(revocation("revoked", { appliedHosts: 1, outcome: "deadline_passed", unconfirmedHosts: 1 })), "Revoked (1 host didn't confirm; any unstarted work there has passed its deadline)");
  assert.equal(unconfirmedNote(revocation("revoked", { appliedHosts: 1, outcome: "deadline_passed", unconfirmedHosts: 3 })), "Revoked (3 hosts didn't confirm; any unstarted work there has passed its deadline)");
  assert.equal(unconfirmedNote(revocation("revoked", { outcome: "deadline_passed", unconfirmedHosts: 0 })), "", "every host confirmed since: no note");
  assert.equal(unconfirmedNote(revocation("revoked", { outcome: "deadline_passed", unconfirmedHosts: null })), "");
  assert.equal(unconfirmedNote(revocation("revoked", { appliedHosts: 2, outcome: "all_applied" })), "");
  assert.equal(unconfirmedNote(revocation("revoked", { outcome: null })), "", "no final report yet");
  assert.equal(unconfirmedNote({ state: "revoked" }), "");
  assert.equal(unconfirmedNote({ state: "revoked", revocation: null }), "");
  assert.equal(unconfirmedNote(revocation("revoking", { outcome: "deadline_passed", unconfirmedHosts: 2 })), "", "only a revoked row says it");
  assert.equal((script.match(/confirmed\(\w+, output, \[/g) || []).length, 5, "the notes add no confirmation");
  // The indirect revocations say running tasks continue, only with the setting on; off, the text is today's.
  const helper = script.match(/^const indirect = .*;$/m)?.[0] || "";
  assert.equal(helper, "const indirect = (text) => me?.delegatedHostWork ? text + \" \" + INDIRECT_NOTE : text;");
  const indirect = (account) => new Function("me", "INDIRECT_NOTE", helper + "\nreturn indirect;")(account, "NOTE");
  assert.equal(indirect(null)("Text."), "Text.");
  assert.equal(indirect({ account: {} })("Text."), "Text.");
  assert.equal(indirect({ delegatedHostWork: true })("Text."), "Text. NOTE");
  // Remove Station has its own helper and note: no interrupt is offered for a Station that is gone.
  const removing = script.match(/^const removing = .*;$/m)?.[0] || "";
  assert.equal(removing, "const removing = (text) => me?.delegatedHostWork ? text + \" \" + REMOVED_NOTE : text;");
  const removal = (account) => new Function("me", "REMOVED_NOTE", removing + "\nreturn removing;")(account, "GONE");
  assert.equal(removal(null)("Text."), "Text.");
  assert.equal(removal({ account: {} })("Text."), "Text.");
  assert.equal(removal({ delegatedHostWork: true })("Text."), "Text. GONE");
  assert.match(script, /\["Remove this member\?", indirect\(member\.account \+ " loses this Station, and their integrations on it are revoked\."\), "Remove member"\]/);
  assert.match(script, /\["Remove " \+ station\.origin \+ "\?", removing\("Every integration on this Station is revoked and its members lose access\. This can't be undone\."\), "Remove Station"\]/);
  assert.match(script, /\["Leave " \+ station\.origin \+ "\?", indirect\("You lose this Station, and your integrations on it are revoked\."\), "Leave Station"\]/);
  // The host-senders line shows only for a signed-in account, with the setting on.
  assert.match(script, /document\.querySelector\("#host-senders-note"\)\.hidden = !\(shown && me\.delegatedHostWork\);/);
  // Everything new is behind the setting: each use of the new copy is on a line that tests it.
  for (const name of ["INTERRUPT_CHOICE", "EXPIRY_NOTE", "PAUSE_NOTE", "INDIRECT_NOTE", "REMOVED_NOTE", "INTERRUPTED_NOTE", "appliedNote", "unconfirmedNote"]) {
    const uses = script.split("\n").filter((line) => new RegExp("\\b" + name + "\\b").test(line) && !line.startsWith("const " + name + " ="));
    assert.ok(uses.length, name + " is used");
    for (const line of uses) assert.match(line, /\bhostWork\b|me\?\.delegatedHostWork/, name + ": " + line.trim());
  }
  assert.doesNotMatch(script, /console\.|innerHTML/);
});
