import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The root documents link to each other and into `deploy/` by relative path
 * and heading anchor. Nothing else notices when a section moves between files
 * or a heading is reworded: the link keeps rendering, and only a reader who
 * follows it finds that it lands nowhere. So every relative Markdown link in
 * these files is resolved here — the target file must exist, and an anchor
 * must name a heading in that file under GitHub's slug rule.
 *
 * The assertions are about resolution, never about prose: a document is free
 * to say anything, as long as what it links to is there.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const rootDocuments = ["README.md", "API.md", "OPERATING.md", "CONTRIBUTING.md"];

type MarkdownLink = { line: number; target: string };

/** Fenced code blocks are not prose: a `[..](..)` inside one is not a link. */
function withoutFencedCode(markdown: string): string {
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
function relativeLinks(markdown: string): MarkdownLink[] {
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
function headingSlugs(markdown: string): Set<string> {
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

function unresolved(document: string): string[] {
  const source = readFileSync(resolve(repositoryRoot, document), "utf8");
  const failures: string[] = [];
  for (const { line, target } of relativeLinks(source)) {
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

describe("root documents", () => {
  for (const document of rootDocuments) {
    it(`${document} exists and carries relative links to check`, () => {
      const source = readFileSync(resolve(repositoryRoot, document), "utf8");
      expect(relativeLinks(source).length).toBeGreaterThan(0);
    });

    it(`every relative link in ${document} resolves to a file and, with an anchor, to a heading`, () => {
      const failures = unresolved(document);
      expect(failures, `\n${failures.join("\n")}`).toStrictEqual([]);
    });
  }

  it("slugs headings the way GitHub does", () => {
    const slugs = headingSlugs([
      "# Overflow",
      "## 10. Deploying a new revision",
      "### Operating an instance: GitHub OAuth and webhooks",
      "## The `offered:` and `settled:` labels are product data",
      "## Reference",
      "## Reference",
      "```",
      "## not a heading",
      "```",
    ].join("\n"));
    expect([...slugs]).toStrictEqual([
      "overflow",
      "10-deploying-a-new-revision",
      "operating-an-instance-github-oauth-and-webhooks",
      "the-offered-and-settled-labels-are-product-data",
      "reference",
      "reference-1",
    ]);
  });

  it("reads links from prose only, and skips absolute URLs", () => {
    const links = relativeLinks([
      "See [the API](API.md#submit-a-repository) and <https://overflow.nitjsefni.eu>.",
      "[remote](https://example.com/x.md#y) [mail](mailto:a@b.c) [same file](#license)",
      "```bash",
      "echo [not](a-link.md)",
      "```",
    ].join("\n"));
    expect(links).toStrictEqual([
      { line: 1, target: "API.md#submit-a-repository" },
      { line: 2, target: "#license" },
    ]);
  });
});
