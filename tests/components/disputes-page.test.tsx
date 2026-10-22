/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClosedPrDisputesContent } from "@/app/disputes/page";
import { ClosedPrDisputeDecisionControl } from "@/components/closed-pr-dispute-decision";
import { ClosedPrDisputeList } from "@/components/closed-pr-dispute-list";
import type { ClosedPrDisputeRequest } from "@/lib/moderation/closed-pr-dispute-service";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh }) }));
vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: vi.fn() }));
const requestId = "00000000-0000-4000-8000-000000000004";
const open: ClosedPrDisputeRequest = {
  id: requestId, contributorId: requestId, pullRequestId: requestId, issueId: requestId,
  landedPullRequestId: null, landedCommitUrl: "https://example.test/commit/landed",
  requestReason: "My closed change landed elsewhere.", state: "OPEN", decision: null,
  decidedBy: null, decidedBySoleModerator: false, decidedReason: null,
  moderatorFigure: null, awardedPoints: null, createdAt: "2026-10-01T10:00:00.000Z", decidedAt: null,
};
const decided: ClosedPrDisputeRequest = { ...open, id: requestId + "-history", state: "DECIDED", decision: "GRANTED",
  decidedBy: requestId, decidedBySoleModerator: true, decidedReason: "Review evidence supports the claim.",
  decidedAt: "2026-10-02T10:00:00.000Z", moderatorFigure: 5, awardedPoints: 3 };
