import { spawnSync } from "node:child_process";
import {
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
import { describe, expect, it } from "vitest";

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

function runAlert(
  options: {
    recipient?: string;
    args?: string[];
    curlStatus?: number;
    journalStatus?: number;
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

    const result = spawnSync(
      "/bin/sh",
      [scriptPath, ...(options.args ?? ["overflow.service"])],
      {
        env: {
          NODE_ENV: "test",
          PATH: `${bin}:/usr/bin:/bin`,
          OVERFLOW_ALERT_RECIPIENT_FILE: recipientFile,
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
