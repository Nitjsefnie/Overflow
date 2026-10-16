// The deploy-revision fixture shared by tests/deploy/deploy-revision.test.ts
// and tests/deploy/deploy-revision-ledger.test.ts: the script path, the
// command shims and their log, the gate-state writers, and the deploy runner.
// Extracted so each measured test module stays under the tests family ceiling
// (scripts/check-module-size.ts).
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const script = fileURLToPath(new URL("../../scripts/deploy-revision.sh", import.meta.url));
/**
 * The gate's jq parser, tracked beside the script so the map and the code
 * that knows its shape travel together (issue 1104). The fixture tree holds
 * the repository's current bytes at this path, exactly as for the script.
 */
export const parser = fileURLToPath(new URL("../../scripts/required-checks-parse.jq", import.meta.url));
/**
 * The refusal the procedure's serialization notes mandate, byte for byte, with
 * the lock spelled as configured. Production defaults to /run/overflow-deploy.lock;
 * the behavioral test substitutes the fixture lock.
 */
export const REFUSAL_TEMPLATE =
  "Could not acquire the deploy lock on %LOCK%; refusing to deploy. Consult the deploy procedure's serialization notes before re-running.";

export const DEFAULT_LOCK = "/run/overflow-deploy.lock";

export function refusalFor(lock: string): string {
  return REFUSAL_TEMPLATE.replace("%LOCK%", lock);
}

/**
 * A shim executable: logs one tab-separated line per invocation — command,
 * arguments, then an env capture — and then either exits with a status the
 * test set or delegates to the real binary. Nothing here reaches the network,
 * systemd, the shared pnpm store or any tree outside the fixture, and every
 * invocation is bounded by spawnSync's timeout.
 */
export function shimBody(name: string, envKeys: string[], dispatch: string): string {
  const envCapture = ["LC_ALL", ...envKeys]
    .map((key) => `envs+=" ${key}=\${${key}-}"`)
    .join("\n");
  return `#!/usr/bin/env bash
line="${name}"
for a in "$@"; do line+=$'\\t'"$a"; done
envs=""
${envCapture}
printf '%s\\tenv\\t%s\\n' "$line" "$envs" >> "\${SHIM_LOG:?}"
${dispatch}
`;
}

