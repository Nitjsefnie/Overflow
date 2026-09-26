import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/deploy-revision.sh", import.meta.url));
const readme = fileURLToPath(new URL("../../deploy/README.md", import.meta.url));
const repoGitignore = fileURLToPath(new URL("../../.gitignore", import.meta.url));

/** Returns deploy/README.md's section 10, failing the surrounding test if the heading is gone. */
async function section10(): Promise<string> {
  const markdown = await readFile(readme, "utf8");
  const section = markdown.split("## 10. Deploying a new revision")[1];
  expect(section, "the section 10 heading").toBeDefined();
  return section!;
}

/**
 * The refusal the procedure's serialization notes mandate, byte for byte, with
 * the lock spelled as configured. Production defaults to /run/overflow-deploy.lock;
 * the behavioral test substitutes the fixture lock.
 */
const REFUSAL_TEMPLATE =
  "Could not acquire the deploy lock on %LOCK%; refusing to deploy. Consult the deploy procedure's serialization notes before re-running.";

const DEFAULT_LOCK = "/run/overflow-deploy.lock";

function refusalFor(lock: string): string {
  return REFUSAL_TEMPLATE.replace("%LOCK%", lock);
}

/**
 * A shim executable: logs one tab-separated line per invocation — command,
 * arguments, then an env capture — and then either exits with a status the
 * test set or delegates to the real binary. Nothing here reaches the network,
 * systemd, the shared pnpm store or any tree outside the fixture, and every
 * invocation is bounded by spawnSync's timeout.
 */
