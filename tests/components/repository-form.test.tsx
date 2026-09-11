/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryForm, type RepositoryFormValues } from "@/components/repository-form";
import { declarations, firstAtRule, pinnedRule, rem, stylesheet } from "../support/stylesheet-rules";

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
  vi.useRealTimers();
});

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
 * Routes the form's three calls by URL: the labels read goes to the labels
 * route, the identities read goes to the forge-identities route, and
 * everything else is a registration or catalog-change submission whose calls
 * are recorded for the assertions.
 */
function stubFormApi(
  submit: () => Response,
  labels: () => Response = defaultLabelsResponse,
  identities: () => Response | Promise<Response> = defaultIdentitiesResponse,
) {
  const submitCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes("/api/repositories/labels")) {
      return labels();
    }
    if (String(input).includes("/api/forge-identities")) {
      return identities();
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

/** The forge-identities view the API answers with; a token never appears. */
const gitlabIdentity = {
  id: "gl-1",
  provider: "gitlab",
  instanceUrl: "https://gitlab.example",
  forgeLogin: "gl-user",
  verifiedAt: "2026-09-01T00:00:00.000Z",
};

const githubIdentity = {
  id: "gh-1",
  provider: "github",
  instanceUrl: "https://github.com",
  forgeLogin: "octo",
  verifiedAt: "2026-09-01T00:00:00.000Z",
};

function defaultIdentitiesResponse(): Response {
  return Response.json({ identities: [] });
}

/** The labels-route calls the stubbed fetch has seen, URLs only. */
function labelsCalls(fetchMock: { mock: { calls: ReadonlyArray<unknown[]> } }): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes("/api/repositories/labels"));
}

/** Lets pending promise chains (the identities read) settle under fake timers. */
async function flushMicrotasks() {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) {
      await Promise.resolve();
    }
  });
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

/**
 * Spacing in the registration form.
 *
 * jsdom performs no layout, so a rendering test passes whether or not two
 * fields touch. What is pinned here is the stylesheet text that produces the
 * spacing — which declarations exist, how they compare in size, and the source
 * order the ties between them are decided by — and never the geometry itself.
 * A real-viewport check is what would pin that; issue 111 tracks its absence.
 */
describe("registration form spacing stylesheet", () => {
  it("separates the form's sections by more than a field puts between its own label and input", () => {
    const sectionGap = pinnedRule(".repository-form > * + *");

    // The boundary between two unrelated fields has to read as wider than the
    // one inside a single field, or the two fields are seen as one.
    const gap = rem(sectionGap.declarations["margin-top"], "the form's section gap");
    const labelGap = rem(pinnedRule(".field").declarations.gap, "the label-to-input gap");
    expect(gap).toBeGreaterThan(labelGap * 2);
    expect(sectionGap.index, "the section gap applies at every viewport").toBeLessThan(firstAtRule);
  });

  it("takes every section gap from the lower section's margin-top so no edge sums two gaps", () => {
    const sectionGap = pinnedRule(".repository-form > * + *");
    const introGap = pinnedRule(".form-intro + *");
    const fieldset = pinnedRule(".catalog-fieldset");
    const actionButton = pinnedRule(".action-button");

    expect(pinnedRule(".form-intro").declarations["margin-bottom"], "the intro adds no bottom margin").toBeUndefined();
    expect(
      rem(introGap.declarations["margin-top"], "the gap below the intro"),
      "the intro keeps a strictly wider gap than the generic one",
    ).toBeGreaterThan(rem(sectionGap.declarations["margin-top"], "the form's section gap"));

    // The wider gaps tie with the generic one on specificity, so each keeps
    // its own value only while the generic rule stays above it.
    expect(sectionGap.index).toBeLessThan(introGap.index);
    expect(sectionGap.index).toBeLessThan(fieldset.index);
    expect(
      sectionGap.index,
      "the submit button keeps its own wider gap only while the generic rule stays above it",
    ).toBeLessThan(actionButton.index);
    expect(fieldset.declarations.margin, "the fieldset keeps its own 2rem").toBe("2rem 0 0");
  });

  it("starts the labels of a catalog row on a common line at every viewport", () => {
    const rowField = pinnedRule(".catalog-row > .field");

    expect(rowField.declarations["align-self"]).toBe("start");
    expect(rowField.index, "the row's fields align to the top at every viewport").toBeLessThan(firstAtRule);
    // Only the fields move: the controls that are not fields — the Remove
    // button, the points stamp — keep the row's end alignment and stay level
    // with the inputs.
    expect(pinnedRule(".catalog-row").declarations["align-items"]).toBe("end");
  });
});

