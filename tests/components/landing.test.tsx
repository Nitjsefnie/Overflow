/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
// and wrapped to four lines, so the button's bottom edge landed at 897px (that
// exact figure from about 1333px wide up; 891px at 1280) and the page needed a
// viewport that tall to show the button at all. Measured in headless Chromium,
// the stylesheet pinned below brings the minimum clearing viewport height to
// 572px, bisected at 1920, 1440, 1366 and 1280 and constant from 1037 up
// (571px at 1024, 553px at 800). A 1366x768 laptop panel gives Chrome roughly
// 625px of viewport once its chrome and a taskbar are subtracted, which is the
// case the first fix missed.
//
// The 96px hero ceiling is a design decision, not a layout constraint. The wrap
// stays at three lines all the way down to the 56px floor, because the h1's
// measure is 13ch and scales with the type wherever the ceiling binds (at
// 800px wide and up; below that the container binds instead). A 4rem ceiling
// measures a 472px clearing height. 96px buys the hero its presence, and 572px
// already clears every common laptop viewport.
//
// WHAT THIS GUARD IS. jsdom does no layout, so nothing here can measure where
// the button lands - the browser measurement is the evidence and these
// assertions are its preconditions. jsdom does resolve the cascade, clamp() and
// vw against window.innerWidth, so the walk below reads what the browser would
// resolve, at four widths covering every band of the three clamps.
//
// WHAT IT IS NOT. It is not a fold check, and it cannot become one here:
//   - it cannot see line counts, so a copy change moves the fold silently;
//   - it covers the elements that stack above the button and no others;
//   - it covers the computed properties listed below and no others - notably
//     jsdom reports every border width as 16px, so a border inside a shorthand
//     carrying var() is invisible;
//   - it cannot evaluate a media, supports or container condition, so those are
//     pinned as declarations instead of resolved;
//   - it cannot see a construct jsdom's parser drops, so those are refused
//     rather than passed;
//   - it cannot tell a term declared as one of jsdom's unset readings (0, auto,
//     none, normal, 16px) from one nobody declared, so a term dropped to one of
//     those reads as absent - every such value is one that cannot lower the
//     button, but it is not a distinction this guard makes;
//   - it cannot follow a term respelled with a logical property, and says so
//     rather than passing it.
// Overflow issue 111 tracks the real fix, which is a browser in CI.
type SubtreeElement = "page" | "hero" | "eyebrow" | "h1" | "lede" | "form" | "button";

// Every property that can move the button down: the vertical stack itself, the
// width available for wrapping, and the text metrics that decide how many lines
// the wrap takes.
const LAYOUT_PROPERTIES = [
  "display", "box-sizing",
  "margin-top", "margin-bottom", "margin-left", "margin-right",
  "padding-top", "padding-bottom", "padding-left", "padding-right",
  "border-top-width", "border-bottom-width", "border-left-width", "border-right-width",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "font-family", "font-size", "font-weight", "line-height",
  "letter-spacing", "word-spacing", "text-transform", "white-space",
];

// jsdom keeps the logical properties as separate, half-resolved values: it
// returns margin-block-start in px but padding-block as its unresolved source
// text, and never maps either onto the physical box above. So they are pinned
// alongside it: respelling a term logically empties its physical key and fills
// a logical one, which reads as two changed entries rather than as silence.
const LOGICAL_PROPERTIES = [
  "padding-block", "padding-block-start", "padding-block-end",
  "padding-inline", "padding-inline-start", "padding-inline-end",
  "margin-block", "margin-block-start", "margin-block-end",
  "margin-inline", "margin-inline-start", "margin-inline-end",
  "inline-size", "block-size", "min-inline-size", "min-block-size",
  "max-inline-size", "max-block-size",
  "border-block-start-width", "border-block-end-width",
  "border-inline-start-width", "border-inline-end-width",
];

const BUDGET_PROPERTIES = [...LAYOUT_PROPERTIES, ...LOGICAL_PROPERTIES];

// What jsdom reports when nothing has been declared: 16px is both its `medium`
// border width and this document's root font size. Values in this set are left
// out of the snapshot, so a term that acquires one is a new key rather than a
// changed one - which the comparison still catches.
const UNSET = new Set(["", "0", "0px", "auto", "none", "normal", "16px"]);

const SNAPSHOT_HEIGHT = 800;
const BASE_WIDTH = 1440;

