import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * GitHub's relative-Markdown-link rules, in one place: a document is only
 * broken when what it links to is not there, and that is a structural
 * property of the link, never a property of the prose around it. Every test
 * that checks document links imports these, so two such tests cannot disagree
 * about what GitHub's slug rule is.
 */

export type MarkdownLink = { line: number; target: string };

/** Fenced code blocks are not prose: a `[..](..)` inside one is not a link. */
export function withoutFencedCode(markdown: string): string {
  const kept: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      kept.push("");
      continue;
    }
    kept.push(fenced ? "" : line);
  }
  return kept.join("\n");
}

/**
 * Reference definitions, `[label]: target`, keyed by lowercased label the way
 * GitHub matches them. A reference use with no definition renders as literal
 * text, not as a link, so a missing definition is not a broken link and the
 * lookup misses are dropped rather than reported.
 */
function linkDefinitions(markdown: string): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const line of withoutFencedCode(markdown).split("\n")) {
    const definition = line.match(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)/);
    if (definition === null) continue;
    definitions.set(definition[1]!.toLowerCase(), definition[2]!);
  }
  return definitions;
}

/**
 * Every relative link a renderer would resolve, in document order: the inline
 * spellings `[text](target)` and `[text](target "title")`, and the reference
 * spellings `[text][label]`, `[text][]` and the bare `[label]`. A reference
 * use counts only where a definition for its label exists — without one it
 * renders as literal text, not as a link. Absolute URLs and mail links are
 * excluded, as are the definition lines themselves, which declare targets
 * rather than use them.
 */
export function relativeLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const definitions = linkDefinitions(markdown);
  const keep = (target: string, line: number): void => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return;
    links.push({ line, target });
  };
  withoutFencedCode(markdown).split("\n").forEach((line, index) => {
    // A definition line declares a target; it is not itself a use of one.
    if (/^\s{0,3}\[[^\]]+\]:/.test(line)) return;
    for (const match of line.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g)) {
      keep(match[1]!, index + 1);
    }
    for (const match of line.matchAll(/\[([^\]]+)\](?:\[([^\]]*)\])?/g)) {
      const label = match[2] === undefined || match[2] === "" ? match[1]! : match[2]!;
      const target = definitions.get(label.toLowerCase());
      if (target !== undefined) keep(target, index + 1);
    }
  });
  return links;
}

/**
 * GitHub's heading slug: lowercase, punctuation other than hyphens,
 * underscores and spaces stripped, spaces to hyphens, and a `-N` suffix on a
 * repeated slug in document order.
 */
export function headingSlugs(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  for (const line of withoutFencedCode(markdown).split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading === null) continue;
    const base = heading[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

/**
 * Every relative link in `markdown` that does not resolve: the target file
 * does not exist, or its anchor names no heading in it. Links resolve exactly
 * as they would in the rendered `document`, so a link with an empty path
 * targets that document itself. `firstLine` is the line of `document` that the
 * first line of `markdown` sits on, so a failure names a line in the file a
 * reader opens rather than a line inside the excerpt.
 */
export function unresolvedLinks(
  markdown: string,
  document: string,
  repositoryRoot: string,
  firstLine = 1,
): string[] {
  const failures: string[] = [];
  for (const { line, target } of relativeLinks(markdown)) {
    const at = `${document}:${firstLine + line - 1}`;
    const [path, anchor] = target.split("#", 2) as [string, string | undefined];
    const targetPath = path === "" ? resolve(repositoryRoot, document) : resolve(repositoryRoot, dirname(document), path);
    if (!existsSync(targetPath)) {
      failures.push(`${at} links to ${target}, and ${path} does not exist`);
      continue;
    }
    if (anchor === undefined) continue;
    if (!targetPath.endsWith(".md")) {
      failures.push(`${at} links to ${target}, an anchor into a file that is not Markdown`);
      continue;
    }
    if (!headingSlugs(readFileSync(targetPath, "utf8")).has(anchor)) {
      failures.push(`${at} links to ${target}, and no heading in ${path || document} has that anchor`);
    }
  }
  return failures;
}

/** `unresolvedLinks` over a whole document, read from `repositoryRoot`. */
export function unresolvedRelativeLinks(document: string, repositoryRoot: string): string[] {
  return unresolvedLinks(readFileSync(resolve(repositoryRoot, document), "utf8"), document, repositoryRoot);
}
