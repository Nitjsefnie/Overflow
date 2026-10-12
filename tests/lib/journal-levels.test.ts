import { spawnSync } from "node:child_process";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let errors: string[];
let output: string[];

beforeEach(() => {
  vi.resetModules();
  errors = [];
  output = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      output.push(String(chunk));
      done();
    },
  });
  vi.stubGlobal("console", new Console({ stdout, stderr: process.stderr, colorMode: false }));
  vi.stubEnv("JOURNAL_STREAM", "test-journal-stream");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function install() {
  const { installJournalLevels } = await import("@/lib/logging/journal-levels");
  installJournalLevels();
}

describe("journal console levels", () => {
  it("prefixes every error line, including blank lines and the final newline", async () => {
    await install();
    console.error("first\n\nlast\n");
    expect(errors.join("")).toBe("<3>first\n<3>\n<3>last\n<3>\n");
  });

  it("prefixes every line of an Error stack", async () => {
    const error = new Error("failure");
    console.error(error);
    const baseline = errors.join("");
    errors.length = 0;
    await install();
    console.error(error);
    const lines = errors.join("").trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.startsWith("<3>"))).toBe(true);
    expect(lines.map((line) => line.slice(3)).join("\n") + "\n").toBe(baseline);
  });

  it("renders format arguments and multi-line inspected objects without colours", async () => {
    const args = ["%s %d %o", "detail", 7, { values: Array.from({ length: 30 }, (_, i) => i) }];
    console.error(...args);
    const baseline = errors.join("");
    errors.length = 0;
    await install();
    console.error(...args);
    const lines = errors.join("").trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.startsWith("<3>"))).toBe(true);
    expect(lines.map((line) => line.slice(3)).join("\n") + "\n").toBe(baseline);
    expect(errors.join("")).not.toContain("\u001b");
  });

  it("prefixes every warning line at warning priority", async () => {
    await install();
    console.warn("first\nsecond");
    expect(errors.join("")).toBe("<4>first\n<4>second\n");
  });

  it("leaves info, log and debug methods and their output untouched", async () => {
    const methods = [console.info, console.log, console.debug];
    await install();
    console.info("info", { value: 7 });
    console.log("log\nline");
    console.debug("debug");
    expect(output.join("")).toBe("info { value: 7 }\nlog\nline\ndebug\n");
    expect([console.info, console.log, console.debug]).toEqual(methods);
    expect(errors).toEqual([]);
  });

  it.each([undefined, ""])("is byte-identical to console when JOURNAL_STREAM is %s", async (journalStream) => {
    vi.stubEnv("JOURNAL_STREAM", journalStream);
    const methods = [console.error, console.warn];
    const error = new Error("failure");
    console.error("%s %o", "first\nsecond", { error });
    console.warn("warning", { value: 7 });
    const baseline = errors.join("");
    errors.length = 0;
    await install();
    console.error("%s %o", "first\nsecond", { error });
    console.warn("warning", { value: 7 });
    expect(errors.join("")).toBe(baseline);
    expect([console.error, console.warn]).toEqual(methods);
  });

  it("installs once without double-prefixing errors or warnings", async () => {
    await install();
    const methods = [console.error, console.warn];
    await install();
    console.error("error");
    console.warn("warning");
    expect([console.error, console.warn]).toEqual(methods);
    expect(errors.join("")).toBe("<3>error\n<4>warning\n");
  });

  it("puts the priority first after Next's production console extensions, even in a dimmed scope", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      require('next/dist/server/node-environment-baseline');
      require('next/dist/server/node-environment-extensions/console-file');
      require('next/dist/server/node-environment-extensions/console-exit');
      require('next/dist/server/node-environment-extensions/console-dim.external');
      const descriptors = ['error', 'warn'].map((name) => {
        const { writable, configurable } = Object.getOwnPropertyDescriptor(console, name);
        return { writable, configurable };
      });
      const { consoleAsyncStorage } = require('next/dist/server/app-render/console-async-storage.external');
      consoleAsyncStorage.run({ dim: true }, () => console.error('<3>probe'));
      const { installJournalLevels } = await import('./src/lib/logging/journal-levels.ts');
      installJournalLevels();
      consoleAsyncStorage.run({ dim: true }, () => {
        console.error('first\\nsecond');
        console.warn('warning\\ncontinuation');
      });
      process.stdout.write(JSON.stringify(descriptors));
    `], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "production", NO_COLOR: "", FORCE_COLOR: "1", JOURNAL_STREAM: "test-journal-stream" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { writable: true, configurable: true },
      { writable: true, configurable: true },
    ]);
    const [probe, ...lines] = result.stderr.trimEnd().split("\n");
    expect(probe).toMatch(/^\u001b/);
    expect(lines).toEqual(["<3>first", "<3>second", "<4>warning", "<4>continuation"]);
  });

  it.each(["error", "warn"] as const)("keeps prerender live while inspecting and writing console.%s", (method) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { inspect } from 'node:util';
      const require = createRequire(import.meta.url);
      require('next/dist/server/node-environment-baseline');
      require('next/dist/server/node-environment-extensions/console-exit');
      require('next/dist/server/node-environment-extensions/console-dim.external');
      require('next/dist/server/node-environment-extensions/date');
      const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external');
      const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external');
      assert.equal(typeof workUnitAsyncStorage.exit, 'function', 'Next work-unit exit export must exist');
      const observations = [];
      const input = { [inspect.custom]() { Date.now(); return 'inspected\\ncontinuation'; } };
      function logInPrerender() {
        const controller = new AbortController();
        const store = { type: 'prerender', controller, renderSignal: controller.signal,
          cacheSignal: null, dynamicTracking: null };
        workAsyncStorage.run({ route: '/journal-probe' }, () => {
          workUnitAsyncStorage.run(store, () => {
            console.${method}(input);
            assert.equal(workUnitAsyncStorage.getStore(), store, 'logging must restore the caller store');
          });
        });
        observations.push(controller.signal.aborted);
      }
      logInPrerender();
      const { installJournalLevels } = await import('./src/lib/logging/journal-levels.ts');
      installJournalLevels();
      // A sink that reads the clock must be isolated as well as the inspector.
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = (...args) => { Date.now(); return write(...args); };
      logInPrerender();
      process.stdout.write(JSON.stringify(observations));
    `], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "production", NO_COLOR: "1", FORCE_COLOR: undefined, JOURNAL_STREAM: "test-journal-stream" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([false, false]);
    const prefix = method === "error" ? "<3>" : "<4>";
    expect(result.stderr).toBe(`inspected\ncontinuation\n${prefix}inspected\n${prefix}continuation\n`);
  });
});
