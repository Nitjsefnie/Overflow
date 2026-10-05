import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  awaitPrSuite,
  SUITE_WORKFLOW_PATH,
  type AwaitDeps,
} from "../../scripts/await-pr-suite.ts";

/**
 * The pull-request suite awaiter: the base-defined verify job takes the
 * outcome of the pull request's own suite run as data. awaitPrSuite polls the
 * workflow-run listing at the head SHA through an injected fetch, keeps only
 * runs of the suite workflow at exactly that SHA, waits for the newest one to
 * complete, and succeeds only on a `success` conclusion — every other outcome
 * fails closed. The clock and the sleeps are injected, so nothing here touches
 * the network or really waits.
 */

const REPO = "Nitjsefnie/Overflow";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const TOKEN = "test-token";
const LISTING_URL =
  `https://api.github.com/repos/${REPO}/actions/workflows/pr-suite.yml/runs` +
  `?head_sha=${SHA}&event=pull_request&per_page=100`;

interface FakeRun {
  id: number;
  path: string;
  head_sha: string;
  event: string;
  status?: string;
  conclusion: string | null;
  created_at: string;
}

function suiteRun(over: Partial<FakeRun> = {}): FakeRun {
  return {
    id: 100,
    path: SUITE_WORKFLOW_PATH,
    head_sha: SHA,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-05T10:00:00Z",
    ...over,
  };
}

type Reply = FakeRun[] | { status: number; body?: string } | Error;

interface Harness {
  deps: AwaitDeps;
  calls: { url: string; headers: Record<string, string>; signal: unknown }[];
  sleeps: number[];
  /** Every logged line and every sleep, in the order they happened. */
  events: string[];
}

/**
 * One fake GitHub per test. Each listing call consumes the next reply; the
 * last reply repeats once the script runs out, so a test need not script every
 * poll up to the deadline. The clock advances only by the injected sleeps.
 */
function harness(replies: Reply[], env: Record<string, string | undefined> = {}): Harness {
  const calls: Harness["calls"] = [];
  const sleeps: number[] = [];
  const events: string[] = [];
  let clock = 1_000_000;
  let index = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal,
    });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply instanceof Error) throw reply;
    if (Array.isArray(reply)) {
      return new Response(JSON.stringify({ total_count: reply.length, workflow_runs: reply }), {
        status: 200,
      });
    }
    return new Response(reply?.body ?? "", { status: reply?.status ?? 500 });
  }) as typeof fetch;
  return {
    calls,
    sleeps,
    events,
    deps: {
      env: {
        GITHUB_REPOSITORY: REPO,
        GH_TOKEN: TOKEN,
        HEAD_SHA: SHA,
        SUITE_DEADLINE_SECONDS: "300",
        SUITE_POLL_SECONDS: "30",
        ...env,
      },
      fetchFn,
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
        events.push(`sleep ${ms}`);
        clock += ms;
      },
      nowFn: () => clock,
      logFn: (line: string) => {
        events.push(`log ${line}`);
      },
    },
  };
}

function errorLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith("::error::"));
}

