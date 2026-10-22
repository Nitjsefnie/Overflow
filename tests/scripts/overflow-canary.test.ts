import { spawn, spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([]);

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts", "overflow-canary.sh");
/**
 * The sibling script, read only where a property of BOTH is under test: the
 * verdict block they share byte for byte. Never executed here - the alert suite
 * drives it - so nothing in this file can pass on the alert script's
 * behaviour.
 */
const alertScriptPath = join(repositoryRoot, "scripts", "overflow-alert.sh");
const recipientAddress = "canary-recipient@example.test";

/**
 * Exim message ids are unique per message, and the stand-ins here share one
 * exim log. Handing two stand-ins the same id would let one run's Completed
 * line answer for another's message, so each stand-in is issued its own and a
 * test that needs a particular id asks for it.
 */
let issuedMessageIds = 0;
const nextMessageId = (): string =>
  `1xBuT1-000000003QH-${String(issuedMessageIds++).padStart(6, "0")}`;

const UNRELATED_COMPLETED =
  "2026-09-30 01:30:04 1xBuT1-000000001AA-1aA1 Completed\n";

/**
 * An id carrying both characters the JSON report must escape. A relay or a
 * host name that puts either in the id would otherwise produce a payload
 * Discord rejects, and the one report the operator needs is the one lost.
 */
const hostileMessageId = '1xBuT1-0000"\\0000QH-0Qqz';

const connectFailureDetail = (id: string): string =>
  `${id} Failed to connect to smtp.gmail.com [2a00:1450:4001:c21::6c]: Connection refused`;

/** The deferral section 53.9 records immediately after that detail line. */
const deferredRetry = (id: string): string =>
  `${id} == ${recipientAddress} R=smarthost T=remote_smtp_smarthost defer (1): Connection refused`;

const relayAnswerMentioningFailure = (id: string): string =>
  `${id} => ${recipientAddress} R=smarthost T=remote_smtp_smarthost H=smtp.gmail.com [2a00:1450:4001:c21::6c] TFO CV=yes DN="CN=smtp.gmail.com" A=plain K C="550 5.7.1 rejected: \\"bounce\\" threshold not reached"`;

const terminalRejectionQuotingAConnectFailure = (id: string): string =>
  `${id} ** rejected: RCPT TO:<${recipientAddress}>: 550 Failed to connect to mail1.example [192.0.2.1]: Connection refused`;

const lowercaseConnectFailure = (id: string): string =>
  `${id} failed to connect to socket 10.0.0.1 for remote_smtp_smarthost transport: Connection timed out`;

const detailLineBesideAQuotedFlag = (id: string): string =>
  `${id} => ${recipientAddress} R=smarthost T=remote_smtp_smarthost H=smtp.gmail.com [2a00:1450:4001:c21::6c] TFO CV=yes DN="CN=smtp.gmail.com" A=plain K C="** 5.7.1 blocked by policy" Failed to connect to smtp.gmail.com [2a00:1450:4001:c21::6c]: Connection refused`;

type RelayOutcome =
  | "completed"
  | "deferred"
  | "deferred-then-completed"
  | "deferred-then-terminal"
  | "deferred-then-connect-failure"
  | "terminal"
  | "terminal-blackhole"
  | "terminal-mentioning-connect-failure"
  | "lowercase-connect-failure"
  | "connect-failure-detail-beside-quoted-flag"
  | "terminal-discarded"
  | "retrying"
  | "retrying-then-completed"
  | "connect-failure-detail"
  | "smarthost-answer-mentions-failure";

interface SmtpStandIn {
  /** The smtp:// URL the script is pointed at. */
  url: string;
  /** The id this daemon accepts a submission under, as a real relay prints it. */
  messageId: string;
  /** Every message body the daemon accepted, in arrival order. */
  messages: string[];
  close: () => Promise<void>;
}

const scratchDirectories: string[] = [];

afterEach(async () => {
  for (const directory of scratchDirectories.splice(0)) {
    tempDirectories.dispose(directory);
  }
});

function scratch(prefix: string): string {
  const directory = tempDirectories.create(join(tmpdir(), `overflow-canary-${prefix}-`));
  scratchDirectories.push(directory);
  return directory;
}

function sharedScratch(prefix: string): string {
  return scratch(prefix);
}

interface WebhookStandIn {
  url: string;
  /** Every request body the webhook received, in arrival order. */
  posts: string[];
  close: () => Promise<void>;
}

async function startWebhook(options: { status?: number } = {}): Promise<WebhookStandIn> {
  const posts: string[] = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posts.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(options.status ?? 204).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/api/webhooks/overflow-canary`,
    posts,
    close: () => closeServer(server),
  };
}

function closeServer(server: HttpServer | NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await closeServer(probe);
  return port;
}

async function startSmtp(options: {
  outcome: RelayOutcome;
  logPath: string;
  messageId?: string;

  completeAfterMs?: number;
  /**
   * Write the smarthost's own `250 2.0.0 OK ... - gsmtp` acceptance line
   * before the `Completed` line, as exim records on the way out. Used to
   * reproduce the boundary case: the relay accepted the message and there is
   * nothing further to observe, whatever became of it afterwards.
   */
  smarthostAcceptLine?: boolean;

  logUnreadableForMs?: number;
}): Promise<SmtpStandIn> {
  const messageId = options.messageId ?? nextMessageId();
  const messages: string[] = [];
  let bufferedData: string[] = [];

  const pending: Promise<void>[] = [];

  const writeFailures: unknown[] = [];
  const server = createNetServer((socket) => {
    let buffer = "";
    let inData = false;

    const logLine = (body: string): void => {
      writeFileSync(options.logPath, `2026-09-30 03:20:04 ${body}\n`, {
        flag: "a",
      });
      if (options.logUnreadableForMs !== undefined) {
        denyReadToChild(options.logPath);
        // Tracked like every other write this fixture makes, so `close` waits
        // for the restore rather than the fixture directory dying under a timer
        // that then writes to a path that is gone.
        pending.push(
          new Promise<void>((resolve) => {
            setTimeout(() => {
              try {
                grantReadToChild(options.logPath);
              } catch (error) {
                writeFailures.push(error);
              } finally {
                resolve();
              }
            }, options.logUnreadableForMs);
          }),
        );
      }
    };

    socket.setEncoding("utf8");
    socket.write("220 overflow-canary.test ESMTP\r\n");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;

      let newline = buffer.indexOf("\r\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            const logLater = (body: string): void => {
              if (options.completeAfterMs === undefined) {
                logLine(body);
                return;
              }
              pending.push(
                new Promise<void>((resolve) => {
                  setTimeout(() => {
                    try {
                      logLine(body);
                    } catch (error) {
                      writeFailures.push(error);
                    } finally {
                      resolve();
                    }
                  }, options.completeAfterMs);
                }),
              );
            };
            const logCompletedLater = (): void => {
              logLater(`${messageId} Completed`);
            };

            if (options.outcome === "deferred-then-terminal") {
              // A defer, and then an outcome that ends the message. The first
              // poll iteration can only see the defer, so a search that
              // settles on the first verdict it meets will report `defer` for
              // the whole budget and name the wrong cause.
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(`${messageId} ** defer: 450 Greylisted, retrying later`);
              logLater(
                `${messageId} ** bounce: <canary@example.test>: 550 5.1.1 mailbox unavailable`,
              );
            } else if (options.outcome === "terminal") {
              // A bare terminal outcome with no defer in front of it. The
              // suite previously wrote only `** defer` lines, so nothing
              // pinned what a terminal verdict does on its own.
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(
                `${messageId} *** rejected RCPT <canary@example.test>: 550 5.1.1 unknown user`,
              );
            } else if (options.outcome === "terminal-blackhole") {

              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(`${messageId} ** blackhole: <> <canary@example.test>`);
            } else if (options.outcome === "terminal-discarded") {
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(`${messageId} ** discarded: <> <canary@example.test>`);
            } else if (options.outcome === "deferred-then-completed") {

              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(
                `${messageId} ** defer rejected: greylisted, retrying in 120 seconds`,
              );
              logCompletedLater();
            } else if (options.outcome === "retrying") {
              // Section 53.9's shape, whole: a connection the smarthost
              // refused, the detail line exim writes for it, and the defer
              // that leaves the message queued. Nothing ends the message, so
              // nothing here may end the poll.
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(connectFailureDetail(messageId));
              logLine(deferredRetry(messageId));
            } else if (options.outcome === "retrying-then-completed") {

              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(connectFailureDetail(messageId));
              logLine(deferredRetry(messageId));
              logCompletedLater();
            } else if (options.outcome === "terminal-mentioning-connect-failure") {
              // A bounce, whose reason text quotes a refused socket. The run
              // must conclude on sight and name the rejection, not wait out
              // the budget naming a retry.
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(terminalRejectionQuotingAConnectFailure(messageId));
            } else if (options.outcome === "connect-failure-detail-beside-quoted-flag") {
              // One line, no flag, a `**` the RELAY wrote inside its own quoted
              // answer, and the detail text outside it.
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(detailLineBesideAQuotedFlag(messageId));
            } else if (options.outcome === "lowercase-connect-failure") {
              // The same refused socket in this build's other spelling, and on
              // its own. It ends nothing, and it carries none of the terminal
              // keywords, so the run waits its budget out with no verdict to
              // report.
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(lowercaseConnectFailure(messageId));
            } else if (options.outcome === "deferred-then-connect-failure") {

              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(`${messageId} ** defer rejected: greylisted, please retry`);
              logLine(connectFailureDetail(messageId));
              logLine(deferredRetry(messageId));
            } else if (options.outcome === "connect-failure-detail") {
              // The detail line with no deferral behind it, which is what the
              // log holds in the window between the refused attempt and the
              // deferral exim writes for it. Nothing here ends the message,
              // and nothing here may end the poll.
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(connectFailureDetail(messageId));
            } else if (options.outcome === "smarthost-answer-mentions-failure") {

              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(relayAnswerMentioningFailure(messageId));
              logLine(deferredRetry(messageId));
              logCompletedLater();
            } else if (options.outcome === "completed") {
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              if (options.smarthostAcceptLine) {
                // What a real relay records on the way out: the smarthost's
                // own 250, which is the acceptance the canary reads. Written
                // with the same id so the run's verdict is decided on a log
                // that looks like the host's rather than a single word.
                logLine(`${messageId} => 250 2.0.0 OK m30pf4687394wrt.42 - gsmtp`);
              }
              logCompletedLater();
            } else {
              logLine(
                `${messageId} ** defer rejected: temporary failure in the relay's upstream connection`,
              );
            }
            socket.write(`250 OK id=${messageId}\r\n`);
          } else {
            bufferedData.push(line);
          }
        } else {
          const command = (line.split(" ")[0] ?? "").toUpperCase();

          if (command === "EHLO" || command === "HELO") {
            socket.write("250 overflow-canary.test\r\n");
          } else if (command === "DATA") {
            inData = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (command === "QUIT") {
            socket.write("221 Bye\r\n");
            socket.end();
          } else {
            socket.write("250 OK\r\n");
          }
        }

        newline = buffer.indexOf("\r\n");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `smtp://127.0.0.1:${port}`,
    messageId,
    messages,
    close: async () => {

      try {
        await closeServer(server);
      } finally {
        await Promise.all(pending);
        if (writeFailures.length > 0) throw writeFailures[0];
      }
    },
  };
}

