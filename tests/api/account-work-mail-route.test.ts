import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkMailDeleteHandler,
  createWorkMailGetHandler,
  createWorkMailPostHandler,
  POST as productionPost,
  type WorkMailRouteDependencies,
  type WorkMailStore,
} from "@/app/api/account/work-mail/route";
import { createWorkMailConfirmPostHandler } from "@/app/api/account/work-mail/confirm/route";
import type { ContributorMailConfig } from "@/lib/accounts/work-mail-config";
import type { ConfirmationOutcome, WorkMailSubscription } from "@/lib/accounts/work-mail-store";
import type { SendResult, WorkMailMessage, WorkMailTransport } from "@/lib/accounts/work-mail-transport";
import type { SqlClient } from "@/lib/db/types";
import { expectNoDependencyCall, guardedRequests, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });

const { productionAuth } = vi.hoisted(() => ({ productionAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: productionAuth }));

useTrustedOrigin();
const requests = guardedRequests("/api/account/work-mail");
const confirmRequests = guardedRequests("/api/account/work-mail/confirm");
const sql = {} as SqlClient;
const smtp = { host: "smtp.mail.example.org", port: 465, username: "sender", password: "pw" };
const enabled: ContributorMailConfig = { enabled: true, smtp, from: "work@mail.example.org", dailyLimit: 40 };
const disabled: ContributorMailConfig = { enabled: false, warnings: [] };
const issuedToken = randomBytes(32).toString("base64url");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
afterAll(() => vi.resetModules());

function setup(config: ContributorMailConfig = enabled, result: SendResult = { ok: true }) {
  const sent: WorkMailMessage[] = [];
  const store = {
    requestConfirmation: vi.fn(async (): Promise<ConfirmationOutcome> => ({ kind: "send", token: issuedToken })),
    confirm: vi.fn(async () => true),
    getSubscription: vi.fn(async (): Promise<WorkMailSubscription | null> => null),
    deleteSubscription: vi.fn(async () => true),
  };
  const send = vi.fn(async (message: WorkMailMessage) => {
    sent.push(message);
    return result;
  });
  const dependencies = {
    getSession: vi.fn(async (): Promise<{ user: { id: string } } | null> => ({ user: { id: "internal-id" } })),
    getSql: vi.fn(() => sql),
    findIdentity: vi.fn(async (): Promise<{ githubUserId: number; githubLogin: string } | null> => ({ githubUserId: 42, githubLogin: "alice" })),
    createStore: vi.fn((): WorkMailStore => store),
    readConfig: vi.fn(() => config),
    createTransport: vi.fn((): WorkMailTransport => ({ send })),
  } satisfies WorkMailRouteDependencies;
  return { dependencies, store, send, sent };
}

const post = (deps: WorkMailRouteDependencies, request = requests.json({ address: "  Ada@Example.NET " })) =>
  createWorkMailPostHandler(deps)(request);

function expectOnlyTheSwitchRead(dependencies: ReturnType<typeof setup>["dependencies"]) {
  expect(dependencies.readConfig).toHaveBeenCalledTimes(1);
  expectNoDependencyCall(Object.fromEntries(Object.entries(dependencies).filter(([name]) => name !== "readConfig")));
}

async function settled(send: ReturnType<typeof setup>["send"]) {
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await send.mock.results[0]!.value;
}

describe("GET /api/account/work-mail", () => {
  it("answers the stored subscription with its times as ISO strings", async () => {
    const { dependencies, store } = setup();
    store.getSubscription.mockResolvedValueOnce({
      id: "00000000-0000-4000-8000-000000000001", address: "ada@example.net",
      confirmedAt: new Date("2026-10-01T10:00:00.000Z"), confirmExpiresAt: null,
      lastNotifiedAt: new Date("2026-10-02T11:00:00.000Z"), createdAt: new Date(0), updatedAt: new Date(0),
    });
    const response = await createWorkMailGetHandler(dependencies)();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      subscription: {
        address: "ada@example.net", confirmed: true, confirmedAt: "2026-10-01T10:00:00.000Z",
        lastNotifiedAt: "2026-10-02T11:00:00.000Z", confirmExpiresAt: null,
      },
    });
    expect(store.getSubscription).toHaveBeenCalledWith("internal-id");
    expect(dependencies.createStore).toHaveBeenCalledWith(sql);
  });

  it("answers a pending subscription and a disabled feature, never constructing a transport", async () => {
    const { dependencies, store } = setup(disabled);
    store.getSubscription.mockResolvedValueOnce({
      id: "00000000-0000-4000-8000-000000000001", address: "ada@example.net", confirmedAt: null,
      confirmExpiresAt: new Date("2026-10-03T10:00:00.000Z"), lastNotifiedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
    });
    const response = await createWorkMailGetHandler(dependencies)();
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      subscription: { address: "ada@example.net", confirmed: false, confirmedAt: null, lastNotifiedAt: null,
        confirmExpiresAt: "2026-10-03T10:00:00.000Z" },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("answers null when nothing is stored", async () => {
    const { dependencies } = setup();
    await expect((await createWorkMailGetHandler(dependencies)()).json()).resolves.toEqual({ enabled: true, subscription: null });
  });

  it.each([
    ["no session", 401, "UNAUTHENTICATED"],
    ["no live account", 403, "FORBIDDEN"],
  ])("refuses %s", async (label, status, code) => {
    const { dependencies, store } = setup();
    if (label === "no session") dependencies.getSession.mockResolvedValueOnce(null);
    else dependencies.findIdentity.mockResolvedValueOnce(null);
    const response = await createWorkMailGetHandler(dependencies)();
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    expect(store.getSubscription).not.toHaveBeenCalled();
  });
});

