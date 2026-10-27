import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contributor mail at server start: off unless all three variables are valid,
 * in which case one hourly digest interval and one transport are wired.
 */

const { createTransport, startSweep, startWorker } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  startSweep: vi.fn(),
  startWorker: vi.fn(),
}));

vi.mock("@/lib/accounts/work-mail-transport", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounts/work-mail-transport")>();
  return { ...actual, createSmtpsTransport: createTransport.mockImplementation(actual.createSmtpsTransport) };
});
vi.mock("@/lib/github/app-installation-auth", async (importActual) => ({
  ...await importActual<typeof import("@/lib/github/app-installation-auth")>(),
  readGitHubRegistrationAppAuthConfig: () => null,
}));
vi.mock("@/lib/fold/abandoned-runs", () => ({ finalizeAbandonedRuns: async () => ({ finalized: 0, skippedLocked: 0 }) }));
vi.mock("@/lib/fold/reconciliation-worker", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/fold/reconciliation-worker")>()),
  startReconciliationWorker: startWorker,
}));
vi.mock("@/lib/fold/sweep", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/fold/sweep")>()),
  startReconciliationSweep: startSweep,
}));
vi.mock("@/lib/db/client", () => ({ getSql: vi.fn(), getCoordinationSql: vi.fn() }));
vi.mock("@/lib/fold/postgres-store", () => ({ PostgresFoldStore: class {} }));

const MAIL_VARIABLES = ["CONTRIBUTOR_MAIL_SMTP_URL", "CONTRIBUTOR_MAIL_FROM", "CONTRIBUTOR_MAIL_DAILY_LIMIT"];
// Assembled at runtime: no credential-shaped literal in the tree.
const smtpUrl = `smtps://sender:${["fixture", "secret"].join("-")}@smtp.mail.example.org`;

function mailEnv(values: Partial<Record<(typeof MAIL_VARIABLES)[number], string>>) {
  for (const name of MAIL_VARIABLES) {
    vi.stubEnv(name, undefined);
    vi.stubEnv(`OVERFLOW_${name}`, values[name]);
  }
}

async function register() {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
  const intervals = vi.spyOn(globalThis, "setInterval").mockImplementation((() => ({ unref() {} })) as never);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { registerNodejs } = await import("@/instrumentation-node");
  await registerNodejs();
  expect(startSweep).toHaveBeenCalledTimes(1);
  return { intervals, warn };
}

beforeEach(() => {
  vi.resetModules();
  createTransport.mockClear();
  startSweep.mockReset();
  startWorker.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => { vi.resetModules(); });

describe("contributor mail at server start", () => {
  it("with every variable unset starts no digest interval, constructs no transport, and the opt-in POST answers 404", async () => {
    mailEnv({});
    const { intervals, warn } = await register();
    expect(intervals).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    const { POST } = await import("@/app/api/account/work-mail/route");
    const response = await POST(new Request("https://overflow.example/api/account/work-mail", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "ada@example.net" }),
    }));
    expect(response.status).toBe(404);
  });

  it("with a valid configuration arms one hourly interval and one transport", async () => {
    mailEnv({ CONTRIBUTOR_MAIL_SMTP_URL: smtpUrl, CONTRIBUTOR_MAIL_FROM: "work@mail.example.org", CONTRIBUTOR_MAIL_DAILY_LIMIT: "40" });
    const { intervals, warn } = await register();
    expect(intervals).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 60 * 60 * 1000);
    expect(createTransport).toHaveBeenCalledExactlyOnceWith(
      { host: "smtp.mail.example.org", port: 465, username: "sender", password: ["fixture", "secret"].join("-") });
    expect(warn).not.toHaveBeenCalled();
  });

  it("with a partial configuration warns once per invalid variable, never its value, and starts nothing", async () => {
    mailEnv({ CONTRIBUTOR_MAIL_SMTP_URL: smtpUrl, CONTRIBUTOR_MAIL_DAILY_LIMIT: "0" });
    const { intervals, warn } = await register();
    expect(intervals).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      ["OVERFLOW_CONTRIBUTOR_MAIL_FROM is unset or invalid; contributor mail stays off."],
      ["OVERFLOW_CONTRIBUTOR_MAIL_DAILY_LIMIT is unset or invalid; contributor mail stays off."],
    ]);
  });
});
