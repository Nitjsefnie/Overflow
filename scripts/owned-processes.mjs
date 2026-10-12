import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** One run owns its detached process groups, signal hooks and work directory. */
export class OwnedProcesses {
  constructor(workDir, { graceMs = 1000, keepWorkDir = process.env.LAYOUT_CHECK_KEEP_WORKDIR === "1" } = {}) {
    this.workDir = workDir;
    this.graceMs = graceMs;
    this.keepWorkDir = keepWorkDir;
    this.keptDirectoryReported = false;
    this.children = new Set();
    this.stopping = new Map();
    this.closed = false;
    this.cleanupPromise = null;
    this.signal = null;
    this.onTerm = () => this.terminate(143);
    this.onInt = () => this.terminate(130);
    this.onExit = () => {
      for (const child of this.children) this.signalGroup(child, "SIGKILL");
      if (this.keepWorkDir) this.reportKeptDirectory();
      else rmSync(this.workDir, { recursive: true, force: true });
    };
    process.on("SIGTERM", this.onTerm);
    process.on("SIGINT", this.onInt);
    process.on("exit", this.onExit);
  }

  spawn(command, args, options = {}) {
    if (this.closed) throw new Error("process ownership is closed");
    const child = spawn(command, args, { ...options, detached: true });
    // Keep the group even if its leader exits: descendants can still be alive.
    this.children.add(child);
    return child;
  }

  signalGroup(child, signal) {
    if (!child.pid) return false; // spawn failure has no group
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }

  stop(child) {
    if (!this.children.has(child)) return Promise.resolve();
    if (!this.stopping.has(child)) {
      this.stopping.set(child, this.stopGroup(child));
    }
    return this.stopping.get(child);
  }

  async stopGroup(child) {
    if (this.signalGroup(child, "SIGTERM")) {
      const deadline = Date.now() + this.graceMs;
      while (this.signalGroup(child, 0) && Date.now() < deadline) {
        await delay(Math.min(50, Math.max(1, deadline - Date.now())));
      }
      this.signalGroup(child, "SIGKILL");
    }
    this.children.delete(child);
  }

  terminate(code) {
    if (this.signal !== null) return;
    this.signal = code;
    this.cleanup().catch(error => console.error(error.message)).finally(() => process.exit(code));
  }

  cleanup() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closed = true;
    this.cleanupPromise = this.cleanResources();
    return this.cleanupPromise;
  }

  reportKeptDirectory() {
    if (this.keptDirectoryReported) return;
    this.keptDirectoryReported = true;
    console.log(`keeping page-geometry work directory: ${this.workDir}`);
  }

  async cleanResources() {
    try {
      await Promise.all([...this.children].map(child => this.stop(child)));
    } finally {
      try {
        if (this.keepWorkDir) this.reportKeptDirectory();
        else await rm(this.workDir, { recursive: true, force: true });
      } finally {
        // On termination keep hooks installed through exit, including during
        // async directory removal; repeated signals cannot bypass cleanup.
        if (this.signal === null) {
          process.off("SIGTERM", this.onTerm);
          process.off("SIGINT", this.onInt);
          process.off("exit", this.onExit);
        }
      }
    }
  }
}
