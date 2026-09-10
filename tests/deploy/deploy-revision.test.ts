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
  checkRunsSuccess: string;
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
const JQ_CHECKRUNS = `.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv`;
const RELEASE_GRAMMAR = /^\.next-release-\d{8}T\d{6}Z-[a-f0-9]{7,40}$/;
const LISTING_REGEX = String.raw`.*/\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}`;

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
  // yields one required-check name per line, and the check-runs call yields
  // `name\tstatus\tconclusion` TSV. The argv-shape assertions below still pin
  // that the script passes those exact --jq programs.
  const protectionJson = path.join(dir, "protection.txt");
  await writeFile(protectionJson, "verify\ndeploy-gate\n");
  const checkRunsSuccess = path.join(dir, "check-runs-success.txt");
  await writeFile(
    checkRunsSuccess,
    [
      "verify\tcompleted\tsuccess",
      "deploy-gate\tcompleted\tsuccess",
      "claim\tcompleted\tsuccess",
    ].join("\n") + "\n",
  );
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
    checkRunsSuccess,
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
if [ "$1" = pull ]; then
  if [ -n "\${GIT_SHIM_PULL_REPOINT:-}" ]; then
    ln -sfn "$GIT_SHIM_PULL_REPOINT" "\${GIT_SHIM_TREE:?}/.next"
  fi
  exit 0
fi
if [ "$1" = status ]; then
  printf '%s' "\${GIT_SHIM_STATUS:-}"
  exit "\${GIT_SHIM_STATUS_RC:-0}"
fi
if [ "$1" = rev-parse ]; then
  if [ "$2" = "--short=7" ]; then
    printf '%s\\n' "\${GIT_SHIM_HASH:-}"
    exit 0
  fi
  printf '%s\\n' "\${GIT_SHIM_HASH_FULL:-\${GIT_SHIM_HASH:-}}"
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
    envKeys: ["GH_SHIM_PROTECTION_JSON", "GH_SHIM_CHECKRUNS_SEQUENCE", "GH_SHIM_STATUS"],
    dispatch: `
if [ -n "\${GH_SHIM_STATUS:-}" ] && [ "\$GH_SHIM_STATUS" != 0 ]; then exit "\$GH_SHIM_STATUS"; fi
path=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = api ]; then path="\$a"; fi
  prev="\$a"
done
case "\$path" in
  */branches/main/protection)
    cat "\${GH_SHIM_PROTECTION_JSON:?}"
    ;;
  */check-runs*)
    idx_file="\${SHIM_LOG:?}.gh-seq"
    idx=\$(cat "\$idx_file" 2>/dev/null || printf '0')
    IFS=':' read -r -a seq_files <<< "\${GH_SHIM_CHECKRUNS_SEQUENCE:?}"
    if [ "\$idx" -ge \${#seq_files[@]} ]; then idx=\$((\${#seq_files[@]} - 1)); fi
    cat "\${seq_files[\$idx]}"
    printf '%s' "\$((idx + 1))" > "\$idx_file"
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
    envKeys: [],
    dispatch: `
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

