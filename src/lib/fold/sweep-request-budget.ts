import { AsyncLocalStorage } from "node:async_hooks";
import { readEnv } from "@/lib/env";

const SWEEP_WINDOW_MS = 6 * 60 * 60_000;
export class SweepBudgetSpent extends Error {
  public constructor(public readonly resetAt: Date) {
    super("Reconciliation held for the sweep request budget.");
  }
}

export function readSweepRequestBudget(environment: Partial<Record<string, string>>): number {
  const raw = environment.RECONCILIATION_SWEEP_REQUEST_BUDGET ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : 3000;
}

export function readSweepWindowMs(environment: Partial<Record<string, string>>): number {
  const raw = readEnv("RECONCILIATION_SWEEP_WINDOW_MINUTES", environment) ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) * 60_000 : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : SWEEP_WINDOW_MS;
}

let observerFailureReported = false;
const requests = new AsyncLocalStorage<{
  spend: () => Promise<Date | null>;
  held: SweepBudgetSpent | null;
}>();

export function withSweepRequestBudget<T>(spend: () => Promise<Date | null>, work: () => Promise<T>): Promise<T> {
  return requests.run({ spend, held: null }, work);
}

/** One atomic DB admission per HTTP request. No chunks: maximum overshoot is zero. */
export async function checkSweepRequestBudget(): Promise<void> {
  const scope = requests.getStore();
  if (scope === undefined) return;
  if (scope.held !== null) throw scope.held;
  let resetAt: Date | null;
  try {
    resetAt = await scope.spend();
    observerFailureReported = false;
  } catch {
    if (!observerFailureReported) {
      observerFailureReported = true;
      try { console.error("Sweep request budget observer unavailable; admitting reconciliation reads."); } catch { /* Diagnostics cannot fail reads. */ }
    }
    return;
  }
  // A sibling can latch a hold while this atomic admission is in flight.
  // An admitted request owns its slot and must send it, even then.
  if (resetAt === null) return;
  scope.held ??= new SweepBudgetSpent(resetAt);
  throw scope.held;
}
