#!/usr/bin/env node
// Deterministic SQL statement gate (issue 1039). Initial budgets equal measured
// work; improvements must run --tighten in the same change. No raise/reseed path.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PERF_BUDGET_PATH = "scripts/perf-budget.json";
export type Measurements = Record<string, readonly number[]>;
export type Budget = Record<string, number>;
export type Violation = {
  kind: "over" | "shrunk" | "missing" | "unexpected" | "nondeterministic" | "invalid";
  workload: string;
  detail: string;
};

export function parseBudget(value: unknown): Budget {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length === 0
    || Object.values(value).some((count) => !Number.isSafeInteger(count) || count <= 0)) {
    throw new Error("performance budget must be a nonempty map of positive safe integers");
  }
  return value as Budget;
}

export function collectViolations(measurements: Measurements, budget: Budget): Violation[] {
  const out: Violation[] = [];
  for (const [workload, recorded] of Object.entries(budget)) {
    if (!Object.hasOwn(measurements, workload)) {
      out.push({ kind: "missing", workload, detail: "declared budget has no measurement" });
      continue;
    }
    const samples = measurements[workload];
    if (!Array.isArray(samples) || samples.length !== 2
      || samples.some((count) => !Number.isSafeInteger(count) || count <= 0)) {
      out.push({ kind: "invalid", workload, detail: "expected two positive integer statement counts" });
      continue;
    }
    const [first, second] = samples as [number, number];
    if (first !== second) {
      out.push({ kind: "nondeterministic", workload, detail: `determinism error: measured ${first}, ${second}` });
    } else if (first > recorded) {
      out.push({ kind: "over", workload, detail: `budget ${recorded}, measured ${first}` });
    } else if (first < recorded) {
      out.push({ kind: "shrunk", workload, detail: `budget ${recorded}, measured ${first}; record it: node scripts/check-perf-budget.ts --tighten` });
    }
  }
  for (const workload of Object.keys(measurements)) {
    if (!Object.hasOwn(budget, workload)) {
      out.push({ kind: "unexpected", workload, detail: "measured workload has no budget key" });
    }
  }
  return out;
}

export function applyTighten(measurements: Measurements, budget: Budget): { doc: Budget; changes: string[] } {
  const violations = collectViolations(measurements, budget);
  const blockers = violations.filter((violation) => violation.kind !== "shrunk");
  if (blockers.length > 0) {
    throw new Error(`--tighten refused; nothing written\n${blockers.map(formatViolation).join("\n")}`);
  }
  const doc = { ...budget };
  const changes: string[] = [];
  for (const { workload } of violations) {
    const count = measurements[workload]![0]!;
    doc[workload] = count;
    changes.push(`lowered ${workload}: ${budget[workload]} -> ${count}`);
  }
  return { doc, changes };
}

function formatViolation(violation: Violation): string {
  return `${violation.kind}: ${violation.workload} — ${violation.detail}`;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--tighten")) {
    console.error("usage: node scripts/check-perf-budget.ts [--tighten]");
    process.exitCode = 2;
    return;
  }
  try {
    const path = new URL("./perf-budget.json", import.meta.url);
    const budget = parseBudget(JSON.parse(readFileSync(path, "utf8")));
    // Production modules use TS parameter properties and @/ imports. Keep the
    // workflow command plain Node; run that import graph with the repo's loader.
    const result = spawnSync(process.execPath, [
      "--import", fileURLToPath(new URL("./perf-node-setup.mjs", import.meta.url)),
      "--experimental-transform-types", "--import",
      fileURLToPath(new URL("./register-path-aliases.ts", import.meta.url)),
      fileURLToPath(new URL("./perf-workloads.ts", import.meta.url)),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`measurement failed (exit ${result.status}, signal ${result.signal})`);
    const measurements: Measurements = JSON.parse(result.stdout);
    for (const [workload, counts] of Object.entries(measurements)) {
      console.log(`${workload}: budget ${budget[workload] ?? "absent"}, measured ${counts.join(", ")}`);
    }
    if (args[0] === "--tighten") {
      const { doc, changes } = applyTighten(measurements, budget);
      if (changes.length === 0) {
        console.log("budget already tight; nothing to change");
        return;
      }
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
      for (const change of changes) console.log(change);
      console.log(`wrote ${PERF_BUDGET_PATH}`);
      return;
    }
    const violations = collectViolations(measurements, budget);
    for (const violation of violations) console.log(formatViolation(violation));
    console.log(`performance budget check: ${violations.length} violation(s)${violations.length === 0 ? " — ok" : ""}`);
    if (violations.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`performance budget check: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
