import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "@/lib/env";

/**
 * Issue 1320 gives self-defined variables the OVERFLOW_ prefix. Legacy names
 * remain deployment fallbacks; prefixed values win, including an empty string.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readEnv", () => {
  it("prefers the OVERFLOW_ name when both names are set", () => {
    vi.stubEnv("OVERFLOW_ENV_READER_TEST", "prefixed");
    vi.stubEnv("ENV_READER_TEST", "legacy");

    expect(readEnv("ENV_READER_TEST")).toBe("prefixed");
  });

  it("reads the old name when only it is set", () => {
    vi.stubEnv("OVERFLOW_ENV_READER_TEST", undefined);
    vi.stubEnv("ENV_READER_TEST", "legacy");

    expect(readEnv("ENV_READER_TEST")).toBe("legacy");
  });

  it("returns undefined when neither name is set", () => {
    vi.stubEnv("OVERFLOW_ENV_READER_TEST", undefined);
    vi.stubEnv("ENV_READER_TEST", undefined);

    expect(readEnv("ENV_READER_TEST")).toBeUndefined();
  });

  it("keeps an empty prefixed value instead of falling through to the old name", () => {
    vi.stubEnv("OVERFLOW_ENV_READER_TEST", "");
    vi.stubEnv("ENV_READER_TEST", "legacy");

    expect(readEnv("ENV_READER_TEST")).toBe("");
  });

  it("reads names without an OVERFLOW_ twin unchanged", () => {
    vi.stubEnv("OVERFLOW_NODE_ENV", undefined);
    vi.stubEnv("NODE_ENV", "test");

    expect(readEnv("NODE_ENV")).toBe("test");
  });

  it("reads the old name from an injected environment instead of process.env", () => {
    vi.stubEnv("OVERFLOW_ENV_READER_TEST", "process-prefixed");
    vi.stubEnv("ENV_READER_TEST", "process-legacy");

    expect(readEnv("ENV_READER_TEST", { ENV_READER_TEST: "legacy" })).toBe("legacy");
  });

  it("prefers the OVERFLOW_ name in an injected environment", () => {
    vi.stubEnv("OVERFLOW_ENV_READER_TEST", "process-prefixed");

    expect(
      readEnv("ENV_READER_TEST", { OVERFLOW_ENV_READER_TEST: "prefixed", ENV_READER_TEST: "legacy" }),
    ).toBe("prefixed");
  });

  it("keeps an empty prefixed value in an injected environment", () => {
    vi.stubEnv("OVERFLOW_ENV_READER_TEST", "process-prefixed");

    expect(readEnv("ENV_READER_TEST", { OVERFLOW_ENV_READER_TEST: "", ENV_READER_TEST: "legacy" })).toBe("");
  });

  it("returns undefined when an injected environment sets neither name", () => {
    vi.stubEnv("OVERFLOW_ENV_READER_TEST", "process-prefixed");
    vi.stubEnv("ENV_READER_TEST", "process-legacy");

    expect(readEnv("ENV_READER_TEST", {})).toBeUndefined();
  });
});
