import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const readme = fileURLToPath(new URL("../../deploy/README.md", import.meta.url));
const deployScript = fileURLToPath(new URL("../../scripts/deploy-revision.sh", import.meta.url));

interface Fixture {
  dir: string;
  tree: string;
  oldSha: string;
  fetchedSha: string;
  previousRelease: string;
  envFile: string;
  lock: string;
  logDir: string;
  bins: string;
  shimLog: string;
  checkRunsFile: string;
  upgradeStatusFile: string;
}

let liveFixture: Fixture | undefined;

afterEach(async () => {
  if (liveFixture) await rm(liveFixture.dir, { recursive: true, force: true });
  liveFixture = undefined;
});

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 20_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function standingBlock(): Promise<string> {
  const markdown = await readFile(readme, "utf8");
  const section = markdown.split("## 10. Deploying a new revision")[1];
  expect(section, "section 10 exists").toBeDefined();
  const blocks = [...section!.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
  const block = blocks.find((candidate) => candidate.includes("git fetch origin main"));
  expect(block, "the fetch-first manual standing block").toBeDefined();
  return block!;
}

async function makeFixture(options: { advanceRemote?: boolean } = {}): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "overflow-readme-fallback-"));
  const seed = path.join(dir, "seed");
  const remote = path.join(dir, "remote.git");
  const tree = path.join(dir, "tree");
  await mkdir(seed);
  run("git", ["init", "--initial-branch=main", seed], dir);
  run("git", ["-C", seed, "config", "user.name", "Fallback Fixture"], dir);
  run("git", ["-C", seed, "config", "user.email", "fallback-fixture@example.test"], dir);
  await writeFile(path.join(seed, ".gitignore"), "*\n");
  await writeFile(path.join(seed, "tracked.txt"), "tracked fixture source\n");
  run("git", ["-C", seed, "add", "-f", ".gitignore", "tracked.txt"], dir);
  run("git", ["-C", seed, "commit", "-m", "fixture source"], dir);
  run("git", ["init", "--bare", "--initial-branch=main", remote], dir);
  run("git", ["-C", seed, "remote", "add", "origin", remote], dir);
  run("git", ["-C", seed, "push", "-u", "origin", "main"], dir);
  run("git", ["clone", remote, tree], dir);
  const oldSha = run("git", ["-C", tree, "rev-parse", "HEAD"], dir);
  let fetchedSha = oldSha;
  if (options.advanceRemote !== false) {
    await writeFile(path.join(seed, "remote-advanced.txt"), "fetched fixture revision\n");
    run("git", ["-C", seed, "add", "-f", "remote-advanced.txt"], dir);
    run("git", ["-C", seed, "commit", "-m", "advance remote main after clone"], dir);
    run("git", ["-C", seed, "push", "origin", "main"], dir);
    fetchedSha = run("git", ["-C", seed, "rev-parse", "HEAD"], dir);
  }

  const fakeGitHubRemote = "git@github.com:overflow-fixture/manual-fallback.git";
  run("git", ["-C", tree, "remote", "set-url", "origin", fakeGitHubRemote], dir);
  run("git", ["-C", tree, "config", `url.${remote}.insteadOf`, fakeGitHubRemote], dir);

  const previousRelease = ".next-release-20260908T000000Z-abc1234";
  const previousPath = path.join(tree, previousRelease);
  await mkdir(path.join(previousPath, "cache"), { recursive: true });
  await writeFile(path.join(previousPath, "BUILD_ID"), previousRelease);
  await symlink(previousRelease, path.join(tree, ".next"));

  const envFile = path.join(dir, "overflow.env");
  const logDir = path.join(dir, "logs");
  const bins = path.join(dir, "bins");
  const shimLog = path.join(dir, "shim-log");
  const checkRunsFile = path.join(dir, "check-runs.tsv");
  const upgradeStatusFile = path.join(dir, "upgrade-status");
  await writeFile(envFile, "OVERFLOW_FIXTURE_ENV_MARKER=loaded\n");
  await writeFile(checkRunsFile, "101\tbuild\tcompleted\tsuccess\n102\tdeploy-gate\tcompleted\tfailure\n103\tdeploy-gate\tcompleted\tsuccess\n");
  await writeFile(upgradeStatusFile, "0\n");
  await mkdir(logDir);
  await mkdir(bins);

  const fixture = {
    dir,
    tree,
    oldSha,
    fetchedSha,
    previousRelease,
    envFile,
    lock: path.join(dir, "deploy.lock"),
    logDir,
    bins,
    shimLog,
    checkRunsFile,
    upgradeStatusFile,
  };
  liveFixture = fixture;
  await writeShims(fixture);
  return fixture;
}

