import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Behavioral coverage for scripts/overflow-alert.sh, which nothing else in the
 * suite executes (the deploy suites read only its path out of the alert unit's
 * ExecStart=). Each test runs the real script under /bin/sh with a PATH shim
 * directory in front: a recording curl that never touches a network, a
 * journalctl stub, and a fixed hostname, so the headers are deterministic and
 * no mail can leave the machine.
 *
 * The recipient path is overridden through OVERFLOW_ALERT_RECIPIENT_FILE
 * because /etc/overflow/alert-recipient is root-only host configuration: a
 * suite that wrote it would mutate the host it runs on, and CI's runner user
 * cannot write /etc at all. The alert unit sets no such variable, so the
 * deployed path is always the default.
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts", "overflow-alert.sh");
const fqdn = "alert.test.example";
const recipientAddress = "ops@example.test";

/** The exact send contract: the recorded curl argv, in order. */
const expectedCurlArgv = [
  "-sS",
  "--max-time",
  "30",
  "--connect-timeout",
  "5",
  "--url",
  "smtp://127.0.0.1:25",
  "--mail-from",
  `overflow-alert@${fqdn}`,
  "--mail-rcpt",
  recipientAddress,
  "--upload-file",
  "-",
];

const curlShim = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$@" > "$OVERFLOW_TEST_CURL_ARGV"',
  'cat > "$OVERFLOW_TEST_MAIL"',
  "exit ${FAKE_CURL_RC:-0}",
  "",
].join("\n");

const journalctlShim = [
  "#!/bin/sh",
  'if [ "${FAKE_JOURNALCTL_RC:-0}" -ne 0 ]; then',
  '  exit "$FAKE_JOURNALCTL_RC"',
  "fi",
  "echo journal-stub-line-1",
  "echo journal-stub-line-2",
  "",
].join("\n");

const hostnameShim = `#!/bin/sh\necho ${fqdn}\n`;

interface AlertRun {
  status: number | null;
  stderr: string;
  /** Whether the run reached the send stage at all. */
  sent: boolean;
  /** The recorded curl argv, present only when the run sent. */
  argv: string[];
  mail: string;
}

/**
 * State directories shared across several runAlert calls of one test, removed
 * after each test. A run without an explicit stateDir gets a scratch directory
 * that dies with its run's fixture, so a test that inspects the recorded state
 * after a run — or drives two runs against one state directory — asks for one
 * of these instead.
 */
const sharedStateDirs: string[] = [];

afterEach(() => {
  for (const directory of sharedStateDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A scratch throttle state directory that outlives one test's runAlert calls. */
function makeStateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "overflow-alert-state-"));
  sharedStateDirs.push(directory);
  return directory;
}

/** Pre-seeds the throttle state file for a unit with a recorded send time. */
function seedState(stateDir: string, unit: string, timestamp: number): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, unit), `${timestamp}\n`);
}

