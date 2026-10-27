import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DueSubscription } from "@/lib/accounts/work-mail-store";
import type { SendResult, WorkMailMessage, WorkMailTransport } from "@/lib/accounts/work-mail-transport";
import type { EligibleIssueFilters } from "@/lib/dashboard/eligible-issues";
import { verifyUnsubscribeToken } from "@/lib/accounts/work-mail-unsubscribe";
import { recordingTransport } from "../support/work-mail-recording-transport";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });

const { built } = vi.hoisted(() => ({ built: [] as { to: string; count: number; origin: string; from: string }[] }));
vi.mock("@/lib/accounts/work-mail-transport", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounts/work-mail-transport")>();
  return {
    ...actual,
    buildDigestMessage: (input: Parameters<typeof actual.buildDigestMessage>[0]) => {
      built.push({ to: input.to, count: input.count, origin: input.origin, from: input.from });
      return actual.buildDigestMessage(input);
    },
  };
});

const { runWorkMailDigestCycle, startWorkMailDigest, WORK_MAIL_DIGEST_INTERVAL_MS } = await import("@/lib/accounts/work-mail-digest");

const origin = "https://overflow.example";
const from = "work@mail.example.org";
const t0 = new Date("2026-10-27T12:00:00.000Z");
const hours = (n: number) => n * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(t0.getTime() + offsetMs);
const tokenKey = randomBytes(32).toString("base64url");

type Claim = { address: string } | false | "ceiling";

function due(overrides: Partial<DueSubscription> = {}): DueSubscription {
  const id = randomUUID();
  return { id, userId: `user-${id}`, address: `${id.slice(0, 8)}@example.net`, watermark: at(-hours(30)), lastNotifiedAt: null, ...overrides };
}

/** A board per account: every listed issue's creation time, served in the board's pages. */
function fakeWorld(rows: DueSubscription[], boards: Record<string, Date[]>) {
  const calls: string[] = [];
  const listIssues = vi.fn(async (accountId: string, filters: EligibleIssueFilters) => {
    const board = boards[accountId] ?? [];
    const page = filters.page ?? 1;
    const size = filters.pageSize ?? 200;
    return board.slice((page - 1) * size, page * size).map((created) => ({ createdAt: created.toISOString() }));
  });
  const store = {
    dbNow: vi.fn(async () => { calls.push("dbNow"); return t0; }),
    listDueSubscriptions: vi.fn(async () => { calls.push("listDue"); return rows; }),
    hasIssueCreatedAfter: vi.fn<(after: Date) => Promise<boolean>>(async () => true),
    claimDigestSlot: vi.fn<(id: string, prev: Date | null, t0: Date, limit: number) => Promise<Claim>>(async (id) =>
      ({ address: rows.find((row) => row.id === id)!.address })),
  };
  return { store, listIssues, calls };
}

function run(world: ReturnType<typeof fakeWorld>, transport: WorkMailTransport = recordingTransport(), extra: { readOrigin?: () => string | null } = {}) {
  return runWorkMailDigestCycle({
    store: world.store, transport, from, dailyLimit: 7, listIssues: world.listIssues,
    readOrigin: extra.readOrigin ?? (() => origin), mintToken: (id) => `token-${id}`,
  });
}

beforeEach(() => { built.length = 0; });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(() => vi.resetModules());

