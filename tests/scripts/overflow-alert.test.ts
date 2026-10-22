import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "overflow-alert-"), join(tmpdir(), "overflow-alert-state-")]);

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

const connectFailureDetail = (id: string = messageId): string =>
  `${logStamp} ${id} Failed to connect to smtp.gmail.com [2a00:1450:4001:c21::6c]: Connection refused`;

/** The deferral section 53.9 records immediately after that detail line. */
const deferredRetry = (id: string = messageId): string =>
  `${logStamp} ${id} == ${recipientAddress} R=smarthost T=remote_smtp_smarthost defer (1): Connection refused`;

const relayAnswerMentioningFailure = (id: string = messageId): string =>
  `${logStamp} ${id} => ${recipientAddress} R=smarthost T=remote_smtp_smarthost H=smtp.gmail.com [2a00:1450:4001:c21::6c] TFO CV=yes DN="CN=smtp.gmail.com" A=plain K C="550 5.7.1 rejected: \\"bounce\\" threshold not reached"`;

const terminalRejectionQuotingAConnectFailure = (id: string = messageId): string =>
  `${logStamp} ${id} ** rejected: RCPT TO:<${recipientAddress}>: 550 Failed to connect to mail1.example [192.0.2.1]: Connection refused`;

const lowercaseConnectFailure = (id: string = messageId): string =>
  `${logStamp} ${id} failed to connect to socket 10.0.0.1 for remote_smtp_smarthost transport: Connection timed out`;

const detailLineBesideAQuotedFlag = (id: string = messageId): string =>
  `${logStamp} ${id} => ${recipientAddress} R=smarthost T=remote_smtp_smarthost H=smtp.gmail.com [2a00:1450:4001:c21::6c] TFO CV=yes DN="CN=smtp.gmail.com" A=plain K C="** 5.7.1 blocked by policy" Failed to connect to smtp.gmail.com [2a00:1450:4001:c21::6c]: Connection refused`;

/** The fixture every send-stage and throttle case starts from. */
const deliveredEximLog = [
  foreignCompleted,
  spoolLine(),
  routingLine("remote_smtp_smarthost"),
  completedLine(),
];

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

  `printf '%s\\n' "$0" > "$OVERFLOW_TEST_CLIENT"`,
  `printf '%s\\n' "$@" > "$OVERFLOW_TEST_CURL_ARGV"`,
  `cat > "$OVERFLOW_TEST_MAIL"`,
  // Match exim's DATA limit in octets, excluding CRLF, without a socket.
  `LC_ALL=C awk '{ sub(/\\r$/, ""); if (length($0) > 998) exit 8 }' "$OVERFLOW_TEST_MAIL" || exit 8`,
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
  // An earlier message's id first, when the case asks for one. A real session
  // hands out an id per message, and only the reply to the end of DATA names
  // the one just submitted, so the script has to take the LAST id and not the
  // first - a fixture with only one line cannot tell those apart.
  `  if [ -n "\${OVERFLOW_TEST_STALE_ID:-}" ]; then`,
  `    echo "< 250 OK id=\${OVERFLOW_TEST_STALE_ID}" >&2`,
  "  fi",
  `  echo "< 250 OK id=\${OVERFLOW_TEST_MESSAGE_ID}" >&2`,
  `  echo '* Closing connection' >&2`,
  "fi",
  "exit ${FAKE_CURL_RC:-0}",
  "",
].join("\n");

const sleepShim = [
  "#!/bin/sh",
  `printf '%s\\n' "$*" >> "$OVERFLOW_TEST_SLEEP_CALLS"`,
  `if [ -s "$OVERFLOW_TEST_LOG_APPEND" ] && [ ! -e "$OVERFLOW_TEST_LOG_APPENDED" ]; then`,
  `  cat "$OVERFLOW_TEST_LOG_APPEND" >> "$OVERFLOW_TEST_EXIM_LOG"`,
  `  : > "$OVERFLOW_TEST_LOG_APPENDED"`,
  "fi",

  `/bin/sleep "\${OVERFLOW_TEST_SLEEP_REAL:-$1}"`,
  "",
].join("\n");

