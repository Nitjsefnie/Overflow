import { describe, expect, it } from "vitest";
import {
  AGENT_PROMPT_PHRASE, agentPromptText, attachSponsorStatements, RECOMMENDED_MODEL_PHRASE, recommendedModelText, sponsorAgentPrompt, sponsorDoneWhen, sponsorRecommendedModel,
} from "@/lib/fold/done-when";
import { foldRepository, type FoldIssue, type FoldResult, type FoldUser, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import type { GitHubIssueComment, GitHubIssueHistoryEvent } from "@/lib/github/types";

const SPONSOR: FoldUser = { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE" };
// The ruled limits, written out so changing a cap constant fails here instead of moving its own test.
const PROMPT_LIMIT_BYTES = 2048;
const MODEL_LIMIT_CHARS = 100;
const T = Date.parse("2026-10-01T12:00:00.000Z");

// Each field is its own sponsor comment; `valid` opens with the field's phrase and carries a value, `invalid` opens with it and does not.
const FIELDS = [
  { name: "agent prompt", extract: sponsorAgentPrompt, valid: (v: string) => `${AGENT_PROMPT_PHRASE} ${v}`, invalid: `${AGENT_PROMPT_PHRASE}:`, other: "Done when x" },
  { name: "recommended model", extract: sponsorRecommendedModel, valid: (v: string) => `${RECOMMENDED_MODEL_PHRASE}: ${v}`, invalid: `${RECOMMENDED_MODEL_PHRASE} bad\u0007`, other: "Agent prompt x" },
] as const;

describe.each(FIELDS)("sponsor $name statement", ({ extract, valid, invalid, other }) => {
  const stored = (v: string) => extract({ comments: [comment(1, valid(v), -60)], history: [] }, SPONSOR);

  it("takes a sponsor comment written before any assignment", () => {
    expect(stored("alpha")).toEqual({ text: expect.stringContaining("alpha"), commentId: "c1" });
  });

  it("takes the earliest valid comment, whatever order they arrive in", () => {
    const comments = [comment(3, valid("late"), -100), comment(1, "Thanks for filing this.", -300), comment(2, valid("early"), -200)];

    expect(extract({ comments, history: [] }, SPONSOR)?.commentId).toBe("c2");
    expect(extract({ comments: [...comments].reverse(), history: [] }, SPONSOR)?.commentId).toBe("c2");
  });

  it("skips an earlier invalid statement for the sponsor's corrected one before assignment", () => {
    const comments = [comment(1, invalid, -200), comment(2, valid("fixed"), -100)];

    expect(extract({ comments, history: [] }, SPONSOR)?.commentId).toBe("c2");
    expect(extract({ comments: comments.slice(0, 1), history: [] }, SPONSOR)).toBeNull();
  });

  it("ignores a comment by anyone but the sponsor, decided by the numeric account id", () => {
    const outsider = { ...comment(1, valid("x"), -60), authorLogin: "outsider", authorGitHubUserId: 3001 };
    const loginOnly = { ...comment(1, valid("x"), -60), authorGitHubUserId: 3001 };
    const noId = { ...comment(1, valid("x"), -60), authorGitHubUserId: null };
    const noIdOther = { ...noId, authorLogin: "outsider" };

    expect(extract({ comments: [outsider], history: [] }, SPONSOR)).toBeNull();
    expect(extract({ comments: [loginOnly], history: [] }, SPONSOR)).toBeNull();
    expect(extract({ comments: [noId], history: [] }, SPONSOR)?.commentId).toBe("c1");
    expect(extract({ comments: [noIdOther], history: [] }, SPONSOR)).toBeNull();
  });

  it("ignores a comment written at or after the first assignment", () => {
    const history = [assigned("a1", 0)];

    expect(extract({ comments: [comment(1, valid("x"), 1)], history }, SPONSOR)).toBeNull();
    expect(extract({ comments: [comment(1, valid("x"), 0)], history }, SPONSOR)).toBeNull();
    expect(extract({ comments: [comment(1, valid("x"), -1)], history }, SPONSOR)?.commentId).toBe("c1");
  });

  it("ignores a comment edited after the first assignment", () => {
    const history = [assigned("a1", 0)];
    const late = { ...comment(1, valid("x"), -60), lastEditedAt: at(1) };
    const early = { ...comment(1, valid("x"), -60), lastEditedAt: at(-1) };

    expect(extract({ comments: [late], history }, SPONSOR)).toBeNull();
    expect(extract({ comments: [early], history }, SPONSOR)?.commentId).toBe("c1");
    expect(extract({ comments: [late, comment(2, valid("y"), -30)], history }, SPONSOR)?.commentId).toBe("c2");
  });

  it("lists none when the earliest instant's ids cannot order its statements", () => {
    const at100 = (n: number, databaseId: number | null) => ({ ...comment(n, valid(`v${n}`), -100), databaseId });

    expect(extract({ comments: [at100(1, null), at100(2, null)], history: [] }, SPONSOR)).toBeNull();
    expect(extract({ comments: [at100(1, 7), at100(2, 7)], history: [] }, SPONSOR)).toBeNull();
    expect(extract({ comments: [at100(1, null), at100(2, 7)], history: [] }, SPONSOR)?.commentId).toBe("c2");
  });

  it("does not read another field's comment", () => {
    expect(extract({ comments: [comment(1, other, -60)], history: [] }, SPONSOR)).toBeNull();
    expect(sponsorDoneWhen({ comments: [comment(1, valid("x"), -60)], history: [] }, SPONSOR)).toBeNull();
  });
});

describe("agentPromptText", () => {
  it("opens with the exact phrase, stores it, and refuses a phrase glued to a word", () => {
    expect(agentPromptText("  Agent prompt: do the thing  ")).toBe("Agent prompt: do the thing");
    expect(agentPromptText("Agent prompt, x")).toBe("Agent prompt, x");
    for (const body of ["Agent prompts x", "Agent prompt_x", "Agent prompt2 x", "Agent prompté x", "agent prompt x", "AGENT PROMPT x", "Note: Agent prompt x"]) {
      expect(agentPromptText(body), body).toBeNull();
    }
  });

  it("refuses a statement with nothing but filler after the phrase", () => {
    for (const body of ["Agent prompt", "Agent prompt:   ", "Agent prompt <!-- only -->", "Agent prompt —", "Agent prompt -: ", ""]) {
      expect(agentPromptText(body), JSON.stringify(body)).toBeNull();
    }
  });

  it("strips HTML comments, an unterminated one to the end", () => {
    expect(agentPromptText("<!-- note -->Agent prompt x")).toBe("Agent prompt x");
    expect(agentPromptText("Agent prompt x <!-- never closed\nmore")).toBe("Agent prompt x");
  });

  // The ellipsis cut falls at byte limit - 3; a pad of 1 to 3 ASCII bytes puts it inside a character, so the walk back must run.
  it.each([["é", "a"], ["😀", "a"], ["😀", "aa"], ["😀", "aaa"]])("caps a body of %s after %j on a character boundary", (unit, pad) => {
    const body = `${AGENT_PROMPT_PHRASE} ${pad}${unit.repeat(Math.ceil(3000 / Buffer.byteLength(unit)))}`;
    const text = agentPromptText(body) ?? "";

    expect(Buffer.from(body)[PROMPT_LIMIT_BYTES - Buffer.byteLength("…")]! & 0xc0).toBe(0x80);
    expect(text.includes("\uFFFD")).toBe(false);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PROMPT_LIMIT_BYTES);
    expect(Buffer.byteLength(text)).toBeGreaterThan(PROMPT_LIMIT_BYTES - 6);
    expect(text.endsWith("…")).toBe(true);
    expect(body.startsWith(text.slice(0, -1))).toBe(true);
  });

  it("stores a body of exactly the byte limit unchanged and cuts one byte more", () => {
    const body = `${AGENT_PROMPT_PHRASE} ${"x".repeat(PROMPT_LIMIT_BYTES - AGENT_PROMPT_PHRASE.length - 1)}`;

    expect(Buffer.byteLength(body)).toBe(PROMPT_LIMIT_BYTES);
    expect(agentPromptText(body)).toBe(body);
    expect(agentPromptText(`${body}x`)).toBe(`${body.slice(0, -3)}…`);
  });
});

describe("recommendedModelText", () => {
  it.each([
    ["claude-opus-5-5", "claude-opus-5-5"], ["GPT-6.1 Sol", "GPT-6.1 Sol"], ["~openai/gpt-sol-latest", "~openai/gpt-sol-latest"],
    ["opus[1m]", "opus[1m]"], ["Some Model (free)", "Some Model (free)"], ["org/model:tag", "org/model:tag"],
  ])("accepts the model name %s", (name, model) => {
    expect(recommendedModelText(`Recommended model: ${name}`)).toBe(model);
    expect(recommendedModelText(`Recommended model ${name}`)).toBe(model);
  });

  it("stores the name without the phrase, after any run of spaces, colons and dashes, across newlines", () => {
    expect(recommendedModelText("Recommended model:\nGLM-5.3-Flash")).toBe("GLM-5.3-Flash");
    expect(recommendedModelText("Recommended model — : \n\n  GLM-5.3-Flash")).toBe("GLM-5.3-Flash");
    expect(recommendedModelText("<!-- n -->  Recommended model: x  <!-- m -->")).toBe("x");
  });

  it("takes the first line only", () => {
    expect(recommendedModelText("Recommended model: Opus 5\nbecause it is fast.\nAnd more")).toBe("Opus 5");
    expect(recommendedModelText("Recommended model: Opus 5\r\nbecause")).toBe("Opus 5");
  });

  it("removes exactly one trailing period", () => {
    expect(recommendedModelText("Recommended model: GLM-5.3-Flash.")).toBe("GLM-5.3-Flash");
    expect(recommendedModelText("Recommended model: GLM-5.3-Flash..")).toBe("GLM-5.3-Flash.");
    expect(recommendedModelText("Recommended model: .")).toBeNull();
    expect(recommendedModelText("Recommended model: a.b")).toBe("a.b");
  });

  it("accepts exactly the character limit and refuses one more, counted in characters", () => {
    const limit = MODEL_LIMIT_CHARS;

    expect(recommendedModelText(`Recommended model: ${"x".repeat(limit)}`)).toBe("x".repeat(limit));
    expect(recommendedModelText(`Recommended model: ${"x".repeat(limit + 1)}`)).toBeNull();
    expect(recommendedModelText(`Recommended model: ${"x".repeat(limit)}.`)).toBe("x".repeat(limit));
    expect(recommendedModelText(`Recommended model: ${"x".repeat(limit + 1)}.`)).toBeNull();
    expect(recommendedModelText(`Recommended model: ${"😀".repeat(limit)}`)).toBe("😀".repeat(limit));
    expect(recommendedModelText(`Recommended model: ${"😀".repeat(limit + 1)}`)).toBeNull();
  });

  it("refuses control and format characters, and never truncates", () => {
    for (const bad of ["\u0007", "\u200B", "\t", "\u202E", "\u0000"]) {
      expect(recommendedModelText(`Recommended model: Opus${bad}5`), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuses a phrase glued to a word, the wrong case, or nothing after the phrase", () => {
    for (const body of ["Recommended models x", "Recommended model_x", "Recommended model2", "Recommended modelling", "recommended model x", "RECOMMENDED MODEL x",
      "Note: Recommended model x", "Recommended model", "Recommended model:", "Recommended model —\n  ", "Recommended model <!-- only -->", ""]) {
      expect(recommendedModelText(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("attachSponsorStatements", () => {
  it("sets all three statements, and only on fold issues read fresh this pass", () => {
    const fold = { issues: [1, 2, 3, 4].map((githubIssueId) => ({ githubIssueId })) } as unknown as FoldResult;
    const statements = [comment(1, "Done when A", -60), comment(2, "Agent prompt B", -50), comment(3, "Recommended model: C", -40)];
    const cached = { id: 3, comments: statements.map((c) => ({ ...c, body: "[body removed]" })), history: [] };

    attachSponsorStatements(fold, [
      { id: 1, body: "Issue body", comments: statements, history: [] },
      { id: 2, body: "", comments: [comment(1, "Thanks for filing this.", -60)], history: [] },
      cached,
    ], SPONSOR);

    expect(fold.issues.map((issue) => [issue.doneWhen, issue.agentPrompt, issue.recommendedModel])).toEqual([
      [{ text: "Done when A", commentId: "c1" }, { text: "Agent prompt B", commentId: "c2" }, { text: "C", commentId: "c3" }],
      [null, null, null],
      [undefined, undefined, undefined],
      [undefined, undefined, undefined],
    ]);
    for (const absent of [fold.issues[2]!, fold.issues[3]!]) {
      expect(["doneWhen", "agentPrompt", "recommendedModel"].filter((key) => key in absent)).toEqual([]);
    }
  });
});

describe("settlement invariance", () => {
  const ADVICE_FIELDS = ["doneWhen", "agentPrompt", "recommendedModel"] as const;
  const withoutAdvice = (fold: FoldResult): FoldResult => ({
    ...fold,
    issues: fold.issues.map((issue) => Object.fromEntries(Object.entries(issue).filter(([key]) => !(ADVICE_FIELDS as readonly string[]).includes(key))) as FoldIssue),
  });
  const foldAndAttach = (snapshot: RepositoryFoldSnapshot): FoldResult => {
    const fold = foldRepository(snapshot);
    attachSponsorStatements(fold, fresh(snapshot), SPONSOR);
    return fold;
  };
  const PROMPT = "Agent prompt: run the whole suite first.";
  const MODEL = "Recommended model: claude-opus-5-5";

  it("keeps every other output when the issue already has a settlement rationale", () => {
    const plain = settledFixture();
    const advised = settledFixture();
    advised.issues[0]!.comments.unshift(
      advice("advice-1", 501, PROMPT, "2026-09-01T10:48:00.000Z"),
      advice("advice-2", 502, MODEL, "2026-09-01T10:49:00.000Z"),
    );
    const base = foldAndAttach(plain);
    const folded = foldAndAttach(advised);

    expect(base.settlements.map(({ status }) => status)).toEqual(["SETTLED"]);
    expect(base.ledgerEntries.length).toBeGreaterThan(0);
    expect(base.issues[0]!.claimAssigneeGitHubLogin).toBe("contributor");
    expect(base.issues[0]!.settledRationaleCommentId).toBe("comment-1");
    expect(base.issues[0]!.agentPrompt).toBeNull();
    expect(folded.issues[0]!.agentPrompt).toEqual({ text: PROMPT, commentId: "advice-1" });
    expect(folded.issues[0]!.recommendedModel).toEqual({ text: "claude-opus-5-5", commentId: "advice-2" });
    expect(withoutAdvice(folded)).toEqual(withoutAdvice(base));
  });

  it("leaves an unsettled issue unsettled when the statements precede its assignment and the rationale window", () => {
    const plain = settledFixture({ rationale: false });
    const advised = settledFixture({ rationale: false });
    advised.issues[0]!.comments.push(
      advice("advice-1", 501, PROMPT, "2026-08-30T10:30:00.000Z"),
      advice("advice-2", 502, MODEL, "2026-08-30T10:31:00.000Z"),
    );
    const base = foldAndAttach(plain);
    const folded = foldAndAttach(advised);

    expect(base.settlements.map(({ status, credits }) => [status, credits])).toEqual([["UNSETTLED", 0]]);
    expect(base.issues[0]!.claimAssigneeGitHubLogin).toBe("contributor");
    expect(base.issues[0]!.settledRationaleCommentId).toBeNull();
    expect(folded.issues[0]!.agentPrompt?.commentId).toBe("advice-1");
    expect(folded.issues[0]!.recommendedModel?.commentId).toBe("advice-2");
    expect(withoutAdvice(folded)).toEqual(withoutAdvice(base));
  });

  it("counts a statement comment inside the rationale window as any other nonblank sponsor comment", () => {
    const withStatement = settledFixture({ rationale: false });
    const withOrdinary = settledFixture({ rationale: false });
    withStatement.issues[0]!.comments.push(advice("c-1", 501, MODEL, "2026-09-01T10:49:00.000Z"));
    withOrdinary.issues[0]!.comments.push(advice("c-1", 501, "Looks good to me.", "2026-09-01T10:49:00.000Z"));
    const statement = foldAndAttach(withStatement);
    const ordinary = foldAndAttach(withOrdinary);

    expect(ordinary.settlements.map(({ status }) => status)).toEqual(["SETTLED"]);
    expect(ordinary.issues[0]!.settledRationaleCommentId).toBe("c-1");
    expect(statement.issues[0]!.recommendedModel?.commentId).toBe("c-1");
    expect(withoutAdvice(statement)).toEqual(withoutAdvice(ordinary));
  });
});

// A body marks an issue as read fresh, which is when the statements are extracted.
const fresh = (snapshot: RepositoryFoldSnapshot) => snapshot.issues.map((issue) => ({ ...issue, body: "" }));

function advice(id: string, databaseId: number, body: string, createdAt: string): GitHubIssueComment {
  return { id, databaseId, authorLogin: "sponsor", authorGitHubUserId: 1001, body, createdAt, lastEditedAt: null };
}

function settledFixture({ rationale = true } = {}): RepositoryFoldSnapshot {
  return {
    repository: {
      id: "repository", githubRepositoryId: 5001, ownerName: "octo/example", active: true, registeredAt: "2026-01-01T00:00:00.000Z",
      sponsor: { ...SPONSOR, moderationEvents: [] },
      difficultyScheme: {
        openingName: "Size", actualName: "Delivered",
        openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
      },
      difficultySchemeVersions: [],
    },
    users: [
      { ...SPONSOR, moderationEvents: [] },
      { id: "contributor", githubUserId: 2001, githubLogin: "contributor", enforcementState: "ACTIVE", moderationEvents: [] },
    ],
    issues: [{
      id: 101, number: 1, title: "Issue", url: "https://github.com/octo/example/issues/1", state: "CLOSED", stateReason: "COMPLETED",
      createdAt: "2026-08-30T09:00:00.000Z", updatedAt: "2026-09-01T12:05:00.000Z", closedAt: "2026-09-01T12:05:00.000Z",
      authorLogin: "sponsor", authorGitHubUserId: null, labels: ["M", "delivered/6"],
      claimAssigneeGitHubLogin: "contributor", claimAssigneeGitHubUserId: 2001,
      history: [
        { kind: "LABELED", id: "opening-1", actorLogin: "sponsor", actorGitHubUserId: null, label: "M", createdAt: "2026-08-30T10:00:00.000Z" },
        { kind: "ASSIGNED", id: "assigned-1", actorLogin: "sponsor", actorGitHubUserId: null, assigneeLogin: "contributor", createdAt: "2026-09-01T10:55:00.000Z" },
        { kind: "LABELED", id: "actual-1", actorLogin: "sponsor", actorGitHubUserId: null, label: "delivered/6", createdAt: "2026-09-01T11:00:00.000Z" },
      ],
      comments: rationale ? [{
        id: "comment-1", databaseId: 401, authorLogin: "sponsor", authorGitHubUserId: null,
        body: "Settled as delivered/6 after reviewing the final diff.", createdAt: "2026-09-01T11:30:00.000Z", lastEditedAt: null,
      }] : [],
      closingPullRequests: [{
        id: 201, number: 11, title: "Pull request", url: "https://github.com/octo/example/pull/11", state: "MERGED",
        mergedAt: "2026-09-01T12:00:00.000Z", mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
        finalCommitAt: "2026-09-01T10:00:00.000Z", authorLogin: "contributor", authorGitHubUserId: 2001,
        repositoryGitHubId: 5001, repositoryNameWithOwner: "octo/example", reviews: [], rawDiff: "diff",
      }],
    }],
  };
}

function at(offsetSeconds: number): string {
  return new Date(T + offsetSeconds * 1000).toISOString();
}

function comment(n: number, body: string, offsetSeconds: number): GitHubIssueComment {
  return { id: `c${n}`, databaseId: 100 + n, authorLogin: "sponsor", authorGitHubUserId: 1001, body, createdAt: at(offsetSeconds), lastEditedAt: null };
}

function assigned(id: string, offsetSeconds: number): GitHubIssueHistoryEvent {
  return { kind: "ASSIGNED", id, actorLogin: "sponsor", actorGitHubUserId: 1001, assigneeLogin: "contributor", createdAt: at(offsetSeconds) };
}