function shimBody(name: string, envKeys: string[], dispatch: string): string {
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

interface ShimLogEntry {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

interface Fixture {
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

afterEach(async () => {
  if (liveFixture) await rm(liveFixture.dir, { recursive: true, force: true });
  liveFixture = undefined;
});

const FIXTURE_UNIT = "overflow-fixture.service";
const FIXTURE_URL = "http://127.0.0.1:39999/deploy-fixture";
const FIXTURE_HASH = "abc1234";
const FIXTURE_REPO = "overflow-fixture/overflow-fixture";
const FIXTURE_REMOTE_URL = `git@github.com:${FIXTURE_REPO}.git`;
const JQ_PROTECTION = `([.required_status_checks.contexts[]?] + [.required_status_checks.checks[]?.context]) | unique | .[]`;
const JQ_CHECKRUNS = `.check_runs[] | [.id, .name] | @tsv`;
const JQ_RUNS = `.workflow_runs[] | [.id, .path] | @tsv`;
const JQ_JOBS = `.jobs[] | [.id, (if (.name // "") == "" then "(unnamed)" else .name end), (.run_attempt // 0), (.status // "unknown"), (.conclusion // "")] | @tsv`;
const MAP_PATH = ".github/required-checks.json";
/** The fixture's pin map: protection requires verify and deploy-gate. */
const FIXTURE_PINS: Record<string, string> = {
  verify: ".github/workflows/ci.yml",
  "deploy-gate": ".github/workflows/deploy-gate.yml",
};
/** Where each fixture check's job runs; claim is a workflow nothing pins. */
const FIXTURE_WORKFLOWS: Record<string, string> = {
  ...FIXTURE_PINS,
  claim: ".github/workflows/claim.yml",
};
const FIXTURE_RUN_IDS: Record<string, number> = {
  ".github/workflows/ci.yml": 100,
  ".github/workflows/deploy-gate.yml": 200,
  ".github/workflows/claim.yml": 300,
};

/**
 * The gate's reads in call order when one poll iteration settles it on `sha`
 * with the fixture's pinned runs (100 and 200): protection, the pin map at the
 * SHA, every check-run, the workflow runs, and the jobs of each pinned run.
 */
function gateReads(sha: string): string[] {
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

interface GateJob {
  id: number;
  name: string;
  attempt?: number;
  status: string;
  conclusion?: string;
}

interface GateRun {
  id: number;
  path: string;
  jobs: GateJob[];
}

/**
 * Writes one poll iteration's GitHub state as the gh shim serves it: each file
 * holds what gh prints after the script's --jq program for that endpoint. A
 * job's check-run shares its id, as on GitHub; `extraCheckRuns` are check-runs
 * no job produced (created through the Checks API).
 */
async function writeGateState(
  fixture: Pick<Fixture, "dir">,
  name: string,
  runs: GateRun[],
  extraCheckRuns: Array<[number, string]> = [],
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
  const checkRuns = [...runs.flatMap((run) => run.jobs.map((job) => [job.id, job.name])), ...extraCheckRuns];
  await writeFile(path.join(directory, "check-runs.tsv"), tsv(checkRuns));
  return directory;
}

/**
 * The common case: one run per workflow, one job per row, each job in the
 * workflow FIXTURE_WORKFLOWS places it in.
 */
async function writeCheckRuns(
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

const RELEASE_GRAMMAR = /^\.next-release-\d{8}T\d{6}Z-[a-f0-9]{7,40}$/;
const LISTING_REGEX = String.raw`.*/\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}`;
/** The ignored-files gate's read, as the shim log records it. */
const IGNORED_LISTING = "git ls-files -z --others --ignored --exclude-standard --directory --no-empty-directory";
/**
 * Every ignored untracked entry production's tree legitimately holds, in the
 * shape `git ls-files --others --ignored --directory` prints it: directories
 * carry a trailing slash, the .next symlink does not.
 */
const OPERATIONAL_IGNORED = [
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
const NEAR_MISS_IGNORED = [
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
function listedOffenders(stderr: string): string[] {
  const lines = stderr.split("\n");
  const offenders: string[] = [];
  for (let at = lines.findIndex((line) => line.startsWith("The tree in ")) - 1; at >= 0; at--) {
    if (!/^ {2}\S/.test(lines[at]!)) break;
    offenders.unshift(lines[at]!.slice(2));
  }
  return offenders;
}

async function makeRelease(tree: string, name: string): Promise<string> {
  const directory = path.join(tree, name);
  await mkdir(path.join(directory, "cache"), { recursive: true });
  await writeFile(path.join(directory, "BUILD_ID"), name);
  return directory;
}

async function makeFixture(options: {
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
const SHIM_DISPATCH: Record<string, { envKeys: string[]; dispatch: string }> = {
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
    envKeys: ["NEXT_DIST_DIR", "npm_config_package_import_method", "OVERFLOW_FIXTURE_ENV_MARKER"],
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
  node: { envKeys: [], dispatch: "exit 0\n" },
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

const ALL_SHIMS = Object.keys(SHIM_DISPATCH);

async function writeShims(fixture: Fixture, names: string[]): Promise<void> {
  for (const name of names) {
    const { envKeys, dispatch } = SHIM_DISPATCH[name]!;
    const file = path.join(fixture.bins, name);
    await writeFile(file, shimBody(name, envKeys, dispatch));
    await chmod(file, 0o755);
  }
}

async function readLog(shimLog: string): Promise<ShimLogEntry[]> {
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

function describeEntry(entry: ShimLogEntry): string {
  return `${entry.cmd} ${entry.args.join(" ")}`;
}

/** The gate's own reads, in order: every gh call and the pin-map read. */
function gateLog(entries: ShimLogEntry[]): string[] {
  return entries
    .filter((entry) => entry.cmd === "gh" || (entry.cmd === "git" && entry.args[0] === "show"))
    .map(describeEntry);
}

/** A refused deploy never reaches the fast-forward, the only step that moves HEAD. */
function expectTreeNotMoved(entries: ShimLogEntry[], label = "the fast-forward"): void {
  expect(entries.some((entry) => entry.cmd === "git" && entry.args[0] === "merge"), label).toBe(false);
}

async function runDeploy(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
  options: { omitShims?: string[] } = {},
) {
  const names = ALL_SHIMS.filter((name) => !(options.omitShims ?? []).includes(name));
  await writeShims(fixture, names);
  return spawnSync("bash", [script], {
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

describe("scripts/deploy-revision.sh", () => {
  it("exists, parses as bash, and runs under strict mode with every knob declared", async () => {
    const source = await readFile(script, "utf8");
    expect(spawnSync("bash", ["-n", script], { encoding: "utf8" }).status).toBe(0);
    expect(source).toContain("set -euo pipefail");
    for (const knob of [
      "OVERFLOW_DEPLOY_TREE",
      "OVERFLOW_DEPLOY_ENV_FILE",
      "OVERFLOW_DEPLOY_LOCK",
      "OVERFLOW_DEPLOY_UNIT",
      "OVERFLOW_DEPLOY_URL",
      "OVERFLOW_DEPLOY_LOG_DIR",
      "OVERFLOW_DEPLOY_CI_TIMEOUT",
    ]) {
      expect(source).toContain(knob);
    }
    expect(source).toMatch(/production sets none/);
  });

  it("defaults the deploy verification curl to the readiness endpoint", async () => {
    const source = await readFile(script, "utf8");
    const defaultUrl = "http://127.0.0.1:3000/api/readiness";
    expect(source).toContain(`OVERFLOW_DEPLOY_URL:-${defaultUrl}`);

    // deploy/README.md section 10 restates the same default in its env
    // listing; pin the pair so neither side can drift from the other.
    expect(await section10()).toContain(`OVERFLOW_DEPLOY_URL\` (default \`${defaultUrl}\`)`);
  });

  it("derives the sign-in smoke URL from the readiness URL knob and runs it after readiness", async () => {
    const source = await readFile(script, "utf8");
    // The derivation composes production's default into the smoke's URL:
    // http://127.0.0.1:3000/api/readiness -> http://127.0.0.1:3000/api/auth/providers.
    expect(source).toContain('providers_url="${url%/api/readiness}/api/auth/providers"');
    const atReadiness = source.indexOf('--retry-connrefused -fsS -o /dev/null -w \'%{http_code}\\n\' "$url"');
    const atSmoke = source.indexOf('"$providers_url"');
    expect(atReadiness, "the readiness curl present").toBeGreaterThan(-1);
    expect(atSmoke, "the sign-in smoke curl present").toBeGreaterThan(-1);
    expect(atSmoke, "the smoke runs after readiness").toBeGreaterThan(atReadiness);
  });

  it("refuses at the fence without invoking git, pnpm or node when the lock is taken", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { FLOCK_STATUS: "1" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(refusalFor(fixture.lock));
    expect(refusalFor(DEFAULT_LOCK)).toBe(
      "Could not acquire the deploy lock on /run/overflow-deploy.lock; refusing to deploy. Consult the deploy procedure's serialization notes before re-running.",
    );
    const entries = await readLog(fixture.shimLog);
    expect(entries.map((entry) => entry.cmd)).toEqual(["flock"]);
  });

  it("runs the whole section 10 procedure in order under a successful fence", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const entries = await readLog(fixture.shimLog);
    const servingCache = `${realpathSync(fixture.prevDir)}/cache`;
    const nodeEntry = entries.find((entry) => entry.cmd === "node")!;
    const release = nodeEntry.args[3]!;
    expect(release).toMatch(RELEASE_GRAMMAR);
    expect(release.endsWith(`-${FIXTURE_HASH}`)).toBe(true);
    expect(await readdir(fixture.tree)).toContain(release);

    // The retention listing is a pipeline, so its find and sort are started
    // concurrently and their log lines race; everything before it is strictly
    // ordered. Assert the sequential spine exactly, then pin the pipeline's
    // two entries on content and on the window they must fall inside.
    const received = entries.map(describeEntry);
    const listingFind = `find ${fixture.tree} -regextype posix-extended -mindepth 1 -maxdepth 1 -type d -regex ${LISTING_REGEX} -printf %f\\n`;
    const sequential = received.filter((line) => line !== listingFind && line !== "sort -r");
    expect(sequential).toEqual([
      `flock -w 900 9`,
      `git fetch origin main`,
      `git rev-parse --verify FETCH_HEAD^{commit}`,
      `git merge-base --is-ancestor HEAD ${FIXTURE_HASH}`,
      `git status --porcelain=v1 -uall`,
      IGNORED_LISTING,
      `git config --get remote.origin.url`,
      ...gateReads(FIXTURE_HASH),
      `git merge --ff-only ${FIXTURE_HASH}`,
      `pnpm install --frozen-lockfile`,
      `pnpm db:migrate`,
      `git rev-parse --short=7 HEAD`,
      `node scripts/release.ts prepare ${fixture.tree} ${release}`,
      `pnpm build`,
      `find ${fixture.tree} -path ${servingCache} -prune -o -exec chown -h root:overflow {} +`,
      `find ${fixture.tree} -path ${servingCache} -prune -o ! -type l -exec chmod u=rwX,g=rX,o= {} +`,
      `chown -R overflow:overflow ${release}/cache`,
      `chmod -R u=rwX,g=rX,o= ${release}/cache`,
      `pnpm release:switch ${fixture.tree} ${release} --expect-current ${realpathSync(fixture.prevDir)}`,
      `systemctl restart ${fixture.unit}`,
      `systemctl is-active ${fixture.unit}`,
      `curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 --retry-connrefused -fsS -o /dev/null -w %{http_code}\\n ${fixture.url}`,
      `curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 --retry-connrefused -fsS -o /dev/null -w %{http_code}\\n ${fixture.url}/api/auth/providers`,
      `pnpm --silent webhooks:upgrade`,
      `pnpm release:prune ${fixture.tree} --keep 3`,
    ]);
    const upgradeAt = received.indexOf(`pnpm --silent webhooks:upgrade`);
    const pruneAt = received.indexOf(`pnpm release:prune ${fixture.tree} --keep 3`);
    for (const pipelineEntry of [listingFind, "sort -r"]) {
      const at = received.indexOf(pipelineEntry);
      expect(at, pipelineEntry).toBeGreaterThan(upgradeAt);
      expect(at, pipelineEntry).toBeLessThan(pruneAt);
      expect(received.filter((line) => line === pipelineEntry)).toHaveLength(1);
    }

    const byCommand = (cmd: string) => entries.filter((entry) => entry.cmd === cmd);
    const [install] = byCommand("pnpm").filter((entry) => entry.args[0] === "install");
    const [migrate] = byCommand("pnpm").filter((entry) => entry.args[0] === "db:migrate");
    const [build] = byCommand("pnpm").filter((entry) => entry.args[0] === "build");
    expect(install!.env.npm_config_package_import_method).toBe("copy");
    expect(install!.env.OVERFLOW_FIXTURE_ENV_MARKER).toBe("");
    expect(migrate!.env.OVERFLOW_FIXTURE_ENV_MARKER).toBe("loaded");
    expect(build!.env.NEXT_DIST_DIR).toBe(release);
    const [listing] = byCommand("find").filter((entry) => entry.args.includes("-printf"));
    const [sort] = byCommand("sort");
    expect(listing!.env.LC_ALL).toBe("C");
    expect(sort!.env.LC_ALL).toBe("C");

    expect(result.stdout).toContain(`Previous build: ${realpathSync(fixture.prevDir)}`);
    expect(result.stdout).toContain(`New build: ${release}`);
    expect(result.stdout).toContain("Webhook upgrade exit status: 0");
    const upgradeLog = path.join(fixture.logDir, `webhook-upgrade-${release}.jsonl`);
    await expect(readFile(upgradeLog, "utf8")).resolves.toContain('{"upgradeFixture":true}');
  });

  it("prunes even when the retention listing exceeds the pipe buffer", async () => {
    const fixture = await makeFixture();
    const previous = path.basename(fixture.prevDir);
    // The find shim prints one line per release name; repeating the previous
    // release's own name past the 64 KiB pipe buffer forces the guard's
    // early-exit consumers to outlive their producer under pipefail. The
    // repeat count must stay small enough that the script's own stdout (it
    // prints the whole listing for the deploy record) stays under
    // spawnSync's 1 MiB default maxBuffer, or Node kills the script before
    // the guard is reached (observed: SIGTERM/ENOBUFS at 200000 lines).
    const result = await runDeploy(fixture, {
      FIND_SHIM_LISTING_REPEAT: "6000",
      FIND_SHIM_LISTING_REPEAT_NAME: previous,
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const entries = await readLog(fixture.shimLog);
    expect(entries.map(describeEntry)).toContain(`pnpm release:prune ${fixture.tree} --keep 3`);
  });

  it("aborts when the serving release has no cache directory, before touching ownership", async () => {
    const fixture = await makeFixture({ servingCache: false });
    const result = await runDeploy(fixture);

    expect(result.status).not.toBe(0);
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "find")).toBe(false);
    expect(entries.some((entry) => entry.cmd === "systemctl")).toBe(false);
    expect(entries.some((entry) => entry.args[0] === "release:switch")).toBe(false);
    expect(entries.some((entry) => entry.args.includes("webhooks:upgrade"))).toBe(false);
    expect(entries.some((entry) => entry.args[0] === "release:prune")).toBe(false);
  });

  it("prints the webhook upgrade's output to the transcript through its log", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture);

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    const release = entries.find((entry) => entry.cmd === "node")!.args[3]!;
    const upgradeLog = path.join(fixture.logDir, `webhook-upgrade-${release}.jsonl`);
    await expect(readFile(upgradeLog, "utf8")).resolves.toContain('{"upgradeFixture":true}');
    expect(result.stdout).toContain('{"upgradeFixture":true}');
  });

  it("prints the retention listing to the deploy record", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture);

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    const release = entries.find((entry) => entry.cmd === "node")!.args[3]!;
    // The captured listing is printed as one contiguous block, descending, so
    // the deploy record shows exactly what the prune guard decided from.
    const listing = [
      release,
      ".next-release-20260908T000000Z-abc1234",
      ".next-release-20260907T000000Z-def5678",
      ".next-release-20260906T000000Z-abc1234",
      ".next-release-20260801T000000Z-def5678",
    ].join("\n");
    expect(result.stdout).toContain(listing);
  });

  it("passes --expect-current the pre-fetch anchor, not a value re-read after the fetch", async () => {
    const fixture = await makeFixture({
      extraReleases: [
        ".next-release-20260701T000000Z-abc1234",
        ".next-release-20260601T000000Z-def5678",
        ".next-release-20260501T000000Z-abc1234",
      ],
    });
    // The fetch moves the serving release out from under the deploy, as a
    // concurrent off-procedure actor would: a re-read anchor would name the new
    // release, and the conditional switch must still receive the old one.
    const repointed = ".next-release-20260701T000000Z-abc1234";
    const result = await runDeploy(fixture, { GIT_SHIM_FETCH_REPOINT: repointed });

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    const [switchEntry] = entries.filter((entry) => entry.args[0] === "release:switch");
    expect(switchEntry!.args).toEqual([
      "release:switch",
      fixture.tree,
      expect.stringMatching(RELEASE_GRAMMAR),
      "--expect-current",
      realpathSync(fixture.prevDir),
    ]);
    expect(realpathSync(path.join(fixture.tree, repointed))).not.toBe(realpathSync(fixture.prevDir));
  });

  it("aborts on a failed readiness check before the webhook upgrade and the prune", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { CURL_STATUS: "7" });

    expect(result.status).toBe(7);
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.args.includes("webhooks:upgrade"))).toBe(false);
    expect(entries.some((entry) => entry.args[0] === "release:prune")).toBe(false);
    expect(entries.some((entry) => entry.args[0] === "restart")).toBe(true);
  });

  it("aborts on a failed sign-in smoke after readiness passed, before the webhook upgrade and the prune", async () => {
    // Issue 649: readiness certifies the database, not Auth.js trust, so the
    // smoke check that follows it must refuse the deploy on its own. The
    // providers URL is the only one that fails here, proving readiness ran
    // first and the failure is the smoke's.
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { CURL_FAIL_MATCH: "/api/auth/providers" });

    expect(result.status, result.stderr).toBe(7);
    const entries = await readLog(fixture.shimLog);
    const curlUrls = entries
      .filter((entry) => entry.cmd === "curl")
      .map((entry) => entry.args.at(-1));
    expect(curlUrls).toEqual([
      fixture.url,
      `${fixture.url}/api/auth/providers`,
    ]);
    expect(entries.some((entry) => entry.args.includes("webhooks:upgrade"))).toBe(false);
    expect(entries.some((entry) => entry.args[0] === "release:prune")).toBe(false);
    expect(entries.some((entry) => entry.args[0] === "restart")).toBe(true);
  });

  it("exits with the webhook upgrade's status after the restart, and never prunes", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { UPGRADE_STATUS: "7" });

    expect(result.status).toBe(7);
    expect(result.stdout).toContain("Webhook upgrade exit status: 7");
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.args[0] === "release:prune")).toBe(false);
    const restartAt = entries.map(describeEntry).indexOf(`systemctl restart ${fixture.unit}`);
    const upgradeAt = entries.findIndex((entry) => entry.args.includes("webhooks:upgrade"));
    expect(restartAt).toBeGreaterThanOrEqual(0);
    expect(upgradeAt).toBeGreaterThan(restartAt);
  });

  it("skips the prune with a warning when the previous release falls outside the newest 3", async () => {
    const fixture = await makeFixture({
      prevRelease: ".next-release-20260101T000000Z-abc1234",
      extraReleases: [
        ".next-release-20260907T000000Z-def5678",
        ".next-release-20260906T000000Z-abc1234",
        ".next-release-20260905T000000Z-def5678",
      ],
    });
    const result = await runDeploy(fixture);

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.args[0] === "release:prune")).toBe(false);
    const previous = path.basename(fixture.prevDir);
    const warning = `${result.stdout}\n${result.stderr}`;
    expect(warning).toContain(previous);
    expect(warning).toContain("pnpm release:prune");
    expect(warning).toContain("--keep");
    expect(await readdir(fixture.tree)).toContain(previous);
  });

  it("prunes when the previous release is exactly third-newest, the keep-3 boundary's last kept name", async () => {
    // The deploy's own release name uses the real clock, so it sorts newest;
    // exactly one release sorts between it and the previous one (20260909
    // above the default 20260908), placing the previous release at the
    // boundary's last included position. The automated prune must fire: this
    // is the run whose `--keep 3` decides the just-replaced rollback target
    // survives, so both narrower and wider retention windows must fail here.
    const fixture = await makeFixture({
      extraReleases: [
        ".next-release-20260909T000000Z-abc1234",
        ".next-release-20260907T000000Z-def5678",
        ".next-release-20260906T000000Z-abc1234",
      ],
    });
    const result = await runDeploy(fixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const entries = await readLog(fixture.shimLog);
    expect(entries.map(describeEntry)).toContain(`pnpm release:prune ${fixture.tree} --keep 3`);
  });

  it("warns without pruning when the previous release is exactly fourth-newest, the first name past the keep-3 boundary", async () => {
    // Two releases sort above the previous one (20260910 and 20260909 above
    // the default 20260908), placing it one past the boundary: the guard must
    // refuse the automated prune — the alternative silently deletes the
    // just-replaced rollback target — and warn instead, keeping everything.
    const fixture = await makeFixture({
      extraReleases: [
        ".next-release-20260910T000000Z-abc1234",
        ".next-release-20260909T000000Z-abc1234",
        ".next-release-20260907T000000Z-def5678",
      ],
    });
    const result = await runDeploy(fixture);

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.args[0] === "release:prune")).toBe(false);
    const previous = path.basename(fixture.prevDir);
    const warning = `${result.stdout}\n${result.stderr}`;
    expect(warning).toContain(previous);
    expect(warning).toContain("pnpm release:prune");
    expect(warning).toContain("--keep");
    expect(await readdir(fixture.tree)).toContain(previous);
  });

  it("satisfies the fence with the real flock binary, proving the fd 9 wiring", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, {}, { omitShims: ["flock"] });

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    expect(entries[0]!.cmd).toBe("git");
  });

  it("builds the release name from UTC date and the 7-character head hash", async () => {
    const source = await readFile(script, "utf8");
    expect(source).toContain("date -u +%Y%m%dT%H%M%SZ");
    expect(source).toContain("git rev-parse --short=7 HEAD");
    expect(source).toContain('mkdir "$release"');
    expect(source).not.toContain('mkdir -p "$release"');
    expect(source).toContain('mkdir -p "$release/cache"');
  });

  it("contains no rm invocation and deletes no release outside release:prune", async () => {
    const source = await readFile(script, "utf8");
    expect(source).not.toMatch(/(^|[^\w])rm([^\w]|$)/);
    expect(source).not.toContain("-delete");
    expect(source).toContain("release:prune");
  });

  it("keeps the retention listing's LC_ALL=C and the incident-prone -regextype flag", async () => {
    const source = await readFile(script, "utf8");
    expect(source).toContain("-regextype posix-extended");
    expect(source).toContain("LC_ALL=C find");
    expect(source).toContain("LC_ALL=C sort");
    expect(source).toContain("-printf '%f\\n'");
    expect(source).toContain(".next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}");
  });

  it("gates the deploy on main's required checks for the deployed SHA", async () => {
    const source = await readFile(script, "utf8");
    expect(source).toContain('gh api "repos/$repo/branches/main/protection"');
    expect(source).toContain('git show "$full_sha:.github/required-checks.json"');
    expect(source).toContain('"repos/$repo/commits/$full_sha/check-runs?filter=all&per_page=100"');
    expect(source).toContain('"repos/$repo/actions/runs?head_sha=$full_sha&per_page=100"');
    expect(source).toContain('"repos/$repo/actions/runs/$run_id/jobs?filter=all&per_page=100"');
    expect(source).toContain("--paginate");
    expect(source).toContain("OVERFLOW_DEPLOY_CI_TIMEOUT");
    expect(source).toContain("OVERFLOW_DEPLOY_CI_GATE");
    expect(source).toContain("git rev-parse --verify 'FETCH_HEAD^{commit}'");
  });

  it("refuses before install when a required check's latest run failed", async () => {
    const fixture = await makeFixture();
    const failed = await writeCheckRuns(fixture, "gate-failed", [
      ["verify", "completed", "failure"],
      ["deploy-gate", "completed", "success"],
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: failed });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("verify");
    expect(result.stderr).toContain("failure");
    const entries = await readLog(fixture.shimLog);
    const started = entries.filter(
      (entry) =>
        entry.cmd === "pnpm" &&
        ["install", "db:migrate", "build", "release:switch", "release:prune"].includes(entry.args[0]!),
    );
    expect(started).toEqual([]);
    expect(entries.some((entry) => entry.cmd === "systemctl" && entry.args[0] === "restart")).toBe(false);
    expect(gateLog(entries)).toEqual(gateReads(FIXTURE_HASH));
    expect(entries.some((entry) => entry.cmd === "sleep")).toBe(false);
    expectTreeNotMoved(entries);
  });

  it("waits for an absent required check run and proceeds once it appears and succeeds", async () => {
    const fixture = await makeFixture();
    const absent = await writeCheckRuns(fixture, "gate-absent", [
      ["verify", "completed", "success"],
      ["claim", "completed", "success"],
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_GATE_SEQUENCE: `${absent}:${fixture.gateSuccess}`,
    });

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    const isCheckRuns = (entry: ShimLogEntry) =>
      entry.cmd === "gh" && entry.args.some((arg) => arg.includes("check-runs?filter=all&per_page=100"));
    const checkRunsCalls = entries.filter(isCheckRuns);
    expect(checkRunsCalls).toHaveLength(2);
    const checkRunsAt = entries.findIndex(isCheckRuns);
    const sleepBetween = entries
      .map(describeEntry)
      .filter((line, at) => line === "sleep 15" && at > checkRunsAt);
    expect(sleepBetween.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "release:switch")).toBe(true);
  });

  it("refuses on the timeout while a required check run stays absent, before mutating anything", async () => {
    const fixture = await makeFixture();
    const absent = await writeCheckRuns(fixture, "gate-absent", [
      ["verify", "completed", "success"],
      ["claim", "completed", "success"],
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_GATE_SEQUENCE: absent,
      OVERFLOW_DEPLOY_CI_TIMEOUT: "1",
    });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("deploy-gate (absent)");
    expect(result.stderr).toContain("HEAD, the index and the working tree are untouched; only the fetched refs moved");
    const entries = await readLog(fixture.shimLog);
    expectTreeNotMoved(entries);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "db:migrate")).toBe(false);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "build")).toBe(false);
    expect(entries.some((entry) => entry.args[0] === "release:switch")).toBe(false);
  });

  it("refuses immediately when an absent run appears and concludes non-success", async () => {
    const fixture = await makeFixture();
    const absent = await writeCheckRuns(fixture, "gate-absent", [
      ["verify", "completed", "success"],
      ["claim", "completed", "success"],
    ]);
    const appeared = await writeCheckRuns(fixture, "gate-appeared-failed", [
      ["verify", "completed", "success"],
      ["deploy-gate", "completed", "failure"],
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_GATE_SEQUENCE: `${absent}:${appeared}`,
    });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("deploy-gate");
    expect(result.stderr).toContain("concluded failure");
    const entries = await readLog(fixture.shimLog);
    const isCheckRuns = (entry: ShimLogEntry) =>
      entry.cmd === "gh" && entry.args.some((arg) => arg.includes("check-runs?filter=all&per_page=100"));
    expect(entries.filter(isCheckRuns)).toHaveLength(2);
    expect(entries.filter((entry) => entry.cmd === "sleep")).toHaveLength(1);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
  });

  it("waits for a pending required check and proceeds once it succeeds", async () => {
    const fixture = await makeFixture();
    const pending = await writeCheckRuns(fixture, "gate-pending", [
      ["verify", "completed", "success"],
      ["deploy-gate", "in_progress"],
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_GATE_SEQUENCE: `${pending}:${fixture.gateSuccess}`,
    });

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    const isCheckRuns = (entry: ShimLogEntry) =>
      entry.cmd === "gh" && entry.args.some((arg) => arg.includes("check-runs?filter=all&per_page=100"));
    const checkRunsCalls = entries.filter(isCheckRuns);
    expect(checkRunsCalls).toHaveLength(2);
    const checkRunsAt = entries.findIndex(isCheckRuns);
    const sleepBetween = entries
      .map(describeEntry)
      .filter((line, at) => line === "sleep 15" && at > checkRunsAt);
    expect(sleepBetween.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "release:switch")).toBe(true);
  });

  it("refuses on the timeout while a required check stays pending, before mutating anything", async () => {
    const fixture = await makeFixture();
    const pending = await writeCheckRuns(fixture, "gate-stuck-pending", [
      ["verify", "completed", "success"],
      ["deploy-gate", "in_progress"],
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_GATE_SEQUENCE: pending,
      OVERFLOW_DEPLOY_CI_TIMEOUT: "1",
    });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("deploy-gate");
    expect(result.stderr).toContain("pending");
    expect(result.stderr).toContain("HEAD, the index and the working tree are untouched; only the fetched refs moved");
    const entries = await readLog(fixture.shimLog);
    expectTreeNotMoved(entries);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
    expect(entries.some((entry) => entry.args[0] === "release:switch")).toBe(false);
  });

  /** A gate refusal starts nothing after the gate and leaves HEAD alone. */
  function expectGateRefused(entries: ShimLogEntry[], label = "the gate refusal"): void {
    expectTreeNotMoved(entries, label);
    expect(entries.some((entry) => entry.cmd === "pnpm"), label).toBe(false);
    expect(entries.some((entry) => entry.cmd === "systemctl"), label).toBe(false);
  }

  it("refuses when a same-named job in another workflow succeeded while the pinned job failed", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-collision", [
      { id: 100, path: FIXTURE_PINS.verify!, jobs: [{ id: 1001, name: "verify", status: "completed", conclusion: "failure" }] },
      { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
      { id: 400, path: ".github/workflows/claim.yml", jobs: [{ id: 4001, name: "verify", status: "completed", conclusion: "success" }] },
    ]);
    // A deadline so a regression toward waiting fails the assertions below
    // rather than spawnSync's kill; a correct gate refuses on the first poll.
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "1" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("verify");
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "sleep")).toBe(false);
    expectGateRefused(entries);
  });

  it("never passes beside a same-named check-run no pinned job produced, and refuses at the deadline naming it", async () => {
    for (const [status, conclusion] of [["completed", "success"], ["in_progress", undefined]] as const) {
      const fixture = await makeFixture();
      const state = await writeGateState(
        fixture,
        "gate-unattributed",
        [
          { id: 100, path: FIXTURE_PINS.verify!, jobs: [{ id: 1001, name: "verify", status, conclusion }] },
          { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
        ],
        // A check-run created through the Checks API: no job record carries its id.
        [[9999, "verify"]],
      );
      const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "1" });

      expect(result.status, `${status}: ${result.stderr}`).toBe(1);
      expect(result.stderr, status).toContain("verify (unattributed check-run 9999)");
      expectGateRefused(await readLog(fixture.shimLog), status);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("passes once an unattributed check-run disappears or its pinned run appears on a later poll", async () => {
    for (const label of ["disappears", "run appears"]) {
      const fixture = await makeFixture();
      const deployGate: GateRun = {
        id: 200,
        path: FIXTURE_PINS["deploy-gate"]!,
        jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }],
      };
      const olderVerify: GateRun = {
        id: 100,
        path: FIXTURE_PINS.verify!,
        jobs: [{ id: 1001, name: "verify", status: "completed", conclusion: "success" }],
      };
      const newerVerify: GateRun = {
        id: 150,
        path: FIXTURE_PINS.verify!,
        jobs: [{ id: 1501, name: "verify", status: "completed", conclusion: "success" }],
      };
      // First poll: check-run 1501 is listed but no listed run carries its job.
      const first = await writeGateState(fixture, "gate-unattributed-first", [olderVerify, deployGate], [[1501, "verify"]]);
      const second =
        label === "disappears"
          ? await writeGateState(fixture, "gate-unattributed-gone", [olderVerify, deployGate])
          : await writeGateState(fixture, "gate-unattributed-attributed", [newerVerify, olderVerify, deployGate]);
      // Short enough that a regression toward waiting refuses before
      // spawnSync's kill, long enough that the second poll always runs: a
      // one-second deadline can expire inside the first poll, since bash's
      // SECONDS ticks on whole wall-clock seconds.
      const result = await runDeploy(fixture, {
        GH_SHIM_GATE_SEQUENCE: `${first}:${second}`,
        OVERFLOW_DEPLOY_CI_TIMEOUT: "30",
      });

      expect(result.status, `${label}: ${result.stderr}`).toBe(0);
      const entries = await readLog(fixture.shimLog);
      const checkRunsReads = entries.filter(
        (entry) => entry.cmd === "gh" && entry.args.some((arg) => arg.includes("check-runs?filter=all&per_page=100")),
      );
      expect(checkRunsReads, label).toHaveLength(2);
      expect(entries.some((entry) => entry.args[0] === "release:switch"), label).toBe(true);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("does not count a same-named job of a different pinned workflow as the check's producer", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-pinned-impostor", [
      { id: 100, path: FIXTURE_PINS.verify!, jobs: [{ id: 1001, name: "verify", status: "completed", conclusion: "success" }] },
      {
        id: 200,
        path: FIXTURE_PINS["deploy-gate"]!,
        jobs: [
          { id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" },
          { id: 2002, name: "verify", status: "completed", conclusion: "success" },
        ],
      },
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "1" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("2002");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("refuses immediately, naming it, when a required check has no pin in the map", async () => {
    const fixture = await makeFixture();
    const partial = path.join(fixture.dir, "required-checks-partial.json");
    await writeFile(partial, JSON.stringify({ verify: FIXTURE_PINS.verify }));
    const result = await runDeploy(fixture, { GIT_SHIM_REQUIRED_CHECKS: partial });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("deploy-gate");
    const entries = await readLog(fixture.shimLog);
    // Nothing is polled: the protection read and the map read, then refusal.
    expect(gateLog(entries)).toEqual(gateReads(FIXTURE_HASH).slice(0, 2));
    expectGateRefused(entries);
  });

  it("refuses when the pin map at the SHA is missing, unparsable or misshapen", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["missing at the SHA", { GIT_SHIM_SHOW_RC: "128" }],
      ["invalid JSON", { map: "{ not json" }],
      ["not an object", { map: JSON.stringify(Object.values(FIXTURE_PINS)) }],
      ["a non-string value", { map: JSON.stringify({ ...FIXTURE_PINS, verify: 7 }) }],
      ["a value outside .github/workflows/", { map: JSON.stringify({ ...FIXTURE_PINS, verify: "scripts/ci.yml" }) }],
      ["a nested workflow path", { map: JSON.stringify({ ...FIXTURE_PINS, verify: ".github/workflows/x/ci.yml" }) }],
      ["a non-YAML file", { map: JSON.stringify({ ...FIXTURE_PINS, verify: ".github/workflows/ci.json" }) }],
      ["a trailing newline in a value", { map: JSON.stringify({ ...FIXTURE_PINS, verify: ".github/workflows/ci.yml\n" }) }],
      [
        "two concatenated documents",
        { map: JSON.stringify(FIXTURE_PINS) + JSON.stringify({ ...FIXTURE_PINS, verify: ".github/workflows/other.yml" }) },
      ],
    ];
    for (const [label, { map, ...env }] of cases) {
      const fixture = await makeFixture();
      if (map !== undefined) await writeFile(fixture.requiredChecks, map);
      const result = await runDeploy(fixture, env);

      expect(result.status, `${label}: ${result.stderr}`).toBe(1);
      expect(result.stderr, label).toContain(MAP_PATH);
      expect(result.stderr, label).toContain(FIXTURE_HASH);
      // The map refusal itself, not the unmapped-context refusal a map read
      // as empty or as the wrong keys would reach: no required check is named.
      for (const check of Object.keys(FIXTURE_PINS)) expect(result.stderr, label).not.toContain(check);
      const entries = await readLog(fixture.shimLog);
      expect(gateLog(entries), label).toEqual(gateReads(FIXTURE_HASH).slice(0, 2));
      expectGateRefused(entries, label);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("refuses, naming the map and the SHA, when jq is not installed", async () => {
    const fixture = await makeFixture();
    // Every shim plus only the real binaries the run touches up to the gate:
    // bash and env for the shebangs, readlink for the anchor, cat for the
    // shims' canned output. No jq anywhere on this PATH.
    const noJqBins = path.join(fixture.dir, "bins-no-jq");
    await mkdir(noJqBins);
    for (const name of ALL_SHIMS) {
      const { envKeys, dispatch } = SHIM_DISPATCH[name]!;
      const file = path.join(noJqBins, name);
      await writeFile(file, shimBody(name, envKeys, dispatch));
      await chmod(file, 0o755);
    }
    for (const [link, target] of [
      ["bash", "/bin/bash"],
      ["env", "/usr/bin/env"],
      ["readlink", "/usr/bin/readlink"],
      ["cat", "/usr/bin/cat"],
    ] as const) {
      await symlink(target, path.join(noJqBins, link));
    }
    expect(
      spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8", env: { ...process.env, PATH: noJqBins } }).status,
      "the premise: no jq on the PATH",
    ).not.toBe(0);

    const result = await runDeploy(fixture, { PATH: noJqBins });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(MAP_PATH);
    expect(result.stderr).toContain(FIXTURE_HASH);
    const entries = await readLog(fixture.shimLog);
    expect(gateLog(entries)).toEqual(gateReads(FIXTURE_HASH).slice(0, 2));
    expectGateRefused(entries);
  });

  it("lets a rerun's latest attempt decide, wherever the jobs listing puts it", async () => {
    const attempts: GateJob[] = [
      { id: 1001, name: "verify", attempt: 1, status: "completed", conclusion: "failure" },
      { id: 1002, name: "verify", attempt: 2, status: "completed", conclusion: "success" },
    ];
    for (const [label, jobs] of [
      ["oldest first", attempts],
      ["newest first", [...attempts].reverse()],
    ] as const) {
      const fixture = await makeFixture();
      const state = await writeGateState(fixture, "gate-rerun", [
        { id: 100, path: FIXTURE_PINS.verify!, jobs: [...jobs] },
        { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
      ]);
      const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state });

      expect(result.status, `${label}: ${result.stderr}`).toBe(0);
      const entries = await readLog(fixture.shimLog);
      expect(entries.some((entry) => entry.args[0] === "release:switch"), label).toBe(true);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("refuses when a rerun's latest attempt failed after an earlier attempt passed", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-rerun-failed", [
      {
        id: 100,
        path: FIXTURE_PINS.verify!,
        jobs: [
          { id: 1001, name: "verify", attempt: 1, status: "completed", conclusion: "success" },
          { id: 1002, name: "verify", attempt: 2, status: "completed", conclusion: "failure" },
        ],
      },
      { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("verify");
    expect(result.stderr).toContain("failure");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("refuses when two same-named pinned jobs in one attempt split, one failed and one passed", async () => {
    const failed: GateJob = { id: 1001, name: "verify", attempt: 1, status: "completed", conclusion: "failure" };
    const passed: GateJob = { id: 1002, name: "verify", attempt: 1, status: "completed", conclusion: "success" };
    for (const [label, jobs] of [
      ["failed first", [failed, passed]],
      ["passed first", [passed, failed]],
    ] as const) {
      const fixture = await makeFixture();
      const state = await writeGateState(fixture, "gate-tie", [
        { id: 100, path: FIXTURE_PINS.verify!, jobs: [...jobs] },
        { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
      ]);
      const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state });

      expect(result.status, `${label}: ${result.stderr}`).toBe(1);
      expect(result.stderr, label).toContain("failure");
      expectGateRefused(await readLog(fixture.shimLog), label);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("lets the newest run of the pinned workflow decide when it ran more than once on the SHA", async () => {
    for (const [label, older, newer, status] of [
      ["newer run passed", "failure", "success", 0],
      ["newer run failed", "success", "failure", 1],
    ] as const) {
      for (const newestFirst of [true, false]) {
        const fixture = await makeFixture();
        const newerRun: GateRun = {
          id: 150,
          path: FIXTURE_PINS.verify!,
          jobs: [{ id: 1501, name: "verify", status: "completed", conclusion: newer }],
        };
        const olderRun: GateRun = {
          id: 100,
          path: FIXTURE_PINS.verify!,
          jobs: [{ id: 1001, name: "verify", status: "completed", conclusion: older }],
        };
        const state = await writeGateState(fixture, "gate-two-runs", [
          ...(newestFirst ? [newerRun, olderRun] : [olderRun, newerRun]),
          { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
        ]);
        const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state });

        expect(result.status, `${label}, newest first ${newestFirst}: ${result.stderr}`).toBe(status);
        await rm(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  it("waits as absent while the pinned run exists without the required job, then refuses at the deadline", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-job-absent", [
      { id: 100, path: FIXTURE_PINS.verify!, jobs: [{ id: 1001, name: "verify", status: "completed", conclusion: "success" }] },
      { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "setup", status: "completed", conclusion: "success" }] },
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "1" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("deploy-gate (absent)");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("refuses immediately when any poll read fails", async () => {
    for (const match of ["/check-runs", "/actions/runs?", "/jobs"]) {
      const fixture = await makeFixture();
      const result = await runDeploy(fixture, { GH_SHIM_FAIL_MATCH: match });

      expect(result.status, `${match}: ${result.stderr}`).toBe(1);
      expect(result.stderr, match).toContain(FIXTURE_HASH);
      const entries = await readLog(fixture.shimLog);
      expect(entries.some((entry) => entry.cmd === "sleep"), match).toBe(false);
      expectGateRefused(entries, match);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("refuses when the required-checks read itself fails", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { GH_SHIM_STATUS: "1" });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("could not determine required checks");
    const entries = await readLog(fixture.shimLog);
    expect(entries.filter((entry) => entry.cmd === "gh")).toHaveLength(1);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
  });

  it("refuses fail-closed when the gh binary is missing entirely", async () => {
    const fixture = await makeFixture();
    // A PATH that reaches no gh anywhere: the shims minus gh itself, plus
    // symlinks for the only real binaries the script touches before the gate
    // (bash for spawnSync and the shims' shebangs, readlink for the anchor).
    // On this host gh also lives in /usr/bin, so dropping that directory is
    // required, not just /usr/local/bin.
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
    ] as const) {
      await symlink(target, path.join(noGhBins, link));
    }
    const gatePath = `${noGhBins}:${fixture.dir}`;
    // The premise: with exactly this PATH, nothing named gh is reachable.
    expect(
      spawnSync("sh", ["-c", "command -v gh"], { encoding: "utf8", env: { ...process.env, PATH: gatePath } }).status,
    ).not.toBe(0);

    const result = await runDeploy(fixture, { PATH: gatePath });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("could not determine required checks");
    const entries = await readLog(fixture.shimLog);
    expect(entries.filter((entry) => entry.cmd === "gh")).toHaveLength(0);
    expectTreeNotMoved(entries);
    const started = entries.filter(
      (entry) =>
        entry.cmd === "pnpm" &&
        ["install", "db:migrate", "build", "release:switch", "release:prune"].includes(entry.args[0]!),
    );
    expect(started).toEqual([]);
    expect(entries.some((entry) => entry.cmd === "systemctl" && entry.args[0] === "restart")).toBe(false);
  });

  it("refuses when main's protection reads but declares no required checks", async () => {
    const fixture = await makeFixture();
    const empty = path.join(fixture.dir, "protection-empty.txt");
    await writeFile(empty, "");
    const result = await runDeploy(fixture, { GH_SHIM_PROTECTION_JSON: empty });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("could not determine required checks");
    const entries = await readLog(fixture.shimLog);
    expect(entries.filter((entry) => entry.cmd === "gh")).toHaveLength(1);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
  });

  it("skips the entire gate under OVERFLOW_DEPLOY_CI_GATE=skip, with a loud warning", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { OVERFLOW_DEPLOY_CI_GATE: "skip" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("OVERFLOW_DEPLOY_CI_GATE=skip");
    expect(result.stderr).toContain(`skipping the required-checks gate for ${FIXTURE_HASH}`);
    expect(result.stderr).toContain("CI is NOT verified");
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "gh")).toBe(false);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "release:switch")).toBe(true);
  });

  it("refuses on any other OVERFLOW_DEPLOY_CI_GATE value, naming the accepted one", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { OVERFLOW_DEPLOY_CI_GATE: "Skip" });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("OVERFLOW_DEPLOY_CI_GATE");
    expect(result.stderr).toContain("skip");
    const entries = await readLog(fixture.shimLog);
    expectTreeNotMoved(entries);
    expect(entries.some((entry) => entry.cmd === "gh")).toBe(false);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
  });

  it("refuses when remote.origin.url does not parse to an owner/repo pair", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, {
      GIT_SHIM_REMOTE_URL: "https://gitlab.com/overflow-fixture/overflow-fixture.git",
    });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("remote.origin.url");
    const entries = await readLog(fixture.shimLog);
    expectTreeNotMoved(entries);
    expect(entries.some((entry) => entry.cmd === "gh")).toBe(false);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
  });

  /**
   * The tree-cleanliness gate's refusals are pre-mutation: nothing after the
   * gate — fast-forward, install, migrate, prepare, build, switch, restart,
   * upgrade, prune — may start, and the CI gate must not run either, since a
   * dirty tree fails fast without waiting on GitHub.
   */
  function expectNoDeployStepRan(entries: ShimLogEntry[], label: string): void {
    expectTreeNotMoved(entries, label);
    const started = entries.filter(
      (entry) =>
        entry.cmd === "pnpm" &&
        ["install", "db:migrate", "build", "release:switch", "release:prune"].includes(entry.args[0]!),
    );
    expect(started, label).toEqual([]);
    expect(entries.some((entry) => entry.cmd === "node" && entry.args[1] === "scripts/release.ts"), label).toBe(false);
    expect(entries.some((entry) => entry.cmd === "systemctl"), label).toBe(false);
    expect(entries.some((entry) => entry.args.includes("webhooks:upgrade")), label).toBe(false);
    expect(entries.some((entry) => entry.cmd === "gh"), label).toBe(false);
  }

  it("refuses before the CI gate when the tree deviates from HEAD, for every dirt class", async () => {
    for (const [label, dirt] of [
      ["staged", "M  src/x.ts\n"],
      ["modified", " M src/x.ts\n"],
      ["untracked", "?? scratch.txt\n"],
    ] as const) {
      const fixture = await makeFixture();
      const result = await runDeploy(fixture, { GIT_SHIM_STATUS: dirt });

      expect(result.status, `${label}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(
        `The working tree in ${fixture.tree} deviates from HEAD; fast-forwarding it to ${FIXTURE_HASH} would not make it that commit.`,
      );
      expect(result.stderr).toContain("refusing to build one from a tree that is not that commit");
      expect(result.stdout, label).toContain(dirt.trimEnd());
      expectNoDeployStepRan(await readLog(fixture.shimLog), label);
    }
  });

  it("refuses fail-closed when the working-tree state itself cannot be read", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { GIT_SHIM_STATUS_RC: "1" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`Could not read the working-tree state in ${fixture.tree}`);
    expect(result.stderr).toContain("refusing to build a release whose source identity cannot be attested");
    expectNoDeployStepRan(await readLog(fixture.shimLog), "unreadable status");
  });

  /** The shim's GIT_SHIM_IGNORED value for these entries: each NUL-terminated, as -z prints them. */
  function ignoredListing(entries: readonly string[]): string {
    return entries.map((entry) => `${entry}\\0`).join("");
  }

  function expectIgnoredRefusal(stderr: string, tree: string, label: string): void {
    expect(stderr, label).toContain(`The tree in ${tree} holds the ignored untracked files above`);
    expect(stderr, label).toContain("ignored untracked files that git status does not show");
    expect(stderr, label).toContain(`a release named for ${FIXTURE_HASH}, a commit that does not contain them`);
    expect(stderr, label).toContain("HEAD, the index and the working tree are untouched; only the fetched refs moved");
    expect(stderr, label).toContain("Remove them, then re-run the deploy");
  }

  it("refuses before the CI gate when an ignored untracked entry lies outside the operational allowlist", async () => {
    // One fixture for every case; each run starts from an empty log.
    const fixture = await makeFixture();
    for (const offender of NEAR_MISS_IGNORED) {
      await writeFile(fixture.shimLog, "");
      const result = await runDeploy(fixture, {
        GIT_SHIM_IGNORED: ignoredListing([...OPERATIONAL_IGNORED, offender]),
      });

      expect(result.status, `${offender}: ${result.stderr}`).toBe(1);
      expectIgnoredRefusal(result.stderr, fixture.tree, offender);
      // Only the offender is listed: the operational entries beside it pass.
      expect(listedOffenders(result.stderr), offender).toEqual([offender]);
      expectNoDeployStepRan(await readLog(fixture.shimLog), offender);
    }
  });

  it("deploys when every ignored untracked entry is operational", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { GIT_SHIM_IGNORED: ignoredListing(OPERATIONAL_IGNORED) });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "git" && entry.args[0] === "merge")).toBe(true);
  });

  it("reads the listing NUL-delimited, so a name containing a newline is judged whole", async () => {
    // Split on newlines, this one name would read as two allowlisted entries.
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { GIT_SHIM_IGNORED: ignoredListing(["next-env.d.ts\\nnode_modules/"]) });

    expect(result.status, result.stderr).toBe(1);
    expectIgnoredRefusal(result.stderr, fixture.tree, "newline name");
    expectNoDeployStepRan(await readLog(fixture.shimLog), "newline name");
  });

  it("refuses fail-closed when the ignored untracked files cannot be listed, even after partial output", async () => {
    for (const [label, listing] of [
      ["no output", ""],
      ["partial output", ignoredListing(["node_modules/"])],
    ] as const) {
      const fixture = await makeFixture();
      const result = await runDeploy(fixture, { GIT_SHIM_IGNORED: listing, GIT_SHIM_IGNORED_RC: "128" });

      expect(result.status, `${label}: ${result.stderr}`).toBe(1);
      expect(result.stderr, label).toContain(
        `Could not list the ignored untracked files in ${fixture.tree} (git ls-files exited 128)`,
      );
      expect(result.stderr, label).toContain("refusing to build a release whose source identity cannot be attested");
      expect(result.stderr, label).toContain(
        "HEAD, the index and the working tree are untouched; only the fetched refs moved",
      );
      expectNoDeployStepRan(await readLog(fixture.shimLog), label);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("refuses as undetermined, not as a non-ancestor, when the ancestry check itself errors", async () => {
    // merge-base --is-ancestor answers "no" with exit 1; anything else is git
    // failing to answer (128 for an unreadable object or repository), which
    // must not be reported as a verdict about the tree's history.
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { GIT_SHIM_ANCESTOR_RC: "128" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      `Could not determine whether HEAD in ${fixture.tree} is an ancestor of the fetched main (${FIXTURE_HASH}): git merge-base exited 128`,
    );
    expect(result.stderr).not.toContain("is not an ancestor");
    expect(result.stderr).toContain("HEAD, the index and the working tree are untouched; only the fetched refs moved");
    expect((await readLog(fixture.shimLog)).map(describeEntry)).toEqual([
      `flock -w 900 9`,
      `git fetch origin main`,
      `git rev-parse --verify FETCH_HEAD^{commit}`,
      `git merge-base --is-ancestor HEAD ${FIXTURE_HASH}`,
    ]);
  });

  it("refuses before either gate when HEAD cannot fast-forward to the fetched commit", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, { GIT_SHIM_ANCESTOR_RC: "1" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`HEAD in ${fixture.tree} is not an ancestor of the fetched main (${FIXTURE_HASH})`);
    expect(result.stderr).toContain("HEAD, the index and the working tree are untouched; only the fetched refs moved");
    expect((await readLog(fixture.shimLog)).map(describeEntry)).toEqual([
      `flock -w 900 9`,
      `git fetch origin main`,
      `git rev-parse --verify FETCH_HEAD^{commit}`,
      `git merge-base --is-ancestor HEAD ${FIXTURE_HASH}`,
    ]);
  });

  it("records the exact source SHA in the release's REVISION, surviving the build's clean step, and prints it to the deploy record", async () => {
    // The shim's build branch wipes the release directory the way Next's
    // clean step does (everything outside cache|dev|lock|trace), so this is a
    // wipe-survival assertion: a record written before the build is deleted
    // before this reads it.
    const fixture = await makeFixture();
    const fullSha = "0123456789abcdef0123456789abcdef01234567";
    const result = await runDeploy(fixture, { GIT_SHIM_HASH_FULL: fullSha });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const entries = await readLog(fixture.shimLog);
    const release = entries.find((entry) => entry.cmd === "node")!.args[3]!;
    await expect(readFile(path.join(fixture.tree, release, "REVISION"), "utf8")).resolves.toBe(`${fullSha}\n`);
    expect(result.stdout).toContain(`Source revision: ${fullSha}`);
  });

  it("skips install, migrate and build when the fetched commit is the one already serving", async () => {
    const fixture = await makeFixture();
    await writeFile(path.join(fixture.prevDir, "REVISION"), `${FIXTURE_HASH}\n`);
    const result = await runDeploy(fixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain(`Already serving ${realpathSync(fixture.prevDir)} (${FIXTURE_HASH})`);
    // Nothing after the fast-forward runs: the log is exactly the fence, the
    // fetch, the SHA resolution, the ancestry check, the cleanliness read, the
    // gate's reads and the fast-forward itself.
    const entries = await readLog(fixture.shimLog);
    expect(entries.map(describeEntry)).toEqual([
      `flock -w 900 9`,
      `git fetch origin main`,
      `git rev-parse --verify FETCH_HEAD^{commit}`,
      `git merge-base --is-ancestor HEAD ${FIXTURE_HASH}`,
      `git status --porcelain=v1 -uall`,
      IGNORED_LISTING,
      `git config --get remote.origin.url`,
      ...gateReads(FIXTURE_HASH),
      `git merge --ff-only ${FIXTURE_HASH}`,
    ]);
    const grammarNames = (await readdir(fixture.tree)).filter((name) => RELEASE_GRAMMAR.test(name));
    expect(grammarNames.sort()).toEqual(
      [
        ".next-release-20260801T000000Z-def5678",
        ".next-release-20260906T000000Z-abc1234",
        ".next-release-20260907T000000Z-def5678",
        ".next-release-20260908T000000Z-abc1234",
      ].sort(),
    );
  });

  it("proceeds with the full deploy when the serving release records a different commit", async () => {
    const fixture = await makeFixture();
    await writeFile(path.join(fixture.prevDir, "REVISION"), "0000000000000000000000000000000000000000\n");
    const result = await runDeploy(fixture);

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(true);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "build")).toBe(true);
  });

  it("proceeds when the serving release records no REVISION at all", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture);

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(true);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "build")).toBe(true);
  });

  it("does not skip on a dangling anchor, and the run still refuses the unusable serving state downstream", async () => {
    const fixture = await makeFixture();
    await rm(path.join(fixture.tree, ".next"));
    await symlink(".next-release-20260101T000000Z-dead1234", path.join(fixture.tree, ".next"));
    const result = await runDeploy(fixture);

    // No skip: the install started. The run then refuses at the pre-existing
    // test -d on the dangling anchor's cache, as it already did before this
    // gate existed.
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).not.toContain("Already serving");
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(true);
  });

  it("matches real git: silent on a production-shaped ignored tree, loud once a tracked file changes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "overflow-deploy-revision-git-"));
    try {
      const git = (...args: string[]): string => {
        const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
      };
      const status = (): string =>
        spawnSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: repo, encoding: "utf8" }).stdout;
      git("init");
      // The repo's .gitignore is tracked, so the fixture commits its copy:
      // the clean assertion below must read as the command's real semantics
      // (ignored operational state is silent), not as the ignore file's own
      // untracked status — the file unignores itself.
      await writeFile(path.join(repo, ".gitignore"), await readFile(repoGitignore, "utf8"));
      git("add", ".gitignore");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "gitignore");
      const releaseDir = ".next-release-20260908T000000Z-abc1234";
      await mkdir(path.join(repo, releaseDir, "cache"), { recursive: true });
      await writeFile(path.join(repo, releaseDir, "BUILD_ID"), releaseDir);
      await symlink(releaseDir, path.join(repo, ".next"));
      await mkdir(path.join(repo, "node_modules", "x"), { recursive: true });
      await writeFile(path.join(repo, "node_modules", "x", "y"), "y");
      await writeFile(path.join(repo, "next-env.d.ts"), "regenerated\n");
      await writeFile(path.join(repo, `${releaseDir}.tsconfig.json`), "{}\n");
      await mkdir(path.join(repo, ".next-release-notes"));
      await writeFile(path.join(repo, ".next-release-notes", "note.txt"), "note\n");
      expect(status()).toBe("");
      // Invisible to status, yet all present: the ignored-files gate's listing
      // yields each in exactly the shape its allowlist names.
      const ignored = git("ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory")
        .split("\0")
        .filter((entry) => entry !== "");
      expect(ignored.sort()).toEqual(
        [".next", `${releaseDir}/`, `${releaseDir}.tsconfig.json`, ".next-release-notes/", "next-env.d.ts", "node_modules/"].sort(),
      );
      for (const entry of ignored) expect(OPERATIONAL_IGNORED, entry).toContain(entry);

      // README.md is a path the ignore file names back, as every tracked file
      // in the repo must be, so the mutation is the natural tracked shape.
      await writeFile(path.join(repo, "README.md"), "one\n");
      git("add", "README.md");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "readme");
      await writeFile(path.join(repo, "README.md"), "two\n");
      expect(status()).not.toBe("");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("places both gates between the fetch and the fast-forward, and writes REVISION from the full SHA", async () => {
    const source = await readFile(script, "utf8");
    expect(source).toContain("git status --porcelain=v1 -uall");
    expect(source).toContain("printf '%s\\n' \"$full_sha\" > \"$release/REVISION\"");
    // A refused gate must leave the tree where it was, so nothing moves HEAD
    // before the last gate: fetch (which only writes refs), resolve, check the
    // fast-forward is possible, both gates, and only then the fast-forward.
    expect(source).not.toMatch(/git pull/);
    const atAnchor = source.indexOf("expected_serving=$(readlink -f");
    const atFetch = source.indexOf("git fetch origin main");
    const atSha = source.indexOf("full_sha=$(git rev-parse --verify 'FETCH_HEAD^{commit}')");
    const atAncestry = source.indexOf('git merge-base --is-ancestor HEAD "$full_sha"');
    const atGate = source.indexOf("git status --porcelain=v1 -uall");
    const atIgnoredGate = source.indexOf(
      "git ls-files -z --others --ignored --exclude-standard --directory --no-empty-directory",
    );
    const atCiGate = source.indexOf('case "${OVERFLOW_DEPLOY_CI_GATE:-}"');
    const atMerge = source.indexOf('git merge --ff-only "$full_sha"');
    const atEsac = source.lastIndexOf("esac", atMerge);
    const atSkip = source.indexOf("Already serving");
    expect(atAnchor, "the anchor present").toBeGreaterThanOrEqual(0);
    expect(atFetch, "the fetch after the anchor").toBeGreaterThan(atAnchor);
    expect(atSha, "full_sha from the fetched commit, after the fetch").toBeGreaterThan(atFetch);
    expect(atAncestry, "the ancestry check after full_sha").toBeGreaterThan(atSha);
    expect(atGate, "the cleanliness gate after the ancestry check").toBeGreaterThan(atAncestry);
    expect(atIgnoredGate, "the ignored-files gate after the cleanliness gate").toBeGreaterThan(atGate);
    expect(atCiGate, "the CI gate after the ignored-files gate").toBeGreaterThan(atIgnoredGate);
    expect(atEsac, "the CI gate's esac after its case").toBeGreaterThan(atCiGate);
    expect(atMerge, "the fast-forward after the CI gate").toBeGreaterThan(atEsac);
    expect(atSkip, "the redundant-deploy skip after the fast-forward").toBeGreaterThan(atMerge);
    // The record must be written after the build — the build's clean step
    // wipes the release directory (everything outside cache|dev|lock|trace) —
    // and after the webhook upgrade's status test: it attests a fully
    // deployed release, so a run that failed after the switch leaves no
    // record and its retry re-runs everything.
    const atRevision = source.indexOf("printf '%s\\n' \"$full_sha\" > \"$release/REVISION\"");
    const atUpgradeGate = source.indexOf('test "$upgrade_status" -eq 0 || exit "$upgrade_status"');
    expect(atRevision, "the REVISION write present").toBeGreaterThan(-1);
    expect(atUpgradeGate, "the upgrade-status test present").toBeGreaterThan(-1);
    expect(atRevision, "the REVISION write after the upgrade-status test").toBeGreaterThan(atUpgradeGate);
  });

  it("places the redundant-deploy skip after the CI-gate case and before the install", async () => {
    const source = await readFile(script, "utf8");
    expect(source).toContain('if [ "$(cat "$serving_release/REVISION")" = "$full_sha" ]; then');
    expect(source).toContain('[ -f "$serving_release/REVISION" ]');
    expect(source).toContain("Already serving");
    // After the required-checks gate, so the gate's refusal semantics are
    // untouched; before the install, so a skip mutates nothing. The esac that
    // matters is the CI-gate's own closing line, found searching back from
    // the install so the skip block's own text cannot confuse the pin.
    const atInstall = source.indexOf("npm_config_package_import_method=copy pnpm install");
    const atEsac = source.lastIndexOf("esac", atInstall);
    const atSkip = source.indexOf("Already serving");
    expect(atEsac, "the CI-gate esac present").toBeGreaterThan(-1);
    expect(atSkip, "the skip after the CI-gate case").toBeGreaterThan(atEsac);
    expect(atInstall, "the install after the skip").toBeGreaterThan(atSkip);
  });
});

/**
 * The refusal regressions against real git: the shims above make every git
 * call succeed, so only a real repository shows whether a refused deploy has
 * already moved the tree. The fixture tree becomes a checkout three commits
 * behind an origin repo. Its origin URL is github-shaped, so the CI gate
 * parses the fixture slug, and a clone-local insteadOf rewrites it to the
 * origin repo, so the fetch never leaves the fixture. The origin commits a
 * .gitignore for the fixture's release layout, so the tree starts clean.
 * The clone fetches BEFORE origin gains its three commits, so its FETCH_HEAD
 * and origin/main both sit at the base: only the deploy's own fetch can
 * bring the tip.
 * Global and system git config are shut out of the fixture and the deploy
 * alike, so a host setting (pull.rebase, say) cannot decide the outcome.
 */
const HERMETIC_GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
/** The one tracked source file makeGitFixture commits under src/. */
const SOURCE_PATH = "src/app/page.tsx";

async function makeGitFixture(): Promise<{ fixture: Fixture; behind: string; tip: string; git: (...args: string[]) => string }> {
  const fixture = await makeFixture();
  const origin = path.join(fixture.dir, "origin");
  const run = (cwd: string, args: string[]): string => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...HERMETIC_GIT_ENV },
    });
    expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  await mkdir(origin);
  run(origin, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(origin, ".gitignore"), "/.next\n/.next-release-*\n");
  await writeFile(path.join(origin, "app.txt"), "stable\n");
  // Tracked source under src/app/, as production's tree has: without it git
  // reports an ignored path planted there as src/ itself, beside the path.
  await mkdir(path.join(origin, "src", "app"), { recursive: true });
  await writeFile(path.join(origin, SOURCE_PATH), "export default function Page() { return null; }\n");
  // The gate reads the pin map from the deployed commit itself.
  await mkdir(path.join(origin, ".github"));
  await writeFile(path.join(origin, MAP_PATH), await readFile(fixture.requiredChecks, "utf8"));
  run(origin, ["add", ".gitignore", "app.txt", SOURCE_PATH, MAP_PATH]);
  run(origin, ["commit", "-q", "-m", "base"]);
  const behind = run(origin, ["rev-parse", "HEAD"]);
  const git = (...args: string[]): string => run(fixture.tree, args);
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", FIXTURE_REMOTE_URL);
  git("config", `url.${origin}.insteadOf`, FIXTURE_REMOTE_URL);
  git("fetch", "-q", "origin", "main");
  git("checkout", "-q", "-B", "main", behind);
  for (const n of [1, 2, 3]) {
    await writeFile(path.join(origin, "incoming.txt"), `${n}\n`);
    run(origin, ["add", "incoming.txt"]);
    run(origin, ["commit", "-q", "-m", `incoming ${n}`]);
  }
  const tip = run(origin, ["rev-parse", "HEAD"]);
  expect(git("status", "--porcelain=v1", "-uall"), "the fixture tree starts clean").toBe("");
  for (const ref of ["FETCH_HEAD", "origin/main"]) {
    expect(git("rev-parse", ref), `${ref} starts at the base, not the tip`).toBe(behind);
  }
  return { fixture, behind, tip, git };
}

describe("scripts/deploy-revision.sh against a real git tree", () => {
  const realGit = { omitShims: ["git"] };

  it("leaves HEAD where it was when the CI-gate setting is refused", async () => {
    const { fixture, behind, git } = await makeGitFixture();
    const result = await runDeploy(fixture, { ...HERMETIC_GIT_ENV, OVERFLOW_DEPLOY_CI_GATE: "bogus" }, realGit);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("OVERFLOW_DEPLOY_CI_GATE=bogus is not a supported value");
    expect(git("rev-parse", "HEAD")).toBe(behind);
  });

  it("leaves HEAD where it was when a required check on the fetched commit concluded failure", async () => {
    const { fixture, behind, tip, git } = await makeGitFixture();
    const failed = await writeCheckRuns(fixture, "gate-failed", [
      ["verify", "completed", "failure"],
      ["deploy-gate", "completed", "success"],
    ]);
    const result = await runDeploy(fixture, { ...HERMETIC_GIT_ENV, GH_SHIM_GATE_SEQUENCE: failed }, realGit);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`Required check verify concluded failure on ${tip}`);
    expect(git("rev-parse", "HEAD")).toBe(behind);
  });

  it("leaves HEAD and the deviation where they were when the tree is dirty", async () => {
    const { fixture, behind, git } = await makeGitFixture();
    await writeFile(path.join(fixture.tree, "app.txt"), "edited in place\n");
    const result = await runDeploy(fixture, { ...HERMETIC_GIT_ENV, OVERFLOW_DEPLOY_CI_GATE: "skip" }, realGit);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`The working tree in ${fixture.tree} deviates from HEAD`);
    expect(git("rev-parse", "HEAD")).toBe(behind);
    expect(git("status", "--porcelain=v1", "-uall")).toBe("M app.txt");
  });

  it("refuses a tree that diverged from main before either gate, leaving HEAD where it was", async () => {
    const { fixture, tip, git } = await makeGitFixture();
    await writeFile(path.join(fixture.tree, "local.txt"), "local only\n");
    git("add", "local.txt");
    git("commit", "-q", "-m", "local commit not on main");
    const diverged = git("rev-parse", "HEAD");
    const result = await runDeploy(fixture, HERMETIC_GIT_ENV, realGit);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`HEAD in ${fixture.tree} is not an ancestor of the fetched main (${tip})`);
    expect(result.stderr).toContain("HEAD, the index and the working tree are untouched; only the fetched refs moved");
    expect(git("rev-parse", "HEAD")).toBe(diverged);
    expect((await readLog(fixture.shimLog)).some((entry) => entry.cmd === "gh"), "the CI gate never ran").toBe(false);
  });

  it("refuses a tree ahead of main before either gate, leaving HEAD where it was", async () => {
    const { fixture, tip, git } = await makeGitFixture();
    // The clone catches up to main, then carries one commit main does not
    // have: HEAD is a descendant of the fetched tip, never an ancestor.
    git("fetch", "-q", "origin", "main");
    git("merge", "-q", "--ff-only", tip);
    await writeFile(path.join(fixture.tree, "local.txt"), "local only\n");
    git("add", "local.txt");
    git("commit", "-q", "-m", "local commit ahead of main");
    const ahead = git("rev-parse", "HEAD");
    const result = await runDeploy(fixture, HERMETIC_GIT_ENV, realGit);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`HEAD in ${fixture.tree} is not an ancestor of the fetched main (${tip})`);
    expect(git("rev-parse", "HEAD")).toBe(ahead);
    expect(git("status", "--porcelain=v1", "-uall")).toBe("");
    expect((await readLog(fixture.shimLog)).some((entry) => entry.cmd === "gh"), "the CI gate never ran").toBe(false);
  });

  it("deploys what its own fetch retrieved even when no refspec maps main to origin/main", async () => {
    const { fixture, behind, tip, git } = await makeGitFixture();
    // A single-branch or custom-refspec clone: the fetch writes FETCH_HEAD but
    // leaves origin/main where it was, at the base.
    git("config", "--unset-all", "remote.origin.fetch");
    const result = await runDeploy(fixture, HERMETIC_GIT_ENV, realGit);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(git("rev-parse", "origin/main"), "the premise: origin/main did not move").toBe(behind);
    expect(git("rev-parse", "HEAD")).toBe(tip);
  });

  it("fast-forwards to the fetched commit once the gates pass, and records it as the release's source", async () => {
    const { fixture, tip, git } = await makeGitFixture();
    const result = await runDeploy(fixture, HERMETIC_GIT_ENV, realGit);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(tip);
    const entries = await readLog(fixture.shimLog);
    // Real git logs nothing; its pin-map read is proved by the gate passing.
    expect(gateLog(entries)).toEqual(gateReads(tip).filter((line) => !line.startsWith("git ")));
    const release = entries.find((entry) => entry.cmd === "node")!.args[3]!;
    expect(release.endsWith(`-${tip.slice(0, 7)}`)).toBe(true);
    await expect(readFile(path.join(fixture.tree, release, "REVISION"), "utf8")).resolves.toBe(`${tip}\n`);
  });

  /**
   * Gives the fixture tree the repository's own deny-by-default ignore rules
   * without a tracked change: info/exclude feeds both git status and
   * ls-files --exclude-standard, and the tree's HEAD stays exactly the base.
   */
  async function denyByDefault(tree: string, git: (...args: string[]) => string): Promise<void> {
    await writeFile(path.join(tree, ".git", "info", "exclude"), await readFile(repoGitignore, "utf8"));
    expect(git("status", "--porcelain=v1", "-uall"), "the deny-by-default tree starts clean").toBe("");
  }

  it("refuses an ignored untracked source file before the CI gate, leaving HEAD and the file where they were", async () => {
    const { fixture, behind, git } = await makeGitFixture();
    await denyByDefault(fixture.tree, git);
    const probe = path.join(fixture.tree, "src", "app", "zz-probe", "page.tsx");
    await mkdir(path.dirname(probe), { recursive: true });
    await writeFile(probe, "export default function Probe() { return null; }\n");
    // The premise: git status cannot see it, so only the new gate can.
    expect(git("status", "--porcelain=v1", "-uall")).toBe("");
    const result = await runDeploy(fixture, HERMETIC_GIT_ENV, realGit);

    expect(result.status, result.stderr).toBe(1);
    // The planted directory is the only offender: the tracked src/app/page.tsx
    // keeps git from reporting src/ itself, so nothing else can carry the refusal.
    expect(listedOffenders(result.stderr)).toEqual(["src/app/zz-probe/"]);
    expect(result.stderr).toContain(`The tree in ${fixture.tree} holds the ignored untracked files above`);
    expect(result.stderr).toContain("HEAD, the index and the working tree are untouched; only the fetched refs moved");
    expect(git("rev-parse", "HEAD")).toBe(behind);
    await expect(readFile(probe, "utf8")).resolves.toContain("Probe");
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "gh"), "the CI gate never ran").toBe(false);
    expect(entries.some((entry) => entry.cmd === "pnpm"), "nothing after the gates ran").toBe(false);
  });

  it("deploys a tree holding exactly production's ignored operational layout", async () => {
    const { fixture, tip, git } = await makeGitFixture();
    await denyByDefault(fixture.tree, git);
    // makeFixture already holds grammar-named release directories and the
    // .next symlink; add the rest of what production's tree holds.
    const serving = path.basename(fixture.prevDir);
    await writeFile(path.join(fixture.tree, `${serving}.tsconfig.json`), "{}\n");
    await mkdir(path.join(fixture.tree, ".next-release-notes"));
    await writeFile(path.join(fixture.tree, ".next-release-notes", "note.txt"), "note\n");
    await mkdir(path.join(fixture.tree, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(fixture.tree, "node_modules", "x", "y"), "y");
    await writeFile(path.join(fixture.tree, "next-env.d.ts"), "regenerated\n");
    // The premise: every allowlist shape is really present in the listing.
    const listed = git("ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory")
      .split("\n");
    expect(listed.sort()).toEqual(
      [
        ".next",
        ".next-release-20260801T000000Z-def5678/",
        ".next-release-20260906T000000Z-abc1234/",
        ".next-release-20260907T000000Z-def5678/",
        ".next-release-20260908T000000Z-abc1234.tsconfig.json",
        ".next-release-20260908T000000Z-abc1234/",
        ".next-release-notes/",
        "next-env.d.ts",
        "node_modules/",
      ].sort(),
    );
    const result = await runDeploy(fixture, HERMETIC_GIT_ENV, realGit);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(tip);
  });

  it("refuses a near-miss of an allowlisted name, so the allowlist is anchored at the tree root", async () => {
    for (const nearMiss of [".next-release-bogus", path.join("src", "node_modules")]) {
      const { fixture, behind, git } = await makeGitFixture();
      await denyByDefault(fixture.tree, git);
      await mkdir(path.join(fixture.tree, nearMiss), { recursive: true });
      await writeFile(path.join(fixture.tree, nearMiss, "f"), "f\n");
      const result = await runDeploy(fixture, HERMETIC_GIT_ENV, realGit);

      expect(result.status, `${nearMiss}: ${result.stderr}`).toBe(1);
      expect(listedOffenders(result.stderr), nearMiss).toEqual([`${nearMiss}/`]);
      expect(git("rev-parse", "HEAD"), nearMiss).toBe(behind);
      expect((await readLog(fixture.shimLog)).some((entry) => entry.cmd === "gh"), nearMiss).toBe(false);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("deploys past an ignored empty directory, since nothing in it can be compiled", async () => {
    const { fixture, tip, git } = await makeGitFixture();
    await denyByDefault(fixture.tree, git);
    const empty = path.join(fixture.tree, "src", "app", "empty");
    await mkdir(empty);
    // The premise: git does report it to a listing that keeps empty directories.
    expect(git("ls-files", "--others", "--ignored", "--exclude-standard", "--directory")).toContain("src/app/empty/");
    const result = await runDeploy(fixture, HERMETIC_GIT_ENV, realGit);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(tip);
  });
});

describe("deploy/README.md section 10 pins the committed script as the procedure", () => {
  it("names scripts/deploy-revision.sh as the procedure to run", async () => {
    expect(await section10()).toContain("bash scripts/deploy-revision.sh");
  });

  it("names the sign-in smoke beside readiness in section 7 and section 10's verification", async () => {
    const markdown = await readFile(readme, "utf8");
    const section7 = markdown.split("## 7. Verify")[1]!.split("## 8. ")[0]!;
    for (const section of [section7, await section10()]) {
      expect(section).toContain("http://127.0.0.1:3000/api/auth/providers");
      expect(section).toContain("sign-in smoke");
    }
  });

  it("keeps the standing block's fence and --expect-current lines in the manual fallback", async () => {
    const section = await section10();
    const blocks = [...section.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    const standing = blocks.find((block) => block.includes("git pull --ff-only origin main"));
    expect(standing, "the manual standing block").toBeDefined();
    expect(standing, "the fd 9 fence line").toContain("exec 9>/run/overflow-deploy.lock");
    expect(standing).toContain('pnpm release:switch /srv/overflow "$release" --expect-current "$expected_serving"');
  });

  it("keeps the retention listing's -regextype posix-extended line", async () => {
    const section = await section10();
    const blocks = [...section.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    const listing = blocks.find((block) => block.includes("-printf '%f\\n'"));
    expect(listing, "the retention listing block").toBeDefined();
    expect(listing).toContain("-regextype posix-extended");
  });
});