function runAlert(
  options: {
    recipient?: string;
    args?: string[];
    curlStatus?: number;
    journalStatus?: number;
    /**
     * The throttle state directory to hand the script through
     * OVERFLOW_ALERT_STATE_DIR. Absent: a scratch directory inside this run's
     * fixture, so a run whose state nobody inspects touches nothing shared.
     */
    stateDir?: string;
  } = {},
): AlertRun {
  const directory = mkdtempSync(join(tmpdir(), "overflow-alert-"));

  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const shim = (name: string, source: string): void => {
      const path = join(bin, name);
      writeFileSync(path, source);
      chmodSync(path, 0o755);
    };
    shim("curl", curlShim);
    shim("journalctl", journalctlShim);
    shim("hostname", hostnameShim);

    const recipientFile = join(directory, "alert-recipient");
    if (options.recipient !== undefined) writeFileSync(recipientFile, options.recipient);

    const curlArgvPath = join(directory, "curl-argv");
    const mailPath = join(directory, "mail.eml");
    const stateDir = options.stateDir ?? join(directory, "throttle-state");

    const result = spawnSync(
      "/bin/sh",
      [scriptPath, ...(options.args ?? ["overflow.service"])],
      {
        env: {
          NODE_ENV: "test",
          PATH: `${bin}:/usr/bin:/bin`,
          OVERFLOW_ALERT_RECIPIENT_FILE: recipientFile,
          OVERFLOW_ALERT_STATE_DIR: stateDir,
          OVERFLOW_TEST_CURL_ARGV: curlArgvPath,
          OVERFLOW_TEST_MAIL: mailPath,
          FAKE_CURL_RC: String(options.curlStatus ?? 0),
          FAKE_JOURNALCTL_RC: String(options.journalStatus ?? 0),
        },
        encoding: "utf8",
      },
    );
    if (result.error) throw result.error;
    expect(result.signal, `killed by ${result.signal}: ${result.stderr}`).toBeNull();

    // Read the shims' captures before the fixture directory is removed.
    const sent = existsSync(curlArgvPath);
    return {
      status: result.status,
      stderr: result.stderr,
      sent,
      argv: sent ? readFileSync(curlArgvPath, "utf8").split("\n").slice(0, -1) : [],
      mail: existsSync(mailPath) ? readFileSync(mailPath, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The valid single-line recipient every send-path test starts from. */
const validRecipient = `${recipientAddress}\n`;

describe("overflow-alert.sh argument contract", () => {
  it.each([
    ["no", []],
    ["two", ["overflow.service", "extra"]],
  ])("exits 2 with the usage line on %s arguments and never sends", (_label, args) => {
    const run = runAlert({ recipient: validRecipient, args });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage: overflow-alert.sh <failed-unit>");
    expect(run.sent, "the send stage must not be reached").toBe(false);
  });
});

describe("overflow-alert.sh recipient validation", () => {
  // Every refusal exits 2 naming the file, and none reaches the send stage.
  it.each([
    ["missing", undefined, "is missing or unreadable"],
    ["empty", "", "is empty"],
    ["no @", "bare-host.example\n", "carries no @"],
    ["two lines", `${recipientAddress}\ninjected@example.test\n`, "carries more than one line"],
    ["a carriage return", `${recipientAddress}\rinjected`, "carries more than one line"],
  ])("refuses a recipient file with %s: exits 2 naming the file", (_label, recipient, message) => {
    const run = runAlert({ recipient });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.sent, "the send stage must not be reached").toBe(false);
  });
});

describe("overflow-alert.sh send stage", () => {
  it("hands curl exactly the reviewed flag set with the shimmed fqdn", () => {
    const run = runAlert({ recipient: validRecipient });

    expect(run.status).toBe(0);
    expect(run.argv).toEqual(expectedCurlArgv);
  });

  it("mails headers, the failure line and the journal tail for a valid recipient", () => {
    const run = runAlert({ recipient: validRecipient });

    expect(run.status).toBe(0);
    const mail = run.mail;
    expect(mail).toContain(`From: overflow-alert@${fqdn}\n`);
    expect(mail).toContain(`To: ${recipientAddress}\n`);
    expect(mail).toContain(`Subject: [overflow] overflow.service failed on ${fqdn}\n`);
    expect(mail).toContain(`The systemd unit overflow.service failed on host ${fqdn} at `);
    expect(mail).toContain("journal-stub-line-1");
    expect(mail).toContain("journal-stub-line-2");
  });

  it("still mails, with a fallback note, when journalctl fails", () => {
    const run = runAlert({ recipient: validRecipient, journalStatus: 1 });

    expect(run.status).toBe(0);
    const mail = run.mail;
    expect(mail).toContain("(reading the journal failed)");
    expect(mail).not.toContain("journal-stub-line-1");
  });

  it("propagates the submission failure as its own exit status", () => {
    const run = runAlert({ recipient: validRecipient, curlStatus: 7 });

    expect(run.status).toBe(7);
  });
});

describe("overflow-alert.sh throttle", () => {
  const unit = "overflow.service";
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  it("sends the first alert and records the send time as all-digits state", () => {
    const stateDir = makeStateDir();
    const run = runAlert({ recipient: validRecipient, stateDir });

    expect(run.status).toBe(0);
    expect(run.sent).toBe(true);
    const recorded = readFileSync(join(stateDir, unit), "utf8");
    expect(recorded).toMatch(/^\d+\n$/);
    expect(Math.abs(Number(recorded) - nowSeconds())).toBeLessThanOrEqual(60);
  });

  it("suppresses a second alert for the same unit inside the window, without reaching the send stage", () => {
    const stateDir = makeStateDir();
    const first = runAlert({ recipient: validRecipient, stateDir });
    expect(first.status).toBe(0);
    expect(first.sent).toBe(true);

    const second = runAlert({ recipient: validRecipient, stateDir });
    expect(second.status).toBe(0);
    expect(second.sent, "a suppressed repeat must not reach the send stage").toBe(false);
    expect(second.stderr).toContain("throttl");
    expect(second.stderr).toContain(unit);
    expect(second.stderr).toContain("1800");
  });

  it("mails when the recorded send is older than the window, and refreshes the record", () => {
    const stateDir = makeStateDir();
    seedState(stateDir, unit, nowSeconds() - 2000);

    const run = runAlert({ recipient: validRecipient, stateDir });

    expect(run.status).toBe(0);
    expect(run.sent).toBe(true);
    const recorded = Number(readFileSync(join(stateDir, unit), "utf8"));
    expect(recorded).toBeGreaterThanOrEqual(nowSeconds() - 60);
    expect(recorded).toBeLessThanOrEqual(nowSeconds());
  });

  it("suppresses when the recorded send is fresh, naming the unit, the window and the age", () => {
    const stateDir = makeStateDir();
    seedState(stateDir, unit, nowSeconds() - 100);

    const run = runAlert({ recipient: validRecipient, stateDir });

    expect(run.status).toBe(0);
    expect(run.sent).toBe(false);
    expect(run.stderr).toContain("throttl");
    expect(run.stderr).toContain(unit);
    expect(run.stderr).toContain("1800");
    expect(run.stderr).toMatch(/was 10\d seconds ago/);
  });

  it("throttles per unit: a second unit sharing the state directory still mails", () => {
    const stateDir = makeStateDir();
    const first = runAlert({ recipient: validRecipient, stateDir });
    expect(first.sent).toBe(true);

    const second = runAlert({
      recipient: validRecipient,
      stateDir,
      args: ["overflow-backup.service"],
    });
    expect(second.status).toBe(0);
    expect(second.sent, "another unit's record must not suppress this unit").toBe(true);
    expect(existsSync(join(stateDir, "overflow-backup.service"))).toBe(true);
  });

  it("records nothing when the submission fails", () => {
    const stateDir = makeStateDir();
    const run = runAlert({ recipient: validRecipient, stateDir, curlStatus: 7 });

    expect(run.status).toBe(7);
    expect(run.sent).toBe(true);
    expect(existsSync(join(stateDir, unit)), "a failed submission leaves no state").toBe(false);
  });

  it("mails anyway, and still exits 0, when the state directory cannot be created", () => {
    const root = makeStateDir();
    writeFileSync(join(root, "blocker"), "a regular file, not a directory\n");
    const stateDir = join(root, "blocker", "sub");

    const run = runAlert({ recipient: validRecipient, stateDir });

    expect(run.status).toBe(0);
    expect(run.sent, "an unrecordable throttle must not stop the mail").toBe(true);
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("mails anyway on corrupt state content, then records a fresh record", () => {
    const stateDir = makeStateDir();
    seedState(stateDir, unit, nowSeconds() - 100);
    writeFileSync(join(stateDir, unit), "garbage\n");

    const run = runAlert({ recipient: validRecipient, stateDir });

    expect(run.status).toBe(0);
    expect(run.sent).toBe(true);
    expect(readFileSync(join(stateDir, unit), "utf8")).toMatch(/^\d+\n$/);
  });

  it("mails anyway when the state path is a directory, warning instead of recording", () => {
    const stateDir = makeStateDir();
    // A directory passes the script's readability test but cannot be read as
    // a timestamp, and the record write after the send cannot land on it.
    mkdirSync(join(stateDir, unit));

    const run = runAlert({ recipient: validRecipient, stateDir });

    expect(run.status, "an unreadable state path must not stop the mail").toBe(0);
    expect(run.sent).toBe(true);
    expect(run.stderr).toContain("could not write state file");
    expect(statSync(join(stateDir, unit)).isDirectory()).toBe(true);
  });

  it("refuses a missing recipient file before consulting the throttle", () => {
    const stateDir = makeStateDir();
    seedState(stateDir, unit, nowSeconds() - 100);

    const run = runAlert({ stateDir });

    expect(run.status).toBe(2);
    expect(run.sent).toBe(false);
  });
});
