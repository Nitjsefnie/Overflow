import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The responsive header contract (issue 40).
 *
 * The header is a three-column grid on desktop and stacks at and below a
 * single measured breakpoint: the wordmark and the session controls share the
 * first row and the navigation spans the full width on the second row,
 * left-aligned. The breakpoint is not a free choice — the widest navigation
 * Overflow ships (the moderator variant, "Moderation" included) must fit on
 * one row above it — so it is pinned to the value measured by
 * `scripts/measure-header-geometry.mjs`, and changing it means re-measuring.
 *
 * Like tests/deploy/unit-file.test.ts this guard reads the shipped artifact
 * and holds it to a closed contract: one header breakpoint, its rules spelled
 * in full, the desktop grid intact as the base rule, and no second, stale
 * copy of the stacked pattern left behind.
 */

const stylesheet = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

type MediaBlock = { condition: string; body: string };

type Rule = { selector: string; declarations: Record<string, string> };

/** Strip comments so braces inside them cannot confuse the brace scanner. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, "");
}

/**
 * The file's `@media` blocks with balanced-brace bodies. Selectors and
 * declarations are read only structurally; anything the scanner cannot
 * represent fails the parse rather than being skipped.
 */
function mediaBlocks(source: string): MediaBlock[] {
  const text = stripComments(source);
  const blocks: MediaBlock[] = [];
  let index = 0;

  while ((index = text.indexOf("@media", index)) !== -1) {
    const open = text.indexOf("{", index);
    const condition = text.slice(index + "@media".length, open).trim();
    let depth = 1;
    let cursor = open + 1;

    while (depth > 0 && cursor < text.length) {
      if (text[cursor] === "{") depth++;
      if (text[cursor] === "}") depth--;
      cursor++;
    }

    blocks.push({ condition, body: text.slice(open + 1, cursor - 1) });
    index = cursor;
  }

  return blocks;
}

