import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SHIM_DISPATCH,
  cleanupLiveFixture,
  makeFixture,
  readLog,
  runDeploy,
  shimBody,
} from "../support/deploy-revision-harness";

afterEach(cleanupLiveFixture);

const KEY = "OVERFLOW_SKIP_STARTUP_RECONCILIATION";
const MARKER = "OVERFLOW_FIXTURE_ENV_MARKER=loaded\n";

// A string is the file's new content; a command runs in the stub instead.
type Rewrite = string | { run: string };

interface Rewrites {
  afterSwitch?: Rewrite;
  afterActive?: Rewrite;
}

const ENV_FILE = '"$OVERFLOW_DEPLOY_ENV_FILE"';
const REMOVED = { run: `rm ${ENV_FILE}` };
const A_DIRECTORY = { run: `rm ${ENV_FILE} && mkdir ${ENV_FILE}` };
const UNREADABLE = { run: `command -p chmod 000 ${ENV_FILE}` };
const RESTORED = { run: `rm -rf ${ENV_FILE}; echo ${KEY}=1 > ${ENV_FILE}` };

const unreadableBefore = (envFile: string) =>
  `${KEY} could not be read from ${envFile}; whether the immediate startup sweep is skipped on this restart is unknown.`;
const unreadableAfter = (envFile: string) =>
  `${KEY} could not be read from ${envFile}; whether every later restart will skip the immediate startup sweep is unknown.`;
const skipBefore = (envFile: string) =>
  `${KEY}=1 is set in ${envFile}; the immediate startup sweep will be skipped on this restart.`;
const stillSet = (envFile: string) =>
  `${KEY}=1 is still set in ${envFile}; every later restart will also skip the immediate startup sweep until that line is removed.`;