interface CanaryRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface CanaryFixture {
  directory: string;
  stateDir: string;
  eximLog: string;
  recipientFile: string;
  webhookFile: string;
  marker: string;
  /**
   * The canary-fault marker: a separate file from `marker`, because it records
   * a different thing. `marker` means a real outage of the failure-alert path
   * was reported; this one means the canary itself could not run.
   */
  faultMarker: string;
}

interface FixtureOptions {
  /**
   * The recipient file's contents, or `null` to leave the file absent — a
   * case the script must refuse, and one `undefined` cannot express: absent
   * here means "write the valid default", not "do not create the file".
   */
  recipient?: string | null;
  /** The webhook file's contents, or `null` to leave the file absent. */
  webhook?: string | null;
  /** Seeds the dead-streak marker, standing in for a reported outage still open. */
  alreadyMarked?: boolean;
}

/**
 * A scratch recipient file, webhook file, state directory and exim log. The
 * webhook default is a loopback URL that is deliberately not a server: a test
 * that never expects a post must not need one, and a test that expects the
 * script to refuse an unreachable channel has one to point at.
 */
function makeFixture(options: FixtureOptions = {}): CanaryFixture {
  const directory = sharedScratch("fixture");
  const stateDir = join(directory, "state");
  const eximLog = join(directory, "exim-mainlog");
  const recipientFile = join(directory, "canary-recipient");
  const webhookFile = join(directory, "canary-webhook");

  writeFileSync(eximLog, UNRELATED_COMPLETED);
  if (options.recipient !== null) {
    writeFileSync(recipientFile, options.recipient ?? `${recipientAddress}\n`);
  }
  if (options.webhook !== null) {
    writeFileSync(webhookFile, options.webhook ?? "http://127.0.0.1:1/unused\n");
  }

  const fixture: CanaryFixture = {
    directory,
    stateDir,
    eximLog,
    recipientFile,
    webhookFile,
    marker: join(stateDir, "dead"),
    faultMarker: join(stateDir, "canary-fault"),
  };

  if (options.alreadyMarked) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(fixture.marker, "2026-09-29T03:20:04Z\n");
  }

  return fixture;
}

