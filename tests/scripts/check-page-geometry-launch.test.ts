import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- untyped .mjs script module
import { launchChromeWithRetry } from "../../scripts/check-page-geometry.mjs";

/**
 * The options launchChromeWithRetry takes, declared locally because the .mjs
 * script ships no type declarations. Defaults: 3 attempts, 20000 ms per
 * attempt — the tests pass reduced budgets and a fake spawn.
 */
interface LaunchOptions {
  command: string;
  args: string[];
  spawnChild?: (command: string, args: string[], options: { stdio: string[] }) => FakeChromeChild;
  attempts?: number;
  budgetMs?: number;
}

/** The launch contract of scripts/check-page-geometry.mjs. */
interface ChromeLauncher {
  (options: LaunchOptions): Promise<{ child: FakeChromeChild; browserUrl: string }>;
}

const launchChrome = launchChromeWithRetry as ChromeLauncher;

/** The endpoint URL every scripted success prints. */
const DEVTOOLS_URL = "ws://127.0.0.1:39991/devtools/browser/issue-447";

/**
 * A child-process double with exactly the surface the launch path touches: a
 * stderr stream, exit events and kill. No real Chrome is spawned; the tests
 * script what each fake child does the moment the launcher starts listening.
 */
class FakeChromeChild extends EventEmitter {
  readonly stderr = new EventEmitter();

  /** Every kill call, in order, signal included. */
  readonly killCalls: Array<string | undefined> = [];

  kill(signal?: string): boolean {
    this.killCalls.push(signal);
    return true;
  }

  /** Simulate Chrome writing raw text to stderr. */
  writeStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }

  /** Simulate Chrome announcing its endpoint on stderr. */
  printDevToolsEndpoint(url: string): void {
    this.writeStderr(`[4471:4472:0:0] DevTools listening on ${url}\n`);
  }

  /** Simulate the process exiting. */
  exitWith(code: number): void {
    this.emit("exit", code);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { stdio: string[] };
}

/**
 * A spawn function driven by a per-attempt script: step N describes what the
 * Nth spawned child does. Each step fires one microtask after the spawn, by
 * which point the launcher has subscribed synchronously.
 */
function scriptedSpawn(script: Array<(child: FakeChromeChild, call: SpawnCall) => void>): {
  spawnChild: LaunchOptions["spawnChild"];
  children: FakeChromeChild[];
  calls: SpawnCall[];
} {
  const children: FakeChromeChild[] = [];
  const calls: SpawnCall[] = [];
  const spawnChild: LaunchOptions["spawnChild"] = (command, args, options) => {
    const child = new FakeChromeChild();
    children.push(child);
    calls.push({ command, args, options });
    const step = script[children.length - 1];
    expect(step, `spawned more times than the ${script.length}-step script`).toBeDefined();
    queueMicrotask(() => step(child, { command, args, options }));
    return child;
  };
  return { spawnChild, children, calls };
}

/** The launcher arguments every test shares: reduced budget, three attempts. */
const LAUNCH_OPTIONS: LaunchOptions = {
  command: "/usr/bin/chromium",
  args: ["--headless=new", "--remote-debugging-port=0"],
  attempts: 3,
  budgetMs: 100,
};

/** Resolve with the error a promise rejects with, or fail if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the launch to reject, but it resolved");
}

describe("the page-geometry Chrome launch (issue 447)", () => {
  it("spawns Chrome with the argv and stdio it was given", async () => {
    const { spawnChild, calls } = scriptedSpawn([
      (child) => child.printDevToolsEndpoint(DEVTOOLS_URL),
    ]);

    await launchChrome({ ...LAUNCH_OPTIONS, spawnChild });

    expect(calls).toEqual([
      {
        command: "/usr/bin/chromium",
        args: ["--headless=new", "--remote-debugging-port=0"],
        options: { stdio: ["ignore", "ignore", "pipe"] },
      },
    ]);
  });

  it("retries after a silent attempt: kills the silent child and resolves with the next attempt's endpoint", async () => {
    const { spawnChild, children } = scriptedSpawn([
      // Attempt 1: alive but silent — no endpoint line, no exit.
      () => {},
      // Attempt 2: prints the endpoint immediately.
      (child) => child.printDevToolsEndpoint(DEVTOOLS_URL),
    ]);

    const launched = await launchChrome({ ...LAUNCH_OPTIONS, spawnChild });

    expect(launched.browserUrl).toBe(DEVTOOLS_URL);
    expect(launched.child).toBe(children[1]);
    expect(children).toHaveLength(2);
    expect(children[0].killCalls).toEqual(["SIGKILL"]); // the silent attempt is killed before relaunch
    expect(children[1].killCalls).toEqual([]); // the live attempt is left running for the caller
  });

  it("retries across failure classes: attempt 1 exits, attempt 2 resolves", async () => {
    const { spawnChild, children } = scriptedSpawn([
      (child) => {
        child.writeStderr("crashed on startup\n");
        child.exitWith(1);
      },
      (child) => child.printDevToolsEndpoint(DEVTOOLS_URL),
    ]);

    const launched = await launchChrome({ ...LAUNCH_OPTIONS, spawnChild });

    expect(launched.browserUrl).toBe(DEVTOOLS_URL);
    expect(launched.child).toBe(children[1]);
    expect(children).toHaveLength(2);
  });

  it("rejects after every attempt stays silent, naming the attempt count and the captured stderr", async () => {
    const { spawnChild } = scriptedSpawn([
      (child) => child.writeStderr("[4471] WARNING: device manager still warming up\n"),
      (child) => child.writeStderr("[4472] WARNING: fontconfig cache cold\n"),
      (child) => child.writeStderr("[4473] WARNING: shader cache compiling\n"),
    ]);

    const failure = await rejectionOf(launchChrome({ ...LAUNCH_OPTIONS, spawnChild }));

    expect(failure.message).toContain("chrome alive but silent");
    expect(failure.message).toContain("after 3 attempt(s)");
    expect(failure.message).toContain("fontconfig cache cold");
  });

  it("rejects with the exit code and captured stderr when the last attempt exits early", async () => {
    const { spawnChild } = scriptedSpawn([
      (child) => child.exitWith(1),
      (child) => child.exitWith(2),
      (child) => {
        child.writeStderr("libGL error: failed to create dri screen\n");
        child.exitWith(101);
      },
    ]);

    const failure = await rejectionOf(launchChrome({ ...LAUNCH_OPTIONS, spawnChild }));

    expect(failure.message).toContain("chrome exited early with code 101");
    expect(failure.message).toContain("after 3 attempt(s)");
    expect(failure.message).toContain("libGL error: failed to create dri screen");
  });

  it("reproduces the captured stderr lines verbatim in the rejection", async () => {
    const stderrLines = [
      "libGL error: failed to create dri screen",
      "Fatal launcher error: missing X display after 447 retries",
    ];
    const { spawnChild } = scriptedSpawn([
      (child) => child.writeStderr(stderrLines.join("\n") + "\n"),
      (child) => child.writeStderr(stderrLines.join("\n") + "\n"),
      (child) => child.writeStderr(stderrLines.join("\n") + "\n"),
    ]);

    const failure = await rejectionOf(launchChrome({ ...LAUNCH_OPTIONS, spawnChild }));

    for (const line of stderrLines) {
      expect(failure.message).toContain(line);
    }
  });
});
