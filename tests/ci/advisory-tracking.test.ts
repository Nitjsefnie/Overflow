import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

type Step = { id?: string; name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: unknown; if?: unknown; "continue-on-error"?: unknown };
type Job = { needs?: unknown; outputs?: Record<string, string>; permissions?: unknown; env?: unknown; steps: Step[] };
type Workflow = { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> };
const read = (file: string): Workflow => parse(readFileSync(resolve(".github/workflows", file), "utf8")) as Workflow;
const { "advisory-audit": audit, "advisory-comment": comment } = read("advisory-tracking.yml").jobs as Record<string, Job>;
const pushSteps = read("dependency-audit.yml").jobs["dependency-audit"]!.steps;
const listing = audit!.steps.find((step) => step.name === "List the advisories without a disposition")!;
const posting = comment!.steps.find((step) => step.name === "Update the tracking issue's comment")!;
/** Every minute a cron minute field fires on: `*`, `n`, `a-b`, `,` lists and `/step`. */
const minutesOf = (field: string): number[] => field.split(",").flatMap((part) => {
  const [range = "*", step = "1"] = part.split("/");
  const [low, high] = range === "*" ? [0, 59] : [Number(range.split("-")[0]), Number(range.split("-")[1] ?? (part.includes("/") ? 59 : range))];
  return Array.from({ length: 60 }, (_, minute) => minute).filter((minute) => minute >= low! && minute <= high! && (minute - low!) % Number(step) === 0);
});

it("runs daily at a minute no other cron fires on: a read-only job audits main, and only a job running no pnpm and no checkout holds issues: write", () => {
  const workflow = read("advisory-tracking.yml");
  expect([workflow.on, workflow.permissions, Object.keys(workflow.jobs), audit!.permissions, comment!.permissions, comment!.needs]).toEqual([{ schedule: [{ cron: "17 7 * * *" }],
    workflow_dispatch: null }, { contents: "read" }, ["advisory-audit", "advisory-comment"], undefined, { issues: "write" }, "advisory-audit"]);
  const crons = readdirSync(resolve(".github/workflows")).flatMap((file) => ((read(file).on.schedule ?? []) as Array<{ cron: string }>).map(({ cron }) => cron));
  expect(crons.filter((cron) => minutesOf(cron.split(" ")[0]!).includes(17))).toEqual(["17 7 * * *"]);
  // The push leg's five pins, setup and pnpm on the audit job; the body handed over as an output; the token only where it posts.
  expect([audit!.env, audit!.steps.slice(1, 3), audit!.steps.length, audit!.steps[0]!.with, listing.env, audit!.outputs]).toEqual([read("dependency-audit.yml").jobs["dependency-audit"]!.env,
    pushSteps.slice(2, 4), 4, { ref: "main", "persist-credentials": false }, undefined, { body: "${{ steps.listing.outputs.body }}" }]);
  expect([comment!.env, comment!.steps, /\b(pnpm|npm|npx|node|corepack)\b/.test(posting.run!)]).toEqual([undefined, [posting], false]);
  expect(posting.env).toEqual({ GH_TOKEN: "${{ github.token }}", OVERFLOW_ADVISORY_TRACKING_ISSUE: "1714", OVERFLOW_ADVISORY_BODY: "${{ needs.advisory-audit.outputs.body }}" });
  for (const step of [...audit!.steps, posting]) expect([step.run?.includes("${{"), step.if, step["continue-on-error"]]).toEqual([step.run === undefined ? undefined : false, undefined, undefined]);
  expect(Object.values(JSON.parse(readFileSync(resolve(".github/required-checks.json"), "utf8")) as string[][]).flat()).not.toContain(".github/workflows/advisory-tracking.yml");
});

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "advisory-tracking-")]);

