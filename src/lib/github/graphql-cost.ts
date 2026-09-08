import { AsyncLocalStorage } from "node:async_hooks";

export type GraphqlFoldCost = {
  observedCost: number | null;
  observedResponses: number;
  unmeasuredResponses: number;
};

const storage = new AsyncLocalStorage<GraphqlFoldCost>();

export function recordGraphqlResponseCost(rateLimit: unknown): void {
  const scope = storage.getStore();
  if (scope === undefined) return;

  let cost: unknown;
  try {
    if (rateLimit !== null && typeof rateLimit === "object" && !Array.isArray(rateLimit)) {
      cost = (rateLimit as { cost?: unknown }).cost;
    }
  } catch {
    // Unreadable costs, including getters and revoked proxies, are unmeasured.
  }
  const observedCost = scope.observedCost ?? 0;
  if (typeof cost !== "number" || !Number.isSafeInteger(cost) || cost < 0
    || cost > Number.MAX_SAFE_INTEGER - observedCost) {
    scope.unmeasuredResponses++;
    return;
  }
  scope.observedCost = observedCost + cost;
  scope.observedResponses++;
}

/** Await all scoped work before returning; nested folds collect independently. */
export function withGraphqlFoldCost<T>(
  work: (readCost: () => GraphqlFoldCost) => Promise<T>,
): Promise<{ value: T; cost: GraphqlFoldCost }> {
  return storage.run({ observedCost: null, observedResponses: 0, unmeasuredResponses: 0 }, async () => {
    const scope = storage.getStore()!;
    const readCost = (): GraphqlFoldCost => ({ ...scope });
    const value = await work(readCost);
    return { value, cost: readCost() };
  });
}
