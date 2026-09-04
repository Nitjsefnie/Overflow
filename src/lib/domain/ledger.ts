import type { SettlementDecision } from "@/lib/domain/settlement";

export type LedgerEntry = {
  accountId: string;
  counterpartyId: string;
  amount: number;
};

export function foldLedger(settlements: readonly SettlementDecision[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];

  for (const settlement of settlements) {
    if (
      settlement.status !== "SETTLED" ||
      !Number.isInteger(settlement.credits) ||
      settlement.credits <= 0
    ) {
      continue;
    }

    entries.push(
      {
        accountId: settlement.creditorId,
        counterpartyId: settlement.debtorId,
        amount: settlement.credits,
      },
      {
        accountId: settlement.debtorId,
        counterpartyId: settlement.creditorId,
        amount: -settlement.credits,
      },
    );
  }

  return entries;
}

export function foldBalances(entries: readonly LedgerEntry[]): Map<string, number> {
  const balances = new Map<string, number>();

  for (const entry of entries) {
    balances.set(entry.accountId, (balances.get(entry.accountId) ?? 0) + entry.amount);
  }

  return balances;
}
