import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calibration } from "../../scripts/calibrate-coverage.ts";
import {
  COVERAGE_PATH,
  MODULE_SIZE_PATH,
  checkRatchets,
  coverageRelaxations,
  moduleSizeRelaxations,
} from "../../scripts/check-ratchets.ts";

const script = fileURLToPath(new URL("../../scripts/check-ratchets.ts", import.meta.url));

type Json = Record<string, unknown>;

const coverage = (
  overrides: { gap?: unknown; hysteresis?: unknown; measured?: unknown; floor?: unknown } = {},
): Json => ({
  gap: "gap" in overrides ? overrides.gap : 1.0,
  hysteresis: "hysteresis" in overrides ? overrides.hysteresis : 0.5,
  languages: {
    typescript: {
      measured: "measured" in overrides ? overrides.measured : 92.89,
      floor: "floor" in overrides ? overrides.floor : 91.89,
    },
  },
});

const moduleSize = (
  ceilings: Record<string, unknown> = { src: 800, tests: 2500 },
  baseline: Record<string, unknown> = { "src/big.ts": 900, "tests/big.test.ts": 2600 },
): Json => ({ ceilings, module_size_baseline: baseline });

describe("coverage ratchet relaxations", () => {
  it("accepts an unchanged document", () => {
    expect(coverageRelaxations(coverage(), coverage())).toEqual([]);
  });

  it("accepts every tightening direction at once", () => {
    const head = coverage({ gap: 0.5, hysteresis: 0.25, measured: 94.1, floor: 93.6 });
    expect(coverageRelaxations(coverage(), head)).toEqual([]);
  });

  it("refuses a lowered floor, naming file, key, base and head values", () => {
    const findings = coverageRelaxations(coverage(), coverage({ floor: 90 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(COVERAGE_PATH);
    expect(findings[0]).toContain("languages.typescript.floor");
    expect(findings[0]).toContain("91.89");
    expect(findings[0]).toContain("90");
  });

  it("refuses a lowered recorded measurement", () => {
    const findings = coverageRelaxations(coverage(), coverage({ measured: 92.0 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("languages.typescript.measured");
    expect(findings[0]).toContain("92.89");
  });

  it("refuses a raised gap and a raised hysteresis", () => {
    expect(coverageRelaxations(coverage(), coverage({ gap: 1.5 }))).toEqual([
      expect.stringContaining("gap"),
    ]);
    expect(coverageRelaxations(coverage(), coverage({ hysteresis: 0.75 }))).toEqual([
      expect.stringContaining("hysteresis"),
    ]);
  });

  it("refuses a removed key, top-level or nested", () => {
    const noGap = coverage();
    delete noGap.gap;
    expect(coverageRelaxations(coverage(), noGap)).toEqual([expect.stringContaining("gap")]);

    const noFloor = coverage();
    delete (noFloor.languages as { typescript: Json }).typescript.floor;
    expect(coverageRelaxations(coverage(), noFloor)).toEqual([
      expect.stringContaining("languages.typescript.floor"),
    ]);
  });

  it("refuses an added key, top-level or nested", () => {
    const added = coverageRelaxations(coverage(), { ...coverage(), exempt: 1 });
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("exempt");
    expect(added[0]).toContain("key added");
    const nested = coverage();
    (nested.languages as Json).python = { measured: 50, floor: 49 };
    expect(coverageRelaxations(coverage(), nested).length).toBeGreaterThan(0);
    expect(coverageRelaxations(coverage(), nested).join("\n")).toContain("languages.python");
  });

  it("refuses an added or removed empty object", () => {
    expect(coverageRelaxations(coverage(), { ...coverage(), exempt: {} })).toEqual([
      expect.stringContaining("key added"),
    ]);
    const nested = coverage();
    (nested.languages as Json).python = {};
    expect(coverageRelaxations(coverage(), nested)).toEqual([
      expect.stringContaining("languages.python"),
    ]);
    expect(coverageRelaxations({ ...coverage(), exempt: {} }, coverage())).toEqual([
      expect.stringContaining("key removed"),
    ]);
  });

  it("refuses a change to a key with no known tightening direction", () => {
    expect(coverageRelaxations({ ...coverage(), note: 1 }, { ...coverage(), note: 2 })).toEqual([
      expect.stringContaining("no tightening direction"),
    ]);
  });

  it("refuses a change away from a non-finite merge-base value", () => {
    expect(coverageRelaxations(coverage({ floor: "91.89" }), coverage({ floor: 92 }))).toEqual([
      expect.stringContaining("merge-base value is not a finite number"),
    ]);
  });

  it("refuses a negative hysteresis and accepts zero", () => {
    expect(coverageRelaxations(coverage(), coverage({ hysteresis: -100 }))).toEqual([
      expect.stringContaining("hysteresis"),
    ]);
    expect(coverageRelaxations(coverage(), coverage({ hysteresis: 0 }))).toEqual([]);
  });

  it("refuses a changed measurement whose floor is below measured minus gap", () => {
    const inflated = coverageRelaxations(coverage(), coverage({ measured: 1000 }));
    expect(inflated).toHaveLength(1);
    expect(inflated[0]).toContain("languages.typescript.floor");
    expect(inflated[0]).toContain("1000");
    expect(coverageRelaxations(coverage(), coverage({ measured: 93.5, floor: 92.4 }))).toEqual([
      expect.stringContaining("languages.typescript.floor"),
    ]);
    expect(coverageRelaxations(coverage(), coverage({ measured: 93.5, floor: 92.5 }))).toEqual([]);
  });

  it("judges the measured invariant with the head's gap, not the merge base's", () => {
    // Merge base: gap 1.0. Head: gap 0.5, measured 93.5, floor 92.5. The
    // floor must carry round2(measured - the head's gap) = 93, so 92.5 is
    // refused; a merge-base-gap implementation would compute 93.5 - 1.0
    // = 92.5 and accept it.
    const findings = coverageRelaxations(
      coverage(),
      coverage({ gap: 0.5, measured: 93.5, floor: 92.5 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("languages.typescript.floor");
    expect(findings[0]).toContain("measured 93.5 minus gap 0.5 = 93");
  });

  it("accepts a genuine calibrate output from the current document", () => {
    const next = calibration({ total: { lines: { pct: 94.37 } } }, {
      gap: 1.0,
      hysteresis: 0.5,
      languages: { typescript: { measured: 92.89, floor: 91.89 } },
    });
    expect(next).not.toBeNull();
    expect(coverageRelaxations(coverage(), next)).toEqual([]);
  });

  it("refuses a value changed to anything but a finite number", () => {
    for (const value of ["91.89", null, true, Infinity, NaN, [91.89], { v: 91.89 }]) {
      expect(coverageRelaxations(coverage(), coverage({ floor: value })).length).toBeGreaterThan(0);
    }
  });

  it("refuses a deleted document", () => {
    expect(coverageRelaxations(coverage(), null)).toEqual([
      expect.stringContaining(COVERAGE_PATH),
    ]);
  });

  it("accepts anything when the merge base had no document", () => {
    expect(coverageRelaxations(null, coverage({ floor: 0, gap: 50 }))).toEqual([]);
    expect(coverageRelaxations(null, null)).toEqual([]);
  });
});

describe("module size ratchet relaxations", () => {
  it("accepts an unchanged document", () => {
    expect(moduleSizeRelaxations(moduleSize(), moduleSize())).toEqual([]);
  });

  it("accepts lowered ceilings and lowered or removed baseline entries", () => {
    const head = moduleSize({ src: 700, tests: 2000 }, { "src/big.ts": 850 });
    expect(moduleSizeRelaxations(moduleSize(), head)).toEqual([]);
    expect(moduleSizeRelaxations(moduleSize(), moduleSize(undefined, {}))).toEqual([]);
  });

  it("refuses a raised src or tests ceiling, naming file, key, base and head values", () => {
    const src = moduleSizeRelaxations(moduleSize(), moduleSize({ src: 900, tests: 2500 }));
    expect(src).toHaveLength(1);
    expect(src[0]).toContain(MODULE_SIZE_PATH);
    expect(src[0]).toContain("ceilings.src");
    expect(src[0]).toContain("800");
    expect(src[0]).toContain("900");
    expect(moduleSizeRelaxations(moduleSize(), moduleSize({ src: 800, tests: 2501 }))).toEqual([
      expect.stringContaining("ceilings.tests"),
    ]);
  });

  it("refuses an added or removed ceilings key", () => {
    expect(
      moduleSizeRelaxations(moduleSize(), moduleSize({ src: 800, tests: 2500, scripts: 100 })),
    ).toEqual([expect.stringContaining("ceilings.scripts")]);
    expect(moduleSizeRelaxations(moduleSize(), moduleSize({ src: 800 }))).toEqual([
      expect.stringContaining("ceilings.tests"),
    ]);
  });

  it("refuses an added baseline entry", () => {
    const head = moduleSize(undefined, {
      "src/big.ts": 900,
      "tests/big.test.ts": 2600,
      "src/new.ts": 801,
    });
    const findings = moduleSizeRelaxations(moduleSize(), head);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("src/new.ts");
    expect(findings[0]).toContain("801");
  });

  it("refuses a raised baseline count", () => {
    const head = moduleSize(undefined, { "src/big.ts": 901, "tests/big.test.ts": 2600 });
    const findings = moduleSizeRelaxations(moduleSize(), head);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("src/big.ts");
    expect(findings[0]).toContain("900");
    expect(findings[0]).toContain("901");
  });

  it("refuses an added or removed top-level key", () => {
    expect(moduleSizeRelaxations(moduleSize(), { ...moduleSize(), exempt: [] })).toEqual([
      expect.stringContaining("exempt"),
    ]);
    const noBaseline = moduleSize();
    delete noBaseline.module_size_baseline;
    expect(moduleSizeRelaxations(moduleSize(), noBaseline)).toEqual([
      expect.stringContaining("module_size_baseline"),
    ]);
  });

  it("refuses non-integer values in ceilings and baseline", () => {
    for (const value of [800.5, "800", null, Infinity, NaN]) {
      expect(
        moduleSizeRelaxations(moduleSize(), moduleSize({ src: value, tests: 2500 })).length,
      ).toBeGreaterThan(0);
      expect(
        moduleSizeRelaxations(
          moduleSize(),
          moduleSize(undefined, { "src/big.ts": value, "tests/big.test.ts": 2600 }),
        ).length,
      ).toBeGreaterThan(0);
    }
  });

  it("refuses ceilings or baseline replaced by a non-object", () => {
    expect(moduleSizeRelaxations(moduleSize(), { ...moduleSize(), ceilings: 800 }).length)
      .toBeGreaterThan(0);
    expect(
      moduleSizeRelaxations(moduleSize(), { ...moduleSize(), module_size_baseline: [] }).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a change to a top-level key with no known tightening direction", () => {
    expect(
      moduleSizeRelaxations({ ...moduleSize(), note: "a" }, { ...moduleSize(), note: "b" }),
    ).toEqual([expect.stringContaining("no tightening direction")]);
  });

  it("refuses a change away from a non-integer merge-base value", () => {
    expect(
      moduleSizeRelaxations(moduleSize({ src: 800.5, tests: 2500 }), moduleSize()),
    ).toEqual([expect.stringContaining("merge-base value is not an integer")]);
  });

  it("refuses a deleted document", () => {
    expect(moduleSizeRelaxations(moduleSize(), null)).toEqual([
      expect.stringContaining(MODULE_SIZE_PATH),
    ]);
  });

  it("accepts anything when the merge base had no document", () => {
    expect(moduleSizeRelaxations(null, moduleSize({ src: 99999, tests: 99999 }))).toEqual([]);
  });
});

describe("ratchet check against a real git repository", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ratchets-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  const writeDoc = (path: string, content: unknown) => {
    mkdirSync(join(root, "scripts"), { recursive: true });
    const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(join(root, path), text);
  };

  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
  };

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

  // main: base docs; feature forks; feature applies `onFeature`; main then
  // advances with a RAISED floor, so the tip is stricter than the merge base.
  const seed = (onFeature: () => void) => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ratchets@example.test");
    git("config", "user.name", "Ratchets Test");
    git("config", "commit.gpgsign", "false");
    writeDoc(COVERAGE_PATH, coverage());
    writeDoc(MODULE_SIZE_PATH, moduleSize());
    commit("base documents");
    git("checkout", "-q", "-b", "feature");
    onFeature();
    commit("feature change");
    git("checkout", "-q", "main");
    writeDoc(COVERAGE_PATH, coverage({ measured: 95.0, floor: 94.0 }));
    writeDoc(MODULE_SIZE_PATH, moduleSize(undefined, { "src/big.ts": 850 }));
    commit("calibrate raises the floor and the baseline tightens");
  };

  it("compares against the merge base, not the advanced base tip", () => {
    seed(() => writeFileSync(join(root, "unrelated.txt"), "change\n"));
    const result = run("main", "feature");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("exits 1 and names the finding when the branch lowers the floor", () => {
    seed(() => writeDoc(COVERAGE_PATH, coverage({ floor: 90.5 })));
    const result = run("main", "feature");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(COVERAGE_PATH);
    expect(result.stdout).toContain("languages.typescript.floor");
    expect(result.stdout).toContain("91.89");
    expect(result.stdout).toContain("90.5");
  });

  it("exits 1 when the branch adds a module size baseline entry", () => {
    seed(() =>
      writeDoc(
        MODULE_SIZE_PATH,
        moduleSize(undefined, {
          "src/big.ts": 900,
          "tests/big.test.ts": 2600,
          "src/new.ts": 1200,
        }),
      ),
    );
    const result = run("main", "feature");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(MODULE_SIZE_PATH);
    expect(result.stdout).toContain("src/new.ts");
  });

  it("exits 1 when the branch deletes a ratchet document", () => {
    seed(() => git("rm", "-q", MODULE_SIZE_PATH));
    const result = run("main", "feature");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(MODULE_SIZE_PATH);
  });

  it("exits 1 when the branch replaces a document with a symlink", () => {
    // The link's target text is the merge base's JSON, so reading the blob
    // would see an unchanged document while the checks read floor 0.
    const target = JSON.stringify(coverage());
    seed(() => {
      rmSync(join(root, COVERAGE_PATH));
      symlinkSync(target, join(root, COVERAGE_PATH));
      writeDoc(join("scripts", target), coverage({ floor: 0 }));
    });
    expect(git("ls-tree", "feature", "--", COVERAGE_PATH)).toMatch(/^120000 blob /);
    const result = run("main", "feature");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(COVERAGE_PATH);
    expect(result.stdout).toContain("120000");
  });

  it("exits 1 when the branch makes a document executable", () => {
    seed(() => chmodSync(join(root, MODULE_SIZE_PATH), 0o755));
    expect(git("ls-tree", "feature", "--", MODULE_SIZE_PATH)).toMatch(/^100755 blob /);
    const result = run("main", "feature");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(MODULE_SIZE_PATH);
    expect(result.stdout).toContain("100755");
  });

  it("exits 2 when the merge base holds a document that is not a regular file", () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ratchets@example.test");
    git("config", "user.name", "Ratchets Test");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(root, "scripts"));
    // Valid JSON as the link text, so a blob read would parse and compare.
    symlinkSync('{"floor":1}', join(root, COVERAGE_PATH));
    commit("symlinked document");
    git("checkout", "-q", "-b", "feature");
    rmSync(join(root, COVERAGE_PATH));
    writeDoc(COVERAGE_PATH, coverage());
    commit("regular document");
    const result = run("main", "feature");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a regular file");
  });

  it("exits 0 when the branch only tightens", () => {
    seed(() => {
      writeDoc(COVERAGE_PATH, coverage({ measured: 93.5, floor: 92.5 }));
      writeDoc(MODULE_SIZE_PATH, moduleSize({ src: 800, tests: 2500 }, { "src/big.ts": 880 }));
    });
    const result = run("main", "feature");
    expect(result.status).toBe(0);
  });

  it("reads committed revisions, never the working tree", () => {
    seed(() => writeFileSync(join(root, "unrelated.txt"), "change\n"));
    git("checkout", "-q", "feature");
    writeDoc(COVERAGE_PATH, coverage({ floor: 1 }));
    expect(run("main", "feature").status).toBe(0);
  });

  it("accepts whatever the head has when the merge base had no document", () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ratchets@example.test");
    git("config", "user.name", "Ratchets Test");
    git("config", "commit.gpgsign", "false");
    commit("empty base");
    git("checkout", "-q", "-b", "feature");
    writeDoc(COVERAGE_PATH, coverage({ floor: 0 }));
    writeDoc(MODULE_SIZE_PATH, moduleSize({ src: 99999, tests: 99999 }));
    commit("introduce documents");
    const result = run("main", "feature");
    expect(result.status).toBe(0);
    expect(checkRatchets(root, "main", "feature").findings).toEqual([]);
  });

  it("exits 1 when the head has a non-regular document and the merge base had none", () => {
    // Valid JSON as the link text, so a blob read would parse and compare:
    // only the head-kind check stands between this and an unjudged document.
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ratchets@example.test");
    git("config", "user.name", "Ratchets Test");
    git("config", "commit.gpgsign", "false");
    commit("empty base");
    git("checkout", "-q", "-b", "feature");
    mkdirSync(join(root, "scripts"), { recursive: true });
    symlinkSync('{"floor":1}', join(root, COVERAGE_PATH));
    commit("symlinked document with no merge-base document");
    expect(git("ls-tree", "feature", "--", COVERAGE_PATH)).toMatch(/^120000 blob /);
    const result = run("main", "feature");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(COVERAGE_PATH);
    expect(result.stdout).toContain("120000");
  });

  it("exits 2 when the two revisions share no merge base", () => {
    seed(() => writeFileSync(join(root, "unrelated.txt"), "change\n"));
    git("checkout", "-q", "--orphan", "island");
    writeDoc(COVERAGE_PATH, coverage({ floor: 1 }));
    commit("unrelated history");
    const result = run("main", "island");
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("merge base");
  });

  it("exits 2 on a missing argument or an unknown revision", () => {
    seed(() => writeFileSync(join(root, "unrelated.txt"), "change\n"));
    expect(run().status).toBe(2);
    expect(run("main").status).toBe(2);
    expect(run("main", "feature", "extra").status).toBe(2);
    expect(run("main", "no-such-branch").status).toBe(2);
    expect(run("--help", "feature").status).toBe(2);
  });

  it("exits 2 when a document at head is not valid JSON", () => {
    seed(() => writeDoc(COVERAGE_PATH, "{ not json\n"));
    const result = run("main", "feature");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(COVERAGE_PATH);
  });
});