const SUITE_RUNS_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** The uid/gid the script is dropped to when the suite runs as root. */
const UNPRIVILEGED_IDENTITY = { uid: 65534, gid: 65534 } as const;

/**
 * Locks a log to the mode the deployed unit could not read: owner and group
 * only, root-owned, and no permission at all for anyone else.
 */
function denyReadToChild(logPath: string): void {
  if (SUITE_RUNS_AS_ROOT) {
    chownSync(logPath, 0, 0);
    chmodSync(logPath, 0o640);
  } else {
    chmodSync(logPath, 0o000);
  }
}

/** Puts the log back the way the fixture wrote it: readable by everyone. */
function grantReadToChild(logPath: string): void {
  chmodSync(logPath, 0o644);
}

/**
 * Opens a fixture to the dropped identity. A `mkdtemp` directory is 0700, so
 * without this the child could not even reach the files - and a fixture that
 * fails for want of a directory it cannot enter would be a false green, so
 * only the parts a 0640 log actually needs are widened.
 */
function openFixtureToDroppedIdentity(fixture: CanaryFixture): void {
  if (!SUITE_RUNS_AS_ROOT) return;

  chmodSync(fixture.directory, 0o755);
  mkdirSync(fixture.stateDir, { recursive: true });
  chmodSync(fixture.stateDir, 0o777);
  chmodSync(fixture.recipientFile, 0o644);
  chmodSync(fixture.webhookFile, 0o644);
}

function expectUnreadableToChild(logPath: string): void {
  const probe = spawnSync("/bin/sh", ["-c", '[ -r "$1" ] && exit 0; exit 3', "sh", logPath], {
    encoding: "utf8",
    ...(SUITE_RUNS_AS_ROOT ? UNPRIVILEGED_IDENTITY : {}),
  });

  expect(
    probe.status,
    `${logPath} is still readable to the identity the script runs as, so the fixture does not reproduce the deployed failure`,
  ).toBe(3);
}

function runCanary(
  fixture: CanaryFixture,
  options: {
    smtpUrl: string;
    waitSeconds?: number | string;
    shimBin?: string;
    /**
     * Run the script as the identity `denyReadToChild` locked the log against.
     * A no-op where the suite cannot setuid, where the lock is on the file's
     * own owner instead.
     */
    asDroppedIdentity?: boolean;
  },
): Promise<CanaryRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [scriptPath], {
      ...(options.asDroppedIdentity === true && SUITE_RUNS_AS_ROOT ? UNPRIVILEGED_IDENTITY : {}),
      env: {
        NODE_ENV: "test",
        PATH: options.shimBin
          ? `${options.shimBin}:/usr/local/bin:/usr/bin:/bin`
          : "/usr/local/bin:/usr/bin:/bin",
        OVERFLOW_CANARY_RECIPIENT_FILE: fixture.recipientFile,
        OVERFLOW_CANARY_WEBHOOK_FILE: fixture.webhookFile,
        OVERFLOW_CANARY_STATE_DIR: fixture.stateDir,
        OVERFLOW_CANARY_EXIM_LOG: fixture.eximLog,
        OVERFLOW_CANARY_SMTP_URL: options.smtpUrl,
        OVERFLOW_CANARY_EXIM_WAIT_SECONDS: String(options.waitSeconds ?? 0),
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, closingSignal) => {
      expect(closingSignal, `killed by ${closingSignal}: ${stderr}`).toBeNull();
      resolve({ status, stdout, stderr });
    });
  });
}

const TERMINAL_BUDGET_SECONDS = 20;
const TERMINAL_BOUND_MS = (TERMINAL_BUDGET_SECONDS * 1000) / 2;

/**
 * The budget the retrying cases are waited out on. It is not the deployed one
 * and does not need to be: what those cases assert is that the poll did not
 * stop at the first thing it read, and a terminal verdict breaks out at once
 * whatever the budget is.
 */
const RETRYING_BUDGET_SECONDS = 3;

function reportedVerdict(reported: string): string | undefined {
  return /recorded (.+?) for /.exec(reported)?.[1];
}

/** `runCanary`, with the wall clock alongside it, for the elapsed assertions. */
async function runTimed(
  fixture: CanaryFixture,
  options: { smtpUrl: string; waitSeconds?: number | string; shimBin?: string },
): Promise<{ run: CanaryRun; elapsed: number }> {
  const startedAt = Date.now();
  const run = await runCanary(fixture, options);

  return { run, elapsed: Date.now() - startedAt };
}

/**
 * Asserts a terminal outcome concluded the poll rather than running out the
 * budget. Shared by both terminal fixtures so the property is stated once and
 * neither shape is the other's sole pin.
 */
function expectConcludedBeforeTheBudget(elapsedMs: number): void {
  expect(
    elapsedMs,
    `a terminal outcome must conclude the poll, not run out the ${TERMINAL_BUDGET_SECONDS}s budget`,
  ).toBeLessThan(TERMINAL_BOUND_MS);
}

