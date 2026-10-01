import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  headingSlugs,
  relativeLinks,
  unresolvedRelativeLinks,
} from "../support/markdown-links";

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

const rootDocuments = [
  "API.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "OPERATING.md",
  "README.md",
  "SECURITY.md",
];

describe("root documents", () => {
  for (const document of rootDocuments) {
    it(`${document} exists and carries relative links to check`, () => {
      const source = readFileSync(resolve(repositoryRoot, document), "utf8");
      expect(relativeLinks(source).length).toBeGreaterThan(0);
    });

    it(`every relative link in ${document} resolves to a file and, with an anchor, to a heading`, () => {
      const failures = unresolvedRelativeLinks(document, repositoryRoot);
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
