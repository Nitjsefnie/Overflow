import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const fixtureDirectories = createOwnedTempDirectoryRegistry(join(tmpdir(), "gate-ownership-test-"));


const root = process.cwd();
const directories: string[] = [];
const groups = new Set<number>();
const gates: ChildProcess[] = [];
async function scratch() {
  const path = await fixtureDirectories.createAsync();
  directories.push(path);
  return path;
}
function launch(preload: string, args: string[] = [], env: Record<string, string | undefined> = {}) {
  const environment: NodeJS.ProcessEnv = { ...process.env, LAYOUT_CHECK_KEEP_WORKDIR: "", LAYOUT_CHECK_CHROME: process.execPath, ...env };
  if (env.DATABASE_URL === undefined) delete environment.DATABASE_URL;
  const child = spawn(process.execPath, ["--import", preload, "scripts/check-page-geometry.mjs", ...args], {
    cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  gates.push(child);
  groups.add(child.pid!);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", data => { stdout += data; });
  child.stderr!.on("data", data => { stderr += data; });
  return { child, exited: once(child, "exit"), stdout: () => stdout, stderr: () => stderr };
}
function gone(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}
async function assertGone(...pids: number[]) {
  await expect.poll(() => pids.every(gone), { timeout: 10000 }).toBe(true);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}
afterEach(async () => {
  try {
    for (const path of [...directories]) {
      for (const kind of ["server", "chrome"]) {
        const spawned = join(path, `${kind}-pid`);
        if (existsSync(spawned)) groups.add(Number(await readFile(spawned, "utf8")));
        const record = join(path, `${kind}.json`);
        if (existsSync(record)) groups.add(JSON.parse(await readFile(record, "utf8")).parent);
      }
      const workdir = join(path, "workdir");
      if (existsSync(workdir)) directories.push(await readFile(workdir, "utf8"));
    }
    // Includes the gate group even after its leader exits, so disconnected
    // plain-spawn mutants are cleaned without leaking their fixture children.
    for (const pid of groups) {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    groups.clear();
    for (const child of gates.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    }
    for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  } finally {
    fixtureDirectories.dispose();
  }
});

it.each(["SIGTERM", "SIGINT"] as const)("owns the real gate's directory at the %s acquisition boundary", async signal => {
  const path = await scratch();
  const preload = join(path, "acquisition.mjs");
  await writeFile(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const allocate = fs.mkdtempSync;
    fs.mkdtempSync = (...args) => {
      const directory = allocate(...args);
      fs.writeSync(1, directory + '\\n');
      process.kill(process.pid, process.env.GATE_ACQUISITION_SIGNAL);
      return directory;
    };
    syncBuiltinESMExports();
  `);
  const run = launch(preload, ["--base-url", "http://127.0.0.1:1"], { GATE_ACQUISITION_SIGNAL: signal });
  const [code, exitSignal] = await run.exited;
  const directory = run.stdout().trim();
  expect(directory).toMatch(/page-geometry-/);
  directories.push(directory); // clean the demonstrated leak on RED too
  expect(code !== 0 || exitSignal !== null).toBe(true);
  expect(existsSync(directory), run.stderr()).toBe(false);
});

it("releases acquisition hooks when the real gate's allocation fails", async () => {
  const path = await scratch();
  const preload = join(path, "allocation-failure.mjs");
  await writeFile(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const events = ['SIGTERM', 'SIGINT', 'exit'];
    const before = events.map(event => process.listenerCount(event));
    process.once('exit', () => {
      const after = events.map(event => process.listenerCount(event));
      fs.writeSync(1, JSON.stringify({ before, after }) + '\\n');
    });
    fs.mkdtempSync = () => { throw new Error('allocation denied by fixture'); };
    syncBuiltinESMExports();
  `);
  const run = launch(preload, ["--base-url", "http://127.0.0.1:1"]);
  const [code] = await run.exited;
  expect(code).toBe(1);
  expect(run.stderr()).toContain("allocation denied by fixture");
  const audit = JSON.parse(run.stdout());
  // The once-exit audit removes itself before running, so any extra
  // listener here belongs to leaked ownership hooks.
  expect(audit.after).toEqual(audit.before);
});

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

// Real node process trees, not spawn doubles: every fake launches exactly
// one non-spawning grandchild, with an explicit depth limit of two.
const startupFixture = `
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const depth = Number(process.env.DEPTH || 0);
  if (depth >= 2) process.exit(2);
  const [kind, record] = process.argv.slice(2);
  let ready = false;
  const child = spawn(process.execPath, ['-e', \`
    if (Number(process.env.DEPTH) >= 2) process.exit(2);
    console.log(process.pid);
    setInterval(() => {}, 1000);
  \`], { env: { ...process.env, DEPTH: String(depth + 1) }, stdio: ['ignore', 'pipe', 'inherit'] });
  child.once('exit', (code, signal) => {
    if (!ready) throw new Error('fixture grandchild exited before readiness: ' + (code ?? signal));
  });
  child.stdout.once('data', data => {
    ready = true;
    fs.writeFileSync(record + '.tmp', JSON.stringify({ parent: process.pid, grandchild: Number(data) }));
    fs.renameSync(record + '.tmp', record);
    if (kind === 'server') {
      require('node:http').createServer((_req, res) => res.end('fixture')).listen(
        Number(process.env.LAYOUT_CHECK_PORT), '127.0.0.1', () => console.log('Ready in fixture'));
    }
    // Chrome remains silent: the real gate waits in its launch path until
    // the test sends the signal, without needing a fake CDP implementation.
  });
  process.on('SIGTERM', () => child.once('exit', () => process.exit(0)));
  setInterval(() => {}, 1000);
`;

it.each(["SIGTERM", "SIGINT"] as const)("owns both real-entrypoint startup trees on %s", async signal => {
  const path = await scratch();
  const fixture = join(path, "startup.cjs");
  const preload = join(path, "startup.mjs");
  await writeFile(fixture, startupFixture);
  const fixtureUrl = pathToFileURL(join(root, "scripts/page-geometry-fixtures.mjs")).href;
  await writeFile(preload, `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    const originalSpawn = cp.spawn;
    const fixture = ${JSON.stringify(fixture)};
    const directory = ${JSON.stringify(path)};
    cp.spawn = (command, args, options) => {
      const kind = args[0] === 'node_modules/next/dist/bin/next' ? 'server'
        : args.includes('--headless=new') ? 'chrome' : null;
      if (!kind) throw new Error('unexpected gate spawn');
      const child = originalSpawn(process.execPath, [fixture, kind, directory + '/' + kind + '.json'], options);
      if (child.pid) fs.writeFileSync(directory + '/' + kind + '-pid', String(child.pid));
      return child;
    };
    const allocate = fs.mkdtempSync;
    fs.mkdtempSync = (...args) => {
      const workdir = allocate(...args);
      fs.writeFileSync(directory + '/workdir', workdir);
      return workdir;
    };
    const exists = fs.existsSync;
    fs.existsSync = path => path === ${JSON.stringify(join(root, ".next"))} || exists(path);
    // No database is opened: just the seeding boundary is replaced, leaving
    // server readiness, Chrome launch, spawn options and ownership real.
    registerHooks({ load(url, context, nextLoad) {
      if (url.includes('page-geometry-fixtures')) fs.writeFileSync(directory + '/loaded-url', url);
      if (url === ${JSON.stringify(fixtureUrl)}) return {
        format: 'module', shortCircuit: true,
        source: 'export async function seedFixtureUsers() { return {}; } export async function seedBoardFixtureCard() {}',
      };
      return nextLoad(url, context);
    } });
    syncBuiltinESMExports();
  `);
  const run = launch(preload, [], {
    DATABASE_URL: "postgresql://127.0.0.1:1/unused_fixture", LAYOUT_CHECK_PORT: String(await freePort()), DEPTH: "0",
  });
  interface Pids { parent: number; grandchild: number }
  let server: Pids | undefined;
  let chrome: Pids | undefined;
  try {
    await expect.poll(async () => {
      if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(run.stderr());
      try {
        server = JSON.parse(await readFile(join(path, "server.json"), "utf8"));
        chrome = JSON.parse(await readFile(join(path, "chrome.json"), "utf8"));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }, { timeout: 10000 }).toBe(true);
  } catch (error) {
    const loaded = existsSync(join(path, "loaded-url")) ? await readFile(join(path, "loaded-url"), "utf8") : "not loaded";
    throw new Error(`gate fixture startup failed: ${run.stdout()} ${run.stderr()} fixture module: ${loaded}`, { cause: error });
  }
  const directory = await readFile(join(path, "workdir"), "utf8");
  directories.push(directory);
  groups.add(server!.parent);
  groups.add(chrome!.parent);
  expect(gone(server!.grandchild)).toBe(false);
  expect(gone(chrome!.grandchild)).toBe(false);
  run.child.kill(signal);
  const [code, exitSignal] = await run.exited;
  expect(exitSignal).toBe(null);
  expect(code).toBe(signal === "SIGTERM" ? 143 : 130);
  await assertGone(server!.parent, server!.grandchild, chrome!.parent, chrome!.grandchild);
  expect(existsSync(directory)).toBe(false);
});
