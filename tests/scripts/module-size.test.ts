import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyTighten,
  classify,
  collectViolations,
  configurationErrors,
  countLines,
  DOC_PATH,
  EXCLUSIONS,
  MEASURED_FAMILIES,
  runCheck,
  trackedPaths,
  type ModuleSizeDoc,
} from "../../scripts/check-module-size.ts";

const CEILINGS = { src: 800, tests: 2500, tooling: 800, stylesheets: 800, migrations: 400 };
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function ceilingsWithout(...families: string[]): Record<string, number> {
  return Object.fromEntries(
    Object.entries(CEILINGS).filter(([family]) => !families.includes(family)),
  );
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "module-size-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function document(baseline: Record<string, number> = {}): ModuleSizeDoc {
  return {
    ceilings: { ...CEILINGS },
    module_size_baseline: baseline,
  };
}

function filesWithLines(entries: Record<string, number>): Map<string, number> {
  const files = new Map<string, number>();
  for (const [path, lines] of Object.entries(entries)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "line\n".repeat(lines));
    files.set(path, countLines(readFileSync(absolute, "utf8")));
  }
  return files;
}

describe("module size ratchet", () => {
  it("accepts a fully consistent baseline and file tree", () => {
    const files = filesWithLines({
      "src/small.ts": 100,
      "src/big.ts": 900,
      "tests/big.test.ts": 2600,
    });
    const doc = document({ "src/big.ts": 900, "tests/big.test.ts": 2600 });
    expect(collectViolations(files, doc)).toEqual([]);
  });

  it("reports only over for an unlisted file above its ceiling", () => {
    const files = filesWithLines({ "src/new.ts": 801 });
    expect(collectViolations(files, document())).toMatchObject([
      { kind: "over", path: "src/new.ts" },
    ]);
  });

  it("reports only grown for a listed file above its recorded count", () => {
    const files = filesWithLines({ "src/big.ts": 950 });
    expect(collectViolations(files, document({ "src/big.ts": 900 }))).toMatchObject([
      { kind: "grown", path: "src/big.ts" },
    ]);
  });

  it("reports only missing for a baseline path absent from files", () => {
    const files = filesWithLines({});
    expect(collectViolations(files, document({ "src/gone.ts": 900 }))).toMatchObject([
      { kind: "missing", path: "src/gone.ts" },
    ]);
  });

  it("reports only graduated for a listed test below its tree ceiling", () => {
    const files = filesWithLines({ "tests/big.test.ts": 2400 });
    const doc = document({ "tests/big.test.ts": 2600 });
    expect(collectViolations(files, doc)).toMatchObject([
      { kind: "graduated", path: "tests/big.test.ts" },
    ]);
  });

  it("accepts files exactly at their ceiling or recorded count", () => {
    const files = filesWithLines({
      "src/boundary.ts": 800,
      "tests/boundary.test.ts": 2500,
      "src/listed.ts": 900,
    });
    const doc = document({ "src/listed.ts": 900 });
    expect(collectViolations(files, doc)).toEqual([]);
  });

  it("reports only shrunk for a listed file below its recorded count but over its ceiling", () => {
    const files = filesWithLines({ "src/big.ts": 850 });
    expect(collectViolations(files, document({ "src/big.ts": 900 }))).toEqual([
      {
        kind: "shrunk",
        path: "src/big.ts",
        detail: "shrank to 850 lines (recorded 900)",
        remedy: "record it: node scripts/check-module-size.ts --tighten",
      },
    ]);
  });

  it("reports shrunk for a listed file shrunk to exactly its ceiling", () => {
    const files = filesWithLines({ "tests/big.test.ts": 2500 });
    expect(collectViolations(files, document({ "tests/big.test.ts": 2600 }))).toMatchObject([
      { kind: "shrunk", path: "tests/big.test.ts" },
    ]);
  });

  it("reports graduated rather than shrunk once a listed file drops under its ceiling", () => {
    const files = filesWithLines({ "src/big.ts": 799 });
    expect(collectViolations(files, document({ "src/big.ts": 900 }))).toMatchObject([
      { kind: "graduated", path: "src/big.ts" },
    ]);
  });

  it("clears a shrunk violation once the baseline is tightened", () => {
    const files = filesWithLines({ "src/big.ts": 850, "src/kept.ts": 900 });
    const doc = document({ "src/big.ts": 900, "src/kept.ts": 900 });
    expect(collectViolations(files, doc)).toMatchObject([
      { kind: "shrunk", path: "src/big.ts" },
    ]);
    const tightened = applyTighten(files, doc).doc;
    expect(tightened.module_size_baseline).toEqual({
      "src/big.ts": 850,
      "src/kept.ts": 900,
    });
    expect(collectViolations(files, tightened)).toEqual([]);
  });

  it("leaves an already tight baseline unchanged", () => {
    const files = filesWithLines({ "src/big.ts": 900, "src/small.ts": 100 });
    const doc = document({ "src/big.ts": 900 });
    expect(applyTighten(files, doc)).toEqual({ doc, changes: [] });
  });

  it("lowers shrunken counts without raising grown counts", () => {
    const files = filesWithLines({ "src/grown.ts": 950, "src/shrunk.ts": 860 });
    const doc = document({ "src/grown.ts": 900, "src/shrunk.ts": 900 });
    const original = JSON.stringify(doc);
    const result = applyTighten(files, doc);
    expect(result.doc.module_size_baseline).toEqual({
      "src/grown.ts": 900,
      "src/shrunk.ts": 860,
    });
    expect(result.changes).toHaveLength(1);
    expect(JSON.stringify(doc)).toBe(original);
  });

  it("drops missing and graduated entries without adding unlisted files", () => {
    const files = filesWithLines({
      "tests/graduated.test.ts": 2400,
      "src/unlisted.ts": 1000,
      "src/kept.ts": 900,
    });
    const doc = document({
      "src/missing.ts": 900,
      "tests/graduated.test.ts": 2600,
      "src/kept.ts": 900,
    });
    expect(applyTighten(files, doc).doc.module_size_baseline).toEqual({
      "src/kept.ts": 900,
    });
  });

  it("allows the last entry to graduate to an empty baseline", () => {
    const files = filesWithLines({ "src/graduated.ts": 799 });
    const doc = document({ "src/graduated.ts": 900 });
    expect(applyTighten(files, doc).doc.module_size_baseline).toEqual({});
  });

  it("preserves untouched serialized members and the survivor key order", () => {
    const files = filesWithLines({ "src/z-lowered.ts": 850, "src/a-kept.ts": 950 });
    const doc = document({
      "src/z-lowered.ts": 900,
      "src/m-dropped.ts": 900,
      "src/a-kept.ts": 950,
    });
    const before = JSON.stringify(doc, null, 2);
    const tightened = applyTighten(files, doc).doc;
    const after = JSON.stringify(tightened, null, 2);
    const untouched = '    "src/a-kept.ts": 950';
    expect(before.split("\n")).toContain(untouched);
    expect(after.split("\n")).toContain(untouched);
    expect(Object.keys(tightened.module_size_baseline)).toEqual([
      "src/z-lowered.ts",
      "src/a-kept.ts",
    ]);
    expect(tightened.module_size_baseline).toEqual({
      "src/z-lowered.ts": 850,
      "src/a-kept.ts": 950,
    });
    expect(tightened.ceilings).toEqual(CEILINGS);
  });

  it("counts newline characters with wc -l semantics", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(1);
    expect(countLines("")).toBe(0);
  });

  it.each([
    ["Unicode", "src/lib/é-mutant.ts"],
    ["newline", "src/lib/newline\nmutant.ts"],
  ])("reports over for a tracked %s filename end to end", (_label, path) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    git("config", "core.quotePath", "true");
    filesWithLines({ [path]: 900 });
    git("add", "--", path);

    expect(runCheck(root, document())).toMatchObject([
      { kind: "over", path },
    ]);
  });

  it("checks tracked files end to end, including growth and unstaged deletion", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    git("config", "user.email", "module-size@example.test");
    git("config", "user.name", "Module Size Test");
    filesWithLines({ "src/big.ts": 850, "src/small.ts": 100 });
    git("add", "-A");
    const doc = document({ "src/big.ts": 850 });
    expect(runCheck(root, doc)).toEqual([]);

    appendFileSync(join(root, "src/big.ts"), "line\n".repeat(60));
    expect(runCheck(root, doc)).toMatchObject([
      { kind: "grown", path: "src/big.ts" },
    ]);

    // git ls-files still includes a file deleted from the working tree.
    unlinkSync(join(root, "src/big.ts"));
    expect(runCheck(root, doc)).toMatchObject([
      { kind: "missing", path: "src/big.ts" },
    ]);

    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/module-size.json"), JSON.stringify(doc));
    const script = fileURLToPath(new URL("../../scripts/check-module-size.ts", import.meta.url));
    const check = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("missing: src/big.ts");
    expect(check.stderr).toBe("");

    const tighten = spawnSync(process.execPath, [script, "--tighten"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(tighten.status).toBe(0);
    expect(tighten.stderr).toBe("");
    expect(JSON.parse(readFileSync(join(root, "scripts/module-size.json"), "utf8")))
      .toEqual(document());
  });
});

