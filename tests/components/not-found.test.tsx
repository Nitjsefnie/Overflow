/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ signOutAction: vi.fn() }));

// PublicAppShell imports the sign-out action for the signed-in shell; the
// public chrome never calls it. Mock it so this suite never loads the server
// action's request-origin guard.
vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: mocks.signOutAction }));

// Rebind the page and the public shell to this file's mocks when a worker is
// shared with a suite that mocks the same module differently.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

async function renderNotFound(): Promise<void> {
  const { default: NotFound } = await import("@/app/not-found");
  render(<NotFound />);
}

/**
 * The landmark roles axe-core counts for its `region` rule, by element and by
 * explicit role. An element passes when it is one of these or sits inside one.
 */
const LANDMARK_SELECTOR = [
  "main",
  "[role='main']",
  "header",
  "[role='banner']",
  "footer",
  "[role='contentinfo']",
  "nav",
  "[role='navigation']",
  "aside",
  "[role='complementary']",
  "form",
  "[role='form']",
  "[role='search']",
  "section[aria-label]",
  "section[aria-labelledby]",
  "[role='region']",
].join(", ");

/**
 * axe-core's region rule makes room for the page's first skip link, and for that
 * one node: `findRegionlessElms` keeps a node only when `_isSkipLink(node) &&
 * getElementByReference(node, 'href')`. Both halves are reproduced here, so the
 * exemption is narrower than "carries the class" — the node must be an anchor
 * whose href resolves onto an element in this document, and it must be the first
 * such anchor on the page. A second skip link further down, or a stray element
 * wearing the class, stays regionless content like any other.
 */
function isThePagesSkipLink(element: Element): boolean {
  if (!element.classList.contains("skip-link") || element.tagName.toLowerCase() !== "a") {
    return false;
  }
  const href = element.getAttribute("href");
  // A bare "#" is a fragment with no name: it resolves onto nothing, so
  // getElementByReference finds no element and the node is not a skip link.
  if (href === null || !href.startsWith("#") || href.length < 2) {
    return false;
  }
  if (document.querySelector(href) === null) {
    return false;
  }
  return element === document.querySelector("a[href]");
}

// Issue 908: src/app had error.tsx and global-error.tsx but no not-found.tsx,
// so an unknown URL rendered Next.js's default 404 — unstyled, no app shell,
// and failing both the landmark-one-main and the region check. These cases walk
// the route itself, because what a reader depends on lives in the composition:
// the chrome around the not-found content, not the content alone.
describe("not-found page", () => {
  it("composes the public shell around a single main of its own", async () => {
    await renderNotFound();

    // The shell adds no main, so the page supplies the one the skip link
    // targets: a second main would nest inside the first, duplicate the
    // main-content id, and retarget the skip link at the shell's wrapper.
    const mains = document.querySelectorAll("main");
    expect(mains, "the not-found page supplies exactly one main").toHaveLength(1);
    const main = mains[0]!;

    expect(main).toHaveClass("landing-page");
    expect(main).toHaveAttribute("id", "main-content");
    expect(document.querySelectorAll("#main-content")).toHaveLength(1);
    expect(document.getElementById("main-content"), "the skip link's target id names this main").toBe(main);
    // ...and it sits inside the shell, so the chrome frames the content.
    expect(main.closest(".app-shell"), "the main sits inside the app shell").not.toBeNull();
    expect(screen.getByRole("main")).toBe(main);
  });

  it("carries the signed-out chrome's landmarks", async () => {
    await renderNotFound();

    // Nothing in the chrome may imply a session: the not-found page is served
    // to whoever mistyped the address, signed in or not, so it uses the public
    // shell rather than the member one.
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("navigation", { name: "Site navigation" })).toBeVisible();
    expect(screen.getByRole("contentinfo")).toBeVisible();
    expect(document.querySelector('a[href="/dashboard"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(banner.querySelector("form")).toBeNull();
  });

  it("labels the content region the main wraps", async () => {
    await renderNotFound();

    // A section with an accessible name is a region landmark. Unnamed, its
    // contents lose that landmark and fall back to main alone.
    const regions = screen.getAllByRole("region");
    expect(regions, "the content inside main is one named region").toHaveLength(1);
    for (const region of regions) {
      expect(region).toHaveAccessibleName();
    }
    expect(regions[0]!.closest("main"), "the region sits inside the page's main").not.toBeNull();
    expect(within(regions[0]!).getByRole("heading", { level: 1 })).toBeVisible();
  });

  it("keeps every rendered text inside a landmark", async () => {
    await renderNotFound();

    // axe-core's `region` rule: all page content must be contained by
    // landmarks. This walks the rendered shell rather than a selector naming
    // the page's own content, so content that escapes main — or chrome that
    // loses its landmarks — fails here too.
    //
    // The rule exempts the shell's skip link, which sits ahead of the header so
    // a keyboard reaches the content without traversing the chrome — but it
    // exempts that one node under a narrow test, which isThePagesSkipLink
    // reproduces rather than a blanket exemption for anything wearing the class.
    const stray = Array.from(document.querySelectorAll(".app-shell *")).filter(
      (element) =>
        !isThePagesSkipLink(element) &&
        element.closest(LANDMARK_SELECTOR) === null &&
        (element.textContent ?? "").trim().length > 0,
    );

    expect(
      stray.map((element) => `${element.tagName.toLowerCase()}.${element.className}`),
      "text rendered outside every landmark: the region violation issue 908 names",
    ).toEqual([]);
  });

  it("points the skip link at the main it renders", async () => {
    await renderNotFound();

    const skipLink = document.querySelector("a.skip-link");
    expect(skipLink, "the shell renders its skip link").not.toBeNull();
    const href = skipLink!.getAttribute("href");
    expect(href).toBe("#main-content");
    // ...and the fragment it names resolves, in this document, to that main.
    expect(document.querySelector(href!)).toBe(document.querySelector("main"));
  });

  it("offers a way back to the public entry from its own main", async () => {
    await renderNotFound();

    // Scoped to main, not the document: PublicAppShell's wordmark links "/"
    // on every page it wraps, so a document-wide query would pass with the
    // page's own way out deleted — and the way out is the one thing a reader
    // who reached a dead address depends on.
    const main = document.querySelector("main");
    expect(main, "the not-found page supplies its own main").not.toBeNull();
    const home = main!.querySelector('a[href="/"]');
    expect(home, "the not-found content links back to the public entry").not.toBeNull();
    expect(home, "the way out is one a reader can see").toBeVisible();
  });

  it("keeps every internal link on a page route", async () => {
    await renderNotFound();

    const routes = new Set(
      readdirSync(resolve(process.cwd(), "src/app"), { recursive: true })
        .map(String)
        .filter((path) => path.endsWith("page.tsx"))
        .map((path) => {
          const directory = path.slice(0, -"page.tsx".length).replace(/\/+$/, "");
          return directory === "" ? "/" : `/${directory}`;
        }),
    );
    // The build writes this file into the dist dir; its route serves the URL,
    // and the shell footer links it from every page.
    routes.add("/third-party-notices.txt");

    const internal = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/") && !href.startsWith("//"));

    expect(internal.length).toBeGreaterThan(0);
    expect(internal.filter((href) => !routes.has(href))).toEqual([]);
  });
});