beforeAll(() => {
  // A shim would stub out the very handshake the verdict rests on, so the
  // suite needs the real client. Probed rather than skipped: a runner without
  // curl is a broken environment, not a suite with nothing to say.
  const probe = spawnSync("/bin/sh", ["-c", "command -v curl"], {
    encoding: "utf8",
  });

  expect(
    probe.status,
    "this suite drives the real curl and needs it on PATH",
  ).toBe(0);
});

describe("overflow-canary.sh recipient validation", () => {
  it.each([
    ["missing", null, "is missing or unreadable"],
    ["empty", "", "is empty"],
    ["no @", "bare-host.example\n", "carries no @"],
    [
      "two lines",
      `${recipientAddress}\ninjected@example.test\n`,
      "carries more than one line",
    ],
    [
      "a carriage return",
      `${recipientAddress}\rinjected`,
      "carries more than one line",
    ],
  ])(
    "refuses a recipient file that is %s: exits 2 naming the file",
    async (_label, recipient, message) => {
      const fixture = makeFixture({ recipient });
      const smtp = await startSmtp({
        outcome: "completed",
        logPath: fixture.eximLog,
      });

      try {
        const run = await runCanary(fixture, { smtpUrl: smtp.url });

        expect(run.status).toBe(2);
        expect(run.stderr).toContain(message);
        // The refusal names the file and the reason, never the value: the
        // recipient file is host configuration, and the journal is exactly
        // where such a value ends up pasted into an issue or a status page.
        if (typeof recipient === "string" && recipient !== "") {
          expect(run.stderr, "the recipient value must not reach the journal").not.toContain(
            recipient.trim(),
          );
        }
        expect(smtp.messages, "the send stage must not be reached").toEqual([]);
      } finally {
        await smtp.close();
      }
    },
  );
});

describe("overflow-canary.sh webhook validation", () => {
  it.each([
    ["missing", null, "is missing or unreadable"],
    ["empty", "", "is empty"],
    [
      "two lines",
      "https://example.test/a\nhttps://example.test/b\n",
      "carries more than one line",
    ],
  ])(
    "refuses a webhook file that is %s: exits 2 naming the file, before any submission",
    async (_label, webhook, message) => {
      const fixture = makeFixture({ webhook });
      const smtp = await startSmtp({
        outcome: "completed",
        logPath: fixture.eximLog,
      });

      try {
        const run = await runCanary(fixture, { smtpUrl: smtp.url });

        expect(run.status).toBe(2);
        expect(run.stderr).toContain(message);
        expect(
          smtp.messages,
          "a canary that cannot report must not report health through the channel it lacks",
        ).toEqual([]);
      } finally {
        await smtp.close();
      }
    },
  );
});

describe("overflow-canary.sh on a healthy path", () => {
  it("exits 0, posts nothing, and records no dead-streak marker", async () => {
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "completed",
      logPath: fixture.eximLog,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url });

      expect(run.status).toBe(0);
      expect(webhook.posts, "a healthy run must not page anyone").toEqual([]);
      expect(existsSync(fixture.marker)).toBe(false);
      expect(run.stderr).toContain(smtp.messageId);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("submits a message distinguishable from a failure alert's, naming the host and the moment", async () => {
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "completed",
      logPath: fixture.eximLog,
    });

    try {
      await runCanary(fixture, { smtpUrl: smtp.url });

      expect(smtp.messages).toHaveLength(1);
      const mail = smtp.messages[0]!;
      expect(mail).toContain(`To: ${recipientAddress}`);
      // The marker, not a shared prefix. A mailbox rule that pages on
      // "[overflow]" - a common shape on exactly this kind of host - would
      // otherwise page once a day on a message whose own body says no action
      // is needed, which is worse than not paging at all.
      expect(mail).toMatch(/^Subject: \[overflow-canary\] /m);
      expect(mail).not.toMatch(/^Subject: \[overflow\] /m);
      expect(mail).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("waits for a slow relay rather than giving up on the first read", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "completed",
      logPath: fixture.eximLog,
      completeAfterMs: 1500,
    });

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: 30,
      });

      expect(run.status).toBe(0);
      expect(webhook.posts, "a slow but successful relay must not page anyone").toEqual([]);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("keeps polling to the budget, and reports, when Completed never arrives", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "deferred", logPath: fixture.eximLog });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url, waitSeconds: 2 });

      expect(run.status).toBe(1);
      expect(
        webhook.posts,
        "a message the relay never completed is a dead alert path, and must be reported",
      ).toHaveLength(1);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });
});

describe("overflow-canary.sh on a dead path", () => {
  it("fails when the submission cannot be made at all, and reports it once", async () => {
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const port = await closedPort();

    try {
      const run = await runCanary(fixture, {
        smtpUrl: `smtp://127.0.0.1:${port}`,
      });

      expect(run.status).toBe(1);
      expect(webhook.posts).toHaveLength(1);
      expect(existsSync(fixture.marker), "a reported outage is recorded").toBe(
        true,
      );

      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toContain("[overflow]");
      expect(report.content).toContain("canary");
    } finally {
      await webhook.close();
    }
  });

  it("fails when the relay accepted the message and never completed it", async () => {
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred",
      logPath: fixture.eximLog,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url });

      expect(
        run.status,
        "a defer on the smarthost leg is a dead alert path",
      ).toBe(1);
      expect(
        smtp.messages,
        "the local daemon did accept the message",
      ).toHaveLength(0);
      expect(webhook.posts).toHaveLength(1);

      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toContain(smtp.messageId);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("fails when a submission is accepted without an id, because there is nothing to follow", async () => {
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);

    // A relay that answers the end of DATA with a bare 250: the submission
    // succeeded and no id exists, so no Completed line can ever be found. A
    // run that read that as health would report a dead path as fine forever.
    const server = createNetServer((socket) => {
      let buffer = "";
      let inData = false;
      socket.setEncoding("utf8");
      socket.write("220 overflow-canary.test ESMTP\r\n");
      socket.on("error", () => {});
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\r\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 OK\r\n");
            }
          } else {
            const command = (line.split(" ")[0] ?? "").toUpperCase();
            if (command === "EHLO" || command === "HELO")
              socket.write("250 overflow-canary.test\r\n");
            else if (command === "DATA") {
              inData = true;
              socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
            } else if (command === "QUIT") {
              socket.write("221 Bye\r\n");
              socket.end();
            } else socket.write("250 OK\r\n");
          }
          newline = buffer.indexOf("\r\n");
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;

    try {
      const run = await runCanary(fixture, {
        smtpUrl: `smtp://127.0.0.1:${port}`,
      });

      expect(run.status).toBe(1);
      expect(webhook.posts).toHaveLength(1);
    } finally {
      await closeServer(server);
      await webhook.close();
    }
  });

  it("escapes a backslash and a quote in the report, so the payload still parses", async () => {
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred",
      logPath: fixture.eximLog,
      messageId: hostileMessageId,
    });

    try {
      await runCanary(fixture, { smtpUrl: smtp.url });

      expect(webhook.posts).toHaveLength(1);
      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toContain(hostileMessageId);
      expect(webhook.posts[0]!.startsWith("{")).toBe(true);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });
});

