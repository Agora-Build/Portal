export const plans = [
  { id: "basic", name: "Basic", summary: "A place to start building.", purchasable: false, features: ["Community profile and meeting rooms", "Shared identity across connected apps", "Pay for services with credits"] },
  { id: "premium", name: "Premium", summary: "More room for your work.", purchasable: true, features: ["Everything in Basic", "Vox: 20 projects and private resources", "Vox: own storage and 200 API eval flows"] },
  { id: "principal", name: "Principal", summary: "For builders shaping the foundry.", purchasable: false, features: ["Premium entitlements", "Vox: mainline evaluation publishing", "Granted by the community"] },
  { id: "fellow", name: "Fellow", summary: "For sustained technical contribution.", purchasable: false, features: ["Premium entitlements", "Vox: mainline evaluation publishing", "Granted by the community"] }
];

export function effectivePlan(account, now = Date.now()) {
  if (["principal", "fellow"].includes(account?.assignedPlan)) return account.assignedPlan;
  const subscription = account?.subscription;
  return ["active", "trialing"].includes(subscription?.status) && subscription.currentPeriodEnd * 1000 > now ? "premium" : "basic";
}

export function entitlements(plan) {
  const premium = plan !== "basic";
  return { projects: premium ? 20 : 5, evalFlowsPerProject: premium ? 20 : 10, apiEvalFlows: premium ? 200 : 50, privateResources: premium, ownStorage: premium, publishMainline: ["principal", "fellow"].includes(plan) };
}
