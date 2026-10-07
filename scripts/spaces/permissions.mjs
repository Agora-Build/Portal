// One rule set for REST handlers and token issuing. Visibility decides who can learn a space exists; access decides who can enter.
export const VISIBILITY = ["listed", "unlisted", "private"];
export const ACCESS = ["open", "house", "members"];
export const validCombination = (visibility, access) => VISIBILITY.includes(visibility) && ACCESS.includes(access) && (visibility !== "private" || access === "members");

export function can(actor, action, space, context = {}) {
  if (actor?.admin) return true;
  const mine = (id) => Boolean(actor && id && actor.ids.includes(id));
  const owner = mine(space.ownerId);
  const member = owner || (space.members || []).some(mine);
  const blocked = (space.blocked || []).some(mine);
  const present = Boolean(actor && context.present);
  switch (action) {
    case "see": return space.visibility !== "private" || member || Boolean(context.invited) || present;
    case "enter":
      if (!actor || blocked || !can(actor, "see", space, context)) return false;
      if (space.access === "open") return true;
      if (space.access === "house") return actor.hasProfile || member;
      return member || Boolean(context.invited);
    case "chat": case "speak": return present && !blocked;
    case "host": case "decorate": case "moderate": return present && (mine(space.hostId) || owner);
    case "edit": case "invite": case "delete": return owner;
    default: return false;
  }
}
