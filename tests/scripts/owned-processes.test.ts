import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const modulePath = join(process.cwd(), "scripts/owned-processes.mjs");
interface Owner {
  spawn(command: string, args: string[], options?: object): ChildProcess;
  stop(child: ChildProcess): Promise<void>;
  cleanup(): Promise<void>;
}
interface OwnerConstructor {
  new (workDir: string, options?: { graceMs?: number; keepWorkDir?: boolean }): Owner;
}
async function ownership(): Promise<OwnerConstructor> {
  expect(existsSync(modulePath), "the process-tree ownership module is missing").toBe(true);
  return (await import(pathToFileURL(modulePath).href)).OwnedProcesses;
}

// Linear, depth-capped fixture: the leader creates exactly one grandchild.
// The leader reaps it on TERM; ignoring TERM in the grandchild exercises KILL.
const tree = `
  const { spawn } = require('node:child_process');
  const depth = Number(process.env.DEPTH || 0);
  if (depth >= 2) process.exit(2);
  const child = spawn(process.execPath, ['-e', \`
    if (Number(process.env.DEPTH) >= 2) process.exit(2);
    if (process.env.IGNORE_TERM === '1') process.on('SIGTERM', () => {});
    console.log(process.pid);
    setInterval(() => {}, 1000);
  \`], { env: { ...process.env, DEPTH: String(depth + 1) }, stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.once('data', data => console.log(JSON.stringify({ parent: process.pid, grandchild: Number(data) })));
  process.on('SIGTERM', () => child.once('exit', () => process.exit(0)));
  setInterval(() => {}, 1000);
`;
const directories: string[] = [];
const children: ChildProcess[] = [];
const owners: Owner[] = [];
const fixtureGroups: number[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "owned-processes-test-"));
  directories.push(path);
  return path;
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}
async function ready(child: ChildProcess): Promise<{ parent: number; grandchild: number }> {
  const [data] = await once(child.stdout!, "data");
  const pids = JSON.parse(data.toString().split("\n")[0]);
  fixtureGroups.push(pids.parent);
  return pids;
}
async function assertGone(...pids: number[]) {
  await expect.poll(() => pids.every(gone), { timeout: 10000 }).toBe(true);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.cleanup();
  for (const pid of fixtureGroups.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  for (const child of children.splice(0)) {
    if (child.pid && !gone(child.pid)) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

it.each([false, true])("terminates the entire group (grandchild ignores TERM: %s)", async (ignore) => {
  const OwnedProcesses = await ownership();
  const owner = new OwnedProcesses(await directory(), { graceMs: 100 });
  owners.push(owner);
  const child = owner.spawn(process.execPath, ["-e", tree], {
    env: { ...process.env, IGNORE_TERM: ignore ? "1" : "0" }, stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  const pids = await ready(child);
  await owner.stop(child);
  await assertGone(pids.parent, pids.grandchild);
});

it("removes the workdir on normal cleanup and makes repeated cleanup safe", async () => {
  const OwnedProcesses = await ownership();
  const path = await directory();
  await writeFile(join(path, "log"), "log");
  const owner = new OwnedProcesses(path);
  owners.push(owner);
  await Promise.all([owner.cleanup(), owner.cleanup()]);
  expect(existsSync(path)).toBe(false);
  expect(() => owner.spawn(process.execPath, ["-e", ""])).toThrow(/closed/i);
});

it("keeps the workdir when the debug environment flag is set", async () => {
  await ownership();
  const path = await directory();
  const script = join(path, "keep.mjs");
  await writeFile(script, `import { OwnedProcesses } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    await new OwnedProcesses(${JSON.stringify(path)}).cleanup();`);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, LAYOUT_CHECK_KEEP_WORKDIR: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", data => { output += data; });
  const [code] = await once(child, "exit");
  expect(code).toBe(0);
  expect(existsSync(path)).toBe(true);
  expect(output).toContain(path);
});

it.each(["SIGTERM", "SIGINT"] as const)("cleans descendants and workdir on %s", async (signal) => {
  await ownership();
  const path = await directory();
  const script = join(path, "signal.mjs");
  await writeFile(script, `import { OwnedProcesses } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const owner = new OwnedProcesses(${JSON.stringify(path)}, { graceMs: 100 });
    owner.spawn(process.execPath, ['-e', ${JSON.stringify(tree)}], { stdio: ['ignore', 'inherit', 'ignore'] });`);
  const child = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const pids = await ready(child);
  const exit = once(child, "exit");
  child.kill(signal);
  const [code, exitSignal] = await exit;
  expect(exitSignal).toBe(null);
  expect(code).toBe(signal === "SIGTERM" ? 143 : 130);
  await assertGone(pids.parent, pids.grandchild);
  expect(existsSync(path)).toBe(false);
});

it("honors --base-url even when it names the default spawned-server URL", async () => {
  const child = spawn(process.execPath, ["scripts/check-page-geometry.mjs", "--base-url", "http://127.0.0.1:3219"], {
    env: { ...process.env, DATABASE_URL: "", LAYOUT_CHECK_PORT: "3219", LAYOUT_CHECK_CHROME: process.execPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", data => { stderr += data; });
  const [code] = await once(child, "exit");
  // External-server mode reaches the session-fixture check; the spawned
  // server's earlier environment preflight must never run in this mode.
  expect(code).toBe(1);
  expect(stderr).toContain("geometry fixture users cannot be seeded");
});

it("prints a preserved workdir even on synchronous failure exit", async () => {
  await ownership();
  const path = await directory();
  const script = join(path, "exit.mjs");
  await writeFile(script, `import { OwnedProcesses } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const owner = new OwnedProcesses(${JSON.stringify(path)});
    const child = owner.spawn(process.execPath, ['-e', ${JSON.stringify(tree)}], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.once('data', data => { process.stdout.write(data); process.exit(2); });`);
  const child = spawn(process.execPath, [script], {
    detached: true, env: { ...process.env, LAYOUT_CHECK_KEEP_WORKDIR: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", data => { output += data; });
  const exit = once(child, "exit");
  const pids = await ready(child);
  const [code] = await exit;
  expect(code).toBe(2);
  await assertGone(pids.parent, pids.grandchild);
  expect(existsSync(path)).toBe(true);
  expect(output).toContain(path);
});
