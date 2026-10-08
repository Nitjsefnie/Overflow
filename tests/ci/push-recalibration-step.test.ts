import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { git, scratchGitEnv } from "../support/scratch-git";

/**
 * Issue 1036 moved the calibration push out of the calibrate job into
 * push-recalibration, a job that holds contents: write and runs no repository
 * or dependency code — its push half is inline shell where
 * scripts/push-recalibration.ts used to be invoked. A structural pin cannot
 * tell a shell that commits and pushes from a shell that only says so, so this
 * suite EXECUTES the two steps the split introduced, the way the runner does —
 * bash with the runner's flags, in scratch repositories holding a bare origin,
 * a seed commit and a clone — mirroring how tests/scripts/push-recalibration.test.ts
 * covers the script whose semantics the shell mirrors, and how
 * tests/ci/docs-only-step.test.ts executes its step's real `run:` text. There
 * is NO NETWORK: the push URL is redirected to a local bare remote through the
 * PUSH_REMOTE_URL override the shell shares with the script, and the refusal
 * and race cases arrive as pre-receive hooks on that remote.
 *
 * Two halves:
 *
 *  - push-recalibration's "Commit and push the recalibrated floor": commits
 *    the document bytes it received as github-actions[bot], pushes
 *    HEAD:refs/heads/main, fetch-rebase-retries once on a refusal, and fails
 *    with a ::error:: naming the recorded and measured floors when the remote
 *    refuses for good. Every case the script's own suite covers has its
 *    counterpart here.
 *  - calibrate's "Export the recalibrated document": the diff decides
 *    `changed`, and the document bytes leave through a GITHUB_OUTPUT heredoc
 *    that the push job's env receives back byte-for-byte.
 *
 * The one case the fixtures cannot reproduce is branch protection itself, so
 * the refusal half stands in for it: what is under test is that a refused push
 * fails the job visibly instead of reading as green (issue 684).
 */

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
};

/** A floor document, serialized exactly the way calibrate-coverage.ts writes one. */
const docText = (measured: number, floor: number): string =>
  `${JSON.stringify(
    { gap: 1, hysteresis: 0.5, languages: { typescript: { measured, floor } } },
    null,
    2,
  )}\n`;

/**
 * The document as the push job's env receives it: the GITHUB_OUTPUT heredoc
 * and the job-output hop both consume the file's final newline, and the
 * push step's printf restores exactly that one.
 */
const outputDocument = (measured: number, floor: number): string =>
  docText(measured, floor).slice(0, -1);

let root = "";
let counter = 0;
let pushRun = "";
let exportRun = "";

beforeAll(async () => {
  const source = await readFileSync(
    resolve(".github/workflows/ci.yml"),
    "utf8",
  );
  const workflow = parse(source) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>;
  };

  const pushSteps = (workflow.jobs?.["push-recalibration"]?.steps ?? []).filter(
    (step) => step.name === "Commit and push the recalibrated floor",
  );
  expect(
    pushSteps,
    "push-recalibration must carry exactly one Commit and push the recalibrated floor step — " +
      "the suite executes its run text; a renamed step is a wiring change this suite must judge",
  ).toHaveLength(1);
  pushRun = pushSteps[0]!.run ?? "";

  const exportSteps = (workflow.jobs?.calibrate?.steps ?? []).filter(
    (step) => step.name === "Export the recalibrated document",
  );
  expect(
    exportSteps,
    "calibrate must carry exactly one Export the recalibrated document step — the suite executes its run text",
  ).toHaveLength(1);
  exportRun = exportSteps[0]!.run ?? "";

  root = mkdtempSync(join(tmpdir(), "push-recalibration-step-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * The environment the runner gives a step: PATH and HOME, plus what the step's
 * env: block maps. Deliberately NOT scratchGitEnv — its GIT_AUTHOR_NAME and
 * GIT_COMMITTER_NAME would outrank the `-c user.name=` the bot identity is set
 * with, and every push case would commit as the scratch identity while the
 * assertion reads github-actions[bot].
 */
const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  ...extra,
});

/** Runs the step's real run text the way the runner does. */
function runStep(script: string, cwd: string, extra: Record<string, string>) {
  counter += 1;
  const path = join(root, `step-${counter}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${script}`);
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", path], {
    cwd,
    encoding: "utf8",
    env: childEnv(extra),
  });
}

