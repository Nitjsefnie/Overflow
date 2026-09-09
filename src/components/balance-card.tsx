import type { DashboardProjection } from "@/lib/dashboard/queries";
import { formatSigned } from "@/lib/format-signed";

type BalanceCardProps = {
  dashboard: Pick<
    DashboardProjection,
    "settledBalance" | "earnedTotal" | "givenTotal" | "reservedPoints" | "availableHeadroom"
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
          <dd>{formatNumber(dashboard.earnedTotal)}</dd>
        </div>
        <div>
          <dt>Given</dt>
          <dd>{formatNumber(dashboard.givenTotal)}</dd>
        </div>
        <div>
          <dt>Reserved</dt>
          <dd>{formatNumber(dashboard.reservedPoints)}</dd>
        </div>
        <div>
          <dt>Available headroom</dt>
          <dd>{formatUnsignedPositive(dashboard.availableHeadroom)}</dd>
        </div>
      </dl>
    </section>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatUnsignedPositive(value: number): string {
  return value < 0 ? `−${formatNumber(Math.abs(value))}` : formatNumber(value);
}
