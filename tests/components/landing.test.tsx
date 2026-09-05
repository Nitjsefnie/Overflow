/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const signIn = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ signIn }));

import { LandingPage } from "@/app/page";

describe("landing page", () => {
  afterEach(() => {
    signIn.mockReset();
  });

  it("submits GitHub sign-in through a server action", async () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: "Cooperative credit for open-source work." })).toBeVisible();
    const signInButton = screen.getByRole("button", { name: "Sign in with GitHub" });
    expect(signInButton.closest("form")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).not.toBeInTheDocument();
    fireEvent.click(signInButton);

    await waitFor(() => expect(signIn).toHaveBeenCalledWith("github"));
  });

  it("does not render a noninteractive landing mark", () => {
    const { container } = render(<LandingPage />);

    expect(container.querySelector(".landing-mark")).toBeNull();
  });

  it("does not present churn as a member metric", () => {
    render(<LandingPage />);

    expect(screen.queryByText(/churn/i)).not.toBeInTheDocument();
  });
});

// Issue 39: the sign-in button, the only control on the signed-out landing page,
// sat below the fold. The hero h1 held its clamp ceiling at every desktop width
// and wrapped to four lines, so the button's bottom edge landed at a fixed 897px
// and the page needed a viewport 897px tall to show it. Measured in headless
// Chromium, the values pinned below bring that to 572px - the minimum viewport
// height that clears the button at every width from 1280 up, bisected at 1920,
// 1440, 1366 and 1280 (571px at 1024, 553px at 800). A 1366x768 laptop panel
// gives Chrome roughly 625px of viewport once its chrome and a taskbar are
// subtracted, and that is the case the first fix still missed.
//
// jsdom does no layout, so nothing here can measure where the button lands; the
// browser measurement is the evidence and these assertions are the guard that
// the inputs to it stay put. jsdom does resolve the cascade, clamp() and vw, at
// one fixed 1024px viewport - so every term below is read the way the browser
// resolves it, not parsed out of the source text.
type LandingElement = "page" | "hero" | "eyebrow" | "h1" | "lede" | "button";

type BudgetTerm = {
  term: string;
  element: LandingElement;
  property: string;
  // Resolved by jsdom at its fixed 1024px viewport, in px.
  atMost?: number;
  atLeast?: number;
  // A clamp() ceiling only binds above 1024px, so it needs its own bound, in px.
  ceilingAtMost?: number;
  // A text measure jsdom resolves with its own ch metric, so it is pinned as declared.
  atLeastCh?: number;
};

// Every term the button's y position sums, with what each contributes at 1440x800.
const FOLD_BUDGET: BudgetTerm[] = [
  { term: "page block padding", element: "page", property: "padding-top", atMost: 40, ceilingAtMost: 40 },
  { term: "hero measure", element: "hero", property: "max-width", atLeast: 928 },
  { term: "eyebrow type", element: "eyebrow", property: "font-size", atMost: 11.52 },
  { term: "eyebrow leading", element: "eyebrow", property: "line-height", atMost: 17.28 },
  { term: "eyebrow to headline", element: "eyebrow", property: "margin-bottom", atMost: 11.2 },
  { term: "headline type", element: "h1", property: "font-size", atMost: 96, ceilingAtMost: 96 },
  { term: "headline leading", element: "h1", property: "line-height", atMost: 100.8 },
  { term: "headline measure", element: "h1", property: "max-width", atLeastCh: 13 },
  { term: "headline to lede", element: "h1", property: "margin-bottom", atMost: 16 },
  { term: "lede type", element: "lede", property: "font-size", atMost: 27.648, ceilingAtMost: 28 },
  { term: "lede leading", element: "lede", property: "line-height", atMost: 41.472 },
  { term: "lede measure", element: "lede", property: "max-width", atLeastCh: 52 },
  { term: "lede to button", element: "lede", property: "margin-bottom", atMost: 28.8 },
  { term: "button offset", element: "button", property: "margin-top", atMost: 24 },
  { term: "button height", element: "button", property: "min-height", atMost: 44.8 },
  { term: "button padding", element: "button", property: "padding-top", atMost: 10.4 },
  { term: "button type", element: "button", property: "font-size", atMost: 16 },
  { term: "button leading", element: "button", property: "line-height", atMost: 24 },
];

const UNCONDITIONAL = "unconditional";

type Declaration = { selectorText: string; condition: string; property: string; value: string };

function mountLandingPage() {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/app/globals.css", "utf8");
  document.head.append(style);
  render(<LandingPage />);
  const elements: Record<LandingElement, Element> = {
    page: document.querySelector("main.landing-page")!,
    hero: document.querySelector(".landing-hero")!,
    eyebrow: document.querySelector(".landing-hero .eyebrow")!,
    h1: screen.getByRole("heading", { level: 1 }),
    lede: document.querySelector(".landing-lede")!,
    button: screen.getByRole("button", { name: "Sign in with GitHub" }),
  };
  return { sheet: style.sheet!, elements, unmount: () => style.remove() };
}

function conditionOf(rule: CSSRule): string {
  const media = (rule as CSSMediaRule).media?.mediaText;
  return media || (rule as CSSConditionRule).conditionText || rule.cssText.split("{")[0].trim();
}

