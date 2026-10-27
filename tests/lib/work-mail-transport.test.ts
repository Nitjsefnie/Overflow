import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmtpSettings } from "@/lib/accounts/work-mail-config";
import { buildConfirmationMessage, createSmtpsTransport, type SmtpConnect, type WorkMailMessage } from "@/lib/accounts/work-mail-transport";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { recordingTransport } from "../support/work-mail-recording-transport";

type Step = "greeting" | "EHLO" | "AUTH" | "MAIL" | "RCPT" | "DATA" | "END" | "QUIT";
/** A reply to write, null to stay silent, or "close" to drop the connection. */
type Reply = string | null | "close";

const HAPPY: Record<Step, string> = {
  greeting: "220 fake ready",
  EHLO: "250-fake greets you\r\n250-AUTH PLAIN\r\n250 8BITMIME",
  AUTH: "235 2.7.0 accepted",
  MAIL: "250 2.1.0 ok",
  RCPT: "250 2.1.5 ok",
  DATA: "354 go ahead",
  END: "250 2.0.0 queued",
  QUIT: "221 bye",
};

type FakeSmtp = { port: number; commands: string[]; data: string[]; connections: number; connected: Promise<void> };
const openServers: { server: net.Server; sockets: Set<net.Socket> }[] = [];

async function fakeSmtp(replies: Partial<Record<Step, Reply>> = {}): Promise<FakeSmtp> {
  let markConnected = () => {};
  const fake: FakeSmtp = { port: 0, commands: [], data: [], connections: 0, connected: new Promise((resolve) => { markConnected = resolve; }) };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    fake.connections += 1;
    markConnected();
    socket.on("error", () => {});
    const say = (step: Step): Reply => {
      const reply = step in replies ? replies[step]! : HAPPY[step];
      if (reply === "close") socket.destroy();
      else if (reply !== null) socket.write(`${reply}\r\n`);
      return reply;
    };
    say("greeting");
    let buffered = "";
    let inData = false;
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      for (let end = buffered.indexOf("\r\n"); end !== -1; end = buffered.indexOf("\r\n")) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (inData && line === ".") {
          inData = false;
          say("END");
        } else if (inData) {
          fake.data.push(line);
        } else {
          fake.commands.push(line);
          const verb = line.split(/[ :]/)[0].toUpperCase();
          const reply = verb in HAPPY ? say(verb as Step) : socket.write("500 unknown\r\n");
          inData = verb === "DATA" && typeof reply === "string" && reply.startsWith("354");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.port = (server.address() as net.AddressInfo).port;
  openServers.push({ server, sockets });
  return fake;
}

const password = randomBytes(12).toString("hex");
const smtp: SmtpSettings = { host: "mail.example.net", port: 465, username: "mailer", password };
const loopback = (fake: FakeSmtp) => vi.fn<SmtpConnect>(() => net.connect(fake.port, "127.0.0.1"));
const message = (): WorkMailMessage => buildConfirmationMessage({
  from: "work@mail.example.org", to: "ada@example.net", origin: "https://overflow.example", token: randomBytes(16).toString("base64url"),
});
const verbs = (fake: FakeSmtp) => fake.commands.map((command) => command.split(/[ :]/)[0]);

beforeEach(() => {
  spyOnConsoleOutput();
});

afterEach(async () => {
  expectNoConsoleOutput();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(openServers.splice(0).map(({ server, sockets }) => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  })));
});

