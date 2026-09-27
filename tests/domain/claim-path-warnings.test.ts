import { describe, expect, it, vi } from "vitest";
import { assessClaimPath } from "@/lib/domain/claim-path";

// Issue 673: yaml's parse() forwards every doc warning to process.emitWarning,
// and those warning messages embed the DECODED contributor bytes (a %TAG
// directive whose URI carries percent-encoded control bytes yields a warning
// containing a literal LF, attacker text and ESC). The assessment must parse
// contributor YAML without ever surfacing a process warning.

const AUDIT_WORKFLOW = ".github/workflows/audit.yml";

const PROBE =
  "%TAG !e! tag:example.com,2026:\n---\non: issue_comment\njobs: !e!%0AFORGED%20audit%20success%1B[2J value";

// The same percent-encoded text with no %TAG handle never decodes, so there is
// nothing to leak (E-SK-85).
const ENCODED_WITHOUT_TAG =
  'on: issue_comment\njobs: "%0AFORGED%20audit%20success%1B[2J value"';

interface CapturedWarning {
  surface: string;
  message: string;
}

function containsControlByte(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

// Wraps the call with a process.emitWarning spy (original implementation kept,
// so emissions still flow) and a real process "warning" listener, then waits a
// macrotask tick for the deferred emission to land.
async function captureWarnings<T>(call: () => T): Promise<{ captured: CapturedWarning[]; result: T }> {
  const captured: CapturedWarning[] = [];
  const emitSpy = vi.spyOn(process, "emitWarning");
  const listener = (warning: unknown): void => {
    captured.push({ surface: "process warning event", message: String(warning) });
  };
  process.on("warning", listener);
  try {
    const result = call();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const args of emitSpy.mock.calls) {
      captured.push({ surface: "process.emitWarning", message: args.map(String).join(" ") });
    }
    return { captured, result };
  } finally {
    process.off("warning", listener);
    emitSpy.mockRestore();
  }
}

function expectClean(captured: CapturedWarning[]): void {
  for (const { surface, message } of captured) {
    expect(message, `${surface} carried the ESC byte`).not.toContain("\x1b");
    expect(message, `${surface} carried a decoded LF before attacker text`).not.toContain(
      "\nFORGED audit success",
    );
    expect(message, `${surface} carried a C0 control byte`).not.toSatisfy(containsControlByte);
  }
}

describe("assessClaimPath emits no process warnings from contributor YAML", () => {
  it(`captures the %TAG warning for ${AUDIT_WORKFLOW} instead of emitting decoded control bytes`, async () => {
    const evidence = [{ path: AUDIT_WORKFLOW, content: PROBE }];
    const { captured, result } = await captureWarnings(() => assessClaimPath(evidence));

    expectClean(captured);
    expect(result).toBe("NO_EVIDENCE_FOUND");
  });

  it("emits nothing for the percent-encoded form without the %TAG handle", async () => {
    const evidence = [{ path: AUDIT_WORKFLOW, content: ENCODED_WITHOUT_TAG }];
    const { captured, result } = await captureWarnings(() => assessClaimPath(evidence));

    expectClean(captured);
    expect(captured).toEqual([]);
    expect(result).toBe("NO_EVIDENCE_FOUND");
  });
});