const dateShim = [
  "#!/bin/sh",
  `if [ "$1" = "+%s" ]; then`,
  `  n=$(cat "$OVERFLOW_TEST_CLOCK_CALLS" 2>/dev/null || echo 0)`,
  `  echo $((n + 1)) > "$OVERFLOW_TEST_CLOCK_CALLS"`,
  `  if [ "\${OVERFLOW_TEST_CLOCK_STEP:-0}" -eq 0 ]; then`,
  `    /bin/date +%s`,
  "  else",
  "    # A driven clock is ANCHORED once and then moves only by the step.",
  "    # Anchoring matters: adding the step to the real time on every reading",
  "    # lets however long this machine takes to spawn a process leak into the",
  "    # count, so how many readings a budget takes would depend on the runner",
  "    # rather than on the budget.",
  `    if [ ! -s "$OVERFLOW_TEST_CLOCK_BASE" ]; then`,
  `      /bin/date +%s > "$OVERFLOW_TEST_CLOCK_BASE"`,
  "    fi",
  `    echo $(( $(cat "$OVERFLOW_TEST_CLOCK_BASE") + n * \${OVERFLOW_TEST_CLOCK_STEP:-0} ))`,
  "  fi",
  "  exit 0",
  "fi",
  `exec /bin/date "$@"`,
  "",
].join("\n");

const journalctlShim = [
  "#!/bin/sh",
  'if [ "${FAKE_JOURNALCTL_RC:-0}" -ne 0 ]; then',
  '  exit "$FAKE_JOURNALCTL_RC"',
  "fi",
  'cat "$OVERFLOW_TEST_JOURNAL"',
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
  /** The arguments of each wait, in order, from the sleep shim's record. */
  sleepArgs: string[];
}

function resolveCurlOn(pathValue: string): string {
  const probe = spawnSync("/bin/sh", ["-c", "command -v curl"], {
    env: { NODE_ENV: "test", PATH: pathValue },
    encoding: "utf8",
  });
  if (probe.error) throw probe.error;

  return probe.stdout.trim();
}

