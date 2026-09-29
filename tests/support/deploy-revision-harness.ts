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
export const JQ_PROTECTION = `([.required_status_checks.contexts[]?] + [.required_status_checks.checks[]?.context]) | unique | .[]`;
export const JQ_CHECKRUNS = `.check_runs[] | [.id, .name, (.app.id // 0), (.status // "unknown"), (.conclusion // "")] | @tsv`;
export const JQ_RUNS = `.workflow_runs[] | [.id, .path] | @tsv`;
export const JQ_JOBS = `.jobs[] | [.id, (if (.name // "") == "" then "(unnamed)" else .name end), (.run_attempt // 0), (.status // "unknown"), (.conclusion // "")] | @tsv`;
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
 * with the fixture's pinned runs (100 and 200): protection, the pin map at the
 * SHA, every check-run, the workflow runs, and the jobs of each pinned run.
 */
export function gateReads(sha: string): string[] {
  return [
    `gh api repos/${FIXTURE_REPO}/branches/main/protection --jq ${JQ_PROTECTION}`,
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
 * Writes one poll iteration's GitHub state as the gh shim serves it: each file
 * holds what gh prints after the script's --jq program for that endpoint. A
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
  const tsv = (rows: Array<Array<string | number>>) => rows.map((row) => row.join("\t") + "\n").join("");
  await writeFile(path.join(directory, "runs.tsv"), tsv(runs.map((run) => [run.id, run.path])));
  for (const run of runs) {
    await writeFile(
      path.join(directory, `jobs-${run.id}.tsv`),
      tsv(run.jobs.map((job) => [job.id, job.name, job.attempt ?? 1, job.status, job.conclusion ?? ""])),
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
    path.join(directory, "check-runs.tsv"),
    tsv(
      checkRuns.map((cr) => {
        const status = cr.status ?? "completed";
        // GitHub leaves a non-completed check-run's conclusion null; the
        // projection's `// ""` guard prints it empty.
        const conclusion = cr.conclusion ?? (status === "completed" ? "success" : "");
        return [cr.id, cr.name, cr.app ?? ACTIONS_APP_ID, status, conclusion];
      }),
    ),
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

export const RELEASE_GRAMMAR = /^\.next-release-\d{8}T\d{6}Z-[a-f0-9]{7,40}$/;
export const LISTING_REGEX = String.raw`.*/\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}`;
/** The ignored-files gate's read, as the shim log records it. */
export const IGNORED_LISTING = "git ls-files -z --others --ignored --exclude-standard --directory --no-empty-directory";
/**
 * Every ignored untracked entry production's tree legitimately holds, in the
 * shape `git ls-files --others --ignored --directory` prints it: directories
 * carry a trailing slash, the .next symlink does not.
 */
export const OPERATIONAL_IGNORED = [
  ".next",
  ".next/",
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
  // that path.
  await mkdir(path.join(tree, "scripts"));
  await writeFile(path.join(tree, "scripts", "deploy-revision.sh"), await readFile(script, "utf8"));
  const envFile = path.join(dir, "overflow.env");
  await writeFile(envFile, "OVERFLOW_FIXTURE_ENV_MARKER=loaded\n");
  const logDir = path.join(dir, "logs");
  const bins = path.join(dir, "bins");
  await mkdir(logDir);
  await mkdir(bins);
  // The gh shim cats these files verbatim, so each holds what gh prints after
  // applying the script's --jq program for that API path: the protection call
  // yields one required-check name per line, and each gate state directory
  // (writeGateState) holds the TSV the check-runs, runs and jobs calls yield.
  // The argv-shape assertions below still pin that the script passes those
  // exact --jq programs. The git shim serves requiredChecks as the pin map.
  const protectionJson = path.join(dir, "protection.txt");
  await writeFile(protectionJson, "verify\ndeploy-gate\n");
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
    envKeys: [],
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
    envKeys: ["GH_SHIM_PROTECTION_JSON", "GH_SHIM_GATE_SEQUENCE", "GH_SHIM_STATUS", "GH_SHIM_FAIL_MATCH"],
    dispatch: `
if [ -n "\${GH_SHIM_STATUS:-}" ] && [ "\$GH_SHIM_STATUS" != 0 ]; then exit "\$GH_SHIM_STATUS"; fi
path=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = api ]; then path="\$a"; fi
  prev="\$a"
done
if [ -n "\${GH_SHIM_FAIL_MATCH:-}" ] && [[ "\$path" == *"\$GH_SHIM_FAIL_MATCH"* ]]; then exit 1; fi
# The check-runs read opens each poll iteration, so it advances the gate
# state sequence; the runs and jobs reads that follow serve the same state.
state_file="\${SHIM_LOG:?}.gh-state"
case "\$path" in
  */branches/main/protection)
    cat "\${GH_SHIM_PROTECTION_JSON:?}"
    ;;
  */commits/*/check-runs*)
    idx_file="\${SHIM_LOG:?}.gh-seq"
    idx=\$(cat "\$idx_file" 2>/dev/null || printf '0')
    IFS=':' read -r -a seq_dirs <<< "\${GH_SHIM_GATE_SEQUENCE:?}"
    if [ "\$idx" -ge \${#seq_dirs[@]} ]; then idx=\$((\${#seq_dirs[@]} - 1)); fi
    printf '%s' "\${seq_dirs[\$idx]}" > "\$state_file"
    cat "\${seq_dirs[\$idx]}/check-runs.tsv"
    printf '%s' "\$((idx + 1))" > "\$idx_file"
    ;;
  */actions/runs/*/jobs*)
    run_id="\${path#*/actions/runs/}"
    cat "\$(cat "\$state_file")/jobs-\${run_id%%/*}.tsv"
    ;;
  */actions/runs"?"*)
    cat "\$(cat "\$state_file")/runs.tsv"
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
