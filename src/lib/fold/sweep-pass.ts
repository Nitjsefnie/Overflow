import { sanitizeForgeStrings } from "@/lib/forge/sanitize-forge-strings";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { DirtyReconciliationSubject } from "@/lib/fold/reconciliation-evidence";

export type SweepPass = {
  id: string;
  scanStartedAt: Date;
  dirtySubjects: DirtyReconciliationSubject[];
  read(key: string): Promise<unknown | undefined>;
  write(key: string, payload: unknown, cursor?: string | null): Promise<void>;
  complete(): Promise<void>;
};
export type SweepPassInput = {
  repositoryId: string;
  evidenceVersion: string;
  scanStartedAt: Date;
  dirtySubjects: DirtyReconciliationSubject[];
};
export type ReconciliationSweepControl = {
  spend(): Promise<Date | null>;
  openPass(input: SweepPassInput): Promise<SweepPass>;
  discardPass(repositoryId: string): Promise<void>;
};
const passes = new AsyncLocalStorage<SweepPass>();
const freshReads = new AsyncLocalStorage<boolean>();
export function withSweepPass<T>(pass: SweepPass | undefined, work: () => Promise<T>): Promise<T> {
  return pass === undefined ? work() : passes.run(pass, work);
}
/** A verification witness must describe the state it verifies; a replayed page describes an earlier one. */
export function withFreshSweepReads<T>(work: () => Promise<T>): Promise<T> {
  return freshReads.run(true, work);
}

/** Replay completed pages locally, so every new window buys forward progress.
 * Keys hash paths/query variables, never authentication headers or credentials.
 * Only parsed successful responses are saved; error payloads are never retained.
 */
export async function checkpointSweepRequest<T>(identity: unknown, read: () => Promise<T>): Promise<T> {
  if (freshReads.getStore()) return read();
  const pass = passes.getStore();
  if (pass === undefined) return read();
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const cached = await pass.read(key);
  if (cached !== undefined) return cached as T;
  const payload = sanitizeForgeStrings(await read());
  const issues = (payload as { repository?: { issues?: { pageInfo?: { endCursor?: string | null } } } } | null)?.repository?.issues;
  await pass.write(key, payload, issues?.pageInfo?.endCursor);
  return payload;
}

export async function checkpointSweepRestRequest<T extends { status: number; headers: Headers; body: string }>(
  identity: unknown, read: () => Promise<T>,
): Promise<{ status: number; headers: Headers; body: string }> {
  const payload = await checkpointSweepRequest(identity, async () => {
    const result = await read();
    return { ...result, headers: Object.fromEntries(result.headers) };
  });
  return { ...payload, headers: new Headers(payload.headers) };
}
