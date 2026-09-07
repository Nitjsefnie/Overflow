export type GitHubGraphqlBudgetReading = {
  readonly remaining: number;
  readonly limit: number | null;
  readonly cost: number | null;
  readonly resetAt: Date;
  readonly observedAt: Date;
};

export type GraphqlBudgetState = "UNKNOWN" | "AVAILABLE" | "BELOW_RESERVE";

export type GitHubGraphqlBudgetAssessment = {
  readonly state: GraphqlBudgetState;
  readonly reading: GitHubGraphqlBudgetReading | null;
  readonly reserve: number;
};

export type GitHubGraphqlBudgetStore = {
  owners(): string[];
  /** Keeps the lowest remaining balance in the newest reset window. */
  record(owner: string, reading: GitHubGraphqlBudgetReading): void;
  read(owner: string): GitHubGraphqlBudgetReading | null;
  /** Records the latest verdict and answers whether it differs from the one before. */
  noteState(owner: string, state: GraphqlBudgetState): boolean;
  readState(owner: string): GraphqlBudgetState;
};

export function createGitHubGraphqlBudgetStore(): GitHubGraphqlBudgetStore {
  const readings = new Map<string, GitHubGraphqlBudgetReading>();
  const states = new Map<string, GraphqlBudgetState>();
  return {
    owners: () => [...new Set([...readings.keys(), ...states.keys()])],
    record(owner, next) {
      const reading = readings.get(owner);
      // Receipt time cannot order concurrent responses. For this owner a later
      // reset window supersedes an earlier one; within a window only a lower
      // balance wins. Other sponsors' windows and balances never participate.
      if (reading === undefined || next.resetAt.getTime() > reading.resetAt.getTime()
        || (next.resetAt.getTime() === reading.resetAt.getTime() && next.remaining < reading.remaining)) {
        readings.set(owner, next);
      }
    },
    read: (owner) => readings.get(owner) ?? null,
    noteState(owner, next) {
      const changed = next !== states.get(owner);
      states.set(owner, next);
      return changed;
    },
    readState: (owner) => states.get(owner) ?? "UNKNOWN",
  };
}

const budgetKey = Symbol.for("overflow.github.graphql-budget");

export function gitHubGraphqlBudget(): GitHubGraphqlBudgetStore {
  // Next.js bundles instrumentation separately from the page tree; both must
  // reach the same store, rather than separate module-level singletons.
  const shared = globalThis as typeof globalThis & { [budgetKey]?: unknown };
  try {
    const existing = shared[budgetKey] as Partial<GitHubGraphqlBudgetStore> | null | undefined;
    if (existing !== null && (typeof existing === "object" || typeof existing === "function")
      && typeof existing.owners === "function" && typeof existing.record === "function" && typeof existing.read === "function"
      && typeof existing.noteState === "function" && typeof existing.readState === "function") {
      return existing as GitHubGraphqlBudgetStore;
    }
  } catch {
    // An unreadable shape (for example a throwing getter) is not a store.
  }
  const budget = createGitHubGraphqlBudgetStore();
  shared[budgetKey] = budget;
  return budget;
}

export function readGraphqlBudgetPayload(
  payload: unknown,
  observedAt: Date,
): GitHubGraphqlBudgetReading | null {
  try {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const { remaining, limit, cost, resetAt } = payload as Record<string, unknown>;
    if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0
      || typeof resetAt !== "string") return null;
    // Require an ISO instant with seconds and a timezone before using Date's
    // parser, which also accepts unrelated text and timezone-less dates.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(resetAt)) return null;
    const reset = new Date(resetAt);
    if (!Number.isFinite(reset.getTime())) return null;
    return {
      remaining,
      limit: typeof limit === "number" && Number.isFinite(limit) ? limit : null,
      cost: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
      resetAt: reset,
      observedAt,
    };
  } catch {
    // Unknown inputs can include throwing getters and revoked proxies.
    return null;
  }
}

export function assessGraphqlBudget(
  reading: GitHubGraphqlBudgetReading | null,
  options: { reserve: number; now: Date },
): GitHubGraphqlBudgetAssessment {
  let state: GraphqlBudgetState;
  // A hold must not outlive its window: after reset the old figure says nothing
  // about the new budget, so UNKNOWN lets the worker proceed.
  if (reading === null || options.now.getTime() >= reading.resetAt.getTime()) {
    state = "UNKNOWN";
  } else {
    state = reading.remaining < options.reserve ? "BELOW_RESERVE" : "AVAILABLE";
  }
  return { state, reading, reserve: options.reserve };
}

// Roughly 10% of the ordinary 5,000-point budget is a recovery allowance for
// the rest of the product and a human diagnosing trouble. This admission
// threshold is not derived from a measured maximum fold cost.
export const DEFAULT_GRAPHQL_BUDGET_RESERVE: number = 500;

export function readGraphqlBudgetReserve(env: NodeJS.ProcessEnv): number {
  const value = env.GITHUB_GRAPHQL_BUDGET_RESERVE;
  if (value === undefined || value.trim() === "") return DEFAULT_GRAPHQL_BUDGET_RESERVE;
  const reserve = Number(value);
  return Number.isInteger(reserve) && reserve >= 0 ? reserve : DEFAULT_GRAPHQL_BUDGET_RESERVE;
}
