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
  /** Keeps `reading` when it is newer than the one held. */
  record(reading: GitHubGraphqlBudgetReading): void;
  read(): GitHubGraphqlBudgetReading | null;
  /** Records the latest verdict and answers whether it differs from the one before. */
  noteState(state: GraphqlBudgetState): boolean;
  readState(): GraphqlBudgetState;
};

export function createGitHubGraphqlBudgetStore(): GitHubGraphqlBudgetStore {
  let reading: GitHubGraphqlBudgetReading | null = null;
  let state: GraphqlBudgetState | null = null;
  return {
    record(next) {
      if (reading === null || next.observedAt.getTime() > reading.observedAt.getTime()) {
        reading = next;
      }
    },
    read: () => reading,
    noteState(next) {
      const changed = next !== state;
      state = next;
      return changed;
    },
    readState: () => state ?? "UNKNOWN",
  };
}

const budgetKey = Symbol.for("overflow.github.graphql-budget");

export function gitHubGraphqlBudget(): GitHubGraphqlBudgetStore {
  // Next.js bundles instrumentation separately from the page tree; both must
  // reach the same store, rather than separate module-level singletons.
  const shared = globalThis as typeof globalThis & { [budgetKey]?: GitHubGraphqlBudgetStore };
  return shared[budgetKey] ??= createGitHubGraphqlBudgetStore();
}

export function readGraphqlBudgetPayload(
  payload: unknown,
  observedAt: Date,
): GitHubGraphqlBudgetReading | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const { remaining, limit, cost, resetAt } = payload as Record<string, unknown>;
  if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0
    || typeof resetAt !== "string") return null;
  const reset = new Date(resetAt);
  if (!Number.isFinite(reset.getTime())) return null;
  return {
    remaining,
    limit: typeof limit === "number" && Number.isFinite(limit) ? limit : null,
    cost: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    resetAt: reset,
    observedAt,
  };
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

export const DEFAULT_GRAPHQL_BUDGET_RESERVE: number = 500;

export function readGraphqlBudgetReserve(env: NodeJS.ProcessEnv): number {
  const value = env.GITHUB_GRAPHQL_BUDGET_RESERVE;
  if (value === undefined || value.trim() === "") return DEFAULT_GRAPHQL_BUDGET_RESERVE;
  const reserve = Number(value);
  return Number.isInteger(reserve) && reserve >= 0 ? reserve : DEFAULT_GRAPHQL_BUDGET_RESERVE;
}
