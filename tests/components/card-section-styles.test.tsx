/**
 * Stylesheet association for card sections.
 *
 * Component tests run in jsdom, which does not cascade stylesheets, so the two
 * invariants a reader depends on are pinned against the stylesheet text: a
 * section carrying only the `surface` class gets the same inner padding as the
 * other card classes, and consecutive sections in the page column separate by
 * one visible gap. Matched rules must be top-level — a rule scoped inside an
 * at-rule no longer applies at every viewport — and must style the element
 * carrying the class itself, not a descendant of it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type StyleRule = {
  selector: string;
  declarations: string;
  /** The enclosing at-rule preludes; empty for a top-level rule. */
  atRules: string[];
};

const stylesheet = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

/**
 * Every leaf rule in the stylesheet, comments stripped, source order kept,
 * each carrying its enclosing at-rule preludes.
 */
function styleRules(css: string): StyleRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules: StyleRule[] = [];
  const preludes: string[] = [];
  const sawNested: boolean[] = [];
  let text = "";
  for (const character of source) {
    if (character === "{") {
      preludes.push(text.trim());
      sawNested.push(false);
      text = "";
    } else if (character === "}") {
      const prelude = preludes.pop() ?? "";
      const hadNested = sawNested.pop() ?? false;
      if (!hadNested && prelude !== "" && !prelude.startsWith("@") && text.trim() !== "") {
        rules.push({
          selector: prelude,
          declarations: text.trim(),
          atRules: preludes.filter((enclosing) => enclosing.startsWith("@")),
        });
      }
      text = "";
      if (sawNested.length > 0) {
        sawNested[sawNested.length - 1] = true;
      }
    } else if (character === ";" && preludes.length === 0) {
      text = "";
    } else {
      text += character;
    }
  }
  return rules;
}

/**
 * Whether the rule styles the element carrying the class itself: the selector
 * part must be the one compound carrying the class — a type selector and
 * pseudo-classes may precede and follow it, but no descendant, child or
 * sibling combinator may appear, so an ancestry-conditional rule like
 * `.page-content .surface` cannot stand in for the element's own declaration.
 */
function hasClassSelector(rule: StyleRule, token: string): boolean {
  const pattern = new RegExp(`^([a-zA-Z][\\w-]*|\\*)?\\.${token}(?![\\w-])(?::[a-z-]+(?:\\([^)]*\\))?)*$`);
  return rule.selector.split(",").some((part) => pattern.test(part.trim()));
}

function propertyValue(rule: StyleRule, property: string): string | undefined {
  return rule.declarations.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"))?.[1]?.trim();
}

/** The last rule styling the element carrying the class itself with the property. */
function effectiveRule(rules: StyleRule[], token: string, property: string): StyleRule | undefined {
  let found: StyleRule | undefined;
  for (const rule of rules) {
    if (hasClassSelector(rule, token) && propertyValue(rule, property) !== undefined) {
      found = rule;
    }
  }
  return found;
}

const rules = styleRules(stylesheet);

describe("card section styles", () => {
  it("gives a section carrying only the surface class the same padding as the other card classes", () => {
    const surfaceRule = effectiveRule(rules, "surface", "padding");

    expect(surfaceRule).toBeDefined();
    expect(surfaceRule?.atRules, "the surface padding rule applies at every viewport").toEqual([]);

    for (const card of [
      "ledger-card",
      "ledger-note",
      "proof-card",
      "calibration-panel",
      "repository-form",
      "audit-queue",
      "empty-state",
    ]) {
      const cardRule = effectiveRule(rules, card, "padding");
      expect(cardRule, `${card} shares the surface padding`).toBeDefined();
      expect(propertyValue(cardRule ?? { selector: "", declarations: "", atRules: [] }, "padding")).toEqual(
        propertyValue(surfaceRule ?? { selector: "", declarations: "", atRules: [] }, "padding"),
      );
      expect(cardRule?.atRules, `${card} padding applies at every viewport`).toEqual([]);
    }
  });

  it("separates consecutive sections in the page column by one visible gap", () => {
    const gapRule = rules.find((rule) =>
      rule.selector.split(",").some((part) => part.replace(/\s+/g, " ") === ".page-content > * + *"),
    );

    expect(gapRule).toBeDefined();
    const gap = gapRule === undefined ? undefined : propertyValue(gapRule, "margin-top");
    expect(gap).toBeDefined();
    expect(Number.parseFloat(gap ?? "")).toBeGreaterThan(0);
    expect(gapRule?.atRules, "the column gap applies at every viewport").toEqual([]);
  });

  it("renders no floating pseudo-element strip on the next-move card", () => {
    const decoration = rules.find((rule) =>
      rule.selector.split(",").some((part) => part.replace(/\s+/g, " ") === ".ledger-note::before"),
    );

    expect(decoration).toBeUndefined();
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
    expect(propertyValue(recentSettlementsMargin ?? { selector: "", declarations: "", atRules: [] }, "margin-top")).toBe(
      "2rem",
    );
    expect(rules.indexOf(gapRule ?? { selector: "", declarations: "", atRules: [] })).toBeLessThan(
      rules.indexOf(recentSettlementsMargin ?? { selector: "", declarations: "", atRules: [] }),
    );
  });
});