// Every declaration of a wanted property anywhere in the sheet, including inside
// at-rules, read through the CSS parser rather than a regex over the source.
function collectDeclarations(sheet: CSSStyleSheet, wanted: (property: string) => boolean): Declaration[] {
  const found: Declaration[] = [];
  const walk = (rules: CSSRuleList, condition: string) => {
    for (const rule of Array.from(rules)) {
      const styleRule = rule as CSSStyleRule;
      if (typeof styleRule.selectorText !== "string") {
        const grouping = rule as CSSGroupingRule;
        if (grouping.cssRules) walk(grouping.cssRules, conditionOf(rule));
        continue;
      }
      for (const property of Array.from(styleRule.style)) {
        if (!wanted(property)) continue;
        found.push({
          selectorText: styleRule.selectorText,
          condition,
          property,
          value: styleRule.style.getPropertyValue(property),
        });
      }
    }
  };
  walk(sheet.cssRules, UNCONDITIONAL);
  return found;
}

function appliesTo(element: Element, declaration: Declaration): boolean {
  try {
    return element.matches(declaration.selectorText);
  } catch {
    // Refuse to classify rather than assume it does not apply.
    throw new Error(
      `the fold budget cannot evaluate the selector "${declaration.selectorText}", which declares ` +
        `${declaration.property}; measure the fold in a browser and teach this guard the new shape`,
    );
  }
}

const ROOT_FONT_SIZE = 16;

function toPixels(value: string, fontSizePx: number, term: string): number {
  const trimmed = value.trim();
  const number = Number.parseFloat(trimmed);
  if (Number.isNaN(number)) throw new Error(`${term}: "${value}" is not a length the fold budget can read`);
  if (trimmed.endsWith("px")) return number;
  if (trimmed.endsWith("rem")) return number * ROOT_FONT_SIZE;
  if (/^-?[\d.]+$/.test(trimmed)) return number * fontSizePx; // a unitless line-height
  throw new Error(
    `${term}: "${value}" resolves in a unit this guard does not read; re-measure the fold in a ` +
      "browser and pin the term in px",
  );
}

// The last argument of a clamp(), which is the value every viewport wider than
// jsdom's own gets. Anything else is reported rather than silently skipped.
function clampCeiling(value: string): string | null {
  const inner = /^clamp\((.*)\)$/s.exec(value.trim());
  if (!inner) return null;
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of inner[1]) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  if (parts.length !== 3) throw new Error(`cannot read the ceiling of "${value}"`);
  return parts[2].trim();
}

describe("landing hero fold budget", () => {
  it("resolves every term of the budget within what the browser measured", () => {
    const { elements, unmount } = mountLandingPage();
    try {
      for (const term of FOLD_BUDGET) {
        if (term.atMost === undefined && term.atLeast === undefined) continue;
        const element = elements[term.element];
        const style = getComputedStyle(element);
        const fontSize = Number.parseFloat(style.fontSize);
        const raw = style.getPropertyValue(term.property);
        const label = `${term.term} (${term.element} ${term.property}, resolved from "${raw}")`;
        const pixels = Math.round(toPixels(raw, fontSize, label) * 1000) / 1000;
        // Soft, so one run names every term that moved rather than only the first.
        if (term.atMost !== undefined) expect.soft(pixels, label).toBeLessThanOrEqual(term.atMost);
        if (term.atLeast !== undefined) expect.soft(pixels, label).toBeGreaterThanOrEqual(term.atLeast);
      }
    } finally {
      unmount();
    }
  });

  it("keeps every declared ceiling and text measure within the budget", () => {
    const { sheet, elements, unmount } = mountLandingPage();
    try {
      expect(getComputedStyle(document.documentElement).fontSize, "root font size assumed by rem terms").toBe(
        `${ROOT_FONT_SIZE}px`,
      );
      for (const term of FOLD_BUDGET) {
        if (term.ceilingAtMost === undefined && term.atLeastCh === undefined) continue;
        const element = elements[term.element];
        const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
        const declarations = collectDeclarations(sheet, (property) => property === term.property).filter(
          (declaration) => appliesTo(element, declaration),
        );
        expect(declarations.length, `${term.term}: declarations of ${term.property}`).toBeGreaterThan(0);
        for (const declaration of declarations) {
          const label = `${term.term} declared by "${declaration.selectorText}" as "${declaration.value}"`;
          if (term.ceilingAtMost !== undefined) {
            const ceiling = clampCeiling(declaration.value);
            const widest = ceiling === null ? declaration.value : ceiling;
            expect.soft(toPixels(widest, fontSize, label), label).toBeLessThanOrEqual(term.ceilingAtMost);
          }
          if (term.atLeastCh !== undefined) {
            expect.soft(declaration.value.trim(), label).toMatch(/^[\d.]+ch$/);
            expect.soft(Number.parseFloat(declaration.value), label).toBeGreaterThanOrEqual(term.atLeastCh);
          }
        }
      }
    } finally {
      unmount();
    }
  });

  // jsdom resolves the cascade at one viewport width, so a term hidden behind a
  // media condition is invisible to the two tests above however wrong it is.
  it("declares no term of the budget behind a media condition", () => {
    const { sheet, elements, unmount } = mountLandingPage();
    try {
      const budgeted = new Set(FOLD_BUDGET.map((term) => term.property));
      const conditional = collectDeclarations(sheet, (property) => budgeted.has(property)).filter(
        (declaration) => declaration.condition !== UNCONDITIONAL,
      );
      const offenders = conditional
        .filter((declaration) =>
          FOLD_BUDGET.some(
            (term) => term.property === declaration.property && appliesTo(elements[term.element], declaration),
          ),
        )
        .map((declaration) => `@media ${declaration.condition} { ${declaration.selectorText} { ${declaration.property}: ${declaration.value} } }`);

      expect(
        offenders,
        "a conditional override of a fold-budget term: measure the fold in a browser at the widths it " +
          "applies to, then pin it here",
      ).toEqual([]);
    } finally {
      unmount();
    }
  });
});
