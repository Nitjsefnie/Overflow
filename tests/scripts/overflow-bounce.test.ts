import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Behavioral coverage for scripts/overflow-bounce.sh, which nothing else in
 * the suite executes (the deploy suites read only its path out of the bounce
 * unit's ExecStart=). Each test runs the real script under /bin/sh with a
 * PATH shim directory in front: a recording curl that never touches a
 * network, so no report can leave the machine.
 *
 * Everything the deployed script reads from the host is overridden through
 * its OVERFLOW_BOUNCE_* variables onto scratch files: the spool, the offset
 * state directory and the webhook file. /var/mail, /var/lib/overflow-bounce
 * and /etc/overflow are root-only host state; a suite that wrote them would
 * mutate the machine it runs on, and CI's runner user cannot write any of
 * them. The bounce unit sets no such variables, so a deployed run always
 * reads the defaults.
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts", "overflow-bounce.sh");
const fqdn = "bounce.test.example";
const webhookUrl = "https://discord.test.example/api/webhooks/bounce-test";

/** The exact post contract: the recorded curl argv, in order. */
const expectedCurlArgv = [
  "-sS",
  "--fail",
  "--max-time",
  "15",
  "--connect-timeout",
  "5",
  "-H",
  "Content-Type: application/json",
  "--data-binary",
  "@-",
  webhookUrl,
];

const curlShim = [
  "#!/bin/sh",
  // Append, so a batch that posts twice is visible as two argv groups of
  // expectedCurlArgv.length lines each.
  'printf \'%s\\n\' "$@" >> "$OVERFLOW_TEST_CURL_ARGV"',
  'cat > "$OVERFLOW_TEST_CURL_PAYLOAD"',
  "exit ${FAKE_CURL_RC:-0}",
  "",
].join("\n");

interface BounceRun {
  status: number | null;
  stderr: string;
  /** Whether the run attempted at least one post. */
  posted: boolean;
  /** Recorded curl argv lines; expectedCurlArgv.length per post. */
  argvLines: string[];
  /** The last recorded webhook payload body. */
  payload: string;
  /** The offset file's content, or null when no offset file exists. */
  offset: string | null;
}

/** Scratch roots shared across several runBounce calls of one test. */
const sharedRoots: string[] = [];

afterEach(() => {
  for (const directory of sharedRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A scratch directory holding a spool and/or state dir across several runs. */
function makeRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "overflow-bounce-root-"));
  sharedRoots.push(directory);
  return directory;
}

function makeSpool(root: string, initial: string): string {
  const spool = join(root, "spool.mbox");
  writeFileSync(spool, initial);
  return spool;
}

function appendToSpool(spool: string, text: string): void {
  appendFileSync(spool, text);
}

function makeStateDir(root: string): string {
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

/** Pre-seeds the offset file; the script mkdir -p's it itself when absent. */
function seedOffset(stateDir: string, value: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "offset"), value);
}

/**
 * One mbox message. `dsn` selects the delivery-failure marker: exim's body
 * text or Gmail's. `failedAddress` is the address listed under the failure
 * marker; for an exim DSN it doubles as the overflow reference when it is an
 * overflow address. Without `dsn` the message is ordinary mail (cron output),
 * whose body can still carry an overflow reference.
 */
function mboxMessage(opts: {
  subject: string;
  dsn?: "exim" | "gmail";
  failedAddress?: string;
  body?: string;
}): string {
  const lines = [
    "From MAILER-DAEMON Fri Sep 26 10:00:00 2026",
    "Return-path: <>",
    "Envelope-to: root@bounce.test.example",
    `Subject: ${opts.subject}`,
    "",
  ];
  if (opts.dsn === "exim") {
    lines.push(
      "This message was created automatically by mail delivery software.",
      "",
      "A message that you sent could not be delivered to one or more of its",
      "recipients. This is a permanent error. The following address(es) failed:",
    );
    if (opts.failedAddress !== undefined) {
      lines.push(
        `  ${opts.failedAddress}`,
        "    host bounce.test.example [127.0.0.1]",
        "    SMTP error from remote mail server after RCPT TO::",
        "    550 unroutable address",
      );
    }
  } else if (opts.dsn === "gmail") {
    lines.push(
      "This is an automatically generated Delivery Status Notification",
      "",
      "Delivery to the following recipient failed:",
    );
    if (opts.failedAddress !== undefined) {
      lines.push(`   ${opts.failedAddress}`);
    }
  } else {
    lines.push(opts.body ?? "cron output line");
  }
  return lines.join("\n") + "\n";
}