// Resolved at 1440px wide, where all three clamps sit at their ceilings.
const AT_BASE_WIDTH: Record<string, string> = {
  "page display": "grid",
  "page box-sizing": "border-box",
  "page padding-top": "40px",
  "page padding-bottom": "40px",
  "page width": "min(100% - 2rem, 1180px)",
  "page min-height": "800px",
  "page font-family": "Arial, Helvetica, sans-serif",
  "page line-height": "1.5",
  "hero display": "block",
  "hero box-sizing": "border-box",
  "hero max-width": "928px",
  "hero font-family": "Arial, Helvetica, sans-serif",
  "hero line-height": "1.5",
  "eyebrow display": "block",
  "eyebrow box-sizing": "border-box",
  "eyebrow margin-bottom": "11.2px",
  // jsdom's UA stylesheet gives p and h1 a logical margin. It is dormant under
  // the physical margins above, and pinned so that a change to it is visible.
  "eyebrow margin-block": "1em",
  "eyebrow font-family": "var(--mono)",
  "eyebrow font-size": "11.52px",
  "eyebrow font-weight": "800",
  "eyebrow line-height": "1.5",
  "eyebrow letter-spacing": "0.2304px",
  "eyebrow text-transform": "uppercase",
  "h1 display": "block",
  "h1 box-sizing": "border-box",
  "h1 max-width": "624px",
  "h1 font-family": "var(--display)",
  "h1 font-size": "96px",
  "h1 font-weight": "bold",
  "h1 line-height": "1.05",
  "h1 letter-spacing": "-4.32px",
  "h1 margin-block": "0.67em",
  "lede display": "block",
  "lede box-sizing": "border-box",
  "lede margin-bottom": "28.8px",
  "lede margin-block": "1em",
  "lede max-width": "728px",
  "lede font-family": "var(--display)",
  "lede font-size": "28px",
  "lede line-height": "1.5",
  "form display": "block",
  "form box-sizing": "border-box",
  "form font-family": "Arial, Helvetica, sans-serif",
  "form line-height": "1.5",
  "button display": "inline-flex",
  "button box-sizing": "border-box",
  "button margin-top": "24px",
  "button padding-top": "10.4px",
  "button padding-bottom": "10.4px",
  "button min-height": "44.8px",
  "button font-family": "Arial, Helvetica, sans-serif",
  "button font-weight": "850",
  "button line-height": "1.5",
};

// The only terms that may differ at another width are the viewport-dependent
// ones. 390px is the type floor, 600px the vw band, 1024px the width where the
// lede's own vw term still binds while the hero's ceiling already does.
// Everything absent from these tables must resolve exactly as it does at 1440.
const AT_OTHER_WIDTHS: Record<number, Record<string, string>> = {
  390: {
    "page padding-top": "32px",
    "page padding-bottom": "32px",
    "h1 max-width": "364px",
    "h1 font-size": "56px",
    "h1 letter-spacing": "-2.52px",
    "lede max-width": "520px",
    "lede font-size": "20px",
  },
  600: {
    "h1 max-width": "468px",
    "h1 font-size": "72px",
    "h1 letter-spacing": "-3.24px",
    "lede max-width": "520px",
    "lede font-size": "20px",
  },
  1024: {
    "lede max-width": "718.848px",
    "lede font-size": "27.648px",
  },
};

// jsdom applies no condition, so a conditional declaration is pinned as text
// rather than resolved. This one narrows the page's gutter on small screens and
// was measured to move the button up, never down.
const CONDITIONAL_OVERRIDES = [
  "page | (max-width: 520px) | .app-shell, .landing-page | width: min(100% - 1.2rem, 1180px)",
];

type ParsedRule = { selectorText: string; condition: string | null; style: CSSStyleDeclaration; cssText: string };

function landingSubtree(): Array<[SubtreeElement, Element]> {
  const button = screen.getByRole("button", { name: "Sign in with GitHub" });
  const form = button.closest("form");
  if (!form) throw new Error("the sign-in button is no longer inside a form");
  return [
    ["page", document.querySelector("main.landing-page")!],
    ["hero", document.querySelector(".landing-hero")!],
    ["eyebrow", document.querySelector(".landing-hero .eyebrow")!],
    ["h1", screen.getByRole("heading", { level: 1 })],
    ["lede", document.querySelector(".landing-lede")!],
    ["form", form],
    ["button", button],
  ];
}

// A fresh mount per width: jsdom resolves vw live from innerWidth, but memoises
// the computed declaration per element (document._styleCache), so re-reading an
// element already read at another width returns the earlier answer.
function withLandingPageAt<T>(width: number, read: (sheet: CSSStyleSheet) => T): T {
  const previousWidth = window.innerWidth;
  const previousHeight = window.innerHeight;
  window.innerWidth = width;
  window.innerHeight = SNAPSHOT_HEIGHT;
  const style = document.createElement("style");
  style.textContent = readFileSync("src/app/globals.css", "utf8");
  document.head.append(style);
  try {
    render(<LandingPage />);
    return read(style.sheet!);
  } finally {
    cleanup();
    style.remove();
    window.innerWidth = previousWidth;
    window.innerHeight = previousHeight;
  }
}

function snapshotSubtree(): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [label, element] of landingSubtree()) {
    const computed = getComputedStyle(element);
    for (const property of BUDGET_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (!UNSET.has(value)) resolved[`${label} ${property}`] = value;
    }
  }
  return resolved;
}

