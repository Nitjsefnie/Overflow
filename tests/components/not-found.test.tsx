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

/** The elements axe never counts as page content, however much text they hold. */
const NOT_PAGE_CONTENT = new Set(["script", "style", "noscript", "template"]);

/**
 * axe's reference anchor: `generateFirstPageLink` takes the first link that is
 * neither a `javascript:` href nor one `_isCurrentPageLink`, and that predicate
 * is true for every href starting with "#". A fragment link — which is what a
 * skip link is — can therefore never BE the anchor, and never loses its
 * exemption to a link placed ahead of it.
 */
function firstPageLink(): Element | undefined {
  return Array.from(document.querySelectorAll("a[href]")).find((candidate) => {
    const href = candidate.getAttribute("href") ?? "";
    return !/^javascript:/i.test(href) && !href.startsWith("#");
  });
}

/**
 * axe-core's region rule keeps a node out of its regionless list when
 * `_isSkipLink(node) && getElementByReference(node, 'href')`: the link must
 * resolve onto an element of this document, and must not be the page's own
 * reference anchor. That is the test modelled here, and the anchor it is
 * measured against is the one above — NOT "the first a[href] in the document",
 * which is the earlier version's mistake and which cost the skip link its
 * exemption as soon as any link preceded it, including a link inside a nav that
 * axe accepts outright.
 *
 * The `skip-link` class is the handle on the shell's own chrome, not part of
 * axe's rule: it keeps this exemption narrower than axe, so a stray element
 * wearing the class elsewhere is still counted.
 */
function isThePagesSkipLink(element: Element): boolean {
  if (!element.classList.contains("skip-link") || element.tagName.toLowerCase() !== "a") {
    return false;
  }
  // getElementByReference resolves an href by id first and falls back to the
  // name attribute. Reading the fragment by hand is what keeps a malformed one
  // (`href="#a b"`, which querySelector throws on) a failed assertion here
  // rather than a TypeError out of the walk.
  const href = element.getAttribute("href") ?? "";
  const reference = href.startsWith("#") ? href.slice(1) : href;
  if (reference === "") {
    return false;
  }
  const target = document.getElementById(reference) ?? document.getElementsByName(reference)[0] ?? null;
  return target !== null && element !== firstPageLink();
}

/**
 * Whether the element carries text of its own. axe flags content — the element
 * a text node hangs off — not the wrappers that merely contain it, so a div
 * whose every child is already inside a landmark is not itself regionless. It
 * also keeps the walk free of the test renderer's own container, which wraps
 * the whole page and holds all of its text without being page content.
 */
function carriesOwnText(element: Element): boolean {
  return Array.from(element.childNodes).some(
    (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim().length > 0,
  );
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
    // landmarks. The walk covers the whole document rather than the shell, so
    // content rendered outside .app-shell is caught too — the shell-scoped
    // version was the one place this file was narrower than the rule it models,
    // and narrower is the direction that misses defects. Body itself is the
    // walk's root: it holds every string on the page and is not content.
    //
    // The rule exempts the shell's skip link, which sits ahead of the header so
    // a keyboard reaches the content without traversing the chrome, under the
    // narrow test isThePagesSkipLink models — not a blanket exemption for
    // anything wearing the class.
    const stray = Array.from(document.body.querySelectorAll("*")).filter(
      (element) =>
        !NOT_PAGE_CONTENT.has(element.tagName.toLowerCase()) &&
        !isThePagesSkipLink(element) &&
        element.closest(LANDMARK_SELECTOR) === null &&
        carriesOwnText(element),
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
