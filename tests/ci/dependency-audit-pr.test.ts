import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "dependency-audit-pr-")]);

const LINUX_ONLY = process.platform === "linux";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { "runs-on"?: string; "timeout-minutes"?: number; env?: Record<string, string>; steps?: Step[] };
type Workflow = {
  name?: string;
  on?: unknown;
  permissions?: Record<string, string>;
  concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
  jobs?: Record<string, Job>;
};

const PR_FILE = ".github/workflows/pr-gates.yml";
const PUSH_FILE = ".github/workflows/dependency-audit.yml";
const JOB_NAME = "dependency-audit";
const AUDIT_STEP_NAME = "Audit the pull request's merge-tree manifests";

const ENV_PINS: Record<string, string> = {
  COREPACK_ENABLE_PROJECT_SPEC: "0",
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_strict_ssl: "true",
  npm_config_cafile: "/etc/ssl/certs/ca-certificates.crt",
  npm_config_audit_level: "low",
};

/** Every fixed refusal the step's prologue can print; content-free constants. */
const REFUSALS = {
  fetchHead: "::error::could not fetch the pull request's head",
  fetchBase:
    "::error::could not fetch the pull request's base commit; refusing to audit a tree this event is not about",
  conflict: "does not merge cleanly into its base",
  mergeTree: "::error::git merge-tree could not produce a merge tree for this pull request (exit",
  sanitizedExists: "already exists; refusing to write manifests into a directory this run did not create",
  manifestEntry: "must be exactly one mode-100644 blob entry in the ${3:?}; refusing",
  prototypeKey: "carries, directly or through YAML escapes, an importer name that collides with an object prototype key; refusing",
};

/** Planted in pull-request-controlled content; must never reach the step's output. */
const MARKER = "GHSA-ATTACKER-MANIFEST-MARKER";

let workflow: Workflow;
let pushWorkflow: Workflow;
let steps: Step[];
let auditStep: Step;

beforeAll(async () => {
  workflow = parse(await readFile(resolve(PR_FILE), "utf8")) as Workflow;
  pushWorkflow = parse(await readFile(resolve(PUSH_FILE), "utf8")) as Workflow;
  const job = workflow.jobs?.[JOB_NAME];
  expect(job, `pr-gates.yml must carry a job named ${JOB_NAME}`).toBeDefined();
  steps = job?.steps ?? [];
  auditStep = steps.find((step) => step.name === AUDIT_STEP_NAME) as Step;
});

