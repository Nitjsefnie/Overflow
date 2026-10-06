/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { MockInstance } from "vitest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { AccountControlsPanel } from "@/components/account-controls-panel";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const { assign } = vi.hoisted(() => ({ assign: vi.fn() }));

// `window.location` is unforgeable in jsdom, so the navigation observation goes
// through a window proxy that swaps only `location` and forwards everything
// else, bound, to the real window.
function stubWindowLocation(): void {
  const realWindow = globalThis.window as object;
  vi.stubGlobal("window", new Proxy(realWindow, {
    get(target, property) {
      if (property === "location") return { assign };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }));
}

// jsdom's `URL` carries no blob-URL statics; add them for the download and
// restore whatever the environment had, so the shared worker keeps its globals.
const urlStaticOriginals = {
  createObjectURL: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
  revokeObjectURL: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
};
const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:account-export-test");
const revokeObjectURL = vi.fn<(url: string) => void>(() => {});

function stubBlobUrls(): void {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true, writable: true, value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true, writable: true, value: revokeObjectURL,
  });
}

const confirmLogin = "Ada";
let click: MockInstance;

function typedConfirmation(value = confirmLogin): void {
  fireEvent.change(screen.getByLabelText("Type your GitHub login to confirm"), {
    target: { value },
  });
}

function reauthenticateForm(): HTMLFormElement | null {
  return document.getElementById("account-delete-reauthenticate") as HTMLFormElement | null;
}

function exportDocument(): Response {
  return Response.json({ account: { githubLogin: "Ada" } }, { status: 200 });
}

function deletionSucceeded(body: Record<string, unknown> = { deleted: true }): Response {
  return Response.json(body, { status: 200 });
}

beforeEach(() => {
  spyOnConsoleOutput();
  stubWindowLocation();
  stubBlobUrls();
  click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  try {
    expectNoConsoleOutput();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, descriptor] of Object.entries(urlStaticOriginals)) {
      if (descriptor === undefined) Reflect.deleteProperty(URL, name);
      else Object.defineProperty(URL, name, descriptor);
    }
  }
});