function runAlert(
  options: {
    recipient?: string;
    args?: string[];
    curlStatus?: number;
    journalStatus?: number;
    journal?: string;
    /** Override the encoder only to exercise failure and wrapping behavior. */
    base64Shim?: string;
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
    /**
     * Leaves OVERFLOW_ALERT_EXIM_WAIT_SECONDS out of the environment entirely,
     * so the run reads the DEPLOYED default. No assertion over an overridden
     * value can see that number, which is the whole point of this switch.
     */
    deployedBudget?: boolean;
    /**
     * Leaves OVERFLOW_ALERT_EXIM_LOG out of the environment entirely, so the
     * run reads the DEPLOYED default path. Same reasoning as `deployedBudget`,
     * and for the same reason: no assertion over an overridden value can see
     * the one a deployed run uses.
     */
    deployedLogPath?: boolean;

    eximLogUnreadable?: boolean;
    /**
     * How far the clock shim advances per reading. Zero is the real clock.
     * See the shim.
     */
    clockStepSeconds?: number;
    /**
     * What the sleep shim really sleeps, overriding the interval the script
     * asked for. Zero pairs with a driven clock: the poll still takes the
     * number of readings the budget says, without costing them in wall time.
     */
    realSleepSeconds?: string;
    /** A daemon that accepts the submission without answering a 250 OK id=. */
    noId?: boolean;

    smtpUrl?: string;
    /**
     * An earlier message's id, which the shim answers BEFORE the message under
     * test. Exercises which of several `250 OK id=` lines the script takes.
     */
    staleMessageId?: string;
  } = {},
): AlertRun {
  const directory = tempDirectories.create(join(tmpdir(), "overflow-alert-"));

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
    shim("date", dateShim);
    shim("journalctl", journalctlShim);
    shim("hostname", hostnameShim);
    if (options.base64Shim) shim("base64", options.base64Shim);

    const journalPath = join(directory, "journal");
    writeFileSync(journalPath, options.journal ?? "journal-stub-line-1\njournal-stub-line-2\n");

    const recipientFile = join(directory, "alert-recipient");
    if (options.recipient !== undefined) writeFileSync(recipientFile, options.recipient);

    const curlArgvPath = join(directory, "curl-argv");
    const clientPath = join(directory, "client");
    const mailPath = join(directory, "mail.eml");
    const sleepCallsPath = join(directory, "sleep-calls");
    const stateDir = options.stateDir ?? join(directory, "throttle-state");
    const eximLogPath = join(directory, "mainlog");
    if (options.eximLog !== null && !options.deployedLogPath) {
      const lines = options.eximLog ?? deliveredEximLog;
      writeFileSync(eximLogPath, `${lines.join("\n")}\n`);
    }
    if (options.eximLogUnreadable) {
      writeFileSync(eximLogPath, `${(options.eximLog ?? deliveredEximLog).join("\n")}\n`);
      chmodSync(eximLogPath, 0o000);
    }

    const dropsPrivileges = Boolean(options.eximLogUnreadable) && process.getuid?.() === 0;
    if (dropsPrivileges) {
      chmodSync(directory, 0o777);
      chmodSync(bin, 0o777);
    }
    const logAppendPath = join(directory, "mainlog-append");
    const grows = options.eximLogGrows;
    writeFileSync(logAppendPath, grows && grows.length > 0 ? `${grows.join("\n")}\n` : "");

    const childEnv = {
      // `as const` because this object is no longer contextually typed by
      // `spawnSync`'s parameter: standalone, `NODE_ENV` would widen to `string`
      // and stop satisfying the repo's `ProcessEnv`.
      NODE_ENV: "test" as const,
      OVERFLOW_ALERT_RECIPIENT_FILE: recipientFile,
      OVERFLOW_ALERT_STATE_DIR: stateDir,
      ...(options.deployedLogPath ? {} : { OVERFLOW_ALERT_EXIM_LOG: eximLogPath }),
      ...(options.smtpUrl ? { OVERFLOW_ALERT_SMTP_URL: options.smtpUrl } : {}),
      OVERFLOW_TEST_CURL_ARGV: curlArgvPath,
      OVERFLOW_TEST_CLIENT: clientPath,
      OVERFLOW_TEST_CLOCK_CALLS: join(directory, "clock-calls"),
      OVERFLOW_TEST_CLOCK_BASE: join(directory, "clock-base"),
      OVERFLOW_TEST_CLOCK_STEP: String(options.clockStepSeconds ?? 0),
      OVERFLOW_TEST_EXIM_LOG: eximLogPath,
      OVERFLOW_TEST_STALE_ID: options.staleMessageId ?? "",
      OVERFLOW_TEST_LOG_APPEND: logAppendPath,
      OVERFLOW_TEST_LOG_APPENDED: join(directory, "mainlog-appended"),
      OVERFLOW_TEST_MAIL: mailPath,
      OVERFLOW_TEST_JOURNAL: journalPath,
      OVERFLOW_TEST_MESSAGE_ID: messageId,
      OVERFLOW_TEST_NO_ID: options.noId ? "1" : "0",
      OVERFLOW_TEST_SLEEP_CALLS: sleepCallsPath,
      OVERFLOW_TEST_SLEEP_REAL: options.realSleepSeconds ?? "",
      FAKE_CURL_RC: String(options.curlStatus ?? 0),
      FAKE_JOURNALCTL_RC: String(options.journalStatus ?? 0),
      ...(options.deployedBudget
        ? {}
        : { OVERFLOW_ALERT_EXIM_WAIT_SECONDS: options.waitSeconds ?? "1" }),
      // PATH last, and written once. Nothing above can set it.
      PATH: `${bin}:/usr/bin:/bin`,
    };

    const resolvedCurl = resolveCurlOn(childEnv.PATH);
    expect(
      resolvedCurl,
      `the script spawned with PATH=${childEnv.PATH} resolves "${resolvedCurl}" instead of this run's recording shim at ${join(
        bin,
        "curl",
      )}; a run that reaches the send stage on this PATH hands its message to a real SMTP client`,
    ).toBe(join(bin, "curl"));

    // `SpawnSyncReturns<string>` and not `ReturnType<typeof spawnSync>`: the latter
    // resolves the unparameterised overload and widens `stderr` to
    // `string | NonSharedBuffer`, which the reads below then reject.
    const spawnAlert = (scriptArgs: string[]): SpawnSyncReturns<string> =>
      spawnSync("/bin/sh", scriptArgs, {
        env: childEnv,
        encoding: "utf8",
        ...(dropsPrivileges ? { uid: 65534, gid: 65534 } : {}),
      });

    const result = spawnAlert([scriptPath, ...(options.args ?? ["overflow.service"])]);
    if (result.error) throw result.error;
    expect(result.signal, `killed by ${result.signal}: ${result.stderr}`).toBeNull();

    // Read the shims' captures before the fixture directory is removed.
    const sent = existsSync(curlArgvPath);

    if (sent) {
      const fixtureClient = join(bin, "curl");
      const ranClient = existsSync(clientPath) ? readFileSync(clientPath, "utf8").trim() : "";
      expect(
        ranClient,
        "the submission went through a client other than this run's own recording shim, so it was not mocked; an unreadable record reads as empty, which also fails",
      ).toBe(fixtureClient);

      expect(
        existsSync(fixtureClient) && lstatSync(fixtureClient).isFile(),
        `${fixtureClient} is not a regular file, so the path the client reported cannot be trusted to name the code that ran - a symlink here resolves to itself and passes the comparison above while pointing somewhere else`,
      ).toBe(true);
    }
    const sleepArgs = existsSync(sleepCallsPath)
      ? readFileSync(sleepCallsPath, "utf8").split("\n").slice(0, -1)
      : [];
    return {
      status: result.status,
      stderr: result.stderr,
      sent,
      argv: sent ? readFileSync(curlArgvPath, "utf8").split("\n").slice(0, -1) : [],
      mail: existsSync(mailPath) ? readFileSync(mailPath, "utf8") : "",
      sleeps: sleepArgs.length,
      sleepArgs,
    };
  } finally {
    tempDirectories.dispose(directory);
  }
}