export interface ShimLogEntry {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export interface Fixture {
  dir: string;
  tree: string;
  envFile: string;
  lock: string;
  unit: string;
  url: string;
  logDir: string;
  bins: string;
  shimLog: string;
  prevDir: string;
  protectionJson: string;
  requiredChecks: string;
  gateSuccess: string;
}

let liveFixture: Fixture | undefined;

/** Removes the live fixture (makeFixture's temp dir), if a test left one. */
export async function cleanupLiveFixture(): Promise<void> {
  if (liveFixture) await rm(liveFixture.dir, { recursive: true, force: true });
  liveFixture = undefined;
}

export const FIXTURE_UNIT = "overflow-fixture.service";
export const FIXTURE_URL = "http://127.0.0.1:39999/deploy-fixture";
export const FIXTURE_HASH = "abc1234";
export const FIXTURE_REPO = "overflow-fixture/overflow-fixture";
export const FIXTURE_REMOTE_URL = `git@github.com:${FIXTURE_REPO}.git`;
export const JQ_CHECKRUNS = `.check_runs[] | [.id, .name, (.app.id // 0), (.status // "unknown"), (.conclusion // "")] | map(if . == null or . == "" then "[missing]" else . end) | @tsv`;
export const JQ_RUNS = `.workflow_runs[] | [.id, .path, .event, .head_branch] | map(if . == null or . == "" then "[missing]" else . end) | @tsv`;
export const JQ_JOBS = `.jobs[] | [.id, (if (.name // "") == "" then "(unnamed)" else .name end), (.run_attempt // 0), (.status // "unknown"), (.conclusion // "")] | map(if . == null or . == "" then "[missing]" else . end) | @tsv`;
export const MAP_PATH = ".github/required-checks.json";
/** The fixture's pin map: protection requires verify and deploy-gate. */
export const FIXTURE_PINS: Record<string, string> = {
  verify: ".github/workflows/ci.yml",
  "deploy-gate": ".github/workflows/deploy-gate.yml",
};
/** Where each fixture check's job runs; claim is a workflow nothing pins. */
export const FIXTURE_WORKFLOWS: Record<string, string> = {
  ...FIXTURE_PINS,
  claim: ".github/workflows/claim.yml",
};
export const FIXTURE_RUN_IDS: Record<string, number> = {
  ".github/workflows/ci.yml": 100,
  ".github/workflows/deploy-gate.yml": 200,
  ".github/workflows/claim.yml": 300,
};
/** GitHub Actions' app id on GitHub.com: the producer of every Actions job's own check-run. */
export const ACTIONS_APP_ID = 15368;
/**
 * The Overflow Ledger App's id: check-runs it posts attribute a required
 * context to the relay that produced them. Matches the script's knob default;
 * the override is exercised by its own test.
 */
export const LEDGER_APP_ID = 5118623;

/**
 * The gate's reads in call order when one poll iteration settles it on `sha`
 * with the fixture's pinned runs (100 and 200): protection, branch rules, the pin map at the
 * SHA, every check-run, the workflow runs, and the jobs of each pinned run.
 */
export function gateReads(sha: string): string[] {
  return [
    `gh api repos/${FIXTURE_REPO}/branches/main/protection --include`,
    `gh api repos/${FIXTURE_REPO}/rules/branches/main --include`,
    `git show ${sha}:${MAP_PATH}`,
    `gh api repos/${FIXTURE_REPO}/commits/${sha}/check-runs?filter=all&per_page=100 --paginate --jq ${JQ_CHECKRUNS}`,
    `gh api repos/${FIXTURE_REPO}/actions/runs?head_sha=${sha}&per_page=100 --paginate --jq ${JQ_RUNS}`,
    ...[100, 200].map(
      (id) => `gh api repos/${FIXTURE_REPO}/actions/runs/${id}/jobs?filter=all&per_page=100 --paginate --jq ${JQ_JOBS}`,
    ),
  ];
}

export interface GateJob {
  id: number;
  name: string;
  attempt?: number;
  status: string;
  conclusion?: string;
}

export interface GateRun {
  id: number;
  path: string;
  /** Omitted fixtures model main pushes; null models a missing API event. */
  event?: string | null;
  /** Omitted fixtures model main; null models a missing API head branch. */
  headBranch?: string | null;
  jobs: GateJob[];
}

/** A check-run as the gate's check-runs read projects it: id, name, app id, status, conclusion. */
export interface GateCheckRun {
  id: number;
  name: string;
  app?: number;
  status?: string;
  conclusion?: string;
}

/**
 * Writes one poll iteration's GitHub JSON for the gh shim to project with jq. A
 * job's check-run shares its id, as on GitHub; `extraCheckRuns` are check-runs
 * no job produced (created through the Checks API or by an App).
 */
export async function writeGateState(
  fixture: Pick<Fixture, "dir">,
  name: string,
  runs: GateRun[],
  extraCheckRuns: GateCheckRun[] = [],
): Promise<string> {
  const directory = path.join(fixture.dir, name);
  await mkdir(directory);
  await writeFile(path.join(directory, "runs.json"), JSON.stringify({ workflow_runs: runs.map((run) => ({
    id: run.id, path: run.path, event: run.event === undefined ? "push" : run.event,
    head_branch: run.headBranch === undefined ? "main" : run.headBranch,
  })) }));
  for (const run of runs) {
    await writeFile(
      path.join(directory, `jobs-${run.id}.json`),
      JSON.stringify({ jobs: run.jobs.map((job) => ({ id: job.id, name: job.name,
        run_attempt: job.attempt ?? 1, status: job.status, conclusion: job.conclusion ?? null })) }),
    );
  }
  const jobCheckRun = (job: GateJob): GateCheckRun => ({
    id: job.id,
    name: job.name,
    app: ACTIONS_APP_ID,
    status: job.status,
    conclusion: job.conclusion,
  });
  const checkRuns = [...runs.flatMap((run) => run.jobs.map(jobCheckRun)), ...extraCheckRuns];
  await writeFile(
    path.join(directory, "check-runs.json"),
    JSON.stringify({ check_runs: checkRuns.map((cr) => {
        const status = cr.status ?? "completed";
        // GitHub leaves a non-completed check-run's conclusion null; the
        // deploy query maps missing outcomes to its sentinel. Deliberate fixture
        // shape: a completed job with no explicit conclusion is written as ""
        // in the jobs JSON but as success in its check-run body, so the fixture
        // does not silently assert a disagreement the real API never produces.
        const conclusion = cr.conclusion ?? (status === "completed" ? "success" : "");
        return { id: cr.id, name: cr.name, app: { id: cr.app ?? ACTIONS_APP_ID }, status, conclusion };
      }) }),
  );
  return directory;
}

/**
 * The common case: one run per workflow, one job per row, each job in the
 * workflow FIXTURE_WORKFLOWS places it in.
 */
export async function writeCheckRuns(
  fixture: Pick<Fixture, "dir">,
  name: string,
  rows: Array<[string, string, string?]>,
): Promise<string> {
  const runs = new Map<string, GateRun>();
  for (const [check, status, conclusion] of rows) {
    const workflow = FIXTURE_WORKFLOWS[check]!;
    const runId = FIXTURE_RUN_IDS[workflow]!;
    const run = runs.get(workflow) ?? { id: runId, path: workflow, jobs: [] };
    run.jobs.push({ id: runId * 10 + run.jobs.length + 1, name: check, status, conclusion });
    runs.set(workflow, run);
  }
  return writeGateState(fixture, name, [...runs.values()]);
}

/** A branch-rules response projected by the gh shim with the real jq query. */
export async function writeBranchRules(fixture: Pick<Fixture, "dir">, contexts: string[]): Promise<string> {
  const file = path.join(fixture.dir, "rules.json");
  await writeFile(file, JSON.stringify([
    { type: "required_status_checks", parameters: { required_status_checks:
      contexts.map((context) => ({ context, integration_id: 123 })) } },
    { type: "pull_request", parameters: {} },
  ]));
  return file;
}

export const RELEASE_GRAMMAR = /^\.next-release-\d{8}T\d{6}Z-[a-f0-9]{7,40}$/;
export const LISTING_REGEX = String.raw`.*/\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}`;
/** The ignored-files gate's read, as the shim log records it. */
export const IGNORED_LISTING = "git ls-files -z --others --ignored --exclude-standard --directory --no-empty-directory";
/**
 * Every ignored untracked entry production's tree legitimately holds, in the
 * shape `git ls-files --others --ignored --directory` prints it: directories
 * carry a trailing slash, the .next symlink does not.
 *
 * `.claude/` is this repository's own session machinery (the autoloaded working
 * rules and the priority board). The checkout a deploy is invoked from may carry
 * it, ignored, so an operator must not have to delete it to deploy. It is
 * allowlisted as a directory entry with its trailing slash, so nothing below it
 * is admitted by name and no sibling one edit away matches.
 */
export const OPERATIONAL_IGNORED = [
  ".next",
  ".next/",
  ".claude/",
  ".next-release-20260908T000000Z-abc1234/",
  ".next-release-20260908T000000Z-0123456789abcdef0123456789abcdef01234567/",
  ".next-release-20260908T000000Z-abc1234.tsconfig.json",
  ".next-release-notes/",
  "next-env.d.ts",
  "node_modules/",
];
/**
 * Names one edit away from an allowlisted entry, each of which must refuse:
 * together they pin that every allowlist entry matches the whole path, from
 * the tree root, with the release grammar exactly.
 */
export const NEAR_MISS_IGNORED = [
  ".claude",
  ".claude-rules/",
  ".claudex",
  "src/.claude/",
  ".next-release-bogus/",
  ".next-switch-abc1234",
  ".next-release-20260908T000000Z-abc1234",
  ".next-release-20260908T000000Z-ABC1234/",
  ".next-release-20260908T000000Z-abc123/",
  ".next-release-2026090T000000Z-abc1234/",
  ".next-release-20260908T000000Z-abc1234/x",
  ".next-release-20260908T000000Z-abc1234.tsconfig.json.bak",
  "x.next-release-notes/",
  "src/node_modules/",
  "node_modules",
  "src/next-env.d.ts",
  "next-env.d.tsx",
  "src/.next",
  ".nextx",
  "src/app/zz-probe/",
];

/**
 * The offending paths the ignored-files refusal lists: the run of lines
 * directly above its message, each indented by exactly two spaces (%q escapes
 * a leading space, so a path never starts with one). A real git fetch writes
 * its ref updates to the same stream just before, indented further.
 */
export function listedOffenders(stderr: string): string[] {
  const lines = stderr.split("\n");
  const offenders: string[] = [];
  for (let at = lines.findIndex((line) => line.startsWith("The tree in ")) - 1; at >= 0; at--) {
    if (!/^ {2}\S/.test(lines[at]!)) break;
    offenders.unshift(lines[at]!.slice(2));
  }
  return offenders;
}

export async function makeRelease(tree: string, name: string): Promise<string> {
  const directory = path.join(tree, name);
  await mkdir(path.join(directory, "cache"), { recursive: true });
  await writeFile(path.join(directory, "BUILD_ID"), name);
  return directory;
}

export async function makeFixture(options: {
  prevRelease?: string;
  extraReleases?: string[];
  servingCache?: boolean;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "overflow-deploy-revision-"));
  const tree = path.join(dir, "tree");
  await mkdir(tree);
  const prevName = options.prevRelease ?? ".next-release-20260908T000000Z-abc1234";
  const prevDir = await makeRelease(tree, prevName);
  if (options.servingCache === false) {
    await rm(path.join(prevDir, "cache"), { recursive: true });
  }
  for (const name of options.extraReleases ?? [
    ".next-release-20260907T000000Z-def5678",
    ".next-release-20260906T000000Z-abc1234",
    ".next-release-20260801T000000Z-def5678",
  ]) {
    await makeRelease(tree, name);
  }
  // Production's .next is a relative symlink to the serving release; keep the
  // fixture in the same shape so the anchor exercises real readlink resolution.
  await symlink(path.basename(prevDir), path.join(tree, ".next"));
  // The post-fast-forward half executes $tree's own copy of the deploy script
  // (issue 747), so the fixture tree holds the repository's current bytes at
  // that path. The gate parses the pin map with the tree's own copy of the
  // parser beside it (issue 1104), so that path is carried the same way.
  await mkdir(path.join(tree, "scripts"));
  await writeFile(path.join(tree, "scripts", "deploy-revision.sh"), await readFile(script, "utf8"));
  await writeFile(path.join(tree, "scripts", "required-checks-parse.jq"), await readFile(parser, "utf8"));
  const envFile = path.join(dir, "overflow.env");
  await writeFile(envFile, "OVERFLOW_FIXTURE_ENV_MARKER=loaded\n");
  const logDir = path.join(dir, "logs");
  const bins = path.join(dir, "bins");
  await mkdir(logDir);
  await mkdir(bins);
  // Discovery returns raw JSON with HTTP headers; the real gate parses it.
  // Later gate-state reads retain gh's --jq projection with real jq.
  const protectionJson = path.join(dir, "protection.json");
  await writeFile(protectionJson, JSON.stringify({ required_status_checks: {
    contexts: ["verify", "deploy-gate"], checks: [],
  } }));
  const requiredChecks = path.join(dir, "required-checks.json");
  await writeFile(requiredChecks, JSON.stringify(FIXTURE_PINS, null, 2) + "\n");
  const gateSuccess = await writeCheckRuns({ dir }, "gate-success", [
    ["verify", "completed", "success"],
    ["deploy-gate", "completed", "success"],
    ["claim", "completed", "success"],
  ]);
  const fixture: Fixture = {
    dir,
    tree,
    envFile,
    lock: path.join(dir, "deploy.lock"),
    unit: FIXTURE_UNIT,
    url: FIXTURE_URL,
    logDir,
    bins,
    shimLog: path.join(dir, "shim-log"),
    prevDir,
    protectionJson,
    requiredChecks,
    gateSuccess,
  };
  liveFixture = fixture;
  return fixture;
}

