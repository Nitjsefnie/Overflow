import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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

/**
 * Records every wait the script asks for, with the arguments it asked with, and
 * then really waits. The record is what the "concluded rather than ran out the
 * budget" cases assert on, so that property is read off an interaction the run
 * produced instead of off a wall-clock margin. The ARGS are recorded too, which
 * is what pins the poll interval: a poll that slept five seconds would still
 * close the same budget, and only its own record says so.
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
  `printf '%s\\n' "$*" >> "$OVERFLOW_TEST_SLEEP_CALLS"`,
  `if [ -s "$OVERFLOW_TEST_LOG_APPEND" ] && [ ! -e "$OVERFLOW_TEST_LOG_APPENDED" ]; then`,
  `  cat "$OVERFLOW_TEST_LOG_APPEND" >> "$OVERFLOW_TEST_EXIM_LOG"`,
  `  : > "$OVERFLOW_TEST_LOG_APPENDED"`,
  "fi",
  // The real duration is what the script asked for, unless a case overrides
  // it. A case that drives the run's clock from a shim does not need the
  // wall-clock wait to match: the poll's LENGTH is then the budget, and the
  // count of readings is a record the run produces rather than a duration
  // anyone has to sit through.
  `/bin/sleep "\${OVERFLOW_TEST_SLEEP_REAL:-$1}"`,
  "",
].join("\n");

/**
 * A clock the run can be made to move forward on.
 *
 * The deployed wait budget is 60 seconds, and the only place that number is
 * observable is in a reason a run produces after waiting it out. Testing that
 * honestly costs sixty seconds of a CI worker per run, which is why this
 * exists: with a step set, each reading advances a FIXED amount from a fixed
 * base, so the number of readings a budget takes is the budget, and the run
 * closes in milliseconds. With no step set the shim returns the real clock and
 * nothing changes.
 *
 * Only `+%s` is intercepted. The mail header's `date -u` and everything else
 * reach the real date.
 */
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
  /** The arguments of each wait, in order, from the sleep shim's record. */
  sleepArgs: string[];
}

/**
 * Which `curl` a PATH resolves to, resolved the way the shell that runs the
 * script resolves it: by SEARCHING that PATH, not by reading a string out of it.
 *
 * This is the observable the transport boundary is actually made of. The suite's
 * safety does not rest on the script's endpoint - it rests on the client the
 * script finds when it goes looking for `curl`, because the shim opens no socket
 * under any case. A PATH that lost the fixture's directory would hand the script
 * the real /usr/bin/curl, and the endpoint override added alongside this would
 * not help: a bare PATH resolves to the production daemon no matter what URL the
 * script was told to use.
 *
 * So the property worth asserting is not that a constant appears in the spawn's
 * environment, which a comment could satisfy and a later edit could quietly drop.
 * It is that the lookup, performed the way the script performs it, lands inside
 * this run's own fixture.
 */
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
    /**
     * Writes the mainlog with mode 000, so it EXISTS and cannot be read - the
     * state the alert unit is actually in when its supplementary groups do not
     * grant the log, and the only state that tells `-r` from `-e` apart. Real
     * permissions, not a simulated one: root bypasses mode bits, so this drops
     * to an unprivileged uid rather than pretending.
     */
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
    /**
     * The submission endpoint, handed to the script as
     * OVERFLOW_ALERT_SMTP_URL. Absent: the variable is left out of the
     * environment entirely, so the run submits to the deployed default.
     *
     * Leaving it out is the honest default for every other case in this suite.
     * The client on PATH is the shim, which records its argv and opens no
     * socket, so the URL is inert here whatever it says - and a case that
     * quietly rewrote it would therefore LOOK mocked without being mocked,
     * which is the one thing this file must never claim.
     */
    smtpUrl?: string;
    /**
     * An earlier message's id, which the shim answers BEFORE the message under
     * test. Exercises which of several `250 OK id=` lines the script takes.
     */
    staleMessageId?: string;
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
    shim("date", dateShim);
    shim("journalctl", journalctlShim);
    shim("hostname", hostnameShim);

    const recipientFile = join(directory, "alert-recipient");
    if (options.recipient !== undefined) writeFileSync(recipientFile, options.recipient);

    const curlArgvPath = join(directory, "curl-argv");
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

    // Root ignores mode bits, so a mode-000 log is still readable by a root
    // test run and would test nothing. Dropping the run's privileges is the
    // honest way to get a file the script genuinely cannot open, and it needs
    // no extra binary: spawnSync setuid's. Everything the script touches in
    // this fixture therefore has to be reachable by the unprivileged uid.
    const dropsPrivileges = Boolean(options.eximLogUnreadable) && process.getuid?.() === 0;
    if (dropsPrivileges) {
      chmodSync(directory, 0o777);
      chmodSync(bin, 0o777);
    }
    const logAppendPath = join(directory, "mainlog-append");
    const grows = options.eximLogGrows;
    writeFileSync(logAppendPath, grows && grows.length > 0 ? `${grows.join("\n")}\n` : "");

    // The one spawn of the script in this file, and therefore the one place the
    // transport boundary has to hold. Asserted here rather than in a single
    // dedicated case so that EVERY run checks it, once per run, instead of one
    // case describing a convention the others could drift away from.
    //
    // The guard reads `childEnv.PATH` and `spawnAlert` hands the child that same
    // object, so there is ONE derivation of the PATH and the guard's input is
    // the spawn's input by construction. Deriving it twice - a constant the
    // guard resolves and a separate string the spawn is handed - is the shape
    // that let a guard pass while the script reached the real client: the two
    // can disagree, and nothing notices. `spawnAlert` therefore takes no
    // environment at all, which makes a divergent PATH a compile error rather
    // than a silent green.
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
      OVERFLOW_TEST_CLOCK_CALLS: join(directory, "clock-calls"),
      OVERFLOW_TEST_CLOCK_BASE: join(directory, "clock-base"),
      OVERFLOW_TEST_CLOCK_STEP: String(options.clockStepSeconds ?? 0),
      OVERFLOW_TEST_EXIM_LOG: eximLogPath,
      OVERFLOW_TEST_STALE_ID: options.staleMessageId ?? "",
      OVERFLOW_TEST_LOG_APPEND: logAppendPath,
      OVERFLOW_TEST_LOG_APPENDED: join(directory, "mainlog-appended"),
      OVERFLOW_TEST_MAIL: mailPath,
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

