import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: unknown; if?: unknown; "continue-on-error"?: unknown };
type Workflow = { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, { permissions?: unknown; env?: unknown; steps: Step[] }> };
const read = (file: string): Workflow => parse(readFileSync(resolve(".github/workflows", file), "utf8")) as Workflow;
const job = read("advisory-tracking.yml").jobs["advisory-tracking"]!;
const pushSteps = read("dependency-audit.yml").jobs["dependency-audit"]!.steps;
const [listing, posting] = ["List the advisories without a disposition", "Update the tracking issue's comment"].map((name) => job.steps.find((step) => step.name === name)!);
/** Every minute a cron minute field fires on: `*`, `n`, `a-b`, `,` lists and `/step`. */
const minutesOf = (field: string): number[] => field.split(",").flatMap((part) => {
  const [range = "*", step = "1"] = part.split("/");
  const [low, high] = range === "*" ? [0, 59] : [Number(range.split("-")[0]), Number(range.split("-")[1] ?? (part.includes("/") ? 59 : range))];
  return Array.from({ length: 60 }, (_, minute) => minute).filter((minute) => minute >= low! && minute <= high! && (minute - low!) % Number(step) === 0);
});

it("runs daily at a minute no other cron fires on, from main, with issues: write only on its one job", () => {
  const workflow = read("advisory-tracking.yml");
  expect([workflow.on, workflow.permissions, Object.keys(workflow.jobs), job.permissions]).toEqual([{ schedule: [{ cron: "17 7 * * *" }], workflow_dispatch: null },
    { contents: "read" }, ["advisory-tracking"], { contents: "read", issues: "write" }]);
  const crons = readdirSync(resolve(".github/workflows")).flatMap((file) => ((read(file).on.schedule ?? []) as Array<{ cron: string }>).map(({ cron }) => cron));
  expect(crons.filter((cron) => minutesOf(cron.split(" ")[0]!).includes(17))).toEqual(["17 7 * * *"]);
  // The push leg's five pins, setup and pnpm, and the token only on the step that writes.
  expect([job.env, job.steps.slice(1, 3)]).toEqual([read("dependency-audit.yml").jobs["dependency-audit"]!.env, pushSteps.slice(2, 4)]);
  expect([job.steps.length, job.steps[0]!.with, listing.env, posting.env]).toEqual([5, { ref: "main", "persist-credentials": false }, undefined,
    { GH_TOKEN: "${{ github.token }}", OVERFLOW_ADVISORY_TRACKING_ISSUE: "1714" }]);
  for (const step of job.steps) expect([step.run?.includes("${{"), step.if, step["continue-on-error"]]).toEqual([step.run === undefined ? undefined : false, undefined, undefined]);
  expect(Object.values(JSON.parse(readFileSync(resolve(".github/required-checks.json"), "utf8")) as string[][]).flat()).not.toContain(".github/workflows/advisory-tracking.yml");
});

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "advisory-tracking-")]);

