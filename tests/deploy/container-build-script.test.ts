import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../../scripts/container-build.sh", import.meta.url));
const script = readFileSync(scriptPath, "utf8");

/**
 * Issue 461: the committed mechanical build path for the container route.
 * The script turns the Dockerfile's provenance machinery (mandatory
 * SOURCE_SHA, revision label, label verification) into one command an
 * operator can run and trust, so the pins below hold its contract textually,
 * the way tests/deploy/unit-file.test.ts pins the unit file: what the script
 * must refuse, what it must build with, what it must verify, and what it
 * must print for rollback to select.
 */
describe("scripts/container-build.sh", () => {
  it("is executable, parses as bash, and runs under strict mode", () => {
    expect(statSync(scriptPath).mode & 0o111, "the executable bit").not.toBe(0);
    expect(spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" }).status).toBe(0);
    expect(script).toContain("set -euo pipefail");
  });

  it("builds from the repository root resolved from the script's own location", () => {
    expect(script).toContain('cd "$(dirname "$0")/.."');
  });

  it("refuses a dirty tree before building, so the revision label names committed source", () => {
    expect(script).toContain("git status --porcelain");
    expect(script).toContain("the revision label must name reviewed committed source");
  });

  it("builds with the full source SHA from git rev-parse HEAD, defaulting the tag to overflow-app", () => {
    expect(script).toContain('source_sha="$(git rev-parse HEAD)"');
    expect(script).toContain('docker build --build-arg SOURCE_SHA="$source_sha"');
    expect(script).toContain('image="${1:-overflow-app}"');
  });

  it("verifies the revision label landed, comparing against git rev-parse HEAD, and refuses an unlabelled image", () => {
    expect(script).toContain('index .Config.Labels "org.opencontainers.image.revision"');
    expect(script).toContain('if [ "$landed" != "$source_sha" ]');
    expect(script).toContain("do not deploy it");
  });

  it("prints the immutable provenance record rollback selects", () => {
    expect(script).toContain("Provenance record");
    expect(script).toContain("rollback");
    expect(script).toContain("revision:");
    expect(script).toContain("image ID:");
    expect(script).toContain("RepoDigests:");
    expect(script).toContain("created:");
  });
});

// The host's git config (templates, hooks, excludesFile, default branch)
// must not change what the fixture repository tracks or ignores.
const HERMETIC_GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

// Stands in for docker: `build` records its argv, saves the context it was
// handed on stdin and the SOURCE_SHA build arg; `image inspect` answers the
// revision label with that recorded SHA, and plausible values for the rest.
const DOCKER_SHIM = `#!/usr/bin/env bash
set -eu
case "$1" in
  build)
    printf '%s\\n' "$@" > "$SHIM_DIR/build-argv"
    cat > "$SHIM_DIR/context.tar"
    for arg in "$@"; do
      case "$arg" in SOURCE_SHA=*) printf '%s' "\${arg#SOURCE_SHA=}" > "$SHIM_DIR/source-sha" ;; esac
    done
    ;;
  image)
    case "$4" in
      *org.opencontainers.image.revision*) cat "$SHIM_DIR/source-sha" ;;
      '{{.Created}}') echo 2026-01-01T00:00:00Z ;;
      '{{.Id}}') echo sha256:0000000000000000000000000000000000000000000000000000000000000000 ;;
      '{{json .RepoDigests}}') echo '[]' ;;
      *) echo >&2 "docker shim: unexpected inspect format $4"; exit 2 ;;
    esac
    ;;
  *) echo >&2 "docker shim: unexpected command $1"; exit 2 ;;
esac
`;

// A git wrapper that delegates to the real git except `archive`, which fails:
// the export feeding the build context must not fail silently.
const FAILING_ARCHIVE_GIT_SHIM = `#!/usr/bin/env bash
if [ "$1" = archive ]; then echo >&2 "git shim: archive failed"; exit 1; fi
exec "$REAL_GIT" "$@"
`;

// Deny-by-default, the shape of this repository's own .gitignore: the probe
// below is ignored, so git status cannot see it (issue 648).
const FIXTURE_GITIGNORE = [
  "*",
  "!.gitignore",
  "!Dockerfile",
  "!scripts/",
  "scripts/*",
  "!scripts/container-build.sh",
  "!src/",
  "src/*",
  "!src/app/",
  "src/app/*",
  "!src/app/page.tsx",
  "",
].join("\n");

const PROBE = "src/app/zz-probe/page.tsx";

// The fixture's second commit rewrites this tracked file, so the context
// must carry HEAD's content, not an earlier commit's.
const PAGE = "src/app/page.tsx";
const PAGE_AT_ROOT = "export default function Page() { return null; }\n";
const PAGE_AT_HEAD = "export default function Page() { return 'head'; }\n";

interface BuildFixture {
  dir: string;
  repo: string;
  shimDir: string;
  bin: string;
  head: string;
}

// Runs body against a fresh fixture and removes the fixture directory
// afterwards, including when building the fixture itself fails.
async function withBuildFixture(body: (fixture: BuildFixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "overflow-container-build-"));
  try {
    await body(await makeBuildFixture(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeBuildFixture(dir: string): Promise<BuildFixture> {
  const repo = path.join(dir, "repo");
  const shimDir = path.join(dir, "shim");
  const bin = path.join(dir, "bin");
  await Promise.all([mkdir(path.join(repo, "scripts"), { recursive: true }), mkdir(shimDir), mkdir(bin)]);
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...HERMETIC_GIT_ENV },
    });
    expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  await writeFile(path.join(repo, ".gitignore"), FIXTURE_GITIGNORE);
  await writeFile(path.join(repo, "Dockerfile"), "FROM scratch\nCOPY . /app\n");
  await copyFile(scriptPath, path.join(repo, "scripts", "container-build.sh"));
  await chmod(path.join(repo, "scripts", "container-build.sh"), 0o755);
  await mkdir(path.join(repo, "src", "app", "zz-probe"), { recursive: true });
  await writeFile(path.join(repo, PAGE), PAGE_AT_ROOT);
  git("add", ".gitignore", "Dockerfile", "scripts/container-build.sh", PAGE);
  git("commit", "-q", "-m", "fixture root");
  await writeFile(path.join(repo, PAGE), PAGE_AT_HEAD);
  git("add", PAGE);
  git("commit", "-q", "-m", "fixture head");
  await writeFile(path.join(repo, PROBE), "export default function Probe() { return null; }\n");
  // The premise of issue 648: the ignored probe leaves git status clean,
  // so the dirty-tree refusal cannot catch it.
  expect(git("status", "--porcelain")).toBe("");
  await writeFile(path.join(bin, "docker"), DOCKER_SHIM);
  await chmod(path.join(bin, "docker"), 0o755);
  return { dir, repo, shimDir, bin, head: git("rev-parse", "HEAD") };
}

function runBuild(fixture: BuildFixture, extraPath: string[] = []) {
  return spawnSync(path.join(fixture.repo, "scripts", "container-build.sh"), [], {
    cwd: fixture.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...HERMETIC_GIT_ENV,
      SHIM_DIR: fixture.shimDir,
      PATH: [...extraPath, fixture.bin, process.env.PATH].join(path.delimiter),
    },
  });
}

