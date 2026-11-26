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

describe("ratchet record pushes", () => {
  let root: string;
  let code: string;
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
    writeFileSync(join(root, "code"), "original");
    commit();
    writeFileSync(join(root, "code"), "tested code");
    code = commit();
    writeFileSync(join(root, records[0]!), "size");
    size = commit();
    for (const file of records.slice(1)) writeFileSync(join(root, file), "record");
    head = commit();
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin/gh"), `#!/usr/bin/env python3
import json, os, sys
assert sys.argv[1] == "api"
print(json.dumps(json.loads(os.environ["RESPONSES"])[sys.argv[2]]))
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

  function fixture(source: Record<string, unknown> = {}) {
    const actions = `repos/${repo}/actions/`;
    const at = (sha: string) => actions + `workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}`;
    const main = { path: ".github/workflows/ci.yml", event: "push", head_branch: "main",
      head_repository: { full_name: repo }, run_attempt: 1 };
    const jobs = (plan: string) => ({ jobs: [
      { name: "postgres-image", conclusion: "success", run_attempt: 1 }, { name: "plan", conclusion: plan, run_attempt: 1 },
      { name: "test (1/1)", conclusion: plan, run_attempt: 1 },
    ] });
    return {
      [at(size)]: { workflow_runs: [{ ...main, id: 22, head_sha: size, status: "in_progress" }] },
      [at(code)]: { workflow_runs: [{ ...main, id: 11, head_sha: code, status: "completed", conclusion: "success", ...source }] },
      [actions + "runs/22/jobs?filter=all&per_page=100&page=1"]: jobs("skipped"),
      [actions + "runs/11/jobs?filter=all&per_page=100&page=1"]: jobs("success"),
      [actions + "runs/11/artifacts?per_page=100&page=1"]: { artifacts: [{ name: "test-ratchet-cell-1_1", expired: false }] },
    };
  }

  it("reuses the tested push's artifacts through an intervening record push whose report is still running", () => {
    const result = run("source", size, { RESPONSES: JSON.stringify(fixture()) });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("run-id=11");
  });

  it("waits for the original push to finish before passing its artifacts to report", () => {
    const actions = `repos/${repo}/actions/`;
    const responses = { ...fixture({ status: "in_progress", conclusion: null }),
      [actions + "runs/11"]: { status: "completed", conclusion: "success" } };
    const clock = join(root, "bin");
    writeFileSync(join(clock, "sitecustomize.py"), "import time\ntime.sleep = lambda seconds: None\n");
    const result = run("source", size, { RESPONSES: JSON.stringify(responses), PYTHONPATH: clock });
    expect(result.stderr).toContain("Waiting for ci run 11");
    expect(result.stdout.trim()).toBe("run-id=11");
  });

  it("refuses incomplete artifacts, including a shard that expired since the original CI run", () => {
    const responses = fixture();
    const key = `repos/${repo}/actions/runs/11/artifacts?per_page=100&page=1`;
    for (const artifacts of [[], [{ name: "test-ratchet-cell-1_1", expired: true }]]) {
      const result = run("source", size, { RESPONSES: JSON.stringify({ ...responses, [key]: { artifacts } }) });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("0 artifacts for 1 shards");
    }
  });

  it.each([{ conclusion: "failure" }, { event: "pull_request" }, { head_branch: "other" },
    { path: ".github/workflows/pr-suite.yml" }, { head_sha: "0".repeat(40) }, { head_repository: { full_name: "other/fork" } }])(
    "refuses artifacts with mismatched provenance or an unsuccessful run %o", override => {
      const result = run("source", size, { RESPONSES: JSON.stringify(fixture(override)) });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("run-id=");
    });

  it("counts both sides of a rename into the allowlist, including a newline in the old path", () => {
    const unusual = "other\npath";
    try {
      writeFileSync(join(root, unusual), "new record");
      const before = commit();
      git("mv", "-f", unusual, records[0]!);
      commit();
      expect(run("classify", before).stdout.trim()).toBe("records-only=false");
    } finally {
      git("checkout", "-q", "--detach", head);
    }
  });
});

interface Step { name?: string; run?: string; if?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string | string[]; steps: Step[]; outputs?: Record<string, string> }
function workflow(file: string): { on: { push: unknown }; jobs: Record<string, Job> } {
  return parse(readFileSync(`.github/workflows/${file}.yml`, "utf8"));
}

describe("main push workflow routing", () => {
  const ci = workflow("ci").jobs;
  const scan = workflow("code-scanning").jobs;
  it("uses the same diff on main for the planner, test matrix, artifact lookup and CodeQL", () => {
    for (const job of [ci["postgres-image"]!, scan.changes!]) {
      expect(job.steps[0]!.with).toMatchObject({ "fetch-depth": 0, "persist-credentials": false });
      expect(job.steps).toContainEqual(expect.objectContaining({ id: "changes",
        env: { OVERFLOW_BEFORE_SHA: "${{ github.event.before }}" }, run: 'python3 scripts/ci_records.py classify >> "$GITHUB_OUTPUT"' }));
      expect(job.outputs?.["records-only"]).toBe("${{ steps.changes.outputs.records-only }}");
    }
    for (const job of [ci.plan!, ci.test!]) expect(job.if).toBe("needs.postgres-image.outputs.records-only != 'true'");
    expect(ci["record-source"]!.if).toBe("needs.postgres-image.outputs.records-only == 'true'");
    expect(ci["record-source"]!.steps.at(-1)?.run).toBe('python3 scripts/ci_records.py source >> "$GITHUB_OUTPUT"');
    expect(scan.changes!.if).toBe("github.event_name == 'push'");
  });

  it("reports on the current tip with the ancestor run's artifacts and the original push write and rise checks", () => {
    expect(ci.report!.needs).toEqual(["postgres-image", "test", "record-source"]);
    expect(ci.report!.if).toBe("${{ !cancelled() && (needs.postgres-image.outputs.records-only != 'true' || needs.record-source.result == 'success') }}");
    const [checkout, report] = ci.report!.steps;
    expect(checkout?.with?.ref).toBe("${{ github.sha }}");
    expect(report?.uses).toMatch(/^Nitjsefnie-Actions\/test-ratchet\/report@/);
    expect(report?.with).toMatchObject({ "run-id": "${{ needs.record-source.outputs.run-id || github.run_id }}",
      "records-only-rise": "true", times: ".github/test-times.json", "push-key": "${{ secrets.MASTER_PUSH_DEPLOY_KEY }}" });
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
      expect(spawnSync("bash", ["-ec", step.run!], { env: { OVERFLOW_RECORDS_ONLY: records,
        OVERFLOW_TEST_RESULT: test, OVERFLOW_SOURCE_RESULT: source, OVERFLOW_REPORT_RESULT: report } }).status).toBe(status);
    }
  });
});
