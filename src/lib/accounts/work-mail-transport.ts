import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import tls from "node:tls";
import { parseContributorAddress, type SmtpSettings } from "@/lib/accounts/work-mail-config";
import { plural } from "@/lib/plural";

export type WorkMailMessage = { from: string; to: string; content: string };
export type SendResult = { ok: true } | { ok: false; code: number | null };
export interface WorkMailTransport {
  send(message: WorkMailMessage): Promise<SendResult>;
}
export type SmtpConnect = (host: string, port: number) => Socket;

type MessageInput = { from: string; to: string; origin: string; now?: Date };

const TOKEN = /^[A-Za-z0-9_.-]+$/;

function requireAddress(input: string): string {
  const parsed = parseContributorAddress(input);
  if (parsed === null) throw new Error("Work mail needs a valid sender and recipient address.");
  return parsed.address;
}

function requireToken(token: string): string {
  if (!TOKEN.test(token)) throw new Error("Work mail tokens are base64url.");
  return token;
}

function requireOrigin(origin: string): string {
  let url: URL | null = null;
  try {
    url = new URL(origin);
  } catch {}
  // The exact-origin equality also refuses the tabs and newlines URL parsing silently strips.
  if (url?.protocol !== "https:" || url.origin !== origin) throw new Error("Work mail links need an https origin.");
  return origin;
}

/**
 * Every header value is a parsed address, fixed text, the checked origin, a
 * uuid or a checked token, none of which can hold CR or LF; the body is ASCII
 * for the same reason, so it always travels as 7bit.
 */
function assemble(input: MessageInput, subject: string, extraHeaders: string[], body: string[]): WorkMailMessage {
  const from = requireAddress(input.from);
  const to = requireAddress(input.to);
  const date = (input.now ?? new Date()).toUTCString().replace(/GMT$/, "+0000");
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${randomUUID()}@${from.slice(from.indexOf("@") + 1)}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "Auto-Submitted: auto-generated",
    ...extraHeaders,
  ];
  return { from, to, content: `${[...headers, "", ...body].join("\r\n")}\r\n` };
}

export function buildConfirmationMessage(input: MessageInput & { token: string }): WorkMailMessage {
  const origin = requireOrigin(input.origin);
  return assemble(input, "Confirm your Overflow work notifications", [], [
    "Someone, hopefully you, asked Overflow to email this address when there is work to take.",
    "",
    "To confirm, open this link within 24 hours:",
    `${origin}/dashboard#work-mail-confirm=${requireToken(input.token)}`,
    "",
    "If it was not you, ignore this message: nothing more is sent unless the address is confirmed.",
  ]);
}

export function buildDigestMessage(input: MessageInput & { count: number; unsubscribeToken: string }): WorkMailMessage {
  const origin = requireOrigin(input.origin);
  const token = requireToken(input.unsubscribeToken);
  if (!Number.isSafeInteger(input.count) || input.count < 1) throw new Error("A work digest needs a positive count.");
  return assemble(input, "New work to take on Overflow", [
    `List-Unsubscribe: <${origin}/api/work-mail/unsubscribe?token=${token}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  ], [
    `${input.count} new ${plural(input.count, "issue")} you can take appeared on Overflow.`,
    "",
    "See them on your board:",
    `${origin}/issues`,
    "",
    "To stop these emails, open:",
    `${origin}/work-mail/unsubscribe#token=${token}`,
    "",
    "Replies to this message are not read; requests go through the project's GitHub issues.",
  ]);
}

const DEFAULT_TIMEOUT_MS = 30_000;

function connectTls(host: string, port: number): Socket {
  return tls.connect({ host, port, servername: host, rejectUnauthorized: true });
}

/** Each reply's final code, null for a malformed line; resolves null once the socket is gone. */
function replyReader(socket: Socket): () => Promise<number | null> {
  const codes: (number | null)[] = [];
  let buffered = "";
  let closed = false;
  let wake = () => {};
  socket.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("latin1");
    for (let end = buffered.indexOf("\r\n"); end !== -1; end = buffered.indexOf("\r\n")) {
      const match = /^(\d{3})(?:([ -]).*)?$/.exec(buffered.slice(0, end));
      buffered = buffered.slice(end + 2);
      if (match === null) codes.push(null);
      else if (match[2] !== "-") codes.push(Number(match[1]));
      wake();
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
    wake();
  });
  return async () => {
    while (codes.length === 0 && !closed) await new Promise<void>((resolve) => { wake = resolve; });
    return codes.length > 0 ? codes.shift()! : null;
  };
}

/** The DATA payload: CRLF lines, dot-stuffed, ending in the lone "."; null when a line exceeds 998 octets. */
function dataPayload(content: string): string | null {
  const lines = content.replace(/(?:\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/);
  if (lines.some((line) => Buffer.byteLength(line) > 998)) return null;
  return [...lines.map((line) => (line.startsWith(".") ? `.${line}` : line)), "."].join("\r\n");
}

/**
 * One SMTP session per message over implicit TLS. Any unexpected reply ends
 * it; the result carries the reply code only, never the server's text, which
 * can echo the address or the credentials. No retry: the caller decides.
 */
export function createSmtpsTransport(
  smtp: SmtpSettings,
  options: { connect?: SmtpConnect; timeoutMs?: number } = {},
): WorkMailTransport {
  const connect = options.connect ?? connectTls;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async send(message) {
      const payload = dataPayload(message.content);
      // The envelope goes into SMTP commands, so it must be what the parser emits.
      const envelopeValid = [message.from, message.to].every((address) => parseContributorAddress(address)?.address === address);
      if (payload === null || !envelopeValid) return { ok: false, code: null };
      const socket = connect(smtp.host, smtp.port);
      const deadline = setTimeout(() => socket.destroy(), timeoutMs);
      const nextReply = replyReader(socket);
      const credentials = Buffer.from(`\0${smtp.username}\0${smtp.password}`, "utf8").toString("base64");
      const exchange: [string | null, number][] = [
        [null, 220],
        [`EHLO ${message.from.slice(message.from.indexOf("@") + 1)}`, 250],
        [`AUTH PLAIN ${credentials}`, 235],
        [`MAIL FROM:<${message.from}>`, 250],
        [`RCPT TO:<${message.to}>`, 250],
        ["DATA", 354],
        [payload, 250],
      ];
      try {
        for (const [command, expected] of exchange) {
          if (command !== null) socket.write(`${command}\r\n`);
          const code = await nextReply();
          if (code !== expected) return { ok: false, code };
        }
        // The message is accepted at this point; QUIT's answer cannot undo that.
        socket.write("QUIT\r\n");
        await nextReply();
        return { ok: true };
      } finally {
        clearTimeout(deadline);
        socket.destroy();
      }
    },
  };
}
