import { describe, expect, it, vi } from "vitest";
import type { TransactionClient } from "@/lib/db/types";
import {
  DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT,
  chunkEvidenceFactWrites,
  diffEvidenceFactKeys,
  mergeEvidenceFacts,
  splitEvidenceFacts,
  synchronizeReconciliationEvidence,
  type MeasuredReconciliationFact,
  type OversizedReconciliationFact,
  type ReconciliationFact,
} from "@/lib/fold/evidence-facts";
import { logField } from "@/lib/webhooks/log-field";
import type {
  NarrowedCachedIssue,
  ReconciliationPullRequestEvidence,
} from "@/lib/fold/reconciliation-evidence";

function issue(overrides: Partial<NarrowedCachedIssue> & { id: number }): NarrowedCachedIssue {
  return {
    number: 1,
    title: "Issue",
    url: "https://github.com/octo/repo/issues/1",
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    closedAt: null,
    authorLogin: null,
    authorGitHubUserId: null,
    labels: [],
    claimAssigneeGitHubLogin: null,
    claimAssigneeGitHubUserId: null,
    history: [],
    comments: [],
    closingPullRequests: [],
    ...overrides,
  } as NarrowedCachedIssue;
}

function pullRequestEvidence(id: number, rawDiff = "diff"): ReconciliationPullRequestEvidence {
  return { id, reviews: [], rawDiff };
}

describe("splitEvidenceFacts", () => {
  it("keys each issue and pull request by its numeric GitHub id", () => {
    const { facts, oversized } = splitEvidenceFacts({
      issues: [issue({ id: 101 }), issue({ id: 102 })],
      pullRequests: [pullRequestEvidence(201), pullRequestEvidence(202)],
    });
    expect(oversized).toEqual([]);
    expect(facts).toEqual([
      { kind: "issue", subjectKey: "101", payload: issue({ id: 101 }), bytes: expect.any(Number) },
      { kind: "issue", subjectKey: "102", payload: issue({ id: 102 }), bytes: expect.any(Number) },
      { kind: "pull_request", subjectKey: "201", payload: pullRequestEvidence(201), bytes: expect.any(Number) },
      { kind: "pull_request", subjectKey: "202", payload: pullRequestEvidence(202), bytes: expect.any(Number) },
    ]);
  });

  it("keeps an empty document empty", () => {
    expect(splitEvidenceFacts({ issues: [], pullRequests: [] })).toEqual({ facts: [], oversized: [] });
  });

  it("omits a fact whose serialized payload exceeds the injected byte limit and keeps the rest", () => {
    const small = issue({ id: 1 });
    const large = issue({ id: 2, title: "x".repeat(1000) });
    const { facts, oversized } = splitEvidenceFacts(
      { issues: [small, large], pullRequests: [pullRequestEvidence(3)] },
      { factByteLimit: 500 },
    );
    expect(facts).toEqual([
      { kind: "issue", subjectKey: "1", payload: small, bytes: expect.any(Number) },
      { kind: "pull_request", subjectKey: "3", payload: pullRequestEvidence(3), bytes: expect.any(Number) },
    ]);
    expect(oversized).toEqual([
      { kind: "issue", subjectKey: "2", bytes: expect.any(Number) },
    ]);
    expect(oversized[0]!.bytes).toBeGreaterThan(500);
  });

  it("keeps a fact measuring exactly at the limit and omits one byte over", () => {
    const atLimit = issue({ id: 1, title: "y".repeat(1000) });
    const limit = Buffer.byteLength(JSON.stringify(atLimit), "utf8");
    const kept = splitEvidenceFacts({ issues: [atLimit], pullRequests: [] }, { factByteLimit: limit });
    expect(kept.oversized).toEqual([]);
    expect(kept.facts).toHaveLength(1);

    const overLimit = issue({ id: 1, title: `y${"z".repeat(1000)}` });
    const refused = splitEvidenceFacts({ issues: [overLimit], pullRequests: [] }, { factByteLimit: limit });
    expect(refused.facts).toEqual([]);
    expect(refused.oversized).toEqual([{ kind: "issue", subjectKey: "1", bytes: expect.any(Number) }]);
  });

  it("reports a 64 MiB default and honours an injected one", () => {
    expect(DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT).toBe(64 * 1024 * 1024);
    const injected = splitEvidenceFacts(
      { issues: [issue({ id: 1, title: "long enough to cross a tiny limit" })], pullRequests: [] },
      { factByteLimit: 16 },
    );
    expect(injected.facts).toEqual([]);
    expect(injected.oversized).toHaveLength(1);
  });

  it("refuses an unusable byte limit instead of silently omitting everything", () => {
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => splitEvidenceFacts({ issues: [issue({ id: 1 })], pullRequests: [], }, { factByteLimit: limit }))
        .toThrow(/byte limit/i);
    }
  });

  it("keeps the last payload for a duplicated key at a stable position", () => {
    const first = issue({ id: 7, title: "first" });
    const second = issue({ id: 7, title: "second" });
    const { facts, oversized } = splitEvidenceFacts({ issues: [first, second], pullRequests: [] });
    expect(facts).toEqual([{ kind: "issue", subjectKey: "7", payload: second, bytes: expect.any(Number) }]);
    expect(oversized).toEqual([]);
  });

  // The last occurrence's fate is the only fate: a key seen both under and
  // over the byte limit must not end up stored AND counted as omitted.
  it("gives a duplicated key seen small-then-oversized exactly one fate: omitted", () => {
    const small = issue({ id: 7, title: "short" });
    const large = issue({ id: 7, title: "x".repeat(1000) });
    const { facts, oversized } = splitEvidenceFacts({ issues: [small, large], pullRequests: [] }, { factByteLimit: 500 });
    expect(facts).toEqual([]);
    expect(oversized).toEqual([{ kind: "issue", subjectKey: "7", bytes: expect.any(Number) }]);
    expect(oversized[0]!.bytes).toBeGreaterThan(500);
  });

  it("gives a duplicated key seen oversized-then-small exactly one fate: kept with the last payload", () => {
    const small = issue({ id: 7, title: "short" });
    const large = issue({ id: 7, title: "x".repeat(1000) });
    const { facts, oversized } = splitEvidenceFacts({ issues: [large, small], pullRequests: [] }, { factByteLimit: 500 });
    expect(oversized).toEqual([]);
    expect(facts).toEqual([{ kind: "issue", subjectKey: "7", payload: small, bytes: expect.any(Number) }]);
  });
});

