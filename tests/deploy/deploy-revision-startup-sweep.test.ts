import { existsSync } from "node:fs";
import { appendFile, chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SHIM_DISPATCH,
  type ShimLogEntry,
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
  seam?: string; // a script BASH_ENV loads into every bash the deploy starts
}

const ENV_FILE = '"$OVERFLOW_DEPLOY_ENV_FILE"';
const REMOVED = { run: `rm ${ENV_FILE}` };
const A_DIRECTORY = { run: `rm ${ENV_FILE} && mkdir ${ENV_FILE}` };
const UNREADABLE = { run: `command -p chmod 000 ${ENV_FILE}` };
const RESTORED = { run: `rm -rf ${ENV_FILE}; echo ${KEY}=1 > ${ENV_FILE}` };
const STEP_KEYS = [KEY, "PRICE", "DSN", "OTHER"];

const unreadableBefore = (envFile: string) =>
  `${KEY} could not be read from ${envFile}; whether the immediate startup sweep is skipped on this restart is unknown.`;
const unreadableAfter = (envFile: string) =>
  `${KEY} could not be read from ${envFile}; whether every later restart will skip the immediate startup sweep is unknown.`;
const skipBefore = (envFile: string) =>
  `${KEY}=1 is set in ${envFile}; the immediate startup sweep will be skipped on this restart.`;
const stillSet = (envFile: string) =>
  `${KEY}=1 is still set in ${envFile}; every later restart will also skip the immediate startup sweep until that line is removed.`;
const unsetBefore = (envFile: string) => `${KEY} is unset or blank in ${envFile}; the immediate startup sweep will run on this restart.`;
const notOne = (quoted: string, envFile: string) =>
  `${KEY}=${quoted} in ${envFile} is not exactly 1, so the immediate startup sweep will run on this restart.`;
// Both reports for a file whose value is `quoted` (printf %q form): 1 skips and reminds, "" is unset or blank.
const reported = (quoted: string, envFile: string) =>
  quoted === "1" ? [skipBefore(envFile), stillSet(envFile)] : [quoted === "" ? unsetBefore(envFile) : notOne(quoted, envFile)];

