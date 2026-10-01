import type { JSONValue } from "postgres";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import {
  narrowCachedIssueBodies,
  RECONCILIATION_EVIDENCE_FORMAT,
  type NarrowedCachedIssue,
  type ReconciliationEvidence,
  type ReconciliationPullRequestEvidence,
  type ReconciliationSynchronization,
} from "@/lib/fold/reconciliation-evidence";

/**
 * The largest serialized fact payload the evidence cache stores by default.
 *
 * Far under jsonb's ~256 MiB ceiling, so an evidence document cannot wedge the
 * fold the way the single-document write did (issue 850): a fact over this
 * limit is omitted from the cache instead of written, and the write succeeds.
 * Injectable per store instance so tests can set it low.
 */
export const DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT = 64 * 1024 * 1024;

/** The two evidence kinds, named as the facts table spells them. */
export type ReconciliationFactKind = "issue" | "pull_request";

/** Where one fact lives inside one repository's evidence document. */
export type ReconciliationFactKey = {
  kind: ReconciliationFactKind;
  subjectKey: string;
};

/** One cached evidence fact: a single cached issue, or a single PR's reviews and raw diff. */
export type ReconciliationFact = ReconciliationFactKey & {
  payload: NarrowedCachedIssue | ReconciliationPullRequestEvidence;
};

/** A fact that was omitted from the cache because its payload exceeded the byte limit. */
export type OversizedReconciliationFact = ReconciliationFactKey & {
  bytes: number;
};

/** The split of one evidence document into the facts to write and the facts to omit. */
export type EvidenceFactSplit = {
  /** Facts to store, in stable document order (issues first, then pull requests). */
  facts: ReconciliationFact[];
  /** Facts over the byte limit, each with its measured serialized size. */
  oversized: OversizedReconciliationFact[];
};

/**
 * Serialized UTF-8 byte length of one fact payload — the measure both the byte
 * limit and the write batching are applied over.
 */
function serializedPayloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? "null", "utf8");
}

/**
 * Splits an evidence document into per-fact writes, omitting any fact whose
 * serialized payload exceeds `factByteLimit` (default 64 MiB).
 *
 * Keyed by the GitHub numeric id, so a subject's row is stable across passes
 * and only changed content is rewritten (issue 853). A duplicated key's last
 * occurrence decides its whole fate — kept with the last payload, or omitted
 * with the last measured size — so a key is never both stored and counted as
 * omitted. GitHub ids cannot collide, so this only orders a pathological
 * input deterministically.
 */
export function splitEvidenceFacts(
  document: {
    issues: ReadonlyArray<NarrowedCachedIssue>;
    pullRequests: ReadonlyArray<ReconciliationPullRequestEvidence>;
  },
  options: { factByteLimit?: number } = {},
): EvidenceFactSplit {
  const factByteLimit = options.factByteLimit ?? DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT;
  if (!Number.isFinite(factByteLimit) || factByteLimit <= 0) {
    throw new Error(`Invalid reconciliation fact byte limit ${String(factByteLimit)}.`);
  }

  const facts = new Map<string, ReconciliationFact>();
  const omitted: OversizedReconciliationFact[] = [];
  const consider = (kind: ReconciliationFactKind, subjectKey: string, payload: NarrowedCachedIssue | ReconciliationPullRequestEvidence): void => {
    const key = `${kind}\u0000${subjectKey}`;
    const bytes = serializedPayloadBytes(payload);
    if (bytes > factByteLimit) {
      // The last occurrence's fate is the only fate: unstage any earlier kept
      // occurrence and replace any earlier report, so a key can never end up
      // both stored and counted as omitted.
      facts.delete(key);
      const prior = omitted.findIndex((report) => report.kind === kind && report.subjectKey === subjectKey);
      if (prior >= 0) omitted.splice(prior, 1);
      omitted.push({ kind, subjectKey, bytes });
      return;
    }
    // Symmetrically, a key reported oversized earlier in the document but kept
    // now loses the stale report — the kept occurrence is the last one.
    if (omitted.length > 0) {
      const prior = omitted.findIndex((report) => report.kind === kind && report.subjectKey === subjectKey);
      if (prior >= 0) omitted.splice(prior, 1);
    }
    facts.set(key, { kind, subjectKey, payload });
  };

  for (const issuePayload of document.issues) {
    consider("issue", String(issuePayload.id), issuePayload);
  }
  for (const pullRequestPayload of document.pullRequests) {
    consider("pull_request", String(pullRequestPayload.id), pullRequestPayload);
  }

  return { facts: [...facts.values()], oversized: omitted };
}