describe("overflow-canary.sh dead-streak dedup", () => {
  it("posts once across two consecutive dead runs", async () => {
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred",
      logPath: fixture.eximLog,
    });

    try {
      const first = await runCanary(fixture, { smtpUrl: smtp.url });
      expect(first.status).toBe(1);

      const second = await runCanary(fixture, { smtpUrl: smtp.url });

      expect(
        second.status,
        "a dead path still exits nonzero, so the unit lands in failed",
      ).toBe(1);
      expect(
        webhook.posts,
        "one outage must not become a page a day",
      ).toHaveLength(1);
      expect(second.stderr).toContain("marker");
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("posts nothing when the outage was already reported and the submission now fails outright", async () => {
    const fixture = makeFixture({ alreadyMarked: true });
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const port = await closedPort();

    try {
      const run = await runCanary(fixture, {
        smtpUrl: `smtp://127.0.0.1:${port}`,
      });

      expect(run.status).toBe(1);
      expect(webhook.posts).toEqual([]);
    } finally {
      await webhook.close();
    }
  });

  it("re-arms after a success, so the next failure reports again", async () => {
    const fixture = makeFixture({ alreadyMarked: true });
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const healthy = await startSmtp({
      outcome: "completed",
      logPath: fixture.eximLog,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: healthy.url });

      expect(run.status).toBe(0);
      expect(
        existsSync(fixture.marker),
        "a healthy run clears the recorded outage",
      ).toBe(false);
    } finally {
      await healthy.close();
    }

    const dead = await startSmtp({
      outcome: "deferred",
      logPath: fixture.eximLog,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: dead.url });

      expect(run.status).toBe(1);
      expect(
        webhook.posts,
        "a fresh failure after a healthy run must report again",
      ).toHaveLength(1);
    } finally {
      await dead.close();
      await webhook.close();
    }
  });

  it("leaves the marker unwritten when the out-of-band report cannot be delivered", async () => {
    // A dead mail path plus a dead webhook is the state this canary exists to
    // be visible in. Recording the outage without having told anyone would
    // silence the next run for good, which is the failure being guarded
    // against rather than a repetition of it.
    const fixture = makeFixture();
    writeFileSync(
      fixture.webhookFile,
      `http://127.0.0.1:${await closedPort()}/unreachable\n`,
    );
    const smtp = await startSmtp({
      outcome: "deferred",
      logPath: fixture.eximLog,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url });

      expect(run.status).toBe(1);
      expect(existsSync(fixture.marker)).toBe(false);
      expect(run.stderr).toContain("out-of-band report");
    } finally {
      await smtp.close();
    }
  });

  it.each([
    ["404", 404],
    ["401", 401],
  ])(
    "records nothing when the webhook answers %s, so the next run reports again",
    async (_label, status) => {

      const fixture = makeFixture();
      const webhook = await startWebhook({ status });
      writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
      const smtp = await startSmtp({
        outcome: "deferred",
        logPath: fixture.eximLog,
      });

      try {
        const run = await runCanary(fixture, { smtpUrl: smtp.url });

        expect(webhook.posts, "the attempt is still made").toHaveLength(1);
        expect(existsSync(fixture.marker), "a refused report must not silence the streak").toBe(
          false,
        );
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("could not be delivered");
      } finally {
        await smtp.close();
        await webhook.close();
      }
    },
  );

  it("still records the outage when the webhook accepts the report", async () => {
    // The counterpart to the two above: a 204 is a real delivery and must keep
    // the dedup working, or the canary would page every day of an outage.
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred",
      logPath: fixture.eximLog,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url });

      expect(webhook.posts).toHaveLength(1);
      expect(existsSync(fixture.marker), "a delivered report is recorded").toBe(true);
      expect(run.status).toBe(1);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });
});

describe("overflow-canary.sh verdict discrimination", () => {
  it("judges the relay verdict by this run's own id, not by any Completed line in the log", async () => {
    // The log is seeded with an unrelated message that DID complete. A run
    // that grepped for Completed alone would call this path healthy while the
    // canary's own message was sitting deferred.
    const fixture = makeFixture();
    expect(readFileSync(fixture.eximLog, "utf8")).toBe(UNRELATED_COMPLETED);

    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred",
      logPath: fixture.eximLog,
      messageId: "1xBuT1-000000009ZZ-9tT9",
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url });

      expect(run.status).toBe(1);
      expect(webhook.posts).toHaveLength(1);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("names the relay's own verdict when the log records a defer for the id", async () => {
    // The absence of Completed already makes this a failure, but the report
    // an operator reads at three in the morning should say what the relay
    // actually said, rather than restating our own timeout. The caught classes
    // are therefore named in the code, not only implied by a missing word.
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "deferred", logPath: fixture.eximLog });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url, waitSeconds: 1 });

      expect(run.status).toBe(1);
      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toContain("defer");
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("a message the relay defers and then completes on retry is not reported dead", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred-then-completed",
      logPath: fixture.eximLog,
      completeAfterMs: 1200,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url, waitSeconds: 30 });

      expect(run.status).toBe(0);
      expect(
        webhook.posts,
        "a message the relay delivered on retry must not page anyone",
      ).toEqual([]);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("names the terminal outcome when a defer is followed by a bounce", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred-then-terminal",
      logPath: fixture.eximLog,
      completeAfterMs: 300,
    });

    try {
      const { run, elapsed } = await runTimed(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: TERMINAL_BUDGET_SECONDS,
      });

      expect(run.status).toBe(1);
      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content, "the terminal outcome is the cause").toContain("bounce");
      expect(report.content, "the provisional one must not mask it").not.toContain("defer");
      expectConcludedBeforeTheBudget(elapsed);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reports a terminal outcome on its own without spending the budget", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "terminal", logPath: fixture.eximLog });

    try {
      const { run, elapsed } = await runTimed(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: TERMINAL_BUDGET_SECONDS,
      });

      expect(run.status).toBe(1);
      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toContain("rejected");
      expectConcludedBeforeTheBudget(elapsed);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reads as healthy when the smarthost accepted a message to a mailbox that no longer exists", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "completed",
      logPath: fixture.eximLog,
      smarthostAcceptLine: true,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url });

      expect(run.status).toBe(0);
      expect(webhook.posts, "nothing here is knowably wrong, so nobody is paged").toEqual([]);
      expect(readFileSync(fixture.eximLog, "utf8")).toContain(smtp.messageId);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });
});

