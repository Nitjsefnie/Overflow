/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryForm, type RepositoryFormValues } from "@/components/repository-form";

const initialValues: RepositoryFormValues = {
  repositoryUrl: "co-op/harbour",
  openingName: "Promise band",
  actualName: "Landing measure",
  openingLabels: [
    { label: "moonlit ridge", comparisonPoints: 3, reservePoints: 4 },
    { label: "granite path", comparisonPoints: 6, reservePoints: 8 },
  ],
  actualLabels: [
    { label: "rill", points: 1 },
    { label: "stream", points: 2 },
    { label: "brook", points: 3 },
    { label: "river", points: 4 },
    { label: "estuary", points: 5 },
    { label: "delta", points: 6 },
    { label: "harbour", points: 7 },
    { label: "sound", points: 8 },
    { label: "sea", points: 9 },
    { label: "ocean", points: 10 },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const stylesheet = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

function declarations(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(
    ([, property, value]) => [property!, value!.trim()],
  ));
}

function feedbackDeclarations(kind: string): Record<string, string> {
  const rule = stylesheet.match(new RegExp(`\\.feedback\\.${kind}\\s*\\{([^}]*)\\}`));
  expect(rule, `Missing .feedback.${kind} rule`).not.toBeNull();
  return declarations(rule![1]!);
}

function resolveColor(value: string): string {
  const token = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  const root = declarations(stylesheet.match(/:root\s*\{([^}]*)\}/)![1]!);
  const hex = token ? root[token] : value;
  expect(hex, `Expected a six-digit hex color for ${value}`).toMatch(/^#[\da-f]{6}$/i);
  return hex!;
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

describe("feedback stylesheet", () => {
  it("keeps the warning visible with a light amber background and dark ink", () => {
    const rule = feedbackDeclarations("warning");
    expect(rule.background).toBe("#fff0c2");
    expect(rule.color).toBe("var(--debit-ink)");
    expect(rule.display).not.toBe("none");
  });

  it.each(["warning", "error", "success"])("gives %s text at least 4.5:1 contrast", (kind) => {
    const rule = feedbackDeclarations(kind);
    const background = relativeLuminance(resolveColor(rule.background!));
    const ink = relativeLuminance(resolveColor(rule.color!));
    const contrast = (Math.max(background, ink) + 0.05) / (Math.min(background, ink) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  });
});

describe("repository registration form", () => {
  describe.each([
    ["EVIDENCE_FOUND", "success", ""],
    ["NO_EVIDENCE_FOUND", "warning", " No workflow assigning the author of an issue comment was found in this repository. Without such a workflow, contributors cannot claim issues themselves by commenting; someone with write access must assign them before any credit is reserved. Add a workflow triggered by issue_comment that assigns the commenter; Overflow's own .github/workflows/claim.yml is a working example."],
    ["NOT_CHECKED", "warning", " Overflow could not read this repository's workflows, so it does not know whether comment-based claiming is set up. Check the workflows yourself for one triggered by issue_comment that assigns the comment author."],
  ])("claimPath: %s", (claimPath, kind, claimMessage) => {
    it.each([
      [true, "co-op/harbour is registered. Its existing issues are being imported and will appear shortly."],
      [false, "co-op/harbour is registered, but its initial import could not be scheduled. It will be picked up by the next repair sweep."],
      [undefined, "co-op/harbour is registered."],
    ])("composes the complete message with initialImportScheduled: %s", async (initialImportScheduled, importMessage) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
        repository: { ownerName: "co-op/harbour" },
        initialImportScheduled,
        claimPath,
      }, { status: 201 })));
      const { container } = render(<RepositoryForm initialValues={initialValues} />);

      fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

      const feedback = await screen.findByRole("status");
      expect(feedback).toHaveClass("feedback", kind);
      expect(feedback.textContent).toBe(importMessage + claimMessage);
      if (kind === "warning") {
        expect(container.querySelector(".feedback.success")).toBeNull();
        expect(feedback).not.toHaveAttribute("aria-live");
      }
    });
  });

  it("keeps the existing success message for missing claimPath", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      repository: { ownerName: "co-op/harbour" },
      initialImportScheduled: true,
    }, { status: 201 })));
    render(<RepositoryForm initialValues={initialValues} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    const feedback = await screen.findByRole("status");
    expect(feedback).toHaveClass("feedback", "success");
    expect(feedback.textContent).toBe(
      "co-op/harbour is registered. Its existing issues are being imported and will appear shortly.",
    );
  });

  it.each([403, 429, 502])("shows an HTTP %s API response's error message verbatim", async (status) => {
    const message = "GitHub rate-limited the request to create the repository webhook (HTTP 403). Retry after 60 seconds. Please retry registration later.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: { code: "GITHUB_RATE_LIMITED", message },
    }, { status })));
    render(<RepositoryForm initialValues={initialValues} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it("keeps configured display names, arbitrary labels, and all actual mappings editable", () => {
    render(<RepositoryForm initialValues={initialValues} />);

    expect(screen.getByLabelText("Opening catalog display name")).toHaveValue("Promise band");
    expect(screen.getByLabelText("Actual catalog display name")).toHaveValue("Landing measure");
    expect(screen.getByLabelText("Opening label 1")).toHaveValue("moonlit ridge");
    expect(screen.getByLabelText("Actual label for 1 point")).toHaveValue("rill");
    expect(screen.getByLabelText("Actual label for 10 points")).toHaveValue("ocean");

    for (const points of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(screen.getByText(`${points} points`)).toBeVisible();
    }

    fireEvent.change(screen.getByLabelText("Actual label for 7 points"), { target: { value: "shelf" } });
    expect(screen.getByLabelText("Actual label for 7 points")).toHaveValue("shelf");
  });

  it("keeps an opening-label input focused throughout a multi-step edit", () => {
    render(<RepositoryForm initialValues={initialValues} />);

    const openingLabel = screen.getByLabelText("Opening label 1");
    openingLabel.focus();

    fireEvent.change(openingLabel, { target: { value: "m" } });
    expect(screen.getByLabelText("Opening label 1")).toBe(openingLabel);
    expect(openingLabel).toHaveFocus();
    expect(openingLabel).toHaveValue("m");

    fireEvent.change(openingLabel, { target: { value: "mo" } });
    expect(screen.getByLabelText("Opening label 1")).toBe(openingLabel);
    expect(openingLabel).toHaveFocus();
    expect(openingLabel).toHaveValue("mo");

    fireEvent.change(openingLabel, { target: { value: "moon" } });
    expect(screen.getByLabelText("Opening label 1")).toBe(openingLabel);
    expect(openingLabel).toHaveFocus();
    expect(openingLabel).toHaveValue("moon");
  });

  it("rejects more than one submitted repository before contacting the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm initialValues={{ ...initialValues, repositoryUrl: "co-op/harbour co-op/other" }} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    expect(screen.getByRole("alert").textContent).toBe("Enter one owner/name or one GitHub repository URL.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a noncanonical owner/name segment before contacting the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm initialValues={{ ...initialValues, repositoryUrl: "co-op/harbour%20two" }} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    expect(screen.getByRole("alert").textContent).toBe("Enter one owner/name or one GitHub repository URL.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits the existing registration API shape and announces success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ repository: { ownerName: "co-op/harbour" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm initialValues={initialValues} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(initialValues);
    expect((await screen.findByRole("status")).textContent).toBe("co-op/harbour is registered.");
  });

  it("says the initial import could not be scheduled when the registration failed to enqueue it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ repository: { ownerName: "co-op/harbour" }, initialImportScheduled: false }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm initialValues={initialValues} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("status")).textContent).toBe(
      "co-op/harbour is registered, but its initial import could not be scheduled. It will be picked up by the next repair sweep.",
    );
  });

  it("says the existing issues are on their way when the registration scheduled the import", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ repository: { ownerName: "co-op/harbour" }, initialImportScheduled: true }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm initialValues={initialValues} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("status")).textContent).toBe(
      "co-op/harbour is registered. Its existing issues are being imported and will appear shortly.",
    );
  });
});
