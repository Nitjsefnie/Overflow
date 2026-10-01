import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  headingSlugs,
  relativeLinks,
  unresolvedLinks,
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

  it("reads the inline and reference spellings of a link, and no others", () => {
    const links = relativeLinks([
      "[titled](deploy/README.md \"a title\") and [plain](backup-restore.md)",
      "[full][here] and [collapsed][] and [bare]",
      "[undefined][missing] is literal text, not a link",
      "[remote][away] [mail][post]",
      "[here]: ../OPERATING.md#environment-reference",
      "[collapsed]: backup-restore.md",
      "[bare]: README.md",
      "[away]: https://example.com/x.md",
      "[post]: mailto:a@b.c",
    ].join("\n"));
    expect(links).toStrictEqual([
      { line: 1, target: "deploy/README.md" },
      { line: 1, target: "backup-restore.md" },
      { line: 2, target: "../OPERATING.md#environment-reference" },
      { line: 2, target: "backup-restore.md" },
      { line: 2, target: "README.md" },
    ]);
  });

  it("does not read an inline link's text as a reference use", () => {
    // `[appx]` here is the link's text, not a reference use. With a definition
    // for `appx` sitting unused further down, reading it as a use reports the
    // definition's target against this line — a dead target on a live link.
    const links = relativeLinks([
      "See [appx](README.md) for the appendix.",
      "",
      "[appx]: does-not-exist.md",
    ].join("\n"));
    expect(links).toStrictEqual([{ line: 1, target: "README.md" }]);
  });

  it("resolves a reference use whose definition lives outside the excerpt", () => {
    // Shaped like the section-scoped caller: an excerpt cut at a heading, whose
    // reference use names a definition declared under a later heading.
    const root = mkdtempSync(join(tmpdir(), "markdown-links-"));
    try {
      writeFileSync(join(root, "doc.md"), [
        "## Section under test",
        "",
        "A [cross-section][appx] reference use.",
        "",
        "## Elsewhere",
        "",
        "[appx]: does-not-exist.md",
      ].join("\n"));
      const lines = readFileSync(join(root, "doc.md"), "utf8").split("\n");
      const start = lines.indexOf("## Section under test");
      const excerpt = lines.slice(start + 1, lines.indexOf("## Elsewhere")).join("\n");
      expect(unresolvedLinks(excerpt, "doc.md", root, start + 2)).toStrictEqual([
        "doc.md:3 links to does-not-exist.md, and does-not-exist.md does not exist",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("documents the two directions the recogniser is wrong in", () => {
  // These pin known misbehaviour, not desired behaviour. The doc comment on
  // `relativeLinks` promises neither direction is handled; if a future change
  // fixes either, these fail and that is the point — the comment and the
  // behaviour must not drift apart silently.
  expect(relativeLinks("See [a [b] c](does-not-exist.md)"), "under-reports").toStrictEqual([]);
  expect(relativeLinks("See [x](file(1).md)"), "over-reports").toStrictEqual([
    { line: 1, target: "file(1" },
  ]);
});

it("reports a failure against the line it occupies in the document, not in the excerpt", () => {
    const failures = unresolvedLinks(
      "[dead](does-not-exist.md)\n\n[also dead](#no-such-anchor)",
      "OPERATING.md",
      repositoryRoot,
      40,
    );
    expect(failures).toStrictEqual([
      "OPERATING.md:40 links to does-not-exist.md, and does-not-exist.md does not exist",
      "OPERATING.md:42 links to #no-such-anchor, and no heading in OPERATING.md has that anchor",
    ]);
  });
});
