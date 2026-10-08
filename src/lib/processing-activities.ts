export type ProcessingBasis = "contract" | "legitimate interests";

export interface ProcessingActivity {
  readonly identifier: string;
  readonly name: string;
  readonly basis: ProcessingBasis;
  readonly noticeLabel: string;
}

export const PROCESSING_ACTIVITIES = [
  {
    identifier: "signed_in_service",
    name: "Running the service for signed-in members",
    basis: "contract",
    noticeLabel:
      "running the service for signed-in members — accounts, the shared ledger, claims, and dashboards — under performance of a contract: your use of the service",
  },
  {
    identifier: "non_member_forge_data",
    name: "Reading public forge data about people who have never signed in",
    basis: "legitimate interests",
    noticeLabel:
      "reading public forge data about people who have never signed in — reconciliation, the ledger, and settlement proofs — under legitimate interests: operating a public work-attribution tracker, weighed against their rights and freedoms",
  },
  {
    identifier: "logs_backups_security",
    name: "Server logs, database backups, abuse and security handling",
    basis: "legitimate interests",
    noticeLabel:
      "server logs, database backups, and abuse and security handling, including Cloudflare's — under legitimate interests: securing and operating the service",
  },
  {
    identifier: "automated_scoring_moderation",
    name: "Automated scoring and moderation",
    basis: "legitimate interests",
    noticeLabel:
      "automated scoring and moderation, described under Scoring and sanctions below — under legitimate interests: keeping the ledger's records accurate and its rules enforceable",
  },
] as const satisfies readonly ProcessingActivity[];

export type ProcessingActivityIdentifier = (typeof PROCESSING_ACTIVITIES)[number]["identifier"];