describe("mergeEvidenceFacts", () => {
  it("rebuilds the document shape from stored rows", () => {
    const merged = mergeEvidenceFacts([
      { kind: "pull_request", subject_key: "201", payload: pullRequestEvidence(201) },
      { kind: "issue", subject_key: "102", payload: issue({ id: 102 }) },
      { kind: "issue", subject_key: "101", payload: issue({ id: 101 }) },
    ]);
    expect(merged).toEqual({
      issues: [issue({ id: 101 }), issue({ id: 102 })],
      pullRequests: [pullRequestEvidence(201)],
    });
  });

  it("orders facts by numeric subject key ascending, not string order", () => {
    const merged = mergeEvidenceFacts([
      { kind: "issue", subject_key: "10", payload: issue({ id: 10 }) },
      { kind: "issue", subject_key: "2", payload: issue({ id: 2 }) },
      { kind: "issue", subject_key: "1", payload: issue({ id: 1 }) },
    ]);
    expect(merged.issues.map(({ id }) => id)).toEqual([1, 2, 10]);
  });

  it("returns empty arrays for a repository with no facts", () => {
    expect(mergeEvidenceFacts([])).toEqual({ issues: [], pullRequests: [] });
  });

  // Mutant: the dispatch silently dropping an unknown kind — the fact would
  // vanish from the reassembled document, and a document that lies about what
  // is cached is the cache-hole shape the omission flag exists to fence.
  it("refuses an unknown fact kind instead of silently dropping the fact", () => {
    expect(() => mergeEvidenceFacts([
      { kind: "issue", subject_key: "1", payload: issue({ id: 1 }) },
      { kind: "note", subject_key: "5", payload: issue({ id: 5 }) },
    ])).toThrow(/unknown reconciliation fact kind/i);
  });
});

describe("diffEvidenceFactKeys", () => {
  const kept: ReconciliationFact[] = [
    { kind: "issue", subjectKey: "101", payload: issue({ id: 101 }) },
    { kind: "pull_request", subjectKey: "201", payload: pullRequestEvidence(201) },
  ];

  it("names existing keys the new document no longer carries", () => {
    expect(diffEvidenceFactKeys(
      [
        { kind: "issue", subject_key: "101" },
        { kind: "issue", subject_key: "999" },
        { kind: "pull_request", subject_key: "201" },
        { kind: "pull_request", subject_key: "888" },
      ],
      kept,
    )).toEqual([
      { kind: "issue", subjectKey: "999" },
      { kind: "pull_request", subjectKey: "888" },
    ]);
  });

  it("finds nothing to delete when the stored keys match the new document", () => {
    expect(diffEvidenceFactKeys(
      [
        { kind: "issue", subject_key: "101" },
        { kind: "pull_request", subject_key: "201" },
      ],
      kept,
    )).toEqual([]);
  });

  it("names every stored key when the new document keeps nothing", () => {
    expect(diffEvidenceFactKeys([{ kind: "issue", subject_key: "101" }], [])).toEqual([
      { kind: "issue", subjectKey: "101" },
    ]);
  });
});