async function writeShim(fixture: Fixture, name: string, behavior: string): Promise<void> {
  const file = path.join(fixture.bins, name);
  const source = `#!/usr/bin/env bash
printf '%s' "${name}" >> "\${SHIM_LOG:?}"
for arg in "$@"; do printf '\\t%s' "$arg" >> "\${SHIM_LOG:?}"; done
printf '\\n' >> "\${SHIM_LOG:?}"
${behavior}
`;
  await writeFile(file, source);
  await chmod(file, 0o755);
}

async function writeShims(fixture: Fixture): Promise<void> {
  await writeShim(
    fixture,
    "gh",
  `case "$2" in
  */branches/main/protection)
    printf 'build\\ndeploy-gate\\n'
    ;;
  */check-runs*)
    cat "\${CHECK_RUNS_FILE:?}"
    ;;
  *) exit 2 ;;
esac`,
  );
  await writeShim(
    fixture,
    "pnpm",
    `if [ "$1" = "--silent" ]; then shift; fi
if [ "$1" = "release:switch" ]; then printf '%s' "$3" > "\${SHIM_LOG:?}.release-name"; fi
if [ "$1" = "webhooks:upgrade" ]; then
  release=$(cat "\${SHIM_LOG:?}.release-name")
  if [ -f "$release/REVISION" ]; then state=present; else state=absent; fi
  printf 'REVISION_AT_WEBHOOK=%s\\n' "$state" >> "\${SHIM_LOG:?}"
  printf '{"upgradeFixture":true}\\n'
  status=$(cat "\${UPGRADE_STATUS_FILE:?}")
  exit "$status"
fi
exit 0`,
  );
  await writeShim(fixture, "node", "exit 0");
  await writeShim(fixture, "systemctl", "exit 0");
  await writeShim(fixture, "curl", "exit 0");
  await writeShim(fixture, "find", "exit 0");
  await writeShim(fixture, "chown", "exit 0");
  await writeShim(fixture, "chmod", "exit 0");
  await writeShim(fixture, "install", "exit 0");
}