describe("awaitPrSuite — success", () => {
  it("succeeds once the suite run completes with success after several polls", async () => {
    const h = harness([
      [],
      [suiteRun({ status: "queued", conclusion: null })],
      [suiteRun({ status: "in_progress", conclusion: null })],
      [suiteRun()],
    ]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.runId).toBe(100);
    expect(errorLines(outcome.lines)).toEqual([]);
    expect(outcome.lines.some((line) => line.includes("100"))).toBe(true);
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toEqual([30_000, 30_000, 30_000]);
  });

  it("logs each progress line as it happens, before the sleep that follows it", async () => {
    const h = harness([[], [suiteRun({ status: "queued", conclusion: null })], [suiteRun()]]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(h.events.map((event) => event.replace(/^(log|sleep) .*$/, "$1"))).toEqual([
      "log",
      "sleep",
      "log",
      "sleep",
      "log",
    ]);
    expect(h.events.filter((event) => event.startsWith("log ")).map((e) => e.slice(4))).toEqual(
      outcome.lines,
    );
  });

  it("queries the documented listing with the API headers and the bearer token", async () => {
    const h = harness([[suiteRun()]]);
    await awaitPrSuite(h.deps);
    expect(h.calls[0]?.url).toBe(LISTING_URL);
    expect(h.calls[0]?.headers).toMatchObject({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("appends run_id to GITHUB_OUTPUT when it is set, after any existing content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "await-pr-suite-"));
    try {
      const outputPath = join(dir, "output");
      writeFileSync(outputPath, "earlier=1\n");
      const h = harness([[suiteRun({ id: 4242 })]], { GITHUB_OUTPUT: outputPath });
      const outcome = await awaitPrSuite(h.deps);
      expect(outcome.exitCode).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toBe("earlier=1\nrun_id=4242\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing to GITHUB_OUTPUT when the run did not succeed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "await-pr-suite-"));
    try {
      const outputPath = join(dir, "output");
      writeFileSync(outputPath, "");
      const h = harness([[suiteRun({ conclusion: "failure" })]], { GITHUB_OUTPUT: outputPath });
      const outcome = await awaitPrSuite(h.deps);
      expect(outcome.exitCode).toBe(1);
      expect(readFileSync(outputPath, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("awaitPrSuite — run selection", () => {
  it("ignores a run of another workflow path, even a successful one", async () => {
    const h = harness([
      [suiteRun({ id: 1, path: ".github/workflows/ci.yml" })],
      [suiteRun({ id: 1, path: ".github/workflows/ci.yml" }), suiteRun({ id: 2, conclusion: "failure" })],
    ]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(errorLines(outcome.lines).join("\n")).toContain("failure");
  });

  it("ignores a path that merely ends with the suite's path", async () => {
    const h = harness([[suiteRun({ path: `nested/${SUITE_WORKFLOW_PATH}` })]], {
      SUITE_DEADLINE_SECONDS: "60",
    });
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(errorLines(outcome.lines).join("\n")).toMatch(/no .*run/i);
  });

  it("ignores a run at another head SHA, even a successful one", async () => {
    const h = harness([[suiteRun({ head_sha: OTHER_SHA })]], { SUITE_DEADLINE_SECONDS: "60" });
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.runId).toBeUndefined();
  });

  it("ignores a run of another event, even a successful one", async () => {
    const h = harness([[suiteRun({ event: "pull_request_target" })]], {
      SUITE_DEADLINE_SECONDS: "60",
    });
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.runId).toBeUndefined();
    expect(errorLines(outcome.lines).join("\n")).toMatch(/no .*run/i);
  });

  it("selects the most recently created run when several exist", async () => {
    const h = harness([
      [
        suiteRun({ id: 900, created_at: "2026-10-05T09:00:00Z", conclusion: "success" }),
        suiteRun({ id: 10, created_at: "2026-10-05T11:00:00Z", conclusion: "failure" }),
        suiteRun({ id: 500, created_at: "2026-10-05T10:00:00Z", conclusion: "success" }),
      ],
    ]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(errorLines(outcome.lines).join("\n")).toContain("10");
  });

  it("waits on the newest run while it runs even when an older one succeeded", async () => {
    const h = harness([
      [
        suiteRun({ id: 1, created_at: "2026-10-05T09:00:00Z" }),
        suiteRun({ id: 2, created_at: "2026-10-05T10:00:00Z", status: "in_progress", conclusion: null }),
      ],
      [
        suiteRun({ id: 1, created_at: "2026-10-05T09:00:00Z" }),
        suiteRun({ id: 2, created_at: "2026-10-05T10:00:00Z" }),
      ],
    ]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.runId).toBe(2);
    expect(h.calls).toHaveLength(2);
  });

  it("breaks a created_at tie by the highest id", async () => {
    const h = harness([
      [
        suiteRun({ id: 7, conclusion: "success" }),
        suiteRun({ id: 8, conclusion: "cancelled" }),
        suiteRun({ id: 6, conclusion: "success" }),
      ],
    ]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(errorLines(outcome.lines).join("\n")).toContain("cancelled");
  });

  it("fails closed at once when a matching run carries no status", async () => {
    const run = suiteRun();
    delete run.status;
    const h = harness([[run]]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.runId).toBeUndefined();
    expect(h.calls).toHaveLength(1);
    expect(errorLines(outcome.lines)).toHaveLength(1);
  });

  it("keeps waiting on a run reporting success before it is completed", async () => {
    const h = harness(
      [[suiteRun({ status: "in_progress" })], [suiteRun({ status: "in_progress" })], [suiteRun()]],
    );
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(h.calls).toHaveLength(3);
  });

  it("fails at the deadline on a run reporting success that never completes", async () => {
    const h = harness([[suiteRun({ id: 31, status: "in_progress" })]], {
      SUITE_DEADLINE_SECONDS: "60",
    });
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.runId).toBeUndefined();
    expect(errorLines(outcome.lines).join("\n")).toContain("in_progress");
  });

  it("fails closed when a matching run carries no usable id or creation time", async () => {
    const h = harness([[suiteRun(), suiteRun({ id: 2, created_at: "not-a-date" })]]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(errorLines(outcome.lines)).toHaveLength(1);
  });
});

describe("awaitPrSuite — non-success outcomes fail closed", () => {
  it.each(["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale"])(
    "a completed run concluding %s exits 1 and names the conclusion",
    async (conclusion) => {
      const h = harness([[suiteRun({ conclusion })]]);
      const outcome = await awaitPrSuite(h.deps);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.runId).toBeUndefined();
      const errors = errorLines(outcome.lines);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(conclusion);
    },
  );

  it("a completed run with no conclusion exits 1", async () => {
    const h = harness([[suiteRun({ conclusion: null })]]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(errorLines(outcome.lines)).toHaveLength(1);
  });

  it("no run found before the deadline exits 1, after polling up to the deadline", async () => {
    const h = harness([[]], { SUITE_DEADLINE_SECONDS: "100", SUITE_POLL_SECONDS: "30" });
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(errorLines(outcome.lines).join("\n")).toMatch(/no .*run/i);
    // Polls at 0, 30, 60, 90 and a last one at the deadline (100); never past it.
    expect(h.sleeps).toEqual([30_000, 30_000, 30_000, 10_000]);
    expect(h.calls).toHaveLength(5);
  });

  it("the deadline reached while the run is in progress exits 1 and names the run", async () => {
    const h = harness([[suiteRun({ id: 77, status: "in_progress", conclusion: null })]], {
      SUITE_DEADLINE_SECONDS: "90",
    });
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    const errors = errorLines(outcome.lines).join("\n");
    expect(errors).toContain("77");
    expect(errors).toContain("in_progress");
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(90_000);
  });

  it("uses a 2400-second deadline and a 30-second poll by default", async () => {
    const h = harness([[]], { SUITE_DEADLINE_SECONDS: undefined, SUITE_POLL_SECONDS: undefined });
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(h.sleeps.every((ms) => ms === 30_000)).toBe(true);
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(2_400_000);
  });
});

describe("awaitPrSuite — API failures", () => {
  it.each([404, 401, 403, 422])("an HTTP %i fails at once with no retry", async (status) => {
    const h = harness([{ status, body: '{"message":"nope"}' }, [suiteRun()]]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(errorLines(outcome.lines).join("\n")).toContain(String(status));
  });

  it("retries a 5xx through the 1s-then-2s backoff and then succeeds", async () => {
    const h = harness([{ status: 502 }, { status: 503 }, [suiteRun()]]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1_000, 2_000]);
  });

  it("retries a 429 and a network error", async () => {
    const h = harness([{ status: 429 }, new Error("socket hang up"), [suiteRun()]]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(h.calls).toHaveLength(3);
  });

  it("fails after three attempts of transient errors", async () => {
    const h = harness([{ status: 500 }]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(h.calls).toHaveLength(3);
    expect(errorLines(outcome.lines).join("\n")).toContain("500");
  });

  it("fails on a listing that is not JSON, has no workflow_runs array or no total_count", async () => {
    for (const body of ["<html>", '{"total_count":0}', '{"workflow_runs":[]}', "null"]) {
      const h = harness([{ status: 200, body }]);
      const outcome = await awaitPrSuite(h.deps);
      expect(outcome.exitCode).toBe(1);
      expect(errorLines(outcome.lines)).toHaveLength(1);
    }
  });

  it("fails closed when total_count says the listing holds more runs than it returned", async () => {
    const body = JSON.stringify({ total_count: 101, workflow_runs: [suiteRun()] });
    const h = harness([{ status: 200, body }]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.runId).toBeUndefined();
    expect(errorLines(outcome.lines).join("\n")).toContain("101");
  });

  it("gives every request an abort signal that has not fired", async () => {
    const h = harness([[], [suiteRun()]]);
    await awaitPrSuite(h.deps);
    expect(h.calls).toHaveLength(2);
    for (const call of h.calls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect((call.signal as AbortSignal).aborted).toBe(false);
    }
  });

  it("retries a request that timed out", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const h = harness([timeout, [suiteRun()]]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([1_000]);
  });

  it("never prints the token", async () => {
    const h = harness([{ status: 401, body: '{"message":"Bad credentials"}' }]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.lines.join("\n")).not.toContain(TOKEN);
  });
});

describe("awaitPrSuite — input validation", () => {
  it.each<[string, Record<string, string | undefined>]>([
    ["missing GITHUB_REPOSITORY", { GITHUB_REPOSITORY: undefined }],
    ["GITHUB_REPOSITORY without an owner", { GITHUB_REPOSITORY: "Overflow" }],
    ["GITHUB_REPOSITORY with extra segments", { GITHUB_REPOSITORY: "a/b/c" }],
    ["GITHUB_REPOSITORY with a query", { GITHUB_REPOSITORY: "a/b?x=1" }],
    ["GITHUB_REPOSITORY with a dot-dot repo", { GITHUB_REPOSITORY: "a/.." }],
    ["GITHUB_REPOSITORY with a dot repo", { GITHUB_REPOSITORY: "a/." }],
    ["GITHUB_REPOSITORY with a dot-dot owner", { GITHUB_REPOSITORY: "../b" }],
    ["GITHUB_REPOSITORY with a leading-dot repo", { GITHUB_REPOSITORY: "a/.b" }],
    ["missing GH_TOKEN", { GH_TOKEN: undefined }],
    ["empty GH_TOKEN", { GH_TOKEN: "" }],
    ["missing HEAD_SHA", { HEAD_SHA: undefined }],
    ["a short HEAD_SHA", { HEAD_SHA: "abc1234" }],
    ["an uppercase HEAD_SHA", { HEAD_SHA: "A".repeat(40) }],
    ["a non-numeric deadline", { SUITE_DEADLINE_SECONDS: "soon" }],
    ["a zero deadline", { SUITE_DEADLINE_SECONDS: "0" }],
    ["a negative poll", { SUITE_POLL_SECONDS: "-5" }],
    ["a zero poll", { SUITE_POLL_SECONDS: "0" }],
    ["a fractional poll", { SUITE_POLL_SECONDS: "1.5" }],
  ])("%s exits 2 without calling the API", async (_label, env) => {
    const h = harness([[suiteRun()]], env);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(2);
    expect(h.calls).toEqual([]);
    expect(errorLines(outcome.lines)).toHaveLength(1);
  });
});

describe("awaitPrSuite — the error line cannot be split", () => {
  it("escapes line breaks in API-supplied text so each failure is one workflow command", async () => {
    const h = harness([{ status: 404, body: "first\nsecond\r\nthird 100%" }]);
    const outcome = await awaitPrSuite(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.every((line) => !line.includes("\n") && !line.includes("\r"))).toBe(true);
    expect(errorLines(outcome.lines)[0]).toContain("first%0Asecond%0D%0Athird 100%25");
  });
});

describe("the CLI, as a spawned process", () => {
  const SCRIPT = new URL("../../scripts/await-pr-suite.ts", import.meta.url);
  // A preload that replaces the global fetch, so the real entry runs end to
  // end with no network: AWAIT_STUB_MODE picks the listing it answers with.
  const STUB = `
    const mode = process.env.AWAIT_STUB_MODE;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (mode === "empty-then-hang" && calls > 1) return new Promise(() => {});
      const runs = mode === "empty-then-hang" ? [] : [{
        id: 555,
        path: ".github/workflows/pr-suite.yml",
        head_sha: process.env.HEAD_SHA,
        event: "pull_request",
        status: "completed",
        conclusion: mode === "failure" ? "failure" : "success",
        created_at: "2026-10-05T10:00:00Z",
      }];
      return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
    };
  `;

  function run(
    scriptPath: string,
    env: Record<string, string>,
    stubPath?: string,
  ): { status: number | null; stdout: string } {
    const args = stubPath === undefined ? [] : ["--import", pathToFileURL(stubPath).href];
    // Only what the script reads: no inherited GITHUB_OUTPUT or token.
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", ...env };
    const result = spawnSync(process.execPath, [...args, scriptPath], {
      env: childEnv as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    expect(result.signal).toBeNull();
    return { status: result.status, stdout: result.stdout };
  }

  function withDir(body: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "await-pr-suite-cli-"));
    try {
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const GOOD_ENV = { GITHUB_REPOSITORY: REPO, GH_TOKEN: TOKEN, HEAD_SHA: SHA };

  it("exits 2 with one ::error:: line on a malformed environment", () => {
    const result = run(SCRIPT.pathname, { HEAD_SHA: "abc" });
    expect(result.status).toBe(2);
    expect(errorLines(result.stdout.split("\n"))).toHaveLength(1);
  });

  it("still runs when invoked through a symlink to the script", () => {
    withDir((dir) => {
      const link = join(dir, "await-pr-suite.ts");
      symlinkSync(SCRIPT.pathname, link);
      const result = run(link, { HEAD_SHA: "abc" });
      expect(result.status).toBe(2);
      expect(errorLines(result.stdout.split("\n"))).toHaveLength(1);
    });
  });

  it("exits 0 and writes run_id on a successful suite run", () => {
    withDir((dir) => {
      const stub = join(dir, "stub.mjs");
      writeFileSync(stub, STUB);
      const output = join(dir, "output");
      writeFileSync(output, "");
      const result = run(
        SCRIPT.pathname,
        { ...GOOD_ENV, AWAIT_STUB_MODE: "success", GITHUB_OUTPUT: output },
        stub,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("555");
      expect(readFileSync(output, "utf8")).toBe("run_id=555\n");
    });
  });

  it("exits 1 on a failed suite run", () => {
    withDir((dir) => {
      const stub = join(dir, "stub.mjs");
      writeFileSync(stub, STUB);
      const result = run(SCRIPT.pathname, { ...GOOD_ENV, AWAIT_STUB_MODE: "failure" }, stub);
      expect(result.status).toBe(1);
      expect(errorLines(result.stdout.split("\n")).join("\n")).toContain("failure");
    });
  });

  it("exits 1, not 0, when the wait never settles, and has already printed its progress", () => {
    withDir((dir) => {
      const stub = join(dir, "stub.mjs");
      writeFileSync(stub, STUB);
      const result = run(
        SCRIPT.pathname,
        { ...GOOD_ENV, AWAIT_STUB_MODE: "empty-then-hang", SUITE_POLL_SECONDS: "1" },
        stub,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("waiting");
    });
  });
});
