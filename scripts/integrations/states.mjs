// Pure lifecycle state machine for integrations (no I/O). Portal never sets Ready itself:
// only Station reports (report:*) move an integration into waiting_for_host / ready / revoked.
import { AppError } from "../store.mjs";

export const STATES = ["awaiting_approval", "provisioning", "waiting_for_host", "ready", "paused", "revoking", "revoked"];
export const REPORT_STATES = ["waiting_for_host", "ready", "revoked"];

const LIVE = ["awaiting_approval", "provisioning", "waiting_for_host", "ready"];
const EDGES = {
  approve: { awaiting_approval: "provisioning" },
  "report:waiting_for_host": { provisioning: "waiting_for_host", ready: "waiting_for_host" },
  "report:ready": { provisioning: "ready", waiting_for_host: "ready" },
  "report:revoked": { revoking: "revoked" }
};
export const EVENTS = [...Object.keys(EDGES), "pause", "resume", "revoke", "renew"];
const BLOCKED_WHEN_EXPIRED = ["approve", "pause", "resume"];

function invalid(message, code = "invalid_state") {
  return Object.assign(new AppError(409, message), { details: { code } });
}

// The state as shown and as Stations see it: expired for anything not yet revoking, and paused while Auth's change feed
// says the owner's account is disabled (Auth issues the integration no token then; spec §3.3.4), whatever the row's own
// state. Transitions use the row's own state.
export function effectiveState(row, now) {
  if (row.state === "revoking" || row.state === "revoked") return row.state;
  if (row.expiresAt != null && new Date(row.expiresAt).getTime() <= now) return "expired";
  if (row.ownerDisabledAt != null) return "paused";
  return row.state;
}

export function transition(row, event, now) {
  if (!EVENTS.includes(event)) throw invalid("This integration event is not recognised.");
  const resumeState = row.resumeState ?? null;
  if (BLOCKED_WHEN_EXPIRED.includes(event) && effectiveState(row, now) === "expired") throw invalid("This integration has expired.", "expired");
  const refuse = () => invalid("This integration is " + row.state.replace(/_/g, " ") + " and cannot take that action.");
  const { state } = row;
  if (EDGES[event]) {
    if (state === "paused" && event.startsWith("report:")) {
      const next = EDGES[event][resumeState];
      if (!next) throw refuse();
      return { state, resumeState: next };
    }
    const next = EDGES[event][state];
    if (!next) throw refuse();
    return { state: next, resumeState };
  }
  if (event === "pause") {
    if (!LIVE.includes(state)) throw refuse();
    return { state: "paused", resumeState: state };
  }
  if (event === "resume") {
    if (state !== "paused") throw refuse();
    return { state: resumeState, resumeState: null };
  }
  if (event === "revoke") {
    if (state === "revoking" || state === "revoked") return { state, resumeState };
    if (state === "awaiting_approval") return { state: "revoked", resumeState };
    return { state: "revoking", resumeState: state === "paused" ? null : resumeState };
  }
  // renew
  if (state === "revoking" || state === "revoked") throw refuse();
  return { state, resumeState };
}
