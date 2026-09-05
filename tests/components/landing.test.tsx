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
// figure from about 1333px wide up; 891px at 1280) and the page needed a
// viewport that tall to show the button at all. Measured in headless Chromium,
// the shipped stylesheet brings the minimum clearing viewport height to 572px,
// bisected at 1920, 1440, 1366 and 1280 and constant from 1037 up (571px at
// 1024, 553px at 800). A 1366x768 laptop panel gives Chrome roughly 625px of
// viewport once its chrome and a taskbar are subtracted.
//
// The 96px hero ceiling is a design decision, not a layout constraint. The wrap
// stays at three lines all the way down to the 56px floor, because the h1's
// measure is 13ch and scales with the type wherever the ceiling binds (at 800px
// wide and up; below that the container binds instead). A 4rem ceiling measures
// a 472px clearing height. 96px buys the hero its presence.
//
// WHAT THIS GUARD IS. A proxy. jsdom does no layout, so nothing here can measure
// where the button lands - the browser measurement above is the evidence, and
// these are bounds on the terms it rests on. Every one is an upper bound on
// something that pushes the button down, or a lower bound on a measure that
// narrowing would wrap into more lines: raising one is a deliberate act, not a
// number to copy across from a diff. jsdom resolves the cascade, clamp() and vw
// against window.innerWidth, so the bounds are read at 1440px, where all three
// clamps sit at their ceilings, and 390px, where all three sit at their floors.
//
// WHAT IT IS NOT, in full. It is not a fold check, and cannot become one here -
// Overflow issue 111 tracks the real fix, which is a browser in CI.
//   - It cannot see line counts, so a copy change moves the fold silently.
//   - It cannot see the type faces: the h1's wrap depends on the metrics behind
//     var(--display), and pinning a font stack would be an equality, not a bound.
//   - It covers the elements that stack above the button and no others, and the
//     properties in the table below and no others.
//   - The button's border is invisible in two spellings, both measured. jsdom
//     reports `medium`, which is 16px, for a width nobody declared, so a width
//     of 16px or less cannot be told from an absent one
//     (border-bottom-width: 1rem takes the button from 49px to 63px tall); and
//     it cannot parse a shorthand carrying var(), which is how this button's
//     own border is written, so a border set the same way is equally invisible
//     (border: 3rem solid var(--line) takes it to 141px). Everywhere else the
//     bound is on the effective border - the width, or zero where the style is
//     none - which is exact, because a width declared without a style occupies
//     no space in a browser either (measured: border-top-width: 3rem on the
//     hero leaves the button where it is).
//   - Six properties that reach these elements are not bounded at all.
//     font-weight and word-spacing were measured not to move the button here -
//     Georgia has no 900 weight and the headline's wrap is measure-bound - so
//     bounding them would only manufacture a red for a change that renders
//     identically. white-space and text-wrap have values that could matter and
//     an ordering this guard cannot establish by measurement. display and
//     font-family would each have to be pinned as an equality, which is the
//     thing this table exists not to be.
//   - It cannot evaluate a media, supports or container condition; those are
//     pinned as declarations instead. A @layer block is exempt, because an
//     unlayered declaration always beats a layered one and nothing here is
//     layered - which stops holding the day anything is.
//   - It cannot see an at-rule jsdom's parser drops entirely, and does not try.
//   - It reads one stylesheet, and refuses an @import rather than pretend to
//     follow it.
type SubtreeElement = "page" | "hero" | "eyebrow" | "h1" | "lede" | "form" | "button";

// element, property, direction, and the bound at 1440px and at 390px - the
// values the browser measurement above was taken over. Infinity is `none` or
// `auto`: an unconstrained measure cannot wrap the text into another line.
type BudgetRow = [SubtreeElement, string, "atMost" | "atLeast", number, number];

