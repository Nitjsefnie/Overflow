import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "@/lib/env";

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
});
