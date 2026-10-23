import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";


const root = fileURLToPath(new URL("../..", import.meta.url));
const workflowsDir = resolve(root, ".github/workflows");
const PIN_SHAPE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * The paths one pin names, whichever form it is written in. Throws on a shape
 * the map must never hold, so a malformed pin surfaces here as a readable
 * failure rather than as an empty list every assertion below would pass
 * vacuously against.
 */
function pinsOf(pin: unknown): string[] {
  const paths = typeof pin === "string" ? [pin] : pin;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === "string")) {
    throw new Error(`a pin is neither a workflow path nor a non-empty list of them: ${JSON.stringify(pin)}`);
  }
  return paths as string[];
}

type Job = { name?: unknown; strategy?: { matrix?: unknown } };
type Producer = { file: string; job: string };

let pins: Record<string, unknown> = {};
let workflowFiles: string[] = [];
let producersByName = new Map<string, Producer[]>();
let unresolvedNames: Producer[] = [];

beforeAll(async () => {
  pins = JSON.parse(await readFile(resolve(root, ".github/required-checks.json"), "utf8"));
  workflowFiles = (await readdir(workflowsDir)).filter((file) => /\.ya?ml$/.test(file)).sort();
  producersByName = new Map();
  unresolvedNames = [];
  for (const file of workflowFiles) {
    const workflow = parse(await readFile(resolve(workflowsDir, file), "utf8")) as {
      jobs?: Record<string, Job>;
    };
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      // A job's check-run is named by its `name:` when set, else by its id.
      const checkName = job.name === undefined ? jobId : String(job.name);
      const producer = { file: `.github/workflows/${file}`, job: jobId };
      // An expression in the name is only known at run time, so it could
      // equal any required name; such a job is reported, never assumed safe.
      if (checkName.includes("${{")) {
        unresolvedNames.push(producer);
        continue;
      }
      // Decision on matrix jobs: they are not counted as producers of their
      // bare name. This relies on GitHub naming a matrix job's check-runs
      // with its matrix values appended, ` (…)`, which holds for the usual
      // matrix but is not verified for every shape (an empty combination,
      // say). A name carrying an expression is caught above. The backstop is
      // the deploy gate: a check-run bearing a required name that is not one
      // of the pinned workflow's jobs keeps it pending, so it never passes.
      if (job.strategy?.matrix !== undefined) continue;
      producersByName.set(checkName, [...(producersByName.get(checkName) ?? []), producer]);
    }
  }
});

describe(".github/required-checks.json", () => {
  it("requires non-persisted credentials in every workflow and default checkouts in privileged workflows", async () => {
    // Every checkout must disable token persistence; privileged workflows
    // must also keep the trusted default ref and repository. These security
    // invariants survive legitimate checkout action SHA or version bumps.
    let checked = 0;
    for (const file of workflowFiles) {
      const workflow = parse(await readFile(resolve(workflowsDir, file), "utf8")) as {
        on?: unknown;
        jobs?: Record<string, {
          steps?: Array<{ uses?: string; with?: Record<string, unknown> }>;
        }>;
      };
      const events = Array.isArray(workflow.on)
        ? workflow.on.map(String)
        : typeof workflow.on === "string"
          ? [workflow.on]
          : Object.keys((workflow.on ?? {}) as Record<string, unknown>);
      const privileged = events.some((event) => event === "pull_request_target" || event === "workflow_run");
      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        for (const [index, step] of (job.steps ?? []).entries()) {
          if (!step.uses?.startsWith("actions/checkout")) continue;
          checked += 1;
          const scope = `${file}/${jobId}/step ${index + 1}`;
          expect(step.with?.["persist-credentials"], `${scope} must explicitly disable token persistence`).toBe(false);
          if (privileged) {
            expect(step.with ?? {}, `${scope} must use the trusted default ref`).not.toHaveProperty("ref");
            expect(step.with ?? {}, `${scope} must use the trusted repository`).not.toHaveProperty("repository");
          }
        }
      }
    }
    expect(checked, "the checkout boundary must inspect actual checkouts").toBeGreaterThan(0);
  });

  it("pins at least the checks branch protection on main requires", () => {
    expect(Object.keys(pins)).toEqual(
      expect.arrayContaining([
        "actionlint",
        "ratchet-guard",
        "verify",
        "secret-scan",
        "dependency-audit",
      ]),
    );
  });

  it("parses under the committed scripts/required-checks-parse.jq with real jq, one check<TAB>path line per pin pair", () => {
    // The deploy gate parses the map with this tracked file (issue 1104), so
    // the shapes the map may hold and the parser that accepts them travel
    // together: a parser edit and a map-shape change land in the same commit
    // or not at all. Real jq, because the gate runs jq and jq ships on
    // GitHub-hosted runners.
    const parsed = spawnSync(
      "jq",
      [
        "-rs",
        "-f",
        resolve(root, "scripts/required-checks-parse.jq"),
        resolve(root, ".github/required-checks.json"),
      ],
      { encoding: "utf8" },
    );
    expect(parsed.status, parsed.stderr).toBe(0);
    const lines = parsed.stdout.split("\n").filter((line) => line !== "");
    const expected: string[] = [];
    for (const [check, pin] of Object.entries(pins)) {
      for (const workflowPath of pinsOf(pin)) expected.push(`${check}\t${workflowPath}`);
    }
    expect(lines.sort()).toEqual(expected.sort());
  });

  it("points every pin at an existing workflow file", () => {
    const known = workflowFiles.map((file) => `.github/workflows/${file}`);
    for (const [check, pin] of Object.entries(pins)) {
      for (const path of pinsOf(pin)) {
        expect(path, check).toMatch(PIN_SHAPE);
        expect(known, `${check} pins ${path}`).toContain(path);
      }
    }
  });

  it("has exactly one producing job per pinned check, in every pinned file and nowhere else", () => {
    for (const [check, pin] of Object.entries(pins)) {
      const pinnedFiles = new Set(pinsOf(pin));
      const producers = producersByName.get(check) ?? [];
      // The producer set is the pin set: a producer in an UNPINNED workflow is
      // what this guard exists to refuse, and a repeated path inside one pin
      // must not buy a second count for a file that produces nothing.
      expect([...new Set(producers.map((producer) => producer.file))].sort(), check).toEqual(
        [...pinnedFiles].sort(),
      );
      expect(producers, check).toHaveLength(pinnedFiles.size);
    }
  });

  it("pins the four PR gate contexts to the aggregate and their push producer", () => {
    for (const context of ["actionlint", "ratchet-guard", "secret-scan", "dependency-audit"]) {
      expect(pins[context], context).toEqual([
        `.github/workflows/${context}.yml`,
        ".github/workflows/pr-gates.yml",
      ]);
    }
  });

  it("never skips a pinned producer job at the job level", async () => {
    for (const [check, pin] of Object.entries(pins)) {
      for (const path of pinsOf(pin)) {
        const workflow = parse(await readFile(resolve(root, path), "utf8")) as {
          jobs: Record<string, { name?: string; if?: unknown }>;
        };
        const producers = Object.entries(workflow.jobs)
          .filter(([id, job]) => (job.name ?? id) === check);
        expect(producers, `${path} must produce ${check}`).toHaveLength(1);
        expect(producers[0]![1].if, `${path}/${check} must never skip`).toBeUndefined();
      }
    }
  });

  it("has no job whose check-run name is only known at run time", () => {
    expect(unresolvedNames).toEqual([]);
  });
});
