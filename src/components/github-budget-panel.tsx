import type { JSX } from "react";
import type { GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";

export type GitHubBudgetPanelProps = { assessment: GitHubGraphqlBudgetAssessment };

export function GitHubBudgetPanel({ assessment }: GitHubBudgetPanelProps): JSX.Element {
  const { state, reading, reserve } = assessment;

  return (
    <div data-testid="github-budget-panel" data-budget-state={state}>
      {reading === null ? (
        <p>The GitHub GraphQL budget has not been observed yet.</p>
      ) : state === "UNKNOWN" ? (
        <p>The last observation belongs to a previous budget window. The current budget is unknown.</p>
      ) : null}
      <dl>
        {reading !== null ? (
          <>
            <dt>Remaining</dt>
            <dd data-testid="github-budget-remaining">{reading.remaining}</dd>
            {reading.limit !== null ? (
              <>
                <dt>Limit</dt>
                <dd data-testid="github-budget-limit">{reading.limit}</dd>
              </>
            ) : null}
          </>
        ) : null}
        <dt>Reconciliation reserve</dt>
        <dd data-testid="github-budget-reserve">{reserve}</dd>
        {reading !== null ? (
          <>
            <dt>Resets at (UTC)</dt>
            <dd><time dateTime={reading.resetAt.toISOString()}>{reading.resetAt.toISOString()}</time></dd>
            <dt>Observed at (UTC)</dt>
            <dd><time dateTime={reading.observedAt.toISOString()}>{reading.observedAt.toISOString()}</time></dd>
          </>
        ) : null}
      </dl>
      {state === "BELOW_RESERVE" ? (
        <p role="status">Reconciliation is being held because the remaining budget is below the reserve.</p>
      ) : null}
    </div>
  );
}
