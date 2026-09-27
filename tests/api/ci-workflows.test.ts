import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
  on: Record<
    string,
    { branches?: string[]; paths?: string[]; types?: string[] } | Array<{ cron: string }> | null
  >;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean | string };
  jobs: Record<string, {
    if?: string;
    "runs-on"?: string;
    "timeout-minutes"?: number;
    services?: Record<string, { image?: string; options?: string }>;
    env?: Record<string, string>;
    steps: Array<{
      if?: string;
      id?: string;
      name?: string;
      uses?: string;
      run?: string;
      with?: Record<string, unknown>;
      env?: Record<string, string>;
    }>;
  }>;
};

describe("GitHub Actions release gates", () => {
  it("preserves claim policy around the reviewed shared action without input overrides", async () => {
    const workflow = await readWorkflow("claim.yml");
    expect(workflow.on).toEqual({ issue_comment: { types: ["created"] } });
    expect(workflow.permissions).toEqual({ issues: "write" });
    expect(workflow.concurrency).toEqual({
      group: "claim-${{ github.event.issue.number }}",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs).toEqual({
      claim: {
        if: "github.event.issue.pull_request == null"
          + " && github.event.issue.state == 'open'"
          + " && github.event.comment.user.type != 'Bot'"
          + " && (contains(github.event.comment.body, '/claim')\n"
          + "    || contains(github.event.comment.body, '/unclaim')\n"
          + "    || contains(github.event.comment.body, '/release'))",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [{ uses: "Nitjsefnie-Actions/claim@d9976f1f803f7a662eed3be17772800b7925e650" }],
      },
    });
  });

  it("checks admission through the reviewed shared action without a consumer checkout", async () => {
    const workflow = await readWorkflow("pr-gate.yml");
    expect(workflow.on).toEqual({ pull_request_target: { types: ["opened", "edited", "reopened"] } });
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "write", issues: "read" });
    expect(workflow.concurrency).toEqual({
      group: "pr-gate-${{ github.event.pull_request.number }}",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs).toEqual({
      gate: {
        if: "github.event.pull_request.user.type != 'Bot'",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [{
          uses: "Nitjsefnie-Actions/pr-gate@679744b0807472d5fd681e42759f081494f2f562",
          with: {
            "github-token": "${{ github.token }}",
            repository: "${{ github.repository }}",
            "pull-request-number": "${{ github.event.pull_request.number }}",
            "pull-request-author": "${{ github.event.pull_request.user.login }}",
          },
        }],
      },
    });
  });

  it("judges the pull request head only as git data, executed entirely from main", async () => {
    const workflow = await readWorkflow("ratchet-guard.yml");
    // pull_request_target keeps the gate alive when a pull request disables
    // the pull_request ci run: the workflow definition, the checkout and the
    // script that executes all come from main. `branches: [main]` keeps a PR
    // retargeted to main (an edited event, which gets no new run) from
    // carrying its stale green over. push covers the commits main itself
    // lands: the repo merges with --rebase, so a merged SHA is a brand-new
    // commit no pull_request run covered, and every push to main must carry
    // a ratchet-guard run for the check to be required and for the deploy
    // gate (scripts/deploy-revision.sh) to pass on the tip it lands. No
    // paths filter: a push without one of the compared files still needs its
    // own run, or deploys of the tip it lands hang on `(absent)`.
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    // Pushes to main must never share a group: GitHub keeps only one PENDING
    // run per concurrency group and cancels the older pending one even with
    // cancel-in-progress false, and a cancelled conclusion on a merged SHA
    // makes the deploy gate refuse immediately. Keying on the SHA gives each
    // push its own group; pull requests keep one group per PR with
    // cancellation.
    expect(workflow.concurrency).toEqual({
      group: "ratchet-guard-${{ github.event.pull_request.number || github.sha }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request_target' }}",
    });
    // The whole job, exactly, in the dependency-audit style. Two checkouts,
    // each gated on the event name: under pull_request_target the checkout
    // has no ref input at all — actions/checkout's default, main's last
    // commit, the checkout its fork guard exempts; under push its ref is
    // github.event.before, the previous main tip, whose copy of
    // scripts/check-ratchets.ts executes. Splitting the steps on the event
    // name keeps each checkout's ref visible without evaluating an
    // expression: the pull_request_target step has no ref input at all, so
    // it is visibly the default checkout (main's tip, exempt from
    // checkout's fork guard), and the push step visibly pins the previous
    // main tip. On a push GitHub always sets `before` to a 40-hex SHA. No
    // step installs or builds anything: untrusted content enters only as
    // git objects (refs/remotes/pr/head under pull_request_target,
    // FETCH_HEAD under push), and the only script that runs is a main-side
    // scripts/check-ratchets.ts reading those objects with `git show`. The
    // base of the comparison is the
    // checked-out commit itself (HEAD) under both events, never the event's
    // base.sha: under pull_request_target that value is recorded when the
    // pull request opens and can trail main, and after a rebase onto a newer
    // main the merge base of the stale base and the head sits below the real
    // fork point, so a real relaxation would pass against the looser
    // document there. Under push the checked-out previous tip is, for a
    // non-forced push, a direct ancestor of the pushed SHA, so the merge
    // base is the previous tip
    // itself and the comparison is exactly "did this push relax a ratchet
    // document relative to the main it replaced". Every event value travels
    // through env, never ${{ }} in run:.
    expect(workflow.jobs).toEqual({
      "ratchet-guard": {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 10,
        steps: [
          {
            if: "${{ github.event_name == 'pull_request_target' }}",
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: {
              "persist-credentials": false,
              "fetch-depth": 0,
            },
          },
          {
            if: "${{ github.event_name == 'push' }}",
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: {
              ref: "${{ github.event.before }}",
              "persist-credentials": false,
              "fetch-depth": 0,
            },
          },
          {
            uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
            with: { "node-version": "24.17.0" },
          },
          {
            if: "${{ github.event_name == 'pull_request_target' }}",
            name: "Fetch the pull request head",
            env: { PR_NUMBER: "${{ github.event.pull_request.number }}" },
            run: 'git fetch --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"',
          },
          {
            if: "${{ github.event_name == 'pull_request_target' }}",
            name: "Ratchet documents",
            env: { HEAD_SHA: "${{ github.event.pull_request.head.sha }}" },
            run: 'node scripts/check-ratchets.ts HEAD "$HEAD_SHA"',
          },
          {
            if: "${{ github.event_name == 'push' }}",
            name: "Fetch the pushed commit",
            env: { PUSHED_SHA: "${{ github.sha }}" },
            run: 'git fetch --no-tags origin "$PUSHED_SHA"',
          },
          {
            if: "${{ github.event_name == 'push' }}",
            name: "Ratchet documents against the previous main",
            env: { PUSHED_SHA: "${{ github.sha }}" },
            run: 'node scripts/check-ratchets.ts HEAD "$PUSHED_SHA"',
          },
        ],
      },
    });
  });

  it("parses a complete PostgreSQL 17 gate with pinned actions and every release command", async () => {
    const workflow = await readWorkflow("ci.yml");
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      packageManager?: string;
      engines?: Record<string, string>;
    };
    expect(manifest).toMatchObject({
      packageManager: "pnpm@10.33.0",
      engines: { node: "24.17.0", pnpm: "10.33.0" },
    });
    expect(workflow.on).toEqual(expect.objectContaining({
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
      // The dispatch trigger carries the calibrate self-test's input: a
      // boolean, defaulting false, whose fabricated raise must be refused by
      // branch protection so the calibrate job fails visibly (issue 684).
      // Pinned in full so a retyped, re-defaulted or renamed input — the
      // difference between a self-test dispatch and an accidental
      // fabrication — fails here.
      workflow_dispatch: {
        inputs: {
          "simulate-refused-raise": {
            description: "calibrate self-test: fabricate a coverage raise so the push is refused by branch protection and the job fails visibly (issue 684)",
            type: "boolean",
            default: false,
          },
        },
      },
    }));
    expect(workflow.on.push).not.toHaveProperty("paths");
    expect(workflow.on.pull_request).not.toHaveProperty("paths");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "ci-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });

    const verify = workflow.jobs.verify!;
    expect(verify.services?.postgres?.image).toBe("postgres:17@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675");
    expect(verify.services?.postgres?.options).toContain("pg_isready");
    expect(verify.steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);
    expect(verify.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with)
      .toEqual(expect.objectContaining({ "persist-credentials": false }));
    expect(verify.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with)
      .toEqual(expect.objectContaining({ "node-version": "24.17.0" }));
    expect(verify.steps.map((step) => step.run).filter(Boolean)).toEqual(expect.arrayContaining([
      "pnpm install --frozen-lockfile",
      "pnpm db:migrate",
      "pnpm test --run",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm build",
    ]));
    expect(verify.env).toEqual(expect.objectContaining({
      DATABASE_URL: "postgresql://overflow:overflow@127.0.0.1:5432/overflow_ci",
      GITHUB_WEBHOOK_URL: "https://overflow.invalid/api/github/webhooks",
      TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }));
  });

  it("parses a catalogue-style workflow gate with explicit least privilege and pinned actions", async () => {
    const workflow = await readWorkflow("actionlint.yml");
    expect(workflow.on).toEqual(expect.objectContaining({
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
      workflow_dispatch: null,
    }));
    expect(workflow.on.push).not.toHaveProperty("paths");
    expect(workflow.on.pull_request).not.toHaveProperty("paths");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "actionlint-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
    const steps = workflow.jobs.actionlint!.steps;
    expect(steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with)
      .toEqual(expect.objectContaining({ "persist-credentials": false }));
    expect(steps.some((step) => step.run === "./actionlint -color .github/workflows/*.yml")).toBe(true);
    expect(steps.some((step) => step.run === "zizmor --no-progress .github/workflows/")).toBe(true);
  });

  it("parses a scheduled lockfile audit whose gate is the bare audit command's exit code", async () => {
    const workflow = await readWorkflow("dependency-audit.yml");
    expect(workflow.on).toEqual({
      schedule: [{ cron: "37 6 * * 1" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "dependency-audit-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });

    // The whole job, exactly, in the claim/pr-gate style: any extra key — a
    // step-level continue-on-error tolerating a red audit, or a job-level
    // permissions override — fails this equality. The gate is the audit
    // command's own exit code, exactly as verified against pnpm 10.33.0:
    // bare `pnpm audit` exits 1 iff advisories exist. No install and no
    // build precede it — pnpm audit reads pnpm-lock.yaml directly.
    expect(workflow.jobs.audit).toEqual({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      steps: [
        {
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "persist-credentials": false },
        },
        {
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "24.17.0" },
        },
        {
          name: "Enable the pinned package manager",
          run: "corepack enable\ncorepack install --global pnpm@10.33.0\npnpm --version\n",
        },
        {
          name: "Audit lockfile advisories",
          run: "pnpm audit",
        },
      ],
    });
  });

  it("keeps the dependabot update policy excluding the locally patched postgres", async () => {
    const config = parse(await readFile(resolve(".github/dependabot.yml"), "utf8")) as {
      version: number;
      updates: Array<{
        "package-ecosystem": string;
        directory: string;
        schedule: { interval: string };
        "open-pull-requests-limit": number;
        ignore?: Array<{ "dependency-name": string }>;
      }>;
    };

    expect(config.version).toBe(2);
    const npm = config.updates.find((update) => update["package-ecosystem"] === "npm");
    expect(npm).toBeDefined();
    expect(npm!.directory).toBe("/");
    expect(npm!.schedule).toEqual({ interval: "weekly" });
    expect(npm!["open-pull-requests-limit"]).toBe(5);
    // An automated postgres bump invalidates patches/postgres@3.4.9.patch and
    // its pnpm-lock.yaml patchedDependencies hash, breaking
    // `pnpm install --frozen-lockfile` — bumps stay by-hand.
    expect(npm!.ignore).toEqual([{ "dependency-name": "postgres" }]);
  });

  it("adds the github-actions and docker ecosystems to the weekly dependabot schedule", async () => {
    const config = parse(await readFile(resolve(".github/dependabot.yml"), "utf8")) as {
      updates: Array<{
        "package-ecosystem": string;
        directory: string;
        schedule: { interval: string };
        "open-pull-requests-limit": number;
        groups?: Record<
          string,
          { "applies-to"?: string; "update-types"?: string[]; patterns?: string[] }
        >;
      }>;
    };

    expect(config.updates.map((update) => update["package-ecosystem"])).toEqual([
      "npm",
      "github-actions",
      "docker",
    ]);
    for (const ecosystem of ["github-actions", "docker"]) {
      const update = config.updates.find((u) => u["package-ecosystem"] === ecosystem)!;
      expect(update.directory, ecosystem).toBe("/");
      expect(update.schedule, ecosystem).toEqual({ interval: "weekly" });
      // Per-entry cap: each updates entry opens at most five pull requests a
      // week (the npm lane included), so three entries could reach fifteen —
      // no single lane floods, but the cap does not pool across ecosystems.
      expect(update["open-pull-requests-limit"], ecosystem).toBe(5);
    }
    // The two Nitjsefnie-Actions workflows are SHA-pinned by maintainer
    // decision and dependabot now proposes their SHA bumps; grouping
    // non-major bumps keeps those, plus the pinned actions/* shas, in one
    // pull request per week instead of one per action. Version updates only:
    // a security advisory must still open a single-package pull request.
    const actions = config.updates.find((u) => u["package-ecosystem"] === "github-actions")!;
    expect(actions.groups).toEqual({
      "minor-and-patch": {
        "applies-to": "version-updates",
        "update-types": ["minor", "patch"],
      },
    });
  });

  it("hash-pins the zizmor install through the tracked requirements file", async () => {
    const workflow = await readWorkflow("actionlint.yml");
    const steps = workflow.jobs.actionlint!.steps;

    const install = steps.find((step) => step.id === "install_zizmor");
    expect(install).toBeDefined();
    expect(install!.name).toBe("Install zizmor");
    // The hashed requirements file is the only install path: no bare
    // `pip install zizmor` and no pip upgrade step — upgrading pip itself is
    // exactly the unhashed supply-chain lane this gate closes.
    expect(install!.run?.trim()).toBe(
      "pip install --require-hashes -r .github/requirements-zizmor.txt",
    );
    expect(install!.run).not.toContain("upgrade pip");
    expect(install!.run).not.toContain("pip install zizmor");
    // The id is load-bearing: the zizmor step's condition skips the scan only
    // when the install failed.
    const zizmor = steps.find((step) => step.run === "zizmor --no-progress .github/workflows/");
    expect(zizmor).toBeDefined();
    expect(zizmor!.if).toBe("${{ !cancelled() && steps.install_zizmor.outcome == 'success' }}");
  });

  it("hash-pins every artifact in the zizmor requirements file", async () => {
    const text = await readFile(resolve(".github/requirements-zizmor.txt"), "utf8");
    const requirements = text.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("#");
    });

    expect(requirements.length).toBeGreaterThan(0);
    for (const line of requirements) {
      expect(line).toContain("--hash=sha256:");
    }
    // Floor for the all-platform shape the file header claims: a
    // regeneration that collapsed the pin to a single artifact's hash (one
    // wheel) must fail here instead of silently narrowing both the platforms
    // the install resolves on and the pin's tamper-resistance.
    const hashes = new Set(
      requirements.flatMap((line) =>
        [...line.matchAll(/--hash=sha256:([0-9a-f]+)/g)].map((match) => match[1]),
      ),
    );
    expect(hashes.size).toBeGreaterThanOrEqual(2);
    const zizmor = requirements.find((line) => line.startsWith("zizmor=="));
    expect(zizmor).toBeDefined();
    expect(zizmor).toContain("zizmor==1.29.0");
    // Tracked: the deny-by-default policy must name this exact file back,
    // while other .github/*.txt (the junk counterexamples) stay ignored.
    expect(checkIgnore(".github/requirements-zizmor.txt")).toBe(1);
    expect(checkIgnore(".github/junk.txt")).toBe(0);
  });

  it("groups the React family so dependabot bumps it in lockstep", async () => {
    const config = parse(await readFile(resolve(".github/dependabot.yml"), "utf8")) as {
      updates: Array<{
        "package-ecosystem": string;
        groups?: Record<string, Record<string, unknown> & { patterns?: string[] }>;
      }>;
    };
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const dependencyNames = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
    ];
    // Dependabot group patterns are globs where `*` matches any run of
    // characters; resolve them against the real manifest so an over-broad
    // pattern is caught by what it sweeps in today.
    const globMatches = (pattern: string, name: string) =>
      new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`)
        .test(name);

    const npm = config.updates.find((update) => update["package-ecosystem"] === "npm");
    expect(npm).toBeDefined();
    const groups = Object.values(npm!.groups ?? {});
    const reactFamily = ["@types/react", "@types/react-dom", "react", "react-dom"];

    // A group without `applies-to` covers version updates only, and security
    // updates are enabled on this repository, so a React advisory would still
    // open a single-package pull request unless a second group covers that
    // lane. Each lane needs exactly one React group.
    for (const lane of ["version-updates", "security-updates"]) {
      const laneGroups = groups.filter((group) => (group["applies-to"] ?? "version-updates") === lane);
      expect(laneGroups, lane).toHaveLength(1);
      const [group] = laneGroups;
      // Any key beyond the lane (update-types, dependency-type,
      // exclude-patterns, ...) narrows which bumps the group collects, so a
      // React bump could arrive split again.
      expect(Object.keys(group!).filter((key) => key !== "applies-to"), lane).toEqual(["patterns"]);
      const patterns = group!.patterns ?? [];
      const members = dependencyNames.filter((name) =>
        patterns.some((pattern) => globMatches(pattern, name)));

      // react-dom refuses to load beside any other react version, so a bump
      // that moves one member alone breaks every test file.
      expect(members.sort(), lane).toEqual(reactFamily);
      // Exact names, not wildcards: `react*` + `@types/react*` resolves to the
      // four today but would also collect a future react-is.
      expect([...patterns].sort(), lane).toEqual(reactFamily);
    }
  });

  it("reopens only shipped yml workflows in the deny-by-default ignore policy", () => {
    expect(checkIgnore(".github/workflows/ci.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/actionlint.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/dependency-audit.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/ratchet-guard.yml")).toBe(1);
    expect(checkIgnore(".github/dependabot.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/unshipped.yaml")).toBe(0);
    expect(checkIgnore(".github/junk.txt")).toBe(0);
  });

  it("parses a source-only CodeQL scan that installs and builds nothing", async () => {
    const workflow = await readWorkflow("code-scanning.yml") as Workflow & { name: string };
    expect(workflow.name).toBe("code scanning");
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
      schedule: [{ cron: "43 5 * * 3" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "code-scanning-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });

    const analyze = workflow.jobs.analyze! as typeof workflow.jobs.analyze & {
      permissions: Record<string, string>;
    };
    expect(analyze.steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);

    // The whole job, exactly, in the dependency-audit style: the job-level
    // permissions object is the least privilege uploading SARIF needs, and
    // any extra key — a tolerated failure, a checkout without
    // persist-credentials disabled — fails this equality.
    expect(analyze).toEqual({
      permissions: { contents: "read", "security-events": "write" },
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 30,
      steps: [
        {
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "persist-credentials": false },
        },
        {
          uses: "github/codeql-action/init@b96794f015dfd88f77b49b1c93e0fa7110f94c63",
          with: { languages: "javascript-typescript" },
        },
        {
          uses: "github/codeql-action/analyze@b96794f015dfd88f77b49b1c93e0fa7110f94c63",
          with: { category: "/language:javascript-typescript" },
        },
      ],
    } satisfies typeof analyze);

    // The no-build principle as its own named assertion, so a "helpful"
    // install or build step fails a pin that says so rather than only a
    // shape diff: CodeQL for JS/TS extracts from source.
    for (const command of analyze.steps.map((step) => step.run).filter(Boolean)) {
      expect(command).not.toMatch(/pnpm (install|build)/);
    }
  });
});

async function readWorkflow(name: string): Promise<Workflow> {
  return parse(await readFile(resolve(".github/workflows", name), "utf8")) as Workflow;
}

function checkIgnore(pathname: string): number | null {
  return spawnSync("git", ["check-ignore", "--no-index", "--quiet", pathname], {
    cwd: resolve("."),
  }).status;
}
