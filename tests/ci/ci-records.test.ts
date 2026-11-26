import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const records = ["size-baseline", "comment-share", "ci-thresholds", "test-times"].map(name => `.github/${name}.json`);
const prefix = join(tmpdir(), "overflow-ci-records-");
const temp = createOwnedTempDirectoryRegistry([prefix]);
const script = resolve("scripts/ci_records.py");
const repo = "fixture/Overflow";
const actions = `repos/${repo}/actions/`;
const runsAt = (sha: string) => actions + `workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}`;

describe("ratchet record pushes", () => {
  let root: string;
  let code: string;
  let runless: string;
  let size: string;
  let head: string;
  function git(...args: string[]) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  }
  function commit() {
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "same subject");
    return git("rev-parse", "HEAD");
  }
  function run(command: string, before: string, env: Record<string, string> = {}) {
    return spawnSync("python3", [script, command], { cwd: root, encoding: "utf8", timeout: 10_000, env: {
      ...process.env, PATH: `${root}/bin:${process.env.PATH}`, GITHUB_REPOSITORY: repo,
      OVERFLOW_BEFORE_SHA: before, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", ...env,
    } });
  }
  beforeAll(async () => {
    root = await temp.createAsync(prefix);
    mkdirSync(join(root, ".github"));
    git("init", "-qb", "main");
    git("config", "diff.renames", "true");
    writeFileSync(join(root, "source\nfile.ts"), "original");
    commit();
    writeFileSync(join(root, "source\nfile.ts"), "tested code");
    code = commit();
    writeFileSync(join(root, records[0]!), "first record in the push");
    runless = commit();
    writeFileSync(join(root, records[0]!), "size");
    size = commit();
    for (const file of records.slice(1)) writeFileSync(join(root, file), "record");
    head = commit();
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin/sitecustomize.py"), "import time\ntime.sleep = lambda seconds: None\n");
    writeFileSync(join(root, "bin/gh"), `#!/usr/bin/env python3
import json, sys
from pathlib import Path
assert sys.argv[1] == "api"
path = Path(__file__).with_name("responses.json")
responses = json.loads(path.read_text())
answer = responses[sys.argv[2]]
if isinstance(answer, list):
    answer = answer.pop(0)
    path.write_text(json.dumps(responses))
print(json.dumps(answer))
`, { mode: 0o755 });
  });
  afterAll(async () => { await temp.disposeAsync(root); });

  it("classifies all four exact paths over the whole push, independently of the commit subject", () => {
    expect(run("classify", code).stdout.trim()).toBe("records-only=true");
    expect(run("classify", size).stdout.trim()).toBe("records-only=true");
    expect(run("classify", git("rev-parse", code + "^")).stdout.trim()).toBe("records-only=false");
  });

  it("keeps dispatches, other refs, empty diffs and unknown bases on the full path", () => {
    for (const [before, env] of [
      [size, { GITHUB_EVENT_NAME: "workflow_dispatch" }], [size, { GITHUB_REF: "refs/heads/other" }],
      [head, {}], ["0".repeat(40), {}], ["", {}],
    ] as const) expect(run("classify", before, env).stdout.trim()).toBe("records-only=false");
  });

  function source(responses: Record<string, unknown>) {
    writeFileSync(join(root, "bin/responses.json"), JSON.stringify(responses));
    return run("source", size, { PYTHONPATH: join(root, "bin") });
  }
  function fixture(override: Record<string, unknown> = {}, measured = code) {
    const main = { path: ".github/workflows/ci.yml", event: "push", head_branch: "main",
      head_repository: { full_name: repo }, run_attempt: 1 };
    const jobs = (plan: string) => ({ jobs: [
      { name: "postgres-image", conclusion: "success", run_attempt: 1 }, { name: "plan", conclusion: plan, run_attempt: 1 },
      { name: "test (1/1)", conclusion: plan, run_attempt: 1 },
    ] });
    return {
      [runsAt(size)]: { workflow_runs: [{ ...main, id: 22, head_sha: size, status: "in_progress" }] },
      [runsAt(runless)]: { workflow_runs: [] },
      [runsAt(code)]: { workflow_runs: [] },
      [runsAt(measured)]: { workflow_runs: [{ ...main, id: 11, head_sha: measured, status: "completed", conclusion: "success", ...override }] },
      [actions + "runs/22/jobs?filter=all&per_page=100&page=1"]: jobs("skipped"),
      [actions + "runs/11/jobs?filter=all&per_page=100&page=1"]: jobs("success"),
      [actions + "runs/11/artifacts?per_page=100&page=1"]: { artifacts: [{ name: "test-ratchet-cell-1_1", expired: false }] },
    };
  }

  it("finds the tested push past both a running record report and a runless commit in that push", () => {
    const result = source(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("run-id=11");
  });

  it("waits for the original push to finish before passing its artifacts to report", () => {
    const responses = { ...fixture({ status: "in_progress", conclusion: null }),
      [actions + "runs/11"]: { status: "completed", conclusion: "success" } };
    const result = source(responses);
    expect(result.stderr).toContain("Waiting for ci run 11");
    expect(result.stdout.trim()).toBe("run-id=11");
  });

  it("waits for the preceding push to appear in the workflow runs listing", () => {
    const responses = fixture();
    expect(source({ ...responses, [runsAt(size)]: [{ workflow_runs: [] }, responses[runsAt(size)]] }).stdout.trim()).toBe("run-id=11");
  });

  it("uses the successful rerun of a shard that failed on the first attempt", () => {
    const jobs = [{ name: "plan", conclusion: "success", run_attempt: 1 },
      { name: "test (1/1)", conclusion: "failure", run_attempt: 1 }, { name: "test (1/1)", conclusion: "success", run_attempt: 2 }];
    expect(source({ ...fixture({ run_attempt: 2 }), [actions + "runs/11/jobs?filter=all&per_page=100&page=1"]: { jobs } }).stdout.trim()).toBe("run-id=11");
  });

  it("refuses a successful run from before a runless code change", () => {
    const result = source(fixture({}, git("rev-parse", code + "^")));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("run 11 is not a main push over the same code");
  });

  it("refuses incomplete artifacts, including a shard that expired since the original CI run", () => {
    const responses = fixture();
    const key = `repos/${repo}/actions/runs/11/artifacts?per_page=100&page=1`;
    for (const artifacts of [[], [{ name: "test-ratchet-cell-1_1", expired: true }]]) {
      const result = source({ ...responses, [key]: { artifacts } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("0 artifacts for 1 shards");
    }
  });

  it.each([{ conclusion: "failure" }, { event: "pull_request" }, { head_branch: "other" },
    { path: ".github/workflows/pr-suite.yml" }, { head_sha: "0".repeat(40) }, { head_repository: { full_name: "other/fork" } }])(
    "refuses artifacts with mismatched provenance or an unsuccessful run %o", override => {
      const result = source(fixture(override));
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("run-id=");
    });

  it("counts both sides of a rename into the allowlist, including a newline in the old path", () => {
    try {
      git("checkout", "-q", "--detach", code);
      mkdirSync(join(root, ".github"), { recursive: true });
      git("mv", "source\nfile.ts", records[3]!);
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "rename");
      expect(run("classify", code).stdout.trim()).toBe("records-only=false");
    } finally {
      git("checkout", "-q", "--detach", head);
    }
  });
});

