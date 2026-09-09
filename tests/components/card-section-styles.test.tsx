/**
 * Stylesheet association for card sections.
 *
 * Component tests run in jsdom, which does not cascade stylesheets, so the two
 * invariants a reader depends on are pinned against the stylesheet text: a
 * section carrying only the `surface` class gets the same inner padding as the
 * other card classes, and consecutive sections in the page column separate by
 * one visible gap.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type StyleRule = {
  selector: string;
  declarations: string;
};

const stylesheet = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

/** Every leaf rule in the stylesheet, comments stripped, source order kept. */
function styleRules(css: string): StyleRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: match[1].trim(), declarations: match[2].trim() }))
    .filter((rule) => rule.declarations !== "" && !rule.selector.startsWith("@"));
}

/**
 * Whether the rule styles the element carrying the class itself: the class
 * must end its compound selector, optionally followed by pseudo-classes, so a
 * descendant rule like `.audit-queue li` does not count for `.audit-queue`.
 */
function hasClassSelector(rule: StyleRule, token: string): boolean {
  const pattern = new RegExp(`\\.${token}(?![\\w-])(?::[a-z-]+(?:\\([^)]*\\))?)?$`);
  return rule.selector.split(",").some((part) => pattern.test(part.trim()));
}

/** The last value declared for the property among the rules matching the class. */
function effectiveStyle(rules: StyleRule[], token: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    if (hasClassSelector(rule, token)) {
      const declared = rule.declarations.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"));
      if (declared !== null) {
        value = declared[1].trim();
      }
    }
  }
  return value;
}

const rules = styleRules(stylesheet);

describe("card section styles", () => {
  it("gives a section carrying only the surface class the same padding as the other card classes", () => {
    const surfacePadding = effectiveStyle(rules, "surface", "padding");

    expect(surfacePadding).toBeDefined();
    for (const card of [
      "ledger-card",
      "ledger-note",
      "proof-card",
      "calibration-panel",
      "repository-form",
      "audit-queue",
      "empty-state",
    ]) {
      expect(effectiveStyle(rules, card, "padding"), `${card} shares the surface padding`).toEqual(surfacePadding);
    }
  });

  it("separates consecutive sections in the page column by one visible gap", () => {
    const gapRule = rules.find((rule) =>
      rule.selector.split(",").some((part) => part.replace(/\s+/g, " ") === ".page-content > * + *"),
    );

    expect(gapRule).toBeDefined();
    const gap = gapRule === undefined ? undefined : gapRule.declarations.match(/margin-top\s*:\s*([^;]+)/)?.[1]?.trim();
    expect(gap).toBeDefined();
    expect(Number.parseFloat(gap ?? "")).toBeGreaterThan(0);
  });

  it("lets a card's own margin-top win over the column gap", () => {
    // The gap rule ties with the per-card margin rules on specificity, so the
    // later per-card declarations only keep their own value while the gap rule
    // stays above them: `.recent-settlements` must keep sitting 2rem below the
    // dashboard grid, not at the generic 1.5rem gap.
    const gapRule = rules.find((rule) =>
      rule.selector.split(",").some((part) => part.replace(/\s+/g, " ") === ".page-content > * + *"),
    );
    const recentSettlementsMargin = rules.find(
      (rule) => hasClassSelector(rule, "recent-settlements") && /margin-top\s*:/.test(rule.declarations),
    );

    expect(gapRule).toBeDefined();
    expect(recentSettlementsMargin).toBeDefined();
    expect(effectiveStyle(rules, "recent-settlements", "margin-top")).toBe("2rem");
    expect(rules.indexOf(gapRule ?? { selector: "", declarations: "" })).toBeLessThan(
      rules.indexOf(recentSettlementsMargin ?? { selector: "", declarations: "" }),
    );
  });
});