describe("overflow-canary.sh when the exim log cannot be read", () => {

  const RELAY_VERDICT_CLAIMS = [/Completed/, /did not take the message/, /the smarthost/];

  it("refuses before submitting anything, and reports the canary itself rather than the relay", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "completed", logPath: fixture.eximLog });
    openFixtureToDroppedIdentity(fixture);
    denyReadToChild(fixture.eximLog);
    expectUnreadableToChild(fixture.eximLog);

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        asDroppedIdentity: true,
      });

      expect(run.status).toBe(2);
      expect(run.stderr).toContain(fixture.eximLog);
      expect(run.stderr).toMatch(/not readable/);
      for (const claim of RELAY_VERDICT_CLAIMS) {
        expect(run.stderr, "an unreadable log is not a verdict about the relay").not.toMatch(
          claim,
        );
      }
      expect(
        smtp.messages,
        "a run that cannot read the verdict must not send a message nobody can interpret",
      ).toEqual([]);
      expect(webhook.posts, "a canary that cannot check must still say so once").toHaveLength(1);

      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toContain("[overflow]");
      expect(report.content).toMatch(/cannot run/);
      expect(report.content).toContain(fixture.eximLog);
      for (const claim of RELAY_VERDICT_CLAIMS) {
        expect(report.content, "the refusal must not page about the relay").not.toMatch(claim);
      }
      expect(
        report.content,
        "the outage header is the false page; the refusal must not borrow it",
      ).not.toContain("not delivering");
      expect(
        existsSync(fixture.marker),
        "the dead-streak marker means a real outage was reported, and none was",
      ).toBe(false);
      expect(existsSync(fixture.faultMarker), "the refusal has its own dedup state").toBe(true);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("names the unreadable log when it goes dark mid-poll, and still claims nothing about the relay", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred",
      logPath: fixture.eximLog,
      logUnreadableForMs: 10_000,
    });
    openFixtureToDroppedIdentity(fixture);

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: 2,
        asDroppedIdentity: true,
      });

      expect(run.status).toBe(2);
      expect(run.stderr).toContain(fixture.eximLog);
      expect(run.stderr).toMatch(/not readable/);
      // The submission DID reach the daemon - the id exists, which is the
      // difference from the pre-flight case and the reason this is not the
      // same refusal.
      expect(
        run.stderr,
        "the message was accepted, so the run knows the id whose verdict it cannot take",
      ).toContain(smtp.messageId);
      for (const claim of RELAY_VERDICT_CLAIMS) {
        expect(run.stderr, "an unreadable log is not a verdict about the relay").not.toMatch(
          claim,
        );
      }
      expect(webhook.posts, "a canary that cannot check must still say so once").toHaveLength(1);

      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toMatch(/cannot run/);
      for (const claim of RELAY_VERDICT_CLAIMS) {
        expect(report.content, "the refusal must not page about the relay").not.toMatch(claim);
      }
      expect(
        report.content,
        "the outage header is the false page; the refusal must not borrow it",
      ).not.toContain("not delivering");
      expect(
        existsSync(fixture.marker),
        "the dead-streak marker means a real outage was reported, and none was",
      ).toBe(false);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reports a persistently broken canary once, under its own state, and re-arms on health", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "completed", logPath: fixture.eximLog });
    openFixtureToDroppedIdentity(fixture);
    denyReadToChild(fixture.eximLog);

    try {
      const first = await runCanary(fixture, {
        smtpUrl: smtp.url,
        asDroppedIdentity: true,
      });
      const second = await runCanary(fixture, {
        smtpUrl: smtp.url,
        asDroppedIdentity: true,
      });

      expect(first.status).toBe(2);
      expect(second.status).toBe(2);
      expect(webhook.posts, "one broken canary is one report, not one a day").toHaveLength(1);
      expect(second.stderr).toMatch(/canary-fault marker/);

      // Readable again, and the relay is fine: the fault is over and must not
      // hold the next failure back.
      grantReadToChild(fixture.eximLog);
      const healthy = await runCanary(fixture, {
        smtpUrl: smtp.url,
        asDroppedIdentity: true,
      });

      expect(healthy.status).toBe(0);
      expect(
        existsSync(fixture.faultMarker),
        "a run that reached a verdict is the only thing that retires the fault",
      ).toBe(false);
      expect(webhook.posts, "a healthy run reports nothing").toHaveLength(1);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reports the outage again after a stretch of blindness, rather than honouring a marker from before it", async () => {

    const fixture = makeFixture({ alreadyMarked: true });
    const recordedOutage = readFileSync(fixture.marker, "utf8");
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "completed", logPath: fixture.eximLog });
    openFixtureToDroppedIdentity(fixture);
    denyReadToChild(fixture.eximLog);

    try {
      const blind = await runCanary(fixture, {
        smtpUrl: smtp.url,
        asDroppedIdentity: true,
      });

      expect(blind.status).toBe(2);
      expect(webhook.posts, "the blindness is reported on its own line").toHaveLength(1);
      expect(
        readFileSync(fixture.marker, "utf8"),
        "a fault in the check neither writes nor disturbs the recorded outage",
      ).toBe(recordedOutage);
      expect(existsSync(fixture.faultMarker)).toBe(true);

      grantReadToChild(fixture.eximLog);
      const dead = await startSmtp({ outcome: "deferred", logPath: fixture.eximLog });

      try {
        const outage = await runCanary(fixture, {
          smtpUrl: dead.url,
          asDroppedIdentity: true,
        });

        expect(outage.status).toBe(1);
        expect(webhook.posts, "the outage behind the blindness must be reported").toHaveLength(2);
        const report = JSON.parse(webhook.posts[1]!) as { content: string };
        expect(report.content).toContain("not delivering");
        expect(
          existsSync(fixture.faultMarker),
          "the fault has been accounted for by the report that followed it",
        ).toBe(false);

        // And the streak is re-anchored: a third dead run is the same message.
        const again = await runCanary(fixture, {
          smtpUrl: dead.url,
          asDroppedIdentity: true,
        });

        expect(again.status).toBe(1);
        expect(webhook.posts, "one outage, one report").toHaveLength(2);
      } finally {
        await dead.close();
      }
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reports the outage when the fault marker is empty, rather than trusting a stamp it cannot read", async () => {

    const fixture = makeFixture({ alreadyMarked: true });
    writeFileSync(fixture.faultMarker, "");
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "deferred", logPath: fixture.eximLog });
    openFixtureToDroppedIdentity(fixture);

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        asDroppedIdentity: true,
      });

      expect(run.status).toBe(1);
      expect(
        webhook.posts,
        "a fault marker the run cannot read a stamp out of must not silence the outage",
      ).toHaveLength(1);
      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toContain("not delivering");
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reports the timeout, not the unreadable log, when the gap closes inside the budget", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred",
      logPath: fixture.eximLog,
      logUnreadableForMs: 400,
    });
    openFixtureToDroppedIdentity(fixture);

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: 3,
        asDroppedIdentity: true,
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/defer/);
      expect(
        run.stderr,
        "the log was readable again before the budget closed, so the unreadable reason is stale",
      ).not.toMatch(/not readable/);
      expect(webhook.posts, "a relay that never Completed the message is a real outage").toHaveLength(
        1,
      );
      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toContain("defer");
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });
});
describe("overflow-canary.sh on a message the relay is retrying", () => {
  it("keeps polling past a refused connection and reports the retry at the budget", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "retrying", logPath: fixture.eximLog });
    const recorder = waitRecorder();

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: RETRYING_BUDGET_SECONDS,
        shimBin: recorder.shimBin,
      });

      expect(run.status).toBe(1);
      expect(
        webhook.posts,
        "a message the relay never Completed is a dead alert path, retrying or not",
      ).toHaveLength(1);
      expect(existsSync(fixture.marker)).toBe(true);
      expect(
        recorder.waits(),
        "a refused connection is a detail line, and must not end the poll on sight",
      ).toBeGreaterThan(0);

      expect(reportedVerdict(JSON.parse(webhook.posts[0]!).content)).toBe(
        "Failed to connect to",
      );
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("keeps the FIRST provisional outcome when the retry's refusal is logged after it", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred-then-connect-failure",
      logPath: fixture.eximLog,
    });
    const recorder = waitRecorder();

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: RETRYING_BUDGET_SECONDS,
        shimBin: recorder.shimBin,
      });

      expect(run.status).toBe(1);
      expect(webhook.posts).toHaveLength(1);
      expect(
        recorder.waits(),
        "a refused connection is not a verdict whatever else the log already holds",
      ).toBeGreaterThan(0);
      expect(reportedVerdict(JSON.parse(webhook.posts[0]!).content)).toBe("defer");
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reports a message delivered on the retry as healthy, though the refused attempt was logged first", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "retrying-then-completed",
      logPath: fixture.eximLog,
      completeAfterMs: 1200,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url, waitSeconds: 30 });

      expect(run.status).toBe(0);
      expect(webhook.posts, "a message delivered on retry must not page anyone").toEqual([]);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("keeps polling on the refused connection alone, with no deferral behind it", async () => {
    // The window between the refused attempt and the deferral exim writes for
    // it, which is what the log holds whenever the run reads it early. Nothing
    // in it ends the message, so nothing in it may end the poll - the same
    // treatment a defer already gets.
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "connect-failure-detail",
      logPath: fixture.eximLog,
    });
    const recorder = waitRecorder();

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: RETRYING_BUDGET_SECONDS,
        shimBin: recorder.shimBin,
      });

      expect(run.status).toBe(1);
      expect(webhook.posts).toHaveLength(1);
      expect(
        recorder.waits(),
        "the detail line on its own is no more a verdict than one behind a defer",
      ).toBeGreaterThan(0);
      // Same obligation with nothing behind it to name: the only thing the
      // log holds is the refused connection, so it is the only thing the
      // report can be about.
      expect(reportedVerdict(JSON.parse(webhook.posts[0]!).content)).toBe(
        "Failed to connect to",
      );
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("does not read a terminal word out of the relay's own quoted answer", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "smarthost-answer-mentions-failure",
      logPath: fixture.eximLog,
      completeAfterMs: 1200,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url, waitSeconds: 30 });

      expect(run.status).toBe(0);
      expect(webhook.posts, "the relay's own words are not a verdict").toEqual([]);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });
});

