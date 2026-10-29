import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupLiveFixture,
  makeFixture,
  runDeploy,
  shimBody,
} from "../support/deploy-revision-harness";

afterEach(cleanupLiveFixture);

const KEY = "OVERFLOW_SKIP_STARTUP_RECONCILIATION";

async function deployWith(fileLines: string, callerEnv: Record<string, string> = {}) {
  const fixture = await makeFixture();
  await appendFile(fixture.envFile, fileLines);
  await writeFile(path.join(fixture.bins, "systemctl"), shimBody("systemctl", [], `
printf 'systemctl %s\\n' "$*"
exit 0
`));
  await chmod(path.join(fixture.bins, "systemctl"), 0o755);
  const result = await runDeploy(fixture, callerEnv, { omitShims: ["systemctl"] });
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  const lines = result.stdout.split("\n");
  return {
    fixture,
    lines,
    restartAt: lines.indexOf(`systemctl restart ${fixture.unit}`),
    activeAt: lines.indexOf(`systemctl is-active ${fixture.unit}`),
    mentions: lines.filter((line) => line.includes(KEY)),
  };
}

describe("scripts/deploy-revision.sh — the startup-sweep override", () => {
  it.each([
    ["unset", "", (envFile: string) => `${KEY} is unset or blank in ${envFile}; the immediate startup sweep will run on this restart.`],
    ["blank", `${KEY}=\n`, (envFile: string) => `${KEY} is unset or blank in ${envFile}; the immediate startup sweep will run on this restart.`],
    ["0", `${KEY}=0\n`, (envFile: string) => `${KEY}=0 in ${envFile} is not exactly 1, so the immediate startup sweep will run on this restart.`],
    ["true", `${KEY}=true\n`, (envFile: string) => `${KEY}=true in ${envFile} is not exactly 1, so the immediate startup sweep will run on this restart.`],
    ["a padded 1", `${KEY}=' 1'\n`, (envFile: string) => `${KEY}=\\ 1 in ${envFile} is not exactly 1, so the immediate startup sweep will run on this restart.`],
  ])("states before the restart that the sweep will run when the file has %s, with no reminder after it", async (_label, fileLines, expected) => {
    const { fixture, lines, restartAt, mentions } = await deployWith(fileLines);
    expect(restartAt).toBeGreaterThan(-1);
    expect(mentions).toEqual([expected(fixture.envFile)]);
    expect(lines.indexOf(mentions[0]!)).toBeLessThan(restartAt);
  });

  it.each([
    ["plain", `${KEY}=1\n`],
    ["quoted", `${KEY}="1"\n`],
    ["set again after an earlier 0", `${KEY}=0\n${KEY}=1\n`],
  ])("states before the restart that the sweep will be skipped, and reminds after it, when the file has a %s 1", async (_label, fileLines) => {
    const { fixture, lines, restartAt, activeAt, mentions } = await deployWith(fileLines);
    expect(mentions).toEqual([
      `${KEY}=1 is set in ${fixture.envFile}; the immediate startup sweep will be skipped on this restart.`,
      `${KEY}=1 is still set in ${fixture.envFile}; every later restart will also skip the immediate startup sweep until that line is removed.`,
    ]);
    expect(lines.indexOf(mentions[0]!)).toBeLessThan(restartAt);
    expect(activeAt).toBeGreaterThan(restartAt);
    expect(lines.indexOf(mentions[1]!)).toBeGreaterThan(activeAt);
  });

  it("ignores a 1 exported by the caller when the file does not set it", async () => {
    const { fixture, mentions } = await deployWith("", { [KEY]: "1" });
    expect(mentions).toEqual([
      `${KEY} is unset or blank in ${fixture.envFile}; the immediate startup sweep will run on this restart.`,
    ]);
  });

  it("reports the file's value when the caller exports a different one", async () => {
    const asZero = await deployWith(`${KEY}=0\n`, { [KEY]: "1" });
    expect(asZero.mentions).toEqual([
      `${KEY}=0 in ${asZero.fixture.envFile} is not exactly 1, so the immediate startup sweep will run on this restart.`,
    ]);
    await cleanupLiveFixture();
    const asOne = await deployWith(`${KEY}=1\n`, { [KEY]: "0" });
    expect(asOne.mentions).toHaveLength(2);
    expect(asOne.mentions[0]).toContain("will be skipped on this restart");
  });

  it("is described beside the override in deploy/README.md", async () => {
    const readme = await readFile("deploy/README.md", "utf8");
    const paragraph = readme.split("\n\n").find((block) => block.startsWith("`scripts/deploy-revision.sh` reads the environment file"));
    expect(paragraph, "the README paragraph").toBeDefined();
    for (const phrase of ["Before the restart", "will be skipped", "will run", "not exactly `1`", "reported as still set", "every later restart"]) {
      expect(paragraph!.replace(/\s+/g, " "), phrase).toContain(phrase);
    }
  });
});