/** A scratch directory that outlives one test's calls, removed after it. */
function makeScratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "overflow-alert-state-"));
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

  /**
   * What the recorded `--url` is, read off the argv rather than off the script.
   *
   * THE SAFETY OF THIS SUITE RESTS ON ONE PROPERTY, and it is worth stating
   * next to the cases that depend on it: the client on PATH is the shim above,
   * which records what it was asked and opens no socket. The endpoint is
   * therefore inert here whatever the script names, and these cases exercise it
   * as exactly what it is - a string the script hands to a client that never
   * dials it. Nothing in this file submits a message to anything, on any case,
   * at any URL.
   *
   * That is also why no case below sets the endpoint by default. A case that
   * rewrote the URL would look as though the transport were mocked when the
   * thing doing the mocking is the client shim and not the address, and that
   * false signal is what the override's absence used to hide.
   */
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
    // The script's submission endpoint is an INPUT like every other one here,
    // so it is reachable from outside the script. While it was written into the
    // curl invocation as a literal, nothing could point the script at anything
    // but the one address, which is what left the transport boundary
    // unreachable and this suite depending entirely on the client shim to stay
    // safe. This is the guard for that: reinstating the literal leaves it red.
    //
    // The run still SUCCEEDS, which is the point. The endpoint is only where
    // the submission goes; the verdict is read off the mainlog fixture, so the
    // recipient validation, the submission, the scan, the state file and the
    // throttle all run and are all judged exactly as they are for the default.
    // An override that quietly disabled the send would be caught by the exit
    // status and the argv both.
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
    // Exim writes Completed when the daemon is FINISHED with a message, which
    // includes one it gave up on: a bounce, a rejection and a discard all end
    // with the same line a successful delivery does. So this message carries
    // an off-host routing line, a permanent refusal and a Completed line all
    // under one id at once. Reading Completed first records a message the relay
    // refused as sent, writes the throttle state, and silences the next real
    // alert for thirty minutes - issue 848's own defect, arriving by the other
    // route. A terminal verdict is conclusive on sight; defer is not.
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
    // "unreadable", not the path: the path is interpolated into every one of
    // these reasons, so naming it cannot tell this route from the others. The
    // word is unique to the route where the log was never readable at all, so
    // it is what a run that took the readable route instead would lack.
    expect(run.stderr).toContain("unreadable");
    expect(existsSync(join(stateDir, unit))).toBe(false);
  });

  it("treats a mainlog that EXISTS but cannot be read as no delivery", () => {
    // The state the alert unit is in when its supplementary groups do not grant
    // the log: the file is there, with this run's routing and Completed lines
    // in it, and the script cannot open it. A check on existence rather than
    // readability would read those lines, find the delivery, and report an
    // alert that its own log says was refused as sent.
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
    // exim re-routes a message whose first attempt did not take, so a local
    // line under this id can be an attempt that was abandoned rather than the
    // decision. Reading it anyway reports a failed alert on a route that
    // delivered - the mirror image of the false green this check exists to
    // end, and the reason the LAST line is the one the script takes.
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
    // exim's log field table gives T three jobs: the TRANSPORT on a routing
    // line, the message SUBJECT on a reception line, and the transport again on
    // a deferred or failed line. The `== ... defer` line below is the spec's own
    // worked example of a deferral, and this message has no `=>` line at all -
    // exim never accepted it for delivery by any transport, and then Completed
    // it as the daemon finished with it. Both lines carrying a T= name a REMOTE
    // transport, so a script that read T= off any line would call this
    // delivered on the strength of a Completed line; reading it off a routing
    // line only leaves no evidence that anything left the host, and the run has
    // to fail. What that verdict is is not this case's business - a message
    // with no routing line has no transport to judge - and the run says which
    // it saw, which is the `defer`.
    //
    // A message that WAS routed off-host and then refused is a different case,
    // and it is judged by the refused verdict rather than by the missing
    // routing line: see "reports a bounced message as failed even though exim
    // Completed it".
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
    // Every other case sets OVERFLOW_ALERT_EXIM_WAIT_SECONDS, so nothing else in
    // this suite can see the number a deployed run actually waits - and no
    // assertion over an overridden value ever can. This leaves the variable out
    // of the environment entirely.
    //
    // The clock advances one second per reading, so the poll's LENGTH is the
    // budget: the default of 60 closes the deadline after 59 waits, and that
    // count is a record the run produces. It is what makes the "60s" below
    // more than an interpolated string - the run waited that long too. The
    // case after this is what pins that the deadline is computed FROM the
    // variable, which this one cannot: 60 written as a literal waits exactly
    // as long and reads identically.
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
    // The same hole as the budget default, one line above it in the script, and
    // every case in this suite sets the override - so nothing could see the
    // path a deployed run reads. The path is not cosmetic: exim rotates its
    // mainlog, so a default pointing at a rotation file reads yesterday's
    // messages, never finds this run's id, and fails every alert after the full
    // budget with CI green.
    //
    // The run therefore judges whatever /var/log/exim4/mainlog happens to be on
    // the machine, which cannot hold this fixture's id - the id is synthetic and
    // never appears in a real exim log - so the run fails, and the path it names
    // in the reason is the one it actually read.
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
    // The count of readings IS the budget: with the clock advancing a second
    // per reading, a 3-second budget closes the deadline after two waits. A
    // deadline computed from anything else - a literal, a constant, some other
    // variable - takes a different number of readings, and that is what
    // distinguishes `date +%s + exim_wait` from `date +%s + 60`. Reading the
    // budget back out of the reason string cannot make that distinction: a
    // literal beside the arithmetic leaves the string exactly as it was.
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
  // WHAT MAKES THIS SUITE SAFE, pinned as behaviour rather than as a convention.
  //
  // Nothing here submits a message, and the reason is one line of `runAlert`:
  // the client the script finds is a shim that opens no socket. That single fact
  // is the whole boundary, and until now nothing asserted it - a comment did,
  // and `sent` reported its consequences only after a run had already reached the
  // send stage on whatever client it found.
  //
  // The observable is therefore which `curl` the script RESOLVED, looked up the
  // way the script looks it up. Asserting that the spawn's environment contains
  // the fixture directory would only prove the string is there, not that the
  // lookup lands on it, and a PATH ordering mistake - the shim directory present
  // but second, behind /usr/bin - satisfies the string check and submits real
  // mail. So the check in `runAlert` resolves rather than pattern-matches.
  //
  // There is no case here asserting the positive half of that. The invariant
  // already resolves the client's PATH on every run and compares it to this
  // run's own fixture path with `toBe`, which is strictly stronger than a case
  // asserting the resolution "contains" a temp prefix and "is not"
  // /usr/bin/curl - a test that cannot fail while the invariant holds is
  // documentation wearing a test's clothes, and leaving one in place here would
  // be the same false signal this file exists to remove.
  it("resolves the system client when the fixture directory is not on the PATH at all", () => {
    // What makes the invariant discriminating rather than decorative: the same
    // lookup on a PATH WITHOUT the fixture directory lands on the real client.
    // That is precisely what a second spawn site added to this file would do by
    // default, because `PATH: "/usr/bin:/bin"` is the shape a bare spawn takes -
    // and it is the shape this file already uses for the two direct date-shim
    // spawns, which is why they are safe only by happening to run nothing that
    // looks for a client.
    //
    // The two bare-PATH spawns in this file are the date shim itself, reached
    // by absolute path, and they never run the script. The day one of them runs
    // the script instead, this is the resolution it would get.
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

  /**
   * 2 means "misconfiguration" here - argument count, recipient file, wait
   * budget - and it has to keep meaning only that, because it is the one status
   * a reader can classify by number alone. The client's own numbering has an
   * entry that collides with it: curl exits 2 when it cannot initialise, which
   * a caller cannot distinguish from this script's own refusal by status alone.
   */
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
    // The budget cases pin the number of readings a budget takes, and those
    // counts are only deterministic because the driven clock is ANCHORED -
    // base + counter*step, a pure function of the counter. Un-anchored it adds
    // the step to the REAL time on every reading, so however long this machine
    // takes to spawn a process leaks into the count.
    //
    // So this drives the shim itself rather than a run of the script: two
    // readings a real second apart, with a step of 1, must differ by exactly
    // 1. The un-anchored form returns floor(t2)+1 - floor(t1), which is >= 2
    // once a real second has passed, on ANY hardware - so it cannot satisfy
    // that assertion here. Detecting it through a poll instead would mean
    // leaning on a 59-iteration case drifting by two, which is about a 2x
    // margin on this box and nothing at all on a runner twice as fast per
    // spawn; the sibling case closes after two iterations and could not detect
    // it under any hardware.
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
