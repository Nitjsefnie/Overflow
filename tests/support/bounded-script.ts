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
    } catch {}
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
  let pgid: number | undefined;
  try {
    const published = Number(readFileSync(pgidFile, "utf8").trim());
    const own = ownProcessGroup();
    if (Number.isInteger(published) && published > 1 && published !== process.pid && published !== own) {
      pgid = published;
    }
  } catch {
    // No file: the script never ran.
  }
  // Unconditional, not only on a timeout: a script that exits can leave a descendant running.
  killTree(pgid, result.pid ?? undefined);
  return result;
}
