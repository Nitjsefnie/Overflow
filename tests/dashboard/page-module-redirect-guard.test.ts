import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([path.join(os.tmpdir(), "redirect-guard-fixture-")]);

const MARKER = "next/navigation";

const APP_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "app",
);

/**
 * Page modules allowed to reference next/navigation, keyed by path relative to
 * src/app. Each entry names the route it serves and why the walk covers it.
 */
const EXCEPTIONS: readonly string[] = [
  // "/" — walked as HomePage() itself; its redirect("/dashboard") for a member
  // session is traced by the walk's first describe.
  "page.tsx",
  // "/moderation" — walked as ModerationPage() itself; its redirect of a
  // non-moderator to "/dashboard" is traced by the walk's second describe.
  "moderation/page.tsx",
];

interface Scan {
  /** One entry per non-exception page module referencing the marker, named by path and line. */
  violations: string[];
  /** Page modules found under the scanned root. */
  moduleCount: number;
  /** Relative paths of the scanned modules that reference the marker. */
  filesWithSites: string[];
}

function listPageModules(rootDir: string): string[] {
  const modules: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name === "page.tsx") modules.push(path.relative(rootDir, full));
    }
  };
  walk(rootDir);
  return modules.sort();
}

/** Line the marker first appears on, or null when it never does. */
function referenceLine(source: string): number | null {
  const at = source.indexOf(MARKER);
  return at === -1 ? null : source.slice(0, at).split("\n").length;
}

function scanAppTree(rootDir: string, exceptions: readonly string[]): Scan {
  const violations: string[] = [];
  const filesWithSites: string[] = [];
  const modules = listPageModules(rootDir);
  for (const relative of modules) {
    if (exceptions.includes(relative)) continue;
    const source = readFileSync(path.join(rootDir, relative), "utf8");
    const line = referenceLine(source);
    if (line === null) continue;
    filesWithSites.push(relative);
    violations.push(
      `${relative}:${line} — page module references ${MARKER}. A redirect written here is invisible to ` +
        `the redirect walk (tests/dashboard/redirect-loop.test.ts): only routes that map serves as ` +
        `themselves have their redirects exercised, every other gated page runs as the session gate ` +
        `instead. Move the routing decision into requireMemberPageSession (src/lib/dashboard/session.ts), ` +
        `or, if the walk serves this module as itself, add it to EXCEPTIONS in ` +
        `tests/dashboard/page-module-redirect-guard.test.ts with the proof.`,
    );
  }
  return { violations, moduleCount: modules.length, filesWithSites };
}

/** Builds a throwaway src/app-shaped tree, runs `run` on it, and always removes it. */
function withFixtureTree(files: Record<string, string>, run: (root: string) => void): void {
  const root = tempDirectories.create(path.join(os.tmpdir(), "redirect-guard-fixture-"));
  try {
    for (const [relative, source] of Object.entries(files)) {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, source, "utf8");
    }
    run(root);
  } finally {
    tempDirectories.dispose(root);
  }
}

