/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** Every label the stubbed repository answers the labels route with. */
const repositoryLabels = [
  "moonlit ridge",
  "granite path",
  "rill",
  "stream",
  "brook",
  "river",
  "estuary",
  "delta",
  "harbour",
  "sound",
  "sea",
  "ocean",
  "shelf",
];

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

/**
 * Routes the form's two calls by URL: the labels read goes to the labels
 * route, everything else is a registration or catalog-change submission whose
 * calls are recorded for the assertions.
 */
function stubFormApi(submit: () => Response, labels: () => Response = defaultLabelsResponse) {
  const submitCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes("/api/repositories/labels")) {
      return labels();
    }
    submitCalls.push({ url: String(input), init: init ?? {} });
    return submit();
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, submitCalls };
}

function defaultLabelsResponse(): Response {
  return Response.json({ labels: repositoryLabels });
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
      stubFormApi(() => Response.json({
        repository: { ownerName: "co-op/harbour" },
        initialImportScheduled,
        claimPath,
      }, { status: 201 }));
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
    stubFormApi(() => Response.json({
      repository: { ownerName: "co-op/harbour" },
      initialImportScheduled: true,
    }, { status: 201 }));
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
    stubFormApi(() => Response.json({
      error: { code: "GITHUB_RATE_LIMITED", message },
    }, { status }));
    render(<RepositoryForm initialValues={initialValues} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it("keeps configured display names and the catalog's picked labels editable", async () => {
    stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm initialValues={initialValues} />);

    expect(screen.getByLabelText("Opening catalog display name")).toHaveValue("Promise band");
    expect(screen.getByLabelText("Actual catalog display name")).toHaveValue("Landing measure");
    const openingLabel = await selectLoadedOption("Opening label 1", "moonlit ridge");
    await selectLoadedOption("Actual label for 1 point", "rill");
    // A preseeded initialValues label survives the mount; only a reference
    // change after the mount clears selections.
    expect(screen.getByLabelText("Actual label for 10 points")).toHaveValue("ocean");
    for (const points of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(screen.getByText(`${points} points`)).toBeVisible();
    }

    await selectLoadedOption("Actual label for 7 points", "shelf");
    expect(screen.getByLabelText("Actual label for 7 points")).toHaveValue("shelf");
    expect(openingLabel).toHaveValue("moonlit ridge");
  });

  it("keeps an opening-label select focused throughout a multi-step edit", async () => {
    stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm initialValues={initialValues} />);

    const openingLabel = await selectLoadedOption("Opening label 1", "moonlit ridge");
    openingLabel.focus();

    fireEvent.change(openingLabel, { target: { value: "rill" } });
    expect(screen.getByLabelText("Opening label 1")).toBe(openingLabel);
    expect(openingLabel).toHaveFocus();
    expect(openingLabel).toHaveValue("rill");

    fireEvent.change(openingLabel, { target: { value: "stream" } });
    expect(screen.getByLabelText("Opening label 1")).toBe(openingLabel);
    expect(openingLabel).toHaveFocus();
    expect(openingLabel).toHaveValue("stream");

    fireEvent.change(openingLabel, { target: { value: "moonlit ridge" } });
    expect(screen.getByLabelText("Opening label 1")).toBe(openingLabel);
    expect(openingLabel).toHaveFocus();
    expect(openingLabel).toHaveValue("moonlit ridge");
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
    const { submitCalls } = stubFormApi(() => Response.json(
      { repository: { ownerName: "co-op/harbour" } },
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    render(<RepositoryForm initialValues={initialValues} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(JSON.parse(String(submitCalls[0]!.init.body))).toEqual(initialValues);
    expect((await screen.findByRole("status")).textContent).toBe("co-op/harbour is registered.");
  });

  it("says the initial import could not be scheduled when the registration failed to enqueue it", async () => {
    const { submitCalls } = stubFormApi(() => Response.json(
      { repository: { ownerName: "co-op/harbour" }, initialImportScheduled: false },
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    render(<RepositoryForm initialValues={initialValues} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect((await screen.findByRole("status")).textContent).toBe(
      "co-op/harbour is registered, but its initial import could not be scheduled. It will be picked up by the next repair sweep.",
    );
  });

  it("says the existing issues are on their way when the registration scheduled the import", async () => {
    const { submitCalls } = stubFormApi(() => Response.json(
      { repository: { ownerName: "co-op/harbour" }, initialImportScheduled: true },
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    render(<RepositoryForm initialValues={initialValues} />);

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect((await screen.findByRole("status")).textContent).toBe(
      "co-op/harbour is registered. Its existing issues are being imported and will appear shortly.",
    );
  });
});

describe("repository catalog change form", () => {
  function changeForm(overrides: Partial<RepositoryFormValues> = {}) {
    return <RepositoryForm variant="catalog-change" initialValues={{ ...initialValues, ...overrides }} />;
  }

  it("submits the catalog as a PATCH with the registration payload shape and announces the change", async () => {
    const { submitCalls } = stubFormApi(() => Response.json({
      repository: { ownerName: "co-op/harbour" },
      changed: true,
      versionNumber: 2,
      effectiveFrom: "2026-09-09T12:00:00.000Z",
    }, { status: 200 }));
    render(changeForm());

    fireEvent.submit(screen.getByRole("form", { name: "Change a repository's difficulty catalog" }));

    const feedback = await screen.findByRole("status");
    expect(feedback).toHaveClass("feedback", "success");
    expect(feedback.textContent).toContain("co-op/harbour");
    expect(feedback.textContent).toContain("version 2");
    expect(feedback.textContent).toContain("already settled");
    expect(submitCalls).toHaveLength(1);
    const { url, init } = submitCalls[0]!;
    expect(url).toBe("/api/repositories");
    expect(init.method).toBe("PATCH");
    expect(init.credentials).toBe("same-origin");
    const body = JSON.parse(String(init.body));
    expect(body.repositoryUrl).toBe("co-op/harbour");
    expect(body.openingName).toBe("Promise band");
    expect(body.actualLabels).toHaveLength(10);
  });

  it("says nothing needed to change when the submitted catalog already is the current one", async () => {
    stubFormApi(() => Response.json({
      repository: { ownerName: "co-op/harbour" },
      changed: false,
      versionNumber: null,
      effectiveFrom: null,
    }, { status: 200 }));
    render(changeForm());

    fireEvent.submit(screen.getByRole("form", { name: "Change a repository's difficulty catalog" }));

    const feedback = await screen.findByRole("status");
    expect(feedback).toHaveClass("feedback", "success");
    expect(feedback.textContent).toContain("already governs");
  });

  it.each([400, 403, 409, 502])("shows an HTTP %s API response's error message verbatim", async (status) => {
    const message = "This GitHub repository is not registered, so there is no catalog to change.";
    stubFormApi(() => Response.json({
      error: { code: "CONFLICT", message },
    }, { status }));
    render(changeForm());

    fireEvent.submit(screen.getByRole("form", { name: "Change a repository's difficulty catalog" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it("rejects a noncanonical repository reference before contacting the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm variant="catalog-change" />);

    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "not a repository" } });
    fireEvent.submit(screen.getByRole("form", { name: "Change a repository's difficulty catalog" }));

    const feedback = screen.getByRole("alert");
    expect(feedback.textContent).toContain("Enter one owner/name or one GitHub repository URL.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("repository form catalog label selectboxes", () => {
  it("loads the repository's labels and enables the selects once they arrive", async () => {
    const { fetchMock } = stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm initialValues={initialValues} />);

    const openingLabel = screen.getByLabelText("Opening label 1") as HTMLSelectElement;
    expect(openingLabel).toBeDisabled();

    await waitFor(() => expect(openingLabel).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/repositories/labels?owner=co-op&name=harbour");
    expect(init.credentials).toBe("same-origin");
  });

  it("renders the fetched labels as the options of both catalogs' selectboxes", async () => {
    stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "co-op/harbour" } });

    const opening = screen.getByLabelText("Opening label 1");
    await waitFor(() => expect(opening).toBeEnabled());
    const actual = screen.getByLabelText("Actual label for 1 point");
    for (const label of repositoryLabels) {
      expect(within(opening).getByRole("option", { name: label })).toBeInTheDocument();
      expect(within(actual).getByRole("option", { name: label })).toBeInTheDocument();
    }
    expect(within(opening).getByRole("option", { name: "Select a label" })).toHaveAttribute("disabled");
  });

  it("keeps the placeholder selectboxes empty until a label is picked", async () => {
    stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "co-op/harbour" } });

    await waitFor(() => expect(screen.getByLabelText("Opening label 1")).toBeEnabled());
    expect(screen.getByLabelText("Opening label 1")).toHaveValue("");
    expect(screen.getByLabelText("Actual label for 1 point")).toHaveValue("");
  });

  it("hides a label picked in one row from the other rows of its own catalog", async () => {
    stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm initialValues={initialValues} />);

    const picked = await selectLoadedOption("Opening label 1", "moonlit ridge");
    const siblingRow = screen.getByLabelText("Opening label 2");
    expect(within(picked).getByRole("option", { name: "moonlit ridge" })).toBeInTheDocument();
    expect(within(siblingRow).queryByRole("option", { name: "moonlit ridge" })).toBeNull();

    // The actual catalog's options are untouched: exclusivity is per catalog.
    expect(within(screen.getByLabelText("Actual label for 1 point")).getByRole("option", { name: "moonlit ridge" }))
      .toBeInTheDocument();
  });

  it("disables the selectboxes and fetches nothing for an invalid reference", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm initialValues={{ ...initialValues, repositoryUrl: "not a repository" }} />);

    expect(screen.getByLabelText("Opening label 1")).toBeDisabled();
    expect(screen.getByLabelText("Actual label for 5 points")).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the selections and refetches when the reference changes", async () => {
    const labels = [Response.json({ labels: ["harbour label", "extra"] }), Response.json({ labels: ["pier", "mast"] })];
    stubFormApi(
      () => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }),
      () => labels.shift() ?? Response.json({ labels: [] }),
    );
    render(<RepositoryForm initialValues={{ ...initialValues, repositoryUrl: "co-op/harbour" }} />);

    await selectLoadedOption("Opening label 1", "harbour label");
    await selectLoadedOption("Actual label for 2 points", "harbour label");

    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "octo/other" } });

    await waitFor(() => expect(screen.getByLabelText("Opening label 1")).toHaveValue(""));
    await waitFor(() => expect(screen.getByLabelText("Actual label for 2 points")).toHaveValue(""));
    await waitFor(() => expect(screen.getByLabelText("Opening label 1")).toBeEnabled());
    const opening = screen.getByLabelText("Opening label 1");
    expect(within(opening).getByRole("option", { name: "pier" })).toBeInTheDocument();
    expect(within(opening).queryByRole("option", { name: "harbour label" })).toBeNull();
  });

  it("shows an inline message and blocks submit when the labels fetch fails", async () => {
    const { fetchMock, submitCalls } = stubFormApi(
      () => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }),
      () => Response.json({ error: { code: "UPSTREAM_FAILURE", message: "Unable to read the repository labels on GitHub." } }, { status: 502 }),
    );
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "co-op/harbour" } });

    expect(await screen.findByText(/could not read the labels of co-op\/harbour/)).toBeVisible();
    expect(screen.getByLabelText("Opening label 1")).toBeDisabled();

    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    expect(screen.getByRole("alert").textContent).toBe("Give every catalog entry a label and a points mapping.");
    expect(submitCalls).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

async function selectLoadedOption(label: string, value: string): Promise<HTMLElement> {
  const select = await screen.findByLabelText(label);
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value } });
  return select;
}
