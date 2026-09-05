import { expect, vi } from "vitest";

const emittingMethods = ["log", "info", "warn", "error", "debug"] as const;

export function spyOnConsoleOutput(): void {
  for (const method of emittingMethods) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
}

export function expectNoConsoleOutput(): void {
  for (const method of emittingMethods) {
    // Record every leak without skipping later teardown hooks (such as DOM cleanup).
    expect.soft(console[method], `console.${method}`).not.toHaveBeenCalled();
  }
}
