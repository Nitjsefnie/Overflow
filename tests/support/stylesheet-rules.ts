import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";

/**
 * The shipped stylesheet, read once for every test that pins a rule in it.
 *
 * jsdom performs no layout, so a rendering test passes whether or not two
 * elements touch. What these helpers let a test pin is the stylesheet text
 * that produces the spacing — which declarations exist, how they compare in
 * size, and the source order the ties between them are decided by — and
 * never the geometry itself.
 */
export const stylesheet = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

/** The declarations of one rule block, keyed by property. */
export function declarations(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(
    ([, property, value]) => [property!, value!.trim()],
  ));
}

/**
 * The stylesheet with comments stripped, so a selector is matched against the
 * rules themselves and never against prose describing them.
 */
export const strippedStylesheet = stylesheet.replace(/\/\*[\s\S]*?\*\//g, " ");

/** Where the viewport-conditional part of the stylesheet begins. */
export const firstAtRule = strippedStylesheet.indexOf("@media");

export type PinnedRule = { declarations: Record<string, string>; index: number };

/**
 * The rule the selector opens, matched only where the selector is the whole
 * prelude: `.field` is answered by its own rule and never by
 * `.catalog-row > .field`, and the returned index is what the source-order
 * assertions compare.
 */
export function pinnedRule(selector: string): PinnedRule {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const match = strippedStylesheet.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `Missing \`${selector}\` rule`).not.toBeNull();
  return { declarations: declarations(match![1]!), index: match!.index! };
}

/** A length in rem, so two of them can be compared as numbers. */
export function rem(value: string | undefined, what: string): number {
  expect(value, what).toMatch(/^[\d.]+rem$/);
  return Number.parseFloat(value!);
}
