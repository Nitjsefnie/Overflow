import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT,
  chunkEvidenceFactWrites,
  diffEvidenceFactKeys,
  mergeEvidenceFacts,
  splitEvidenceFacts,
  type OversizedReconciliationFact,
  type ReconciliationFact,
} from "@/lib/fold/evidence-facts";
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
      { kind: "issue", subjectKey: "101", payload: issue({ id: 101 }) },
      { kind: "issue", subjectKey: "102", payload: issue({ id: 102 }) },
      { kind: "pull_request", subjectKey: "201", payload: pullRequestEvidence(201) },
      { kind: "pull_request", subjectKey: "202", payload: pullRequestEvidence(202) },
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
      { kind: "issue", subjectKey: "1", payload: small },
      { kind: "pull_request", subjectKey: "3", payload: pullRequestEvidence(3) },
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
    expect(facts).toEqual([{ kind: "issue", subjectKey: "7", payload: second }]);
    expect(oversized).toEqual([]);
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
  function factsOf(count: number, diffBytes: number): ReconciliationFact[] {
    return Array.from({ length: count }, (_, index): ReconciliationFact => ({
      kind: "issue",
      subjectKey: String(index + 1),
      payload: issue({ id: index + 1, title: "p".repeat(Math.max(0, diffBytes)) }),
    }));
  }

  function batchBytes(batch: ReconciliationFact[]): number {
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
    const big: ReconciliationFact = { kind: "issue", subjectKey: "2", payload: issue({ id: 2, title: "B".repeat(5000) }) };
    const facts: ReconciliationFact[] = [
      { kind: "issue", subjectKey: "1", payload: issue({ id: 1 }) },
      big,
      { kind: "issue", subjectKey: "3", payload: issue({ id: 3 }) },
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
