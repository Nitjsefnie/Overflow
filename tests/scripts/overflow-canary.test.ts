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

type RelayOutcome = "completed" | "deferred";

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
 * A scratch directory shared across several runs of one test - the dedup and
 * re-arm cases read the marker a run left behind, so they cannot use a
 * directory that dies with a single run's fixture.
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
 */
async function startWebhook(): Promise<WebhookStandIn> {
  const posts: string[] = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posts.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(204).end();
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
}): Promise<SmtpStandIn> {
  const messageId = options.messageId ?? nextMessageId();
  const messages: string[] = [];
  let bufferedData: string[] = [];
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
            if (options.outcome === "completed") {
              messages.push(bufferedData.join("\r\n"));
              bufferedData = [];
              logLine(`${messageId} Completed`);
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
    close: () => closeServer(server),
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
  options: { smtpUrl: string; waitSeconds?: number },
): Promise<CanaryRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [scriptPath], {
      env: {
        NODE_ENV: "test",
        PATH: "/usr/local/bin:/usr/bin:/bin",
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
      expect(mail).toMatch(/^Subject: \[overflow\] .*canary.*$/m);
      // The alert subject reads "<unit> failed on <host>"; a mailbox holding
      // both has to be able to tell them apart without reading the body.
      expect(mail).not.toMatch(/^Subject: \[overflow\] \S+ failed on \S+$/m);
      expect(mail).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
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

      expect(run.status).not.toBe(0);
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
      ).not.toBe(0);
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

      expect(run.status).not.toBe(0);
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
      expect(first.status).not.toBe(0);

      const second = await runCanary(fixture, { smtpUrl: smtp.url });

      expect(
        second.status,
        "a dead path still exits nonzero, so the unit lands in failed",
      ).not.toBe(0);
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

      expect(run.status).not.toBe(0);
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

      expect(run.status).not.toBe(0);
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

      expect(run.status).not.toBe(0);
      expect(existsSync(fixture.marker)).toBe(false);
      expect(run.stderr).toContain("out-of-band report");
    } finally {
      await smtp.close();
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

      expect(run.status).not.toBe(0);
      expect(webhook.posts).toHaveLength(1);
    } finally {
      await smtp.close();
      await webhook.close();
    }
  });
});
