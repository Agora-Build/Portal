import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { AppError } from "./store.mjs";
import { plans, effectivePlan } from "./plans.mjs";
import { depositCredits, refundCredits } from "./ledger.mjs";

export function billingConfig(env = process.env) {
  const subscriptions = [
    { id: "premium-monthly", plan: "premium", priceId: env.STRIPE_PREMIUM_MONTHLY_PRICE_ID || "" },
    { id: "premium-yearly", plan: "premium", priceId: env.STRIPE_PREMIUM_YEARLY_PRICE_ID || "" }
  ].filter((product) => product.priceId);
  const packs = env.BILLING_CREDIT_PACKS_FILE ? JSON.parse(readFileSync(env.BILLING_CREDIT_PACKS_FILE, "utf8")) : [];
  if (!Array.isArray(packs) || packs.some((pack) => !/^[a-z][a-z0-9-]{1,40}$/.test(pack.id) || typeof pack.name !== "string" || pack.name.length > 80 || !Number.isSafeInteger(pack.credits) || pack.credits < 1 || pack.credits > 1000000000 || !/^price_[A-Za-z0-9]+$/.test(pack.priceId))) throw new Error("Invalid credit pack catalog.");
  const products = [...subscriptions, ...packs.map((pack) => ({ ...pack, type: "credits" }))];
  if (new Set(products.map((product) => product.id)).size !== products.length || new Set(products.map((product) => product.priceId)).size !== products.length) throw new Error("Billing product IDs and Stripe prices must be unique.");
  const periodCredits = Number(env.PREMIUM_PERIOD_CREDITS || 0);
  if (!Number.isSafeInteger(periodCredits) || periodCredits < 0 || periodCredits > 1000000000) throw new Error("Invalid Premium period credits.");
  let origin = "";
  try {
    const url = new URL(env.SITE_URL);
    if (!url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) origin = url.origin;
  } catch { /* Checkout remains unavailable until the public origin is set. */ }
  return { products, secret: env.STRIPE_SECRET_KEY || "", webhookSecret: env.STRIPE_WEBHOOK_SECRET || "", origin, periodCredits, ready: Boolean(origin && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) };
}

