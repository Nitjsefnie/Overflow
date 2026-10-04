import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The issue chooser is the admission surface every outsider reaches first.
 * `config.yml` disables blank issues and offers one private security contact,
 * so every other reporting route the root documents invite — conduct reports
 * (CODE_OF_CONDUCT.md § Reporting) and non-defect requests (CONTRIBUTING.md)
 * — needs a form the chooser actually offers.
 *
 * The assertions are about structure, never about prose: which files the
 * chooser offers, what their front matter applies, and what the one contact
 * link points at. What a template tells its reporter is free to change.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const templateDirectory = join(repositoryRoot, ".github/ISSUE_TEMPLATE");

type IssueTemplateFrontMatter = {
  name?: string;
  about?: string;
  labels?: string[] | string;
  assignees?: string[] | string;
};

const readFrontMatter = (template: string): IssueTemplateFrontMatter => {
  const source = readFileSync(join(templateDirectory, template), "utf8");
  const lines = source.split("\n");
  expect(lines[0], `${template} must open with a front-matter fence`).toBe("---");
  const close = lines.indexOf("---", 1);
  expect(close, `${template} must close its front-matter fence`).toBeGreaterThan(0);
  return parse(lines.slice(1, close).join("\n")) as IssueTemplateFrontMatter;
};

describe("issue admission surface", () => {
  it("keeps blank issues disabled", () => {
    const config = parse(
      readFileSync(join(templateDirectory, "config.yml"), "utf8"),
    ) as { blank_issues_enabled?: boolean };
    expect(config.blank_issues_enabled).toBe(false);
  });

  it("keeps exactly one contact link, the private security-advisory route", () => {
    const config = parse(
      readFileSync(join(templateDirectory, "config.yml"), "utf8"),
    ) as { contact_links?: Array<{ url?: string }> };
    expect(config.contact_links).toHaveLength(1);
    expect(config.contact_links?.[0]?.url).toBe(
      "https://github.com/Nitjsefnie/Overflow/security/advisories/new",
    );
  });

  it("offers the three issue templates in the chooser", () => {
    for (const template of ["bug-report.md", "conduct-report.md", "general.md"]) {
      expect(
        existsSync(join(templateDirectory, template)),
        `${template} must exist in .github/ISSUE_TEMPLATE/`,
      ).toBe(true);
    }
  });

  it("auto-applies and auto-assigns nothing from either new template", () => {
    for (const template of ["conduct-report.md", "general.md"]) {
      const frontMatter = readFrontMatter(template);
      expect(frontMatter.labels ?? []).toStrictEqual([]);
      expect(frontMatter.assignees ?? []).toStrictEqual([]);
    }
  });

  it("gives each new template a non-empty name and about, distinct from each other and the bug form", () => {
    const conduct = readFrontMatter("conduct-report.md");
    const general = readFrontMatter("general.md");
    const bug = readFrontMatter("bug-report.md");
    for (const [template, frontMatter] of [
      ["conduct-report.md", conduct],
      ["general.md", general],
    ] as const) {
      expect(frontMatter.name, `${template} name`).toBeTruthy();
      expect(frontMatter.about, `${template} about`).toBeTruthy();
    }
    const names = [conduct.name, general.name, bug.name];
    expect(new Set(names).size, `template names ${JSON.stringify(names)}`).toBe(3);
  });
});