// The stubs rewrite the env file when the deploy reaches release:switch or the is-active check.
async function deployWith(fileLines: string, callerEnv: Record<string, string> = {}, rewrites: Rewrites = {}) {
  const fixture = await makeFixture();
  await appendFile(fixture.envFile, fileLines);
  const rewrite = (name: string) =>
    `if [ -n "\${${name}+x}" ]; then case "$${name}" in '!'*) eval "\${${name}#!}";; *) printf '%s' "$${name}" > "$OVERFLOW_DEPLOY_ENV_FILE";; esac; fi\n`;
  const shims: Record<string, string> = {
    systemctl: shimBody("systemctl", [], `
if [ "$1" = is-active ]; then ${rewrite("SHIM_AFTER_ACTIVE")}fi
printf 'systemctl %s\\n' "$*"
exit 0
`),
    pnpm: shimBody("pnpm", [...SHIM_DISPATCH.pnpm!.envKeys, KEY],
      `if [ "$1" = release:switch ]; then ${rewrite("SHIM_AFTER_SWITCH")}fi\n${SHIM_DISPATCH.pnpm!.dispatch}`),
    node: shimBody("node", [...SHIM_DISPATCH.node!.envKeys, KEY], SHIM_DISPATCH.node!.dispatch),
  };
  for (const [name, body] of Object.entries(shims)) {
    await writeFile(path.join(fixture.bins, name), body);
    await chmod(path.join(fixture.bins, name), 0o755);
  }
  const hookEnv: Record<string, string> = {};
  const hookValue = (rewrite: Rewrite) => (typeof rewrite === "string" ? MARKER + rewrite : `!${rewrite.run}`);
  if (rewrites.afterSwitch !== undefined) hookEnv.SHIM_AFTER_SWITCH = hookValue(rewrites.afterSwitch);
  if (rewrites.afterActive !== undefined) hookEnv.SHIM_AFTER_ACTIVE = hookValue(rewrites.afterActive);
  const result = await runDeploy(fixture, { ...callerEnv, ...hookEnv }, { omitShims: Object.keys(shims) });
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  const lines = result.stdout.split("\n");
  return {
    fixture,
    lines,
    stderr: result.stderr,
    entries: await readLog(fixture.shimLog),
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

  it.each([
    ["added", "", `${KEY}=1\n`],
    ["changed to 1", `${KEY}=0\n`, `${KEY}=1\n`],
  ])("announces a skip line %s in the file after it was first read, and reminds after the restart", async (_label, initial, changed) => {
    const { fixture, lines, restartAt, mentions } = await deployWith(initial, {}, { afterSwitch: changed });
    expect(mentions).toEqual([
      `${KEY}=1 is set in ${fixture.envFile}; the immediate startup sweep will be skipped on this restart.`,
      `${KEY}=1 is still set in ${fixture.envFile}; every later restart will also skip the immediate startup sweep until that line is removed.`,
    ]);
    expect(lines.indexOf(mentions[0]!)).toBeLessThan(restartAt);
  });

  it.each([
    ["removed", `${KEY}=1\n`, "", (envFile: string) => `${KEY} is unset or blank in ${envFile}; the immediate startup sweep will run on this restart.`],
    ["changed to true", `${KEY}=1\n`, `${KEY}=true\n`, (envFile: string) => `${KEY}=true in ${envFile} is not exactly 1, so the immediate startup sweep will run on this restart.`],
  ])("does not report a skip line %s from the file after it was first read", async (_label, initial, changed, expected) => {
    const { fixture, mentions } = await deployWith(initial, {}, { afterSwitch: changed });
    expect(mentions).toEqual([expected(fixture.envFile)]);
  });

  it("takes the reminder from the file as it is once the service is active, not from the announcement", async () => {
    const removed = await deployWith(`${KEY}=1\n`, {}, { afterActive: "" });
    expect(removed.mentions).toEqual([
      `${KEY}=1 is set in ${removed.fixture.envFile}; the immediate startup sweep will be skipped on this restart.`,
    ]);
    await cleanupLiveFixture();
    const added = await deployWith("", {}, { afterActive: `${KEY}=1\n` });
    expect(added.mentions).toEqual([
      `${KEY} is unset or blank in ${added.fixture.envFile}; the immediate startup sweep will run on this restart.`,
      `${KEY}=1 is still set in ${added.fixture.envFile}; every later restart will also skip the immediate startup sweep until that line is removed.`,
    ]);
  });

  it("hands a 1 exported by the caller to the migration-status check, the migrations and the build", async () => {
    const { entries, mentions, fixture } = await deployWith("", { [KEY]: "1" });
    const steps = entries.filter((entry) =>
      (entry.cmd === "node" && entry.args[0] === "scripts/deploy-migration-status.ts")
      || (entry.cmd === "pnpm" && ["db:migrate", "build"].includes(entry.args[0]!)));
    expect(steps.map((entry) => entry.args[0])).toEqual(["scripts/deploy-migration-status.ts", "db:migrate", "build"]);
    expect(steps.map((entry) => entry.env[KEY])).toEqual(["1", "1", "1"]);
    expect(mentions).toEqual([
      `${KEY} is unset or blank in ${fixture.envFile}; the immediate startup sweep will run on this restart.`,
    ]);
  });

  it("deploys when the file expands the variable the caller exported", async () => {
    const { fixture, mentions } = await deployWith(`OTHER=$${KEY}\n`, { [KEY]: "1" });
    expect(mentions).toEqual([
      `${KEY} is unset or blank in ${fixture.envFile}; the immediate startup sweep will run on this restart.`,
    ]);
  });

  it("reports the value of a file that also expands the variable and later sets it", async () => {
    const { fixture, mentions } = await deployWith(`OTHER=$${KEY}\n${KEY}=1\n`, { [KEY]: "0" });
    expect(mentions).toEqual([
      `${KEY}=1 is set in ${fixture.envFile}; the immediate startup sweep will be skipped on this restart.`,
      `${KEY}=1 is still set in ${fixture.envFile}; every later restart will also skip the immediate startup sweep until that line is removed.`,
    ]);
  });

  it("keeps what the file prints out of the reported value, and leaves its stdout on stdout and its errors on stderr", async () => {
    const { fixture, lines, stderr, mentions } = await deployWith(`echo noisy-line\necho noisy-err >&2\n${KEY}=1\n`);
    expect(lines.filter((line) => line === "noisy-line")).toHaveLength(1);
    expect(lines).not.toContain("noisy-err");
    expect(stderr.split("\n").filter((line) => line === "noisy-err")).toHaveLength(3);
    expect(stderr).not.toContain("noisy-line");
    expect(mentions).toEqual([
      `${KEY}=1 is set in ${fixture.envFile}; the immediate startup sweep will be skipped on this restart.`,
      `${KEY}=1 is still set in ${fixture.envFile}; every later restart will also skip the immediate startup sweep until that line is removed.`,
    ]);
  });

  it("reads a value the file builds from its own earlier lines, as the first read does", async () => {
    const { fixture, mentions } = await deployWith("", {}, { afterSwitch: `PREFIX=1\n${KEY}=$(printenv PREFIX)\n` });
    expect(mentions).toEqual([
      `${KEY}=1 is set in ${fixture.envFile}; the immediate startup sweep will be skipped on this restart.`,
      `${KEY}=1 is still set in ${fixture.envFile}; every later restart will also skip the immediate startup sweep until that line is removed.`,
    ]);
  });

  it("finishes the deploy when a file rewritten after the switch fails a command", async () => {
    const { fixture, mentions } = await deployWith("", {}, { afterSwitch: `${KEY}=1\nfalse\n` });
    expect(mentions).toEqual([
      `${KEY}=1 is set in ${fixture.envFile}; the immediate startup sweep will be skipped on this restart.`,
      `${KEY}=1 is still set in ${fixture.envFile}; every later restart will also skip the immediate startup sweep until that line is removed.`,
    ]);
  });

  const FAILED_READS: [string, Rewrite][] = [
    ["exits non-zero", "exit 37\n"],
    ["exits 0 after setting the variable", `${KEY}=1\nexit 0\n`],
    ["defines a printf that exits 0", `printf() { exit 0; }\n${KEY}=1\n`],
    ["is removed", REMOVED],
    ["is replaced by a directory", A_DIRECTORY],
  ];

  it("restarts and reports the file as unreadable at both reports when it exits non-zero on its second source", async () => {
    const { fixture, lines, restartAt, activeAt, mentions } = await deployWith(
      `${KEY}=1\nmkdir "$OVERFLOW_DEPLOY_ENV_FILE.once" || exit 37\n`,
    );
    expect(restartAt).toBeGreaterThan(-1);
    expect(mentions).toEqual([unreadableBefore(fixture.envFile), unreadableAfter(fixture.envFile)]);
    expect(lines.indexOf(mentions[0]!)).toBeLessThan(restartAt);
    expect(lines.indexOf(mentions[1]!)).toBeGreaterThan(activeAt);
  });

  it("restarts and reports the file as unreadable at both reports when it defines an unset that exits 0", async () => {
    const { fixture, restartAt, mentions } = await deployWith(`unset() { exit 0; }\n${KEY}=1\n`);
    expect(restartAt).toBeGreaterThan(-1);
    expect(mentions).toEqual([unreadableBefore(fixture.envFile), unreadableAfter(fixture.envFile)]);
  });

  it.each(FAILED_READS)("restarts and announces the file as unreadable when it %s after it was first read", async (_label, failure) => {
    const { fixture, lines, stderr, restartAt, mentions } = await deployWith(`${KEY}=1\n`, {}, { afterSwitch: failure, afterActive: RESTORED });
    expect(restartAt).toBeGreaterThan(-1);
    expect(mentions).toEqual([unreadableBefore(fixture.envFile), stillSet(fixture.envFile)]);
    expect(lines.indexOf(mentions[0]!)).toBeLessThan(restartAt);
    expect(stderr).not.toMatch(/No such file or directory|is a directory/);
  });

  it.each(FAILED_READS)("reports the file as unreadable after the restart when it %s once the service is active", async (_label, failure) => {
    const { fixture, lines, activeAt, mentions } = await deployWith(`${KEY}=1\n`, {}, { afterActive: failure });
    expect(mentions).toEqual([skipBefore(fixture.envFile), unreadableAfter(fixture.envFile)]);
    expect(lines.indexOf(mentions[1]!)).toBeGreaterThan(activeAt);
  });

  it.skipIf(process.getuid?.() === 0)("reports a file that is present but not readable as unreadable", async () => {
    const { fixture, mentions } = await deployWith(`${KEY}=1\n`, {}, { afterSwitch: UNREADABLE });
    expect(mentions).toEqual([unreadableBefore(fixture.envFile), unreadableAfter(fixture.envFile)]);
  });

  it("reports the value of a file that fails a command when the main shell has inherit_errexit set", async () => {
    const { fixture, mentions } = await deployWith("shopt -s inherit_errexit\n", {}, { afterSwitch: `${KEY}=1\nfalse\n` });
    expect(mentions).toEqual([skipBefore(fixture.envFile), stillSet(fixture.envFile)]);
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