const cronSubject = "Cron <root@bounce.test.example> touch /tmp/stamp";
const dsnSubject = "Mail delivery failed: returning message to sender";
const overflowCanaryAddress = `overflow-canary@${fqdn}`;
const overflowAlertAddress = `overflow-alert@${fqdn}`;

/** The report text contract for a subject and optional failed-address line. */
function expectedContent(subject: string, failedAddress?: string): string {
  const summary =
    `[overflow] a delivery-failure notification arrived for an overflow ` +
    `alert or canary message on ${fqdn}: ${subject}` +
    (failedAddress !== undefined ? `; ${failedAddress}` : "");
  return summary.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runBounce(options: {
  spool: string;
  /** Shared offset state directory; absent: a scratch one nobody inspects. */
  stateDir?: string;
  webhook?: string;
  webhookMissing?: boolean;
  curlStatus?: number;
  args?: string[];
}): BounceRun {
  const directory = mkdtempSync(join(tmpdir(), "overflow-bounce-"));

  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const shimPath = join(bin, "curl");
    writeFileSync(shimPath, curlShim);
    chmodSync(shimPath, 0o755);

    const webhookFile = join(directory, "canary-discord-webhook");
    if (!options.webhookMissing) {
      writeFileSync(webhookFile, options.webhook ?? `${webhookUrl}\n`);
    }

    const curlArgvPath = join(directory, "curl-argv");
    const payloadPath = join(directory, "payload.json");
    const stateDir = options.stateDir ?? join(directory, "state");

    const result = spawnSync("/bin/sh", [scriptPath, ...(options.args ?? [])], {
      env: {
        NODE_ENV: "test",
        PATH: `${bin}:/usr/bin:/bin`,
        OVERFLOW_BOUNCE_SPOOL: options.spool,
        OVERFLOW_BOUNCE_STATE_DIR: stateDir,
        OVERFLOW_BOUNCE_WEBHOOK_FILE: webhookFile,
        OVERFLOW_BOUNCE_HOSTNAME: fqdn,
        OVERFLOW_TEST_CURL_ARGV: curlArgvPath,
        OVERFLOW_TEST_CURL_PAYLOAD: payloadPath,
        FAKE_CURL_RC: String(options.curlStatus ?? 0),
      },
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    expect(result.signal, `killed by ${result.signal}: ${result.stderr}`).toBeNull();

    const offsetPath = join(stateDir, "offset");
    const argvLines = existsSync(curlArgvPath)
      ? readFileSync(curlArgvPath, "utf8").split("\n").slice(0, -1)
      : [];
    return {
      status: result.status,
      stderr: result.stderr,
      posted: argvLines.length > 0,
      argvLines,
      payload: existsSync(payloadPath) ? readFileSync(payloadPath, "utf8") : "",
      offset: existsSync(offsetPath) ? readFileSync(offsetPath, "utf8") : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The shared state dir's offset as a number, for arithmetic assertions. */
function offsetValue(stateDir: string): number {
  return Number(readFileSync(join(stateDir, "offset"), "utf8").trim());
}

function spoolSize(spool: string): number {
  return readFileSync(spool).byteLength;
}

describe("overflow-bounce.sh argument contract", () => {
  it("exits 2 with a usage line on any argument and never posts", () => {
    const root = makeRoot();
    const run = runBounce({
      spool: makeSpool(root, ""),
      args: ["unexpected"],
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage: overflow-bounce.sh");
    expect(run.posted, "the post stage must not be reached").toBe(false);
  });
});

describe("overflow-bounce.sh offset state", () => {
  it("first run: initializes the offset to the spool size, posts nothing, exits 0", () => {
    const root = makeRoot();
    const spool = makeSpool(
      root,
      // Even a backlog DSN is never reported: the first run starts now.
      mboxMessage({ subject: cronSubject }) +
        mboxMessage({ subject: dsnSubject, dsn: "exim", failedAddress: overflowCanaryAddress }),
    );
    const stateDir = makeStateDir(root);

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.posted, "backlog mail must not be reported").toBe(false);
    expect(run.offset).not.toBeNull();
    expect(offsetValue(stateDir)).toBe(spoolSize(spool));
  });

  it("treats corrupt offset content as no state and re-initializes", () => {
    const root = makeRoot();
    const spool = makeSpool(root, mboxMessage({ subject: cronSubject }));
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, "garbage\n");

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.posted).toBe(false);
    expect(offsetValue(stateDir)).toBe(spoolSize(spool));
  });

  it("rotation: an offset past the spool size resets to 0 and re-scans", () => {
    const root = makeRoot();
    const spool = makeSpool(
      root,
      mboxMessage({ subject: dsnSubject, dsn: "exim", failedAddress: overflowAlertAddress }),
    );
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, `${spoolSize(spool) + 100}\n`);

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.posted, "a rotation reset must re-scan and re-report").toBe(true);
    expect(run.argvLines).toEqual(expectedCurlArgv);
    expect(offsetValue(stateDir)).toBe(spoolSize(spool));
  });

  it("an offset equal to the spool size is a silent no-op", () => {
    const root = makeRoot();
    const spool = makeSpool(root, mboxMessage({ subject: cronSubject }));
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, `${spoolSize(spool)}\n`);

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.posted).toBe(false);
    expect(offsetValue(stateDir)).toBe(spoolSize(spool));
  });

  it("second run reads incrementally: only bytes appended after the first run are seen", () => {
    const root = makeRoot();
    const cronMail = mboxMessage({ subject: cronSubject, body: "first batch cron output" });
    const spool = makeSpool(root, cronMail);
    const stateDir = makeStateDir(root);

    const first = runBounce({ spool, stateDir });
    expect(first.status).toBe(0);
    expect(first.posted).toBe(false);

    const dsnMail = mboxMessage({
      subject: "later bounce for a different message",
      dsn: "exim",
      failedAddress: overflowCanaryAddress,
    });
    appendToSpool(spool, dsnMail);

    const second = runBounce({ spool, stateDir });

    expect(second.status).toBe(0);
    expect(second.posted).toBe(true);
    expect(second.payload).toBe(`{"content":"${expectedContent("later bounce for a different message", overflowCanaryAddress)}"}`);
    expect(second.payload).not.toContain("first batch cron output");
    expect(offsetValue(stateDir)).toBe(spoolSize(spool));
  });
});