describe("createSmtpsTransport", () => {
  it("delivers through greeting, EHLO, AUTH PLAIN, MAIL, RCPT, DATA and QUIT", async () => {
    const fake = await fakeSmtp();
    const connect = loopback(fake);
    const sent = message();

    expect(await createSmtpsTransport(smtp, { connect }).send(sent)).toEqual({ ok: true });

    expect(connect).toHaveBeenCalledWith("mail.example.net", 465);
    expect(verbs(fake)).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]);
    expect(fake.commands[0]).toBe("EHLO mail.example.org");
    const [, mechanism, credentials] = fake.commands[1].split(" ");
    expect(mechanism).toBe("PLAIN");
    expect(Buffer.from(credentials, "base64").toString("utf8")).toBe(`\0mailer\0${password}`);
    expect(fake.commands.slice(2, 4)).toEqual(["MAIL FROM:<work@mail.example.org>", "RCPT TO:<ada@example.net>"]);
    expect(`${fake.data.join("\r\n")}\r\n`).toBe(sent.content);
  });

  it("dot-stuffs body lines and sends bare line breaks as CRLF", async () => {
    const fake = await fakeSmtp();
    const content = "Subject: x\r\n\r\n.hidden\n.\r\nplain\r..\r\n";

    expect(await createSmtpsTransport(smtp, { connect: loopback(fake) }).send({ ...message(), content })).toEqual({ ok: true });

    expect(fake.data).toEqual(["Subject: x", "", "..hidden", "..", "plain", "..."]);
  });

  it("sends a 998-octet line and refuses a 999-octet one without connecting", async () => {
    const fake = await fakeSmtp();
    const connect = loopback(fake);
    const transport = createSmtpsTransport(smtp, { connect });

    expect(await transport.send({ ...message(), content: `Subject: x\r\n\r\n${"a".repeat(998)}\r\n` })).toEqual({ ok: true });
    expect(await transport.send({ ...message(), content: `Subject: x\r\n\r\n${"é".repeat(499)}a\r\n` })).toEqual({ ok: false, code: null });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sender", { from: "work@mail.example.org>\r\nRCPT TO:<victim@example.net" }],
    ["recipient", { to: "ada@example.net>\r\nRCPT TO:<victim@example.net" }],
  ])("refuses an envelope whose %s is not a parsed address, without connecting", async (_name, envelope) => {
    const fake = await fakeSmtp();
    const connect = loopback(fake);

    expect(await createSmtpsTransport(smtp, { connect }).send({ ...message(), ...envelope })).toEqual({ ok: false, code: null });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each<[Step, number, string[]]>([
    ["greeting", 554, []],
    ["EHLO", 502, ["EHLO"]],
    ["AUTH", 535, ["EHLO", "AUTH"]],
    ["MAIL", 550, ["EHLO", "AUTH", "MAIL"]],
    ["RCPT", 551, ["EHLO", "AUTH", "MAIL", "RCPT"]],
    ["DATA", 554, ["EHLO", "AUTH", "MAIL", "RCPT", "DATA"]],
    ["END", 552, ["EHLO", "AUTH", "MAIL", "RCPT", "DATA"]],
  ])("ends the session on an unexpected %s reply and returns only its code", async (step, code, sentVerbs) => {
    const fake = await fakeSmtp({ [step]: `${code}-5.7.1 first line\r\n${code} 5.7.1 rejected ${password}` });

    const result = await createSmtpsTransport(smtp, { connect: loopback(fake) }).send(message());

    expect(result).toEqual({ ok: false, code });
    expect(verbs(fake)).toEqual(sentVerbs);
  });

  it("reads the code of a multi-line reply from its last line", async () => {
    const fake = await fakeSmtp({ EHLO: "250-fake\r\n250-SIZE 1000\r\n502 no" });

    expect(await createSmtpsTransport(smtp, { connect: loopback(fake) }).send(message())).toEqual({ ok: false, code: 502 });
  });

  it("succeeds once the message is queued, whatever QUIT answers", async () => {
    for (const QUIT of ["500 what", null, "close"] satisfies Reply[]) {
      const fake = await fakeSmtp({ QUIT });
      expect(await createSmtpsTransport(smtp, { connect: loopback(fake), timeoutMs: 200 }).send(message())).toEqual({ ok: true });
    }
  });

  it.each<[string, Partial<Record<Step, Reply>>]>([
    ["a malformed greeting", { greeting: "hello there" }],
    ["a greeting with a short code", { greeting: "22 hi" }],
    ["a dropped connection", { MAIL: "close" }],
  ])("fails without a code on %s", async (_name, replies) => {
    const fake = await fakeSmtp(replies);
    expect(await createSmtpsTransport(smtp, { connect: loopback(fake) }).send(message())).toEqual({ ok: false, code: null });
  });

  it("fails without a code when the connection is refused", async () => {
    const fake = await fakeSmtp();
    const { server } = openServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(await createSmtpsTransport(smtp, { connect: loopback(fake) }).send(message())).toEqual({ ok: false, code: null });
  });

  it("gives up on a silent server at the configured timeout", async () => {
    const fake = await fakeSmtp({ greeting: null });
    expect(await createSmtpsTransport(smtp, { connect: loopback(fake), timeoutMs: 50 }).send(message())).toEqual({ ok: false, code: null });
  });

  it("gives up on a silent server after 30 seconds by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = await fakeSmtp({ greeting: null });
    let settled = false;
    const sending = createSmtpsTransport(smtp, { connect: loopback(fake) }).send(message()).finally(() => { settled = true; });
    await fake.connected;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await sending).toEqual({ ok: false, code: null });
  });

  it("dials TLS with certificate verification and the host as the server name by default", async () => {
    const fake = await fakeSmtp();
    const dial = vi.spyOn(tls, "connect").mockImplementation(() => net.connect(fake.port, "127.0.0.1") as tls.TLSSocket);

    expect(await createSmtpsTransport({ ...smtp, port: 2465 }).send(message())).toEqual({ ok: true });

    expect(dial).toHaveBeenCalledTimes(1);
    expect(dial.mock.calls[0]).toEqual([{ host: "mail.example.net", port: 2465, servername: "mail.example.net", rejectUnauthorized: true }]);
  });
});

describe("recordingTransport", () => {
  it("records each message and answers with the configured result", async () => {
    const transport = recordingTransport({ ok: false, code: 451 });
    const sent = message();

    expect(await transport.send(sent)).toEqual({ ok: false, code: 451 });
    expect(transport.sent).toEqual([sent]);
    expect(await recordingTransport().send(sent)).toEqual({ ok: true });
  });
});
