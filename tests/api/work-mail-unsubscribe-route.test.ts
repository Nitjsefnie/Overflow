import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkMailUnsubscribePostHandler,
  GET,
  type WorkMailUnsubscribeRouteDependencies,
} from "@/app/api/work-mail/unsubscribe/route";
import { mintUnsubscribeToken } from "@/lib/accounts/work-mail-unsubscribe";

const url = "https://overflow.internal/api/work-mail/unsubscribe";
const currentKey = randomBytes(32).toString("base64url");
const previousKey = randomBytes(32).toString("base64url");
const subscriptionId = randomUUID();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function setup() {
  vi.stubEnv("OVERFLOW_TOKEN_ENCRYPTION_KEY", currentKey);
  vi.stubEnv("OVERFLOW_TOKEN_ENCRYPTION_KEY_PREVIOUS", previousKey);
  const dependencies = { deleteSubscriptionById: vi.fn(async (): Promise<boolean> => true) } satisfies WorkMailUnsubscribeRouteDependencies;
  return { dependencies, post: (request: Request) => createWorkMailUnsubscribePostHandler(dependencies)(request) };
}

// RFC 8058's one-click shape: no cookies, no Origin, a form-encoded body.
function oneClick(token: string | null, init: RequestInit = {}): Request {
  const target = token === null ? url : `${url}?token=${encodeURIComponent(token)}`;
  return new Request(target, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", ...init,
  });
}

async function answer(response: Response): Promise<string> {
  return `${response.status} ${[...response.headers].map((pair) => pair.join(": ")).join("; ")} ${await response.text()}`;
}

describe("POST /api/work-mail/unsubscribe", () => {
  it("deletes the subscription a valid one-click request names", async () => {
    const { dependencies, post } = setup();
    const response = await post(oneClick(mintUnsubscribeToken(subscriptionId, currentKey)));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(dependencies.deleteSubscriptionById).toHaveBeenCalledExactlyOnceWith(subscriptionId);
  });

  it("accepts a token minted under the previous key", async () => {
    const { dependencies, post } = setup();
    await post(oneClick(mintUnsubscribeToken(subscriptionId, previousKey)));
    expect(dependencies.deleteSubscriptionById).toHaveBeenCalledExactlyOnceWith(subscriptionId);
  });

  it("needs no session, origin or JSON body: a foreign origin and a multipart body still unsubscribe", async () => {
    const { dependencies, post } = setup();
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    await post(oneClick(mintUnsubscribeToken(subscriptionId, currentKey), {
      headers: { origin: "https://mail.example" }, body: form,
    }));
    expect(dependencies.deleteSubscriptionById).toHaveBeenCalledExactlyOnceWith(subscriptionId);
  });

  it("answers every request alike, whether the token was valid and whether a row existed", async () => {
    const answers = new Set<string>();
    const unknownKey = randomBytes(32).toString("base64url");
    const cases: [string, string | null, boolean][] = [
      ["valid, row existed", mintUnsubscribeToken(subscriptionId, currentKey), true],
      ["valid, no row", mintUnsubscribeToken(subscriptionId, currentKey), false],
      ["foreign key", mintUnsubscribeToken(subscriptionId, unknownKey), true],
      ["garbage", "not-a-token", true],
      ["missing", null, true],
    ];
    for (const [label, token, existed] of cases) {
      const { dependencies, post } = setup();
      dependencies.deleteSubscriptionById.mockResolvedValueOnce(existed);
      answers.add(await answer(await post(oneClick(token))));
      expect(dependencies.deleteSubscriptionById.mock.calls.length, label).toBe(label.startsWith("valid") ? 1 : 0);
    }
    expect(answers.size).toBe(1);
    expect([...answers][0]).toMatch(/^200 /);
  });

  it("answers 502 without the error text when the delete fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { dependencies, post } = setup();
    dependencies.deleteSubscriptionById.mockRejectedValueOnce(new Error("secret database detail"));
    const response = await post(oneClick(mintUnsubscribeToken(subscriptionId, currentKey)));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret database detail");
    expect(error).toHaveBeenCalledExactlyOnceWith("Work mail unsubscribe failed.");
  });
});

describe("GET /api/work-mail/unsubscribe", () => {
  it("answers a page whose one form posts back to the same URL, without redirecting or acting", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    const forms = html.match(/<form\b[^>]*>/g) ?? [];
    expect(forms).toEqual(['<form method="post">']);
    expect(html).toMatch(/<button type="submit">/);
    expect(html).not.toMatch(/<script|http-equiv/i);
  });
});