describe("overflow-bounce.sh report filter", () => {
  it("reports an exim DSN referencing an overflow address: posts once, advances past it", () => {
    const root = makeRoot();
    const spool = makeSpool(
      root,
      mboxMessage({ subject: dsnSubject, dsn: "exim", failedAddress: overflowCanaryAddress }),
    );
    const stateDir = makeStateDir(root);
    // Offset 0: the scan path, as a rotation reset produces. (A run with no
    // state at all initializes to end-of-spool and never reports.)
    seedOffset(stateDir, "0\n");

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.posted).toBe(true);
    expect(run.argvLines).toEqual(expectedCurlArgv);
    expect(run.payload).toBe(`{"content":"${expectedContent(dsnSubject, overflowCanaryAddress)}"}`);
    expect(run.payload, "the payload must stay on one line").not.toContain("\n");
    expect(offsetValue(stateDir)).toBe(spoolSize(spool));
  });

  it("reports a Gmail-format DSN referencing an overflow address", () => {
    const root = makeRoot();
    const spool = makeSpool(
      root,
      mboxMessage({
        subject: "Delivery Status Notification",
        dsn: "gmail",
        failedAddress: overflowCanaryAddress,
      }),
    );
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, "0\n");

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.posted).toBe(true);
    expect(run.payload).toContain("Delivery Status Notification");
  });

  it("advances silently past plain mail that references an overflow address", () => {
    const root = makeRoot();
    const spool = makeSpool(
      root,
      mboxMessage({
        subject: cronSubject,
        body: `canary check wrote overflow-canary@${fqdn} into its output`,
      }),
    );
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, "0\n");

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.posted, "no DSN marker means no report").toBe(false);
    expect(offsetValue(stateDir)).toBe(spoolSize(spool));
  });

  it("advances silently past a DSN that references no overflow address", () => {
    const root = makeRoot();
    const spool = makeSpool(
      root,
      mboxMessage({
        subject: dsnSubject,
        dsn: "exim",
        failedAddress: "someone-else@random.example",
      }),
    );
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, "0\n");

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.posted, "no overflow reference means no report").toBe(false);
    expect(offsetValue(stateDir)).toBe(spoolSize(spool));
  });
});