describe("points stamp stylesheet", () => {
  it("keeps the stamp on the surface with ordinary ink", () => {
    const stamp = pinnedRule(".points-stamp");

    expect(resolveColor(stamp.declarations.background!)).toBe("#fffaf0");
    expect(resolveColor(stamp.declarations.color!)).toBe("#181714");
  });

  it("never wears the fill the primary action button wears", () => {
    const stamp = pinnedRule(".points-stamp");
    const actionButton = pinnedRule(".action-button");

    // A read-only stamp beside a catalog row must not read as the primary
    // action, so its fill can never resolve to the button's fill — however
    // either declaration spells its color.
    expect(resolveColor(stamp.declarations.background!)).not.toBe(
      resolveColor(actionButton.declarations.background!),
    );
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
      expect(screen.getByText(`${points} point${points === 1 ? "" : "s"}`)).toBeVisible();
    }

    await selectLoadedOption("Actual label for 7 points", "shelf");
    expect(screen.getByLabelText("Actual label for 7 points")).toHaveValue("shelf");
    expect(openingLabel).toHaveValue("moonlit ridge");
  });

  it("reads the actual catalog's point stamps with the plural each count takes", () => {
    render(<RepositoryForm initialValues={initialValues} />);

    expect(screen.queryByText("1 points")).toBeNull();
    expect(screen.getByText("1 point")).toBeVisible();
    expect(screen.getByText("2 points")).toBeVisible();
    expect(screen.getByText("10 points")).toBeVisible();
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
    expect(init?.credentials).toBe("same-origin");
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

  it("discards a stale labels response that resolves after a newer reference's", async () => {
    let resolveStale: (response: Response) => void = () => {};
    let labelsCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).includes("/api/repositories/labels")) {
        return Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 });
      }
      labelsCalls += 1;
      if (labelsCalls === 1) {
        // Hold the first repository's response until the second one has won.
        return new Promise<Response>((resolve) => {
          resolveStale = resolve;
        });
      }
      return Response.json({ labels: ["pier", "mast"] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<RepositoryForm initialValues={{ ...initialValues, repositoryUrl: "co-op/harbour" }} />);
    // The read is debounced: the first repository's request goes out only
    // after the reference has settled.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "octo/other" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const opening = screen.getByLabelText("Opening label 1");
    await waitFor(() => expect(opening).toBeEnabled());
    expect(within(opening).getByRole("option", { name: "pier" })).toBeInTheDocument();
    await selectLoadedOption("Opening label 1", "pier");
    expect(opening).toHaveValue("pier");

    await act(async () => {
      resolveStale(Response.json({ labels: ["harbour label", "extra"] }));
    });

    expect(opening).toBeEnabled();
    expect(opening).toHaveValue("pier");
    expect(within(opening).getByRole("option", { name: "pier" })).toBeInTheDocument();
    expect(within(opening).queryByRole("option", { name: "harbour label" })).toBeNull();
    const actual = screen.getByLabelText("Actual label for 1 point");
    expect(within(actual).getByRole("option", { name: "mast" })).toBeInTheDocument();
    expect(within(actual).queryByRole("option", { name: "harbour label" })).toBeNull();
    expect(container.querySelector(".labels-fetch-error")).toBeNull();
  });

  it("fires exactly one labels request once the reference stops changing", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ labels: ["pier", "mast"] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm />);

    const repositoryField = screen.getByLabelText("GitHub repository");
    // Rapid typing: several edits inside the quiet window, crossing from
    // invalid to valid references along the way.
    fireEvent.change(repositoryField, { target: { value: "o" } });
    fireEvent.change(repositoryField, { target: { value: "octo" } });
    fireEvent.change(repositoryField, { target: { value: "octo/over" } });
    fireEvent.change(repositoryField, { target: { value: "octo/overflow" } });

    expect(fetchMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/repositories/labels?owner=octo&name=overflow");
    expect(screen.getByLabelText("Opening label 1")).toBeEnabled();
    expect(within(screen.getByLabelText("Opening label 1")).getByRole("option", { name: "pier" })).toBeInTheDocument();
  });

  it("cancels the pending fetch when the reference changes inside the quiet window", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ labels: ["pier", "mast"] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RepositoryForm />);

    const repositoryField = screen.getByLabelText("GitHub repository");
    fireEvent.change(repositoryField, { target: { value: "co-op/harbour" } });
    vi.advanceTimersByTime(200);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(repositoryField, { target: { value: "octo/other" } });
    vi.advanceTimersByTime(400);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/repositories/labels?owner=octo&name=other");
    expect(screen.getByLabelText("Opening label 1")).toBeEnabled();
    expect(within(screen.getByLabelText("Opening label 1")).getByRole("option", { name: "mast" })).toBeInTheDocument();
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