/** The top-level rules of a block body, with declarations parsed per rule. */
function rules(body: string): Rule[] {
  const parsed: Rule[] = [];
  let index = 0;

  while (index < body.length) {
    const open = body.indexOf("{", index);
    if (open === -1) break;
    const selector = body.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;

    while (depth > 0 && cursor < body.length) {
      if (body[cursor] === "{") depth++;
      if (body[cursor] === "}") depth--;
      cursor++;
    }

    // An @-rule (a media block the caller parses separately) is not a style
    // rule; skip it whole so its nested declarations never leak in.
    if (selector.startsWith("@")) {
      index = cursor;
      continue;
    }

    const block = body.slice(open + 1, cursor - 1);
    const declarations = Object.fromEntries(
      [...block.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(
        ([, property, value]) => [property!, value!.trim()],
      ),
    );
    parsed.push({ selector, declarations });
    index = cursor;
  }

  return parsed;
}

function ruleWith(parsed: Rule[], selector: string): Rule {
  const found = parsed.find((rule) => rule.selector === selector);
  expect(found, `expected a "${selector}" rule`).toBeDefined();
  return found!;
}

/**
 * The class components that decide header geometry, including the session
 * controls: they are row 1 of the stacked layout, so a margin on them
 * re-splits the header's vertical centres exactly as a nav wrap does.
 */
const HEADER_SURFACE_CLASSES = [
  ".site-header",
  ".site-nav",
  ".wordmark",
  ".member-stamp",
  ".session-controls",
];

/**
 * A selector part touches the header surface when it contains any surface
 * class on an identifier boundary anywhere in the compound — so
 * `.app-shell .site-header nav`, `nav:has(.site-nav)` and `nav .site-nav`
 * are all counted — or names the nav element in any form. The lookaheads
 * keep lookalike names elsewhere (.site-navigation, .card-nav) out of the
 * inventory. Enumerated against the shipped stylesheet: every nav /
 * wordmark / member-stamp / session-controls selector in it is header
 * surface, so nothing legitimate is tripped over.
 *
 * What the matcher still cannot see: it reasons about selector text, never
 * cascade effect. A rule that moves header geometry through a selector with
 * none of these components (a bare `header > a:first-child`, a universal
 * sibling rule, inherited properties on body) is uncounted, and a nav hidden
 * with `visibility: hidden` passes this guard and the harness's geometry
 * judge alike. The vocabulary bounds the guarantee.
 */
function touchesHeaderSurface(selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .some((part) =>
      HEADER_SURFACE_CLASSES.some((name) =>
        new RegExp(`${name.replace(/\./g, "\\.")}(?![\\w-])`).test(part)) ||
      /(^|[\s>+~(])nav(?![\w-])/.test(part));
}

/** Base rules sort before media'd ones; media blocks sort by max-width. */
function whereRank(where: string): number {
  const parsed = where.match(/max-width:\s*(\d+(?:\.\d+)?)px/);
  return parsed ? Number(parsed[1]) : -1;
}

function byLocation(
  a: { where: string; selector: string },
  b: { where: string; selector: string },
): number {
  return whereRank(a.where) - whereRank(b.where) ||
    (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0);
}

function headerSurfaceInventory(source: string): Array<{ where: string; selector: string }> {
  const inventory: Array<{ where: string; selector: string }> = [];
  const add = (where: string, selector: string) => {
    if (touchesHeaderSurface(selector)) {
      inventory.push({ where, selector: selector.replace(/\s+/g, " ").trim() });
    }
  };

  for (const rule of rules(stripComments(source))) {
    add("base", rule.selector);
  }
  for (const block of mediaBlocks(source)) {
    for (const rule of rules(block.body)) {
      add(block.condition, rule.selector);
    }
  }

  return inventory.sort(byLocation);
}

/**
 * The complete sanctioned set, location by location: the desktop base rules,
 * the two width-local tweaks in the 520px block, and the stacked pattern plus
 * its empty-nav guard in the measured 1240px block. Anything else touching
 * the header surface — anywhere, media'd or bare — fails the inventory.
 */
const expectedHeaderSurfaceRules: ReadonlyArray<{ where: string; selector: string }> = [
  { where: "base", selector: ".member-stamp" },
  { where: "base", selector: ".member-stamp span" },
  {
    where: "base",
    selector: ".member-stamp, .mono-meta, .eyebrow, .points-stamp, .proof-fingerprint, .site-footer",
  },
  { where: "base", selector: ".session-controls" },
  { where: "base", selector: ".site-header" },
  { where: "base", selector: ".site-nav" },
  { where: "base", selector: ".site-nav a" },
  { where: "base", selector: ".site-nav a:hover" },
  { where: "base", selector: ".wordmark" },
  { where: "(max-width: 520px)", selector: ".member-stamp" },
  { where: "(max-width: 520px)", selector: ".site-header" },
  { where: "(max-width: 1240px)", selector: ".site-header" },
  { where: "(max-width: 1240px)", selector: ".site-header nav" },
  { where: "(max-width: 1240px)", selector: ".site-header nav:has(.site-nav:empty)" },
  { where: "(max-width: 1240px)", selector: ".site-nav" },
  { where: "(max-width: 1240px)", selector: ".site-nav:empty" },
];

/** The header breakpoint exactly as the measurement harness pinned it. */
const HEADER_BREAKPOINT = 1240;

let blocks: MediaBlock[] = [];

beforeAll(() => {
  blocks = mediaBlocks(stylesheet);
});

/**
 * The blocks that carry the stacked pattern itself — a grid-template-columns
 * decision for the header or a nav placement rule — as opposed to width-local
 * tweaks (the 520px block narrows the header gap) that merely touch the
 * header.
 */
function headerStackedBlocks(): MediaBlock[] {
  return blocks.filter((block) => {
    const parsed = rules(block.body);
    return parsed.some((rule) =>
        rule.selector === ".site-header" && "grid-template-columns" in rule.declarations) ||
      parsed.some((rule) => rule.selector === ".site-header nav");
  });
}

function baseHeaderRule(): Rule {
  return ruleWith(rules(stripComments(stylesheet)), ".site-header");
}

describe("responsive header contract", () => {
  it("keeps the desktop three-column grid as the base rule", () => {
    const declarations = baseHeaderRule().declarations;

    expect(declarations["display"]).toBe("grid");
    expect(declarations["grid-template-columns"]).toBe("auto minmax(0, 1fr) auto");
    expect(declarations["align-items"]).toBe("center");
  });

  it("stacks the header under exactly one media query, the measured breakpoint", () => {
    const headerBlocks = headerStackedBlocks();

    expect(
      headerBlocks,
      "the header's stacked pattern must live in exactly one media query; " +
        "if the navigation changed width, re-measure with " +
        "scripts/measure-header-geometry.mjs and move the breakpoint once",
    ).toHaveLength(1);
    expect(headerBlocks[0]!.condition).toBe(`(max-width: ${HEADER_BREAKPOINT}px)`);
  });

  it("carries the stacked pattern in full inside the measured breakpoint", () => {
    const [block] = headerStackedBlocks();
    const parsed = rules(block!.body);

    expect(ruleWith(parsed, ".site-header").declarations["grid-template-columns"]).toBe("1fr auto");

    const navPlacement = ruleWith(parsed, ".site-header nav").declarations;
    expect(navPlacement["grid-column"]).toBe("1 / -1");
    expect(navPlacement["grid-row"]).toBe("2");

    expect(ruleWith(parsed, ".site-nav").declarations["justify-content"]).toBe("flex-start");
  });

  it("renders a signed-out header's empty navigation as nothing inside the stacked block", () => {
    const [block] = headerStackedBlocks();
    const parsed = rules(block!.body);

    // An empty ul alone is not enough: the nav element itself is the grid
    // item explicitly placed in row 2, so hiding only the ul leaves the row
    // track and its 1rem row-gap rendered under the wordmark. The nav-level
    // rule is what removes the row; both spellings are pinned.
    expect(ruleWith(parsed, ".site-nav:empty").declarations["display"]).toBe("none");
    expect(ruleWith(parsed, ".site-header nav:has(.site-nav:empty)").declarations["display"])
      .toBe("none");
  });

  it("leaves no copy of the stacked pattern in the older 780px block", () => {
    const block780 = blocks.find((block) => block.condition === "(max-width: 780px)");

    expect(
      block780,
      "the 780px block itself must stay (the rest of the narrow layout depends on it)",
    ).toBeDefined();
    expect(
      rules(block780!.body).filter((rule) => rule.selector.startsWith(".site-header") ||
        rule.selector === ".site-nav"),
    ).toEqual([]);
  });

  /**
   * The named-shape assertions only know the rules the contract names, so a
   * header rule appended anywhere else leaves them green. This closes the
   * universe: every rule in the file whose selector touches the header
   * surface is enumerated — from the base block and from every media block —
   * and must equal the sanctioned set exactly.
   */
  it("accounts for every rule touching the header surface, wherever it lives", () => {
    expect(headerSurfaceInventory(stylesheet))
      .toEqual([...expectedHeaderSurfaceRules].sort(byLocation));
  });
});
