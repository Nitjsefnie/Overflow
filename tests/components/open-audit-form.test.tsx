/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModerationPage from "@/app/moderation/page";
import { OpenAuditForm } from "@/components/open-audit-form";
import { MINIMUM_CALIBRATION_SAMPLE_SIZE } from "@/lib/calibration/statistics";
import type { AuditCandidateProjection, ModerationRepositoryProjection } from "@/lib/dashboard/queries";

const { redirect, refresh, sql } = vi.hoisted(() => ({ redirect: vi.fn(), refresh: vi.fn(), sql: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh }) }));
vi.mock("@/lib/db/client", () => ({ getSql: () => sql }));
vi.mock("@/lib/dashboard/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/dashboard/session")>(),
  requireMemberPageSession: async () => ({
    user: { id: "moderator-1", role: "MODERATOR", name: "Moderator" },
  }),
}));

const miraId = "00000000-0000-4000-8000-000000000001";
const nilsId = "00000000-0000-4000-8000-000000000002";
const repositoryId = "00000000-0000-4000-8000-000000000003";
const auditId = "00000000-0000-4000-8000-000000000004";

const candidates: AuditCandidateProjection[] = [
  {
    id: miraId,
    githubLogin: "mira",
    enforcementState: "ACTIVE",
    selfWorkPairCount: 12,
    outsiderPairCount: 30,
    openAuditId: null,
  },
  {
    id: nilsId,
    githubLogin: "nils",
    enforcementState: "ACTIVE",
    selfWorkPairCount: 4,
    outsiderPairCount: 6,
    openAuditId: auditId,
  },
];

const repositories: ModerationRepositoryProjection[] = [{ id: repositoryId, ownerName: "overflow/ledger" }];

const startedAt = "2026-01-01T00:00";
const endedAt = "2026-02-01T00:00";

function comparison() {
  return {
    selfWork: { count: 12, meanDelta: 2, medianDelta: 2 },
    outsider: { count: 3, meanDelta: -1, medianDelta: -1 },
    differenceBetweenMeans: 3,
  };
}

function chooseWindow() {
  fireEvent.change(screen.getByLabelText("Sample window start"), { target: { value: startedAt } });
  fireEvent.change(screen.getByLabelText("Sample window end"), { target: { value: endedAt } });
}

function chooseTarget(accountId: string) {
  fireEvent.change(screen.getByLabelText("Audit target"), { target: { value: accountId } });
}

function writeReason(reason: string) {
  fireEvent.change(screen.getByLabelText("Reason for opening the audit"), { target: { value: reason } });
}

afterEach(() => {
  redirect.mockClear();
  refresh.mockClear();
  sql.mockReset();
  vi.unstubAllGlobals();
});