describe("POST /api/account/work-mail", () => {
  it("answers 404 before any dependency when the feature is off, whatever the request", async () => {
    for (const request of [requests.json({ address: "ada@example.net" }), requests.foreignText({})]) {
      const { dependencies } = setup(disabled);
      const response = await post(dependencies, request);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: { code: "NOT_FOUND", message: "Work mail is not enabled on this instance." } });
      expectOnlyTheSwitchRead(dependencies);
    }
  });

  it("stores the parsed address, then mails the confirmation link to it from the configured sender", async () => {
    const { dependencies, store, send, sent } = setup();
    const response = await post(dependencies);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ requested: true });
    expect(store.requestConfirmation).toHaveBeenCalledExactlyOnceWith("internal-id", "Ada@example.net", { dailyLimit: 40 });
    await settled(send);
    expect(dependencies.createTransport).toHaveBeenCalledExactlyOnceWith(smtp);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("Ada@example.net");
    expect(sent[0]!.from).toBe("work@mail.example.org");
    expect(sent[0]!.content.split("\r\n")).toContain(`${trustedOrigin}/dashboard#work-mail-confirm=${issuedToken}`);
  });

  it("answers a suppressed request exactly like a sent one and mails nothing", async () => {
    const sentRun = setup();
    const sentResponse = await post(sentRun.dependencies);
    await settled(sentRun.send);
    const suppressedRun = setup();
    suppressedRun.store.requestConfirmation.mockResolvedValueOnce({ kind: "suppressed" });
    const suppressedResponse = await post(suppressedRun.dependencies);
    expect(suppressedResponse.status).toBe(sentResponse.status);
    expect([...suppressedResponse.headers]).toEqual([...sentResponse.headers]);
    expect(await suppressedResponse.text()).toBe(await sentResponse.text());
    expect(suppressedRun.dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("answers before the mail server does", async () => {
    const { dependencies, send } = setup();
    send.mockImplementationOnce(() => new Promise<SendResult>(() => undefined));
    expect((await post(dependencies)).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a refused send", "reply", { ok: false, code: 550 } as SendResult],
    ["a send that never reached a reply", "none", { ok: false, code: null } as SendResult],
  ])("still answers 202 on %s and logs only the reply code", async (_label, code, result) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dependencies, send } = setup(enabled, result);
    expect((await post(dependencies)).status).toBe(202);
    await settled(send);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(`Work mail confirmation was not sent (reply code ${code === "reply" ? 550 : "none"}).`);
  });

  it("still answers 202 when the message cannot be built for a non-https origin, logging no detail", async () => {
    vi.stubEnv("OVERFLOW_APP_URL", "http://overflow.example");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dependencies } = setup();
    const response = await post(dependencies, requests.json({ address: "ada@example.net" }, "POST", { origin: "http://overflow.example" }));
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith("Work mail confirmation was not sent.");
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("answers the account cap with 429 and the store's Retry-After", async () => {
    const { dependencies, store } = setup();
    store.requestConfirmation.mockResolvedValueOnce({ kind: "account-limited", retryAfterSeconds: 3600 });
    const response = await post(dependencies);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("answers the spent daily ceiling with 503", async () => {
    const { dependencies, store } = setup();
    store.requestConfirmation.mockResolvedValueOnce({ kind: "ceiling" });
    const response = await post(dependencies);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("DAILY_LIMIT_REACHED");
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid address", requests.json({ address: "not an address" })],
    ["a missing address", requests.json({})],
    ["a non-string address", requests.json({ address: ["ada@example.net"] })],
    ["malformed JSON", new Request(requests.url, { method: "POST", headers: { origin: trustedOrigin, "content-type": "application/json" }, body: "{" })],
  ])("refuses %s with 400 before the store", async (_label, request) => {
    const { dependencies, store } = setup();
    const response = await post(dependencies, request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "INVALID_REQUEST", message: "A valid email address is required." } });
    expect(store.requestConfirmation).not.toHaveBeenCalled();
  });

  it("refuses a body over 4 KiB", async () => {
    const { dependencies, store } = setup();
    const response = await post(dependencies, requests.json({ address: "a".repeat(4 * 1024) }));
    expect(response.status).toBe(413);
    expect(store.requestConfirmation).not.toHaveBeenCalled();
  });

  it.each([
    ["a foreign origin", 403, requests.foreignJson({ address: "ada@example.net" })],
    ["a declared non-JSON body", 415, requests.trustedText({ address: "ada@example.net" })],
  ])("refuses %s before any dependency but the switch", async (_label, status, request) => {
    const { dependencies } = setup();
    expect((await post(dependencies, request)).status).toBe(status);
    expectOnlyTheSwitchRead(dependencies);
  });

  it("answers 502 without the store's error text when the store fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { dependencies, store } = setup();
    store.requestConfirmation.mockRejectedValueOnce(new Error("Failing row contains (ada@example.net)"));
    const response = await post(dependencies);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("ada@example.net");
    expect(JSON.stringify(error.mock.calls)).not.toContain("ada@example.net");
    expect(error).toHaveBeenCalledExactlyOnceWith("Work mail request failed.");
  });
});