// The deploy's own steps that read the file's variables: the migration-status check, the migrations and the build.
const steps = (entries: ShimLogEntry[]) => entries.filter((entry) =>
  (entry.cmd === "node" && entry.args[0] === "scripts/deploy-migration-status.ts") || (entry.cmd === "pnpm" && ["db:migrate", "build"].includes(entry.args[0]!)));

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
    pnpm: shimBody("pnpm", [...SHIM_DISPATCH.pnpm!.envKeys, ...STEP_KEYS],
      `if [ "$1" = release:switch ]; then ${rewrite("SHIM_AFTER_SWITCH")}fi\n${SHIM_DISPATCH.pnpm!.dispatch}`),
    node: shimBody("node", [...SHIM_DISPATCH.node!.envKeys, ...STEP_KEYS], SHIM_DISPATCH.node!.dispatch),
  };
  for (const [name, body] of Object.entries(shims)) {
    await writeFile(path.join(fixture.bins, name), body);
    await chmod(path.join(fixture.bins, name), 0o755);
  }
  const hookEnv: Record<string, string> = {};
  const hookValue = (rewrite: Rewrite) => (typeof rewrite === "string" ? MARKER + rewrite : `!${rewrite.run}`);
  if (rewrites.afterSwitch !== undefined) hookEnv.SHIM_AFTER_SWITCH = hookValue(rewrites.afterSwitch);
  if (rewrites.afterActive !== undefined) hookEnv.SHIM_AFTER_ACTIVE = hookValue(rewrites.afterActive);
  if (rewrites.seam !== undefined) await writeFile(hookEnv.BASH_ENV = path.join(fixture.dir, "seam.sh"), rewrites.seam);
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
  // [label, file at the first read, rewrite after the switch (both reports read it), the value's %q form]
  const FILES: [string, string, string | undefined, string][] = [
    ["unset", "", undefined, ""],
    ["blank", `${KEY}=\n`, undefined, ""],
    ["0", `${KEY}=0\n`, undefined, "0"],
    ["true", `${KEY}=true\n`, undefined, "true"],
    ["a padded 1", `${KEY}=' 1'\n`, undefined, "\\ 1"],
    ["a plain 1", `${KEY}=1\n`, undefined, "1"],
    ["a quoted 1", `${KEY}="1"\n`, undefined, "1"],
    ["a 1 set again after an earlier 0", `${KEY}=0\n${KEY}=1\n`, undefined, "1"],
    ["a 1 and a mkdir that exits non-zero when run again", `${KEY}=1\nmkdir "$OVERFLOW_DEPLOY_ENV_FILE.once" || exit 37\n`, undefined, "1"],
    ["a 1 and an unset that exits 0", `unset() { exit 0; }\n${KEY}=1\n`, undefined, "1"],
    ["a skip line added after the first read", "", `${KEY}=1\n`, "1"],
    ["a 0 changed to 1 after the first read", `${KEY}=0\n`, `${KEY}=1\n`, "1"],
    ["a 1 removed after the first read", `${KEY}=1\n`, "", ""],
    ["a 1 changed to true after the first read", `${KEY}=1\n`, `${KEY}=true\n`, "true"],
    ["a value of 1 and a newline", "", `${KEY}="1\n"\n`, "$'1\\n'"],
    ["a trap function", "", `trap() { return 42; }\n${KEY}=1\n`, "1"],
    ["an EXIT trap and an exit 0", "", `trap ':' EXIT\n${KEY}=1\nexit 0\n`, "1"],
    ["a printf function", "", `printf() { return 42; }\n${KEY}=1\n`, "1"],
    ["a printf function that exits 0", "", `printf() { exit 0; }\n${KEY}=1\n`, "1"],
    ["set -e and a failing command before a marker", "", `set -e\n${KEY}=1\nfalse\ntouch "$OVERFLOW_DEPLOY_ENV_FILE.ran"\n`, "1"],
    ["a failing command", "", `${KEY}=1\nfalse\n`, "1"],
    ["an exit 0 after setting it", "", `${KEY}=1\nexit 0\n`, "1"],
    ["an exit 37", "", "exit 37\n", ""],
    ["a loop that never ends", "", "while :; do :; done\n", ""],
    ["a trailing comment", "", `${KEY}=1 # note\n`, "1\\ #\\ note"],
    ["a command substitution", "", `${KEY}=$(printf 1)\n`, "\\$\\(printf\\ 1\\)"],
    ["a command substitution of an earlier line's value", "", `PREFIX=1\n${KEY}=$(printenv PREFIX)\n`, "\\$\\(printenv\\ PREFIX\\)"],
    ["single quotes", "", `${KEY}='1'\n`, "1"],
    ["a line continuation", "", `${KEY}=\\\n1\n`, "1"],
    ["the line commented out by #", "", `#${KEY}=1\n`, ""],
    ["the line commented out by ;", "", `;${KEY}=1\n`, ""],
    ["a # comment whose quote opens nothing", "", `#a="\n${KEY}=0\n`, "0"],
    ["a ; comment whose quote opens nothing", "", `;a="\n${KEY}=0\n`, "0"],
    ["names systemd drops as invalid, at the first read too", `export ${KEY}=1\n9${KEY}=1\n${KEY}-X=1\n`, undefined, ""],
    ["spaces around = and after the value", "", `${KEY} = 1 \t\n`, "1"],
    ["a backslash inside double quotes", "", `${KEY}="\\1"\n`, "\\\\1"],
    ["no final newline", "", `${KEY}=1`, "1"],
    ["a double quote left open at the end", "", `${KEY}="1\n`, "$'1\\n'"],
    ["CRLF line ends", "", `${KEY}=1\r\nOTHER=2\r\n`, "1"],
    ["the line inside another variable's double-quoted value", "", `OTHER="a\n${KEY}=1\n"\n`, ""],
  ];

  it.each(FILES)("reports, before the restart and once active, what systemd's EnvironmentFile= takes from a file with %s", async (_label, initial, afterSwitch, quoted) => {
    const { fixture, lines, restartAt, activeAt, mentions } = await deployWith(initial, {}, { afterSwitch });
    expect(restartAt).toBeGreaterThan(-1);
    expect(activeAt).toBeGreaterThan(restartAt);
    expect(mentions).toEqual(reported(quoted, fixture.envFile));
    expect(lines.indexOf(mentions[0]!)).toBeLessThan(restartAt);
    if (mentions[1]) expect(lines.indexOf(mentions[1])).toBeGreaterThan(activeAt);
    expect(existsSync(`${fixture.envFile}.ran`), "the marker after a failing command").toBe(false);
  });

  it("ignores a 1 exported by the caller when the file does not set it", async () => {
    const { fixture, mentions } = await deployWith("", { [KEY]: "1" });
    expect(mentions).toEqual([unsetBefore(fixture.envFile)]);
  });

  it("reports the file's value when the caller exports a different one", async () => {
    const asZero = await deployWith(`${KEY}=0\n`, { [KEY]: "1" });
    expect(asZero.mentions).toEqual([notOne("0", asZero.fixture.envFile)]);
    await cleanupLiveFixture();
    const asOne = await deployWith(`${KEY}=1\n`, { [KEY]: "0" });
    expect(asOne.mentions).toHaveLength(2);
    expect(asOne.mentions[0]).toContain("will be skipped on this restart");
  });

  it("takes the reminder from the file as it is once the service is active, not from the announcement", async () => {
    const removed = await deployWith(`${KEY}=1\n`, {}, { afterActive: "" });
    expect(removed.mentions).toEqual([skipBefore(removed.fixture.envFile)]);
    await cleanupLiveFixture();
    const added = await deployWith("", {}, { afterActive: `${KEY}=1\n` });
    expect(added.mentions).toEqual([unsetBefore(added.fixture.envFile), stillSet(added.fixture.envFile)]);
  });

  it("hands a 1 exported by the caller to the migration-status check, the migrations and the build", async () => {
    const { entries, mentions, fixture } = await deployWith("", { [KEY]: "1" });
    expect(steps(entries).map((entry) => entry.args[0])).toEqual(["scripts/deploy-migration-status.ts", "db:migrate", "build"]);
    expect(steps(entries).map((entry) => entry.env[KEY])).toEqual(["1", "1", "1"]);
    expect(mentions).toEqual([unsetBefore(fixture.envFile)]);
  });

  it("deploys when the file names the variable the caller exported", async () => {
    const { fixture, mentions } = await deployWith(`OTHER=$${KEY}\n`, { [KEY]: "1" });
    expect(mentions).toEqual([unsetBefore(fixture.envFile)]);
  });

  it("reports the value of a file that also names the variable and later sets it", async () => {
    const { fixture, mentions } = await deployWith(`OTHER=$${KEY}\n${KEY}=1\n`, { [KEY]: "0" });
    expect(mentions).toEqual(reported("1", fixture.envFile));
  });

  it("never runs the file: what its lines would print reaches neither stream", async () => {
    const { fixture, lines, stderr, mentions } = await deployWith(`echo noisy-line\necho noisy-err >&2\n${KEY}=1\n`);
    expect(`${lines.join("\n")}\n${stderr}`).not.toMatch(/noisy-(line|err)/);
    expect(mentions).toEqual(reported("1", fixture.envFile));
  });

  it.each([
    ["no expansion of a set name", "PRICE=5$HOME\n", "PRICE", "5$HOME"],
    ["no abort on an unset name", "DSN=pa$OVERFLOW_FIXTURE_UNSET\n", "DSN", "pa$OVERFLOW_FIXTURE_UNSET"],
    ["the text after a closing quote", `OTHER="ab" #c\n`, "OTHER", "ab#c"],
  ])("hands the deploy's own steps the file's value as systemd reads it, over the caller's, with %s", async (_label, line, name, value) => {
    const { entries } = await deployWith(line, { [name]: "caller" });
    expect(steps(entries).map((entry) => entry.env[name])).toEqual([value, value, value]);
  });

  it("refuses the deploy before the migration-status check when the first read cannot read the file", async () => {
    const fixture = await makeFixture();
    await rm(fixture.envFile);
    const result = await runDeploy(fixture);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`Could not read the environment file ${fixture.envFile}`);
    expect(steps(await readLog(fixture.shimLog))).toEqual([]);
  });

  const FAILED_READS: [string, Rewrite][] = [
    ["is removed", REMOVED],
    ["is replaced by a directory", A_DIRECTORY],
    ["is replaced by a pipe nobody writes", { run: `rm ${ENV_FILE} && mkfifo ${ENV_FILE}` }],
  ];
  const FAST_DEADLINE = { OVERFLOW_DEPLOY_ENV_READ_TIMEOUT: "1" };

  it.each(FAILED_READS)("restarts and announces the file as unreadable when it %s after it was first read", async (_label, failure) => {
    const { fixture, lines, stderr, restartAt, mentions } = await deployWith(`${KEY}=1\n`, FAST_DEADLINE, { afterSwitch: failure, afterActive: RESTORED });
    expect(restartAt).toBeGreaterThan(-1);
    expect(mentions).toEqual([unreadableBefore(fixture.envFile), stillSet(fixture.envFile)]);
    expect(lines.indexOf(mentions[0]!)).toBeLessThan(restartAt);
    expect(stderr).not.toMatch(/No such file or directory|is a directory/);
  });

  it.each(FAILED_READS)("reports the file as unreadable after the restart when it %s once the service is active", async (_label, failure) => {
    const { fixture, lines, activeAt, mentions } = await deployWith(`${KEY}=1\n`, FAST_DEADLINE, { afterActive: failure });
    expect(mentions).toEqual([skipBefore(fixture.envFile), unreadableAfter(fixture.envFile)]);
    expect(lines.indexOf(mentions[1]!)).toBeGreaterThan(activeAt);
  });

  it("announces as unreadable, at both reports, a file removed between deciding to read it and opening it", async () => {
    // Armed after the switch: removes the file right after the old helper's -r check answers, and right before the new read opens it.
    const seam = `armed() { [[ -e $OVERFLOW_DEPLOY_ENV_FILE.armed ]]; }
[() { builtin [ "\${@:1:$#-1}" ]; local rc=$?; if [[ \${1-} == -r && \${2-} == "$OVERFLOW_DEPLOY_ENV_FILE" ]] && armed; then rm -f -- "$2"; fi; return $rc; }
timeout() { if [[ \${!#} == "$OVERFLOW_DEPLOY_ENV_FILE" ]] && armed; then rm -f -- "\${!#}"; fi; command timeout "$@"; }
`;
    const { fixture, lines, stderr, restartAt, activeAt, mentions } = await deployWith(`${KEY}=1\n`, {}, { seam, afterSwitch: { run: `touch ${ENV_FILE}.armed` }, afterActive: RESTORED });
    expect(restartAt).toBeGreaterThan(-1);
    expect(mentions).toEqual([unreadableBefore(fixture.envFile), unreadableAfter(fixture.envFile)]);
    expect(lines.indexOf(mentions[0]!)).toBeLessThan(restartAt);
    expect(lines.indexOf(mentions[1]!)).toBeGreaterThan(activeAt);
    expect(stderr).not.toMatch(/No such file or directory/);
  });

  it.skipIf(process.getuid?.() === 0)("reports a file that is present but not readable as unreadable", async () => {
    const { fixture, mentions } = await deployWith(`${KEY}=1\n`, {}, { afterSwitch: UNREADABLE });
    expect(mentions).toEqual([unreadableBefore(fixture.envFile), unreadableAfter(fixture.envFile)]);
  });
});