async function runDeploy(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
  options: { omitFlockShim?: boolean } = {},
) {
  const names = options.omitFlockShim ? ALL_SHIMS.filter((name) => name !== "flock") : ALL_SHIMS;
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
      GH_SHIM_CHECKRUNS_SEQUENCE: fixture.checkRunsSuccess,
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
      `git pull --ff-only origin main`,
      `git rev-parse HEAD`,
      `git status --porcelain=v1 -uall`,
      `git config --get remote.origin.url`,
      `gh api repos/${FIXTURE_REPO}/branches/main/protection --jq ${JQ_PROTECTION}`,
      `gh api repos/${FIXTURE_REPO}/commits/${FIXTURE_HASH}/check-runs?per_page=100 --paginate --jq ${JQ_CHECKRUNS}`,
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

  it("passes --expect-current the pre-pull anchor, not a value re-read after the pull", async () => {
    const fixture = await makeFixture({
      extraReleases: [
        ".next-release-20260701T000000Z-abc1234",
        ".next-release-20260601T000000Z-def5678",
        ".next-release-20260501T000000Z-abc1234",
      ],
    });
    // The pull moves the serving release out from under the deploy, as a
    // concurrent off-procedure actor would: a re-read anchor would name the new
    // release, and the conditional switch must still receive the old one.
    const repointed = ".next-release-20260701T000000Z-abc1234";
    const result = await runDeploy(fixture, { GIT_SHIM_PULL_REPOINT: repointed });

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

  it("satisfies the fence with the real flock binary, proving the fd 9 wiring", async () => {
    const fixture = await makeFixture();
    const result = await runDeploy(fixture, {}, { omitFlockShim: true });

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
    expect(source).toContain('"repos/$repo/commits/$full_sha/check-runs?per_page=100"');
    expect(source).toContain("--paginate");
    expect(source).toContain("OVERFLOW_DEPLOY_CI_TIMEOUT");
    expect(source).toContain("OVERFLOW_DEPLOY_CI_GATE");
    expect(source).toContain('git rev-parse HEAD');
  });

  async function writeCheckRuns(
    fixture: Fixture,
    name: string,
    rows: Array<[string, string, string?]>,
  ): Promise<string> {
    const file = path.join(fixture.dir, name);
    await writeFile(
      file,
      rows.map(([n, status, conclusion]) => [n, status, conclusion ?? ""].join("\t")).join("\n") + "\n",
    );
    return file;
  }

  it("refuses before install when a required check's latest run failed", async () => {
    const fixture = await makeFixture();
    const failed = await writeCheckRuns(fixture, "check-runs-failed.txt", [
      ["verify", "completed", "failure"],
      ["deploy-gate", "completed", "success"],
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_CHECKRUNS_SEQUENCE: failed });

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
    expect(entries.filter((entry) => entry.cmd === "gh")).toHaveLength(2);
  });

  it("refuses fail-closed when a required check has no check run on the SHA", async () => {
    const fixture = await makeFixture();
    const absent = await writeCheckRuns(fixture, "check-runs-absent.txt", [
      ["verify", "completed", "success"],
      ["claim", "completed", "success"],
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_CHECKRUNS_SEQUENCE: absent });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("deploy-gate");
    expect(result.stderr).toContain("absent");
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
    expect(entries.filter((entry) => entry.cmd === "gh")).toHaveLength(2);
  });

  it("waits for a pending required check and proceeds once it succeeds", async () => {
    const fixture = await makeFixture();
    const pending = await writeCheckRuns(fixture, "check-runs-pending.txt", [
      ["verify", "completed", "success"],
      ["deploy-gate", "in_progress"],
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_CHECKRUNS_SEQUENCE: `${pending}:${fixture.checkRunsSuccess}`,
    });

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    const isCheckRuns = (entry: ShimLogEntry) =>
      entry.cmd === "gh" && entry.args.some((arg) => arg.includes("check-runs?per_page=100"));
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
    const pending = await writeCheckRuns(fixture, "check-runs-stuck-pending.txt", [
      ["verify", "completed", "success"],
      ["deploy-gate", "in_progress"],
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_CHECKRUNS_SEQUENCE: pending,
      OVERFLOW_DEPLOY_CI_TIMEOUT: "1",
    });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("deploy-gate");
    expect(result.stderr).toContain("pending");
    expect(result.stderr).toContain("nothing has been mutated");
    const entries = await readLog(fixture.shimLog);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
    expect(entries.some((entry) => entry.args[0] === "release:switch")).toBe(false);
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
    expect(entries.some((entry) => entry.cmd === "gh")).toBe(false);
    expect(entries.some((entry) => entry.cmd === "pnpm" && entry.args[0] === "install")).toBe(false);
  });

  /**
   * The tree-cleanliness gate's refusals are pre-mutation: nothing after the
   * gate — install, migrate, prepare, build, switch, restart, upgrade, prune —
   * may start, and the CI gate must not run either, since a dirty tree fails
   * fast without waiting on GitHub.
   */
  function expectNoDeployStepRan(entries: ShimLogEntry[], label: string): void {
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
        `The working tree in ${fixture.tree} deviates from HEAD (${FIXTURE_HASH})`,
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
      expect(status()).toBe("");

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

  it("places the tree-cleanliness gate after the SHA resolution and before the CI gate, and writes REVISION from the full SHA", async () => {
    const source = await readFile(script, "utf8");
    expect(source).toContain("git status --porcelain=v1 -uall");
    expect(source).toContain("printf '%s\\n' \"$full_sha\" > \"$release/REVISION\"");
    const atSha = source.indexOf("full_sha=$(git rev-parse HEAD)");
    const atGate = source.indexOf("git status --porcelain=v1 -uall");
    const atCiGate = source.indexOf('case "${OVERFLOW_DEPLOY_CI_GATE:-}"');
    expect(atSha).toBeGreaterThanOrEqual(0);
    expect(atGate, "the gate after full_sha").toBeGreaterThan(atSha);
    expect(atCiGate, "the CI gate after the cleanliness gate").toBeGreaterThan(atGate);
    // The record must be written after the build: the build's clean step
    // wipes the release directory (everything outside cache|dev|lock|trace),
    // so a pre-build write is deleted by the build it precedes.
    const atRevision = source.indexOf("printf '%s\\n' \"$full_sha\" > \"$release/REVISION\"");
    const atBuild = source.indexOf('NEXT_DIST_DIR="$release" pnpm build');
    expect(atRevision, "the REVISION write present").toBeGreaterThan(-1);
    expect(atBuild, "the build line present").toBeGreaterThan(-1);
    expect(atRevision, "the REVISION write after the build").toBeGreaterThan(atBuild);
  });
});

describe("deploy/README.md section 10 pins the committed script as the procedure", () => {
  it("names scripts/deploy-revision.sh as the procedure to run", async () => {
    expect(await section10()).toContain("bash scripts/deploy-revision.sh");
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