/**
 * Rebuilds the evidence document shape the fold reads — the same
 * `{ issues, pullRequests }` the single-row document used to carry — from the
 * stored fact rows, ordered by numeric subject key ascending so reassembly is
 * deterministic regardless of the rows' physical order.
 *
 * Keys that are not numeric (impossible from this module's own writes) sort
 * after every numeric key, by their text.
 */
export function mergeEvidenceFacts(
  facts: ReadonlyArray<{ kind: string; subject_key: string; payload: unknown }>,
): { issues: NarrowedCachedIssue[]; pullRequests: ReconciliationPullRequestEvidence[] } {
  const order = (subjectKey: string): [number, number, string] => {
    const numeric = Number(subjectKey);
    return [Number.isSafeInteger(numeric) ? 0 : 1, Number.isSafeInteger(numeric) ? numeric : 0, subjectKey];
  };
  const issues: NarrowedCachedIssue[] = [];
  const pullRequests: ReconciliationPullRequestEvidence[] = [];
  for (const fact of [...facts].sort((left, right) => {
    const [leftRank, leftNumeric, leftText] = order(left.subject_key);
    const [rightRank, rightNumeric, rightText] = order(right.subject_key);
    return leftRank - rightRank
      || (leftRank === 0 ? leftNumeric - rightNumeric : 0)
      || (leftText < rightText ? -1 : leftText > rightText ? 1 : 0);
  })) {
    if (fact.kind === "issue") issues.push(fact.payload as NarrowedCachedIssue);
    else if (fact.kind === "pull_request") pullRequests.push(fact.payload as ReconciliationPullRequestEvidence);
  }
  return { issues, pullRequests };
}

/**
 * Names the stored fact keys the given document no longer carries — the
 * targeted deletes that keep absent subjects from lingering in the cache. A
 * key kept by the new document, or omitted as oversized, is not returned:
 * only genuinely absent keys are.
 */
export function diffEvidenceFactKeys(
  existing: ReadonlyArray<{ kind: string; subject_key: string }>,
  kept: ReadonlyArray<ReconciliationFact>,
): ReconciliationFactKey[] {
  const keptKeys = new Set(kept.map(({ kind, subjectKey }) => `${kind}\u0000${subjectKey}`));
  return existing
    .filter(({ kind, subject_key }) => !keptKeys.has(`${kind}\u0000${subject_key}`))
    .map(({ kind, subject_key }) => ({ kind: kind as ReconciliationFactKind, subjectKey: subject_key }));
}

/**
 * Groups facts into batches whose serialized parameter stays within
 * `maxBatchBytes`, so one write statement never carries more than the byte
 * budget the fact limit already bounds each payload to. A single fact larger
 * than the whole budget gets its own batch rather than being dropped —
 * dropping here would silently lose cache content the split already admitted.
 */
