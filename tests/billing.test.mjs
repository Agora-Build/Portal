import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Stripe from "stripe";
import { createStore } from "../scripts/store.mjs";
import { createLedger } from "../scripts/ledger.mjs";
import { createBilling, billingConfig } from "../scripts/billing.mjs";
import { createAppServer } from "../scripts/serve.mjs";
import { authConfig, createAuth } from "../scripts/auth.mjs";
import { createModelClient, modelConfig } from "../scripts/models.mjs";

const root = new URL("../", import.meta.url).pathname;
let temp, count = 0;
before(async () => { temp = await mkdtemp(resolve(tmpdir(), "agora-billing-")); });
after(async () => { await rm(temp, { recursive: true, force: true }); });
const config = () => ({ ready: true, origin: "https://agora.build", secret: "sk_test_fixture", webhookSecret: "whsec_fixture_only", periodCredits: 25, products: [{ id: "premium-monthly", plan: "premium", priceId: "price_premium" }, { id: "builder-pack", name: "Builder pack", type: "credits", credits: 100, priceId: "price_credits" }] });
async function fixture() {
  const store = createStore(resolve(root, "data/people.json"), resolve(temp, ++count + ".json"));
  const login = await store.login({ provider: "google", issuer: "https://accounts.google.com", subject: "fixture-user", name: "Builder" });
  const sessions = new Map(), subscriptions = new Map(), invoices = new Map(), payments = new Map(), charges = new Map();
  let sequence = 0, customerCalls = 0;
  const real = new Stripe("sk_test_fixture");
  const stripe = {
    prices: { retrieve: async (id) => ({ id, active: true, unit_amount: id === "price_premium" ? 1500 : 500, currency: "usd", billing_scheme: "per_unit", recurring: id === "price_premium" ? { interval: "month", interval_count: 1, usage_type: "licensed" } : null }) },
    customers: { create: async () => { customerCalls++; return { id: "cus_builder" }; } },
    checkout: { sessions: {
      create: async (input) => {
        const id = "cs_" + ++sequence;
        const charge = { id: "ch_" + id, customer: input.customer, payment_intent: "pi_" + id, amount: 500, amount_refunded: 0 };
        charges.set(charge.id, charge);
        payments.set("pi_" + id, { id: "pi_" + id, status: "succeeded", customer: input.customer, metadata: input.metadata, latest_charge: charge });
        sessions.set(id, { ...input, id, payment_intent: "pi_" + id, payment_status: "unpaid", line_items: { data: [{ price: { id: input.line_items[0].price }, quantity: 1 }] }, url: "https://checkout.stripe.com/" + id });
        return sessions.get(id);
      },
      retrieve: async (id) => structuredClone(sessions.get(id))
    } },
    subscriptions: { retrieve: async (id) => structuredClone(subscriptions.get(id)) },
    invoices: { retrieve: async (id) => structuredClone(invoices.get(id)) },
    paymentIntents: { retrieve: async (id) => structuredClone(payments.get(id)) },
    charges: { retrieve: async (id) => structuredClone(charges.get(id)) },
    billingPortal: { sessions: { create: async (input) => ({ url: "https://billing.stripe.com/" + input.customer }) } },
    webhooks: real.webhooks
  };
  const billing = createBilling(store, config(), { stripe });
  return { store, login, billing, stripe, sessions, subscriptions, invoices, payments, charges, customerCalls: () => customerCalls };
}
const event = (id, type, object) => ({ id, type, data: { object } });

test("the catalog uses configured Stripe prices and has Vox's four plans without fabricated purchase availability", async () => {
  assert.equal(billingConfig({}).ready, false);
  const { store, billing } = await fixture();
  const disconnected = await createBilling(store, billingConfig({})).catalog();
  assert.equal(disconnected.ready, false); assert.equal(disconnected.products.length, 0);
  assert.deepEqual(disconnected.plans.map((plan) => plan.id), ["basic", "premium", "principal", "fellow"]);
  const connected = await billing.catalog();
  assert.equal(connected.products[0].amount, 1500); assert.equal(connected.products[0].interval, "month");
  assert.ok(!JSON.stringify(connected).includes("price_premium"));
});