describe("the digest cycle", () => {
  it("reads the database clock before the due list and claims with it, the listed previous stamp and the limit", async () => {
    const lastNotifiedAt = at(-hours(25));
    const row = due({ watermark: lastNotifiedAt, lastNotifiedAt });
    const world = fakeWorld([row], { [row.userId]: [at(-hours(1))] });
    const transport = recordingTransport();
    await expect(run(world, transport)).resolves.toEqual({ due: 1, sent: 1, failed: 0, ceiling: false });
    expect(world.calls).toEqual(["dbNow", "listDue"]);
    expect(world.store.claimDigestSlot).toHaveBeenCalledExactlyOnceWith(row.id, lastNotifiedAt, t0, 7);
    expect(transport.sent).toHaveLength(1);
    expect(built).toEqual([{ to: row.address, count: 1, origin, from }]);
  });

  it("counts issues created after the watermark and no later than the cycle start", async () => {
    const row = due({ watermark: at(-hours(30)) });
    const world = fakeWorld([row], {
      [row.userId]: [at(-hours(31)), at(-hours(30)), at(-hours(30) + 1), at(-hours(2)), at(0), at(1)],
    });
    await run(world);
    expect(built.map((input) => input.count)).toEqual([3]);
  });

  it("pages the open-claim board 500 at a time until a short page", async () => {
    const row = due();
    // The one new issue sits on the second page.
    const board = [...Array.from({ length: 500 }, () => at(-hours(40))), at(-hours(1)), ...Array.from({ length: 499 }, () => at(-hours(40)))];
    const world = fakeWorld([row], { [row.userId]: board });
    await run(world);
    expect(world.listIssues.mock.calls).toEqual([
      [row.userId, { claimState: "OPEN", pageSize: 500, page: 1 }],
      [row.userId, { claimState: "OPEN", pageSize: 500, page: 2 }],
      [row.userId, { claimState: "OPEN", pageSize: 500, page: 3 }],
    ]);
    expect(built.map((input) => input.count)).toEqual([1]);
  });

  it("neither claims nor mails a row with no new work, and still serves the next row", async () => {
    const quiet = due({ watermark: at(-hours(10)) });
    const busy = due({ watermark: at(-hours(10)) });
    const world = fakeWorld([quiet, busy], { [quiet.userId]: [at(-hours(11))], [busy.userId]: [at(-hours(9))] });
    const transport = recordingTransport();
    await expect(run(world, transport)).resolves.toEqual({ due: 2, sent: 1, failed: 0, ceiling: false });
    expect(world.store.claimDigestSlot.mock.calls.map((call) => call[0])).toEqual([busy.id]);
    expect(transport.sent.map((message) => message.to)).toEqual([busy.address]);
  });

  it("stops before listing any board when nothing is due or no issue is newer than the oldest watermark", async () => {
    const empty = fakeWorld([], {});
    await expect(run(empty)).resolves.toEqual({ due: 0, sent: 0, failed: 0, ceiling: false });
    expect(empty.store.hasIssueCreatedAfter).not.toHaveBeenCalled();
    const newer = due({ watermark: at(-hours(2)) });
    const older = due({ watermark: at(-hours(50)) });
    const quiet = fakeWorld([newer, older], { [newer.userId]: [at(-hours(1))] });
    quiet.store.hasIssueCreatedAfter.mockResolvedValueOnce(false);
    await run(quiet);
    expect(quiet.store.hasIssueCreatedAfter).toHaveBeenCalledExactlyOnceWith(older.watermark);
    expect(quiet.listIssues).not.toHaveBeenCalled();
    expect(quiet.store.claimDigestSlot).not.toHaveBeenCalled();
  });

  it("mails nothing for a slot another cycle took, and goes on to the next row", async () => {
    const taken = due();
    const free = due();
    const world = fakeWorld([taken, free], { [taken.userId]: [at(-hours(1))], [free.userId]: [at(-hours(1))] });
    world.store.claimDigestSlot.mockResolvedValueOnce(false);
    const transport = recordingTransport();
    await run(world, transport);
    expect(transport.sent.map((message) => message.to)).toEqual([free.address]);
  });

  it("mails the address the claim returns, not the listed one", async () => {
    const row = due();
    const world = fakeWorld([row], { [row.userId]: [at(-hours(1))] });
    world.store.claimDigestSlot.mockResolvedValueOnce({ address: "replaced@example.net" });
    const transport = recordingTransport();
    await run(world, transport);
    expect(transport.sent.map((message) => message.to)).toEqual(["replaced@example.net"]);
  });

  it("ends the cycle at the daily ceiling without claiming another row", async () => {
    const rows = [due(), due(), due()];
    const world = fakeWorld(rows, Object.fromEntries(rows.map((row) => [row.userId, [at(-hours(1))]])));
    world.store.claimDigestSlot.mockResolvedValueOnce({ address: rows[0]!.address }).mockResolvedValueOnce("ceiling");
    const transport = recordingTransport();
    await expect(run(world, transport)).resolves.toEqual({ due: 3, sent: 1, failed: 0, ceiling: true });
    expect(world.store.claimDigestSlot).toHaveBeenCalledTimes(2);
    expect(world.listIssues.mock.calls.map((call) => call[0])).toEqual([rows[0]!.userId, rows[1]!.userId]);
    expect(transport.sent).toHaveLength(1);
  });

  it("counts a refused or failed send against its row only, logging no address, and never retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rows = [due(), due(), due()];
    const world = fakeWorld(rows, Object.fromEntries(rows.map((row) => [row.userId, [at(-hours(1))]])));
    const results: (SendResult | Error)[] = [{ ok: false, code: 550 }, new Error(`socket closed for ${rows[1]!.address}`), { ok: true }];
    const attempts: WorkMailMessage[] = [];
    const transport = {
      send: vi.fn(async (message: WorkMailMessage) => {
        attempts.push(message);
        const result = results.shift()!;
        if (result instanceof Error) throw result;
        return result;
      }),
    };
    await expect(run(world, transport)).resolves.toEqual({ due: 3, sent: 1, failed: 2, ceiling: false });
    expect(attempts.map((message) => message.to)).toEqual(rows.map((row) => row.address));
    expect(warn.mock.calls).toEqual([["Work mail digest was not sent (reply code 550)."], ["Work mail digest was not sent."]]);
  });

  it("treats a message that cannot be built as a failed send for that row, not the cycle", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rows = [due(), due()];
    const world = fakeWorld(rows, Object.fromEntries(rows.map((row) => [row.userId, [at(-hours(1))]])));
    const transport = recordingTransport();
    await expect(run(world, transport, { readOrigin: () => null })).resolves.toEqual({ due: 2, sent: 0, failed: 2, ceiling: false });
    expect(world.store.claimDigestSlot).toHaveBeenCalledTimes(2);
    expect(transport.sent).toEqual([]);
    expect(warn.mock.calls).toEqual([["Work mail digest was not sent."], ["Work mail digest was not sent."]]);
  });

  it("links the configured app origin and mints the subscription's one-click opt-out by default", async () => {
    vi.stubEnv("OVERFLOW_TOKEN_ENCRYPTION_KEY", tokenKey);
    vi.stubEnv("OVERFLOW_APP_URL", "https://board.overflow.example/");
    const row = due();
    const world = fakeWorld([row], { [row.userId]: [at(-hours(1))] });
    const transport = recordingTransport();
    await runWorkMailDigestCycle({ store: world.store, transport, from, dailyLimit: 7, listIssues: world.listIssues });
    expect(built.map((input) => input.origin)).toEqual(["https://board.overflow.example"]);
    const header = transport.sent[0]!.content.split("\r\n").find((line) => line.startsWith("List-Unsubscribe: "))!;
    const token = /[?&]token=([^>]+)>$/.exec(header)![1]!;
    expect(verifyUnsubscribeToken(token, tokenKey, undefined)).toBe(row.id);
  });
});