describe("overflow-canary.sh when the flag and the words disagree", () => {
  it("concludes on a rejection whose reason text names a refused socket", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "terminal-mentioning-connect-failure",
      logPath: fixture.eximLog,
    });

    try {
      const { run, elapsed } = await runTimed(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: TERMINAL_BUDGET_SECONDS,
      });

      expect(run.status).toBe(1);
      expect(reportedVerdict(JSON.parse(webhook.posts[0]!).content)).toBe("rejected");
      expectConcludedBeforeTheBudget(elapsed);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reads a quoted `**` as the relay's words, not as exim's flag", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "connect-failure-detail-beside-quoted-flag",
      logPath: fixture.eximLog,
    });
    const recorder = waitRecorder();

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: RETRYING_BUDGET_SECONDS,
        shimBin: recorder.shimBin,
      });

      expect(run.status).toBe(1);
      expect(webhook.posts).toHaveLength(1);
      expect(
        recorder.waits(),
        "a `**` inside a quoted answer is not the flag, and the line is still a detail line",
      ).toBeGreaterThan(0);
      expect(reportedVerdict(JSON.parse(webhook.posts[0]!).content)).toBe(
        "Failed to connect to",
      );
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("waits out the budget on the lowercase refused-socket line, which ends nothing", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "lowercase-connect-failure",
      logPath: fixture.eximLog,
    });
    const recorder = waitRecorder();

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        waitSeconds: RETRYING_BUDGET_SECONDS,
        shimBin: recorder.shimBin,
      });

      expect(run.status).toBe(1);
      expect(webhook.posts).toHaveLength(1);
      expect(recorder.waits(), "a line that names no verdict must not end the poll").toBeGreaterThan(
        0,
      );
      expect(
        reportedVerdict(JSON.parse(webhook.posts[0]!).content),
        "no token here is terminal and none is provisional, so no name is recorded",
      ).toBeUndefined();
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });
});