const FOLD_BUDGET: BudgetRow[] = [
  // The page's own box, and the type it hands down: the button takes its font
  // from here through `button, input, textarea { font: inherit }`. Its
  // padding-bottom and border-bottom sit below the whole stack, so they are
  // absent here rather than pinned at a value nothing can violate.
  ["page", "margin-top", "atMost", 0, 0],
  ["page", "padding-top", "atMost", 40, 32],
  ["page", "border-top", "atMost", 0, 0],
  ["page", "font-size", "atMost", 16, 16],
  ["page", "line-height", "atMost", 24, 24],
  // The hero, whose max-width is the headline's wrap measure above ~102px of type.
  ["hero", "margin-top", "atMost", 0, 0],
  ["hero", "padding-top", "atMost", 0, 0],
  ["hero", "border-top", "atMost", 0, 0],
  ["hero", "line-height", "atMost", 24, 24],
  ["hero", "max-width", "atLeast", 928, 928],
  // The eyebrow: one line of type, the box around it, and the space between it
  // and the headline.
  ["eyebrow", "margin-top", "atMost", 0, 0],
  ["eyebrow", "margin-bottom", "atMost", 11.2, 11.2],
  ["eyebrow", "padding-top", "atMost", 0, 0],
  ["eyebrow", "padding-bottom", "atMost", 0, 0],
  ["eyebrow", "border-top", "atMost", 0, 0],
  ["eyebrow", "border-bottom", "atMost", 0, 0],
  ["eyebrow", "font-size", "atMost", 11.52, 11.52],
  ["eyebrow", "line-height", "atMost", 17.28, 17.28],
  ["eyebrow", "letter-spacing", "atMost", 0.2304, 0.2304],
  ["eyebrow", "text-transform", "atMost", 2, 2],
  ["eyebrow", "width", "atLeast", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  ["eyebrow", "max-width", "atLeast", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  // The headline: three lines at every width, and every term that decides it.
  ["h1", "margin-top", "atMost", 0, 0],
  ["h1", "margin-bottom", "atMost", 16, 16],
  ["h1", "padding-top", "atMost", 0, 0],
  ["h1", "padding-bottom", "atMost", 0, 0],
  ["h1", "border-top", "atMost", 0, 0],
  ["h1", "border-bottom", "atMost", 0, 0],
  ["h1", "font-size", "atMost", 96, 56],
  ["h1", "line-height", "atMost", 100.8, 58.8],
  ["h1", "letter-spacing", "atMost", -4.32, -2.52],
  ["h1", "text-transform", "atMost", 0, 0],
  ["h1", "width", "atLeast", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  ["h1", "max-width", "atLeast", 624, 364],
  // The lede: two lines at 1440, four at 390.
  ["lede", "margin-top", "atMost", 0, 0],
  ["lede", "margin-bottom", "atMost", 28.8, 28.8],
  ["lede", "padding-top", "atMost", 0, 0],
  ["lede", "padding-bottom", "atMost", 0, 0],
  ["lede", "border-top", "atMost", 0, 0],
  ["lede", "border-bottom", "atMost", 0, 0],
  ["lede", "font-size", "atMost", 28, 20],
  ["lede", "line-height", "atMost", 42, 30],
  ["lede", "letter-spacing", "atMost", 0, 0],
  ["lede", "text-transform", "atMost", 0, 0],
  ["lede", "width", "atLeast", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  ["lede", "max-width", "atLeast", 728, 520],
  // The form wrapping the button contributes nothing of its own today. Its
  // padding-bottom and border-bottom are below the button, so they are absent.
  ["form", "margin-top", "atMost", 0, 0],
  ["form", "padding-top", "atMost", 0, 0],
  ["form", "border-top", "atMost", 0, 0],
  ["form", "font-size", "atMost", 16, 16],
  ["form", "line-height", "atMost", 24, 24],
  // The button's own box: 49px tall, 24px below the lede. The raw widths are
  // bounded here as well as the effective borders, because the shipped
  // shorthand carries var() - jsdom reads no style through it, so a width-only
  // change to this element is one the browser uses and the effective bound
  // cannot see.
  ["button", "margin-top", "atMost", 24, 24],
  ["button", "padding-top", "atMost", 10.4, 10.4],
  ["button", "padding-bottom", "atMost", 10.4, 10.4],
  ["button", "border-top", "atMost", 0, 0],
  ["button", "border-bottom", "atMost", 0, 0],
  ["button", "border-top-width", "atMost", 16, 16],
  ["button", "border-bottom-width", "atMost", 16, 16],
  ["button", "min-height", "atMost", 44.8, 44.8],
  ["button", "box-sizing", "atMost", 0, 0],
  ["button", "font-size", "atMost", 16, 16],
  ["button", "line-height", "atMost", 24, 24],
];

// jsdom applies no condition, so a conditional declaration is pinned as text
// rather than resolved. This one narrows the page's gutter on small screens and
// was measured to move the button up, never down.
const CONDITIONAL_OVERRIDES = [
  "page | (max-width: 520px) | .app-shell, .landing-page | width: min(100% - 1.2rem, 1180px)",
];

// Two terms are keywords rather than lengths, so they are compared as a rank:
// a higher rank sets the text wider or the box taller, and an unlisted value is
// refused rather than guessed at.
const KEYWORD_RANKS: Record<string, Record<string, number>> = {
  "text-transform": { none: 0, lowercase: 0, capitalize: 1, uppercase: 2, "full-width": 3, "full-size-kana": 3 },
  "box-sizing": { "border-box": 0, "content-box": 1 },
};

// The synthetic terms above, and the border styles that occupy no space.
const EFFECTIVE_BORDERS: Record<string, string> = { "border-top": "border-top", "border-bottom": "border-bottom" };
const NO_BORDER = new Set(["none", "hidden", ""]);

const BASE_WIDTH = 1440;
const NARROW_WIDTH = 390;
const VIEWPORT_HEIGHT = 800;
const ROOT_FONT_SIZE = 16;

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
  window.innerHeight = VIEWPORT_HEIGHT;
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

function toPixels(
  value: string,
  fontSize: number,
  property: string,
  direction: "atMost" | "atLeast",
  term: string,
): number {
  const trimmed = value.trim();
  const ranks = KEYWORD_RANKS[property];
  if (ranks) {
    const rank = ranks[trimmed];
    if (rank === undefined) {
      throw new Error(
        `${term} resolves to "${value}", a value this guard has no ordering for; measure the fold in ` +
          "a browser and give it a rank",
      );
    }
    return rank;
  }
  // An unconstrained term is on the safe side of either bound: it imposes no
  // height of its own, and it wraps the text into no extra line. Reading it as
  // whichever end of the range the bound allows keeps a deleted measure or
  // minimum from failing, since removing one can only raise the button. It says
  // nothing about deleting a term that resolves to something else: dropping the
  // headline's negative tracking widens the text, and the bound catches it.
  if (trimmed === "none" || trimmed === "auto") {
    return direction === "atMost" ? 0 : Number.POSITIVE_INFINITY;
  }
  // `normal` is zero spacing; for anything else it is a value this cannot bound.
  if (trimmed === "normal" && property.endsWith("-spacing")) return 0;
  const number = Number.parseFloat(trimmed);
  if (!Number.isNaN(number)) {
    if (trimmed.endsWith("px")) return number;
    if (trimmed.endsWith("rem")) return number * ROOT_FONT_SIZE;
    if (/^-?[\d.]+$/.test(trimmed)) return number * fontSize; // a unitless line-height
  }
  throw new Error(
    `${term} resolves to "${value}", which this guard cannot compare; measure the fold in a browser ` +
      "and pin the term in px",
  );
}

function conditionOf(rule: CSSRule): string {
  const media = (rule as CSSMediaRule).media?.mediaText;
  return media || (rule as CSSConditionRule).conditionText || rule.cssText.split("{")[0].trim();
}

// Every style rule in the sheet, with the condition it sits under. A @layer
// block is walked as if unconditional: jsdom applies neither, and in a browser
// an unlayered declaration beats a layered one, so a layered rule cannot
// override anything this stylesheet declares.
function styleRules(sheet: CSSStyleSheet): { rules: ParsedRule[]; imports: string[] } {
  const rules: ParsedRule[] = [];
  const imports: string[] = [];
  const walk = (list: CSSRuleList, condition: string | null) => {
    for (const rule of Array.from(list)) {
      const styleRule = rule as CSSStyleRule;
      if (typeof styleRule.selectorText === "string") {
        rules.push({
          selectorText: styleRule.selectorText.replace(/\s+/g, " "),
          condition,
          style: styleRule.style,
          cssText: styleRule.cssText,
        });
        continue;
      }
      if (rule.constructor.name === "CSSImportRule") {
        imports.push(rule.cssText);
        continue;
      }
      const grouping = rule as CSSGroupingRule;
      if (grouping.cssRules) {
        walk(grouping.cssRules, rule.constructor.name === "CSSLayerBlockRule" ? condition : conditionOf(rule));
      }
    }
  };
  walk(sheet.cssRules, null);
  return { rules, imports };
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
  it.each([BASE_WIDTH, NARROW_WIDTH])(
    "keeps the stack above the sign-in button within the budget measured at %ipx wide",
    (width) => {
      // Read inside the mount: a CSSStyleDeclaration is live, and re-resolves to
      // the defaults once the stylesheet and the element are gone.
      const resolved = withLandingPageAt(width, () => {
        const values = new Map<SubtreeElement, Record<string, string>>();
        for (const [label, element] of landingSubtree()) {
          const computed = getComputedStyle(element);
          const read: Record<string, string> = { "font-size": computed.fontSize };
          for (const [owner, property] of FOLD_BUDGET) {
            if (owner !== label) continue;
            // A border only occupies space if it has a style, and jsdom reports
            // `medium` - 16px - for a width nobody declared. Reading the pair
            // together is what tells a declared 15px border from an absent one.
            const edge = EFFECTIVE_BORDERS[property];
            read[property] = edge
              ? NO_BORDER.has(computed.getPropertyValue(`${edge}-style`))
                ? "0px"
                : computed.getPropertyValue(`${edge}-width`)
              : computed.getPropertyValue(property);
          }
          values.set(label, read);
        }
        return values;
      });

      for (const [label, property, direction, atBase, atNarrow] of FOLD_BUDGET) {
        const computed = resolved.get(label)!;
        const raw = computed[property];
        const bound = width === BASE_WIDTH ? atBase : atNarrow;
        const term = `${label} ${property} at ${width}px wide (resolved from "${raw}")`;
        // Rounded, because a unitless line-height times a font size lands a
        // thousandth of a pixel above its own bound in binary floating point.
        const pixels =
          Math.round(toPixels(raw, Number.parseFloat(computed["font-size"]), property, direction, term) * 1000) / 1000;
        const hint = `${term}: raising this lowers the sign-in button, so measure the fold in a browser at ${width}x600 before changing the bound`;
        // Soft, so one run names every term that moved rather than only the first.
        if (direction === "atMost") expect.soft(pixels, hint).toBeLessThanOrEqual(bound);
        else expect.soft(pixels, hint).toBeGreaterThanOrEqual(bound);
      }
    },
  );

  it("declares no fold-budget term behind a condition jsdom cannot evaluate", () => {
    const budgeted = new Set(FOLD_BUDGET.map(([, property]) => property));
    const found = withLandingPageAt(BASE_WIDTH, (sheet) => {
      const subtree = landingSubtree();
      return styleRules(sheet)
        .rules.filter((rule) => rule.condition !== null)
        .flatMap((rule) =>
          Array.from(rule.style)
            .filter((property) => budgeted.has(property))
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
      "a conditional declaration reaching the hero: jsdom applies no condition, so measure the fold in " +
        "a browser at the widths this applies to and pin it in CONDITIONAL_OVERRIDES",
    ).toEqual(CONDITIONAL_OVERRIDES);
  });

  it("refuses a rule jsdom's CSS parser did not fully understand", () => {
    const unparsed = withLandingPageAt(BASE_WIDTH, (sheet) =>
      styleRules(sheet)
        .rules.filter((rule) => {
          // Everything jsdom kept for this rule, against everything it turned
          // into declarations. A construct it does not implement - CSS nesting
          // in any spelling, a nested at-rule - survives in one and not the
          // other. Comparing the two asks jsdom what it understood instead of
          // scanning the source for punctuation.
          const block = rule.cssText.slice(rule.cssText.indexOf("{") + 1, rule.cssText.lastIndexOf("}"));
          return block.trim() !== rule.style.cssText.trim();
        })
        .map((rule) => `${rule.selectorText} { ${rule.cssText.replace(/\s+/g, " ").slice(0, 120)} }`),
    );

    expect(
      unparsed,
      "jsdom kept part of this rule as text instead of declarations, so the bounds above cannot see " +
        "inside it; measure the fold in a browser and express the rule in CSS this toolchain parses",
    ).toEqual([]);
  });

  it("reads the whole stylesheet", () => {
    const imports = withLandingPageAt(BASE_WIDTH, (sheet) => styleRules(sheet).imports);

    expect(
      imports,
      "this guard reads src/app/globals.css and nothing else, and jsdom never fetches an @import while " +
        "the bundler inlines it; measure the fold in a browser, then either move these rules into " +
        "globals.css or teach this guard to follow the import",
    ).toEqual([]);
  });
});