describe("the hourly digest schedule", () => {
  const config = { enabled: true as const, smtp: { host: "smtp.mail.example.org", port: 465, username: "u", password: "p" }, from, dailyLimit: 7 };

  function heldStore() {
    let release: () => void = () => undefined;
    const store = {
      dbNow: vi.fn(() => new Promise<Date>((resolve) => { release = () => resolve(t0); })),
      listDueSubscriptions: vi.fn(async () => [] as DueSubscription[]),
      hasIssueCreatedAfter: vi.fn(async () => false),
      claimDigestSlot: vi.fn(async (): Promise<Claim> => false),
    };
    return { store, release: () => release() };
  }

  it("runs a cycle once an hour, never two at once in one process", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { store, release } = heldStore();
    startWorkMailDigest(config, { createStore: () => store, transport: recordingTransport() });
    await vi.advanceTimersByTimeAsync(WORK_MAIL_DIGEST_INTERVAL_MS - 1);
    expect(store.dbNow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.dbNow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WORK_MAIL_DIGEST_INTERVAL_MS);
    expect(store.dbNow).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.listDueSubscriptions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WORK_MAIL_DIGEST_INTERVAL_MS);
    expect(store.dbNow).toHaveBeenCalledTimes(2);
  });

  it("logs a failed cycle on a fixed line and runs the next one", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    let attempt = 0;
    const createStore = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("no database for ada@example.net");
      return { ...heldStore().store, dbNow: vi.fn(async () => { throw new Error("failing row (ada@example.net)"); }) };
    });
    startWorkMailDigest(config, { createStore, transport: recordingTransport() });
    await vi.advanceTimersByTimeAsync(WORK_MAIL_DIGEST_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(WORK_MAIL_DIGEST_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(WORK_MAIL_DIGEST_INTERVAL_MS);
    expect(createStore).toHaveBeenCalledTimes(3);
    expect(error.mock.calls).toEqual([["Work mail digest cycle failed."], ["Work mail digest cycle failed."], ["Work mail digest cycle failed."]]);
  });

  it("logs each cycle's counts", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const store = { ...heldStore().store, dbNow: vi.fn(async () => t0) };
    startWorkMailDigest(config, { createStore: () => store, transport: recordingTransport() });
    await vi.advanceTimersByTimeAsync(WORK_MAIL_DIGEST_INTERVAL_MS);
    expect(info).toHaveBeenCalledExactlyOnceWith("Work mail digest", { due: 0, sent: 0, failed: 0, ceiling: false });
  });
});