export function createBilling(store, config = billingConfig(), { stripe = config.ready ? new Stripe(config.secret, { maxNetworkRetries: 1, timeout: 10000 }) : null, now = Date.now } = {}) {
  let cached;
  const ready = () => { if (!config.ready || !stripe) throw new AppError(503, "Purchases are not connected yet."); };
  async function productFor(id) {
    ready();
    const product = config.products.find((product) => product.id === id);
    if (!product) throw new AppError(422, "This purchase is not in the catalog.");
    const price = await stripe.prices.retrieve(product.priceId);
    if (!price.active || !Number.isSafeInteger(price.unit_amount) || price.unit_amount < 1 || price.billing_scheme !== "per_unit" || (product.plan ? !price.recurring || price.recurring.usage_type !== "licensed" : price.recurring)) throw new AppError(503, "This price is not available for purchase.");
    if (product.plan && ((product.id.endsWith("monthly") && price.recurring.interval !== "month") || (product.id.endsWith("yearly") && price.recurring.interval !== "year"))) throw new AppError(503, "This subscription price has the wrong billing interval.");
    return { ...product, amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval || null, intervalCount: price.recurring?.interval_count || 1 };
  }
  async function customerFor(userId) {
    const state = await store.snapshot(), account = state.accounts.find((account) => account.id === userId);
    if (!account) throw new AppError(401, "Sign in to purchase.");
    if (account.stripeCustomerId) return account.stripeCustomerId;
    const customer = await stripe.customers.create({ name: account.name, metadata: { portal_user_id: userId } }, { idempotencyKey: "portal-customer:" + userId });
    await store.transaction((state) => {
      const account = state.accounts.find((account) => account.id === userId);
      if (account.stripeCustomerId && account.stripeCustomerId !== customer.id) throw new AppError(409, "Billing customer conflict.");
      account.stripeCustomerId = customer.id;
    });
    return customer.id;
  }
  return {
    config,
    async catalog() {
      if (!config.ready) return { ready: false, plans, products: [], periodCredits: config.periodCredits };
      if (cached && cached.until > now()) return cached.value;
      const products = await Promise.all(config.products.map((product) => productFor(product.id)));
      const value = { ready: true, plans, products: products.map(({ priceId, ...product }) => product), periodCredits: config.periodCredits };
      cached = { value, until: now() + 60000 };
      return value;
    },
    async account(userId) {
      const account = (await store.snapshot()).accounts.find((account) => account.id === userId);
      if (!account) throw new AppError(401, "Sign in to see billing.");
      return { plan: effectivePlan(account, now()), subscription: account.subscription ? { status: account.subscription.status, currentPeriodEnd: account.subscription.currentPeriodEnd, cancelAtPeriodEnd: account.subscription.cancelAtPeriodEnd } : null, canManage: Boolean(config.ready && account.stripeCustomerId) };
    },
    async checkout(userId, productId, requestKey) {
      ready();
      if (!/^[A-Za-z0-9_-]{16,120}$/.test(requestKey || "")) throw new AppError(422, "A checkout idempotency key is required.");
      const product = await productFor(productId), customer = await customerFor(userId);
      const order = await store.transaction((state) => {
        state.orders ||= [];
        const account = state.accounts.find((account) => account.id === userId);
        const old = state.orders.find((order) => order.userId === userId && order.requestKey === requestKey);
        if (old) {
          if (old.productId !== productId) throw new AppError(409, "Checkout key conflict.");
          if (old.status !== "pending") throw new AppError(409, "This checkout has already completed or expired.");
          return old;
        }
        if (product.plan && (effectivePlan(account, now()) !== "basic" || ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(account.subscription?.status) || state.orders.some((order) => order.userId === userId && order.plan && order.status === "pending" && order.expiresAt > now()))) throw new AppError(409, "Manage your existing subscription or checkout before starting another.");
        const value = { id: randomUUID(), userId, customer, productId, priceId: product.priceId, plan: product.plan || null, credits: product.credits || 0, requestKey, status: "pending", expiresAt: now() + 31 * 60000 };
        state.orders.push(value); return value;
      });
      if (order.url && order.expiresAt > now()) return { url: order.url };
      try {
        const session = await stripe.checkout.sessions.create({ mode: product.plan ? "subscription" : "payment", customer, line_items: [{ price: order.priceId, quantity: 1 }], client_reference_id: userId, metadata: { portal_order_id: order.id, portal_user_id: userId }, ...(product.plan ? { subscription_data: { metadata: { portal_user_id: userId, portal_order_id: order.id } } } : { payment_intent_data: { metadata: { portal_user_id: userId, portal_order_id: order.id } } }), success_url: config.origin + "/account.html?checkout=success", cancel_url: config.origin + "/account.html?checkout=cancelled", expires_at: Math.floor(order.expiresAt / 1000) }, { idempotencyKey: "portal-checkout:" + order.id });
        await store.transaction((state) => { const saved = state.orders.find((value) => value.id === order.id); saved.stripeId = session.id; saved.url = session.url; });
        return { url: session.url };
      } catch { throw new AppError(503, "Checkout could not be created. Retry with the same request key."); }
    },
    async manage(userId) {
      ready(); const customer = await customerFor(userId);
      const session = await stripe.billingPortal.sessions.create({ customer, return_url: config.origin + "/account.html" });
      return { url: session.url };
    },
    verify(payload, signature) {
      ready();
      try { return stripe.webhooks.constructEvent(payload, signature, config.webhookSecret); }
      catch { throw new AppError(400, "Invalid payment webhook signature."); }
    },
    async apply(event) {
      ready();
      return store.transaction(async (state) => {
        state.billingEvents ||= {};
        if (Object.hasOwn(state.billingEvents, event.id)) return { received: true };
        const object = event.data.object;
        if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
          const order = (state.orders || []).find((order) => order.id === object.metadata?.portal_order_id);
          if (order) {
            const session = await stripe.checkout.sessions.retrieve(object.id, { expand: ["line_items"] });
            const line = session.line_items?.data;
            if (order.stripeId !== session.id || session.customer !== order.customer || session.client_reference_id !== order.userId || session.metadata?.portal_user_id !== order.userId || !line || line.length !== 1 || line[0].price?.id !== order.priceId || line[0].quantity !== 1) throw new AppError(400, "Payment does not match its portal order.");
            if (!order.plan && session.mode === "payment" && session.payment_status === "paid") {
              if (!session.payment_intent) throw new AppError(400, "This credit purchase has no payment reference.");
              const payment = await stripe.paymentIntents.retrieve(typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id, { expand: ["latest_charge"] });
              if (payment.status !== "succeeded" || payment.customer !== order.customer || payment.metadata?.portal_order_id !== order.id) throw new AppError(400, "This credit payment could not be verified.");
              depositCredits(state, order.userId, order.credits, "Purchased credits", "stripe:checkout:" + session.id);
              order.status = "paid";
              order.paymentIntentId = payment.id;
              if (typeof payment.latest_charge === "object") applyRefund(state, order, payment.latest_charge);
            }
            if (order.plan && session.mode === "subscription" && session.subscription) {
              const subscription = await stripe.subscriptions.retrieve(typeof session.subscription === "string" ? session.subscription : session.subscription.id);
              applySubscription(state, subscription, config);
              order.status = "paid";
            }
          }
        } else if (event.type === "charge.refunded") {
          const charge = await stripe.charges.retrieve(object.id);
          const order = (state.orders || []).find((order) => !order.plan && order.status === "paid" && order.paymentIntentId === charge.payment_intent && order.customer === charge.customer);
          if (order) applyRefund(state, order, charge);
        } else if (event.type === "checkout.session.expired") {
          const order = (state.orders || []).find((order) => order.stripeId === object.id);
          if (order && order.status === "pending") order.status = "expired";
        } else if (event.type.startsWith("customer.subscription.")) {
          // Read the current Stripe object while holding the storage lock; late events cannot restore old rights.
          applySubscription(state, await stripe.subscriptions.retrieve(object.id), config);
        } else if (event.type === "invoice.paid") {
          const subscriptionId = object.parent?.subscription_details?.subscription || object.subscription;
          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(typeof subscriptionId === "string" ? subscriptionId : subscriptionId.id);
            const account = applySubscription(state, subscription, config);
            const invoice = await stripe.invoices.retrieve(object.id);
            if (account && invoice.status === "paid" && invoice.amount_paid > 0 && config.periodCredits && ["subscription_create", "subscription_cycle"].includes(invoice.billing_reason) && invoice.customer === account.stripeCustomerId) depositCredits(state, account.id, config.periodCredits, "Premium period credits", "stripe:invoice:" + invoice.id);
          }
        }
        state.billingEvents[event.id] = event.type;
        return { received: true };
      });
    }
  };
}