describe("account controls panel", () => {
  it("renders the export and deletion controls with the delete button disabled until the login is typed", () => {
    // A never-resolving fetch keeps the click handlers' state machine quiescent
    // for the rest of the case: no state lands after the assertions run.
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);

    const region = screen.getByRole("region", { name: "Your account data" });
    expect(region).toBeVisible();
    expect(within(region).getByRole("button", { name: "Download export" })).toBeEnabled();

    const confirmation = within(region).getByLabelText("Type your GitHub login to confirm");
    expect(confirmation).toHaveValue("");
    const deleteButton = within(region).getByRole("button", { name: "Delete account" });
    expect(deleteButton).toBeDisabled();

    // Typing the login arms the control; clearing it disarms it again.
    fireEvent.change(confirmation, { target: { value: " " } });
    expect(deleteButton).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: confirmLogin } });
    expect(deleteButton).toBeEnabled();
    fireEvent.change(confirmation, { target: { value: "" } });
    expect(deleteButton).toBeDisabled();

    // An export in flight disarms the delete control even with the login
    // typed: the export request alone lands, and the delete click sends nothing.
    fireEvent.change(confirmation, { target: { value: confirmLogin } });
    fireEvent.click(within(region).getByRole("button", { name: "Download export" }));
    fireEvent.click(deleteButton);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/account/export", {
      method: "POST",
      credentials: "same-origin",
    });

    // The deletion explainer links the account-data notice's deletion section.
    const explainer = within(region).getByRole("link");
    expect(explainer).toHaveAttribute("href", "/account-data#account-data-deletion-heading");
    expect(reauthenticateForm()).toBeNull();
  });

  it("downloads the export under its documented file name when the export succeeds", async () => {
    // A microtask queued by the click runs after the rest of the click's own
    // tick and before any timer, so it sees whether revocation was deferred.
    let revokedInClickTick: boolean | undefined;
    click.mockImplementation(() => {
      queueMicrotask(() => { revokedInClickTick = revokeObjectURL.mock.calls.length > 0; });
    });
    const fetchMock = vi.fn().mockResolvedValue(exportDocument());
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);

    fireEvent.click(screen.getByRole("button", { name: "Download export" }));

    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.size).toBeGreaterThan(0);
    await expect(blob.text()).resolves.toContain("githubLogin");
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("overflow-account-export.json");
    expect(anchor.href).toContain("blob:account-export-test");
    // Revoking in the same tick as the click can cancel the download in some
    // browsers, so the object URL outlives the click by at least one tick.
    expect(click).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:account-export-test"));
    expect(revokedInClickTick).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/account/export", {
      method: "POST",
      credentials: "same-origin",
    });
  });

  it.each([
    [401, "UNAUTHENTICATED", "Sign in is required."],
    [403, "FORBIDDEN", "A member account is required."],
    [502, "UPSTREAM_FAILURE", "Unable to export account data."],
  ])("reports a %s %s export refusal without triggering a download", async (status, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ error: { code, message } }, { status }),
    ));
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);

    fireEvent.click(screen.getByRole("button", { name: "Download export" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download export" })).toBeEnabled();
  });

  it("reports an export request that cannot reach Overflow without echoing the failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private network detail")));
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);

    fireEvent.click(screen.getByRole("button", { name: "Download export" }));

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("private network detail");
    expect(screen.getByRole("button", { name: "Download export" })).toBeEnabled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("sends the confirmation login with the delete request and navigates home on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(deletionSucceeded());
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);
    typedConfirmation();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/"));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/account", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmLogin }),
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(reauthenticateForm()).toBeNull();
  });

  it("navigates home even when deletion succeeded but ending the session failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(deletionSucceeded({ deleted: true, sessionEnded: false })));
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);
    typedConfirmation();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a confirmation mismatch without navigating or sending a second request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: {
      code: "CONFIRMATION_MISMATCH", message: "route-message-sentinel",
    } }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);
    typedConfirmation("not-my-login");

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("route-message-sentinel");
    expect(assign).not.toHaveBeenCalled();
    expect(reauthenticateForm()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Delete account" })).toBeEnabled();
  });

  it("offers the supplied re-authentication sign-in as its own form when deletion needs a fresh sign-in", async () => {
    const reauthenticate = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: {
      code: "REAUTHENTICATION_REQUIRED", message: "Confirm your GitHub sign-in to delete your account.",
    } }, { status: 403 })));
    render(<AccountControlsPanel reauthenticateAction={reauthenticate} />);
    typedConfirmation();
    expect(reauthenticateForm()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    const alert = await screen.findByRole("alert");
    const form = reauthenticateForm();
    expect(form).not.toBeNull();
    expect(screen.getByRole("region", { name: "Your account data" })).toContainElement(form);
    expect(form).not.toContainElement(alert);
    expect(assign).not.toHaveBeenCalled();
    const submit = within(form!).getByRole("button", { name: "Confirm GitHub sign-in" });
    expect(submit).toHaveAttribute("type", "submit");
    fireEvent.click(submit);
    await vi.waitFor(() => expect(reauthenticate).toHaveBeenCalledTimes(1));
  });

  it.each([
    [400, "CONFIRMATION_MISMATCH", "The confirmation login does not match your account."],
    [401, "UNAUTHENTICATED", "Sign in is required."],
    [403, "FORBIDDEN", "A member account is required."],
    [502, "UPSTREAM_FAILURE", "Unable to delete account."],
  ])("offers no re-authentication form for a %s %s refusal", async (status, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code, message } }, { status })));
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);
    typedConfirmation();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    await screen.findByRole("alert");
    expect(reauthenticateForm()).toBeNull();
  });

  it("names the sponsored repositories to unregister when deletion is sponsor-blocked", async () => {
    const repositories = [
      { ownerName: "octo/harbour", provider: "github", instanceUrl: null },
      { ownerName: "octo/quay", provider: "gitlab", instanceUrl: "https://gitlab.example" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: {
      code: "SPONSOR_BLOCKED",
      message: "route-message-sentinel",
      repositories,
    } }, { status: 409 })));
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);
    typedConfirmation();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("route-message-sentinel");
    const region = screen.getByRole("region", { name: "Your account data" });
    expect(within(region).getByRole("list")).toHaveTextContent("octo/harbour");
    expect(within(region).getByRole("list")).toHaveTextContent("octo/quay");
    expect(within(region).getByRole("list")).toHaveTextContent("https://gitlab.example");
    expect(assign).not.toHaveBeenCalled();
    expect(reauthenticateForm()).toBeNull();
    expect(screen.getByRole("button", { name: "Delete account" })).toBeEnabled();
  });

  it("allows only one in-flight delete request and re-arms after the outcome", async () => {
    let resolveDeletion!: (response: Response) => void;
    const deletion = new Promise<Response>((resolve) => { resolveDeletion = resolve; });
    const fetchMock = vi.fn().mockReturnValue(deletion);
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);
    typedConfirmation();
    const button = screen.getByRole("button", { name: "Delete account" });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => { resolveDeletion(deletionSucceeded()); });
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows only one in-flight export request and re-arms after the outcome", async () => {
    let resolveExport!: (response: Response) => void;
    const exportRequest = new Promise<Response>((resolve) => { resolveExport = resolve; });
    const fetchMock = vi.fn().mockReturnValue(exportRequest);
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);
    const button = screen.getByRole("button", { name: "Download export" });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => { resolveExport(exportDocument()); });
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Download export" })).toBeEnabled();
  });

  // The last-moderator warning (issue 1122): a plain warning above the confirm
  // field, rendered only for the instance's last live moderator. It never
  // blocks — the deletion proceeds exactly as without it.

  it("warns above the confirm field when the account is the instance's last live moderator", () => {
    // A never-resolving fetch keeps the click handlers' state machine quiescent.
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(() => {})));
    render(
      <AccountControlsPanel
        reauthenticateAction={vi.fn(async () => {})}
        isLastLiveModerator
        moderatorFloorConfigured
      />,
    );

    const region = screen.getByRole("region", { name: "Your account data" });
    const warning = within(region).getByRole("status");
    expect(warning).toBeVisible();
    // A plain warning, not an error alert: nothing has gone wrong yet.
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
    expect(warning.textContent).toContain("no in-product moderator");
    expect(warning.textContent).toContain("MODERATOR_GITHUB_USER_IDS");
    expect(warning.textContent).toContain("next time it signs in");
    // The floor is configured, so the absence sentence stays off.
    expect(warning.textContent).not.toContain("No GitHub user id is configured");
    // The warning sits above the confirm field.
    const confirmation = within(region).getByLabelText("Type your GitHub login to confirm");
    expect(warning.compareDocumentPosition(confirmation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names the absent floor plainly in the warning when no GitHub user id is configured", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(() => {})));
    render(
      <AccountControlsPanel
        reauthenticateAction={vi.fn(async () => {})}
        isLastLiveModerator
        moderatorFloorConfigured={false}
      />,
    );

    const warning = screen.getByRole("status");
    expect(warning.textContent).toContain("No GitHub user id is configured in MODERATOR_GITHUB_USER_IDS right now.");
  });

  it("renders no moderator warning for an ordinary account", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(() => {})));
    render(<AccountControlsPanel reauthenticateAction={vi.fn(async () => {})} />);

    const region = screen.getByRole("region", { name: "Your account data" });
    expect(within(region).queryByRole("status")).not.toBeInTheDocument();
    expect(within(region).queryByText(/moderator/i)).not.toBeInTheDocument();
  });

  it("still deletes the last live moderator's account while the warning is showing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(deletionSucceeded()));
    render(
      <AccountControlsPanel
        reauthenticateAction={vi.fn(async () => {})}
        isLastLiveModerator
        moderatorFloorConfigured={false}
      />,
    );
    typedConfirmation();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
