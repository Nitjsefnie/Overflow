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
 * A stderr stand-in: an EventEmitter plus the Readable drain API the launch
 * path calls after a successful attempt.
 */
class FakeStderr extends EventEmitter {
  resume(): this {
    return this;
  }
}

/**
 * A child-process double with exactly the surface the launch path touches: a
 * stderr stream, exit events, spawn errors and kill. No real Chrome is
 * spawned; the tests script what each fake child does the moment the
 * launcher starts listening.
 */
class FakeChromeChild extends EventEmitter {
  readonly stderr = new FakeStderr();

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

  /** Simulate the process object failing to spawn at all — no exit follows. */
  emitSpawnError(message: string): void {
    this.emit("error", new Error(message));
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
    // The returned child must not keep the accumulating stderr collector.
    expect(children[1].stderr.listenerCount("data")).toBe(0);
  });

  it("gives each attempt a fresh budget: a slow endpoint inside attempt 2's own window still resolves", async () => {
    const { spawnChild, children } = scriptedSpawn([
      // Attempt 1: silent for its whole budget, then killed.
      () => {},
      // Attempt 2: prints 50ms into ITS OWN window. An instant (microtask)
      // answer cannot tell a fresh per-attempt budget from one deadline
      // shared across tries — the shared shape leaves attempt 2 a 0ms
      // remnant, and only a genuinely delayed print catches it.
      (child) => setTimeout(() => child.printDevToolsEndpoint(DEVTOOLS_URL), 50),
    ]);

    const launched = await launchChrome({ ...LAUNCH_OPTIONS, spawnChild });

    expect(launched.browserUrl).toBe(DEVTOOLS_URL);
    expect(launched.child).toBe(children[1]);
    expect(children[0].killCalls).toEqual(["SIGKILL"]);
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

  it("retries when Chrome cannot be spawned at all: attempt 1 errors, attempt 2 resolves", async () => {
    const { spawnChild, children } = scriptedSpawn([
      (child) => child.emitSpawnError("spawn EACCES: permission denied"),
      (child) => child.printDevToolsEndpoint(DEVTOOLS_URL),
    ]);

    const launched = await launchChrome({ ...LAUNCH_OPTIONS, spawnChild });

    expect(launched.browserUrl).toBe(DEVTOOLS_URL);
    expect(launched.child).toBe(children[1]);
    expect(children).toHaveLength(2);
  });

  it("rejects after every attempt fails to spawn, naming the error and the captured stderr", async () => {
    const { spawnChild } = scriptedSpawn([
      (child) => {
        child.writeStderr("nothing reached the pipe\n");
        child.emitSpawnError("spawn EACCES: permission denied");
      },
      (child) => child.emitSpawnError("spawn EACCES: permission denied"),
      (child) => child.emitSpawnError("spawn EACCES: permission denied"),
    ]);

    const failure = await rejectionOf(launchChrome({ ...LAUNCH_OPTIONS, spawnChild }));

    expect(failure.message).toContain("could not be spawned");
    expect(failure.message).toContain("spawn EACCES: permission denied");
    expect(failure.message).toContain("after 3 attempt(s)");
    expect(failure.message).toContain("nothing reached the pipe");
  });

  it("refuses a non-positive attempt count with a clear error, spawning nothing", async () => {
    const { spawnChild, children } = scriptedSpawn([
      (child) => child.printDevToolsEndpoint(DEVTOOLS_URL),
    ]);

    const failure = await rejectionOf(launchChrome({ ...LAUNCH_OPTIONS, spawnChild, attempts: 0 }));

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure.message).toContain("attempts");
    expect(children).toHaveLength(0);
  });

  it("caps the captured stderr in a rejection at its last 15 lines", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `noise line ${index + 1} of 20`);
    const block = lines.join("\n") + "\n";
    const { spawnChild } = scriptedSpawn([
      (child) => child.writeStderr(block),
      (child) => child.writeStderr(block),
      (child) => child.writeStderr(block),
    ]);

    const failure = await rejectionOf(launchChrome({ ...LAUNCH_OPTIONS, spawnChild }));

    // Three 20-line attempts accumulate 60 lines; exactly the last 15 (the
    // third attempt's lines 6-20) may survive into the message.
    for (let index = 0; index < 5; index++) {
      expect(failure.message).not.toContain(lines[index]);
    }
    for (let index = 5; index < 20; index++) {
      expect(failure.message).toContain(lines[index]);
    }
  });
});
