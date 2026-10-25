import assert from "node:assert/strict";
import test from "node:test";
import { STATES, REPORT_STATES, EVENTS, effectiveState, transition } from "../scripts/integrations/states.mjs";

const NOW = Date.UTC(2026, 9, 24);
const FUTURE = new Date(NOW + 86400000).toISOString();
const row = (state, extra = {}) => ({ state, resumeState: null, expiresAt: FUTURE, ...extra });

// Expected plain (non-paused) transitions: event -> { from: to }.
const LIVE = ["awaiting_approval", "provisioning", "waiting_for_host", "ready"];
const TABLE = {
  approve: { awaiting_approval: "provisioning" },
  "report:waiting_for_host": { provisioning: "waiting_for_host", ready: "waiting_for_host" },
  "report:ready": { provisioning: "ready", waiting_for_host: "ready" },
  "report:revoked": { revoking: "revoked" },
  pause: Object.fromEntries(LIVE.map((s) => [s, "paused"])),
  resume: { paused: "(resumeState)" },
  revoke: { awaiting_approval: "revoked", provisioning: "revoking", waiting_for_host: "revoking", ready: "revoking", paused: "revoking", revoking: "revoking", revoked: "revoked" },
  renew: Object.fromEntries(STATES.filter((s) => s !== "revoking" && s !== "revoked").map((s) => [s, s]))
};

function attempt(r, event) {
  try { return transition(r, event, NOW); } catch (error) { return error; }
}

test("constants", () => {
  assert.deepEqual(STATES, ["awaiting_approval", "provisioning", "waiting_for_host", "ready", "paused", "revoking", "revoked"]);
  assert.deepEqual(REPORT_STATES, ["waiting_for_host", "ready", "revoked"]);
  assert.deepEqual([...EVENTS].sort(), Object.keys(TABLE).sort());
});

test("every state x event pair allows exactly the table (non-paused rows)", () => {
  for (const event of EVENTS) {
    for (const state of STATES.filter((s) => s !== "paused" || event === "resume")) {
      const r = row(state, state === "paused" ? { resumeState: "ready" } : {});
      const result = attempt(r, event);
      const expected = TABLE[event][state];
      if (expected === undefined) {
        assert.equal(result.status, 409, event + " from " + state + " must be refused");
        assert.deepEqual(result.details, { code: "invalid_state" });
        assert.match(result.message, /\S/);
      } else {
        assert.equal(result.state, expected === "(resumeState)" ? "ready" : expected, event + " from " + state);
      }
    }
  }
});

test("pause records resumeState and resume restores it", () => {
  for (const from of LIVE) {
    const paused = transition(row(from), "pause", NOW);
    assert.deepEqual(paused, { state: "paused", resumeState: from });
    assert.deepEqual(transition({ ...row("paused"), resumeState: from }, "resume", NOW), { state: from, resumeState: null });
  }
  assert.equal(attempt({ ...row("paused"), resumeState: "ready" }, "pause").status, 409);
});

test("non-pause transitions keep the existing resumeState", () => {
  assert.deepEqual(transition(row("ready"), "report:waiting_for_host", NOW), { state: "waiting_for_host", resumeState: null });
  assert.deepEqual(transition(row("ready", { resumeState: "x" }), "renew", NOW), { state: "ready", resumeState: "x" });
});

test("station reports while paused update resumeState by the From rules", () => {
  const paused = (resumeState) => ({ state: "paused", resumeState, expiresAt: FUTURE });
  assert.deepEqual(transition(paused("provisioning"), "report:ready", NOW), { state: "paused", resumeState: "ready" });
  assert.deepEqual(transition(paused("provisioning"), "report:waiting_for_host", NOW), { state: "paused", resumeState: "waiting_for_host" });
  assert.deepEqual(transition(paused("waiting_for_host"), "report:ready", NOW), { state: "paused", resumeState: "ready" });
  assert.deepEqual(transition(paused("ready"), "report:waiting_for_host", NOW), { state: "paused", resumeState: "waiting_for_host" });
  for (const [resumeState, event] of [["waiting_for_host", "report:waiting_for_host"], ["ready", "report:ready"], ["awaiting_approval", "report:ready"], ["ready", "report:revoked"]]) {
    const error = attempt(paused(resumeState), event);
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { code: "invalid_state" });
  }
});

test("revoke from paused clears resumeState; revoke is idempotent when done or underway", () => {
  assert.deepEqual(transition({ state: "paused", resumeState: "ready", expiresAt: FUTURE }, "revoke", NOW), { state: "revoking", resumeState: null });
  assert.deepEqual(transition(row("revoking"), "revoke", NOW), { state: "revoking", resumeState: null });
  assert.deepEqual(transition(row("revoked"), "revoke", NOW), { state: "revoked", resumeState: null });
  assert.deepEqual(transition(row("awaiting_approval"), "revoke", NOW), { state: "revoked", resumeState: null });
});

test("effectiveState reports expiry except for revoking and revoked", () => {
  const past = new Date(NOW - 1000);
  assert.equal(effectiveState(row("ready"), NOW), "ready");
  assert.equal(effectiveState(row("ready", { expiresAt: past }), NOW), "expired");
  assert.equal(effectiveState(row("ready", { expiresAt: new Date(NOW).toISOString() }), NOW), "expired");
  assert.equal(effectiveState(row("paused", { expiresAt: past }), NOW), "expired");
  assert.equal(effectiveState(row("revoking", { expiresAt: past }), NOW), "revoking");
  assert.equal(effectiveState(row("revoked", { expiresAt: past }), NOW), "revoked");
});

test("approve, pause and resume on an expired row are refused as expired; revoke and renew still work", () => {
  const old = { expiresAt: new Date(NOW - 1000).toISOString() };
  for (const [state, event] of [["awaiting_approval", "approve"], ["ready", "pause"], ["paused", "resume"]]) {
    const error = attempt(row(state, { ...old, resumeState: "ready" }), event);
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { code: "expired" });
  }
  assert.equal(transition(row("ready", old), "revoke", NOW).state, "revoking");
  assert.equal(transition(row("ready", old), "renew", NOW).state, "ready");
});

test("an unknown event is refused", () => {
  assert.equal(attempt(row("ready"), "explode").status, 409);
});