describe("chunkEvidenceFactWrites", () => {
  function measured(fact: ReconciliationFact): MeasuredReconciliationFact {
    return { ...fact, bytes: Buffer.byteLength(JSON.stringify(fact.payload), "utf8") };
  }

  function factsOf(count: number, diffBytes: number): MeasuredReconciliationFact[] {
    return Array.from({ length: count }, (_, index): MeasuredReconciliationFact =>
      measured({
        kind: "issue",
        subjectKey: String(index + 1),
        payload: issue({ id: index + 1, title: "p".repeat(Math.max(0, diffBytes)) }),
      }));
  }

  function batchBytes(batch: MeasuredReconciliationFact[]): number {
    return batch.reduce((total, fact) => total + Buffer.byteLength(JSON.stringify(fact.payload), "utf8"), 0);
  }

  it("keeps every batch within the byte budget without losing or reordering facts", () => {
    const facts = factsOf(10, 100);
    const singleFactBytes = batchBytes([facts[0]!]);
    // Two facts fit per batch, three do not — the exact boundary is exercised,
    // not assumed from the fixture.
    const budget = singleFactBytes * 2 + 1;
    const batches = chunkEvidenceFactWrites(facts, budget);
    expect(batches.length).toBe(5);
    expect(batches.flat()).toEqual(facts);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batchBytes(batch)).toBeLessThanOrEqual(budget);
    }
  });

  it("gives a fact larger than the whole budget its own batch rather than dropping it", () => {
    const big = measured({ kind: "issue", subjectKey: "2", payload: issue({ id: 2, title: "B".repeat(5000) }) });
    const facts = [
      measured({ kind: "issue", subjectKey: "1", payload: issue({ id: 1 }) }),
      big,
      measured({ kind: "issue", subjectKey: "3", payload: issue({ id: 3 }) }),
    ];
    const batches = chunkEvidenceFactWrites(facts, 100);
    expect(batches.map((batch) => batch.map(({ subjectKey }) => subjectKey))).toEqual([["1"], ["2"], ["3"]]);
    expect(batches.flat()).toEqual(facts);
  });

  it("returns one batch when everything fits", () => {
    const facts = factsOf(3, 10);
    expect(chunkEvidenceFactWrites(facts, 64 * 1024 * 1024)).toEqual([facts]);
    expect(chunkEvidenceFactWrites([], 1024)).toEqual([]);
  });
});

// Type-level guard: the oversized report carries the measured size for the log line.
describe("oversized report", () => {
  it("measures the omitted payload in bytes", () => {
    const payload = issue({ id: 5, title: "measure me" });
    const { oversized } = splitEvidenceFacts({ issues: [payload], pullRequests: [] }, { factByteLimit: 8 });
    const report: OversizedReconciliationFact[] = oversized;
    expect(report).toEqual([{ kind: "issue", subjectKey: "5", bytes: Buffer.byteLength(JSON.stringify(payload), "utf8") }]);
  });
});

// The oversized-fact report is the one log line the evidence write emits, and
// the subject key it names is `String(<instance-supplied numeric id>)` — the
// runtime type of that field is whatever the forge's JSON said, so a hostile
// instance can make it carry line breaks and terminal escapes. This drives the
// real publish path (a stub transaction stands in for the SQL) straight to the
// sink.
describe("synchronizeReconciliationEvidence oversized log", () => {
  it("encodes a hostile subject key in the oversized-fact line", async () => {
    const calls: unknown[][] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { calls.push(args); });
    try {
      const hostileId = "102\nPrivileged action {\n  action: 'moderator-role.grant'\n}\n\u001b[31mred";
      const transaction = vi.fn().mockResolvedValue([]) as unknown as TransactionClient;
      await synchronizeReconciliationEvidence(transaction, "repository-1", {
        expectedVersion: null,
        scanStartedAt: new Date("2030-01-02T03:04:05.678Z"),
        full: true,
        issues: [issue({ id: hostileId as unknown as number, title: "x".repeat(1000) })],
        pullRequests: [],
        dirtySubjects: [],
      }, 600);

      expect(calls).toHaveLength(1);
      const rendered = String(calls[0]![0]);
      expect(rendered).not.toContain("\n");
      expect(rendered).not.toContain("\u001b");
      expect(rendered).toContain(logField(hostileId));
    } finally {
      errorLog.mockRestore();
    }
  });
});
