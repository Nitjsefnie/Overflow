/**
 * Stylesheet association for the claim-state select and its sibling text inputs.
 *
 * Component tests run in jsdom, which does not cascade stylesheets, so the invariants
 * a reader depends on are pinned against the stylesheet text: the select must share the
 * text inputs' height, border, background and focus treatment through rules that apply at
 * every viewport, and it must inherit the form's font like the sibling controls do —
 * without `font: inherit` a select renders at the platform default size, visibly smaller
 * than the inputs beside it (issue 32). The geometric consequence of this wiring is
 * verified against a real browser by `scripts/measure-field-controls.ts`; this file pins
 * the wiring itself, so a selector edit that drops the select silently fails a committed
 * check.
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

/** The selector's parts, whitespace-normalized, e.g. `.field input:focus` → `.field input:focus`. */
function selectorParts(rule: StyleRule): string[] {
  return rule.selector.split(",").map((part) => part.replace(/\s+/g, " ").trim());
}

/** Whether any part of the selector names the control exactly: `.field input`, `.field select:focus`. */
function namesControl(rule: StyleRule, control: string, pseudoState = ""): boolean {
  return selectorParts(rule).some((part) => part === `.field ${control}${pseudoState}`);
}

function propertyValue(rule: StyleRule, property: string): string | undefined {
  return rule.declarations.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"))?.[1]?.trim();
}

/**
 * The last top-level rule styling `.field <control>` with the property — the effective
 * source of the value, given that later rules win and at-rule-scoped rules no longer
 * apply at every viewport.
 */
function effectiveRule(rules: StyleRule[], control: string, property: string, pseudoState = ""): StyleRule | undefined {
  let found: StyleRule | undefined;
  for (const rule of rules) {
    if (namesControl(rule, control, pseudoState) && propertyValue(rule, property) !== undefined) {
      found = rule;
    }
  }
  return found;
}

const rules = styleRules(stylesheet);

describe("field control styles", () => {
  it("styles the select with the text inputs' height, border, background and focus treatment, at every viewport", () => {
    for (const [property, pseudoState] of [
      ["min-height", ""],
      ["border", ""],
      ["background", ""],
      ["border-color", ":focus"],
    ] as const) {
      const inputRule = effectiveRule(rules, "input", property, pseudoState);
      const selectRule = effectiveRule(rules, "select", property, pseudoState);

      expect(selectRule, `the select is styled for ${property}${pseudoState}`).toBeDefined();
      expect(selectRule?.atRules, `the select ${property}${pseudoState} rule applies at every viewport`).toEqual([]);
      expect(
        propertyValue(selectRule ?? { selector: "", declarations: "", atRules: [] }, property),
        `the select matches the text input on ${property}${pseudoState}`,
      ).toEqual(propertyValue(inputRule ?? { selector: "", declarations: "", atRules: [] }, property));
    }
  });

  it("lets the select inherit the form's font like the sibling controls", () => {
    const fontReset = rules.find(
      (rule) => propertyValue(rule, "font") === "inherit" && selectorParts(rule).includes("input"),
    );

    expect(fontReset, "a font: inherit reset exists for the form controls").toBeDefined();
    expect(
      selectorParts(fontReset ?? { selector: "", declarations: "", atRules: [] }).includes("select"),
      "the font reset names select, which otherwise renders at the platform default size",
    ).toBe(true);
  });
});
