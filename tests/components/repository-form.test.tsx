/** @vitest-environment jsdom */

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

describe("repository registration form", () => {
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

    expect(screen.getByRole("alert")).toHaveTextContent("Enter one owner/name or one GitHub repository URL.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a noncanonical owner/name segment before contacting the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm initialValues={{ ...initialValues, repositoryUrl: "co-op/harbour%20two" }} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter one owner/name or one GitHub repository URL.");
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
    expect(await screen.findByRole("status")).toHaveTextContent("co-op/harbour is registered.");
  });
});