test("credit purchase requires paid, matching checkout and is fulfilled once across repeated and concurrent events", async () => {
  const f = await fixture(), id = f.login.account.id;
  const checkout = await f.billing.checkout(id, "builder-pack", "purchase-request-001");
  const again = await f.billing.checkout(id, "builder-pack", "purchase-request-001");
  assert.equal(again.url, checkout.url); assert.equal(f.sessions.size, 1); assert.equal(f.customerCalls(), 1);
  const session = [...f.sessions.values()][0];
  assert.equal((await createLedger(f.store).balance(id)).credits, 0);
  await f.billing.apply(event("evt_unpaid", "checkout.session.completed", session));
  assert.equal((await createLedger(f.store).balance(id)).credits, 0);
  session.payment_status = "paid";
  const paid = event("evt_paid", "checkout.session.async_payment_succeeded", session);
  await Promise.all([f.billing.apply(paid), f.billing.apply(paid)]);
  await f.billing.apply(event("evt_paid_again", "checkout.session.completed", session));
  assert.equal((await createLedger(f.store).balance(id)).credits, 100);
  assert.equal((await createLedger(f.store).statement(id)).entries.length, 1);
  await assert.rejects(f.billing.checkout(id, "premium-monthly", "purchase-request-001"), { status: 409 });
});

test("subscription checkout activates only through verified Stripe state and recurring allowances require paid invoices", async () => {
  const f = await fixture(), id = f.login.account.id;
  await f.billing.checkout(id, "premium-monthly", "subscription-request-001");
  const session = [...f.sessions.values()][0];
  assert.equal((await f.billing.account(id)).plan, "basic");
  await assert.rejects(f.billing.checkout(id, "premium-monthly", "subscription-request-002"), { status: 409 });
  const subscription = { id: "sub_builder", customer: session.customer, metadata: session.subscription_data.metadata, status: "active", cancel_at_period_end: false, items: { data: [{ price: { id: "price_premium" }, quantity: 1, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] } };
  f.subscriptions.set(subscription.id, subscription);
  session.subscription = subscription.id; session.payment_status = "paid";
  await f.billing.apply(event("evt_subscription_paid", "checkout.session.completed", session));
  assert.equal((await f.billing.account(id)).plan, "premium");
  assert.equal((await f.store.session(f.login.token)).account.entitlements.projects, 20);
  assert.equal((await createLedger(f.store).balance(id)).credits, 0);
  const invoice = { id: "in_paid", customer: "cus_builder", status: "paid", amount_paid: 1500, billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: subscription.id } } };
  f.invoices.set(invoice.id, invoice);
  const paid = event("evt_invoice", "invoice.paid", invoice);
  await Promise.all([f.billing.apply(paid), f.billing.apply(paid)]);
  await f.billing.apply(event("evt_invoice_duplicate", "invoice.paid", invoice));
  assert.equal((await createLedger(f.store).balance(id)).credits, 25);
  assert.match((await f.billing.manage(id)).url, /billing\.stripe\.com/);
  subscription.cancel_at_period_end = true;
  await f.billing.apply(event("evt_cancel_at_period", "customer.subscription.updated", subscription));
  assert.equal((await f.billing.account(id)).plan, "premium");
  subscription.status = "canceled";
  await f.billing.apply(event("evt_deleted", "customer.subscription.deleted", subscription));
  assert.equal((await f.billing.account(id)).plan, "basic");
  await f.billing.apply(event("evt_late_active_event", "customer.subscription.updated", { ...subscription, status: "active" }));
  assert.equal((await f.billing.account(id)).plan, "basic");
});

