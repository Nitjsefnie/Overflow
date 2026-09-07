/** @vitest-environment jsdom */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RouteError from "@/app/error";
import GlobalError from "@/app/global-error";

describe.each([
  { name: "route", Component: RouteError },
  { name: "global", Component: GlobalError },
])("$name error boundary", ({ name, Component }) => {
  let frame: HTMLIFrameElement | undefined;

  afterEach(() => {
    cleanup();
    frame?.remove();
    frame = undefined;
  });

  function renderBoundary(error: Error & { digest?: string }, reset = vi.fn()) {
    // Give each full-document mount its own event root and browsing context.
    if (name === "global") {
      frame = document.createElement("iframe");
      document.body.append(frame);
      const boundaryDocument = frame.contentDocument!;
      const view = render(<Component error={error} reset={reset} />, {
        container: boundaryDocument,
        baseElement: boundaryDocument.documentElement,
      });
      return { ...view, output: () => view.baseElement.outerHTML };
    }
    const view = render(<Component error={error} reset={reset} />);
    return { ...view, output: () => view.baseElement.outerHTML };
  }

  it("renders a heading when given an error without a digest", () => {
    const view = renderBoundary(new Error("private-render-7c85"));

    expect(view.getByRole("heading", { level: 1 })).toBeVisible();
  });

  it("calls the supplied reset function when the retry control is activated", () => {
    const reset = vi.fn();
    const view = renderBoundary(new Error("private-retry-25e1"), reset);

    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button"));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("provides a link to the application root", () => {
    const view = renderBoundary(new Error("private-link-d07b"));

    expect(view.getAllByRole("link").some((link) => link.getAttribute("href") === "/")).toBe(true);
  });

  it("excludes the error message from the rendered output", () => {
    const view = renderBoundary(new Error("private-query-c4a91"));

    expect(view.output()).not.toContain("private-query-c4a91");
  });

  it("excludes the error stack from the rendered output", () => {
    const error = new Error("private-message-e19c");
    error.stack = "private-stack-path-58af";
    const view = renderBoundary(error);

    expect(view.output()).not.toContain("private-stack-path-58af");
  });

  it("shows the digest for correlation with server logs", () => {
    const error = Object.assign(new Error("private-digest-b962"), { digest: "digest-8c014f" });
    const view = renderBoundary(error);

    expect(view.getByText("digest-8c014f", { exact: false })).toBeVisible();
  });
});
