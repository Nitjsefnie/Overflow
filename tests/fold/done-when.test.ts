import { describe, expect, it } from "vitest";
import { attachDoneWhen, DONE_WHEN_MAX_BYTES, doneWhenText, sponsorDoneWhen } from "@/lib/fold/done-when";
import { scrubFoldResultForPerson } from "@/lib/fold/data-subject-suppression";
import type { ReconciliationSynchronization } from "@/lib/fold/reconciliation-evidence";
import type { FoldResult, FoldUser } from "@/lib/fold/repository-fold";
import type { WalkIssue } from "@/lib/fold/reconciliation-walk";
import type { GitHubIssueComment, GitHubIssueHistoryEvent } from "@/lib/github/types";

const SPONSOR: FoldUser = { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE" };
const T = Date.parse("2026-10-01T12:00:00.000Z");

describe("sponsorDoneWhen", () => {
  it("takes a sponsor comment written before any assignment", () => {
    const issue = { comments: [comment(1, "Done when pnpm test passes.", -60)], history: [] };

    expect(sponsorDoneWhen(issue, SPONSOR)).toEqual({ text: "Done when pnpm test passes.", commentId: "c1" });
  });

  it("ignores a comment by anyone but the sponsor, decided by the numeric account id", () => {
    const outsider = { ...comment(1, "Done when pnpm test passes.", -60), authorLogin: "outsider", authorGitHubUserId: 3001 };
    const loginOnly = { ...comment(1, "Done when pnpm test passes.", -60), authorGitHubUserId: 3001 };

    expect(sponsorDoneWhen({ comments: [outsider], history: [] }, SPONSOR)).toBeNull();
    expect(sponsorDoneWhen({ comments: [loginOnly], history: [] }, SPONSOR)).toBeNull();
  });

  it("falls back to the login when GitHub reported no account id", () => {
    const sponsorLogin = { ...comment(1, "Done when x", -60), authorGitHubUserId: null };
    const otherLogin = { ...sponsorLogin, authorLogin: "outsider" };

    expect(sponsorDoneWhen({ comments: [sponsorLogin], history: [] }, SPONSOR)?.commentId).toBe("c1");
    expect(sponsorDoneWhen({ comments: [otherLogin], history: [] }, SPONSOR)).toBeNull();
  });

  it("ignores a comment written at or after the first assignment", () => {
    const history = [assigned("a1", 0)];

    expect(sponsorDoneWhen({ comments: [comment(1, "Done when x", 1)], history }, SPONSOR)).toBeNull();
    expect(sponsorDoneWhen({ comments: [comment(1, "Done when x", 0)], history }, SPONSOR)).toBeNull();
    expect(sponsorDoneWhen({ comments: [comment(1, "Done when x", -1)], history }, SPONSOR)?.commentId).toBe("c1");
  });

  it("bounds by the earliest assignment, whatever order the history arrives in", () => {
    const comments = [comment(1, "Done when x", 60)];

    expect(sponsorDoneWhen({ comments, history: [assigned("a1", 0), assigned("a2", 120)] }, SPONSOR)).toBeNull();
    expect(sponsorDoneWhen({ comments, history: [assigned("a2", 120), assigned("a1", 0)] }, SPONSOR)).toBeNull();
  });

  it("is bounded only by valid assignment events", () => {
    const comments = [comment(1, "Done when x", 60)];
    const unreadable = { ...assigned("a1", 0), createdAt: "not a time" };

    expect(sponsorDoneWhen({ comments, history: [labeled("l1", 0), assigned("u1", 0, "UNASSIGNED")] }, SPONSOR)?.commentId).toBe("c1");
    expect(sponsorDoneWhen({ comments, history: [unreadable, assigned("a2", 120)] }, SPONSOR)?.commentId).toBe("c1");
  });

  it("ignores a comment edited after the first assignment", () => {
    const history = [assigned("a1", 0)];
    const editedLate = { ...comment(1, "Done when x", -60), lastEditedAt: at(1) };
    const editedEarly = { ...comment(1, "Done when x", -60), lastEditedAt: at(-1) };
    const editedUnassigned = { ...comment(1, "Done when x", -60), lastEditedAt: at(365 * 86_400) };

    expect(sponsorDoneWhen({ comments: [editedLate], history }, SPONSOR)).toBeNull();
    expect(sponsorDoneWhen({ comments: [editedEarly], history }, SPONSOR)?.commentId).toBe("c1");
    expect(sponsorDoneWhen({ comments: [editedUnassigned], history: [] }, SPONSOR)?.commentId).toBe("c1");
  });

  it("takes the earliest qualifying comment", () => {
    const comments = [comment(3, "Done when B", -100), comment(1, "Thanks for filing this.", -300), comment(2, "Done when A", -200)];

    expect(sponsorDoneWhen({ comments, history: [] }, SPONSOR)).toEqual({ text: "Done when A", commentId: "c2" });
  });

  it("passes over an earlier statement disqualified by a late edit", () => {
    const comments = [{ ...comment(1, "Done when A", -200), lastEditedAt: at(10) }, comment(2, "Done when B", -100)];

    expect(sponsorDoneWhen({ comments, history: [assigned("a1", 0)] }, SPONSOR)?.commentId).toBe("c2");
  });

  it("passes over a comment GitHub reported without an id", () => {
    const comments = [{ ...comment(1, "Done when A", -200), id: "" }, comment(2, "Done when B", -100)];

    expect(sponsorDoneWhen({ comments, history: [] }, SPONSOR)?.commentId).toBe("c2");
  });

  it("breaks a same-instant tie by the smaller databaseId", () => {
    const comments = [{ ...comment(1, "Done when A", -100), databaseId: 20 }, { ...comment(2, "Done when B", -100), databaseId: 10 }];

    expect(sponsorDoneWhen({ comments, history: [] }, SPONSOR)?.commentId).toBe("c2");
    expect(sponsorDoneWhen({ comments: [...comments].reverse(), history: [] }, SPONSOR)?.commentId).toBe("c2");
  });

  it("lists none when the earliest instant's ids cannot order its statements", () => {
    const at100 = (n: number, databaseId: number | null) => ({ ...comment(n, `Done when ${n}`, -100), databaseId });
    const undecidable = [[at100(1, null), at100(2, null)], [at100(1, 7), at100(2, 7)]];
    const decidable = [at100(1, null), at100(2, 7), comment(3, "Done when later", -50)];
    const earlier = [comment(1, "Done when early", -200), at100(2, null), at100(3, null)];

    for (const comments of undecidable) {
      expect(sponsorDoneWhen({ comments, history: [] }, SPONSOR)).toBeNull();
      expect(sponsorDoneWhen({ comments: [...comments].reverse(), history: [] }, SPONSOR)).toBeNull();
    }
    expect(sponsorDoneWhen({ comments: decidable, history: [] }, SPONSOR)?.commentId).toBe("c2");
    expect(sponsorDoneWhen({ comments: [...decidable].reverse(), history: [] }, SPONSOR)?.commentId).toBe("c2");
    expect(sponsorDoneWhen({ comments: earlier, history: [] }, SPONSOR)?.commentId).toBe("c1");
    expect(sponsorDoneWhen({ comments: [...earlier].reverse(), history: [] }, SPONSOR)?.commentId).toBe("c1");
  });

  it("keeps untrusted text verbatim; escaping is the renderer's job", () => {
    const body = "Done when <script>alert(1)</script>";

    expect(sponsorDoneWhen({ comments: [comment(1, body, -60)], history: [] }, SPONSOR)?.text).toBe(body);
  });
});

describe("attachDoneWhen", () => {
  it("sets the statement only on fold issues read fresh this pass", () => {
    const fold = { issues: [1, 2, 3, 4, 5].map((githubIssueId) => ({ githubIssueId })) } as unknown as FoldResult;
    const statement = [comment(1, "Done when A", -60)];
    const walked: Pick<WalkIssue, "id" | "body" | "comments" | "history"> = { id: 3, body: "", comments: statement, history: [] };
    const cached = { id: 4, comments: [{ ...statement[0]!, body: "[body removed]" }], history: [] };
    const unfolded = { id: 6, body: "", comments: statement, history: [] };

    attachDoneWhen(fold, [
      { id: 1, body: "Issue body", comments: statement, history: [] },
      { id: 2, body: "", comments: [comment(1, "Thanks for filing this.", -60)], history: [] },
      walked, cached, unfolded,
    ], SPONSOR);

    expect(fold.issues.map((issue) => issue.doneWhen)).toEqual([
      { text: "Done when A", commentId: "c1" }, null, { text: "Done when A", commentId: "c1" }, undefined, undefined,
    ]);
    expect("doneWhen" in fold.issues[3]!).toBe(false);
    expect("doneWhen" in fold.issues[4]!).toBe(false);
    expect(fold.issues).toHaveLength(5);
  });
});

describe("scrubFoldResultForPerson", () => {
  const scrubbed = (doneWhen: { text: string; commentId: string } | undefined, person: { forgeId: number; logins: string[] }) => {
    const issue = { githubIssueId: 1, ownerGitHubLogin: "reporter", claimAssigneeGitHubLogin: null, ...(doneWhen && { doneWhen }) };
    const fold = { issues: [issue], pullRequests: [], settlements: [], selfWorkCalibrations: [], policyViolations: [] } as unknown as FoldResult;
    const evidence = [{ id: 1, history: [], comments: [
      comment(1, "Done when A", -60), { ...comment(2, "Done when B", -30), authorLogin: "other", authorGitHubUserId: 3001 },
      { ...comment(3, "Done when C", -20), authorGitHubUserId: null }, { ...comment(4, "Done when D", -10), authorLogin: "other", authorGitHubUserId: null },
    ] }];
    scrubFoldResultForPerson(fold, { forgeId: person.forgeId, logins: new Set(person.logins) }, evidence as unknown as ReconciliationSynchronization["issues"]);
    return fold.issues[0]!;
  };

  it("drops the statement when its comment's author is the suppressed person, decided by the numeric id", () => {
    expect(scrubbed({ text: "Done when A", commentId: "c1" }, { forgeId: 4004, logins: ["sponsor"] }).doneWhen)
      .toEqual({ text: "Done when A", commentId: "c1" });
    expect(scrubbed({ text: "Done when A", commentId: "c1" }, { forgeId: 1001, logins: [] }).doneWhen).toBeNull();
    expect(scrubbed({ text: "Done when B", commentId: "c2" }, { forgeId: 1001, logins: ["sponsor"] }).doneWhen)
      .toEqual({ text: "Done when B", commentId: "c2" });
  });

  it("falls back to the comment's login when GitHub reported no account id", () => {
    expect(scrubbed({ text: "Done when C", commentId: "c3" }, { forgeId: 4004, logins: ["sponsor"] }).doneWhen).toBeNull();
    expect(scrubbed({ text: "Done when D", commentId: "c4" }, { forgeId: 4004, logins: ["sponsor"] }).doneWhen)
      .toEqual({ text: "Done when D", commentId: "c4" });
  });

  it("leaves a statement this pass did not read fresh absent", () => {
    expect("doneWhen" in scrubbed(undefined, { forgeId: 1001, logins: ["sponsor"] })).toBe(false);
  });
});

describe("doneWhenText", () => {
  it("strips HTML comments, an unterminated one to the end", () => {
    expect(doneWhenText("<!-- note -->Done when x")).toBe("Done when x");
    expect(doneWhenText("Done when x <!-- mid --> passes")).toBe("Done when x  passes");
    expect(doneWhenText("<!--\nmultiline\n-->\nDone when y")).toBe("Done when y");
    expect(doneWhenText("<!-- a -->Done when x<!-- b -->")).toBe("Done when x");
    expect(doneWhenText("Done when x <!-- never closed\nmore")).toBe("Done when x");
  });

  it("requires the exact phrase at the start, followed by a non-word character", () => {
    expect(doneWhenText("  \n Done when x  ")).toBe("Done when x");
    expect(doneWhenText("Done when: x")).toBe("Done when: x");
    expect(doneWhenText("Done when, x")).toBe("Done when, x");
    for (const body of ["Done whenever x", "Done when_x", "Done when2 x", "Done whené x", "done when x", "DONE WHEN x", "Note: Done when x"]) {
      expect(doneWhenText(body), body).toBeNull();
    }
  });

  it("refuses a statement with nothing after the phrase", () => {
    for (const body of ["Done when", "Done when:   ", "Done when <!-- only -->", "Done when —", "Done when -: ", "", "  \n\t "]) {
      expect(doneWhenText(body), JSON.stringify(body)).toBeNull();
    }
  });

  it.each(["é", "😀"])("caps a body of %s at the byte limit on a character boundary", (unit) => {
    const body = `Done when ${unit.repeat(Math.ceil(3000 / Buffer.byteLength(unit)))}`;
    const text = doneWhenText(body) ?? "";

    expect(text).not.toBe("");
    expect(text.includes("\uFFFD")).toBe(false);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DONE_WHEN_MAX_BYTES);
    expect(Buffer.byteLength(text)).toBeGreaterThan(DONE_WHEN_MAX_BYTES - 6);
    expect(text.endsWith("…")).toBe(true);
    expect(body.startsWith(text.slice(0, -1))).toBe(true);
  });

  it("stores a body of exactly the byte limit unchanged", () => {
    const body = `Done when ${"x".repeat(DONE_WHEN_MAX_BYTES - "Done when ".length)}`;

    expect(Buffer.byteLength(body)).toBe(DONE_WHEN_MAX_BYTES);
    expect(doneWhenText(body)).toBe(body);
  });
});

function at(offsetSeconds: number): string {
  return new Date(T + offsetSeconds * 1000).toISOString();
}

function comment(n: number, body: string, offsetSeconds: number): GitHubIssueComment {
  return {
    id: `c${n}`,
    databaseId: 100 + n,
    authorLogin: "sponsor",
    authorGitHubUserId: 1001,
    body,
    createdAt: at(offsetSeconds),
    lastEditedAt: null,
  };
}

function assigned(id: string, offsetSeconds: number, kind: "ASSIGNED" | "UNASSIGNED" = "ASSIGNED"): GitHubIssueHistoryEvent {
  return { kind, id, actorLogin: "sponsor", actorGitHubUserId: 1001, assigneeLogin: "contributor", createdAt: at(offsetSeconds) };
}

function labeled(id: string, offsetSeconds: number): GitHubIssueHistoryEvent {
  return { kind: "LABELED", id, actorLogin: "sponsor", actorGitHubUserId: 1001, label: "offered: 3", createdAt: at(offsetSeconds) };
}
