import { spawnSync, type SpawnSyncReturns as SpawnResult } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Base freshness gate is shell in scripts/ci-base-freshness.sh, and its
 * interesting decisions — pass, fail, or refuse to judge — are all made against
 * GitHub API responses. This suite exercises the real script end to end with a
 * stubbed gh: a temp directory whose fake gh answers each endpoint's --jq query
 * from canned per-case data, so every verdict below is the script's actual exit
 * code and output against a controlled API.
 *
 * The stub answers ONLY the four query shapes the script may issue and fails
 * loudly (exit 3) on anything else, so a script that mis-wires an endpoint gets
 * a nonzero exit and a failed assertion instead of plausible-looking data.
 *
 * The gate must fail closed: every uncertain outcome — an API failure, an empty
 * response, an unrepresentable compare — is a refusal, never a pass (issue 510).
 * The pass certificates and the shared-file failure are the only honest
 * verdicts; everything else is a refusal.
 */
describe("scripts/ci-base-freshness.sh", () => {
  const scriptPath = join(".", "scripts", "ci-base-freshness.sh");

  const BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const CURRENT_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const HEAD_SHA = "cccccccccccccccccccccccccccccccccccccccc";
  const REPO_SLUG = "Nitjsefnie/Overflow";
  const BASE_REF = "main";

  type StubConfig = {
    /** Response body for `--jq .sha` — the current tip of the base ref. */
    currentSha?: string;
    /** When set, the stub gh exits 1 with a message instead of answering. */
    ghFails?: boolean;
    /** Response body for `--jq '.total_commits'` on the compare endpoint. */
    totalCommits?: string;
    /** Response lines for `--jq '.files[].filename'` on the compare endpoint. over
     * over
     */
    advanceFiles?: string[];
    /** Response lines for `--jq '.[].filename'` on the pull request files endpoint. */
    prFiles?: string[];
  };

  let tempRoot = "";
  let tempCounter = 0;

  type RunOptions = { env?: Record<string, string | undefined> };

  async function runScript(config: StubConfig, options: RunOptions = {}): Promise<SpawnResult<string>> {
    tempCounter += 1;
    const stubDir = join(tempRoot, `stub-${tempCounter}`);
    await mkdir(stubDir, { recursive: true });
    const stub = join(stubDir, "gh");
    await writeFile(
      stub,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ -n "${STUB_FAIL:-}" ]; then',
        '  echo "stub gh: simulated API failure" >&2',
        "  exit 1",
        "fi",
        'if [ -n "${STUB_SILENT:-}" ]; then',
        "  exit 0",
        "fi",
        'jq=""',
        'prev=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "--jq" ]; then jq="$a"; fi',
        '  prev="$a"',
        "done",
        'case "$jq" in',
        '  ".sha") printf \'%s\\n\' "${STUB_CURRENT_SHA:-}" ;;',
        '  ".total_commits") printf \'%s\\n\' "${STUB_TOTAL_COMMITS:-}" ;;',
        '  ".files[].filename") if [ -n "${STUB_ADVANCE_FILES:-}" ]; then printf \'%s\\n\' "$STUB_ADVANCE_FILES"; fi ;;',
        '  ".[].filename") if [ -n "${STUB_PR_FILES:-}" ]; then printf \'%s\\n\' "$STUB_PR_FILES"; fi ;;',
        '  *) echo "stub gh: unexpected query: $jq" >&2; exit 3 ;;',
        "esac",
      ].join("\n") + "\n",
      "utf8",
    );
    await chmod(stub, 0o755);

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      "GH_TOKEN", "REPO_SLUG", "BASE_SHA", "BASE_REF", "PR_NUMBER", "HEAD_SHA",
      "STUB_FAIL", "STUB_SILENT", "STUB_CURRENT_SHA", "STUB_TOTAL_COMMITS",
      "STUB_ADVANCE_FILES", "STUB_PR_FILES",
    ]) {
      delete env[key];
    }
    Object.assign(env, {
      GH_TOKEN: "stub-token",
      REPO_SLUG: REPO_SLUG,
      BASE_SHA: BASE_SHA,
      BASE_REF: BASE_REF,
      PR_NUMBER: "510",
      HEAD_SHA: HEAD_SHA,
      STUB_CURRENT_SHA: config.currentSha ?? CURRENT_SHA,
      STUB_TOTAL_COMMITS: config.totalCommits ?? "1",
      STUB_ADVANCE_FILES: (config.advanceFiles ?? []).join("\n"),
      STUB_PR_FILES: (config.prFiles ?? []).join("\n"),
      STUB_FAIL: config.ghFails ? "1" : "",
    });
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
    // The stub answers for gh: put its directory ahead of PATH so the script
    // can never reach the real binary.
    env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;

    return spawnSync("bash", [scriptPath], { cwd: ".", env, encoding: "utf8" });
  }

  const output = (result: SpawnResult<string>): string => `${result.stdout}\n${result.stderr}`;

  beforeAll(async () => {
    tempRoot = join(tmpdir(), `base-freshness-${process.pid}-${Date.now()}`);
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("certifies an unchanged base and exits 0", async () => {
    const result = await runScript({
      currentSha: BASE_SHA,
      advanceFiles: ["docs/unrelated.md"],
      prFiles: ["src/app/page.tsx"],
    });

    expect(result.status, "the unchanged base must pass").toBe(0);
    expect(output(result), "the unchanged-base certificate must say the base is unchanged").toMatch(/unchanged/i);
  });

  it("certifies a disjoint advance and names the advance range", async () => {
    const result = await runScript({
      currentSha: CURRENT_SHA,
      totalCommits: "2",
      advanceFiles: ["docs/other.md", "README.md"],
      prFiles: ["src/app/page.tsx", "src/lib/x.ts"],
    });

    expect(result.status, "a disjoint advance must pass").toBe(0);
    expect(output(result), "the certificate must be auditable: it names the advance range").toContain(BASE_SHA);
    expect(output(result)).toContain(CURRENT_SHA);
    expect(output(result), "the certificate must state the advance is disjoint from the PR's files").toMatch(/disjoint/i);
  });

  it("fails an overlapping advance, naming the shared file", async () => {
    const result = await runScript({
      currentSha: CURRENT_SHA,
      totalCommits: "2",
      advanceFiles: ["src/app/page.tsx", "docs/other.md"],
      prFiles: ["src/app/page.tsx", "src/lib/x.ts"],
    });

    expect(result.status, "an advance sharing a PR file must fail the gate").not.toBe(0);
    expect(output(result), "the failure must name the shared file").toContain("src/app/page.tsx");
  });

  it("fails closed when the gh call for the base tip fails", async () => {
    const result = await runScript({ ghFails: true });

    expect(result.status, "an API failure is uncertainty and must refuse").not.toBe(0);
  });

  it("fails closed when the gh call succeeds but returns no base tip", async () => {
    const result = await runScript({ currentSha: "" });

    expect(result.status, "an empty response is uncertainty and must refuse").not.toBe(0);
  });

  it("fails closed when the PR reports no changed files while the base advanced", async () => {
    const result = await runScript({
      currentSha: CURRENT_SHA,
      totalCommits: "1",
      advanceFiles: ["docs/other.md"],
      prFiles: [],
    });

    expect(result.status, "an empty PR file list cannot prove disjointness").not.toBe(0);
  });

  it("fails closed when the compare reports exactly 300 files — the truncation bound", async () => {
    const result = await runScript({
      currentSha: CURRENT_SHA,
      totalCommits: "50",
      advanceFiles: Array.from({ length: 300 }, (_, i) => `dir${i % 7}/file-${String(i).padStart(3, "0")}.txt`),
      prFiles: ["src/app/page.tsx"],
    });

    expect(result.status, "a 300-file compare is the API's truncation bound, not a witnessed list").not.toBe(0);
  });

  it("fails closed when the compare carries more than 200 commits", async () => {
    const result = await runScript({
      currentSha: CURRENT_SHA,
      totalCommits: "201",
      advanceFiles: ["docs/other.md"],
      prFiles: ["src/app/page.tsx"],
    });

    expect(result.status, "a >200-commit advance is too large to certify as irrelevant").not.toBe(0);
  });

  it("fails closed when PR_NUMBER is not provided", async () => {
    const result = await runScript(
      { currentSha: CURRENT_SHA, totalCommits: "1", advanceFiles: ["third.md"], prFiles: ["src/app/page.tsx"] },
      { env: { PR_NUMBER: undefined } },
    );

    expect(result.status, "no PR number means the PR's file list cannot be fetched").not.toBe(0);
  });
});