function conditionOf(rule: CSSRule): string {
  const media = (rule as CSSMediaRule).media?.mediaText;
  return media || (rule as CSSConditionRule).conditionText || rule.cssText.split("{")[0].trim();
}

function parsedRules(sheet: CSSStyleSheet): { styleRules: ParsedRule[]; atRuleNames: string[] } {
  const styleRules: ParsedRule[] = [];
  const atRuleNames: string[] = [];
  const walk = (rules: CSSRuleList, condition: string | null) => {
    for (const rule of Array.from(rules)) {
      const styleRule = rule as CSSStyleRule;
      if (typeof styleRule.selectorText === "string") {
        styleRules.push({
          selectorText: styleRule.selectorText.replace(/\s+/g, " "),
          condition,
          style: styleRule.style,
          cssText: styleRule.cssText,
        });
        continue;
      }
      atRuleNames.push(/^@([a-z-]+)/.exec(rule.cssText)?.[1] ?? rule.constructor.name);
      const grouping = rule as CSSGroupingRule;
      if (grouping.cssRules) walk(grouping.cssRules, conditionOf(rule));
    }
  };
  walk(sheet.cssRules, null);
  return { styleRules, atRuleNames };
}

function appliesTo(element: Element, rule: ParsedRule): boolean {
  try {
    return element.matches(rule.selectorText);
  } catch {
    // Refuse to classify rather than assume it does not apply.
    throw new Error(
      `the fold budget cannot evaluate the selector "${rule.selectorText}"; measure the fold in a ` +
        "browser and teach this guard the new shape",
    );
  }
}

describe("landing hero fold budget", () => {
  it.each([BASE_WIDTH, 390, 600, 1024])(
    "resolves the stack above the sign-in button to the measured values at %ipx wide",
    (width) => {
      const resolved = withLandingPageAt(width, snapshotSubtree);
      const expected = { ...AT_BASE_WIDTH, ...(AT_OTHER_WIDTHS[width] ?? {}) };

      // Named separately, because the bare diff would read as a term that moved
      // when what happened is that the guard stopped being able to see it.
      expect
        .soft(
          Object.keys({ ...resolved, ...expected }).filter(
            (key) =>
              LOGICAL_PROPERTIES.some((property) => key.endsWith(` ${property}`)) &&
              resolved[key] !== expected[key],
          ),
          "a term spelled with a logical property, which jsdom does not map onto the physical box this " +
            "guard reads; measure the fold in a browser, then spell it physically or teach this guard " +
            "to resolve it",
        )
        .toEqual([]);
      expect(resolved, `computed box model of the landing hero at ${width}px wide`).toEqual(expected);
    },
  );

  it("declares no unpinned override behind a condition jsdom cannot evaluate", () => {
    const found = withLandingPageAt(BASE_WIDTH, (sheet) => {
      const subtree = landingSubtree();
      return parsedRules(sheet)
        .styleRules.filter((rule) => rule.condition !== null)
        .flatMap((rule) =>
          Array.from(rule.style)
            .filter((property) => BUDGET_PROPERTIES.includes(property))
            .flatMap((property) =>
              subtree
                .filter(([, element]) => appliesTo(element, rule))
                .map(
                  ([label]) =>
                    `${label} | ${rule.condition} | ${rule.selectorText} | ${property}: ${rule.style.getPropertyValue(property)}`,
                ),
            ),
        );
    });

    expect(
      found,
      "a conditional declaration reaching the hero: jsdom applies no condition, so measure the fold " +
        "in a browser at the widths this applies to and pin it in CONDITIONAL_OVERRIDES",
    ).toEqual(CONDITIONAL_OVERRIDES);
  });

  it("refuses a rule jsdom's CSS parser did not fully understand", () => {
    const { unparsed, atRuleNames } = withLandingPageAt(BASE_WIDTH, (sheet) => {
      const { styleRules, atRuleNames: names } = parsedRules(sheet);
      return {
        // A brace left inside a declaration block is source jsdom kept verbatim
        // instead of turning into declarations - the signature of CSS nesting
        // and of anything else its parser is older than.
        unparsed: styleRules
          .filter((rule) => rule.cssText.slice(rule.cssText.indexOf("{")).includes("{", 1))
          .map((rule) => `${rule.selectorText} { ${rule.cssText.replace(/\s+/g, " ").slice(0, 120)} }`),
        atRuleNames: names,
      };
    });

    expect(
      unparsed,
      "jsdom kept this rule's block as text instead of declarations, so neither the resolved read nor " +
        "the conditional pin can see inside it; measure the fold in a browser and express the rule in " +
        "CSS this toolchain parses",
    ).toEqual([]);
    expect(
      atRuleNames,
      "an at-rule in the stylesheet that jsdom did not parse into the CSSOM, or a new one to pin; the " +
        "browser may apply what jsdom silently dropped, so measure the fold before changing this list",
    ).toEqual([...(readFileSync("src/app/globals.css", "utf8").matchAll(/^[ \t]*@([a-z-]+)/gm))].map((match) => match[1]));
  });
});
