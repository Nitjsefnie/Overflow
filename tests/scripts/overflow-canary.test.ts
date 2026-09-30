import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Behavioral coverage for scripts/overflow-canary.sh, the periodic exercise of
 * the host's failure-alert delivery path.
 *
 * The alert path is curl -> local exim -> one smarthost, and nothing in it
 * reports its own failure, so a dead route looks exactly like a healthy host.
 * The only observation that can see the smarthost leg is the exim mainlog's
 * `Completed` line for the id the submission was accepted under, which is why
 * these tests drive the real script end to end rather than shimming its
 * commands: a shim would stub out the very handshake the verdict rests on.
 *
 * So the suite runs the real /bin/sh script with the real curl against two
 * scratch servers in this process - a minimal SMTP stand-in speaking enough
 * of RFC 5321 for curl's client, and an HTTP server standing in for the
 * out-of-band webhook. Nothing leaves the machine and no host file is read:
 * the recipient and webhook paths, the state directory, the exim log and the
 * SMTP URL are all overridden through the script's test-only variables, which
 * the canary unit sets none of, so a deployed run always takes the defaults.
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts", "overflow-canary.sh");
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

/**
 * The exim log's own prelude, present in every fixture: one message the canary
 * did not cause, already completed by the relay. Every run therefore judges a
 * log that is not silent and not exclusively its own, so a verdict that
 * ignored the id and matched any Completed line fails here rather than
 * passing by accident.
 */
const UNRELATED_COMPLETED =
  "2026-09-30 01:30:04 1xBuT1-000000001AA-1aA1 Completed\n";

/**
 * An id carrying both characters the JSON report must escape. A relay or a
 * host name that puts either in the id would otherwise produce a payload
 * Discord rejects, and the one report the operator needs is the one lost.
 */
const hostileMessageId = '1xBuT1-0000"\\0000QH-0Qqz';

type RelayOutcome =
  | "completed"
  | "deferred"
  | "deferred-then-completed"
  | "deferred-then-terminal"
  | "terminal";

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
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `overflow-canary-${prefix}-`));
  scratchDirectories.push(directory);
  return directory;
}

/**
 * A scratch directory for a fixture or a shim, removed after the test.
 *
 * The name is a leftover from an earlier shape and describes no behaviour:
 * this delegates to `scratch` and returns a **fresh `mkdtemp` directory on
 * every call**, exactly as `scratch` does. Nothing is shared between calls,
 * and a test that needs one directory to outlive a single run - the dedup
 * and re-arm cases, which read the marker a previous run left behind - gets
 * that by holding the returned path in a local, not from this helper.
 *
 * Worth stating because `shimDir` below depends on the fresh-per-call
 * behaviour: it must not hand two tests the same PATH directory, or one
 * test's `hostname` shim would silently become another's.
 */
function sharedScratch(prefix: string): string {
  return scratch(prefix);
}

interface WebhookStandIn {
  url: string;
  /** Every request body the webhook received, in arrival order. */
  posts: string[];
  close: () => Promise<void>;
}

/**
 * Stands in for the Discord webhook: an HTTP server that records the exact
 * bytes the script posted, so a payload can be parsed and asserted on rather
 * than pattern-matched.
 *
 * `status` is what the stand-in answers with, so a test can play a webhook
 * that has stopped existing (404) or revoked its token (401). A client that
 * treats any HTTP response as success records a report nobody received as
 * delivered, and the failure mode is silent in the worst way — the outage is
 * marked reported and every later run of the streak posts nothing.
 */
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

/**
 * A port on the loopback interface with nothing listening on it, taken by
 * binding and then releasing it. A closed port is the honest way to make a
 * submission fail: there is no shim to crash and no timeout to wait out, and
 * curl fails at connect the way it would against a stopped exim daemon.
 */
async function closedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await closeServer(probe);
  return port;
}

/**
 * The minimum SMTP server curl's client will complete a submission against,
 * and the exim mainlog the relay verdict is read out of.
 *
 * It answers the end of DATA with the `250 OK id=` line a real relay prints,
 * and writes the log line that relay outcome would produce. `deferred` writes
 * only a defer, which is the shape a relay that accepted the message and
 * could not hand it on leaves behind: the id is in the log, `Completed` never
 * appears, and a run that trusts the 250 alone reports a dead host as healthy.
 */
