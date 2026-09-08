import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubGateway } from "@/lib/github/client";

const repository = { owner: "new-owner", name: "renamed" };
const secret = "original-webhook-secret";
const hook = {
  type: "Repository", id: 81, name: "web", active: false,
  events: ["issues", "pull_request", "pull_request_review", "push"],
  config: { url: "https://overflow.example/api/github/webhooks", content_type: "json", insecure_ssl: "0", secret: "********" },
};

afterEach(() => vi.useRealTimers());

describe("upgrading persisted GitHub webhook subscriptions", () => {
  it("adds comments to the exact hook, preserves configuration and unrelated events, and safely reruns", async () => {
    let remote = structuredClone(hook);
    const requests: Request[] = [];
    const gateway = new GitHubGateway({ accessToken: "sponsor-token", fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "PATCH") {
        const body = await request.clone().json();
        remote = { ...remote, ...body, events: [...remote.events, ...body.add_events] };
      }
      return Response.json(remote);
    } });

    await gateway.ensureWebhookEvents(repository, 81, secret);
    await gateway.ensureWebhookEvents(repository, 81, secret);

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.github.com/repos/new-owner/renamed/hooks/81",
      "PATCH https://api.github.com/repos/new-owner/renamed/hooks/81",
      "GET https://api.github.com/repos/new-owner/renamed/hooks/81",
    ]);
    expect(await requests[1]!.json()).toEqual({
      add_events: ["issue_comment"], active: false,
      config: { url: "https://overflow.example/api/github/webhooks", content_type: "json", insecure_ssl: "0", secret },
    });
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer sponsor-token");
    expect(requests[1]!.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(remote.events).toEqual(["issues", "pull_request", "pull_request_review", "push", "issue_comment"]);
    expect(remote.config.secret).toBe(secret);
    expect(remote.active).toBe(false);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid persisted hook id %s before HTTP", async (id) => {
    const requests: unknown[] = [];
    const gateway = new GitHubGateway({ accessToken: "token", fetch: async (...args) => { requests.push(args); return Response.json(hook); } });
    await expect(gateway.ensureWebhookEvents(repository, id, secret)).rejects.toThrow("GitHub webhook id must be a positive safe integer.");
    expect(requests).toEqual([]);
  });

  it.each([
    null, { ...hook, id: 82 }, { ...hook, events: null }, { ...hook, events: [42] },
    { ...hook, active: "false" }, { ...hook, config: null }, { ...hook, config: { url: 42 } },
  ])("refuses malformed or mismatched preflight hooks without writing: %j", async (payload) => {
    const methods: string[] = [];
    const gateway = new GitHubGateway({ accessToken: "token", fetch: async (_input, init) => {
      methods.push(init?.method ?? "GET"); return Response.json(payload);
    } });
    await expect(gateway.ensureWebhookEvents(repository, 81, secret)).rejects.toThrow("GitHub webhook response was invalid.");
    expect(methods).toEqual(["GET"]);
  });

  it.each([
    hook,
    { ...hook, id: 82, events: ["issue_comment"] },
    { ...hook, events: ["issue_comment"] },
    { ...hook, events: [...hook.events, "issue_comment"], active: true },
    { ...hook, events: [...hook.events, "issue_comment"], config: { ...hook.config, url: "https://changed.example" } },
    null,
  ])("never reports an ambiguous PATCH response as verified: %j", async (payload) => {
    const gateway = new GitHubGateway({ accessToken: "token", fetch: async (_input, init) => Response.json(init?.method === "PATCH" ? payload : hook) });
    await expect(gateway.ensureWebhookEvents(repository, 81, secret)).rejects.toThrow();
  });

  it("recognizes an existing wildcard subscription without changing the hook", async () => {
    const methods: string[] = [];
    const gateway = new GitHubGateway({ accessToken: "token", fetch: async (_input, init) => {
      methods.push(init?.method ?? "GET"); return Response.json({ ...hook, events: ["*"] });
    } });
    await gateway.ensureWebhookEvents(repository, 81, secret);
    expect(methods).toEqual(["GET"]);
  });

  it("refuses a missing original secret before making any update", async () => {
    const methods: string[] = [];
    const gateway = new GitHubGateway({ accessToken: "token", fetch: async (_input, init) => {
      methods.push(init?.method ?? "GET"); return Response.json(hook);
    } });
    await expect(gateway.ensureWebhookEvents(repository, 81, "")).rejects.toThrow("Existing webhook secret must be configured.");
    expect(methods).toEqual([]);
  });

  it.each([403, 404, 422, 500])("reports HTTP %s without exposing private response diagnostics", async (status) => {
    const gateway = new GitHubGateway({ accessToken: "token", fetch: async (_input, init) => init?.method === "PATCH"
      ? new Response("private upstream token and secret", { status }) : Response.json(hook) });
    const error = await gateway.ensureWebhookEvents(repository, 81, secret).catch((error: unknown) => error);
    expect(error).toMatchObject({ status, body: null });
    expect(String(error)).not.toContain("private upstream");
  });

  it.each(["GET", "PATCH"])("bounds a stalled %s body by the existing request deadline", async (method) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const gateway = new GitHubGateway({ accessToken: "token", timeoutMs: 100, fetch: async (_input, init) => {
      if ((init?.method ?? "GET") !== method) return Response.json(hook);
      signal = init?.signal;
      return new Response(new ReadableStream({ start() {} }));
    } });
    const result = gateway.ensureWebhookEvents(repository, 81, secret).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ message: "GitHub request timed out." });
    expect(signal?.aborted).toBe(true);
  });
});