/**
 * Per-command behavior behind the shared log line. The shims exist to make the
 * procedure observable and controllable, so each records its argv and either
 * exits with a status the test set or delegates to the real binary: the
 * retention listing must really enumerate the fixture tree, and the fence must
 * really be satisfiable, for the success-path pins to mean anything.
 */
export const SHIM_DISPATCH: Record<string, { envKeys: string[]; dispatch: string }> = {
  git: {
    envKeys: ["GIT_SHIM_PARSER", "GIT_SHIM_PARSER_RC"],
    dispatch: `
if [ "$1" = fetch ]; then
  if [ -n "\${GIT_SHIM_FETCH_REPOINT:-}" ]; then
    ln -sfn "$GIT_SHIM_FETCH_REPOINT" "\${GIT_SHIM_TREE:?}/.next"
  fi
  exit 0
fi
if [ "$1" = merge-base ]; then
  exit "\${GIT_SHIM_ANCESTOR_RC:-0}"
fi
if [ "$1" = status ]; then
  printf '%s' "\${GIT_SHIM_STATUS:-}"
  exit "\${GIT_SHIM_STATUS_RC:-0}"
fi
if [ "$1" = ls-files ]; then
  # %b turns a literal \\0 in the test's value into the NUL -z emits, so a
  # test can hand the script names that themselves contain a newline.
  printf '%b' "\${GIT_SHIM_IGNORED:-}"
  exit "\${GIT_SHIM_IGNORED_RC:-0}"
fi
if [ "$1" = rev-parse ]; then
  if [ "$2" = "--short=7" ]; then
    printf '%s\\n' "\${GIT_SHIM_HASH:-}"
    exit 0
  fi
  printf '%s\\n' "\${GIT_SHIM_HASH_FULL:-\${GIT_SHIM_HASH:-}}"
  exit 0
fi
if [ "$1" = show ]; then
  case "\${2-}" in
    *:scripts/required-checks-parse.jq)
      # The parser-skew fallback's read at the target SHA: the test names the
      # file to serve as that copy, or an exit status for the read to fail
      # with. With neither set the target SHA carries no parser, the shape a
      # pre-parser target commit has, so the read fails and the gate refuses.
      if [ -n "\${GIT_SHIM_PARSER_RC:-}" ]; then exit "\$GIT_SHIM_PARSER_RC"; fi
      if [ -n "\${GIT_SHIM_PARSER:-}" ]; then cat "\$GIT_SHIM_PARSER"; exit 0; fi
      exit 128
      ;;
  esac
  if [ -n "\${GIT_SHIM_SHOW_RC:-}" ]; then exit "\$GIT_SHIM_SHOW_RC"; fi
  cat "\${GIT_SHIM_REQUIRED_CHECKS:?}"
  exit 0
fi
if [ "$1" = config ]; then
  printf '%s\\n' "\${GIT_SHIM_REMOTE_URL:-}"
  exit 0
fi
exit 0
`,
  },
  pnpm: {
    envKeys: [
      "NEXT_DIST_DIR",
      "npm_config_package_import_method",
      "OVERFLOW_FIXTURE_ENV_MARKER",
      "OVERFLOW_DEPLOY_MIGRATION_ACK",
    ],
    dispatch: `
if [ "$1" = "--silent" ]; then shift; fi
if [ "$1" = build ]; then
  dist="\${NEXT_DIST_DIR:?}"
  for entry in "$dist"/* "$dist"/.[!.]*; do
    [ -e "$entry" ] || continue
    case "\${entry##*/}" in
      cache|dev|lock|trace) ;;
      *) rm -rf "$entry" ;;
    esac
  done
  exit 0
fi
if [ "$1" = webhooks:upgrade ]; then
  printf '{"upgradeFixture":true}\\n'
  exit "\${UPGRADE_STATUS:-0}"
fi
exit 0
`,
  },
  gh: {
    envKeys: ["GH_SHIM_PROTECTION_JSON", "GH_SHIM_PROTECTION_404", "GH_SHIM_RULES_JSON", "GH_SHIM_RULES_ERROR", "GH_SHIM_DISCOVERY_FAILURE", "GH_SHIM_GATE_SEQUENCE", "GH_SHIM_STATUS", "GH_SHIM_FAIL_MATCH"],
    dispatch: `
if [ -n "\${GH_SHIM_STATUS:-}" ] && [ "\$GH_SHIM_STATUS" != 0 ]; then exit "\$GH_SHIM_STATUS"; fi
path=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = api ]; then path="\$a"; fi
  prev="\$a"
done
if [ -n "\${GH_SHIM_FAIL_MATCH:-}" ] && [[ "\$path" == *"\$GH_SHIM_FAIL_MATCH"* ]]; then exit 1; fi
failure="\${GH_SHIM_DISCOVERY_FAILURE:-}"
source=
case "\$path" in
  */branches/main/protection) source=protection ;;
  */rules/branches/main) source=rules ;;
esac
if [[ "\$failure" == "\$source-http500" ]]; then
  printf 'HTTP/1.1 500 Internal Server Error\\r\\nContent-Type: application/json\\r\\n\\r\\n{"message":"Upstream HTTP 404 while reading rules"}'
  printf 'gh: Upstream HTTP 404 while reading rules (HTTP 500)\\n' >&2
  exit 1
fi
if [[ "\$failure" == "\$source-jq404" ]]; then
  printf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n"HTTP 404"'
  exit 0
fi
# The check-runs read opens each poll iteration, so it advances the gate
# state sequence; the runs and jobs reads that follow serve the same state.
state_file="\${SHIM_LOG:?}.gh-state"
case "\$path" in
  */branches/main/protection)
    if [ "\${GH_SHIM_PROTECTION_404:-}" = 1 ]; then
      printf 'HTTP/2.0 404 Not Found\\r\\nContent-Type: application/json\\r\\n\\r\\n{}'
      printf 'gh: Not Found (HTTP 404)\\n' >&2
      exit 1
    fi
    printf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n'
    cat "\${GH_SHIM_PROTECTION_JSON:?}"
    ;;
  */rules/branches/main)
    if [ "\${GH_SHIM_RULES_ERROR:-}" = 1 ]; then
      printf 'HTTP/2.0 500 Internal Server Error\\nContent-Type: application/json\\n\\n{}'
      printf 'gh: Internal Server Error (HTTP 500)\\n' >&2
      exit 1
    fi
    if [ -n "\${GH_SHIM_RULES_JSON:-}" ]; then
      printf 'HTTP/1.1 200 OK\\nContent-Type: application/json\\n\\n'
      cat "$GH_SHIM_RULES_JSON"
    else
      printf 'HTTP/2.0 404 Not Found\\r\\nContent-Type: application/json\\r\\n\\r\\n{}'
      printf 'gh: Not Found (HTTP 404)\\n' >&2
      exit 1
    fi
    ;;
  */commits/*/check-runs*)
    idx_file="\${SHIM_LOG:?}.gh-seq"
    idx=\$(cat "\$idx_file" 2>/dev/null || printf '0')
    IFS=':' read -r -a seq_dirs <<< "\${GH_SHIM_GATE_SEQUENCE:?}"
    if [ "\$idx" -ge \${#seq_dirs[@]} ]; then idx=\$((\${#seq_dirs[@]} - 1)); fi
    printf '%s' "\${seq_dirs[\$idx]}" > "\$state_file"
    jq -r "\${!#}" "\${seq_dirs[\$idx]}/check-runs.json" || exit "$?"
    printf '%s' "\$((idx + 1))" > "\$idx_file"
    ;;
  */actions/runs/*/jobs*)
    run_id="\${path#*/actions/runs/}"
    jq -r "\${!#}" "\$(cat "\$state_file")/jobs-\${run_id%%/*}.json"
    ;;
  */actions/runs"?"*)
    jq -r "\${!#}" "\$(cat "\$state_file")/runs.json"
    ;;
  *)
    exit 1
    ;;
esac
`,
  },
  sleep: { envKeys: [], dispatch: "exit 0\n" },
  node: {
    envKeys: ["OVERFLOW_FIXTURE_ENV_MARKER"],
    dispatch: `
if [ "$1" = "scripts/deploy-migration-status.ts" ]; then
  printf '%s' "\${OVERFLOW_DEPLOY_MIGRATION_STATUS_TEST_OUTPUT:-}"
  exit "\${OVERFLOW_DEPLOY_MIGRATION_STATUS_TEST_EXIT:-0}"
fi
exit 0
`,
  },
  systemctl: { envKeys: [], dispatch: "exit 0\n" },
  curl: {
    envKeys: ["CURL_FAIL_MATCH"],
    dispatch: `
if [ -n "\${CURL_FAIL_MATCH:-}" ] && [[ "$*" == *"$CURL_FAIL_MATCH"* ]]; then exit 7; fi
if [ -n "\${CURL_STATUS:-}" ] && [ "$CURL_STATUS" != 0 ]; then exit "$CURL_STATUS"; fi
exit 0
`,
  },
  flock: { envKeys: [], dispatch: `exit "\${FLOCK_STATUS:-0}"\n` },
  find: {
    envKeys: [],
    dispatch: `
for a in "$@"; do
  if [ "$a" = "-exec" ]; then exit 0; fi
done
if [ -n "\${FIND_SHIM_LISTING_REPEAT:-}" ]; then
  seq "\${FIND_SHIM_LISTING_REPEAT}" | sed "s/.*/\${FIND_SHIM_LISTING_REPEAT_NAME}/"
  exit 0
fi
exec /usr/bin/find "$@"
`,
  },
  sort: { envKeys: [], dispatch: `exec /usr/bin/sort "$@"\n` },
  chown: { envKeys: [], dispatch: "exit 0\n" },
  chmod: { envKeys: [], dispatch: "exit 0\n" },
};