async function startSmtp(options: {
  outcome: RelayOutcome;
  logPath: string;
  messageId?: string;
  /**
   * Write the `Completed` line this many milliseconds AFTER answering the end
   * of DATA, instead of at the moment it is answered.
   *
   * This is what a real relay does: it accepts the message, and the exim
   * mainlog records the outcome a moment later, after the connection to the
   * smarthost has actually been made. It is also the only way to reach the
   * canary's polling loop, which a stand-in that logs synchronously satisfies
   * on the very first read - leaving the loop, its deadline arithmetic and
   * its sleep entirely unexercised, and a regression to a single read
   * invisible.
   */
  completeAfterMs?: number;
  /**
   * Write the smarthost's own `250 2.0.0 OK ... - gsmtp` acceptance line
   * before the `Completed` line, as exim records on the way out. Used to
   * reproduce the boundary case: the relay accepted the message and there is
   * nothing further to observe, whatever became of it afterwards.
   */
  smarthostAcceptLine?: boolean;
}): Promise<SmtpStandIn> {
  const messageId = options.messageId ?? nextMessageId();
  const messages: string[] = [];
  let bufferedData: string[] = [];
  /**
   * Scheduled log writes that have not fired yet. `close` waits on them: the
   * fixture directory dies with the test, and a relay still owing the mainlog
   * a line would otherwise write into a directory that is already gone -
   * which surfaces as an unhandled ENOENT attributed to whichever test
   * happened to be running, and reads as a harness fault rather than one.
   */
  const pending: Promise<void>[] = [];
  /**
   * Errors from those writes, rethrown by `close` once every one has settled.
   * Settling the promise in a `finally` is what keeps a throwing write from
   * hanging `Promise.all` until the vitest timeout - but swallowing the error
   * would trade a hang for a silent pass, so it is held here instead and
   * raised at the one moment the test is already looking.
   */
  const writeFailures: unknown[] = [];
  const server = createNetServer((socket) => {
    let buffer = "";
    let inData = false;

    const logLine = (body: string): void => {
      writeFileSync(options.logPath, `2026-09-30 03:20:04 ${body}\n`, {
        flag: "a",
      });
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
            } else if (options.outcome === "deferred-then-completed") {
              // One message id, two outcomes, in the order a real relay
              // produces them when a message is greylisted or answered with a
              // temporary 4xx: the first attempt defers, the retry succeeds.
              // Both lines are in the log at once, which is the case that
              // decides whether the script reads a verdict as final on sight
              // or waits for the budget to close.
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(
                `${messageId} ** defer rejected: greylisted, retrying in 120 seconds`,
              );
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
      // The pending writes are drained and their failures rethrown even if
      // closing the listener itself throws, which is what a `finally` buys:
      // without it a rejected closeServer skips both, and the guard above
      // stops guarding for exactly the run where the harness is already
      // misbehaving.
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
  };

  if (options.alreadyMarked) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(fixture.marker, "2026-09-29T03:20:04Z\n");
  }

  return fixture;
}

/**
 * Runs the real script and resolves with its outcome.
 *
 * Deliberately not spawnSync: the SMTP and webhook stand-ins live in this
 * process, and a synchronous spawn blocks the event loop, so the kernel's
 * accept queue is never drained and curl waits on a server that cannot answer
 * until the run it is waiting for has returned.
 */
function runCanary(
  fixture: CanaryFixture,
  options: { smtpUrl: string; waitSeconds?: number | string; shimBin?: string },
): Promise<CanaryRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [scriptPath], {
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
    // The relay answers the end of DATA immediately and logs Completed a
    // moment later, which is what a real relay does while it waits on the
    // smarthost. A run that gave the log one read would call this path dead.
    //
    // This is coverage, not a guard: the scenario below is the one that
    // discriminates, because a read that misses and finds nothing leaves no
    // reason at all, so a collapsed loop exits 0 here too.
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
    // The discriminating test for the polling loop, and the direction that
    // matters. Collapsing the loop to a single read does not report a healthy
    // path as dead - it reports a DEAD path as HEALTHY: the read misses, no
    // reason is ever set, and the run falls through to exit 0 with no post and
    // no marker. That is the silent failure this whole script exists to
    // prevent, so the scenario has to be one where the loop is the only thing
    // standing between a deferred message and a green result.
    //
    // A non-zero budget is the point: with waitSeconds at 0 the negative cases
    // exit on the first read, and the deadline arithmetic, the retry and the
    // sleep the brief's step 6 specifies are never executed at all. Two
    // seconds is enough for the loop to spin and give up.
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
      // The transport succeeded and the report was refused. A webhook that
      // has been deleted or had its token revoked answers exactly this way,
      // and a client that counts any HTTP response as delivery writes the
      // dead-streak marker for an outage it never actually reported - after
      // which every later run of the streak stays silent. That is the one
      // report nobody receives followed by permanent quiet, which is the
      // exact failure this script exists to prevent.
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
    // The scenario is one message id with two lines in the log at once: a
    // first attempt deferred, the retry completed. That is what a greylisted
    // or temporary-4xx relay produces routinely, so a verdict read as final
    // on sight turns an ordinary retry into a false dead verdict plus a
    // spurious page on the one signal the maintainer is meant to trust.
    //
    // What this pins is therefore a BEHAVIOUR, not an ordering: moving the
    // Completed and failure checks past each other is a no-op, verified
    // deliberately, because a provisional verdict must not short-circuit the
    // poll. What breaks here is a verdict becoming conclusive on sight -
    // treating `defer` as final, or breaking on any verdict before re-reading
    // the log. That is the failure the reviewer's swap produced in the
    // shipped code, where the canary paged and recorded a dead streak for a
    // message the relay had delivered.
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
    // exim records a temporary failure and, if the retry also fails for good,
    // a terminal one - under the same id. A search that settles on the FIRST
    // verdict it meets reports `defer` for the whole budget: still a correct
    // dead verdict, but the wrong cause, named to an operator at three in the
    // morning, and it burns the entire budget before saying so.
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({
      outcome: "deferred-then-terminal",
      logPath: fixture.eximLog,
      completeAfterMs: 300,
    });

    try {
      const run = await runCanary(fixture, { smtpUrl: smtp.url, waitSeconds: 20 });

      expect(run.status).toBe(1);
      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content, "the terminal outcome is the cause").toContain("bounce");
      expect(report.content, "the provisional one must not mask it").not.toContain("defer");
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reports a terminal outcome on its own without spending the budget", async () => {
    // A terminal verdict ends a message, so it must conclude the poll at once
    // rather than wait out the budget for a Completed line that will never
    // come. Without this the canary sits for the full 60 seconds on every
    // bounce and rejection, and a refactor that made every verdict provisional
    // would ship silently.
    //
    // The suite previously wrote only `** defer` lines, so nothing pinned
    // this. The elapsed bound below is the rule's one permitted exception to
    // "never assert a wall-clock margin" - an assertion that something did
    // NOT happen inside an interval far shorter than it could take - and it
    // is scaled from the budget the run is given: 20 s of budget, 10 s of
    // bound, against a short-circuit that finishes in well under a second.
    const fixture = makeFixture();
    const webhook = await startWebhook();
    writeFileSync(fixture.webhookFile, `${webhook.url}\n`);
    const smtp = await startSmtp({ outcome: "terminal", logPath: fixture.eximLog });

    try {
      const startedAt = Date.now();
      const run = await runCanary(fixture, { smtpUrl: smtp.url, waitSeconds: 20 });
      const elapsed = Date.now() - startedAt;

      expect(run.status).toBe(1);
      const report = JSON.parse(webhook.posts[0]!) as { content: string };
      expect(report.content).toContain("rejected");
      expect(
        elapsed,
        "a terminal outcome must conclude the poll, not run out the budget",
      ).toBeLessThan(10_000);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });

  it("reads as healthy when the smarthost accepted a message to a mailbox that no longer exists", async () => {
    // THE BOUNDARY OF THIS SCRIPT, pinned by a test rather than by prose
    // alone - and it is a boundary, not a defect.
    //
    // Measured on the real host against the real Gmail smarthost and an
    // RFC 2606 reserved domain, so that delivery is impossible by
    // construction: Gmail answered `250 2.0.0 OK ... - gsmtp`, exim logged
    // Completed, and the canary reported a healthy path. That is correct. The
    // smarthost accepted the message, and once the message has left the queue
    // there is no observation left through the local exim that can tell the
    // smarthost's acceptance from the remote mailbox existing.
    //
    // So a wrong, deleted or converted recipient is a permanent false green,
    // and the only detector for it is the daily heartbeat STOPPING ARRIVING.
    // The operator section says so; this test is what stops that from being
    // quietly reworded into a claim the code does not support.
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
      // The budget reaches a $(( )) expansion, where a non-numeric operand
      // aborts the run under set -e and says nothing at all. Only the tests
      // set it, so this is not a production path - but a refusal that names
      // the value costs three lines, and the silence it replaces is the same
      // unreadable-result failure the rest of this file keeps closing.
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