describe("pr-gates.yml's shape", () => {
  it("is named for the relay's filter, which matches the name: field", () => {
    expect(workflow.name).toBe("pr gates");
  });

  it("triggers on pull_request_target alone, with no paths filter", () => {

    expect(Object.keys(workflow.on ?? {})).toEqual(["pull_request_target"]);
    expect(workflow.on).toEqual({
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    });
  });

  it("scopes permissions to contents: read", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("cancels only superseded runs of the same pull request", () => {
    expect(workflow.concurrency).toEqual({
      group: "pr-gates-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
  });

  it("bounds the producing job's runtime", () => {
    expect(workflow.jobs?.[JOB_NAME]?.["timeout-minutes"]).toBe(10);
  });

  it("binds the pull-request-controlled inputs for every step that runs pnpm", () => {
    // Job level, like the push leg's: Actions env is step-scoped, so a pin on
    // the installing step never reaches the step that executes the audit.
    // The five values are the push leg's five, exactly — a diverged value
    // here would mean the two legs audit under different rules.
    const jobEnv = workflow.jobs?.[JOB_NAME]?.env ?? {};
    for (const [key, value] of Object.entries(ENV_PINS)) {
      expect(jobEnv[key], `${JOB_NAME}'s job env must pin ${key}=${value}`).toBe(value);
    }
    expect(Object.keys(jobEnv).sort()).toEqual(Object.keys(ENV_PINS).sort());
  });

  it("checks out nothing from the pull request, and executes nothing of the pull request's", () => {
    const checkout = steps.filter((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout).toHaveLength(1);

    const setup = steps.filter((step) => step.uses?.startsWith("actions/setup-node"));
    expect(setup).toHaveLength(1);

    const enable = steps.find((step) => step.name === "Enable the pinned package manager");
    expect(enable?.run).toContain("corepack enable");
    expect(enable?.run).toContain("corepack install --global pnpm@");
    expect(enable?.run).toContain("pnpm --version");

    // No step may run anything out of a checkout: the only scripts that
    // execute are this file's own run blocks. And the PR's manifests are
    // read, never installed or executed.
    for (const step of steps) {
      expect(step.run ?? "", `step ${step.name ?? step.uses} must not run a repo script`).not.toMatch(
        /\bnode\s+(\.\/)?scripts\//,
      );
      expect(step.run ?? "").not.toMatch(/\b(pnpm|npm|yarn)\s+(ci|install|i)\b/);
    }
  });

  it("carries exactly the four steps, in the established order", () => {
    expect(steps).toHaveLength(4);
    expect(steps.filter((step) => step.name).map((step) => step.name)).toEqual([
      "Enable the pinned package manager", AUDIT_STEP_NAME,
    ]);
  });

  it("receives the event through env:, never through shell interpolation", () => {
    // The wire format of the event reaches the shell only through the step's
    // env block; a ${{ }} inside any run block would be an interpolation
    // channel this repository denies everywhere.
    for (const step of steps) {
      expect(step.run ?? "", `step ${step.name ?? step.uses}`).not.toContain("${{");
    }
    expect(auditStep.env).toEqual({
      OVERFLOW_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      OVERFLOW_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      GIT_LFS_SKIP_SMUDGE: "1",
    });
  });

  it("fetches by SHA, builds the merge locally, and materializes with the ls-tree discipline", () => {
    const run = auditStep.run ?? "";

    const code = run
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).toContain('git fetch --quiet --no-tags origin "${OVERFLOW_HEAD_SHA:?}"');
    expect(code).toContain('git fetch --quiet --no-tags origin "${OVERFLOW_BASE_SHA:?}"');
    expect(code).not.toContain("refs/pull");
    // The merge tree is built for THIS event's two SHAs, never read from the
    // asynchronous event payload or a refs/pull merge ref.
    expect(run).toContain('git merge-tree --write-tree "${OVERFLOW_BASE_SHA:?}" "${OVERFLOW_HEAD_SHA:?}"');
    // The ls-tree single-blob discipline, per manifest, into a fresh
    // sanitized directory, and the audit reads from it.
    expect(run).toContain('git ls-tree "${1:?}" -- "${2:?}"');
    expect(run).toContain('git cat-file blob "${blob}" > "${2}/${manifest}"');
    expect(run).toContain("for manifest in package.json pnpm-lock.yaml");
    expect(run).toContain('materialize "${merged_tree}" "${sanitized}" "merge tree"');
    expect(run).toContain('materialize "${OVERFLOW_BASE_SHA}" "${base_manifests}" "base commit\'s tree"');
    expect(run).toContain("${RUNNER_TEMP}/audit-manifests");
    expect(run).toContain('cd -- "${sanitized}"');
  });

  it("prints only the fixed refusal constants, and no pull-request bytes", () => {
    const run = auditStep.run ?? "";
    const prologue = run.slice(0, run.indexOf("set -uo pipefail"));
    const errorLines = prologue.split("\n").filter((line) => line.includes("::error::"));
    expect(errorLines.length).toBeGreaterThan(0);
    for (const line of errorLines) {
      expect(
        Object.values(REFUSALS).some((constant) => line.includes(constant)),
        `every refusal must be one of the fixed constants; found ${JSON.stringify(line)}`,
      ).toBe(true);
    }
  });

  it("classifies and lists with the push leg's own scripts, byte-identical", () => {
    // Extracted, never hand-copied: the classifier and the advisory listing are
    // the parts the two legs still share (the PR leg's retry and verdict
    // dispatch differ, since its advisories verdict goes on to audit the base),
    // so each is sliced out of both parsed run texts and required equal.
    const pushRun = pushWorkflow.jobs?.[JOB_NAME]?.steps?.find((step) => step.name === "Audit lockfile advisories")?.run ?? "";
    // advisory-tracking.yml's listing step shares the classifier and the whole retry loop but its clean and advisories arms.
    const tracking = (parse(readFileSync(resolve(".github/workflows/advisory-tracking.yml"), "utf8")) as Workflow).jobs?.["advisory-audit"]?.steps?.find((step) => step.name === "List the advisories without a disposition")?.run ?? "";
    const classifier = /result=\$\(AUDIT_EXIT="\$code" node -e '\n([\s\S]*?)\n'\)/g;
    for (const [shared, copies] of [[classifier, [auditStep.run ?? "", tracking]], [/echo "advisory ids and patched versions:"\n\s*node -e '\n([\s\S]*?)\n\s*'\n/g, [auditStep.run ?? ""]],
      [/(set -uo pipefail\nattempts=3\n[\s\S]*?\n {2}case "\$verdict" in\n)/g, [tracking]], [/(\n {4}transient\)\n[\s\S]*?\n {2}esac\ndone\n)/g, [tracking]]] as Array<[RegExp, string[]]>) {
      const push = [...pushRun.matchAll(shared)].map((match) => match[1]!);
      expect(push).toHaveLength(1);
      for (const copy of copies) expect([...copy.matchAll(shared)].map((match) => match[1]!)).toEqual(push);
    }
    expect(pushRun).toContain('"clean|no known vulnerabilities found"');
  });
});

describe.skipIf(!LINUX_ONLY)("the audit step, run over git fixtures", () => {
  let root = "";
  let cases = 0;
  let shared: Fixture;

  beforeAll(async () => {
    root = await tempDirectories.createAsync(join(tmpdir(), "dependency-audit-pr-"));
    shared = await fixture({ "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE }, { "README.md": "docs only\n" });
  });

  afterAll(async () => {
    await tempDirectories.disposeAsync(root);
  });

  type Fixture = { workspace: string; baseSha: string; headSha: string };
  /** One served answer of the `pnpm` stub. */
  type Outcome = { code: number; stdout: string; stderr?: string; post?: object };
  /** The stub's whole model: `<head|base> <argv>` to the answers it serves in order; any other call exits 97. */
  type Calls = Record<string, Outcome[]>;

  const BASE_PACKAGE = `${JSON.stringify({ name: "scratch", version: "1.0.0", private: true }, null, 2)}\n`;
  const BASE_LOCKFILE = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n";
  const H = "head audit --json";
  const B = "base audit --json";
  /** The local audit request that names the importers pnpm walks; `walked` POSTs one listing `ids` (the root alone by default). */
  const HC = "head audit --json --registry http://127.0.0.1:PORT/";
  const BC = "base audit --json --registry http://127.0.0.1:PORT/";
  const walked = (...ids: string[]): Outcome[] => [{ code: 0, stdout: "", post: { dependencies: Object.fromEntries((ids.length > 0 ? ids : ["."]).map((id) => [id, {}])) } }];
  const headWhy = (...selectors: string[]): string => `head why --json ${selectors.join(" ")}`;
  const baseWhy = (...selectors: string[]): string => `base why --json ${selectors.join(" ")}`;
  const G1 = "GHSA-2222-3333-4444";
  const G2 = "GHSA-5555-6666-7777";
  const X = "x@1.0.0";
  /** The stub replays these captured SHAPES; no registry, no real advisory. */
  const audit = (...found: Array<[string | undefined, string, string?]>): Outcome[] => [{ code: found.length > 0 ? 1 : 0, stdout: `${JSON.stringify({
    advisories: Object.fromEntries(found.map(([id, spec, path], index) => [String(1106913 + index), {
      module_name: spec.split("@")[0], severity: "high", title: "synthetic advisory for the fixture only", vulnerable_versions: "<1.3.1",
      patched_versions: ">=1.3.1", github_advisory_id: id, findings: [{ version: spec.split("@")[1], paths: [path ?? `.>${spec.split("@")[0]}`] }],
    }])),
    metadata: { vulnerabilities: { high: found.length } },
  })}\n` }];
  const IMPORTER = { name: "scratch", version: "1.0.0", depField: "dependencies" };
  const DEV_IMPORTER = { ...IMPORTER, depField: "devDependencies" };
  /** A `pnpm why --json` node for name@version, expanded with its dependents. */
  const node = (spec: string, ...dependents: object[]): object => ({ name: spec.split("@")[0], version: spec.split("@")[1], dependents });
  const marked = (spec: string, mark: "deduped" | "circular"): object => ({ name: spec.split("@")[0], version: spec.split("@")[1], [mark]: true });
  const why = (...roots: object[]): Outcome[] => [{ code: 0, stdout: JSON.stringify(roots) }];
  /** x@1.0.0 under `depth` levels of two dependents each, every level's pair depending on the next: 2^depth paths, each node expanded once; `back` joins a1's dependents. */
  const lattice = (depth: number, root = X, ...back: object[]): object => {
    let pair = [node("a1@1.0.0", IMPORTER, ...back), node("b1@1.0.0", IMPORTER)];
    for (let level = 2; level <= depth; level += 1) {
      pair = [node(`a${level}@1.0.0`, ...pair), node(`b${level}@1.0.0`, marked(`a${level - 1}@1.0.0`, "deduped"), marked(`b${level - 1}@1.0.0`, "deduped"))];
    }
    return node(root, ...pair);
  };
  /** a and b depend on x and on each other (a's dependent b, b's circular mark back to a); c depends on a; b and c are direct. */
  const CYCLIC = node(X, node("a@1.0.0", node("b@1.0.0", marked("a@1.0.0", "circular"), IMPORTER), node("c@1.0.0", DEV_IMPORTER)), marked("b@1.0.0", "deduped"));
  /** a@1.0.0 and a@2.0.0 on one chain; b's circular mark names a@1.0.0 by version too. */
  const TWO_A = node(X, node("a@1.0.0", DEV_IMPORTER, node("a@2.0.0", node("b@1.0.0", IMPORTER, marked("a@1.0.0", "circular")))));
  const SIBLING = node(X, { ...node("a@1.0.0", IMPORTER), peersSuffixHash: "p1" }, node("b@1.0.0", { ...node("a@1.0.0", node("c@1.0.0", IMPORTER, marked("a@1.0.0", "circular"))), peersSuffixHash: "p2" }));
  const SERVER_5XX: Outcome = { code: 1, stdout: `${JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message:
    "The audit endpoint (at http://127.0.0.1:40857/-/npm/v1/security/audits/quick) responded with 503: {\"error\":\"service unavailable\"}. The audit endpoint (at http://127.0.0.1:40857/-/npm/v1/security/audits) responded with 503: {\"error\":\"service unavailable\"}" } })}\n` };
  const NOT_FOUND: Outcome = { code: 1, stdout: `${JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/audits/quick) responded with 404: not found" } })}\n` };
  const UNPARSEABLE = "::error::the audit report or pnpm why output in the merge tree is not in the shape this step reads; refusing";
  const pre = (id: string, spec = X): string => `::warning::${id} in ${spec} is pre-existing on the base`;

  /** Head entry for a path the pull request DELETES from the base tree. */
  const DELETED = Symbol("deleted");

  const GIT_ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "scratch repository",
    GIT_AUTHOR_EMAIL: "scratch@example.invalid", GIT_COMMITTER_NAME: "scratch repository", GIT_COMMITTER_EMAIL: "scratch@example.invalid" };
  const g = (repo: string, ...args: string[]): string => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  /**
   * A scratch origin: `stage` writes a blob and stages it at a path, and
   * `publish` points main at the base and `feature` at the head and clones a
   * workspace (the step's cwd, the state actions/checkout's fetch-depth: 0
   * leaves on a pull_request_target event). main stays at the base, so the
   * clone carries both commits and their shared history in one fetch, and
   * merge-tree finds their true merge base.
   */
  async function scratchOrigin(): Promise<{ dir: string; stage: (path: string, content: string, mode?: string) => Promise<void>; publish: (baseSha: string, headSha: string) => Fixture }> {
    const dir = join(root, `origin-${(cases += 1)}`);
    await mkdir(dir, { recursive: true });
    g(dir, "init", "--quiet", "--initial-branch=main");
    g(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    let blobs = 0;
    const stage = async (path: string, content: string, mode = "100644"): Promise<void> => {
      const file = join(root, `blob-${cases}-${(blobs += 1)}`);
      await writeFile(file, content);
      g(dir, "update-index", "--add", "--cacheinfo", `${mode},${g(dir, "hash-object", "-w", file)},${path}`);
    };
    const publish = (baseSha: string, headSha: string): Fixture => {
      g(dir, "update-ref", "refs/heads/main", baseSha);
      g(dir, "update-ref", "refs/heads/feature", headSha);
      g(root, "clone", "--quiet", `file://${dir}`, `${dir}-workspace`);
      return { workspace: `${dir}-workspace`, baseSha, headSha };
    };
    return { dir, stage, publish };
  }

  /** `base` committed at OVERFLOW_BASE_SHA, and `head` built on it: the two commits the step is handed. */
  async function fixture(base: Record<string, string>, head: Record<string, string | { mode: string; content: string } | typeof DELETED>): Promise<Fixture> {
    const origin = await scratchOrigin();
    for (const [path, content] of Object.entries(base)) await origin.stage(path, content);
    g(origin.dir, "commit", "--quiet", "-m", "base");
    const baseSha = g(origin.dir, "rev-parse", "HEAD");
    for (const [path, entry] of Object.entries(head)) {
      if (entry === DELETED) {
        // The base's entry is still in the index after its commit; a deleted
        // path must leave it explicitly, or write-tree rebuilds the base's
        // file and nothing is deleted.
        g(origin.dir, "update-index", "--force-remove", path);
        continue;
      }
      const spec = typeof entry === "string" ? { mode: "100644", content: entry } : entry;
      await origin.stage(path, spec.content, spec.mode);
    }
    return origin.publish(baseSha, g(origin.dir, "commit-tree", g(origin.dir, "write-tree"), "-p", baseSha, "-m", "head"));
  }

  interface CaseResult {
    status: number | null;
    stdout: string;
    stderr: string;
    sanitized: string;
    baseManifests: string;
    /** The stub's record: one `<head|base|cwd> <argv>` line per invocation. */
    invocations: string[];
    sleeps: string[];
  }

  async function runStep(fx: Fixture, calls: Calls): Promise<CaseResult> {
    const home = join(root, `run-${(cases += 1)}`);
    mkdirSync(join(home, "bin"), { recursive: true });
    const stubDir = join(home, "stub");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "calls.json"), JSON.stringify(calls));
    writeFileSync(join(stubDir, "invocations"), "");
    writeFileSync(join(stubDir, "sleeps"), "");
    writeFileSync(
      join(home, "bin", "pnpm"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const dir = process.env.AUDIT_STUB_DIR;',
        'const temp = process.env.RUNNER_TEMP;',
        'const where = { [temp + "/audit-manifests"]: "head", [temp + "/audit-manifests-base"]: "base" }[process.cwd()] ?? process.cwd();',
        'const registry = process.argv.find((arg) => arg.startsWith("http://127.0.0.1:"));',
        'const call = where + " " + process.argv.slice(2).join(" ").replace(/127\\.0\\.0\\.1:\\d+/, "127.0.0.1:PORT");',
        'fs.appendFileSync(dir + "/invocations", call + "\\n");',
        'const served = fs.readFileSync(dir + "/invocations", "utf8").split("\\n").filter((line) => line === call).length;',
        'const outcomes = JSON.parse(fs.readFileSync(dir + "/calls.json", "utf8"))[call];',
        'if (!outcomes) { process.stderr.write("unmodeled pnpm call: " + call + "\\n"); process.exit(97); }',
        "const outcome = outcomes[Math.min(served, outcomes.length) - 1];",
        'const posted = outcome.post === undefined ? Promise.resolve() : fetch(registry + "-/npm/v1/security/audits/quick", { method: "POST", body: JSON.stringify(outcome.post) }).then((response) => response.text());',
        'posted.then(() => { process.stdout.write(outcome.stdout); process.stderr.write(outcome.stderr ?? ""); process.exit(outcome.code); });',
        "",
      ].join("\n"),
    );
    writeFileSync(join(home, "bin", "sleep"), ["#!/usr/bin/env node", 'require("node:fs").appendFileSync(process.env.AUDIT_STUB_DIR + "/sleeps", process.argv.slice(2).join(" ") + "\\n");', ""].join("\n"));
    for (const stub of ["pnpm", "sleep"]) chmodSync(join(home, "bin", stub), 0o755);

    const runnerTemp = join(home, "runner-temp");
    await mkdir(runnerTemp);
    const script = join(home, "step.sh");
    await writeFile(script, auditStep.run ?? "exit 99\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
      cwd: fx.workspace,
      encoding: "utf8",
      env: {
        ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", OVERFLOW_HEAD_SHA: fx.headSha, OVERFLOW_BASE_SHA: fx.baseSha,
        RUNNER_TEMP: runnerTemp, AUDIT_STUB_DIR: stubDir, DEPENDENCY_AUDIT_RETRY_DELAY_SECONDS: "7",
        PATH: `${join(home, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      sanitized: join(runnerTemp, "audit-manifests"),
      baseManifests: join(runnerTemp, "audit-manifests-base"),
      invocations: (await readFile(join(stubDir, "invocations"), "utf8")).split("\n").filter((line) => line !== ""),
      sleeps: (await readFile(join(stubDir, "sleeps"), "utf8")).split("\n").filter((line) => line !== ""),
    };
  }

  /** Every modeled answer served exactly once, in the order modeled: no unmodeled call, no skipped one. */
  const served = (calls: Calls): string[] => Object.entries(calls).flatMap(([call, outcomes]) => outcomes.map(() => call));

  it("fails a manifest-touching pull request whose merge-tree lockfile adds a vulnerable package", async () => {
    // The pull request changes pnpm-lock.yaml, the merge tree carries the
    // changed bytes, the audit runs on THOSE bytes, the base is materialized
    // from OVERFLOW_BASE_SHA and audited clean, and the finding is the
    // pull request's own: a red the relay mirrors onto a failing check-run.
    const headLockfile = `${BASE_LOCKFILE}# ${MARKER}\n`;
    const fx = await fixture({ "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE }, { "pnpm-lock.yaml": headLockfile });
    const calls = { [H]: audit([G1, "scratch-left-pad@1.3.0"]), [B]: audit(), [HC]: walked(), [headWhy("scratch-left-pad@1.3.0")]: why(node("scratch-left-pad@1.3.0", IMPORTER)) };
    const outcome = await runStep(fx, calls);
    expect(outcome.status).toBe(1);
    expect(outcome.invocations).toEqual(served(calls));
    expect(readFileSync(join(outcome.sanitized, "pnpm-lock.yaml"), "utf8")).toBe(headLockfile);
    expect(readFileSync(join(outcome.sanitized, "package.json"), "utf8")).toBe(BASE_PACKAGE);
    expect(readFileSync(join(outcome.baseManifests, "pnpm-lock.yaml"), "utf8")).toBe(BASE_LOCKFILE);
    expect(readFileSync(join(outcome.baseManifests, "package.json"), "utf8")).toBe(BASE_PACKAGE);
    // The attempt line with the classifier's verdict and detail, the
    // per-advisory listing, then the introduced triple.
    expect(outcome.stdout).toContain("exited 1: advisories — 1 advisories (1 high)");
    expect(outcome.stdout).toContain("scratch-left-pad high: synthetic advisory for the fixture only");
    expect(outcome.stdout).toContain(`::error::the pull request introduces ${G1} in scratch-left-pad@1.3.0 along .>scratch-left-pad, which its base does not carry`);
    expect(outcome.sleeps).toEqual([]);
  });

  // [name, the stub's model, exit status, output that must appear, output that must not]
  const rows: Array<[string, Calls, number, string[], string[]?]> = [
    ["fails a pull request adding a new vulnerable package@version", { [H]: audit([G1, X]), [B]: audit([G2, "y@1.0.0"]), [HC]: walked(), [headWhy(X)]: why(node(X, IMPORTER)), [BC]: walked(), [baseWhy("y@1.0.0")]: why(node("y@1.0.0", IMPORTER)) },
      1, [`::error::the pull request introduces ${G1} in ${X} along .>x, which its base does not carry`], ["::warning::"]],
    // Both audits report the one identical path .>a>x: only the full enumeration sees .>b>x.
    ["fails a new dependent of a vulnerable version the base already carries", { [H]: audit([G1, X, ".>a>x"]), [B]: audit([G1, X, ".>a>x"]),
      [HC]: walked(), [headWhy(X)]: why(node(X, node("a@1.0.0", IMPORTER), node("b@1.0.0", IMPORTER))), [BC]: walked(), [baseWhy(X)]: why(node(X, node("a@1.0.0", IMPORTER))) },
      1, [`::error::the pull request introduces ${G1} in ${X} along .>b>x,`, pre(G1)], ["along .>a>x"]],
    ["passes a head whose findings and paths are the base's, warning on each", { [H]: audit([G1, X], [G2, X]), [B]: audit([G1, X], [G2, X]),
      [HC]: walked(), [headWhy(X)]: why(node(X, node("a@1.0.0", IMPORTER), node("c@1.0.0", marked("a@1.0.0", "deduped")))),
      [BC]: walked(), [baseWhy(X)]: why(node(X, node("a@1.0.0", IMPORTER), node("c@1.0.0", marked("a@1.0.0", "deduped")))) }, 0, [pre(G1), pre(G2)], ["::error::"]],
    ["passes a head that removes a finding", { [H]: audit([G1, X]), [B]: audit([G1, X], [G2, "y@1.0.0"]), [HC]: walked(), [headWhy(X)]: why(node(X, IMPORTER)),
      [BC]: walked(), [baseWhy(X, "y@1.0.0")]: why(node(X, IMPORTER), node("y@1.0.0", IMPORTER)) }, 0, [pre(G1)], ["::error::", G2]],
    ["passes a head that only changes a parent's version along an existing path", { [H]: audit([G1, X, ".>a>x"]), [B]: audit([G1, X, ".>a>x"]),
      [HC]: walked(), [headWhy(X)]: why(node(X, node("a@2.0.0", IMPORTER))), [BC]: walked(), [baseWhy(X)]: why(node(X, node("a@1.0.0", IMPORTER))) }, 0, [pre(G1)], ["::error::"]],
    ["fails closed when the base's audit stays transient", { [H]: audit([G1, X]), [B]: [SERVER_5XX, SERVER_5XX, SERVER_5XX] }, 1, ["still unavailable after 3 attempts"], ["::warning::"]],
    ["fails closed when the base's audit is unreachable", { [H]: audit([G1, X]), [B]: [NOT_FOUND] }, 1, ["exited 1: unreachable", "was NOT audited"], ["::warning::"]],
    ["fails closed when the base's audit is unreadable", { [H]: audit([G1, X]), [B]: [{ code: 1, stdout: "" }] }, 1, ["exited 1: unreadable", "was NOT audited"], ["::warning::"]],
    ["fails closed when pnpm why exits nonzero", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: [{ code: 1, stdout: "[]" }] },
      1, ["::error::pnpm why exited nonzero in the merge tree; refusing to judge findings it could not place"]],
    ["fails closed when the base's pnpm why exits nonzero", { [H]: audit([G1, X]), [B]: audit([G1, X]), [HC]: walked(), [headWhy(X)]: why(node(X, IMPORTER)), [BC]: walked(), [baseWhy(X)]: [{ code: 1, stdout: "[]" }] },
      1, ["::error::pnpm why exited nonzero in the base; refusing"], ["::warning::"]],
    ["fails closed when pnpm why prints unparseable output", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: [{ code: 0, stdout: "[{" }] }, 1, [UNPARSEABLE]],
    ["fails closed on a finding pnpm why places on no path", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: why() },
      1, [`::error::${X} has a finding in the merge tree but pnpm why places it on no path from the root; refusing`]],
    ["fails closed on a finding lacking github_advisory_id", { [H]: audit([undefined, X]), [B]: audit() }, 1, [`::error::a finding on ${X} in the merge tree carries no github_advisory_id; refusing to key it`]],
    // a now depends on b, closing a cycle pnpm prints as b's circular mark; .>c>a>b>x exists only through that edge.
    ["fails a new dependent reaching the vulnerable version only through a cycle", { [H]: audit([G1, X]), [B]: audit([G1, X]), [HC]: walked(), [headWhy(X)]: why(CYCLIC),
      [BC]: walked(), [baseWhy(X)]: why(node(X, node("a@1.0.0", node("b@1.0.0", IMPORTER), node("c@1.0.0", IMPORTER)), marked("b@1.0.0", "deduped"))) },
      1, [`::error::the pull request introduces ${G1} in ${X} along .>c>a>b>x,`, pre(G1)], ["along .>b>a>x,", "along .>c>a>x,", "along .>b>x,"]],
    ["passes a head identical to a base whose graph has a cycle", { [H]: audit([G1, X]), [B]: audit([G1, X]), [HC]: walked(), [headWhy(X)]: why(CYCLIC), [BC]: walked(), [baseWhy(X)]: why(CYCLIC) }, 0, [pre(G1)], ["::error::"]],
    // An a@1.0.0 of another peer suffix was printed (and left) before the chain the mark sits on: only the one above counts.
    ["passes a cycle mark whose name an earlier sibling shares", { [H]: audit([G1, X]), [B]: audit([G1, X]), [HC]: walked(), [headWhy(X)]: why(SIBLING), [BC]: walked(), [baseWhy(X)]: why(SIBLING) }, 0, [pre(G1)], ["::error::"]],
    ["passes a cycle mark that names its node by version as well as name", { [H]: audit([G1, X]), [B]: audit([G1, X]), [HC]: walked(), [headWhy(X)]: why(TWO_A), [BC]: walked(), [baseWhy(X)]: why(TWO_A) }, 0, [pre(G1)], ["::error::"]],
    // pnpm why places paths from the root project alone, while pnpm audit walks every lockfile importer.
    ["fails a second lockfile importer adding an edge onto a version the base already carries", { [H]: audit([G1, X]), [B]: audit([G1, X]), [HC]: walked(".", "sub") },
      1, ["::error::the lockfile in the merge tree names an importer other than the root project, whose paths this step cannot place; refusing"], ["::warning::"]],
    ["fails closed on a base lockfile whose one importer is not the root", { [H]: audit([G1, X]), [B]: audit([G1, X]), [HC]: walked(), [headWhy(X)]: why(node(X, IMPORTER)), [BC]: walked("sub") },
      1, ["::error::the lockfile in the base names an importer other than the root project"]],
    ["fails closed when the local audit request never arrives", { [H]: audit([G1, X]), [B]: audit(), [HC]: [{ code: 1, stdout: "" }] }, 1, [UNPARSEABLE]],
    ["fails closed past the cap counted across a directory's roots", { [H]: audit([G1, X], [G1, "y@1.0.0"]), [B]: audit(), [HC]: walked(), [headWhy(X, "y@1.0.0")]: why(lattice(15), lattice(15, "y@1.0.0")) },
      1, ["::error::the paths in the merge tree need more than 100000 steps to enumerate; refusing"]],
    ["refuses a cycle mark naming no node above it", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: why(node(X, node("a@1.0.0", IMPORTER, marked("q@1.0.0", "circular")))) }, 1, [UNPARSEABLE]],
    ["refuses a cycle mark naming two nodes above it", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: why(node(X, { ...node("a@1.0.0", { ...node("a@1.0.0", IMPORTER,
      marked("a@1.0.0", "circular")), peersSuffixHash: "p2" }), peersSuffixHash: "p1" })) }, 1, [UNPARSEABLE]],
    ["fails closed past the path-enumeration cap", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: why(lattice(16)) },
      1, ["::error::the paths in the merge tree need more than 100000 steps to enumerate; refusing"]],
    ["fails closed past the cap on a graph with a cycle", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: why(lattice(16, X, marked("a16@1.0.0", "circular"))) },
      1, ["::error::the paths in the merge tree need more than 100000 steps to enumerate; refusing"]],
    ["passes paths that stay inside the cap", { [H]: audit([G1, X]), [B]: audit([G1, X]), [HC]: walked(), [headWhy(X)]: why(lattice(15)), [BC]: walked(), [baseWhy(X)]: why(lattice(15)) }, 0, [pre(G1)], ["::error::"]],
    ["refuses a dependent named outside the npm alphabet", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: why(node(X, node("a>b@1.0.0", IMPORTER))) },
      1, ["::error::a package name or version in the merge tree is outside the npm alphabet; refusing to print or key it"], [".>a>b"]],
    ["refuses a reported package outside the npm alphabet", { [H]: audit([G1, "x%0A@1.0.0"]), [B]: audit() },
      1, ["::error::a package name or version in the merge tree is outside the npm alphabet; refusing to print or key it"]],
    ["refuses an advisory listing no findings", { [H]: [{ code: 1, stdout: audit([G1, X])[0]!.stdout.replace(/"findings":\[\{.*?\}\]/, '"findings":[]') }], [B]: audit() }, 1, [UNPARSEABLE]],
    ["refuses a node pnpm why expands twice", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: why(node(X, node("a@1.0.0", IMPORTER), node("b@1.0.0", node("a@1.0.0", IMPORTER)))) }, 1, [UNPARSEABLE]],
    ["refuses a dependent with neither dependents nor a mark", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: why(node(X, { name: "a", version: "1.0.0" })) }, 1, [UNPARSEABLE]],
    ["refuses a deduped node pnpm why never expanded", { [H]: audit([G1, X]), [B]: audit(), [HC]: walked(), [headWhy(X)]: why(node(X, marked("a@1.0.0", "deduped"))) }, 1, [UNPARSEABLE]],
  ];

  it.each(rows)("%s", async (_name, calls, status, present, absent = []) => {
    const outcome = await runStep(shared, calls);
    expect(outcome.status).toBe(status);
    expect(outcome.invocations).toEqual(served(calls));
    for (const text of present) expect(outcome.stdout + outcome.stderr).toContain(text);
    for (const text of absent) expect(outcome.stdout + outcome.stderr).not.toContain(text);
  });

  it("passes a no-manifest pull request on the base's unchanged bytes", async () => {
    // The green half: the pull request touches no manifest, the merge tree
    // carries the base's blobs unchanged, and the context reports the same
    // verdict any clean run reports — never a missing check.
    const outcome = await runStep(shared, { [H]: audit() });
    expect(outcome.status).toBe(0);
    expect(outcome.invocations).toEqual([H]);
    expect(readFileSync(join(outcome.sanitized, "pnpm-lock.yaml"), "utf8")).toBe(BASE_LOCKFILE);
    expect(readFileSync(join(outcome.sanitized, "package.json"), "utf8")).toBe(BASE_PACKAGE);
    expect(outcome.stdout).toContain("clean — no known vulnerabilities found");
  });

  it("audits the merge tree's bytes, not the head's, when main has advanced past the branch point", async () => {
    const origin = await scratchOrigin();
    const baseLock = "lockfileVersion: '9.0'\n";
    const lockAtMain = `# main-side prepended\n${baseLock}`;
    const lockAtHead = `${baseLock}# head-side appended\n`;
    const mergedLock = `# main-side prepended\n${baseLock}# head-side appended\n`;
    // The state must actually discriminate: if a future edit collapses these
    // into one string, the fixture can no longer tell a merge-tree read from
    // a head read, and the assertion below would hold for the wrong reason.
    expect(mergedLock).not.toBe(lockAtHead);
    expect(mergedLock).not.toBe(lockAtMain);
    // Branch point: the shared manifests.
    await origin.stage("package.json", BASE_PACKAGE);
    await origin.stage("pnpm-lock.yaml", baseLock);
    g(origin.dir, "commit", "--quiet", "-m", "branch point");
    const branchPoint = g(origin.dir, "rev-parse", "HEAD");
    // main advances: the lockfile gains a line at the top.
    await origin.stage("pnpm-lock.yaml", lockAtMain);
    g(origin.dir, "commit", "--quiet", "-m", "main advances the lockfile");
    const baseSha = g(origin.dir, "rev-parse", "HEAD");
    // The pull request's head, from the branch point: the lockfile gains a
    // line at the bottom, and nothing else changes.
    await origin.stage("pnpm-lock.yaml", lockAtHead);
    const headSha = g(origin.dir, "commit-tree", g(origin.dir, "write-tree"), "-p", branchPoint, "-m", "head advances the lockfile");

    const outcome = await runStep(origin.publish(baseSha, headSha), { [H]: audit() });
    expect(outcome.status).toBe(0);
    // The bytes the audit actually read are the MERGE tree's lockfile — both
    // sides' lines — not the head's and not the advanced base's.
    expect(readFileSync(join(outcome.sanitized, "pnpm-lock.yaml"), "utf8")).toBe(mergedLock);
    expect(readFileSync(join(outcome.sanitized, "package.json"), "utf8")).toBe(BASE_PACKAGE);
  });

  it("refuses a pull request that deletes a manifest, with the fixed constant", async () => {
    const fx = await fixture({ "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE }, { "package.json": DELETED });
    const outcome = await runStep(fx, { [H]: audit() });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("::error::package.json must be exactly one mode-100644 blob entry in the merge tree; refusing");
    // The audit never ran.
    expect(outcome.invocations).toEqual([]);
  });

  // An importer name that collides with an object prototype key leaves the audit request, so that side's audit reads clean and a hidden edge would pass:
  // each spelling that decodes to it refuses first, on either side, and the writer's ordinary escapes (last pair) do not.
  const hidden = (key: string): string => `${BASE_LOCKFILE}\n${key}\n    dependencies:\n      x:\n        specifier: 1.0.0\n        version: 1.0.0\n`;
  const SPELLINGS = ["  __proto__:", "  ? __proto__\n  :", '  "__proto__" :', '  "\\x5f_proto__":', '  "__pr\\u006Fto__":', '  "__\\U00000070roto__":', '  ? "__pro\\\n    to__"\n  :', '  ? "__pro\\\r    to__"\n  :'];
  it.each([...SPELLINGS.map((key) => [BASE_LOCKFILE, hidden(key), "merge tree", audit(), []]), [hidden(SPELLINGS[0]!), `${BASE_LOCKFILE}# head\n`, "base commit's tree", audit([G1, X]), [H]],
    [BASE_LOCKFILE, `${BASE_LOCKFILE}\npackages:\n\n  x@1.0.0:\n    deprecated: "old\\tversion\\_\\L\\uFEFF\\x09"\n`, "", audit(), [H]]] as Array<[string, string, string, Outcome[], string[]]>)(
    "refuses a lockfile importer colliding with an object prototype key, and only that (pair %#)", async (base, head, side, headAudit, invoked) => {
      const outcome = await runStep(await fixture({ "package.json": BASE_PACKAGE, "pnpm-lock.yaml": base }, { "pnpm-lock.yaml": head }), { [H]: headAudit });
      expect(outcome.status).toBe(side ? 1 : 0);
      expect(outcome.stdout + outcome.stderr).toContain(side ? `::error::pnpm-lock.yaml in the ${side} ${REFUSALS.prototypeKey}` : "clean — no known vulnerabilities found");
      expect(outcome.invocations).toEqual(invoked);
    });

  it("refuses a symlinked manifest without leaking its target", async () => {
    const fx = await fixture({ "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE }, { "pnpm-lock.yaml": { mode: "120000", content: "/etc/ATTACKER-SYMLINK-TARGET" } });
    const outcome = await runStep(fx, { [H]: audit() });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("pnpm-lock.yaml must be exactly one mode-100644 blob entry");
    expect(outcome.stdout + outcome.stderr).not.toContain("ATTACKER-SYMLINK-TARGET");
    expect(outcome.invocations).toEqual([]);
  });

  it("refuses a pull request that does not merge cleanly, and sends the reader to rebase", async () => {
    // Both sides edit the same line after the branch point: merge-tree exits
    // 1, and the refusal is the conflict constant, not the tool-failure one.
    const origin = await scratchOrigin();
    await origin.stage("package.json", '{"name": "scratch", "shared": "line"}\n');
    g(origin.dir, "commit", "--quiet", "-m", "branch point");
    const branchPoint = g(origin.dir, "rev-parse", "HEAD");
    // main moves the line one way; the pull request's head, from the same
    // branch point, moves it another. Same path, same region: conflict.
    await origin.stage("package.json", '{"name": "scratch", "shared": "main side"}\n');
    g(origin.dir, "commit", "--quiet", "-m", "main moves the line");
    const baseSha = g(origin.dir, "rev-parse", "HEAD");
    await origin.stage("package.json", '{"name": "scratch", "shared": "head side"}\n');
    const headSha = g(origin.dir, "commit-tree", g(origin.dir, "write-tree"), "-p", branchPoint, "-m", "head side");

    const outcome = await runStep(origin.publish(baseSha, headSha), { [H]: audit() });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr + outcome.stdout).toContain(REFUSALS.conflict);
    expect(outcome.stderr + outcome.stdout).toContain("rebase the branch onto the base and push again");
    // The audit never ran: nothing was materialized.
    expect(outcome.invocations).toEqual([]);
  });

  it("spends exactly its retry budget on a registry outage and then fails closed", async () => {
    const outcome = await runStep(shared, { [H]: [SERVER_5XX, SERVER_5XX, SERVER_5XX] });
    expect(outcome.status).toBe(1);
    expect(outcome.invocations).toEqual([H, H, H]);
    expect(outcome.sleeps).toEqual(["7", "7"]);
    expect(outcome.stdout).toContain("transient");
    expect(outcome.stdout).toContain("still unavailable after 3 attempts");
  });

  it("carries no pull-request byte through any output on the advisory path", async () => {
    const headPackage = `${BASE_PACKAGE}/* ${MARKER} */\n`;
    const fx = await fixture({ "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE }, { "package.json": headPackage });
    const outcome = await runStep(fx, { [H]: audit([G1, X]), [B]: audit([G1, X]), [HC]: walked(), [headWhy(X)]: why(node(X, IMPORTER)), [BC]: walked(), [baseWhy(X)]: why(node(X, IMPORTER)) });
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain(pre(G1));
    expect(outcome.stdout + outcome.stderr).not.toContain(MARKER);
    expect(readFileSync(join(outcome.sanitized, "package.json"), "utf8")).toBe(headPackage);
  });
});