describe("overflow-canary.sh naming the verdict it read", () => {
  it("names a deferral by the token, not by a prefix of it", async () => {

    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "deferred", logPath: fixture.eximLog });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url, waitSeconds: 1 });

      expect(run.status).toBe(1);
      expect(reportedVerdict(JSON.parse(webhook.posts[0]!).content)).toBe("defer");
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it.each([
    ["blackhole", "terminal-blackhole"],
    ["discarded", "terminal-discarded"],
  ] as const)(
    "reports the terminal %s verdict on its own, by name",
    async (_keyword, outcome) => {
      const fixture = makeFixture();
      const webhook = await startWebhook();
      writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
      const smtp = await startSmtp({ outcome, logPath: fixture.eximLog });

      try {
        const { run, elapsed } = await runTimed(fixture, {
          smtpUrl: smtp.url,
          waitSeconds: TERMINAL_BUDGET_SECONDS,
        });

        expect(run.status).toBe(1);
        expect(reportedVerdict(JSON.parse(webhook.posts[0]!).content)).toBe(_keyword);
        expectConcludedBeforeTheBudget(elapsed);
      } finally {
        await smtp.close();
        await webhook.close();
      }
    },
  );
});

describe("the two scripts' verdict blocks", () => {

  function verdictBlock(source: string): string {
    const start = source.indexOf('      verdict=$(awk -v id="$message_id" \'');
    const terminator = '\n      \' "$exim_log") || verdict=\'\'\n';
    const end = source.indexOf(terminator, start);

    expect(start, "the verdict block was not found").toBeGreaterThan(-1);
    expect(end, "the verdict block's terminator was not found").toBeGreaterThan(start);

    return source.slice(start, end + terminator.length);
  }

  it("is byte-identical in both scripts", () => {

    const canary = verdictBlock(readFileSync(scriptPath, "utf8"));
    const alert = verdictBlock(readFileSync(alertScriptPath, "utf8"));

    expect(canary.length, "the extracted block looks truncated").toBeGreaterThan(0);
    expect(alert).toBe(canary);
  });

  it("is present in both scripts rather than only in the one this suite drives", () => {
    // A guard that passes because one side is empty is a guard that reports
    // nothing, so the extraction itself is pinned: both blocks have to carry
    // the rule this issue is about, on both sides.
    for (const source of [readFileSync(scriptPath, "utf8"), readFileSync(alertScriptPath, "utf8")]) {
      expect(verdictBlock(source)).toContain("Failed to connect to");
      expect(verdictBlock(source)).toContain("scrubbed");
    }
  });
});

/**
 * A shim directory holding one command that fails, so the script's own
 * dependency on it can be broken. PATH is the script's only seam for these:
 * the canary unit sets none of the OVERFLOW_CANARY_* variables, and it pins a
 * PATH of its own that this runs ahead of.
 */
function shimDir(failing: string): string {
  const directory = sharedScratch("shim");
  writeFileSync(join(directory, failing), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });

  return directory;
}

function waitRecorder(): { shimBin: string; waits: () => number } {
  const directory = sharedScratch("waits");
  const record = join(directory, "waits");
  writeFileSync(
    join(directory, "sleep"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\n/bin/sleep "$@"\n`,
    { mode: 0o755 },
  );

  return {
    shimBin: directory,
    waits: () =>
      existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean).length : 0,
  };
}

describe("overflow-canary.sh when the host cannot describe itself", () => {
  // Without these, `set -e` kills the run at the assignment and the journal
  // carries nothing but a nonzero exit. "The canary unit failed" would then
  // have a third meaning - neither a dead path nor a misconfigured file -
  // distinguishable only by the absence of a line that should be there.
  it.each([
    ["hostname", "the FQDN lookup", "could not determine the host's FQDN"],
    ["date", "the clock", "could not read the clock"],
  ])("refuses loudly when %s fails, rather than dying with an empty journal", async (failing, _what, message) => {
    const fixture = makeFixture();
    const smtp = await startSmtp({ outcome: "completed", logPath: fixture.eximLog });

    try {
      const run = await runCanary(fixture, {
        smtpUrl: smtp.url,
        shimBin: shimDir(failing),
      });

      expect(run.status).toBe(2);
      expect(run.stderr).toContain(message);
      expect(smtp.messages, "a run that cannot describe itself must not mail").toEqual([]);
    } finally {
      await smtp.close();
    }
  });

  it.each(["thirty", "-1", "1.5", "60s"])(
    "refuses a wait budget of %j rather than aborting inside the arithmetic",
    async (budget) => {

      const fixture = makeFixture();
      const smtp = await startSmtp({ outcome: "completed", logPath: fixture.eximLog });

      try {
        const run = await runCanary(fixture, {
          smtpUrl: smtp.url,
          waitSeconds: budget,
        });

        expect(run.status).toBe(2);
        expect(run.stderr).toContain("OVERFLOW_CANARY_EXIM_WAIT_SECONDS");
        expect(smtp.messages, "an unusable budget must not reach the send stage").toEqual([]);
      } finally {
        await smtp.close();
      }
    },
  );
});