describe("open audit form", () => {
  it("lists every candidate with its cohort counts and marks the accounts already under audit", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    expect(screen.getByRole("option", { name: "mira · 12 self-work · 30 outsider settlements" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "nils · 4 self-work · 6 outsider settlements · audit already open" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "All repositories" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "overflow/ledger" })).toBeInTheDocument();
  });

  it("refuses to open an audit without a target or without both sample window bounds", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    chooseWindow();
    writeReason("The self-work sample is settling far above the outsider sample.");
    fireEvent.click(screen.getByRole("button", { name: "Open audit" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Choose an audit target and both sample window bounds.");
    expect(fetchMock).not.toHaveBeenCalled();

    chooseTarget(miraId);
    fireEvent.change(screen.getByLabelText("Sample window end"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Open audit" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Choose an audit target and both sample window bounds.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a blank reason before any request is sent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    chooseTarget(miraId);
    chooseWindow();
    writeReason("   ");
    fireEvent.click(screen.getByRole("button", { name: "Open audit" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a nonblank reason before opening an audit.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("previews the account-wide cohort and states the sample floor it misses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          preview: {
            targetAccountId: miraId,
            repositoryId: null,
            sampleStartedAt: "2026-01-01T00:00:00.000Z",
            sampleEndedAt: "2026-02-01T00:00:00.000Z",
            comparison: comparison(),
            meetsMinimumSampleSize: false,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    chooseTarget(miraId);
    chooseWindow();
    fireEvent.click(screen.getByRole("button", { name: "Preview cohort" }));

    await waitFor(() => {
      expect(screen.getByText("Self-work sample · 12 pairs · mean delta +2")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/moderation/cohort?targetAccountId=${miraId}&sampleStartedAt=2026-01-01T00%3A00&sampleEndedAt=2026-02-01T00%3A00`,
      { credentials: "same-origin" },
    );
    expect(screen.getByText("Outsider settlement sample · 3 pairs · mean delta −1")).toBeInTheDocument();
    expect(screen.getByText("Difference between means +3")).toBeInTheDocument();
    expect(screen.getByText(`This cohort is below the ${MINIMUM_CALIBRATION_SAMPLE_SIZE}-pair minimum, so opening the audit will be refused.`)).toBeInTheDocument();
  });

  it("scopes the preview to the chosen repository and states a met sample floor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          preview: {
            targetAccountId: miraId,
            repositoryId,
            sampleStartedAt: "2026-01-01T00:00:00.000Z",
            sampleEndedAt: "2026-02-01T00:00:00.000Z",
            comparison: { ...comparison(), outsider: { count: 11, meanDelta: -1, medianDelta: -1 } },
            meetsMinimumSampleSize: true,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    chooseTarget(miraId);
    chooseWindow();
    fireEvent.change(screen.getByLabelText("Repository scope"), { target: { value: repositoryId } });
    fireEvent.click(screen.getByRole("button", { name: "Preview cohort" }));

    await waitFor(() => {
      expect(
        screen.getByText(`Both samples meet the ${MINIMUM_CALIBRATION_SAMPLE_SIZE}-pair minimum.`),
      ).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/moderation/cohort?targetAccountId=${miraId}&repositoryId=${repositoryId}&sampleStartedAt=2026-01-01T00%3A00&sampleEndedAt=2026-02-01T00%3A00`,
      { credentials: "same-origin" },
    );
  });

  it("disables opening a second audit for a target that already has one and says why", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    chooseTarget(nilsId);
    chooseWindow();
    writeReason("The outsider sample looks generous.");

    expect(screen.getByRole("button", { name: "Open audit" })).toBeDisabled();
    expect(screen.getByText("An audit is already open for nils. Resolve it before opening another.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open audit" }));
    expect(fetchMock).not.toHaveBeenCalled();

    chooseTarget(miraId);
    expect(screen.getByRole("button", { name: "Open audit" })).toBeEnabled();
    expect(
      screen.queryByText("An audit is already open for nils. Resolve it before opening another."),
    ).not.toBeInTheDocument();
  });

  it("shows the structured error message when the ledger refuses the audit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "INSUFFICIENT_SAMPLES",
            message: `At least ${MINIMUM_CALIBRATION_SAMPLE_SIZE} self-work and ${MINIMUM_CALIBRATION_SAMPLE_SIZE} outsider-settlement pairs are required.`,
          },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    chooseTarget(miraId);
    chooseWindow();
    writeReason("The self-work sample settles well above the outsider sample.");
    fireEvent.click(screen.getByRole("button", { name: "Open audit" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        `At least ${MINIMUM_CALIBRATION_SAMPLE_SIZE} self-work and ${MINIMUM_CALIBRATION_SAMPLE_SIZE} outsider-settlement pairs are required.`,
      );
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows a connection message when the request cannot be sent", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    chooseTarget(miraId);
    chooseWindow();
    writeReason("The self-work sample settles well above the outsider sample.");
    fireEvent.click(screen.getByRole("button", { name: "Open audit" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The audit could not reach Overflow. Check your connection and try again.",
      );
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("opens the audit without a preview, reports the target and refreshes the queue", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    chooseTarget(miraId);
    chooseWindow();
    writeReason("The self-work sample settles well above the outsider sample.");
    fireEvent.click(screen.getByRole("button", { name: "Open audit" }));

    expect(screen.getByRole("status")).toHaveTextContent("Opening the audit for mira…");
    expect(screen.getByRole("button", { name: "Open audit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview cohort" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/moderation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        targetAccountId: miraId,
        sampleStartedAt: startedAt,
        sampleEndedAt: endedAt,
        reason: "The self-work sample settles well above the outsider sample.",
      }),
    });

    resolveResponse?.(new Response(JSON.stringify({ audit: { id: auditId } }), { status: 201 }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("An audit is open for mira.");
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("sends the chosen repository with the opened audit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ audit: { id: auditId } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenAuditForm candidates={candidates} repositories={repositories} />);

    chooseTarget(miraId);
    chooseWindow();
    fireEvent.change(screen.getByLabelText("Repository scope"), { target: { value: repositoryId } });
    writeReason("The self-work sample settles well above the outsider sample.");
    fireEvent.click(screen.getByRole("button", { name: "Open audit" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/moderation", expect.objectContaining({
      body: JSON.stringify({
        targetAccountId: miraId,
        repositoryId,
        sampleStartedAt: startedAt,
        sampleEndedAt: endedAt,
        reason: "The self-work sample settles well above the outsider sample.",
      }),
    }));
  });
});

describe("moderation page open-audit section", () => {
  it("offers the open-audit form above an empty audit queue", async () => {
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("as self_work_pair_count")) {
        return [{
          id: miraId,
          github_login: "mira",
          enforcement_state: "ACTIVE",
          self_work_pair_count: 12,
          outsider_pair_count: 30,
          open_audit_id: null,
        }];
      }
      if (query.includes("from registered_repositories")) {
        return [{ id: repositoryId, owner_name: "overflow/ledger" }];
      }
      return [];
    });

    render(await ModerationPage());

    expect(screen.getByText("No account audits are open.")).toBeVisible();
    const section = screen.getByRole("region", { name: "Open a calibration audit" });
    expect(section).toHaveClass("surface");
    expect(within(section).getByRole("heading", { level: 2 })).toHaveAttribute("id", "open-audit-heading");
    expect(within(section).getByRole("option", { name: "mira · 12 self-work · 30 outsider settlements" })).toBeInTheDocument();
    expect(within(section).getByRole("option", { name: "overflow/ledger" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Open audit" })).toBeEnabled();

    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.slice(0, 2)).toEqual(["Open a calibration audit", "No account audits are open."]);
  });

  it("replaces the form with a readable message when the audit targets cannot be loaded", async () => {
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("as self_work_pair_count")) {
        throw new Error("Audit candidate query unavailable");
      }
      return [];
    });

    render(await ModerationPage());

    expect(screen.getByText("The audit targets could not be loaded.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open audit" })).toBeNull();
  });
});