interface Step { id?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string | string[]; steps: Step[]; outputs?: Record<string, string> }
function workflow(file: string): { on: { push: unknown }; jobs: Record<string, Job> } {
  return parse(readFileSync(`.github/workflows/${file}.yml`, "utf8"));
}

describe("main push workflow routing", () => {
  const ci = workflow("ci").jobs;
  const scan = workflow("code-scanning").jobs;
  it("uses the same diff on main for the planner, test matrix, artifact lookup and CodeQL", () => {
    for (const job of [ci["postgres-image"]!, scan.changes!]) {
      expect(job.steps).toContainEqual(expect.objectContaining({ id: "changes",
        env: { OVERFLOW_BEFORE_SHA: "${{ github.event.before }}" }, run: 'python3 scripts/ci_records.py classify >> "$GITHUB_OUTPUT"' }));
      expect(job.outputs?.["records-only"]).toBe("${{ steps.changes.outputs.records-only }}");
    }
    for (const job of [ci.plan!, ci.test!]) expect(job.if).toBe("needs.postgres-image.outputs.records-only != 'true'");
    expect(ci["record-source"]!.if).toBe("needs.postgres-image.outputs.records-only == 'true'");
    expect(ci["record-source"]!.steps.at(-1)?.run).toBe('python3 scripts/ci_records.py source >> "$GITHUB_OUTPUT"');
    expect(scan.changes!.if).toBe("github.event_name == 'push'");
  });

  it("runs report after the record source has succeeded on a record-only push", () => {
    expect(ci.report!.needs).toEqual(["postgres-image", "test", "record-source"]);
    expect(ci.report!.if).toBe("${{ !cancelled() && (needs.postgres-image.outputs.records-only != 'true' || needs.record-source.result == 'success') }}");
  });

  it("passes the record source's declared outputs from real steps to inputs of dependent jobs", () => {
    const name = "record-source";
    const producer = ci[name]!;
    const consumers = Object.values(ci).filter(job => [job.needs].flat().includes(name));
    const reads = consumers.flatMap(job => job.steps.flatMap(step => Object.values(step.with ?? {})))
      .flatMap(input => typeof input === "string" ? [...input.matchAll(/\bneeds\.([\w-]+)\.outputs\.([\w-]+)/g)] : []);
    const outputs = Object.entries(producer.outputs ?? {});
    expect(outputs.length).toBeGreaterThan(0);
    for (const [output, expression] of outputs) {
      const step = /\bsteps\.([\w-]+)\.outputs\.[\w-]+/.exec(expression);
      expect(step, expression).not.toBeNull();
      expect(producer.steps.map(item => item.id)).toContain(step![1]);
      expect(reads.some(([, job, key]) => job === name && key === output), output).toBe(true);
    }
  });

  it("keeps every required producer on all main pushes and rejects unexpected skips in verify", () => {
    const required = JSON.parse(readFileSync(".github/required-checks.json", "utf8")) as Record<string, string[]>;
    for (const [context, paths] of Object.entries(required)) {
      const file = paths.find(path => workflow(path.split("/").pop()!.replace(".yml", "")).on.push);
      const push = parse(readFileSync(file!, "utf8"));
      expect(push.on.push.branches).toContain("main");
      expect(Object.keys(push.on.push)).toEqual(["branches"]);
      expect(push.jobs[context].if).toBe(context === "verify" ? "${{ always() }}" : undefined);
    }
    const step = ci.verify!.steps[0]!;
    expect(step.env).toEqual({ OVERFLOW_RECORDS_ONLY: "${{ needs.postgres-image.outputs.records-only }}",
      OVERFLOW_SOURCE_RESULT: "${{ needs.record-source.result }}", OVERFLOW_TEST_RESULT: "${{ needs.test.result }}",
      OVERFLOW_REPORT_RESULT: "${{ needs.report.result }}" });
    for (const [records, test, source, report, status] of [
      ["false", "success", "skipped", "success", 0], ["true", "skipped", "success", "success", 0],
      ["false", "skipped", "skipped", "success", 1], ["true", "skipped", "failure", "success", 1],
      ["true", "skipped", "success", "failure", 1], ["false", "failure", "skipped", "success", 1],
    ] as const) {
      expect(spawnSync("bash", ["-ec", step.run!], { env: { NODE_ENV: "test", OVERFLOW_RECORDS_ONLY: records,
        OVERFLOW_TEST_RESULT: test, OVERFLOW_SOURCE_RESULT: source, OVERFLOW_REPORT_RESULT: report } }).status).toBe(status);
    }
  });
});
