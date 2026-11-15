// Runs a script in its own process group under a SIGKILL timeout and kills
// the whole group after the spawn returns, so nothing the script started
// outlives the call. Shared by tests/ci/dependency-audit-retry.test.ts and the
// deploy-revision harness's runDeploy.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const STEP_KILL_SIGNAL = "SIGKILL";

const STEP_LAUNCHER = 'echo $$ > "$1"; shift; exec "$@"';

// Resolved on the runner's PATH: a caller's env may carry a shim-only PATH without it.
const SETSID = spawnSync("sh", ["-c", "command -v setsid"], { encoding: "utf8" }).stdout?.trim() || "setsid";

function killTree(pgid: number | undefined, pid: number | undefined): void {
  if (pgid !== undefined) {
    try {
      process.kill(-pgid, STEP_KILL_SIGNAL);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  if (pid !== undefined) {
    try {
      process.kill(pid, STEP_KILL_SIGNAL);
    } catch {
      // Already gone, or not ours to signal.
    }
  }
}

function ownProcessGroup(): number | undefined {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const pgid = Number(afterComm[2]);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

/** Runs `argv` (e.g. `["bash", "-e", script]`) with `dir` as cwd; the group id is published in `dir`. */
export function runBoundedScript(
  argv: string[],
  dir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): SpawnSyncReturns<string> {
  const pgidFile = join(dir, "step-pgid");
  // A previous run's file would name a dead group whose id may since be reused.
  rmSync(pgidFile, { force: true });
  const result = spawnSync(SETSID, ["bash", "-c", STEP_LAUNCHER, "step", pgidFile, ...argv], {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    killSignal: STEP_KILL_SIGNAL,
  });
  // The script publishes `$$` before the exec, so this read is after the fact
  // and never races: by now either the file is there or the script never ran.
  let pgid: number | undefined;
  try {
    const published = Number(readFileSync(pgidFile, "utf8").trim());
    const own = ownProcessGroup();
    if (Number.isInteger(published) && published > 1 && published !== process.pid && published !== own) {
      pgid = published;
    }
  } catch {
    // No file: `setsid` never got as far as the script.
  }
  // Unconditional, not only on a timeout: a script that exits can leave a
  // descendant running, and that is the same leak by another route.
  killTree(pgid, result.pid ?? undefined);
  return result;
}