function applyRefund(state, order, charge) {
  if (charge.customer !== order.customer || charge.payment_intent !== order.paymentIntentId || !Number.isSafeInteger(charge.amount) || charge.amount < 1 || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 || charge.amount_refunded > charge.amount) throw new AppError(400, "Invalid payment refund.");
  const credits = Number(BigInt(order.credits) * BigInt(charge.amount_refunded) / BigInt(charge.amount));
  refundCredits(state, order, credits);
}

function applySubscription(state, subscription, config) {
  const account = state.accounts.find((account) => account.stripeCustomerId === subscription.customer && account.id === subscription.metadata?.portal_user_id);
  if (!account) return null;
  const items = subscription.items?.data || [];
  if (items.length !== 1 || !config.products.some((product) => product.plan === "premium" && product.priceId === items[0].price?.id) || items[0].quantity !== 1) {
    if (account.subscription?.id === subscription.id) { account.subscription.status = "unrecognized"; account.subscription.currentPeriodEnd = 0; }
    return null;
  }
  const order = (state.orders || []).find((order) => order.id === subscription.metadata?.portal_order_id && order.userId === account.id && order.plan === "premium");
  if (!order) return null;
  if (account.subscription && account.subscription.id !== subscription.id && account.subscription.status !== "canceled") throw new AppError(409, "Conflicting subscriptions.");
  account.subscription = { id: subscription.id, status: subscription.status, currentPeriodEnd: items[0].current_period_end || subscription.current_period_end || 0, cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end) };
  return account;
}
