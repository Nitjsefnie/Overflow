import { readEnv } from "@/lib/env";
import { plural } from "@/lib/plural";

const SWEEP_WINDOW_MS = 6 * 60 * 60_000;

export function readSweepWindowMs(environment: Partial<Record<string, string>>): number {
  const raw = readEnv("RECONCILIATION_SWEEP_WINDOW_MINUTES", environment) ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) * 60_000 : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : SWEEP_WINDOW_MS;
}

/** Whole hours read as hours, so the default window reads "6 hours". */
export function formatSweepWindow(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} ${plural(minutes / 60, "hour")}` : `${minutes} ${plural(minutes, "minute")}`;
}
