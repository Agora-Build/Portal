import { randomUUID } from "node:crypto";
import { AppError } from "./store.mjs";

function ledger(state) {
  state.ledger ||= { balances: {}, entries: [], reservations: [], deposits: {} };
  state.ledger.debts ||= {};
  return state.ledger;
}
function user(state, id) {
  if (!state.accounts.some((account) => account.id === id)) throw new AppError(404, "Portal user not found.");
}
function amount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000000) throw new AppError(422, "Use 1 to 1,000,000,000 whole credits.");
}
function transfer(book, from, to, credits, reason, ref) {
  const groupId = randomUUID();
  for (const [account, value] of [[from, -credits], [to, credits]]) {
    const balance = (book.balances[account] || 0) + value;
    if (!Number.isSafeInteger(balance) || (account.startsWith("account:") && balance < 0)) throw new AppError(409, "Insufficient credits.");
    book.balances[account] = balance;
    book.entries.push({ id: book.entries.length + 1, account, amount: value, reason, ref, groupId, createdAt: new Date().toISOString() });
  }
}
function repayRefundDebt(book, userId, ref) {
  const repaid = Math.min(book.balances[userId] || 0, book.debts[userId] || 0);
  if (repaid) {
    transfer(book, userId, "system:refund-debt:" + userId, repaid, "Refund adjustment repaid", ref);
    book.debts[userId] -= repaid;
  }
}
export function depositCredits(state, userId, credits, reason, idempotencyKey) {
  amount(credits); user(state, userId); const book = ledger(state);
  const old = Object.hasOwn(book.deposits, idempotencyKey) ? book.deposits[idempotencyKey] : null;
  if (old) {
    if (old.userId !== userId || old.credits !== credits || old.reason !== reason) throw new AppError(409, "Deposit key conflict.");
    return old;
  }
  transfer(book, "system:external", userId, credits, reason, idempotencyKey);
  repayRefundDebt(book, userId, idempotencyKey);
  const receipt = { userId, credits, reason, idempotencyKey };
  book.deposits[idempotencyKey] = receipt;
  return receipt;
}
export function refundCredits(state, order, refundedCredits) {
  const book = ledger(state), previous = order.refundedCredits || 0;
  if (!Number.isSafeInteger(refundedCredits) || refundedCredits < 0 || refundedCredits > order.credits) throw new AppError(422, "Invalid credit refund.");
  if (refundedCredits <= previous) return;
  const delta = refundedCredits - previous;
  const available = Math.min(delta, book.balances[order.userId] || 0);
  if (available) transfer(book, order.userId, "system:external", available, "Credit purchase refund", order.id);
  if (delta > available) {
    const debt = delta - available;
    transfer(book, "system:refund-debt:" + order.userId, "system:external", debt, "Spent credits refunded", order.id);
    book.debts[order.userId] = (book.debts[order.userId] || 0) + debt;
  }
  order.refundedCredits = refundedCredits;
}

export function createLedger(store, { now = Date.now } = {}) {
  const api = {
    async balance(userId) {
      const state = await store.snapshot(); user(state, userId);
      const book = ledger(state);
      return { userId, credits: book.balances[userId] || 0, adjustmentCredits: book.debts[userId] || 0, asOf: new Date(now()).toISOString() };
    },
    async statement(userId, cursor) {
      const state = await store.snapshot(); user(state, userId);
      if (cursor && !/^[1-9][0-9]{0,15}$/.test(cursor)) throw new AppError(422, "Invalid statement cursor.");
      const entries = ledger(state).entries.filter((entry) => entry.account === userId && (!cursor || entry.id < Number(cursor))).reverse().slice(0, 51);
      return { entries: entries.slice(0, 50).map(({ account, ...entry }) => entry), nextCursor: entries.length > 50 ? String(entries[49].id) : null };
    },
    deposit(userId, credits, reason, idempotencyKey) {
      amount(credits);
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{2,199}$/.test(idempotencyKey)) throw new AppError(422, "A valid deposit key is required.");
      return store.transaction((state) => {
        return depositCredits(state, userId, credits, reason, idempotencyKey);
      });
    },
    reserve(userId, service, credits, idempotencyKey) {
      amount(credits);
      return store.transaction((state) => {
        user(state, userId); const book = ledger(state);
        const old = book.reservations.find((entry) => entry.userId === userId && entry.service === service && entry.key === idempotencyKey);
        if (old) {
          if (old.credits !== credits) throw new AppError(409, "Request price conflict.");
          return { id: old.id, status: old.status === "held" ? "pending" : old.status };
        }
        if ((book.balances[userId] || 0) < credits || book.debts[userId] > 0) throw new AppError(409, "Insufficient credits or an outstanding refund adjustment.");
        const id = randomUUID();
        transfer(book, userId, "system:escrow", credits, service + ":hold", id);
        book.reservations.push({ id, userId, service, credits, key: idempotencyKey, status: "held", createdAt: now() });
        return { id, status: "reserved" };
      });
    },
    settle(userId, id, outcome, service) {
      if (!["capture", "release"].includes(outcome)) throw new AppError(422, "Invalid settlement outcome.");
      return store.transaction((state) => {
        const book = ledger(state), reservation = book.reservations.find((entry) => entry.id === id && entry.userId === userId && (!service || entry.service === service));
        if (!reservation) throw new AppError(404, "Reservation not found.");
        const status = outcome === "capture" ? "captured" : "released";
        if (reservation.status === status) return { settled: true };
        if (reservation.status !== "held") throw new AppError(409, "This reservation is already settled.");
        transfer(book, "system:escrow", outcome === "capture" ? "system:platform" : userId, reservation.credits, reservation.service + ":" + outcome, id);
        if (outcome === "release") repayRefundDebt(book, userId, id);
        reservation.status = status;
        return { settled: true };
      });
    },
    async expire() {
      const state = await store.snapshot();
      for (const reservation of ledger(state).reservations.filter((entry) => entry.status === "held" && entry.createdAt < now() - 3600000)) {
        try { await api.settle(reservation.userId, reservation.id, "release"); }
        catch (error) { if (error.status !== 409) throw error; }
      }
    }
  };
  return api;
}