describe("no page module under src/app reaches next/navigation outside the walked exceptions", () => {
  it("leaves no page module for a hidden redirect to hide in", () => {
    const modules = listPageModules(APP_DIRECTORY);

    expect(modules.length).toBeGreaterThanOrEqual(12);
    for (const exception of EXCEPTIONS) {
      expect(modules).toContain(exception);
    }

    const scan = scanAppTree(APP_DIRECTORY, EXCEPTIONS);

    // The violation list is the load-bearing output: it names every offending
    // module. Assert it first so a failure lists them all.
    expect(scan.violations).toEqual([]);

    // Each exception must still earn its place: an entry that stops
    // referencing next/navigation is dropped, not grandfathered.
    for (const exception of EXCEPTIONS) {
      const source = readFileSync(path.join(APP_DIRECTORY, exception), "utf8");
      expect(
        source,
        `${exception} is declared an exception but no longer references ${MARKER}; ` +
          `drop it from EXCEPTIONS or re-justify it`,
      ).toContain(MARKER);
    }
  });

  it("pins each exception's safety to the walk still serving that module as itself", () => {
    const walk = readFileSync(
      fileURLToPath(new URL("./redirect-loop.test.ts", import.meta.url)),
      "utf8",
    );

    expect(walk).toMatch(/["']\/["']\s*:\s*\(\)\s*=>\s*HomePage\(\)/);
    expect(walk).toMatch(/["']\/moderation["']\s*:\s*\(\)\s*=>\s*ModerationPage\(\)/);
  });
});

describe("the scan catches every import shape", () => {
  const shapes = [
    {
      name: "a static named import",
      source: [
        `import { redirect } from "next/navigation";`,
        "",
        "export default async function Page() {",
        '  redirect("/somewhere");',
        "  return null;",
        "}",
      ].join("\n"),
    },
    {
      name: "an aliased named import",
      source: [
        `import { redirect as boom } from "next/navigation";`,
        "",
        "export default async function Page() {",
        '  boom("/somewhere");',
        "  return null;",
        "}",
      ].join("\n"),
    },
    {
      name: "a namespace import",
      source: [
        `import * as navigation from "next/navigation";`,
        "",
        "export default async function Page() {",
        '  navigation.redirect("/somewhere");',
        "  return null;",
        "}",
      ].join("\n"),
    },
    {
      name: "a dynamic import destructured to redirect",
      source: [
        "export default async function Page() {",
        `  const { redirect } = await import("next/navigation");`,
        '  redirect("/somewhere");',
        "  return null;",
        "}",
      ].join("\n"),
    },
    {
      name: "a dynamic import called through its namespace",
      source: [
        "export default async function Page() {",
        `  const navigation = await import("next/navigation");`,
        '  navigation.redirect("/somewhere");',
        "  return null;",
        "}",
      ].join("\n"),
    },
    {
      name: "a non-redirect member of the module (the rule is module-level)",
      source: [
        `import { notFound } from "next/navigation";`,
        "",
        "export default async function Page() {",
        "  notFound();",
        "}",
      ].join("\n"),
    },
  ];

  it.each(shapes)("flags $name", ({ source }) => {
    withFixtureTree({ "widget/page.tsx": source }, (root) => {
      const scan = scanAppTree(root, []);

      expect(scan.moduleCount).toBe(1);
      expect(scan.filesWithSites).toEqual(["widget/page.tsx"]);
      // The line moves with the shape (a dynamic import sits below the
      // component's first line); the exact-line naming has its own case below.
      expect(scan.violations).toEqual([expect.stringMatching(/^widget\/page\.tsx:\d+ —/)]);
      expect(scan.violations[0]).toMatch(/invisible to/);
    });
  });

  it("leaves a module with no next/navigation reference unflagged", () => {
    withFixtureTree(
      {
        "widget/page.tsx": [
          `import Link from "next/link";`,
          "",
          "export default function Page() {",
          '  return <Link href="/somewhere">somewhere</Link>;',
          "}",
        ].join("\n"),
      },
      (root) => {
        const scan = scanAppTree(root, []);

        expect(scan.moduleCount).toBe(1);
        expect(scan.filesWithSites).toEqual([]);
        expect(scan.violations).toEqual([]);
      },
    );
  });

  it("respects a declared exception, so a walked module keeps its redirects", () => {
    withFixtureTree(
      {
        "widget/page.tsx": [
          `import { redirect } from "next/navigation";`,
          "",
          "export default async function Page() {",
          '  redirect("/somewhere");',
          "}",
        ].join("\n"),
      },
      (root) => {
        const scan = scanAppTree(root, ["widget/page.tsx"]);

        expect(scan.moduleCount).toBe(1);
        expect(scan.filesWithSites).toEqual([]);
        expect(scan.violations).toEqual([]);
      },
    );
  });

  it("names the line the reference sits on, not just the file", () => {
    withFixtureTree(
      {
        "widget/page.tsx": [
          "import Link from `next/link`;",
          "",
          "export default async function Page() {",
          '  const nav = await import("next/navigation");',
          "  return null;",
          "}",
        ].join("\n"),
      },
      (root) => {
        const scan = scanAppTree(root, []);

        expect(scan.violations).toEqual([expect.stringContaining("widget/page.tsx:4")]);
      },
    );
  });

  it("keeps recursing into dot-directories, so no class of directory is skipped by name", () => {
    withFixtureTree(
      {
        "widget/page.tsx": [
          `import { redirect } from "next/navigation";`,
          "",
          "export default async function Page() {",
          '  redirect("/somewhere");',
          "}",
        ].join("\n"),
        ".hidden/page.tsx": [
          "export default async function Page() {",
          `  const { redirect } = await import("next/navigation");`,
          '  redirect("/somewhere");',
          "}",
        ].join("\n"),
      },
      (root) => {
        const scan = scanAppTree(root, []);

        expect(scan.moduleCount).toBe(2);
        expect(scan.filesWithSites).toEqual([".hidden/page.tsx", "widget/page.tsx"]);
        expect(scan.violations).toEqual([
          expect.stringMatching(/^\.hidden\/page\.tsx:\d+ —/),
          expect.stringMatching(/^widget\/page\.tsx:\d+ —/),
        ]);
      },
    );
  });

  it("reads modules at every depth of the tree it scans", () => {
    withFixtureTree(
      {
        "a/b/c/page.tsx": `export default function Page() {\n  return null;\n}\n`,
      },
      (root) => {
        expect(listPageModules(root)).toEqual(["a/b/c/page.tsx"]);
      },
    );
  });
});
