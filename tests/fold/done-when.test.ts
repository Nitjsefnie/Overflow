import { describe, expect, it } from "vitest";
import { DONE_WHEN_MAX_BYTES, doneWhenText, sponsorDoneWhen } from "@/lib/fold/done-when";
import type { FoldUser } from "@/lib/fold/repository-fold";
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
  });

  it("keeps untrusted text verbatim; escaping is the renderer's job", () => {
    const body = "Done when <script>alert(1)</script>";

    expect(sponsorDoneWhen({ comments: [comment(1, body, -60)], history: [] }, SPONSOR)?.text).toBe(body);
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
