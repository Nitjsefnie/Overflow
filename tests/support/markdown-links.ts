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

/** Inline links, `[text](target)`, excluding absolute URLs and mail links. */
export function relativeLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  withoutFencedCode(markdown).split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      links.push({ line: index + 1, target });
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
 * targets that document itself. The reported `line` counts from the first line
 * of the `markdown` passed, not from the first line of `document` — pass a
 * document, or expect the offset.
 */
export function unresolvedLinks(markdown: string, document: string, repositoryRoot: string): string[] {
  const failures: string[] = [];
  for (const { line, target } of relativeLinks(markdown)) {
    const [path, anchor] = target.split("#", 2) as [string, string | undefined];
    const targetPath = path === "" ? resolve(repositoryRoot, document) : resolve(repositoryRoot, dirname(document), path);
    if (!existsSync(targetPath)) {
      failures.push(`${document}:${line} links to ${target}, and ${path} does not exist`);
      continue;
    }
    if (anchor === undefined) continue;
    if (!targetPath.endsWith(".md")) {
      failures.push(`${document}:${line} links to ${target}, an anchor into a file that is not Markdown`);
      continue;
    }
    if (!headingSlugs(readFileSync(targetPath, "utf8")).has(anchor)) {
      failures.push(`${document}:${line} links to ${target}, and no heading in ${path || document} has that anchor`);
    }
  }
  return failures;
}

/** `unresolvedLinks` over a whole document, read from `repositoryRoot`. */
export function unresolvedRelativeLinks(document: string, repositoryRoot: string): string[] {
  return unresolvedLinks(readFileSync(resolve(repositoryRoot, document), "utf8"), document, repositoryRoot);
}