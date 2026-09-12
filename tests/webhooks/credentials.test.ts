import { describe, expect, it } from "vitest";
import { webhookCallbackUrl } from "@/lib/webhooks/credentials";

const selector = "181a4fbb-64d1-44fd-82da-cd191613798c";

describe("webhook callback configuration", () => {
  it.each(["https://example.test/hook#fragment", "https://example.test/hook#", "ftp://example.test/hook"])(
    "rejects an unusable callback base %s", (base) => {
      expect(() => webhookCallbackUrl(base, selector)).toThrow();
    },
  );
  it("replaces an old selector while preserving unrelated query parameters", () => {
    expect(webhookCallbackUrl("https://example.test/hook?tenant=one&hook=old&hook=duplicate", selector))
      .toBe(`https://example.test/hook?tenant=one&hook=${selector}`);
  });
});
