import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

/**
 * Branch protection names each required check only by its check-run name, and
 * every workflow here posts through the same GitHub Actions app, so a job with
 * a required name in ANY workflow satisfies it. `.github/required-checks.json`
 * pins each required name to the one workflow file whose job is trusted to
 * produce it, and scripts/deploy-revision.sh resolves each required check
 * through that pin. This suite holds the committed workflows to the pin: every
 * pinned name has exactly one producing job across all workflow files, and it
 * lives in the pinned file.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflowsDir = resolve(root, ".github/workflows");
const PIN_SHAPE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

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
  it("pins at least the checks branch protection on main requires", () => {
    expect(Object.keys(pins)).toEqual(expect.arrayContaining(["actionlint", "ratchet-guard", "verify"]));
  });

  it("points every pin at an existing workflow file", () => {
    for (const [check, pin] of Object.entries(pins)) {
      expect(typeof pin, check).toBe("string");
      expect(pin, check).toMatch(PIN_SHAPE);
      expect(workflowFiles.map((file) => `.github/workflows/${file}`), check).toContain(pin);
    }
  });

  it("has exactly one producing job per pinned check, in the pinned workflow file", () => {
    for (const [check, pin] of Object.entries(pins)) {
      const producers = producersByName.get(check) ?? [];
      expect(producers, check).toEqual([{ file: pin, job: expect.any(String) }]);
    }
  });

  it("has no job whose check-run name is only known at run time", () => {
    expect(unresolvedNames).toEqual([]);
  });
});
