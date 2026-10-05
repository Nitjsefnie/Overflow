import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Behavioral coverage for scripts/db-offhost-backup.sh, which nothing else in
 * the suite executes. Each test runs the real script under /bin/sh with a PATH
 * shim directory in front and the mailbox CLI replaced through
 * OVERFLOW_OFFHOST_MB, so a run records the argv it intended and touches
 * nothing outside its own fixture:
 *
 * - `pg_dump` is a recording stub: it never dials a database. DATABASE_URL
 *   throughout this file names a closed port on loopback with credentials that
 *   exist nowhere, so a run that reached the real client would fail loudly
 *   rather than dump anything.
 * - `xz` and `age` are pass-through recording stubs that each prefix their
 *   input, so the installed file's bytes (`age|xz|<plain>`) prove the data
 *   flowed through both stages, and the argv records prove with what flags.
 * - `find`, `date`, `ln`, `sleep` and `python3` are real: the sweep, the
 *   install, the prune and the 14-day message sweep run their real logic
 *   against fixture files whose mtimes and message timestamps the test set.
 *
 * The safety properties under test are the ones the backup contract rests on:
 * nothing is posted unencrypted (the recipient is validated before anything
 * runs), the size guard never splits a file and leaves the local copy, and the
 * Discord sweep deletes only this job's own messages older than 14 days.
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts", "db-offhost-backup.sh");

/** A syntactically valid age recipient public key, as nothing but a marker. */
const recipient = "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs29ufrs";

/** The dedicated backups channel, numeric as Discord channel ids are. */
const channel = "123456789012345678";

const databaseUrl = "postgresql://backup:synthetic@127.0.0.1:1/overflow_offhost_test";

/** The plain SQL the pg_dump stub writes, as one line for easy size math. */
const defaultDump = "overflow test dump payload\n";

/**
 * The argv the size-guard boundary is computed against: the stubs chain their
 * prefixes, so the installed file is `age|xz|` (7 bytes) plus the dump text.
 */
const stubOverheadBytes = "age|xz|".length;

const dumpShim = [
  "#!/bin/sh",
  `printf '%s\\n' "$@" > "$OFFHOST_TEST_DUMP_ARGV"`,
  `if [ "\${OFFHOST_TEST_DUMP_RC:-0}" -ne 0 ]; then`,
  `  if [ -n "\${OFFHOST_TEST_DUMP_FAILPARTIAL:-}" ]; then`,
  `    printf '%s' "$OFFHOST_TEST_DUMP_OUTPUT"`,
  "  fi",
  `  exit "$OFFHOST_TEST_DUMP_RC"`,
  "fi",
  `if [ -n "\${OFFHOST_TEST_DUMP_EMPTY:-}" ]; then`,
  "  exit 0",
  "fi",
  `printf '%s' "$OFFHOST_TEST_DUMP_OUTPUT"`,
  "",
].join("\n");

const xzShim = [
  "#!/bin/sh",
  `printf '%s\\n' "$@" > "$OFFHOST_TEST_XZ_ARGV"`,
  "{ printf 'xz|'; cat; }",
  "",
].join("\n");

const ageShim = [
  "#!/bin/sh",
  `printf '%s\\n' "$@" > "$OFFHOST_TEST_AGE_ARGV"`,
  "{ printf 'age|'; cat; }",
  "",
].join("\n");

/**
 * The mailbox CLI fake. Every invocation is recorded to the log as its argv,
 * one argument per line, calls separated by a `---` line; behaviour follows
 * the OFFHOST_TEST_MB_* knobs. The connector fake stays alive under its own
 * pid (the script must stop it) and flips the liveness file, which is what
 * turns a failing list-agents probe into a succeeding one.
 */
