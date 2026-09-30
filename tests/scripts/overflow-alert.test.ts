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
 * journalctl stub, a sleep that records being asked to wait, and a fixed
 * hostname, so the headers are deterministic and no mail can leave the machine.
 *
 * The recipient path is overridden through OVERFLOW_ALERT_RECIPIENT_FILE
 * because /etc/overflow/alert-recipient is root-only host configuration: a
 * suite that wrote it would mutate the host it runs on, and CI's runner user
 * cannot write /etc at all. The alert unit sets no such variable, so the
 * deployed path is always the default.
 *
 * The exim mainlog is overridden through OVERFLOW_ALERT_EXIM_LOG for the same
 * reason, and it is the load-bearing fixture of this suite: a submission the
 * local daemon merely spooled is NOT an alert that arrived, so every verdict
 * here is read off a log the test writes. The default fixture is a message that
 * left the host, which is what the send-stage and throttle cases need; the
 * delivery-verdict cases replace it line by line.
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts", "overflow-alert.sh");
const fqdn = "alert.test.example";
const recipientAddress = "ops@example.test";

/** The exact send contract: the recorded curl argv, in order. */
const expectedCurlArgv = [
  "-v",
  "--no-progress-meter",
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

/** The id the shimmed daemon accepts a submission under, as a real relay prints it. */
const messageId = "1xBuT1-000000009AA-1aA1";

const logStamp = "2026-09-30 02:15:07";

/**
 * A message the script did not cause, already completed. Every fixture carries
 * it, so a verdict that ignored the id and matched any Completed line passes
 * here by accident rather than failing.
 */
const foreignCompleted = "2026-09-30 01:30:04 1xBuT1-000000001AA-1aA1 Completed";

/** The routing line exim writes when it hands a message to a transport. */
const routingLine = (transport: string, id: string = messageId): string =>
  `${logStamp} ${id} => ${recipientAddress} R=smarthost T=${transport}`;

/** The completion line exim writes once every recipient has been dealt with. */
const completedLine = (id: string = messageId): string =>
  `${logStamp} ${id} Completed`;

/** The `<= ` line a spooled message carries; no transport, no verdict. */
const spoolLine = (id: string = messageId): string =>
  `${logStamp} ${id} <= overflow-alert@${fqdn} U=root P=esmtp S=1421`;

/** The fixture every send-stage and throttle case starts from. */
const deliveredEximLog = [
  foreignCompleted,
  spoolLine(),
  routingLine("remote_smtp_smarthost"),
  completedLine(),
];

/**
 * The local delivery agents the script refuses by name, and the reason each
 * one is in this list: it hands the message to something on THIS machine, so
 * the exim daemon's own acceptance and completion prove nothing about whether
 * anybody was told. `address_file` is the transport the issue was filed
 * against; the rest are the siblings that fail the same way.
 */
const localTransports = [
  "address_file",
  "address_pipe",
  "address_pipe_unset",
  "addressd",
  "address_directory",
  "appendfile",
  "autoreply",
  "mailbox",
  "maildrop_home",
  "mailstore_home",
  "tpipe",
];

const curlShim = [
  "#!/bin/sh",
  `printf '%s\\n' "$@" > "$OVERFLOW_TEST_CURL_ARGV"`,
  `cat > "$OVERFLOW_TEST_MAIL"`,
  `if [ "\${OVERFLOW_TEST_NO_ID:-0}" -eq 0 ]; then`,
  `  echo '* Connected to 127.0.0.1 port 25' >&2`,
  `  echo '> EHLO ${fqdn}' >&2`,
  `  echo '< 250 OK' >&2`,
  `  echo '> MAIL FROM:<overflow-alert@${fqdn}>' >&2`,
  `  echo '< 250 OK' >&2`,
  `  echo '> RCPT TO:<${recipientAddress}>' >&2`,
  `  echo '< 250 OK' >&2`,
  `  echo '> DATA' >&2`,
  `  echo '< 354 Go ahead' >&2`,
  `  printf '>\\n' >&2`,
  `  echo "< 250 OK id=\${OVERFLOW_TEST_MESSAGE_ID}" >&2`,
  `  echo '* Closing connection' >&2`,
  "fi",
  "exit ${FAKE_CURL_RC:-0}",
  "",
].join("\n");

/**
 * Records every wait the script asks for and then really waits. The record is
 * what the "concluded rather than ran out the budget" cases assert on, so
 * that property is read off an interaction the run produced instead of off a
 * wall-clock margin, and the recorded file survives after the run.
 *
 * It also grows the exim log, once, on the FIRST wait. A log that already
 * carried its own Completed line before the run ever polled it proves nothing
 * about a verdict that arrives later - which is the whole shape of a greylist
 * retry, and the whole reason a poll that concludes on sight is wrong. Appending
 * at the first wait makes "not there yet, and then there" something the run
 * actually observes.
 *
 * The real sleep is named by absolute path: the shim directory is first on the
 * script's PATH, so a bare `sleep` here would find this file again.
 */
const sleepShim = [
  "#!/bin/sh",
  `printf 'x\\n' >> "$OVERFLOW_TEST_SLEEP_CALLS"`,
  `if [ -s "$OVERFLOW_TEST_LOG_APPEND" ] && [ ! -e "$OVERFLOW_TEST_LOG_APPENDED" ]; then`,
  `  cat "$OVERFLOW_TEST_LOG_APPEND" >> "$OVERFLOW_TEST_EXIM_LOG"`,
  `  : > "$OVERFLOW_TEST_LOG_APPENDED"`,
  "fi",
  `/bin/sleep "$@"`,
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
  /** How many times the run asked to wait, counted from the sleep shim's record. */
  sleeps: number;
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
    /**
     * The exim mainlog lines this run judges against. Absent: a message that
     * left the host. `null`: no log file at all, so the run cannot read one.
     */
    eximLog?: string[] | null;
    /**
     * Lines appended to the mainlog on the run's FIRST wait, so the verdict
     * this fixture is about arrives after the run has already looked and found
     * nothing. See the sleep shim.
     */
    eximLogGrows?: string[];
    /** The wait budget, as the script's OVERFLOW_ALERT_EXIM_WAIT_SECONDS. */
    waitSeconds?: string;
    /** A daemon that accepts the submission without answering a 250 OK id=. */
    noId?: boolean;
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
    shim("sleep", sleepShim);
    shim("journalctl", journalctlShim);
    shim("hostname", hostnameShim);

    const recipientFile = join(directory, "alert-recipient");
    if (options.recipient !== undefined) writeFileSync(recipientFile, options.recipient);

    const curlArgvPath = join(directory, "curl-argv");
    const mailPath = join(directory, "mail.eml");
    const sleepCallsPath = join(directory, "sleep-calls");
    const stateDir = options.stateDir ?? join(directory, "throttle-state");
    const eximLogPath = join(directory, "mainlog");
    if (options.eximLog !== null) {
      const lines = options.eximLog ?? deliveredEximLog;
      writeFileSync(eximLogPath, `${lines.join("\n")}\n`);
    }
    const logAppendPath = join(directory, "mainlog-append");
    const grows = options.eximLogGrows;
    writeFileSync(logAppendPath, grows && grows.length > 0 ? `${grows.join("\n")}\n` : "");

    const result = spawnSync(
      "/bin/sh",
      [scriptPath, ...(options.args ?? ["overflow.service"])],
      {
        env: {
          NODE_ENV: "test",
          PATH: `${bin}:/usr/bin:/bin`,
          OVERFLOW_ALERT_RECIPIENT_FILE: recipientFile,
          OVERFLOW_ALERT_STATE_DIR: stateDir,
          OVERFLOW_ALERT_EXIM_LOG: eximLogPath,
          OVERFLOW_ALERT_EXIM_WAIT_SECONDS: options.waitSeconds ?? "1",
          OVERFLOW_TEST_CURL_ARGV: curlArgvPath,
          OVERFLOW_TEST_EXIM_LOG: eximLogPath,
          OVERFLOW_TEST_LOG_APPEND: logAppendPath,
          OVERFLOW_TEST_LOG_APPENDED: join(directory, "mainlog-appended"),
          OVERFLOW_TEST_MAIL: mailPath,
          OVERFLOW_TEST_MESSAGE_ID: messageId,
          OVERFLOW_TEST_NO_ID: options.noId ? "1" : "0",
          OVERFLOW_TEST_SLEEP_CALLS: sleepCallsPath,
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
    const sleeps = existsSync(sleepCallsPath)
      ? readFileSync(sleepCallsPath, "utf8").split("\n").length - 1
      : 0;
    return {
      status: result.status,
      stderr: result.stderr,
      sent,
      argv: sent ? readFileSync(curlArgvPath, "utf8").split("\n").slice(0, -1) : [],
      mail: existsSync(mailPath) ? readFileSync(mailPath, "utf8") : "",
      sleeps,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    // The refusal names the file and the reason, never the value: the
    // recipient file is host configuration and the journal is exactly where
    // such a value ends up pasted into an issue.
    if (recipient !== undefined && recipient !== "") {
      expect(run.stderr, "the recipient value must not reach the journal").not.toContain(
        recipient.trim(),
      );
    }
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

describe("overflow-alert.sh delivery verdict", () => {
  const unit = "overflow.service";

  /**
   * The issue this whole verdict is about: exim accepted a message and a local
   * delivery agent wrote it to /var/mail/mail on this same machine. Both halves
   * of the daemon's own account are present - the 250 OK id the script follows,
   * and the Completed line that ends the message - and no operator was told
   * anything. So the run must fail, and, because a failed alert must not buy
   * the next thirty minutes of silence, must leave no throttle record behind.
   */
  it("refuses a T=address_file routing line as a local write: nonzero, no state recorded", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      eximLog: [foreignCompleted, spoolLine(), routingLine("address_file"), completedLine()],
    });

    expect(run.status).not.toBe(0);
    expect(run.sent, "the submission itself still happened").toBe(true);
    expect(
      existsSync(join(stateDir, unit)),
      "a message that reached nobody must not suppress the next alert",
    ).toBe(false);
    expect(run.stderr).toContain("address_file");
    expect(run.stderr).toContain(messageId);
    // The recipient stays out of the journal on this path too, for the same
    // reason its own validation keeps it out: this line is what gets pasted
    // into an issue.
    expect(run.stderr).not.toContain(recipientAddress);
  });

  it.each(localTransports)(
    "refuses the local %s transport the same way a local write is refused",
    (transport) => {
      const stateDir = makeStateDir();

      const run = runAlert({
        recipient: validRecipient,
        stateDir,
        eximLog: [spoolLine(), routingLine(transport), completedLine()],
      });

      expect(run.status).not.toBe(0);
      expect(existsSync(join(stateDir, unit))).toBe(false);
      expect(run.stderr).toContain(transport);
    },
  );

  it("delivers when the routing line names a remote transport and exim Completed it", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      eximLog: [spoolLine(), routingLine("remote_smtp_smarthost"), completedLine()],
    });

    expect(run.status).toBe(0);
    expect(existsSync(join(stateDir, unit))).toBe(true);
    expect(run.stderr).toContain("remote_smtp_smarthost");
    expect(run.stderr).toContain(messageId);
  });

  it.each(["remote_smtp", "remote_smtp_unsecure", "smarthost"])(
    "delivers on the unlisted but remote %s transport rather than refusing it",
    (transport) => {
      // The denylist is deliberate: a legitimately configured remote transport
      // this script does not name is not a failure, and refusing it would be
      // the same false green the verdict exists to end.
      const run = runAlert({
        recipient: validRecipient,
        eximLog: [spoolLine(), routingLine(transport), completedLine()],
      });

      expect(run.status).toBe(0);
    },
  );

  it("keeps waiting through a defer and delivers when the retry Completes", () => {
    // The defer is the FIRST thing the run can see, and the Completed line only
    // lands after it has already waited once - a greylist retry as exim writes
    // it. A poll that concludes on the defer would report a dead alert on the
    // one signal the operator has to trust, so the run has to survive its
    // first look and let the later Completed line win.
    const run = runAlert({
      recipient: validRecipient,
      waitSeconds: "3",
      eximLog: [
        spoolLine(),
        `${logStamp} ${messageId} ** defer rejected: RCPT TO:<${recipientAddress}>: 451 greylisted`,
      ],
      eximLogGrows: [routingLine("remote_smtp_smarthost"), completedLine()],
    });

    expect(run.sleeps, "a defer alone must not end the poll").toBeGreaterThan(0);
    expect(run.status).toBe(0);
  });

  it("fails naming the defer when the budget closes with no Completed behind it", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "1",
      eximLog: [
        spoolLine(),
        routingLine("remote_smtp_smarthost"),
        `${logStamp} ${messageId} ** defer rejected: RCPT TO:<${recipientAddress}>: 451 greylisted`,
      ],
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("defer");
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it.each([
    ["rejected", `** rejected: RCPT TO:<${recipientAddress}>: 550 no such user`],
    ["bounce", `** bounce: <> ${recipientAddress}`],
    ["blackhole", `** blackhole: <> ${recipientAddress}`],
    ["discarded", `** discarded: <> ${recipientAddress}`],
    ["Failed", `Failed`],
  ])(
    "concludes on the terminal %s verdict instead of waiting out the budget",
    (_label, tail) => {
      const stateDir = makeStateDir();

      const run = runAlert({
        recipient: validRecipient,
        stateDir,
        waitSeconds: "20",
        eximLog: [spoolLine(), routingLine("remote_smtp_smarthost"), `${logStamp} ${messageId} ${tail}`],
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(messageId);
      expect(run.sleeps, "a terminal verdict must end the poll, not the budget").toBe(0);
      expect(existsSync(join(stateDir, unit))).toBe(false);
    },
  );

  it("fails when exim never writes a Completed line within the budget", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "1",
      eximLog: [spoolLine(), routingLine("remote_smtp_smarthost")],
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(messageId);
    expect(existsSync(join(stateDir, unit))).toBe(false);
    expect(run.sleeps, "the budget is the thing being spent here").toBeGreaterThan(0);
  });

  it("fails when the daemon accepted the alert but answered no id to follow", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      noId: true,
      eximLog: [foreignCompleted, completedLine("1xBuT1-000000009AA-1aA1")],
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("250 OK id=");
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("does not read another message's Completed line as its own verdict", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "1",
      eximLog: [foreignCompleted, spoolLine(), routingLine("remote_smtp_smarthost")],
    });

    expect(run.status).not.toBe(0);
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("treats an unreadable exim mainlog as no delivery rather than as silence to wait on", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "1",
      eximLog: null,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("mainlog");
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it.each(["thirty", "-1", "1.5", "60s", "0x3c"])(
    "refuses a wait budget of %j with exit 2 naming the value, before the send",
    (budget) => {
      const run = runAlert({ recipient: validRecipient, waitSeconds: budget });

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("OVERFLOW_ALERT_EXIM_WAIT_SECONDS");
      expect(run.stderr).toContain(budget);
      expect(run.sent, "an unusable budget must not reach the send stage").toBe(false);
    },
  );

  it("falls back to the default budget on an empty one rather than refusing it", () => {
    // The default is substituted with `:-`, so an empty variable takes the
    // deployed budget instead of reaching the digit check. That is deliberate:
    // an unset-and-empty budget is the canary's own shape, and a run that
    // waits the deployed number of seconds beats one that refuses to alert.
    const run = runAlert({ recipient: validRecipient, waitSeconds: "" });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain(messageId);
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