describe("overflow-bounce.sh batch handling", () => {
  it("posts once for the single DSN in an interleaved batch and advances past the whole batch", () => {
    const root = makeRoot();
    const spool = makeSpool(
      root,
      mboxMessage({ subject: cronSubject }) +
        mboxMessage({ subject: dsnSubject, dsn: "exim", failedAddress: overflowAlertAddress }) +
        mboxMessage({ subject: cronSubject, body: "more cron output" }),
    );
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, "0\n");

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.argvLines, "exactly one post for the batch").toEqual(expectedCurlArgv);
    expect(run.payload).toBe(`{"content":"${expectedContent(dsnSubject, overflowAlertAddress)}"}`);
    expect(offsetValue(stateDir)).toBe(spoolSize(spool));
  });
});

describe("overflow-bounce.sh webhook failure", () => {
  it("exits nonzero without advancing the offset, so the next run reports again", () => {
    const root = makeRoot();
    const spool = makeSpool(
      root,
      mboxMessage({ subject: cronSubject }) +
        mboxMessage({ subject: dsnSubject, dsn: "exim", failedAddress: overflowCanaryAddress }),
    );
    const stateDir = makeStateDir(root);

    const first = runBounce({ spool, stateDir });
    expect(first.status).toBe(0);
    const offsetBefore = offsetValue(stateDir);

    appendToSpool(
      spool,
      mboxMessage({ subject: "appended bounce", dsn: "exim", failedAddress: overflowCanaryAddress }),
    );

    const second = runBounce({ spool, stateDir, curlStatus: 22 });

    expect(second.status).toBe(22);
    expect(second.posted, "the post was attempted").toBe(true);
    expect(offsetValue(stateDir), "a refused post must leave the offset alone").toBe(offsetBefore);
  });
});

describe("overflow-bounce.sh misconfiguration", () => {
  const offsetBefore = "5\n";
  const stateWithWork = (root: string): { spool: string; stateDir: string } => {
    const spool = makeSpool(
      root,
      mboxMessage({ subject: dsnSubject, dsn: "exim", failedAddress: overflowCanaryAddress }),
    );
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, offsetBefore);
    return { spool, stateDir };
  };

  it.each([
    ["missing", undefined, true],
    ["empty", "" as string | undefined, false],
    ["multiline", `${webhookUrl}\nhttps://discord.test.example/api/webhooks/other\n`, false],
  ])("exits 2 naming the file for a %s webhook file, before touching the offset", (_label, webhook, missing) => {
    const root = makeRoot();
    const { spool, stateDir } = stateWithWork(root);

    const run = runBounce({ spool, stateDir, webhook, webhookMissing: missing });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("overflow-bounce.sh:");
    expect(run.stderr).toContain("canary-discord-webhook");
    expect(run.posted).toBe(false);
    expect(readFileSync(join(stateDir, "offset"), "utf8")).toBe(offsetBefore);
  });

  it("exits 2 naming the file for an unreadable spool, before touching the offset", () => {
    const root = makeRoot();
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, offsetBefore);

    const run = runBounce({ spool: join(root, "no-such-spool"), stateDir });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no-such-spool");
    expect(run.posted).toBe(false);
    expect(readFileSync(join(stateDir, "offset"), "utf8")).toBe(offsetBefore);
  });
});

describe("overflow-bounce.sh payload escaping", () => {
  it("a subject carrying a quote and a backslash survives the payload exactly", () => {
    const root = makeRoot();
    const hostileSubject = `bounce with "quote" and backslash \\ and tail`;
    const spool = makeSpool(
      root,
      mboxMessage({ subject: hostileSubject, dsn: "exim", failedAddress: overflowCanaryAddress }),
    );
    const stateDir = makeStateDir(root);
    seedOffset(stateDir, "0\n");

    const run = runBounce({ spool, stateDir });

    expect(run.status).toBe(0);
    expect(run.posted).toBe(true);
    expect(run.payload).toBe(`{"content":"${expectedContent(hostileSubject, overflowCanaryAddress)}"}`);
    expect(run.payload, "the payload must stay on one line").not.toContain("\n");
  });
});