const sharedStateDirs: string[] = [];

afterEach(() => {
  for (const directory of sharedStateDirs.splice(0)) {
    tempDirectories.dispose(directory);
  }
});

/** A scratch directory that outlives one test's calls, removed after it. */
function makeScratchDir(): string {
  const directory = tempDirectories.create(join(tmpdir(), "overflow-alert-state-"));
  sharedStateDirs.push(directory);
  return directory;
}

/** A scratch throttle state directory that outlives one test's runAlert calls. */
function makeStateDir(): string {
  return makeScratchDir();
}

/** Pre-seeds the throttle state file for a unit with a recorded send time. */
function seedState(stateDir: string, unit: string, timestamp: number): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, unit), `${timestamp}\n`);
}

/** The valid single-line recipient every send-path test starts from. */
const validRecipient = `${recipientAddress}\n`;

/** Check the captured SMTP payload before decoding; Buffer alone accepts malformed base64. */
function decodeMail(mail: string): Buffer {
  expect(mail).not.toMatch(/(?<!\r)\n|\r(?!\n)/);
  expect(mail.endsWith("\r\n")).toBe(true);
  for (const line of mail.split("\r\n")) {
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
  }
  const parts = mail.split("\r\n\r\n");
  expect(parts).toHaveLength(2);
  const [headers, encoded] = parts;
  expect(headers.split("\r\n")).toEqual([
    `From: overflow-alert@${fqdn}`,
    `To: ${recipientAddress}`,
    `Subject: [overflow] overflow.service failed on ${fqdn}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ]);
  const lines = encoded.split("\r\n").slice(0, -1);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(76);
    expect(line).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  }
  const joined = lines.join("");
  const decoded = Buffer.from(joined, "base64");
  expect(decoded.toString("base64")).toBe(joined);
  return decoded;
}

function expectJournal(mail: string, journal: string): void {
  const body = decodeMail(mail);
  const intro = body.toString("utf8").match(
    /^The systemd unit overflow\.service failed on host alert\.test\.example at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\.\r\n\r\nLast journal entries for the failed unit \(current boot\):\r\n/,
  );
  expect(intro).not.toBeNull();
  // Compare bytes, including every blank line and trailing space. Only the
  // text's line endings change to MIME's canonical CRLF representation.
  expect(body.subarray(Buffer.byteLength(intro![0]))).toEqual(
    Buffer.from(journal.replace(/\r?\n/g, "\r\n")),
  );
}

function reportedVerdict(stderr: string): string | undefined {
  return /recorded (.+?) for /.exec(stderr)?.[1];
}

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

  const urlArgument = (argv: string[]): string => argv[argv.indexOf("--url") + 1] ?? "";

  it("submits to the deployed local exim daemon when the variable is absent entirely", () => {
    // The deployed default, reached with the variable out of the environment.
    // No assertion over an OVERRIDDEN value can ever see the number or the
    // address a deployed run really uses, so the case that omits it is the one
    // that means anything about the host.
    const run = runAlert({ recipient: validRecipient });

    expect(run.status).toBe(0);
    expect(urlArgument(run.argv)).toBe("smtp://127.0.0.1:25");
  });

  it("submits to the endpoint OVERFLOW_ALERT_SMTP_URL names, rather than to a hardcoded one", () => {

    const run = runAlert({
      recipient: validRecipient,
      smtpUrl: "smtp://127.0.0.1:2525",
    });

    expect(run.status).toBe(0);
    expect(urlArgument(run.argv), "the endpoint must be the one the variable names").toBe(
      "smtp://127.0.0.1:2525",
    );
    expect(run.argv, "and nothing else about the submission changes").toEqual([
      ...expectedCurlArgv.slice(0, expectedCurlArgv.indexOf("smtp://127.0.0.1:25")),
      "smtp://127.0.0.1:2525",
      ...expectedCurlArgv.slice(expectedCurlArgv.indexOf("smtp://127.0.0.1:25") + 1),
    ]);
  });

  it("hands the client an endpoint containing a space as ONE argument", () => {

    const spacedEndpoint = "smtp://127.0.0.1: 25";
    const run = runAlert({ recipient: validRecipient, smtpUrl: spacedEndpoint });

    expect(run.status).toBe(0);
    expect(
      run.argv,
      "an endpoint with a space must arrive whole, not split into two --url operands",
    ).toContain(spacedEndpoint);
    // The split form leaves the halves behind as separate elements, so the
    // absence of the split is asserted directly rather than inferred from the
    // containment above.
    expect(run.argv, "and no fragment of it may appear on its own").not.toContain(
      "smtp://127.0.0.1:",
    );
  });

  it("mails headers, the failure line and the journal tail for a valid recipient", () => {
    const run = runAlert({ recipient: validRecipient });

    expect(run.status).toBe(0);
    expectJournal(run.mail, "journal-stub-line-1\njournal-stub-line-2\n");
  });

  it("still mails, with a fallback note, when journalctl fails", () => {
    const run = runAlert({ recipient: validRecipient, journalStatus: 1 });

    expect(run.status).toBe(0);
    expectJournal(run.mail, "(reading the journal failed)\n");
  });

  it("propagates the submission failure as its own exit status", () => {
    const run = runAlert({ recipient: validRecipient, curlStatus: 7 });

    expect(run.status).toBe(7);
  });
});

describe("overflow-alert.sh MIME body", () => {
  it.each([997, 998, 999, 1123, 1131, 1200, 8192, 32768])(
    "preserves a %i-octet journal line within SMTP's wire limit",
    (length) => {
      const journal = `${"x".repeat(length)}\n`;
      const run = runAlert({ recipient: validRecipient, journal });

      expect(run.status).toBe(0);
      expectJournal(run.mail, journal);
    },
  );

  it.each([
    [998, "é".repeat(499)],
    [999, "é".repeat(499) + "x"],
    [999, "界".repeat(333)],
    [1200, "🦊".repeat(300)],
  ])("preserves multibyte UTF-8 across the %i-octet boundary", (octets, line) => {
    expect(Buffer.byteLength(line)).toBe(octets);
    expect(line.length).toBeLessThan(998);
    const journal = `${line}\n`;
    const run = runAlert({ recipient: validRecipient, journal });

    expect(run.status).toBe(0);
    expectJournal(run.mail, journal);
  });

  it.each(["", "\n\n", ".\n..leading dots\nFrom: journal text\nspaces  \t\nback\\slash\n\n", "already CRLF\r\n\r\n"])(
    "preserves blank lines, whitespace and SMTP-looking journal text (%j)",
    (journal) => {
      const run = runAlert({ recipient: validRecipient, journal });

      expect(run.status).toBe(0);
      expectJournal(run.mail, journal);
    },
  );

  it.each([
    ["unwrapped", "/usr/bin/base64 | tr -d '\\n'"],
    ["64-column", "/usr/bin/base64 | tr -d '\\n' | fold -w 64"],
    ["76-column", "/usr/bin/base64 | tr -d '\\n' | fold -w 76"],
  ])("bounds %s encoder output without changing its decoded bytes", (_name, command) => {
    const journal = `${"long journal entry 界🦊 ".repeat(100)}\n`;
    const run = runAlert({ recipient: validRecipient, journal, base64Shim: `#!/bin/sh\n${command}\n` });

    expect(run.status).toBe(0);
    expectJournal(run.mail, journal);
  });

  it.each([1, 2, 127])("does not submit or throttle an encoder failure (exit %i)", (status) => {
    const stateDir = makeStateDir();
    const failed = runAlert({
      recipient: validRecipient,
      stateDir,
      base64Shim: `#!/bin/sh\ncat >/dev/null\nprintf 'cGFydGlhbA==\\n'\nexit ${status}\n`,
    });

    expect(failed.status).toBe(1);
    expect(failed.sent).toBe(false);
    expect(failed.stderr).toContain("could not encode the alert body");
    expect(existsSync(join(stateDir, "overflow.service"))).toBe(false);
    const retry = runAlert({ recipient: validRecipient, stateDir });
    expect(retry.status).toBe(0);
    expect(retry.sent).toBe(true);
  });

  it("retries a rejected long-line alert and throttles only after confirmed delivery", () => {
    const stateDir = makeStateDir();
    const journal = `${"pg_dump: LOCK TABLE ".repeat(100)}\n`;
    const options = { recipient: validRecipient, stateDir, journal };
    const rejected = runAlert({ ...options, curlStatus: 8 });

    expect(rejected.status).toBe(8);
    expect(rejected.sent).toBe(true);
    expectJournal(rejected.mail, journal);
    expect(existsSync(join(stateDir, "overflow.service"))).toBe(false);

    const retry = runAlert(options);
    expect(retry.status).toBe(0);
    expect(retry.sent).toBe(true);
    expectJournal(retry.mail, journal);
    const recorded = readFileSync(join(stateDir, "overflow.service"), "utf8");
    expect(recorded).toMatch(/^\d+\n$/);

    const suppressed = runAlert(options);
    expect(suppressed.status).toBe(0);
    expect(suppressed.sent).toBe(false);
    expect(readFileSync(join(stateDir, "overflow.service"), "utf8")).toBe(recorded);
  });

  it("does not refresh an expired throttle record when encoding fails", () => {
    const stateDir = makeStateDir();
    const expired = Math.floor(Date.now() / 1000) - 2000;
    seedState(stateDir, "overflow.service", expired);
    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      base64Shim: "#!/bin/sh\ncat >/dev/null\nexit 1\n",
    });

    expect(run.status).toBe(1);
    expect(run.sent).toBe(false);
    expect(readFileSync(join(stateDir, "overflow.service"), "utf8")).toBe(`${expired}\n`);
  });
});