describe("scripts/container-build.sh build context (issue 648)", () => {
  it("builds from an export of the commit on stdin, so an ignored untracked file never enters the image", async () => {
    await withBuildFixture(async (fixture) => {
      const result = runBuild(fixture);
      expect(result.status, result.stderr).toBe(0);

      const argv = (await readFile(path.join(fixture.shimDir, "build-argv"), "utf8")).trimEnd().split("\n");
      expect(argv.at(-1), "the build context argument").toBe("-");

      const listing = spawnSync("tar", ["-tf", path.join(fixture.shimDir, "context.tar")], { encoding: "utf8" });
      expect(listing.status, listing.stderr).toBe(0);
      const entries = listing.stdout.split("\n").filter(Boolean);
      expect(entries).toEqual(
        expect.arrayContaining([".gitignore", "Dockerfile", "scripts/container-build.sh", PAGE]),
      );
      expect(entries.filter((entry) => entry.includes("zz-probe"))).toEqual([]);

      // The exported content is HEAD's, the commit the label names.
      const page = spawnSync("tar", ["-xOf", path.join(fixture.shimDir, "context.tar"), PAGE], { encoding: "utf8" });
      expect(page.status, page.stderr).toBe(0);
      expect(page.stdout).toBe(PAGE_AT_HEAD);

      expect(await readFile(path.join(fixture.shimDir, "source-sha"), "utf8")).toBe(fixture.head);
      expect(result.stdout).toContain(`revision:    ${fixture.head}`);
    });
  });

  it("fails when the export of the commit fails, rather than building whatever arrived", async () => {
    await withBuildFixture(async (fixture) => {
      const shimBin = path.join(fixture.dir, "git-shim");
      await mkdir(shimBin);
      await writeFile(path.join(shimBin, "git"), FAILING_ARCHIVE_GIT_SHIM.replace("$REAL_GIT", realGitPath()));
      await chmod(path.join(shimBin, "git"), 0o755);

      const result = runBuild(fixture, [shimBin]);
      expect(result.status, result.stdout).not.toBe(0);
      expect(result.stderr).toContain("git shim: archive failed");
      expect(result.stdout).not.toContain("Provenance record");
    });
  });
});

function realGitPath(): string {
  const result = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
