import type { DashboardProjection } from "@/lib/dashboard/queries";

type BalanceCardProps = {
  dashboard: Pick<
    DashboardProjection,
    "settledBalance" | "earnedTotal" | "givenTotal" | "reservedPoints" | "availableHeadroom" | "creditFloor"
  >;
};

export function BalanceCard({ dashboard }: BalanceCardProps) {
  const balanceClass = dashboard.settledBalance < 0 ? "balance-debit" : "balance-credit";

  return (
    <section className="ledger-card shadow-offset" aria-labelledby="ledger-position-heading">
      <p className="eyebrow">Materialized ledger</p>
      <h2 id="ledger-position-heading">Ledger position</h2>
      <p className={`balance-number ${balanceClass}`}>{formatSigned(dashboard.settledBalance)}</p>
      <p className="balance-caption">settled credits</p>
      <dl className="ledger-totals">
        <div>
          <dt>Earned</dt>
          <dd>Earned {formatNumber(dashboard.earnedTotal)}</dd>
        </div>
        <div>
          <dt>Given</dt>
          <dd>Given {formatNumber(dashboard.givenTotal)}</dd>
        </div>
        <div>
          <dt>Reserved</dt>
          <dd>Reserved {formatNumber(dashboard.reservedPoints)}</dd>
        </div>
        <div>
          <dt>Available headroom</dt>
          <dd>Available headroom {formatUnsignedPositive(dashboard.availableHeadroom)}</dd>
        </div>
      </dl>
      {dashboard.creditFloor !== undefined ? (
        <p className="credit-floor">Optional credit floor {formatUnsignedPositive(dashboard.creditFloor)}</p>
      ) : null}
    </section>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatSigned(value: number): string {
  if (value > 0) {
    return `+${formatNumber(value)}`;
  }
  if (value < 0) {
    return `−${formatNumber(Math.abs(value))}`;
  }
  return formatNumber(0);
}

function formatUnsignedPositive(value: number): string {
  return value < 0 ? `−${formatNumber(Math.abs(value))}` : formatNumber(value);
}