describe.skipIf(process.platform !== "linux")("the listing and comment steps, run with a stubbed pnpm and gh", () => {
  let root = "";
  let cases = 0;
  beforeAll(async () => { root = await tempDirectories.createAsync(join(tmpdir(), "advisory-tracking-")); });
  afterAll(async () => { await tempDirectories.disposeAsync(root); });
  type Outcome = { code: number; stdout: string };
  type Comment = { user: { login: string }; body: string };
  const [AUDIT, READ, POST] = ["pnpm audit --json", "gh api --paginate --slurp repos/o/r/issues/1714/comments", "gh api --method POST repos/o/r/issues/1714/comments -F body=@$RUNNER_TEMP/advisory-tracking.md --silent"];
  const report = (...ids: string[]): Outcome => ({ code: ids.length > 0 ? 1 : 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { high: ids.length } }, advisories: Object.fromEntries(ids.map((id, index) =>
    [String(1106913 + index), { github_advisory_id: id, module_name: "lodash", severity: "high", title: `Fixture advisory ${id}`, vulnerable_versions: "<4.17.21", patched_versions: ">=4.17.21" }])) }) });
  const failure = (status: number): Outcome => ({ code: 1, stdout: JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: `The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/audits/quick) responded with ${status}: x` } }) });
  const [bot, person] = ["github-actions[bot]", "github-actions"].map((login) => (body: string): Comment => ({ user: { login }, body }));
  const pages = (...comments: Comment[][]): Outcome[] => [{ code: 0, stdout: JSON.stringify(comments) }];
  const STUB = ["#!/usr/bin/env node", 'const fs = require("node:fs"); const dir = process.env.STUB_DIR; const argv = process.argv.slice(2);',
    'const call = [require("node:path").basename(process.argv[1]), ...argv].join(" ").replaceAll(process.env.RUNNER_TEMP, "$RUNNER_TEMP"); fs.appendFileSync(dir + "/calls", JSON.stringify(call) + "\\n");',
    'const body = argv.find((arg) => arg.startsWith("body=@")); if (body) fs.appendFileSync(dir + "/posts", JSON.stringify(fs.readFileSync(body.slice(6), "utf8")) + "\\n");',
    'const model = JSON.parse(fs.readFileSync(dir + "/model.json", "utf8")); const next = (model[call] ?? []).shift(); fs.writeFileSync(dir + "/model.json", JSON.stringify(model));',
    'if (!next) { process.stderr.write("unmodeled call: " + call + "\\n"); process.exit(97); } process.stdout.write(next.stdout); process.exit(next.code);', ""].join("\n");

  /** Runs the listing step, then the comment step if it succeeded; one stub serves pnpm, gh and sleep from `model` in order and exits 97 on any call it does not model. */
  function run(model: Record<string, Outcome[]>): { status: number | null; calls: string[]; posts: string[]; output: string } {
    const home = join(root, `case-${(cases += 1)}`);
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(join(home, "temp"));
    writeFileSync(join(home, "model.json"), JSON.stringify({ "sleep 30": [{ code: 0, stdout: "" }, { code: 0, stdout: "" }], [POST]: [{ code: 0, stdout: "" }], ...model }));
    for (const name of ["pnpm", "gh", "sleep"]) writeFileSync(join(home, "bin", name), STUB, { mode: 0o755 });
    const env = { ...process.env, STUB_DIR: home, RUNNER_TEMP: join(home, "temp"), GITHUB_REPOSITORY: "o/r", ...posting.env, PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}` };
    let [output, status]: [string, number | null] = ["", 0];
    for (const step of [listing, posting]) {
      if (status !== 0) break;
      writeFileSync(join(home, "step.sh"), step.run!);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(home, "step.sh")], { cwd: home, encoding: "utf8", env });
      [output, status] = [output + result.stdout + result.stderr, result.status];
    }
    const lines = (file: string): string[] => { try { return readFileSync(join(home, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string); } catch { return []; } };
    return { status, calls: lines("calls"), posts: lines("posts"), output };
  }
  const [G1, G2] = ["GHSA-2222-3333-4444", "GHSA-5555-6666-7777"];
  /** The real step's own body for an audit naming `ids`, as GitHub may return it: trailing newline dropped. */
  const listed = (...ids: string[]): string => run({ [AUDIT]: [report(...ids)], [READ]: pages([]) }).posts[0]!.replace(/\n+$/, "");

  it("posts the listing when the issue has no comment of its own yet, naming each advisory and the four dispositions", () => {
    const outcome = run({ [AUDIT]: [report(G2, G1)], [READ]: pages([person("unrelated")]) });
    expect([outcome.status, outcome.calls, outcome.posts.length]).toEqual([0, [AUDIT, READ, POST], 1]);
    expect(outcome.posts[0]!.split("\n").filter((line) => line.startsWith("- "))).toEqual([G1, G2].map((id) => `- ${id}: lodash <4.17.21, high: Fixture advisory ${id} (patched >=4.17.21)`));
    for (const disposition of ["upgrade", "override", "removal", "pnpm.auditConfig.ignoreGhsas"]) expect(outcome.posts[0]).toContain(disposition);
  });

  // [name, audit answers, comment pages before the run, the one body posted (trailing newline dropped), or none]
  const rows: Array<[string, Outcome[], () => Comment[][], () => string | undefined]> = [
    ["writes nothing when the latest bot comment, on a later page, is the same listing", [report(G1)], () => [[bot(listed(G2))], [bot(listed(G1)), person("a later reply")]], () => undefined],
    ["posts when the listing differs from the latest bot comment, though an earlier one matched", [report(G1)], () => [[bot(listed(G1)), bot(listed(G2))]], () => listed(G1)],
    ["posts the clean body once a listed advisory is disposed of", [report()], () => [[bot(listed(G1))]], () => "No advisory against main's lockfile lacks a disposition."],
    ["never counts another author's comment as the previous listing", [report(G1)], () => [[person(listed(G1))]], () => listed(G1)],
  ];
  it.each(rows)("%s", (_name, audit, before, after) => {
    const [comments, posted] = [before(), after()];
    const outcome = run({ [AUDIT]: audit, [READ]: pages(...comments) });
    expect([outcome.status, outcome.calls, outcome.posts.map((body) => body.replace(/\n+$/, ""))])
      .toEqual([0, posted === undefined ? [AUDIT, READ] : [AUDIT, READ, POST], posted === undefined ? [] : [posted]]);
  });

  // [name, audit answers, comment read answers, calls made, text the red run prints]
  const reds: Array<[string, Outcome[], Outcome[], string[], string]> = [
    ["an unreadable audit", [{ code: 1, stdout: "" }], [], [AUDIT], "exited 1: unreadable"],
    ["an unreachable registry", [failure(404)], [], [AUDIT], "exited 1: unreachable"],
    ["transient answers past the retry budget", [failure(503), failure(503), failure(503)], [], [AUDIT, "sleep 30", AUDIT, "sleep 30", AUDIT], "still unavailable after 3 attempts"],
    ["comments that cannot be read", [report(G1)], [{ code: 1, stdout: "" }], [AUDIT, READ], ""],
    ["comments that do not parse", [report(G1)], [{ code: 0, stdout: "[[" }], [AUDIT, READ], ""],
  ];
  it.each(reds)("fails red and writes nothing on %s", (_name, audit, comments, calls, printed) => {
    const outcome = run({ [AUDIT]: audit, [READ]: comments });
    expect([outcome.status, outcome.calls, outcome.posts, outcome.output.includes(printed)]).toEqual([1, calls, [], true]);
  });
});