describe("module size families and exclusions", () => {
  it.each([
    ["src/lib/fold/repository-fold.ts", "src"],
    ["src/app/page.tsx", "src"],
    ["tests/db/schema.test.ts", "tests"],
    ["tests/ui/panel.test.tsx", "tests"],
    ["scripts/migrate.ts", "tooling"],
    ["scripts/check-page-geometry.mjs", "tooling"],
    ["scripts/db-backup.sh", "tooling"],
    ["next.config.ts", "tooling"],
    ["eslint.config.mjs", "tooling"],
    ["src/app/globals.css", "stylesheets"],
    ["db/migrations/001_initial.sql", "migrations"],
  ])("measures %s in the %s family", (path, name) => {
    expect(classify(path)).toEqual({ kind: "measured", name });
  });

  it.each([
    ["README.md", "documentation"],
    ["deploy/README.md", "documentation"],
    [".github/PULL_REQUEST_TEMPLATE.md", "documentation"],
    ["LICENSE", "documentation"],
    [".github/workflows/ci.yml", "repository metadata"],
    [".github/required-checks.json", "repository metadata"],
    [".github/requirements-zizmor.txt", "repository metadata"],
    [".github/requirements-pyyaml.txt", "repository metadata"],
    [".gitignore", "repository metadata"],
    [".dockerignore", "repository metadata"],
    [".env.example", "repository metadata"],
    ["package.json", "package manifests"],
    ["pnpm-lock.yaml", "package manifests"],
    ["pnpm-workspace.yaml", "package manifests"],
    ["tsconfig.json", "package manifests"],
    ["scripts/module-size.json", "ratchet documents"],
    ["patches/postgres@3.4.9.patch", "dependency patches"],
    ["deploy/overflow.service", "deployment units"],
    ["deploy/overflow-backup.timer", "deployment units"],
    ["Dockerfile", "deployment units"],
    ["docker-compose.yml", "deployment units"],
    ["public/mark.svg", "static assets"],
    ["scripts/required-checks-parse.jq", "declarative jq filters"],
  ])("records %s as excluded under %s", (path, name) => {
    expect(classify(path)).toEqual({ kind: "excluded", name });
  });

  it.each([
    "scripts/lib/helper.ts",
    "config/app.config.ts",
    "src/lib/data.json",
    "public/app.js",
    ".github/scripts/label.ts",
    "db/seed.sql",
    "tools/build.py",
    // The jq exclusion names only the tree root's own filters: a NESTED .jq
    // path is nobody's admission.
    "scripts/lib/required-checks-parse.jq",
  ])("classifies %s as neither measured nor excluded", (path) => {
    expect(classify(path)).toBeUndefined();
  });

  it("reports unclassified for a path in no family and no exclusion", () => {
    const files = filesWithLines({ "tools/build.py": 10, "README.md": 3000 });
    expect(collectViolations(files, document())).toMatchObject([
      { kind: "unclassified", path: "tools/build.py" },
    ]);
  });

  it("reports unknown-ceiling for a ceilings key that names no measured family", () => {
    const doc = { ...document(), ceilings: { ...CEILINGS, docs: 300 } };
    expect(collectViolations(filesWithLines({}), doc)).toMatchObject([
      { kind: "unknown-ceiling", path: DOC_PATH },
    ]);
  });

  it("reports over naming the stylesheets family for an unlisted stylesheet", () => {
    const files = filesWithLines({ "src/app/theme.css": 801 });
    const violations = collectViolations(files, document());
    expect(violations).toMatchObject([{ kind: "over", path: "src/app/theme.css" }]);
    expect(violations[0]?.detail).toContain("stylesheets");
  });

  it("applies each family's own ceiling", () => {
    const files = filesWithLines({
      "db/migrations/100_big.sql": 401,
      "db/migrations/101_fits.sql": 400,
      "scripts/tool.mjs": 801,
      "tests/fits.test.ts": 801,
    });
    expect(collectViolations(files, document())).toMatchObject([
      { kind: "over", path: "db/migrations/100_big.sql" },
      { kind: "over", path: "scripts/tool.mjs" },
    ]);
  });

  it("reports unmeasured-entry for a baseline entry outside every measured family", () => {
    const files = filesWithLines({ "README.md": 900, "tools/build.py": 900 });
    const doc = document({ "README.md": 900, "tools/build.py": 900 });
    expect(collectViolations(files, doc)).toMatchObject([
      { kind: "unmeasured-entry", path: "README.md" },
      { kind: "unmeasured-entry", path: "tools/build.py" },
      { kind: "unclassified", path: "tools/build.py" },
    ]);
  });

  it("drops an unmeasured baseline entry on tighten", () => {
    const files = filesWithLines({ "README.md": 900, "src/big.ts": 900 });
    const doc = document({ "README.md": 900, "src/big.ts": 900 });
    const tightened = applyTighten(files, doc).doc;
    expect(tightened.module_size_baseline).toEqual({ "src/big.ts": 900 });
    expect(collectViolations(files, tightened)).toEqual([]);
  });

  it("keeps an unmeasured entry whose tracked path is unclassified on tighten", () => {
    const files = filesWithLines({ "tools/build.py": 900, "src/big.ts": 900 });
    const doc = document({
      "README.md": 900,
      "tools/build.py": 900,
      "tools/gone.py": 900,
      "src/big.ts": 900,
    });
    const result = applyTighten(files, doc);
    expect(result.doc.module_size_baseline).toEqual({
      "tools/build.py": 900,
      "src/big.ts": 900,
    });
    const violations = collectViolations(files, result.doc);
    expect(violations).toMatchObject([
      { kind: "unmeasured-entry", path: "tools/build.py" },
      { kind: "unclassified", path: "tools/build.py" },
    ]);
    // --tighten would refuse here, so the remedy must not point at it.
    expect(violations[0]?.remedy).not.toContain("--tighten");
  });

  it("refuses --tighten without writing while a tracked path is unclassified", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    filesWithLines({ "src/app/globals.scss": 900, "src/big.ts": 850 });
    git("add", "-A");
    mkdirSync(join(root, "scripts"), { recursive: true });
    const before = JSON.stringify(
      document({ "src/app/globals.scss": 900, "src/big.ts": 900 }),
    );
    writeFileSync(join(root, DOC_PATH), before);
    const script = fileURLToPath(new URL("../../scripts/check-module-size.ts", import.meta.url));
    const run = spawnSync(process.execPath, [script, "--tighten"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("src/app/globals.scss");
    expect(readFileSync(join(root, DOC_PATH), "utf8")).toBe(before);
  });

  it("names every measured family that has no ceilings key as a configuration error", () => {
    const doc = { ...document(), ceilings: ceilingsWithout("stylesheets", "migrations") };
    expect(configurationErrors(doc)).toEqual([
      expect.stringContaining("stylesheets"),
      expect.stringContaining("migrations"),
    ]);
    expect(configurationErrors(document())).toEqual([]);
  });

  it("exits 2 on a measured family with no ceilings key", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "scripts"));
    writeFileSync(
      join(root, DOC_PATH),
      JSON.stringify({ ceilings: ceilingsWithout("migrations"), module_size_baseline: {} }),
    );
    const script = fileURLToPath(new URL("../../scripts/check-module-size.ts", import.meta.url));
    for (const args of [[script], [script, "--tighten"]]) {
      const run = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("migrations");
    }
  });

  it("reports an unclassified tracked file end to end and skips excluded ones", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    filesWithLines({ "tools/build.py": 5, "README.md": 3000, "src/app/big.css": 900 });
    git("add", "-A");
    expect(runCheck(root, document())).toMatchObject([
      { kind: "over", path: "src/app/big.css" },
      { kind: "unclassified", path: "tools/build.py" },
    ]);
  });

  it("leaves an admitted-but-absent exclusion inert: no stale-exclusion violation fires", () => {
    // .github/requirements-pyyaml.txt is admitted here before the file it
    // admits is tracked (it lands with the suppression-gate pull request).
    // An exclusion is consulted only for a TRACKED path — classify runs over
    // the tree, never over the exclusion list — so an admission whose file is
    // absent produces no violation of any kind: the tree below deliberately
    // carries no manifest, and the check stays silent about it.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    filesWithLines({ "README.md": 3000, "src/app/page.css": 300 });
    git("add", "-A");
    expect(runCheck(root, document())).toEqual([]);
  });

  it("gives every family and exclusion a distinct name", () => {
    const names = [...MEASURED_FAMILIES, ...EXCLUSIONS].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("places every tracked file of this repository in exactly one family or exclusion", () => {
    const paths = trackedPaths(repositoryRoot);
    expect(paths.length).toBeGreaterThan(0);
    const misplaced = paths
      .map((path) => ({
        path,
        matches: [...MEASURED_FAMILIES, ...EXCLUSIONS]
          .filter((c) => c.matches(path))
          .map((c) => c.name),
      }))
      .filter(({ matches }) => matches.length !== 1);
    expect(misplaced).toEqual([]);
  });

  it("passes on this repository with the committed module-size document", () => {
    const doc: ModuleSizeDoc = JSON.parse(readFileSync(join(repositoryRoot, DOC_PATH), "utf8"));
    expect(configurationErrors(doc)).toEqual([]);
    expect(runCheck(repositoryRoot, doc)).toEqual([]);
  });
});