test("a paid checkout with another customer, price or user is refused without credit or membership changes", async () => {
  const f = await fixture(), id = f.login.account.id;
  await f.billing.checkout(id, "builder-pack", "tampering-request-001");
  const session = [...f.sessions.values()][0]; session.payment_status = "paid";
  const original = structuredClone(session);
  for (const mutate of [(value) => { value.customer = "cus_other"; }, (value) => { value.client_reference_id = "account:another"; }, (value) => { value.line_items.data[0].price.id = "price_other"; }, (value) => { value.line_items.data[0].quantity = 2; }]) {
    Object.assign(session, structuredClone(original)); mutate(session);
    await assert.rejects(f.billing.apply(event("evt_tampered", "checkout.session.completed", session)), { status: 400 });
    assert.equal((await createLedger(f.store).balance(id)).credits, 0);
  }
  await assert.rejects(f.billing.checkout(id, "principal", "principal-request-001"), { status: 422 });
});

test("HTTP payment webhooks verify the raw body signature and browser return URLs cannot grant credits", async () => {
  const f = await fixture(), id = f.login.account.id;
  await f.billing.checkout(id, "builder-pack", "signed-request-001");
  const session = [...f.sessions.values()][0]; session.payment_status = "paid";
  const payload = JSON.stringify(event("evt_signed", "checkout.session.completed", session));
  const signature = f.stripe.webhooks.generateTestHeaderString({ payload, secret: config().webhookSecret });
  const server = createAppServer(root, { store: f.store, billing: f.billing, auth: createAuth(authConfig({})), models: createModelClient(modelConfig({})), monitor: false });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const forged = await fetch(base + "/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "invalid" }, body: payload });
    assert.equal(forged.status, 400);
    await fetch(base + "/account.html?checkout=success", { headers: { Cookie: "house_session=" + f.login.token } });
    assert.equal((await createLedger(f.store).balance(id)).credits, 0);
    const verified = await fetch(base + "/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signature }, body: payload });
    assert.equal(verified.status, 200);
    assert.equal((await createLedger(f.store).balance(id)).credits, 100);
    const anonymousCheckout = await fetch(base + "/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(anonymousCheckout.status, 401);
  } finally { await new Promise((done) => { server.close(done); server.closeIdleConnections(); }); }
});

test("partial and full refunds reverse purchased credits once, and spent credits create a recoverable adjustment", async () => {
  const f = await fixture(), id = f.login.account.id, ledger = createLedger(f.store);
  await f.billing.checkout(id, "builder-pack", "refund-request-001");
  const session = [...f.sessions.values()][0]; session.payment_status = "paid";
  await f.billing.apply(event("evt_purchase", "checkout.session.completed", session));
  const hold = await ledger.reserve(id, "test:work", 80, "spent-request");
  await ledger.settle(id, hold.id, "capture");
  const charge = [...f.charges.values()][0]; charge.amount_refunded = 250;
  await f.billing.apply(event("evt_partial_refund", "charge.refunded", charge));
  assert.equal((await ledger.balance(id)).credits, 0);
  assert.equal((await ledger.balance(id)).adjustmentCredits, 30);
  await f.billing.apply(event("evt_repeat_refund", "charge.refunded", charge));
  assert.equal((await ledger.balance(id)).adjustmentCredits, 30);
  charge.amount_refunded = 500;
  await f.billing.apply(event("evt_full_refund", "charge.refunded", charge));
  assert.equal((await ledger.balance(id)).adjustmentCredits, 80);
  await assert.rejects(ledger.reserve(id, "test:work", 1, "denied-request"), { status: 409 });
  await ledger.deposit(id, 100, "New test purchase", "new-purchase");
  assert.equal((await ledger.balance(id)).credits, 20);
  assert.equal((await ledger.balance(id)).adjustmentCredits, 0);
  const book = (await f.store.snapshot()).ledger;
  assert.equal(book.entries.reduce((total, entry) => total + entry.amount, 0), 0);
  assert.equal(Object.values(book.balances).reduce((total, value) => total + value, 0), 0);
});