export const ALL_SHIMS = Object.keys(SHIM_DISPATCH);

export async function writeShims(fixture: Fixture, names: string[]): Promise<void> {
  for (const name of names) {
    const { envKeys, dispatch } = SHIM_DISPATCH[name]!;
    const file = path.join(fixture.bins, name);
    await writeFile(file, shimBody(name, envKeys, dispatch));
    await chmod(file, 0o755);
  }
}

export async function readLog(shimLog: string): Promise<ShimLogEntry[]> {
  const raw = await readFile(shimLog, "utf8");
  const entries: ShimLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    const envAt = fields.indexOf("env");
    const env: Record<string, string> = {};
    for (const pair of fields.slice(envAt + 1).join(" ").split(" ")) {
      const separator = pair.indexOf("=");
      if (separator > 0) env[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
    entries.push({ cmd: fields[0]!, args: fields.slice(1, envAt), env });
  }
  return entries;
}

export function describeEntry(entry: ShimLogEntry): string {
  return `${entry.cmd} ${entry.args.join(" ")}`;
}

/** The gate's own reads, in order: every gh call and the pin-map read. */
export function gateLog(entries: ShimLogEntry[]): string[] {
  return entries
    .filter((entry) => entry.cmd === "gh" || (entry.cmd === "git" && entry.args[0] === "show"))
    .map(describeEntry);
}

/** A refused deploy never reaches the fast-forward, the only step that moves HEAD. */
export function expectTreeNotMoved(entries: ShimLogEntry[], label = "the fast-forward"): void {
  expect(entries.some((entry) => entry.cmd === "git" && entry.args[0] === "merge"), label).toBe(false);
}

/** A gate refusal starts nothing after the gate and leaves HEAD alone. */
export function expectGateRefused(entries: ShimLogEntry[], label = "the gate refusal"): void {
  expectTreeNotMoved(entries, label);
  expect(entries.some((entry) => entry.cmd === "pnpm"), label).toBe(false);
  expect(entries.some((entry) => entry.cmd === "systemctl"), label).toBe(false);
}

export async function runDeploy(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
  options: { omitShims?: string[]; scriptPath?: string; openFd9On?: string } = {},
) {
  const names = ALL_SHIMS.filter((name) => !(options.omitShims ?? []).includes(name));
  await writeShims(fixture, names);
  // scriptPath: which copy of the deploy script starts the run (the tree's
  // own copy for the issue-747 proof). openFd9On: a path fd 9 is opened on
  // before the script starts, for a phase-2 entry that must get past the
  // fd 9 check to reach the serving-anchor refusal.
  const args = options.openFd9On
    ? ["-c", 'exec 9>"$1"; exec bash "$2"', "deploy-revision", options.openFd9On, options.scriptPath ?? script]
    : [options.scriptPath ?? script];
  return spawnSync("bash", args, {
    encoding: "utf8",
    cwd: fixture.dir,
    timeout: 60_000,
    env: {
      ...process.env,
      SHIM_LOG: fixture.shimLog,
      GIT_SHIM_HASH: FIXTURE_HASH,
      GIT_SHIM_TREE: fixture.tree,
      GIT_SHIM_REMOTE_URL: FIXTURE_REMOTE_URL,
      GH_SHIM_PROTECTION_JSON: fixture.protectionJson,
      GIT_SHIM_REQUIRED_CHECKS: fixture.requiredChecks,
      GH_SHIM_GATE_SEQUENCE: fixture.gateSuccess,
      OVERFLOW_DEPLOY_TREE: fixture.tree,
      OVERFLOW_DEPLOY_ENV_FILE: fixture.envFile,
      OVERFLOW_DEPLOY_LOCK: fixture.lock,
      OVERFLOW_DEPLOY_UNIT: fixture.unit,
      OVERFLOW_DEPLOY_URL: fixture.url,
      OVERFLOW_DEPLOY_LOG_DIR: fixture.logDir,
      PATH: `${fixture.bins}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      ...extraEnv,
    },
  });
}

/** Builds the existing shim PATH with no reachable gh binary. */
export async function missingGhPath(fixture: Fixture): Promise<string> {
  const noGhBins = path.join(fixture.dir, "bins-no-gh");
  await mkdir(noGhBins);
  for (const name of ALL_SHIMS.filter((name) => name !== "gh")) {
    const { envKeys, dispatch } = SHIM_DISPATCH[name]!;
    const file = path.join(noGhBins, name);
    await writeFile(file, shimBody(name, envKeys, dispatch));
    await chmod(file, 0o755);
  }
  for (const [link, target] of [
    ["bash", "/bin/bash"],
    ["env", "/usr/bin/env"],
    ["readlink", "/usr/bin/readlink"],
    ["mktemp", "/usr/bin/mktemp"],
    ["rm", "/usr/bin/rm"],
  ] as const) {
    await symlink(target, path.join(noGhBins, link));
  }
  return `${noGhBins}:${fixture.dir}`;
}

/** Runs the real discovery gate from the deploy script or the manual procedure. */
export async function expectDiscoveryRefusal(target: string, failure: string): Promise<void> {
  const fixture = await makeFixture();
  const extraEnv: Record<string, string> = { GH_SHIM_DISCOVERY_FAILURE: failure };
  if (failure === "malformed-rules") {
    const rules = path.join(fixture.dir, "malformed-rules.json");
    await writeFile(rules, JSON.stringify([{ type: "required_status_checks",
      parameters: { required_status_checks: "deploy-gate" } }]));
    extraEnv.GH_SHIM_RULES_JSON = rules;
  } else if (failure.startsWith("protection")) {
    extraEnv.GH_SHIM_RULES_JSON = await writeBranchRules(fixture, ["verify", "deploy-gate"]);
  }
  let scriptPath = script;
  if (target === "manual") {
    const markdown = await readFile(new URL("../../deploy/README.md", import.meta.url), "utf8");
    const section = markdown.split("## 10. Deploying a new revision")[1]!;
    const gate = section.slice(section.indexOf("required_stderr=$(mktemp)"), section.indexOf("check_runs_status=0"));
    scriptPath = path.join(fixture.dir, "manual-discovery.sh");
    await writeFile(scriptPath, `repo=${FIXTURE_REPO}\n${gate}\npnpm install\n`);
  }
  const result = await runDeploy(fixture, extraEnv, { scriptPath });
  expect(result.status, `${target}/${failure}: ${result.stderr}`).toBe(1);
  expect(result.stderr).toContain("could not determine required checks for main");
  expect(result.stderr).toContain(failure.startsWith("protection") ? "branch-protection read failed" : "rules read failed");
  expectGateRefused(await readLog(fixture.shimLog));
}