async function runFallback(fixture: Fixture) {
  const block = (await standingBlock())
    .replaceAll("/srv/overflow", fixture.tree)
    .replaceAll("/run/overflow-deploy.lock", fixture.lock)
    .replaceAll("/etc/overflow/overflow.env", fixture.envFile)
    .replaceAll("/var/log/overflow", fixture.logDir);
  const script = path.join(fixture.dir, "manual-fallback.sh");
  await writeFile(script, block);
  return spawnSync("bash", [script], {
    cwd: fixture.tree,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      SHIM_LOG: fixture.shimLog,
      CHECK_RUNS_FILE: fixture.checkRunsFile,
      UPGRADE_STATUS_FILE: fixture.upgradeStatusFile,
      PATH: `${fixture.bins}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

async function shimLog(fixture: Fixture): Promise<string[]> {
  try {
    return (await readFile(fixture.shimLog, "utf8")).trimEnd().split("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("deploy/README.md manual fallback", () => {
  it("pins its ignored-file allowlist to the deploy script's expanded regex", async () => {
    const block = await standingBlock();
    const readmeRegex = block.match(/^allowlist_re='([^']+)'$/m)?.[1];
    expect(readmeRegex, "the inlined allowlist assignment").toBeDefined();

    const script = await readFile(deployScript, "utf8");
    const releaseAssignment = script.match(/^release_name_re=.*$/m)?.[0];
    const allowlistAssignment = script.match(/^operational_ignored_re=.*$/m)?.[0];
    expect(releaseAssignment, "the release-name regex assignment").toBeDefined();
    expect(allowlistAssignment, "the operational ignored regex assignment").toBeDefined();
    const expanded = spawnSync(
      "bash",
      ["-c", `${releaseAssignment}\n${allowlistAssignment}\nprintf '%s' "$operational_ignored_re"`],
      { encoding: "utf8" },
    );
    expect(expanded.status, expanded.stderr).toBe(0);
    expect(readmeRegex).toBe(expanded.stdout);
  });

  it("refuses a stray ignored source before install or switch and leaves HEAD unchanged", async () => {
    const fixture = await makeFixture();
    await writeFile(path.join(fixture.tree, "zz-stray.ts"), "ignored source\n");
    const before = run("git", ["rev-parse", "HEAD"], fixture.tree);
    expect(before).toBe(fixture.oldSha);
    expect(fixture.fetchedSha).not.toBe(fixture.oldSha);

    const result = await runFallback(fixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain("zz-stray.ts");
    const entries = await shimLog(fixture);
    expect(entries.some((entry) => entry.startsWith("pnpm\tinstall"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("pnpm\trelease:switch"))).toBe(false);
    expect(run("git", ["rev-parse", "HEAD"], fixture.tree)).toBe(fixture.oldSha);
  });

  it("refuses a local commit that diverged from fetched main before install or switch", async () => {
    const fixture = await makeFixture();
    await writeFile(path.join(fixture.tree, "tracked.txt"), "local-only revision\n");
    run("git", ["config", "user.name", "Fallback Fixture"], fixture.tree);
    run("git", ["config", "user.email", "fallback-fixture@example.test"], fixture.tree);
    run("git", ["add", "tracked.txt"], fixture.tree);
    run("git", ["commit", "-m", "local-only revision"], fixture.tree);
    const localSha = run("git", ["rev-parse", "HEAD"], fixture.tree);
    expect(localSha).not.toBe(fixture.oldSha);
    expect(fixture.fetchedSha).not.toBe(fixture.oldSha);
    run("git", ["fetch", "origin", "main"], fixture.tree);
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", localSha, fixture.fetchedSha], {
      cwd: fixture.tree,
      encoding: "utf8",
    });
    expect(ancestry.status).toBe(1);

    const result = await runFallback(fixture);

    const output = `${result.stderr}\n${result.stdout}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain("is not an ancestor of the fetched main");
    expect(run("git", ["rev-parse", "HEAD"], fixture.tree)).toBe(localSha);
    const entries = await shimLog(fixture);
    expect(entries.some((entry) => entry.startsWith("pnpm\tinstall"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("pnpm\trelease:switch"))).toBe(false);
  });

  it("refuses a tracked working-tree deviation before install or switch", async () => {
    const fixture = await makeFixture();
    await writeFile(path.join(fixture.tree, "tracked.txt"), "modified after clone\n");
    const before = run("git", ["rev-parse", "HEAD"], fixture.tree);
    expect(before).toBe(fixture.oldSha);

    const result = await runFallback(fixture);

    const output = `${result.stderr}\n${result.stdout}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain("tracked.txt");
    expect(output).toContain("working tree in");
    expect(output).toContain("deviates from HEAD");
    expect(run("git", ["rev-parse", "HEAD"], fixture.tree)).toBe(before);
    const entries = await shimLog(fixture);
    expect(entries.some((entry) => entry.startsWith("pnpm\tinstall"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("pnpm\trelease:switch"))).toBe(false);
  });

  it.each([
    {
      kind: "absent",
      checkRuns: "101\tbuild\tcompleted\tsuccess\n",
      pending: "deploy-gate (absent)",
    },
    {
      kind: "non-completed",
      checkRuns: "101\tbuild\tcompleted\tsuccess\n102\tdeploy-gate\tin_progress\t\n",
      pending: "deploy-gate (in_progress)",
    },
    {
      kind: "unsuccessful",
      checkRuns: "101\tbuild\tcompleted\tsuccess\n102\tdeploy-gate\tcompleted\tfailure\n",
      pending: "deploy-gate (failure)",
    },
  ])("refuses before merge when a required check is $kind", async ({ checkRuns, pending }) => {
    const fixture = await makeFixture();
    await writeFile(fixture.checkRunsFile, checkRuns);

    const result = await runFallback(fixture);

    const output = `${result.stderr}\n${result.stdout}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain(pending);
    expect(fixture.fetchedSha).not.toBe(fixture.oldSha);
    expect(run("git", ["rev-parse", "HEAD"], fixture.tree)).toBe(fixture.oldSha);
    const entries = await shimLog(fixture);
    expect(entries.some((entry) => entry.startsWith("pnpm\tinstall"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("pnpm\trelease:switch"))).toBe(false);
  });

  it("does not write REVISION when webhook upgrade fails", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.upgradeStatusFile, "17\n");

    const result = await runFallback(fixture);

    const output = result.stderr + "\n" + result.stdout;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Webhook upgrade exit status: 17");
    const release = result.stdout.match(/New build: ([^\n]+)/)?.[1];
    expect(release, "the release created before webhook upgrade").toBeDefined();
    expect(await readdir(path.join(fixture.tree, release!))).not.toContain("REVISION");
  });

  it("skips a redundant deploy when the serving revision equals unchanged fetched main", async () => {
    const fixture = await makeFixture({ advanceRemote: false });
    expect(fixture.fetchedSha).toBe(fixture.oldSha);
    await writeFile(path.join(fixture.tree, fixture.previousRelease, "REVISION"), `${fixture.fetchedSha}\n`);
    const before = run("git", ["rev-parse", "HEAD"], fixture.tree);

    const result = await runFallback(fixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain(`Already serving ${realpathSync(path.join(fixture.tree, fixture.previousRelease))} (${fixture.fetchedSha})`);
    expect(run("git", ["rev-parse", "HEAD"], fixture.tree)).toBe(before);
    const entries = await shimLog(fixture);
    expect(entries.some((entry) => entry.startsWith("pnpm\tinstall"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("pnpm\trelease:switch"))).toBe(false);
  });

  it("runs the fetch-first fallback and writes REVISION only after switch, restart and webhook upgrade", async () => {
    const fixture = await makeFixture();

    const result = await runFallback(fixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const sha = run("git", ["rev-parse", "HEAD"], fixture.tree);
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(fixture.fetchedSha).not.toBe(fixture.oldSha);
    expect(sha).toBe(fixture.fetchedSha);
    const release = result.stdout.match(/New build: ([^\n]+)/)?.[1];
    expect(release, "the release created by the block").toBeDefined();
    await expect(readFile(path.join(fixture.tree, release!, "REVISION"), "utf8")).resolves.toBe(`${sha}\n`);

    const entries = await shimLog(fixture);
    const switchEntry = entries.find((entry) => entry.startsWith("pnpm\trelease:switch\t"));
    expect(switchEntry).toContain(`--expect-current\t${realpathSync(path.join(fixture.tree, fixture.previousRelease))}`);
    const switchAt = entries.indexOf(switchEntry!);
    const restartAt = entries.findIndex((entry) => entry === "systemctl\trestart\toverflow.service");
    expect(switchAt).toBeGreaterThan(-1);
    expect(restartAt).toBeGreaterThan(switchAt);

    const checkRunReads = entries.filter((entry) => entry.startsWith("gh\tapi\t") && entry.includes("/check-runs?"));
    expect(checkRunReads).toHaveLength(1);
    expect(checkRunReads[0]).toContain("--paginate");
    const webhookAt = entries.indexOf("pnpm\t--silent\twebhooks:upgrade");
    expect(webhookAt).toBeGreaterThan(restartAt);
    expect(entries[webhookAt + 1]).toBe("REVISION_AT_WEBHOOK=absent");
  });
});