/** Parses a GITHUB_OUTPUT file, heredoc blocks included. */
function readGithubOutput(path: string): Record<string, string> {
  const lines = readFileSync(path, "utf8").split("\n");
  const values: Record<string, string> = {};
  let index = 0;
  while (index < lines.length) {
    const heredoc = /^(.*?)<<(.+)$/.exec(lines[index]!);
    if (heredoc !== null) {
      const [, key, delimiter] = heredoc;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== delimiter) {
        body.push(lines[index]!);
        index += 1;
      }
      values[key!] = body.join("\n");
      index += 1;
      continue;
    }
    const equals = lines[index]!.indexOf("=");
    if (equals !== -1) {
      values[lines[index]!.slice(0, equals)] = lines[index]!.slice(equals + 1);
    }
    index += 1;
  }
  return values;
}

describe("push-recalibration's push step, executed", () => {
  let origin = "";
  let checkout = "";

  /**
   * A bare origin holding one seed commit — the real scripts and floor
   * document, so the exported and pushed documents are the shapes production
   * writes — an optional pre-receive hook, and a fresh clone: the state the
   * push job starts from. The hook goes in after the seed push, before the
   * clone.
   */
  function seedRemote(hook: string): void {
    counter += 1;
    origin = join(root, `origin-${counter}.git`);
    checkout = join(root, `checkout-${counter}`);
    const seed = join(root, `seed-${counter}`);
    git(root, "init", "--bare", "-q", "-b", "main", origin);
    git(root, "init", "-q", "-b", "main", seed);
    mkdirSync(join(seed, "scripts"), { recursive: true });
    for (const name of ["calibrate-coverage.ts", "check-coverage-floor.ts"]) {
      writeFileSync(
        join(seed, `scripts/${name}`),
        readFileSync(resolve(`scripts/${name}`)),
      );
    }
    writeFileSync(
      join(seed, "scripts/coverage.json"),
      docText(73.46, 72.46),
    );
    writeFileSync(join(seed, "other.txt"), "seed\n");
    git(seed, "add", "scripts/coverage.json", "other.txt", "scripts");
    git(seed, "commit", "-qm", "seed");
    git(seed, "push", "-q", origin, "HEAD:refs/heads/main");
    if (hook !== "") {
      writeFileSync(join(origin, "hooks/pre-receive"), hook);
      chmodSync(join(origin, "hooks/pre-receive"), 0o755);
    }
    git(root, "clone", "-q", origin, checkout);
  }

  // Refuses every push, the way branch protection refuses GITHUB_TOKEN.
  const rejectAlways =
    "#!/bin/sh\necho 'branch protection refuses this push' >&2\nexit 1\n";

  // Refuses the first push only — and a racing commit lands on main first, so
  // the retry has to rebase for real. The hook clears the quarantine
  // variables for the two commands that must write outside it: the racing
  // commit's objects and the ref update itself.
  const rejectOnceWithRace = (marker: string): string =>
    [
      "#!/bin/sh",
      `if [ -f '${marker}' ]; then exit 0; fi`,
      `touch '${marker}'`,
      "read old new ref",
      'tree=$(git rev-parse "$old^{tree}")',
      "racing=$(env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY \\",
      "  -u GIT_ALTERNATE_OBJECT_DIRECTORIES \\",
      "  GIT_AUTHOR_NAME=racing GIT_AUTHOR_EMAIL=racing@example.com \\",
      "  GIT_COMMITTER_NAME=racing GIT_COMMITTER_EMAIL=racing@example.com \\",
      '  git commit-tree "$tree" -p "$old" -m "racing commit lands first")',
      "env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY \\",
      "  -u GIT_ALTERNATE_OBJECT_DIRECTORIES \\",
      '  git update-ref refs/heads/main "$racing" "$old"',
      'echo "racing commit landed on main; first push refused" >&2',
      "exit 1",
      "",
    ].join("\n");

  const pushEnv = (): Record<string, string> => ({
    DOCUMENT: outputDocument(78.46, 77.46),
    GH_TOKEN: "scratch-token-not-a-secret",
    GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
    PUSH_REMOTE_URL: origin,
  });

  const assertClean = (): void => {
    expect(git(checkout, "status", "--porcelain")).toBe("");
    // No rebase left in progress behind whatever the case did.
    expect(existsSync(join(checkout, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(join(checkout, ".git", "rebase-apply"))).toBe(false);
  };

  it("commits the exported document as the bot and pushes to a permissive remote", () => {
    seedRemote("");
    const before = git(origin, "rev-parse", "main");
    const result = runStep(pushRun, checkout, pushEnv());

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const after = git(origin, "rev-parse", "main");
    expect(after).not.toBe(before);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(after);
    expect(git(checkout, "log", "-1", "--format=%an <%ae>")).toBe(
      "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    );
    expect(git(checkout, "log", "-1", "--format=%s")).toBe(
      "ci: update CI ratchets",
    );
    // The pushed document is the exported document, byte for byte.
    expect(readFileSync(join(checkout, "scripts/coverage.json"), "utf8")).toBe(
      docText(78.46, 77.46),
    );
    // The token rides in the push URL only; .git/config stays clean of it.
    expect(
      readFileSync(join(checkout, ".git", "config"), "utf8"),
    ).not.toContain("scratch-token-not-a-secret");
    assertClean();
  });

  it("fails with ::error:: naming both floors and leaves the repo clean when the remote refuses twice", () => {
    seedRemote(rejectAlways);
    const before = git(origin, "rev-parse", "main");
    const result = runStep(pushRun, checkout, pushEnv());

    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("::error::");
    // Recorded floor at HEAD^1 and measured floor in the committed doc.
    expect(output).toContain("72.46");
    expect(output).toContain("77.46");
    expect(output).toContain("refuses pushes from GITHUB_TOKEN");
    expect(output).toContain("node scripts/calibrate-coverage.ts");
    expect(git(origin, "rev-parse", "main")).toBe(before);
    assertClean();
  });

  it("rebases onto the advanced remote and lands on the retry after one refusal", () => {
    seedRemote(rejectOnceWithRace(join(origin, "rejected.once")));
    const before = git(origin, "rev-parse", "main");
    const result = runStep(pushRun, checkout, pushEnv());

    expect(result.status).toBe(0);
    const after = git(origin, "rev-parse", "main");
    expect(after).not.toBe(before);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(after);
    expect(git(origin, "log", "--format=%s", "-2", "main")).toBe(
      "ci: update CI ratchets\nracing commit lands first",
    );
    assertClean();
  });

  it("pushes nothing when the exported document matches the record", () => {
    seedRemote("");
    const before = git(origin, "rev-parse", "main");
    // No GH_TOKEN: the token is needed only where a push URL is built from it.
    const result = runStep(pushRun, checkout, {
      DOCUMENT: outputDocument(73.46, 72.46),
      GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
      PUSH_REMOTE_URL: origin,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "coverage floor already current; nothing to push",
    );
    expect(git(origin, "rev-parse", "main")).toBe(before);
    expect(git(checkout, "log", "--format=%s", "-1")).toBe("seed");
    assertClean();
  });

  it("never echoes the token when the push itself fails", () => {
    seedRemote("");
    // Nothing listens on 127.0.0.1:1; the URL carries the token so any
    // unredacted git error output would name it.
    const result = runStep(pushRun, checkout, {
      DOCUMENT: docText(78.46, 77.46),
      GH_TOKEN: "scratch-token-not-a-secret",
      GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
      PUSH_REMOTE_URL:
        "https://x-access-token:scratch-token-not-a-secret@127.0.0.1:1/Nitjsefnie/Overflow.git",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      "scratch-token-not-a-secret",
    );
    assertClean();
  });
});

describe("calibrate's export step, executed", () => {
  let origin = "";
  let checkout = "";

  /** The same fixture shape as the push cases: seed, push, clone. */
  function seedRemote(): void {
    counter += 1;
    origin = join(root, `origin-${counter}.git`);
    checkout = join(root, `checkout-${counter}`);
    const seed = join(root, `seed-${counter}`);
    git(root, "init", "--bare", "-q", "-b", "main", origin);
    git(root, "init", "-q", "-b", "main", seed);
    mkdirSync(join(seed, "scripts"), { recursive: true });
    for (const name of ["calibrate-coverage.ts", "check-coverage-floor.ts"]) {
      writeFileSync(
        join(seed, `scripts/${name}`),
        readFileSync(resolve(`scripts/${name}`)),
      );
    }
    writeFileSync(join(seed, "scripts/coverage.json"), docText(73.46, 72.46));
    writeFileSync(join(seed, "other.txt"), "seed\n");
    git(seed, "add", "scripts/coverage.json", "other.txt", "scripts");
    git(seed, "commit", "-qm", "seed");
    git(seed, "push", "-q", origin, "HEAD:refs/heads/main");
    git(root, "clone", "-q", origin, checkout);
  }

  /** The exported output of one export-step run, read back off GITHUB_OUTPUT. */
  function runExport(): { status: number | null; values: Record<string, string>; output: string } {
    counter += 1;
    const outputPath = join(root, `github-output-${counter}`);
    writeFileSync(outputPath, "");
    const result = runStep(exportRun, checkout, {
      GITHUB_OUTPUT: outputPath,
    });
    return {
      status: result.status,
      values: readGithubOutput(outputPath),
      output: `${result.stdout}\n${result.stderr}`,
    };
  }

  it("marks the record changed when calibrate rewrote the document", () => {
    seedRemote();
    // The state calibrate leaves after a warranted raise.
    writeFileSync(join(checkout, "scripts/coverage.json"), docText(78.46, 77.46));

    const { status, values } = runExport();

    expect(status).toBe(0);
    expect(values.changed).toBe("true");
    // The document output is the file's bytes, minus the final newline the
    // GITHUB_OUTPUT delimiter consumes — the push job's printf restores it.
    expect(`${values.document}\n`).toBe(docText(78.46, 77.46));
  });

  it("reports the current document when nothing changed", () => {
    seedRemote();

    const { status, values } = runExport();

    expect(status).toBe(0);
    expect(values.changed).toBe("false");
    expect(`${values.document}\n`).toBe(docText(73.46, 72.46));
  });

  it("hands a real recalibration to the push step byte-for-byte", () => {
    // The chain the split wires: the calibrate script runs in a tree with no
    // node_modules (it needs none), the export step publishes what it wrote,
    // and the push step lands exactly those bytes on the remote.
    seedRemote();
    mkdirSync(join(checkout, "coverage"), { recursive: true });
    writeFileSync(
      join(checkout, "coverage/coverage-summary.json"),
      `${JSON.stringify({ total: { lines: { pct: 95.0 } } }, null, 2)}\n`,
    );
    const calibrate = spawnSync(
      process.execPath,
      ["scripts/calibrate-coverage.ts"],
      { cwd: checkout, encoding: "utf8", env: childEnv({}) },
    );
    expect(calibrate.status, calibrate.stderr).toBe(0);

    const { values } = runExport();
    expect(values.changed).toBe("true");

    // A second checkout of the same seed receives the document the way the
    // push job does: through env.
    counter += 1;
    const receiver = join(root, `receiver-${counter}`);
    git(root, "clone", "-q", origin, receiver);
    const before = git(origin, "rev-parse", "main");
    const result = runStep(pushRun, receiver, {
      DOCUMENT: values.document,
      GH_TOKEN: "scratch-token-not-a-secret",
      GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
      PUSH_REMOTE_URL: origin,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(git(origin, "rev-parse", "main")).not.toBe(before);
    expect(
      readFileSync(join(receiver, "scripts/coverage.json"), "utf8"),
    ).toBe(docText(95, 94));
  });
});