describe.skipIf(process.platform !== "linux")("the audit job's listing and the comment job, run with a stubbed pnpm and gh", () => {
  let [root, cases] = ["", 0];
  beforeAll(async () => { root = await tempDirectories.createAsync(join(tmpdir(), "advisory-tracking-")); }); afterAll(async () => { await tempDirectories.disposeAsync(root); });
  type Outcome = { code: number; stdout: string }; type Comment = { user: { login: string }; body: string };
  const [AUDIT, READ, POST] = ["pnpm audit --json", "gh api --paginate repos/o/r/issues/1714/comments", "gh api --method POST repos/o/r/issues/1714/comments -F body=@$RUNNER_TEMP/advisory-tracking.md --silent"];
  /** Titles carry a mention, an issue reference, a backtick run and a line break: the listing must keep each inert inside one code span. */
  const report = (...ids: string[]): Outcome => ({ code: ids.length > 0 ? 1 : 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { high: ids.length } }, advisories: Object.fromEntries(ids.map((id, index) =>
    [String(1106913 + index), { github_advisory_id: id, module_name: "lodash", severity: "high", title: `Fixture @advisory ${id}\nin #1 with \`\`code\`\``, vulnerable_versions: "<4.17.21", patched_versions: ">=4.17.21" }])) }) });
  const failure = (status: number): Outcome => ({ code: 1, stdout: JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: `The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/audits/quick) responded with ${status}: x` } }) });
  const [bot, person, app] = ["github-actions[bot]", "github-actions", "dependabot[bot]"].map((login) => (body: string): Comment => ({ user: { login }, body }));
  const pages = (...comments: Comment[][]): Outcome[] => [{ code: 0, stdout: JSON.stringify(comments) }];
  /** One stub for pnpm, gh and sleep: serves `model` in order, applies a `--jq` filter to each served page with real jq as gh does, and exits 97 on any call it does not model. */
  const STUB = ["#!/usr/bin/env node", 'const fs = require("node:fs"); const dir = process.env.STUB_DIR; const argv = process.argv.slice(2); const jq = argv.indexOf("--jq");',
    'const call = [require("node:path").basename(process.argv[1]), ...argv.filter((_, i) => jq < 0 || (i !== jq && i !== jq + 1))].join(" ").replaceAll(process.env.RUNNER_TEMP, "$RUNNER_TEMP");',
    'fs.appendFileSync(dir + "/calls", JSON.stringify(call) + "\\n"); const body = argv.find((arg) => arg.startsWith("body=@")); if (body) fs.appendFileSync(dir + "/posts", JSON.stringify(fs.readFileSync(body.slice(6), "utf8")) + "\\n");',
    'const model = JSON.parse(fs.readFileSync(dir + "/model.json", "utf8")); const next = (model[call] ?? []).shift(); fs.writeFileSync(dir + "/model.json", JSON.stringify(model));',
    'if (!next) { process.stderr.write("unmodeled call: " + call + "\\n"); process.exit(97); } if (jq < 0 || next.code !== 0) { process.stdout.write(next.stdout); process.exit(next.code); }',
    'for (const page of JSON.parse(next.stdout)) { const r = require("node:child_process").spawnSync("jq", ["-r", argv[jq + 1]], { input: JSON.stringify(page), encoding: "utf8" }); if (r.status !== 0) process.exit(1); process.stdout.write(r.stdout); }',
    ""].join("\n");
  /** GitHub's GITHUB_OUTPUT grammar: `name=value` lines and `name<<DELIMITER` blocks; an unterminated block throws. */
  const outputsOf = (text: string): Record<string, string> => { const [lines, found] = [text.split("\n"), {} as Record<string, string>];
    for (let index = 0; index < lines.length; index += 1) { const [line, block] = [lines[index]!, /^([\w-]+)<<(.+)$/.exec(lines[index]!)]; const end = block ? lines.indexOf(block[2]!, index + 1) : index;
      if (end < 0) throw new Error("unterminated output block"); else if (block) [found[block[1]!], index] = [lines.slice(index + 1, end).join("\n"), end]; else if (line.includes("=")) found[line.split("=")[0]!] = line.slice(line.indexOf("=") + 1); }
    return found; };

  /** Runs the audit job's listing step, then (if green) the comment job with its env resolved from the audit job's declared outputs, as GitHub would; `handover: false` drops them. */
  function run(model: Record<string, Outcome[]>, handover = true): { status: number | null; calls: string[]; posts: string[]; output: string } {
    const home = join(root, `case-${(cases += 1)}`);
    for (const dir of ["bin", "temp-audit", "temp-comment"]) mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, "model.json"), JSON.stringify({ "sleep 30": [{ code: 0, stdout: "" }, { code: 0, stdout: "" }], [POST]: [{ code: 0, stdout: "" }], ...model }));
    for (const name of ["pnpm", "gh", "sleep"]) writeFileSync(join(home, "bin", name), STUB, { mode: 0o755 }); writeFileSync(join(home, "output"), "");
    const exec = (step: Step, temp: string, env: Record<string, string>) => { writeFileSync(join(home, "step.sh"), step.run!); return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(home, "step.sh")],
      { cwd: home, encoding: "utf8", env: { ...process.env, ...env, STUB_DIR: home, RUNNER_TEMP: join(home, temp), GITHUB_REPOSITORY: "o/r", GITHUB_OUTPUT: join(home, "output"), PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}` } }); };
    let result = exec(listing, "temp-audit", {}); let [output, status] = [result.stdout + result.stderr, result.status];
    if (status === 0) {
      const stepOutputs = outputsOf(readFileSync(join(home, "output"), "utf8"));
      const jobOutputs = Object.fromEntries(Object.entries(audit!.outputs ?? {}).map(([name, value]) => [name, value.replace(/^\$\{\{ steps\.([\w-]+)\.outputs\.([\w-]+) \}\}$/, (_, id, key) => (id === listing.id ? stepOutputs[key] : undefined) ?? "")]));
      const needs = (value: string): string => value.replace(/^\$\{\{ needs\.([\w-]+)\.outputs\.([\w-]+) \}\}$/, (_, job, key) => (handover && [comment!.needs].flat().includes(job) && job === "advisory-audit" ? jobOutputs[key] : undefined) ?? "");
      result = exec(posting, "temp-comment", Object.fromEntries(Object.entries(posting.env ?? {}).map(([name, value]) => [name, needs(value)])));
      [output, status] = [output + result.stdout + result.stderr, result.status];
    }
    const lines = (file: string): string[] => { try { return readFileSync(join(home, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string); } catch { return []; } };
    return { status, calls: lines("calls"), posts: lines("posts"), output };
  }
  const [G1, G2] = ["GHSA-2222-3333-4444", "GHSA-5555-6666-7777"];
  /** The real jobs' own body for an audit naming `ids`, as GitHub may return it: trailing newline dropped. */
  const listed = (...ids: string[]): string => run({ [AUDIT]: [report(...ids)], [READ]: pages([]) }).posts[0]!.replace(/\n+$/, "");

  it("posts the marked listing when the issue has none yet, every advisory field inside a code span and the four dispositions named", () => {
    const outcome = run({ [AUDIT]: [report(G2, G1)], [READ]: pages([person("unrelated")]) });
    expect([outcome.status, outcome.calls, outcome.posts.length, outcome.posts[0]!.split("\n")[0]]).toEqual([0, [AUDIT, READ, POST], 1, "<!-- overflow:advisory-tracking -->"]);
    expect(outcome.posts[0]!.split("\n").filter((line) => line.startsWith("- "))).toEqual([G1, G2].map((id) =>
      `- \` ${id} \`: \` lodash \` \` <4.17.21 \`, \` high \`: \`\`\` Fixture @advisory ${id} in #1 with \`\`code\`\` \`\`\` (patched \` >=4.17.21 \`)`));
    for (const disposition of ["upgrade", "override", "removal", "pnpm.auditConfig.ignoreGhsas"]) expect(outcome.posts[0]).toContain(disposition);
  });

  // [name, audit answers, comment pages before the run, the one body posted (trailing newline dropped), or none]
  const rows: Array<[string, Outcome[], () => Comment[][], () => string | undefined]> = [
    ["writes nothing when the latest marked bot comment, on a later page, is the same listing", [report(G1)], () => [[bot(listed(G2))], [bot(listed(G1)), person("a later reply")]], () => undefined],
    ["writes nothing when a later bot reply carries no marker", [report(G1)], () => [[bot(listed(G1)), bot("Assigned to @someone.")]], () => undefined],
    ["posts when the listing differs from the latest marked bot comment, though an earlier one matched", [report(G1)], () => [[bot(listed(G1)), bot(listed(G2))]], () => listed(G1)],
    ["posts the clean body once a listed advisory is disposed of", [report()], () => [[bot(listed(G1))]], () => "<!-- overflow:advisory-tracking -->\n\nNo advisory against main's lockfile lacks a disposition."],
    ["never counts another author's comment as the previous listing", [report(G1)], () => [[person(listed(G1))]], () => listed(G1)],
    ["never counts another App's bot comment, marker and all, as the previous listing", [report(G1)], () => [[app(listed(G1))]], () => listed(G1)],
  ];
  it.each(rows)("%s", (_name, audit, before, after) => {
    const [comments, posted] = [before(), after()];
    const outcome = run({ [AUDIT]: audit, [READ]: pages(...comments) });
    expect([outcome.status, outcome.calls, outcome.posts.map((body) => body.replace(/\n+$/, ""))]).toEqual([0, posted === undefined ? [AUDIT, READ] : [AUDIT, READ, POST], posted === undefined ? [] : [posted]]);
  });

  // [name, audit answers, comment read answers, calls made, text the red run prints, whether the audit job's outputs reach the comment job]
  const reds: Array<[string, Outcome[], Outcome[], string[], string, boolean?]> = [
    ["an unreadable audit", [{ code: 1, stdout: "" }], [], [AUDIT], "exited 1: unreadable"],
    ["an unreachable registry", [failure(404)], [], [AUDIT], "exited 1: unreachable"],
    ["transient answers past the retry budget", [failure(503), failure(503), failure(503)], [], [AUDIT, "sleep 30", AUDIT, "sleep 30", AUDIT], "still unavailable after 3 attempts"],
    ["comments that cannot be read", [report(G1)], [{ code: 1, stdout: "" }], [AUDIT, READ], ""],
    ["comments that do not parse", [report(G1)], [{ code: 0, stdout: "[[" }], [AUDIT, READ], ""],
    ["a body the audit job never handed over", [report(G1)], [], [AUDIT], "OVERFLOW_ADVISORY_BODY", false],
  ];
  it.each(reds)("fails red and writes nothing on %s", (_name, audit, comments, calls, printed, handover = true) => {
    const outcome = run({ [AUDIT]: audit, [READ]: comments }, handover);
    expect([outcome.status, outcome.calls, outcome.posts, outcome.output.includes(printed)]).toEqual([1, calls, [], true]);
  });
});