export function chunkEvidenceFactWrites(
  facts: ReadonlyArray<ReconciliationFact>,
  maxBatchBytes: number,
): ReconciliationFact[][] {
  if (!Number.isFinite(maxBatchBytes) || maxBatchBytes <= 0) {
    throw new Error(`Invalid reconciliation fact batch byte budget ${String(maxBatchBytes)}.`);
  }
  const batches: ReconciliationFact[][] = [];
  let current: ReconciliationFact[] = [];
  let currentBytes = 0;
  for (const fact of facts) {
    const bytes = serializedPayloadBytes(fact.payload);
    if (current.length > 0 && currentBytes + bytes > maxBatchBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(fact);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** One stored fact row, as the facts table spells the columns. */
type FactStorageRow = { kind: ReconciliationFactKind; subject_key: string; payload: JSONValue };

function factStorageRow({ kind, subjectKey, payload }: ReconciliationFact): FactStorageRow {
  return { kind, subject_key: subjectKey, payload: payload as JSONValue };
}

/**
 * Publishes one fold pass's evidence inside the caller's publication
 * transaction — the same fence and atomicity the single-document write had,
 * with the document split into per-fact rows.
 *
 * The `version` fence is unchanged: the metadata row's next version must equal
 * what the caller read, or the pass is stale and nothing is written. The two
 * wholesale-rewritten jsonb arrays are gone from the metadata row; the facts
 * are written around it — inserts and updates carrying a no-op guard, deletes
 * strictly targeted at keys the new document no longer carries — so a pass
 * whose document came back unchanged moves no fact row at all (issue 853),
 * and no fact ever written can approach jsonb's size ceiling (issue 850).
 */
export async function synchronizeReconciliationEvidence(
  transaction: TransactionClient,
  repositoryId: string,
  synchronization: ReconciliationSynchronization,
  factByteLimit: number,
): Promise<void> {
  // Lock a row that exists even before bootstrap so two cold publishers cannot
  // both pass the absence check. The version compare also fences expired workers.
  await transaction`select id from registered_repositories where id = ${repositoryId} for update`;
  const [current] = await transaction<{ version: number; last_full_pass_at: Date }[]>`
    select version, last_full_pass_at from repository_reconciliation_evidence where repository_id = ${repositoryId}
  `;
  if ((current?.version ?? null) !== synchronization.expectedVersion) {
    throw new Error("Stale reconciliation evidence publisher.");
  }

  // Split before any write: a fact over the byte limit is omitted from the
  // cache — never attempted — so one enormous subject lands as an
  // operator-visible, non-retried state instead of a permanently failing
  // write the sweep revives forever (issue 850).
  const { facts, oversized } = splitEvidenceFacts({
    issues: narrowCachedIssueBodies(synchronization.issues),
    pullRequests: synchronization.pullRequests,
  }, { factByteLimit });
  if (oversized.length > 0) {
    console.error(
      `Reconciliation evidence for repository ${repositoryId}: omitted ${oversized.length} oversized fact(s) `
        + `over the ${factByteLimit}-byte limit; the fold continues without them and a later full pass retries `
        + `them (${oversized.map(({ kind, subjectKey }) => `${kind}#${subjectKey}`).join(", ")}).`,
    );
  }

  await transaction`insert into repository_reconciliation_evidence
    (repository_id, version, format_version, checkpoint, last_full_pass_at, omitted_oversized_facts)
    values (${repositoryId}, ${(current?.version ?? 0) + 1}, ${RECONCILIATION_EVIDENCE_FORMAT},
      ${synchronization.scanStartedAt}, ${synchronization.full ? synchronization.scanStartedAt : current?.last_full_pass_at ?? null},
      ${oversized.length})
    on conflict (repository_id) do update set version = excluded.version, format_version = excluded.format_version,
      checkpoint = excluded.checkpoint, last_full_pass_at = excluded.last_full_pass_at,
      omitted_oversized_facts = excluded.omitted_oversized_facts`;

  // Per-fact writes with a no-op guard: a fact whose payload is jsonb-equal to
  // the stored one is not rewritten, so a pass whose document came back
  // unchanged moves no fact row and orphans no TOAST (issue 853).
  for (const batch of chunkEvidenceFactWrites(facts, factByteLimit)) {
    await transaction`
      insert into repository_reconciliation_evidence_facts (repository_id, kind, subject_key, payload)
      select ${repositoryId}, each->>'kind', each->>'subject_key', each->'payload'
      from jsonb_array_elements(${transaction.json(batch.map(factStorageRow) as unknown as JSONValue)}) as each
      on conflict (repository_id, kind, subject_key) do update set payload = excluded.payload
      where repository_reconciliation_evidence_facts.payload is distinct from excluded.payload
    `;
  }

  // Targeted deletes: keys absent from the new document — including a fact
  // this pass omitted as oversized, whose stale stored row must not survive as
  // stale cache. An unchanged document finds no such key and deletes nothing.
  const storedKeys = await transaction<{ kind: string; subject_key: string }[]>`
    select kind, subject_key from repository_reconciliation_evidence_facts where repository_id = ${repositoryId}
  `;
  for (const { kind, subjectKey } of diffEvidenceFactKeys(storedKeys, facts)) {
    await transaction`delete from repository_reconciliation_evidence_facts
      where repository_id = ${repositoryId} and kind = ${kind} and subject_key = ${subjectKey}`;
  }

  // Acknowledge exactly the generations this pass consumed, leaving newer
  // generations (a webhook that re-enqueued mid-pass) in place.
  for (const subject of synchronization.dirtySubjects) {
    await transaction`delete from repository_reconciliation_dirty_subjects
      where repository_id = ${repositoryId} and kind = ${subject.kind}
        and github_subject_id = ${subject.id} and generation = ${subject.generation}`;
  }
}

/**
 * Reassembles a repository's evidence document from the metadata row and its
 * fact rows — the same shape the single-document read returned, so the fold's
 * merge logic is unchanged. Deterministic ordering by numeric subject key.
 *
 * One statement, one snapshot: metadata and facts are fetched by a single
 * join, so a fold pass committing mid-read can never hand the reader a
 * metadata/facts pair from different writes (a BEFORE/AFTER pair of plain
 * selects could). The statement returns ROWS — one per fact plus the metadata
 * row — never a jsonb aggregate: an aggregate of all facts would be one jsonb
 * value under jsonb's 268,435,455-byte total ceiling, reintroducing at read
 * time the exact permanent-failure shape issue 850 removed from the write
 * path (the write deliberately admits documents whose facts total more than
 * that; only the per-fact limit bounds a fact). Each row detoasts its own
 * payload, so the read is bounded by the per-fact limit no matter how many
 * facts a repository carries.
 */
export async function readReconciliationEvidence(
  sql: SqlClient,
  repositoryId: string,
): Promise<ReconciliationEvidence | null> {
  const rows = await sql<{
    version: number; format_version: number; checkpoint: Date; last_full_pass_at: Date;
    omitted_oversized_facts: number;
    kind: ReconciliationFactKind | null; subject_key: string | null; payload: unknown;
  }[]>`
    select e.version, e.format_version, e.checkpoint, e.last_full_pass_at, e.omitted_oversized_facts,
      f.kind, f.subject_key, f.payload
    from repository_reconciliation_evidence e
    left join repository_reconciliation_evidence_facts f on f.repository_id = e.repository_id
    where e.repository_id = ${repositoryId}
  `;
  const [metadata] = rows;
  if (metadata === undefined) {
    return null;
  }
  // A metadata row with no facts surfaces exactly one row whose fact columns
  // are NULL; every real fact row carries both (kind is CHECK-constrained,
  // subject_key is NOT NULL).
  const factRows: Array<{ kind: string; subject_key: string; payload: unknown }> = [];
  for (const row of rows) {
    if (row.kind !== null) {
      factRows.push({ kind: row.kind, subject_key: row.subject_key!, payload: row.payload });
    }
  }
  return {
    version: metadata.version,
    formatVersion: metadata.format_version,
    checkpoint: metadata.checkpoint,
    lastFullPassAt: metadata.last_full_pass_at,
    omittedOversizedFacts: metadata.omitted_oversized_facts,
    ...mergeEvidenceFacts(factRows),
  };
}