describe("overflow-alert.sh delivery verdict", () => {
  const unit = "overflow.service";

  it("refuses a T=address_file routing line as a local write: nonzero, no state recorded", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
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
        waitSeconds: "3",
        clockStepSeconds: 1,
        realSleepSeconds: "0",
        eximLog: [spoolLine(), routingLine(transport), completedLine()],
      });

      expect(run.status).not.toBe(0);
      expect(existsSync(join(stateDir, unit))).toBe(false);
      expect(run.stderr).toContain(transport);
    },
  );

  it("reports a bounced message as failed even though exim Completed it", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [
        spoolLine(),
        routingLine("remote_smtp_smarthost"),
        `${logStamp} ${messageId} ** bounce: <> ${recipientAddress}: 550 unknown user`,
        completedLine(),
      ],
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("bounce");
    expect(existsSync(join(stateDir, unit)), "a refused alert must not silence the next one").toBe(
      false,
    );
  });

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

  it("names a deferral by the token, not by a prefix of it", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [
        spoolLine(),
        routingLine("remote_smtp_smarthost"),
        deferredRetry(),
      ],
    });

    expect(run.status).not.toBe(0);
    expect(reportedVerdict(run.stderr)).toBe("defer");
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("fails naming the defer when the budget closes with no Completed behind it", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
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

  it("keeps waiting past a refused connection and reports the retry at the budget", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [
        spoolLine(),
        routingLine("remote_smtp_smarthost"),
        connectFailureDetail(),
        deferredRetry(),
      ],
    });

    expect(run.sleeps, "a refused connection is a detail line, not a verdict").toBe(2);
    expect(run.status).not.toBe(0);
    expect(existsSync(join(stateDir, unit)), "an undelivered alert must not silence the next").toBe(
      false,
    );

    expect(reportedVerdict(run.stderr)).toBe("Failed to connect to");
  });

  it("delivers when the retry connects, though the refused attempt was logged first", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      eximLog: [
        spoolLine(),
        routingLine("remote_smtp_smarthost"),
        connectFailureDetail(),
        deferredRetry(),
      ],
      eximLogGrows: [completedLine()],
    });

    expect(run.status).toBe(0);
    expect(existsSync(join(stateDir, unit)), "a delivered alert records its send").toBe(true);
  });

  it("keeps waiting on the refused connection alone, with no deferral behind it", () => {
    // The window between the refused attempt and the deferral exim writes for
    // it, which is what the log holds whenever the run reads it early. Nothing
    // in it ends the message, so nothing in it may end the poll.
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [spoolLine(), routingLine("remote_smtp_smarthost"), connectFailureDetail()],
    });

    expect(run.sleeps, "the detail line on its own is no more a verdict").toBe(2);
    expect(run.status).not.toBe(0);
    expect(existsSync(join(stateDir, unit))).toBe(false);
    // Same obligation with nothing behind it to name: the only thing the log
    // holds is the refused connection, so it is the only thing the reason can
    // be about.
    expect(reportedVerdict(run.stderr)).toBe("Failed to connect to");
  });

  it("concludes on a rejection whose reason text names a refused socket", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      eximLog: [spoolLine(), routingLine("remote_smtp_smarthost"), terminalRejectionQuotingAConnectFailure()],
    });

    expect(run.sleeps, "a `**` flag is conclusive on sight").toBe(0);
    expect(run.status).not.toBe(0);
    expect(reportedVerdict(run.stderr)).toBe("rejected");
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("reads a quoted `**` as the relay's words, not as exim's flag", () => {
    // The anchor, pinned. `flagged` must be true only where `**` FOLLOWS the
    // id; a `**` a smarthost wrote into its own quoted answer must not make an
    // unflagged detail line terminal. One detail line, no flag, so the run
    // waits its budget out and names the refusal.
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [spoolLine(), detailLineBesideAQuotedFlag()],
    });

    expect(run.sleeps, "a `**` inside a quoted answer is not the flag").toBe(2);
    expect(run.status).not.toBe(0);
    expect(reportedVerdict(run.stderr)).toBe("Failed to connect to");
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("waits out the budget on the lowercase refused-socket line, which ends nothing", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [spoolLine(), routingLine("remote_smtp_smarthost"), lowercaseConnectFailure()],
    });

    expect(run.sleeps, "a line naming no verdict must not end the poll").toBe(2);
    expect(run.status).not.toBe(0);
    expect(reportedVerdict(run.stderr)).toBeUndefined();
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("keeps the FIRST provisional outcome when the retry's refusal is logged after it", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [
        spoolLine(),
        routingLine("remote_smtp_smarthost"),
        `${logStamp} ${messageId} ** defer rejected: greylisted, please retry`,
        connectFailureDetail(),
        deferredRetry(),
      ],
    });

    expect(run.sleeps, "a refused connection is not a verdict whatever else the log holds").toBe(2);
    expect(run.status).not.toBe(0);
    expect(existsSync(join(stateDir, unit))).toBe(false);
    expect(reportedVerdict(run.stderr)).toBe("defer");
  });

  it("does not read a terminal word out of the relay's own quoted answer", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      eximLog: [spoolLine(), relayAnswerMentioningFailure(), deferredRetry()],
      eximLogGrows: [completedLine()],
    });

    expect(run.status).toBe(0);
    expect(existsSync(join(stateDir, unit)), "a delivered alert records its send").toBe(true);
  });

  it("fails when exim never writes a Completed line within the budget", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [spoolLine(), routingLine("remote_smtp_smarthost")],
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(messageId);
    expect(existsSync(join(stateDir, unit))).toBe(false);
    // The budget has to be comfortably longer than the run's own start-up, or
    // the very first deadline check can find it already spent and the poll is
    // never exercised at all.
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
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [foreignCompleted, spoolLine(), routingLine("remote_smtp_smarthost")],
    });

    expect(run.status).not.toBe(0);
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("treats an absent exim mainlog as no delivery, and says which file it could not read", () => {
    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: null,
    });

    expect(run.status).not.toBe(0);

    expect(run.stderr).toContain("unreadable");
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("treats a mainlog that EXISTS but cannot be read as no delivery", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLogUnreadable: true,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("unreadable");
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

  it("follows the LAST 250 OK id=, not the first, when the session names two", () => {
    // One line in the trace cannot tell "last" from "first", so the fixture has
    // to carry two. Taking the wrong one reads a verdict about a message that
    // is not this one, and reports the alert undelivered while it is sitting
    // delivered in the log.
    const stateDir = makeStateDir();
    const staleId = "1xBuT1-000000008ZZ-9old";

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      staleMessageId: staleId,
    });

    expect(run.stderr, "the id under test is the one that must be followed").toContain(
      messageId,
    );
    expect(run.status).toBe(0);
    expect(existsSync(join(stateDir, unit))).toBe(true);
  });

  it("takes the LAST routing line as the current routing decision", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      eximLog: [
        spoolLine(),
        routingLine("address_file"),
        routingLine("remote_smtp_smarthost"),
        completedLine(),
      ],
    });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("address_file");
    expect(existsSync(join(stateDir, unit))).toBe(true);
  });

  it("reads the transport off a routing line only, never off a T= elsewhere", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      eximLog: [
        `${logStamp} ${messageId} <= overflow-alert@${fqdn} U=root P=esmtp S=1421 T=[overflow] overflow.service failed`,
        `${logStamp} ${messageId} == ${recipientAddress} R=dnslookup T=remote_smtp_smarthost defer (146): Connection refused`,
        completedLine(),
      ],
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("defer");
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("waits the DEPLOYED budget, and reports it, when the variable is absent entirely", () => {

    const stateDir = makeStateDir();

    const run = runAlert({
      recipient: validRecipient,
      stateDir,
      deployedBudget: true,
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [spoolLine(), routingLine("remote_smtp_smarthost")],
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr, "the deployed default must be the number reported").toContain("60s");
    expect(run.sleeps, "a 60-second budget closes after 59 waits").toBe(59);
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("reads the DEPLOYED log path when the variable is absent entirely", () => {

    const run = runAlert({
      recipient: validRecipient,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      deployedLogPath: true,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr, "the deployed default path must be the one it read").toContain(
      "/var/log/exim4/mainlog",
    );
    // A rotation file is `mainlog.N`, so the bare name with nothing after it is
    // what distinguishes today's log from yesterday's. Without this the assertion
    // above still passes on `mainlog.1`, because the path it names is a prefix.
    expect(run.stderr, "today's mainlog, not a rotated one").not.toContain("mainlog.");
  });

  it("computes the deadline from the budget, not from a number standing beside it", () => {

    const run = runAlert({
      recipient: validRecipient,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [spoolLine(), routingLine("remote_smtp_smarthost")],
    });

    expect(run.status).not.toBe(0);
    expect(run.sleeps, "a 3-second budget closes after two waits").toBe(2);
    expect(run.stderr).toContain("within 3s");
  });

  it("polls once a second rather than at some other interval", () => {
    // The interval is invisible from the outside - a five-second poll closes the
    // same budget - so it is read off the run's own record of what it asked to
    // wait for.
    const run = runAlert({
      recipient: validRecipient,
      waitSeconds: "3",
      clockStepSeconds: 1,
      realSleepSeconds: "0",
      eximLog: [spoolLine(), routingLine("remote_smtp_smarthost")],
    });

    expect(run.sleeps, "the budget is the thing being spent here").toBeGreaterThan(0);
    expect(run.sleepArgs).toEqual(run.sleepArgs.map(() => "1"));
  });
});

describe("overflow-alert.sh transport boundary", () => {

  it("resolves the system client when the fixture directory is not on the PATH at all", () => {

    const resolved = resolveCurlOn("/usr/bin:/bin");

    expect(resolved, "the system client is on the machine").not.toBe("");
    expect(
      resolved,
      "which is exactly what the check inside runAlert refuses, so the failure names a real client rather than an expectation",
    ).not.toContain(join(tmpdir(), "overflow-alert-"));
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

describe("overflow-alert.sh exit-status contract", () => {
  const unit = "overflow.service";

  it("never reports 2 for a submission failure that curl numbered 2", () => {
    const stateDir = makeStateDir();

    const run = runAlert({ recipient: validRecipient, stateDir, curlStatus: 2 });

    expect(run.status).not.toBe(2);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("curl exited 2");
    expect(existsSync(join(stateDir, unit)), "a failed submission leaves no state").toBe(false);
  });

  it("propagates every other submission failure as the client numbered it", () => {
    for (const code of [7, 28, 56]) {
      const stateDir = makeStateDir();
      const run = runAlert({ recipient: validRecipient, stateDir, curlStatus: code });

      expect(run.status, `curl's ${code} is not the misconfiguration class`).toBe(code);
      expect(existsSync(join(stateDir, unit))).toBe(false);
    }
  });

  it("still reserves 2 for a misconfiguration that never sends", () => {
    const run = runAlert({ recipient: validRecipient, waitSeconds: "sixty" });

    expect(run.status).toBe(2);
    expect(run.sent).toBe(false);
  });
});

describe("the driven clock the budget cases measure with", () => {
  it("advances by exactly the step, whatever the real clock does in between", async () => {

    const directory = makeScratchDir();
    const shimPath = join(directory, "date");
    writeFileSync(shimPath, dateShim);
    chmodSync(shimPath, 0o755);
    const clockCalls = join(directory, "clock-calls");
    const clockBase = join(directory, "clock-base");

    const readClock = (): number => {
      const result = spawnSync(shimPath, ["+%s"], {
        env: {
          NODE_ENV: "test",
          PATH: "/usr/bin:/bin",
          OVERFLOW_TEST_CLOCK_BASE: clockBase,
          OVERFLOW_TEST_CLOCK_CALLS: clockCalls,
          OVERFLOW_TEST_CLOCK_STEP: "1",
        },
        encoding: "utf8",
      });
      if (result.error) throw result.error;

      return Number(result.stdout.trim());
    };

    const first = readClock();
    // A real second has to pass, or the two readings are the same instant and
    // there is nothing to compare.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = readClock();

    expect(second - first, "the step, and only the step").toBe(1);
  });

  it("is the real clock when no step is set, so every other case is untouched", () => {
    const directory = makeScratchDir();
    const shimPath = join(directory, "date");
    writeFileSync(shimPath, dateShim);
    chmodSync(shimPath, 0o755);

    const readClock = (): number => {
      const result = spawnSync(shimPath, ["+%s"], {
        env: {
          NODE_ENV: "test",
          PATH: "/usr/bin:/bin",
          OVERFLOW_TEST_CLOCK_BASE: join(directory, "clock-base"),
          OVERFLOW_TEST_CLOCK_CALLS: join(directory, "clock-calls"),
          OVERFLOW_TEST_CLOCK_STEP: "0",
        },
        encoding: "utf8",
      });
      if (result.error) throw result.error;

      return Number(result.stdout.trim());
    };

    // Two readings of the untouched clock must agree to within a second of each
    // other and with the wall clock: this is the branch every throttle case in
    // the suite takes, and a shim that froze time here would silently date
    // every recorded send to one instant.
    const before = Math.floor(Date.now() / 1000);
    const first = readClock();
    const second = readClock();
    const after = Math.floor(Date.now() / 1000);

    expect(first).toBeGreaterThanOrEqual(before);
    expect(second).toBeLessThanOrEqual(after);
  });
});
