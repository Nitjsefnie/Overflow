import type { ContributorMailConfig } from "@/lib/accounts/work-mail-config";
import { PostgresWorkMailStore } from "@/lib/accounts/work-mail-store";
import { buildDigestMessage, createSmtpsTransport, type WorkMailTransport } from "@/lib/accounts/work-mail-transport";
import { mintUnsubscribeToken } from "@/lib/accounts/work-mail-unsubscribe";
import {
  ISSUES_BOARD_MAX_PAGE_SIZE,
  listEligibleIssues,
  type EligibleIssueFilters,
  type EligibleIssueProjection,
} from "@/lib/dashboard/eligible-issues";
import { readTrustedOrigin } from "@/lib/security/request-origin";

export const WORK_MAIL_DIGEST_INTERVAL_MS = 60 * 60 * 1000;

export type DigestStore = Pick<PostgresWorkMailStore, "dbNow" | "listDueSubscriptions" | "hasIssueCreatedAfter" | "claimDigestSlot">;
export type DigestCycleDependencies = {
  store: DigestStore;
  transport: WorkMailTransport;
  from: string;
  dailyLimit: number;
  listIssues?: (accountId: string, filters: EligibleIssueFilters) => Promise<Pick<EligibleIssueProjection, "createdAt">[]>;
  readOrigin?: () => string | null;
  mintToken?: (subscriptionId: string) => string;
};
export type DigestCycleSummary = { due: number; sent: number; failed: number; ceiling: boolean };

/** Issues on the account's open-claim board created in (watermark, t0]; the board query runs unchanged. */
async function countNewIssues(
  listIssues: NonNullable<DigestCycleDependencies["listIssues"]>, accountId: string, watermark: Date, t0: Date,
): Promise<number> {
  let count = 0;
  for (let page = 1; ; page += 1) {
    const rows = await listIssues(accountId, { claimState: "OPEN", pageSize: ISSUES_BOARD_MAX_PAGE_SIZE, page });
    count += rows.filter(({ createdAt }) => {
      const created = Date.parse(createdAt);
      return created > watermark.getTime() && created <= t0.getTime();
    }).length;
    if (rows.length < ISSUES_BOARD_MAX_PAGE_SIZE) return count;
  }
}

/**
 * One pass over the due subscriptions: a row is mailed at most once per slot,
 * claimed before the send and never retried. The (watermark, t0] window keeps
 * one issue from counting toward two digests.
 * shortcut: re-entering issues are not new, and an insert whose transaction began before t0 and committed after the
 * read can be missed; upgrade by recording when an issue entered eligibility.
 */
export async function runWorkMailDigestCycle(dependencies: DigestCycleDependencies): Promise<DigestCycleSummary> {
  const { store, transport } = dependencies;
  const listIssues = dependencies.listIssues ?? listEligibleIssues;
  const summary: DigestCycleSummary = { due: 0, sent: 0, failed: 0, ceiling: false };
  const t0 = await store.dbNow();
  const due = await store.listDueSubscriptions();
  summary.due = due.length;
  if (due.length === 0) return summary;
  const oldest = due.reduce((min, row) => (row.watermark < min ? row.watermark : min), due[0]!.watermark);
  if (!(await store.hasIssueCreatedAfter(oldest))) return summary;

  for (const row of due) {
    const count = await countNewIssues(listIssues, row.userId, row.watermark, t0);
    if (count === 0) continue;
    const claim = await store.claimDigestSlot(row.id, row.lastNotifiedAt, t0, dependencies.dailyLimit);
    if (claim === "ceiling") {
      summary.ceiling = true;
      return summary;
    }
    if (claim === false) continue;
    // Fixed log lines: a send error or reply can carry the address.
    try {
      const message = buildDigestMessage({
        from: dependencies.from, to: claim.address, origin: (dependencies.readOrigin ?? readTrustedOrigin)() ?? "", count,
        unsubscribeToken: (dependencies.mintToken ?? mintUnsubscribeToken)(row.id),
      });
      const result = await transport.send(message);
      if (result.ok) summary.sent += 1;
      else {
        summary.failed += 1;
        console.warn(`Work mail digest was not sent (reply code ${result.code ?? "none"}).`);
      }
    } catch {
      summary.failed += 1;
      console.warn("Work mail digest was not sent.");
    }
  }
  return summary;
}

/** Arms the hourly cycle; a tick while the previous cycle still runs is dropped. */
export function startWorkMailDigest(
  config: Extract<ContributorMailConfig, { enabled: true }>,
  overrides: { createStore?: () => DigestStore; transport?: WorkMailTransport } = {},
): void {
  const transport = overrides.transport ?? createSmtpsTransport(config.smtp);
  const createStore = overrides.createStore ?? (() => new PostgresWorkMailStore());
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const summary = await runWorkMailDigestCycle({ store: createStore(), transport, from: config.from, dailyLimit: config.dailyLimit });
        console.info("Work mail digest", summary);
      } catch {
        console.error("Work mail digest cycle failed.");
      } finally {
        running = false;
      }
    })();
  }, WORK_MAIL_DIGEST_INTERVAL_MS);
  timer.unref?.();
}
