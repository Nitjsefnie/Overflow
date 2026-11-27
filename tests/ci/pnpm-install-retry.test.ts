import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { parse } from "yaml";
import { runBoundedScript } from "../support/bounded-script";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

type Step = { name?: string; run?: string };
const tempDirectories = createOwnedTempDirectoryRegistry(join(tmpdir(), "pnpm-install-retry-"));
afterAll(() => tempDirectories.dispose());

// Every step installing pnpm, found by what it runs in any workflow, so a dropped or added copy reds the first test.
const installs = readdirSync(resolve(".github/workflows")).sort().flatMap((file) =>
  Object.entries((parse(readFileSync(resolve(".github/workflows", file), "utf8")) as { jobs: Record<string, { steps?: Step[] }> }).jobs)
    .flatMap(([job, { steps = [] }]) => steps.filter((step) => step.run?.includes("corepack install")).map((step) => ({ where: `${file} ${job}`, step }))));

// Each stub exits 125 on a call it does not model; the corepack stub answers each install with the next scripted exit code.
const STUBS = {
  corepack: 'if [ "$*" = enable ]; then exit 0; fi\nif [ "$#" -eq 3 ] && [ "$1 $2" = "install --global" ]; then\n'
    + '  n=$(( $(cat "$STUB_DIR/attempts") + 1 )); echo "$n" > "$STUB_DIR/attempts"\n  code=$(sed -n "${n}p" "$STUB_DIR/outcomes"); exit "${code:-125}"\nfi\nexit 125',
  pnpm: 'if [ "$*" = --version ]; then touch "$STUB_DIR/pnpm-ran"; exit 0; fi\nexit 125',
  sleep: 'if [ "$#" -eq 1 ]; then echo "$1" >> "$STUB_DIR/sleeps"; exit 0; fi\nexit 125',
};

function runInstall(run: string, outcomes: number[]) {
  const home = tempDirectories.create(), bin = join(home, "bin"), at = (name: string) => join(home, name);
  mkdirSync(bin);
  for (const [name, body] of [["attempts", "0"], ["outcomes", `${outcomes.join("\n")}\n`], ["sleeps", ""], ["step.sh", run]]) writeFileSync(at(name!), body!);
  for (const [name, body] of Object.entries(STUBS)) writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  // Actions' default shell for a run step.
  const result = runBoundedScript(["bash", "--noprofile", "--norc", "-eo", "pipefail", at("step.sh")], home, { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: home }, 60_000);
  return { ok: result.status === 0, attempts: Number(readFileSync(at("attempts"), "utf8")), sleeps: readFileSync(at("sleeps"), "utf8").split("\n").filter((line) => line !== ""),
    pnpmRan: existsSync(at("pnpm-ran")), annotated: /^::error::\S/m.test(result.stdout) };
}

it("installs pnpm in exactly these seven jobs, each in its one named setup step", () => {
  expect(installs.map(({ where, step }) => `${where}: ${step.name}`)).toEqual(["advisory-tracking.yml advisory-audit", "ci.yml test", "ci.yml verify", "dependency-audit.yml dependency-audit",
    "pr-gates.yml dependency-audit", "pr-suite.yml test", "pr-suite.yml suite"].map((where) => `${where}: Enable the pinned package manager`));
});

const delays = new Set<string>();
it.each([[[0], 1, true], [[1, 0], 2, true], [[1, 1, 0], 3, true], [[1, 1, 1], 3, false]] as const)("install exits %j: %i attempts, pnpm ready %s, in every install step", (outcomes, attempts, installed) => {
  for (const { where, step } of installs) {
    const { sleeps, ...observed } = runInstall(step.run!, [...outcomes]);
    sleeps.forEach((delay) => delays.add(delay));
    // A sleep between attempts and none after the last; an annotation only when the job stops.
    expect({ ...observed, sleeps: sleeps.length }, where).toEqual({ ok: installed, attempts, sleeps: attempts - 1, pnpmRan: installed, annotated: !installed });
    expect([...delays], `${where}: every pause is one positive whole-second delay`).toEqual([...delays].filter((delay) => /^[1-9]\d*$/.test(delay)).slice(0, 1));
  }
});