const mbFake = [
  "#!/bin/sh",
  `printf '%s\\n' "$@" >> "$OFFHOST_TEST_MB_LOG"`,
  `printf -- '---\\n' >> "$OFFHOST_TEST_MB_LOG"`,
  `case "\${1:-}" in`,
  "  list-agents)",
  `    if [ "\${OFFHOST_TEST_MB_LIST_RC:-0}" -ne 0 ]; then`,
  `      if [ -e "\${OFFHOST_TEST_CONNECTOR_LIVE:-/nonexistent}" ]; then`,
  "        exit 0",
  "      fi",
  `      exit "$OFFHOST_TEST_MB_LIST_RC"`,
  "    fi",
  "    exit 0 ;;",
  "  connector)",
  `    printf '%s\\n' "$$" > "\${OFFHOST_TEST_CONNECTOR_PID:-/dev/null}"`,
  `    if [ -z "\${OFFHOST_TEST_MB_CONNECTOR_MUTE:-}" ]; then`,
  `      : > "\${OFFHOST_TEST_CONNECTOR_LIVE:-/dev/null}" 2>/dev/null || :`,
  "    fi",
  // A 300-second body: a connector this run FAILED to stop is still alive
  // however long the reap of a killed one takes, so the process-gone asserts
  // below can only pass on a real kill.
  "    exec /bin/sleep 300 ;;",
  "  send)",
  `    if [ "\${OFFHOST_TEST_MB_SEND_RC:-0}" -ne 0 ]; then exit "$OFFHOST_TEST_MB_SEND_RC"; fi`,
  `    printf 'Sent to nobody: %s (msg_id=1111222233334444555 channel_id=9999888877776666555)\\n' "$4"`,
  "    exit 0 ;;",
  "  conversation)",
  `    if [ -n "\${OFFHOST_TEST_MB_CONVERSATION_JSON:-}" ]; then`,
  `      cat "$OFFHOST_TEST_MB_CONVERSATION_JSON"`,
  "    else",
  "      printf '[]\\n'",
  "    fi",
  "    exit 0 ;;",
  "  message)",
  `    if [ "\${OFFHOST_TEST_MB_DELETE_RC:-0}" -ne 0 ]; then exit "$OFFHOST_TEST_MB_DELETE_RC"; fi`,
  "    exit 0 ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

interface BackupRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every mailbox CLI invocation in call order, each as its argv. */
  mbCalls: string[][];
  dumpArgv: string[] | null;
  xzArgv: string[] | null;
  ageArgv: string[] | null;
  /** The backup path, as the script printed it on its last stdout line. */
  backupPath: string;
  /** The pid the connector fake recorded for itself, when it ran. */
  connectorPid: number | null;
}

/**
 * Fixture trees live until the test has asserted on the files and processes a
 * run left behind, so cleanup happens here rather than inside runBackup.
 */
const runDirectories: string[] = [];