describe("DELETE /api/account/work-mail", () => {
  it.each([true, false])("deletes the caller's subscription and answers alike whether one existed (%s)", async (existed) => {
    const { dependencies, store } = setup(disabled);
    store.deleteSubscription.mockResolvedValueOnce(existed);
    const response = await createWorkMailDeleteHandler(dependencies)(new Request(requests.url, { method: "DELETE", headers: { origin: trustedOrigin } }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(store.deleteSubscription).toHaveBeenCalledExactlyOnceWith("internal-id");
  });

  it("refuses a foreign origin before any dependency", async () => {
    const { dependencies } = setup();
    expect((await createWorkMailDeleteHandler(dependencies)(requests.foreignJson({}, "DELETE"))).status).toBe(403);
    expectNoDependencyCall(dependencies);
  });
});

describe("POST /api/account/work-mail/confirm", () => {
  const confirm = (deps: WorkMailRouteDependencies, request = confirmRequests.json({ token: issuedToken })) =>
    createWorkMailConfirmPostHandler(deps)(request);

  it("confirms the caller's pending address with the token", async () => {
    const { dependencies, store } = setup();
    const response = await confirm(dependencies);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ confirmed: true });
    expect(store.confirm).toHaveBeenCalledExactlyOnceWith("internal-id", issuedToken);
  });

  it("answers 404 before any dependency when the feature is off", async () => {
    const { dependencies } = setup(disabled);
    expect((await confirm(dependencies)).status).toBe(404);
    expectOnlyTheSwitchRead(dependencies);
  });

  it("gives one answer to every failed confirmation", async () => {
    const failures: [string, Request][] = [
      ["unmatched", confirmRequests.json({ token: issuedToken })],
      ["missing", confirmRequests.json({})],
      ["non-string", confirmRequests.json({ token: 7 })],
      ["malformed", new Request(confirmRequests.url, { method: "POST", headers: { origin: trustedOrigin, "content-type": "application/json" }, body: "{" })],
      ["oversized", confirmRequests.json({ token: "a".repeat(4 * 1024) })],
    ];
    const answers = new Set<string>();
    for (const [label, request] of failures) {
      const { dependencies, store } = setup();
      store.confirm.mockResolvedValueOnce(false);
      const response = await confirm(dependencies, request);
      answers.add(`${response.status} ${await response.text()}`);
      expect(store.confirm.mock.calls.length, label).toBe(label === "unmatched" ? 1 : 0);
    }
    expect([...answers]).toEqual([
      '400 {"error":{"code":"INVALID_CONFIRMATION","message":"The confirmation link is invalid or has expired."}}',
    ]);
  });

  it("refuses a foreign origin and an anonymous caller", async () => {
    const { dependencies } = setup();
    expect((await confirm(dependencies, confirmRequests.foreignJson({ token: issuedToken }))).status).toBe(403);
    dependencies.getSession.mockResolvedValueOnce(null);
    expect((await confirm(dependencies)).status).toBe(401);
  });
});

describe("production POST /api/account/work-mail", () => {
  it("answers 404 without reading the session while contributor mail is unset", async () => {
    for (const name of ["CONTRIBUTOR_MAIL_SMTP_URL", "CONTRIBUTOR_MAIL_FROM", "CONTRIBUTOR_MAIL_DAILY_LIMIT"]) {
      vi.stubEnv(`OVERFLOW_${name}`, undefined);
      vi.stubEnv(name, undefined);
    }
    const response = await productionPost(requests.json({ address: "ada@example.net" }));
    expect(response.status).toBe(404);
    expect(productionAuth).not.toHaveBeenCalled();
  });
});