describe("repository form forge selection", () => {
  /** Submits a full GitLab registration; returns the recorded submit calls. */
  async function submitGitLabRegistration(
    submitResponse: () => Response,
  ): Promise<Array<{ url: string; init: RequestInit }>> {
    const { fetchMock, submitCalls } = stubFormApi(
      submitResponse,
      defaultLabelsResponse,
      () => Response.json({ identities: [githubIdentity, gitlabIdentity] }),
    );
    render(<RepositoryForm />);
    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    const instance = await waitFor(() => {
      const select = screen.getByLabelText("Instance") as HTMLSelectElement;
      expect(within(select).getByRole("option", { name: "https://gitlab.example (gl-user)" })).toBeInTheDocument();
      return select;
    });
    fireEvent.change(instance, { target: { value: "https://gitlab.example" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: " group/proj " } });
    await selectLoadedOption("Opening label 1", "rill");
    await selectLoadedOption("Opening label 2", "stream");
    await selectLoadedOption("Opening label 3", "brook");
    for (const points of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await selectLoadedOption(
        `Actual label for ${points} point${points === 1 ? "" : "s"}`,
        repositoryLabels[points - 1]!,
      );
    }
    expect(fetchMock).toHaveBeenCalled();
    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));
    await waitFor(() => expect(submitCalls).toHaveLength(1));
    return submitCalls;
  }

  it("offers the forge with GitHub preselected and the GitHub fields on the GitHub path", () => {
    const { fetchMock } = stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm />);

    const forge = screen.getByLabelText("Forge");
    expect(forge).toHaveValue("github");
    expect(within(forge).getByRole("option", { name: "GitHub" })).toBeInTheDocument();
    expect(within(forge).getByRole("option", { name: "GitLab" })).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub repository")).toBeInTheDocument();
    expect(screen.queryByLabelText("Instance")).toBeNull();
    expect(screen.queryByLabelText("Project")).toBeNull();
    // The identities read is not spent when the forge never leaves GitHub.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the catalog-change variant GitHub-only without a Forge selector", () => {
    stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm variant="catalog-change" />);

    expect(screen.queryByLabelText("Forge")).toBeNull();
    expect(screen.getByLabelText("GitHub repository")).toBeInTheDocument();
  });

  it("swaps the GitHub repository field for the Instance and Project fields when GitLab is chosen", () => {
    stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    expect(screen.queryByLabelText("GitHub repository")).toBeNull();
    expect(screen.getByLabelText("Instance")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toBeInTheDocument();
  });

  it("feeds the Instance select from the linked GitLab identities only", async () => {
    const { fetchMock } = stubFormApi(
      () => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }),
      defaultLabelsResponse,
      () => Response.json({ identities: [githubIdentity, gitlabIdentity] }),
    );
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    const instance = screen.getByLabelText("Instance");
    await waitFor(() =>
      expect(within(instance).getByRole("option", { name: "https://gitlab.example (gl-user)" })).toBeInTheDocument(),
    );
    expect(within(instance).queryByRole("option", { name: /octo/ })).toBeNull();
    expect(fetchMock.mock.calls.every(([input]) => String(input).includes("/api/forge-identities"))).toBe(true);
  });

  it("refuses a GitLab submit when no GitLab identity is linked, naming the dashboard's Forge identities page", async () => {
    const { fetchMock, submitCalls } = stubFormApi(() => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }));
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushMicrotasks();
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "group/proj" } });
    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    expect(screen.getByRole("alert").textContent).toContain("Forge identities page");
    expect(submitCalls).toHaveLength(0);
  });

  it("refuses a GitLab submit with no instance chosen before contacting the API", async () => {
    const { submitCalls } = stubFormApi(
      () => Response.json({ repository: { ownerName: "co-op/harbour" } }, { status: 201 }),
      defaultLabelsResponse,
      () => Response.json({ identities: [gitlabIdentity] }),
    );
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    await flushMicrotasks();
    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    expect(screen.getByRole("alert").textContent).toBe("Choose the GitLab instance to register through.");
    expect(submitCalls).toHaveLength(0);
  });

  it("does not claim identities are missing while the identities read is in flight", async () => {
    let resolveIdentities: (response: Response) => void = () => {};
    const { submitCalls } = stubFormApi(
      () => Response.json({ repository: { ownerName: "group/proj" } }, { status: 201 }),
      defaultLabelsResponse,
      () => new Promise<Response>((resolve) => {
        resolveIdentities = resolve;
      }),
    );
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    const alertText = screen.getByRole("alert").textContent;
    expect(alertText).not.toContain("Forge identities page");
    expect(submitCalls).toHaveLength(0);

    // Once the answer lands, a genuinely empty list earns the real refusal.
    await act(async () => {
      resolveIdentities(Response.json({ identities: [] }));
    });
    await flushMicrotasks();
    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));
    expect(screen.getByRole("alert").textContent).toContain("Forge identities page");
    expect(submitCalls).toHaveLength(0);
  });

  it("names reload as the remedy when the identities read failed", async () => {
    const { submitCalls } = stubFormApi(
      () => Response.json({ repository: { ownerName: "group/proj" } }, { status: 201 }),
      defaultLabelsResponse,
      () => new Response("exploded", { status: 500 }),
    );
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    await flushMicrotasks();
    fireEvent.submit(screen.getByRole("form", { name: "Register one repository" }));

    const alertText = screen.getByRole("alert").textContent;
    expect(alertText).toContain("Reload");
    expect(alertText).not.toContain("Forge identities page");
    expect(alertText).not.toContain("retry");
    expect(submitCalls).toHaveLength(0);
  });

  it("clears the selections and refetches when the GitLab project changes", async () => {
    const labels = [Response.json({ labels: ["pier", "mast"] }), Response.json({ labels: ["keel", "sail"] })];
    stubFormApi(
      () => Response.json({ repository: { ownerName: "group/proj" } }, { status: 201 }),
      () => labels.shift() ?? Response.json({ labels: [] }),
      () => Response.json({ identities: [gitlabIdentity] }),
    );
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    const instance = await waitFor(() => {
      const select = screen.getByLabelText("Instance") as HTMLSelectElement;
      expect(within(select).getByRole("option", { name: "https://gitlab.example (gl-user)" })).toBeInTheDocument();
      return select;
    });
    fireEvent.change(instance, { target: { value: "https://gitlab.example" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "group/proj" } });
    await selectLoadedOption("Opening label 1", "pier");
    await selectLoadedOption("Actual label for 2 points", "pier");

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "other/proj" } });

    await waitFor(() => expect(screen.getByLabelText("Opening label 1")).toHaveValue(""));
    await waitFor(() => expect(screen.getByLabelText("Actual label for 2 points")).toHaveValue(""));
    await waitFor(() => expect(screen.getByLabelText("Opening label 1")).toBeEnabled());
    const opening = screen.getByLabelText("Opening label 1");
    expect(within(opening).getByRole("option", { name: "keel" })).toBeInTheDocument();
    expect(within(opening).queryByRole("option", { name: "pier" })).toBeNull();
  });

  it("reads the GitLab labels once instance and project are present and well-shaped", async () => {
    const { fetchMock } = stubFormApi(
      () => Response.json({ repository: { ownerName: "group/proj" } }, { status: 201 }),
      defaultLabelsResponse,
      () => Response.json({ identities: [gitlabIdentity] }),
    );
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    const instance = await waitFor(() => {
      const select = screen.getByLabelText("Instance") as HTMLSelectElement;
      expect(within(select).getByRole("option", { name: "https://gitlab.example (gl-user)" })).toBeInTheDocument();
      return select;
    });
    fireEvent.change(instance, { target: { value: "https://gitlab.example" } });
    // The project is still missing: no labels read yet.
    await flushMicrotasks();
    expect(labelsCalls(fetchMock)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "group/proj" } });
    await waitFor(() => expect(labelsCalls(fetchMock)).toHaveLength(1));
    const url = new URL(labelsCalls(fetchMock)[0]!, "http://localhost");
    expect(url.pathname).toBe("/api/repositories/labels");
    expect([...url.searchParams.keys()].sort()).toEqual(["instance", "project", "provider"]);
    expect(url.searchParams.get("provider")).toBe("gitlab");
    expect(url.searchParams.get("instance")).toBe("https://gitlab.example");
    expect(url.searchParams.get("project")).toBe("group/proj");
    expect(fetchMock.mock.calls.find(([input]) => String(input).includes("/api/repositories/labels"))?.[1]).toMatchObject({
      credentials: "same-origin",
    });

    await waitFor(() => expect(screen.getByLabelText("Opening label 1")).toBeEnabled());
    expect(within(screen.getByLabelText("Opening label 1")).getByRole("option", { name: "rill" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Actual label for 10 points")).getByRole("option", { name: "ocean" })).toBeInTheDocument();
  });

  it("shows the project shape guidance and fetches nothing for a project that is neither numeric nor a path", async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubFormApi(
      () => Response.json({ repository: { ownerName: "group/proj" } }, { status: 201 }),
      defaultLabelsResponse,
      () => Response.json({ identities: [gitlabIdentity] }),
    );
    render(<RepositoryForm />);

    fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
    await flushMicrotasks();
    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "https://gitlab.example" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "justaproject" } });

    expect(screen.getByText("Submit the GitLab project as a positive numeric id or a path with namespace.")).toBeVisible();
    vi.advanceTimersByTime(400);
    await flushMicrotasks();
    expect(labelsCalls(fetchMock)).toHaveLength(0);
  });

  it("submits the GitLab registration body with the instance and the trimmed project", async () => {
    const submitCalls = await submitGitLabRegistration(() =>
      Response.json({ repository: { ownerName: "group/proj" } }, { status: 201 }),
    );

    const { url, init } = submitCalls[0]!;
    expect(url).toBe("/api/repositories");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "gitlab",
      instanceUrl: "https://gitlab.example",
      project: "group/proj",
      openingName: "Opening catalog",
      actualName: "Result catalog",
      openingLabels: [
        { label: "rill", comparisonPoints: 3, reservePoints: 3 },
        { label: "stream", comparisonPoints: 6, reservePoints: 6 },
        { label: "brook", comparisonPoints: 9, reservePoints: 9 },
      ],
      actualLabels: repositoryLabels.slice(0, 10).map((label, index) => ({ label, points: index + 1 })),
    });
  });

  it("renders the same registration success message for a GitLab registration", async () => {
    await submitGitLabRegistration(() =>
      Response.json({
        repository: { ownerName: "group/proj" },
        initialImportScheduled: false,
        claimPath: "NOT_CHECKED",
      }, { status: 201 }),
    );

    const feedback = await screen.findByRole("status");
    expect(feedback).toHaveClass("feedback", "warning");
    expect(feedback.textContent).toBe(
      "group/proj is registered, but its initial import could not be scheduled. It will be picked up by the next repair sweep."
        + " Overflow could not read this repository's workflows, so it does not know whether comment-based claiming is set up."
        + " Check the workflows yourself for one triggered by issue_comment that assigns the comment author.",
    );
  });
});

async function selectLoadedOption(label: string, value: string): Promise<HTMLElement> {
  const select = await screen.findByLabelText(label);
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value } });
  return select;
}
