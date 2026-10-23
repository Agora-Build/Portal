import { AppError } from "./store.mjs";

export function creditsConfig(env = process.env) {
  const costs = Object.fromEntries(["chat", "tts"].map((marketplace) => {
    const raw = env["MARKETPLACE_" + marketplace.toUpperCase() + "_CREDITS"];
    const cost = raw === undefined || raw === "" ? 0 : Number(raw);
    if (!Number.isSafeInteger(cost) || cost < 0 || cost > 1000000000) throw new Error("Marketplace credit prices must be non-negative whole numbers.");
    return [marketplace, cost];
  }));
  return { costs, ready: true };
}

export function createCredits(config = creditsConfig(), { ledger } = {}) {
  return {
    config,
    balance(userId) { return ledger.balance(userId); },
    statement(userId, cursor) { return ledger.statement(userId, cursor); },
    reserve(userId, service, credits, key) { return ledger.reserve(userId, service, credits, key); },
    settle(userId, id, outcome, service) { return ledger.settle(userId, id, outcome, service); },
    async run(userId, marketplace, key, action) {
      const cost = config.costs[marketplace];
      if (!Number.isSafeInteger(cost)) throw new AppError(422, "Unknown marketplace price.");
      if (!cost) return action();
      if (!/^[A-Za-z0-9:_-]{16,120}$/.test(key || "")) throw new AppError(422, "Provide an Idempotency-Key of 16 to 120 characters.");
      const reservation = await ledger.reserve(userId, marketplace, cost, key);
      if (reservation.status !== "reserved") throw new AppError(409, "This marketplace request is already in progress or completed. Use a new key for a new request.");
      let result;
      try { result = await action(); }
      catch (error) { await ledger.settle(userId, reservation.id, "release"); throw error; }
      await ledger.settle(userId, reservation.id, "capture");
      return result;
    }
  };
}