const decidedByAnotherModerator: ClosedPrDisputeRequest = {
  ...decided, id: requestId + "-other-history", decidedBySoleModerator: false,
  decidedReason: "An independent moderator reviewed the claim.",
};
afterEach(() => { refresh.mockClear(); vi.unstubAllGlobals(); });
function renderPage(requests: ClosedPrDisputeRequest[] | null = []) {
  return render(<ClosedPrDisputesContent memberName="Ada" isModerator={false} requests={requests} />);
}
function enterFiling() {
  fireEvent.change(screen.getByLabelText("Closed pull request ID"), { target: { value: requestId } });
  fireEvent.change(screen.getByLabelText("Why should this closed PR be credited?"), { target: { value: " My change landed. " } });
}
function mockResponse(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function enterDecision() {
  fireEvent.change(screen.getByLabelText("Reason for the dispute decision"), { target: { value: " The evidence supports the claim. " } });
}

describe("closed PR dispute page and filing", () => {
  it("offers accessible filing and history regions", () => {
    renderPage([open, decided]);
    expect(screen.getByRole("region", { name: "Request a closed PR dispute" })).toBeVisible();
    const history = screen.getByRole("list", { name: "Your closed PR disputes" });
    const entries = within(history).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(entries[1]).toHaveTextContent(decided.decidedReason!);
    expect(entries[1]).toHaveTextContent("GRANTED");
    expect(entries[1]).toHaveTextContent("3");
    expect(entries[1]).toHaveTextContent("decided by the sole moderator");
    expect(within(history).queryByRole("button")).toBeNull();
  });
  it("keeps filing available when history fails", () => {
    renderPage(null);
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "Request the dispute" })).toBeEnabled();
  });
  it("refuses a blank filing before sending", () => {
    const fetchMock = mockResponse({});
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Request the dispute" }));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["automatic", "pull request", "commit"])("files with %s landed evidence and refreshes", async (evidence) => {
    const fetchMock = mockResponse({ request: open });
    renderPage(); enterFiling();
    const url = "https://github.com/owner/repo/commit/landed";
    if (evidence === "pull request") fireEvent.change(screen.getByLabelText("Landed pull request URL (optional)"), { target: { value: url } });
    if (evidence === "commit") fireEvent.change(screen.getByLabelText("Landed commit URL (optional)"), { target: { value: url } });
    fireEvent.click(screen.getByRole("button", { name: "Request the dispute" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeVisible());
    const body = { pullRequestId: requestId, reason: "My change landed.",
      ...(evidence === "pull request" ? { landedPullRequestUrl: url } : {}),
      ...(evidence === "commit" ? { landedCommitUrl: url } : {}) };
    expect(fetchMock).toHaveBeenCalledWith("/api/disputes", {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("renders a filing refusal instead of refreshing", async () => {
    mockResponse({ error: { code: "CONFLICT", message: "This PR already has an open dispute." } }, 409);
    renderPage(); enterFiling();
    fireEvent.click(screen.getByRole("button", { name: "Request the dispute" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This PR already has an open dispute."));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("moderation dispute list and decisions", () => {
  it.each(["contributor history", "moderation queue"] as const)("scopes controls and sole-moderator labels to their rows on %s", (surface) => {
    const requests = [open, decided, decidedByAnotherModerator];
    const moderation = surface === "moderation queue";
    if (moderation) render(<ClosedPrDisputeList requests={requests} moderation />);
    else renderPage(requests);
    const list = screen.getByRole("list", { name: moderation ? "Closed PR dispute queue and history" : "Your closed PR disputes" });
    const entries = within(list).getAllByRole("listitem");
    expect(entries).toHaveLength(3);
    const openItem = within(entries[0]!);
    if (moderation) {
      expect(openItem.getByRole("button", { name: "Grant the dispute" })).toBeVisible();
      expect(openItem.getByRole("button", { name: "Deny the dispute" })).toBeVisible();
      expect(openItem.getAllByRole("button")).toHaveLength(2);
    } else {
      expect(openItem.queryAllByRole("button")).toHaveLength(0);
    }
    for (const entry of entries.slice(1)) expect(within(entry).queryAllByRole("button")).toHaveLength(0);
    expect(within(entries[1]!).getByText(/decided by the sole moderator/)).toBeVisible();
    expect(within(entries[2]!).getByText(decidedByAnotherModerator.decidedReason!, { exact: false })).toBeVisible();
    expect(within(entries[2]!).queryByText(/decided by the sole moderator/)).toBeNull();
    expect(within(list).getAllByText((text) => text.includes(open.landedCommitUrl!))).toHaveLength(3);
  });
  it.each([
    { decision: "GRANTED", figure: 1 },
    { decision: "GRANTED", figure: 5 },
    { decision: "GRANTED", figure: 10 },
    { decision: "DENIED", figure: undefined },
  ] as const)("sends $decision with figure $figure and refreshes", async ({ decision, figure }) => {
    const fetchMock = mockResponse({ request: { ...decided, decision } });
    render(<ClosedPrDisputeDecisionControl requestId={requestId} />); enterDecision();
    if (decision === "GRANTED") fireEvent.change(screen.getByLabelText("Figure (1–10)"), { target: { value: String(figure) } });
    fireEvent.click(screen.getByRole("button", { name: decision === "GRANTED" ? "Grant the dispute" : "Deny the dispute" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeVisible());
    expect(fetchMock).toHaveBeenCalledWith("/api/moderation/disputes", {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ requestId, decision, reason: "The evidence supports the claim.", ...(decision === "GRANTED" ? { figure } : {}) }),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it.each(["", "0", "11", "1.5"])("refuses grant figure %j before sending", (figure) => {
    const fetchMock = mockResponse({});
    render(<ClosedPrDisputeDecisionControl requestId={requestId} />); enterDecision();
    fireEvent.change(screen.getByLabelText("Figure (1–10)"), { target: { value: figure } });
    fireEvent.click(screen.getByRole("button", { name: "Grant the dispute" }));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("renders insufficient evidence readably and keeps the decision open", async () => {
    const message = "Stored review evidence is required to grant this dispute.";
    mockResponse({ error: { code: "INSUFFICIENT_EVIDENCE", message } }, 422);
    render(<ClosedPrDisputeDecisionControl requestId={requestId} />); enterDecision();
    fireEvent.change(screen.getByLabelText("Figure (1–10)"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant the dispute" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Deny the dispute" })).toBeEnabled();
  });
  it("handles unreachable decisions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<ClosedPrDisputeDecisionControl requestId={requestId} />); enterDecision();
    fireEvent.click(screen.getByRole("button", { name: "Deny the dispute" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(refresh).not.toHaveBeenCalled();
  });
});

it("shows stored source and landing evidence side by side with forge destinations", () => {
  render(<ClosedPrDisputeList moderation requests={[{ ...open, comparison: {
    closedPullRequest: { number: 12, title: "Original parser", url: "https://github.com/owner/repo/pull/12",
      reviews: [{ id: 101, state: "CHANGES_REQUESTED", submittedAt: "2026-10-01T10:00:00Z", dismissal: null }], rawDiff: "-old parser\n+original parser" },
    landedPullRequest: { number: 19, title: "Landing parser", url: "https://github.com/owner/repo/pull/19",
      reviews: [{ id: 102, state: "APPROVED", submittedAt: "2026-10-02T10:00:00Z", dismissal: null }], rawDiff: "-old parser\n+landed parser" },
    landedCommitUrl: null,
  } }]} />);
  const source = within(screen.getByRole("region", { name: "Closed pull request evidence" }));
  const landing = within(screen.getByRole("region", { name: "Landed change evidence" }));
  expect(source.getByRole("link", { name: "#12 Original parser" })).toHaveAttribute("href", "https://github.com/owner/repo/pull/12");
  expect(source.getByText(/CHANGES_REQUESTED/)).toHaveTextContent("101");
  expect(source.getByText(/original parser/)).toHaveTextContent("-old parser");
  expect(landing.getByRole("link", { name: "#19 Landing parser" })).toHaveAttribute("href", "https://github.com/owner/repo/pull/19");
  expect(landing.getByText(/APPROVED/)).toHaveTextContent("102");
  expect(landing.getByText(/landed parser/)).toHaveTextContent("-old parser");
});