afterEach(() => {
  for (const directory of runDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A killed child is a zombie between its death and its reap, and
 * `process.kill(pid, 0)` answers "exists" for a zombie - so the first
 * observation after the job exits can land inside that window. Poll bounded
 * for the reap: the connector fake sleeps 300 seconds, so an assertion that
 * gives up here can only ever mean the job failed to stop it.
 */
function expectProcessGone(pid: number): void {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`pid ${pid} is still running 5s after the job exited`);
}

function runBackup(
  options: {
    /** The plain SQL the pg_dump stub writes. */
    dumpOutput?: string;
    dumpEmpty?: boolean;
    dumpRc?: number;
    dumpFailPartial?: boolean;
    args?: string[];
    /** The posting limit, as OVERFLOW_BACKUP_MAX_BYTES. */
    maxBytes?: string;
    /** Forces the list-agents liveness probe to fail, driving the bring-up path. */
    listRc?: number;
    sendRc?: number;
    deleteRc?: number;
    /** Makes the connector fake start without flipping the liveness file. */
    connectorMute?: boolean;
    /** The messages the conversation stub answers with, as raw JSON text. */
    conversationJson?: string;
    /**
     * Runs against a backup directory the TEST made and seeded, so the run's
     * sweep and prune can be judged on real files afterwards. Absent: a fresh
     * scratch directory that dies with the run's fixture.
     */
    backupDirectory?: string;
    /** Leaves one of the required variables out of the environment entirely. */
    omit?: "DATABASE_URL" | "OVERFLOW_BACKUP_AGE_RECIPIENT" | "OVERFLOW_BACKUP_DISCORD_CHANNEL";
    recipient?: string;
    channelValue?: string;
  } = {},
): BackupRun & { backupDirectory: string } {
  const directory = mkdtempSync(join(tmpdir(), "overflow-offhost-"));
  runDirectories.push(directory);
  const backupDirectory = options.backupDirectory ?? join(directory, "backups");
  const connectorPidPath = join(directory, "connector-pid");
  {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const shim = (name: string, source: string): void => {
      const path = join(bin, name);
      writeFileSync(path, source);
      chmodSync(path, 0o755);
    };
    shim("pg_dump", dumpShim);
    shim("xz", xzShim);
    shim("age", ageShim);
    const mbPath = join(directory, "mb-fake");
    writeFileSync(mbPath, mbFake);
    chmodSync(mbPath, 0o755);

    const dumpArgvPath = join(directory, "dump-argv");
    const xzArgvPath = join(directory, "xz-argv");
    const ageArgvPath = join(directory, "age-argv");
    const mbLogPath = join(directory, "mb-log");
    const conversationPath = join(directory, "conversation.json");
    if (options.conversationJson !== undefined) {
      writeFileSync(conversationPath, options.conversationJson);
    }

    const childEnv = {
      NODE_ENV: "test" as const,
      DATABASE_URL: databaseUrl,
      OVERFLOW_BACKUP_AGE_RECIPIENT: options.recipient ?? recipient,
      OVERFLOW_BACKUP_DISCORD_CHANNEL: options.channelValue ?? channel,
      OVERFLOW_BACKUP_DIR: backupDirectory,
      OVERFLOW_BACKUP_MAX_BYTES: options.maxBytes ?? "100000000",
      OVERFLOW_OFFHOST_MB: mbPath,
      OVERFLOW_OFFHOST_CONNECTOR_WAIT_SECONDS: "2",
      OFFHOST_TEST_DUMP_ARGV: dumpArgvPath,
      OFFHOST_TEST_DUMP_OUTPUT: options.dumpOutput ?? defaultDump,
      OFFHOST_TEST_DUMP_RC: String(options.dumpRc ?? 0),
      OFFHOST_TEST_DUMP_EMPTY: options.dumpEmpty ? "1" : "",
      OFFHOST_TEST_DUMP_FAILPARTIAL: options.dumpFailPartial ? "1" : "",
      OFFHOST_TEST_XZ_ARGV: xzArgvPath,
      OFFHOST_TEST_AGE_ARGV: ageArgvPath,
      OFFHOST_TEST_MB_LOG: mbLogPath,
      OFFHOST_TEST_CONNECTOR_LIVE: join(directory, "connector-live"),
      OFFHOST_TEST_CONNECTOR_PID: connectorPidPath,
      OFFHOST_TEST_MB_LIST_RC: String(options.listRc ?? 0),
      OFFHOST_TEST_MB_SEND_RC: String(options.sendRc ?? 0),
      OFFHOST_TEST_MB_DELETE_RC: String(options.deleteRc ?? 0),
      OFFHOST_TEST_MB_CONNECTOR_MUTE: options.connectorMute ? "1" : "",
      ...(options.conversationJson !== undefined
        ? { OFFHOST_TEST_MB_CONVERSATION_JSON: conversationPath }
        : {}),
      PATH: `${bin}:/usr/bin:/bin`,
    };
    delete (childEnv as Record<string, unknown>)[options.omit ?? ""];

    const result = spawnSync("/bin/sh", [scriptPath, ...(options.args ?? [])], {
      env: childEnv,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    expect(result.signal, `killed by ${result.signal}: ${result.stderr}`).toBeNull();

    const mbLog = existsSync(mbLogPath) ? readFileSync(mbLogPath, "utf8") : "";
    const mbCalls: string[][] = [];
    let current: string[] = [];
    for (const line of mbLog.split("\n")) {
      if (line === "---") {
        mbCalls.push(current);
        current = [];
        continue;
      }
      if (line.length > 0) current.push(line);
    }

    const readArgv = (path: string): string[] | null =>
      existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(0, -1) : null;

    const stdoutLines = result.stdout.split("\n").filter((line) => line.length > 0);
    const connectorPid = existsSync(connectorPidPath)
      ? Number(readFileSync(connectorPidPath, "utf8").trim())
      : null;

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      mbCalls,
      dumpArgv: readArgv(dumpArgvPath),
      xzArgv: readArgv(xzArgvPath),
      ageArgv: readArgv(ageArgvPath),
      backupPath: stdoutLines.at(-1) ?? "",
      connectorPid: connectorPid !== null && Number.isFinite(connectorPid) ? connectorPid : null,
      backupDirectory,
    };
  }
}

/** The recorded `send` invocations, which a safe run has at most one of. */
function sendCalls(run: BackupRun): string[][] {
  return run.mbCalls.filter((argv) => argv[0] === "send");
}

/** The recorded message deletions, each as its full argv. */
function deleteCalls(run: BackupRun): string[][] {
  return run.mbCalls.filter((argv) => argv[0] === "message" && argv[2] === "delete");
}

/** Seed a file in a directory with an mtime age in days, before a run. */
function seedFile(directory: string, name: string, ageDays: number, content = "x\n"): string {
  const path = join(directory, name);
  writeFileSync(path, content);
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(path, when, when);
  return path;
}

/** The Discord `created` stamp the conversation fixture carries for an age. */
function createdDaysAgo(ageDays: number): string {
  return new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
}

describe("db-offhost-backup.sh environment validation", () => {
  it("refuses to run without DATABASE_URL, before anything runs", () => {
    const run = runBackup({ omit: "DATABASE_URL" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("DATABASE_URL");
    expect(run.dumpArgv, "nothing may be dumped on a refusal").toBeNull();
    expect(run.mbCalls, "and the mailbox must not be touched at all").toEqual([]);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("refuses an %s age recipient before any posting step", (_label, recipientOverride) => {
    const run = runBackup(
      recipientOverride === undefined
        ? { omit: "OVERFLOW_BACKUP_AGE_RECIPIENT" }
        : { recipient: recipientOverride },
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("OVERFLOW_BACKUP_AGE_RECIPIENT");
    expect(run.dumpArgv).toBeNull();
    expect(run.mbCalls, "an unencrypted backup must never be posted").toEqual([]);
  });

  it("refuses a missing Discord channel before any posting step", () => {
    const run = runBackup({ omit: "OVERFLOW_BACKUP_DISCORD_CHANNEL" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("OVERFLOW_BACKUP_DISCORD_CHANNEL");
    expect(run.dumpArgv).toBeNull();
    expect(run.mbCalls).toEqual([]);
  });

  it("refuses a non-numeric channel id", () => {
    const run = runBackup({ channelValue: "backups-chat; rm -rf /" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("OVERFLOW_BACKUP_DISCORD_CHANNEL");
    expect(run.dumpArgv).toBeNull();
    expect(sendCalls(run)).toEqual([]);
  });

  it("refuses a non-numeric posting limit", () => {
    const run = runBackup({ maxBytes: "9.5 MB" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("OVERFLOW_BACKUP_MAX_BYTES");
    expect(run.dumpArgv).toBeNull();
  });

  it("refuses an unexpected argument", () => {
    const run = runBackup({ args: ["--output-dir", "/tmp/nope"] });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("unknown argument");
    expect(run.dumpArgv).toBeNull();
    expect(run.mbCalls).toEqual([]);
  });
});

describe("db-offhost-backup.sh reduced dump", () => {
  /** The 7 tables the reduced set excludes data for, in the contract's order. */
  const excludedTables = [
    "repository_reconciliation_evidence_facts",
    "repository_reconciliation_evidence",
    "webhook_deliveries",
    "repository_policy_violations",
    "repository_reconciliation_dirty_subjects",
    "repository_reconciliation_jobs",
    "repository_reconciliation_usage",
  ];

  it("dumps plain format with exactly the 7 excluded tables and the database url", () => {
    const run = runBackup();

    expect(run.status).toBe(0);
    expect(run.dumpArgv).toEqual([
      "--format=plain",
      ...excludedTables.map((table) => `--exclude-table-data=${table}`),
      databaseUrl,
    ]);
  });

  it("compresses with xz -9e and encrypts to the recipient, in that order", () => {
    const run = runBackup();

    expect(run.status).toBe(0);
    expect(run.xzArgv).toEqual(["-9e"]);
    expect(run.ageArgv).toEqual(["-r", recipient]);
    const installed = statSync(run.backupPath);
    expect(installed.isFile()).toBe(true);
    expect(readFileSync(run.backupPath, "utf8").startsWith("age|xz|")).toBe(true);
    // The mode is the script's business: this file is what leaves the host.
    expect(installed.mode & 0o777).toBe(0o600);
  });

  it("installs the encrypted file under its own name into a 0700 directory", () => {
    const run = runBackup();

    expect(run.status).toBe(0);
    expect(statSync(run.backupDirectory).mode & 0o777).toBe(0o700);
    expect(basename(run.backupPath)).toMatch(/^overflow-reduced-\d{8}T\d{6}Z\.sql\.xz\.age$/);
  });

  it("refuses an empty dump before compressing or posting anything", () => {
    const run = runBackup({ dumpEmpty: true });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("empty");
    expect(run.xzArgv, "no compression of an empty dump").toBeNull();
    expect(run.ageArgv, "no encryption of an empty dump").toBeNull();
    expect(sendCalls(run), "and no post").toEqual([]);
  });

  it("propagates a pg_dump failure as a nonzero exit", () => {
    const run = runBackup({ dumpRc: 1, dumpFailPartial: true });

    expect(run.status).not.toBe(0);
    expect(run.xzArgv).toBeNull();
    expect(sendCalls(run)).toEqual([]);
  });
});

describe("db-offhost-backup.sh size guard", () => {
  /** The installed file's size for a given dump payload, under the stub chain. */
  const installedSize = (dump: string): number => stubOverheadBytes + Buffer.byteLength(dump);

  it("posts nothing when the encrypted file is exactly at the limit, keeping the local copy", () => {
    const dump = "0123456789";
    const run = runBackup({ dumpOutput: dump, maxBytes: String(installedSize(dump)) });

    expect(run.status, "the guard trips as a failure so OnFailure alerts").not.toBe(0);
    expect(run.stderr).toContain("posting limit");
    expect(sendCalls(run), "a file at the limit must not be posted").toEqual([]);
    // The local encrypted file stays: it is a good local copy.
    expect(run.backupPath).toBe("");
    expect(readdirSync(run.backupDirectory)).toEqual([
      expect.stringMatching(/^overflow-reduced-\d{8}T\d{6}Z\.sql\.xz\.age$/),
    ]);
  });

  it("posts when the encrypted file is one byte under the limit", () => {
    const dump = "0123456789";
    const run = runBackup({ dumpOutput: dump, maxBytes: String(installedSize(dump) + 1) });

    expect(run.status).toBe(0);
    expect(sendCalls(run), "one byte under the limit posts").toHaveLength(1);
    expect(run.backupPath).not.toBe("");
  });
});

describe("db-offhost-backup.sh local retention", () => {
  it("prunes reduced backups older than 14 days and only those", () => {
    const directory = mkdtempSync(join(tmpdir(), "overflow-offhost-prune-"));
    try {
      const backupDirectory = join(directory, "backups");
      mkdirSync(backupDirectory);
      const oldReduced = seedFile(
        backupDirectory,
        "overflow-reduced-20260901T000000Z.sql.xz.age",
        20,
      );
      const freshReduced = seedFile(
        backupDirectory,
        "overflow-reduced-20260929T000000Z.sql.xz.age",
        1,
      );
      const oldFullDump = seedFile(backupDirectory, "overflow-20260901T000000Z.dump", 20);
      const unrelated = seedFile(backupDirectory, "notes.txt", 20);

      const run = runBackup({ backupDirectory });

      expect(run.status).toBe(0);
      expect(existsSync(oldReduced), "a reduced backup past 14 days is pruned").toBe(false);
      expect(existsSync(freshReduced), "a fresh reduced backup stays").toBe(true);
      expect(existsSync(oldFullDump), "the full backup's files are not ours to delete").toBe(true);
      expect(existsSync(unrelated), "nothing else is ours to delete").toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sweeps leftover partials older than 24 hours, keeping fresh ones", () => {
    const directory = mkdtempSync(join(tmpdir(), "overflow-offhost-sweep-"));
    try {
      const backupDirectory = join(directory, "backups");
      mkdirSync(backupDirectory);
      const stalePartial = seedFile(
        backupDirectory,
        ".overflow-reduced-20260901T000000Z.sql.xz.age.incomplete",
        2,
      );
      const freshPartial = seedFile(
        backupDirectory,
        ".overflow-reduced-20260930T000000Z.sql.xz.age.incomplete",
        1 / 24,
      );

      const run = runBackup({ backupDirectory });

      expect(run.status).toBe(0);
      expect(existsSync(stalePartial), "a partial past 24 hours is swept").toBe(false);
      expect(existsSync(freshPartial), "a fresh partial stays").toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("db-offhost-backup.sh discord posting", () => {
  it("posts exactly once, as osc, to the channel, with the file attached and --wait", () => {
    const run = runBackup();
    const calls = sendCalls(run);

    expect(run.status).toBe(0);
    expect(calls, "exactly one send").toHaveLength(1);
    const [subject, body, attachFlag, attachedPath, channelFlag, channelValue, waitFlag] =
      calls[0]!.slice(3);
    expect(calls[0]!.slice(0, 3)).toEqual(["send", "osc", "nobody"]);
    expect(subject).toBe(basename(run.backupPath));
    expect(attachFlag).toBe("--attach");
    expect(attachedPath).toBe(run.backupPath);
    expect(channelFlag).toBe("--channel");
    expect(channelValue).toBe(channel);
    expect(waitFlag).toBe("--wait");
    const size = statSync(run.backupPath).size;
    expect(body).toBe(`${subject} ${size} bytes ${new Date().toISOString().slice(0, 10)}`);
    expect(body, "the recipient key is not part of the message").not.toContain(recipient);
  });

  it("prints the sent line and ends stdout with the installed path", () => {
    const run = runBackup();

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("msg_id=");
    expect(run.stdout.trimEnd().endsWith(run.backupPath)).toBe(true);
  });

  it("brings up its own osc connector when none is running, and stops it afterwards", () => {
    const run = runBackup({ listRc: 1 });
    const connectorCalls = run.mbCalls.filter((argv) => argv[0] === "connector");

    expect(run.status).toBe(0);
    expect(connectorCalls, "one connector for the job").toHaveLength(1);
    expect(connectorCalls[0]!.slice(0, 2)).toEqual(["connector", "osc"]);
    expect(connectorCalls[0]![2]).toBe("--claude-pid");
    expect(connectorCalls[0]![3], "the pid is the job's own, as a number").toMatch(/^\d+$/);
    expect(sendCalls(run)).toHaveLength(1);

    // The connector is gone: the script killed the pid it started, rather than
    // leaving a gateway process behind. The pid asserted is the one the fake
    // recorded for itself - the same process the script was handed by $!.
    expect(run.connectorPid).not.toBeNull();
    expectProcessGone(run.connectorPid!);
  });

  it("fails without posting when the connector never comes up", () => {
    const run = runBackup({ listRc: 1, connectorMute: true });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("connector");
    expect(sendCalls(run), "no post through a connector that is not up").toEqual([]);
    expect(run.connectorPid).not.toBeNull();
    expectProcessGone(run.connectorPid!);
  });

  it("propagates a failed send as a nonzero exit", () => {
    const run = runBackup({ sendRc: 1 });

    expect(run.status).not.toBe(0);
    expect(sendCalls(run)).toHaveLength(1);
  });

  it("deletes only its own osc-authored messages older than 14 days", () => {
    const stale = "1111111111111111111";
    const thirteenDays = "2222222222222222222";
    const otherAuthor = "3333333333333333333";
    const fresh = "4444444444444444444";
    const conversationJson = JSON.stringify([
      { msg_id: stale, from: "osc", created: createdDaysAgo(20) },
      { msg_id: thirteenDays, from: "osc", created: createdDaysAgo(13) },
      { msg_id: otherAuthor, from: "backup-bot", created: createdDaysAgo(30) },
      { msg_id: fresh, from: "osc", created: createdDaysAgo(0) },
    ]);

    const run = runBackup({ conversationJson });

    expect(run.status).toBe(0);
    const sweep = run.mbCalls.filter((argv) => argv[0] === "conversation");
    expect(sweep, "one page, generously sized, json, in the backups channel").toEqual([
      ["conversation", "osc", "100", "--channel", channel, "--json"],
    ]);
    expect(deleteCalls(run)).toEqual([
      ["message", "osc", "delete", stale, "--channel", channel],
    ]);
  });

  it("propagates a failed sweep deletion as a nonzero exit", () => {
    const run = runBackup({
      conversationJson: JSON.stringify([
        { msg_id: "1111111111111111111", from: "osc", created: createdDaysAgo(20) },
      ]),
      deleteRc: 1,
    });

    expect(run.status).not.toBe(0);
    expect(deleteCalls(run), "the deletion was attempted").toHaveLength(1);
  });
});
