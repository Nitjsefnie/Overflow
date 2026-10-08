import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

/**
 * Branch protection names each required check only by its check-run name, and
 * every workflow here posts through the same GitHub Actions app, so a job with
 * a required name in ANY workflow satisfies it. `.github/required-checks.json`
 * pins each required name to the workflow file, or files, whose job is trusted
 * to produce it, and scripts/deploy-revision.sh resolves each required check
 * through that pin. This suite holds the committed workflows to the pin: every
 * pinned name has exactly one producing job in every pinned file, and no
 * producing job in any unpinned file.
 *
 * A pin may be a list because issue 1090 splits a workflow that reads
 * pull-request data out of its privileged triggers, leaving one required
 * context produced by a `pull_request_target` file and a push file. Every
 * committed entry uses that list form; this suite reads both forms so a
 * reader that silently drops half of a pin cannot pass.
 */

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

  it("has no job whose check-run name is only known at run time", () => {
    expect(unresolvedNames).toEqual([]);
  });
});
