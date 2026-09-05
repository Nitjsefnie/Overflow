import { describe, expect, it } from "vitest";
import { GitHubApiError, GitHubGateway } from "@/lib/github/client";

describe("GitHubGateway REST transport", () => {
  it("uses GitHub's versioned API headers when reading one explicitly named repository", async () => {
    let capturedRequest: Request | undefined;
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        return Response.json({
          id: 42,
          name: "overflow",
          full_name: "octo/overflow",
          private: false,
          html_url: "https://github.com/octo/overflow",
          owner: { login: "octo" },
          permissions: { admin: true },
        });
      },
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).resolves.toEqual({
      id: 42,
      owner: "octo",
      ownerType: "USER",
      name: "overflow",
      fullName: "octo/overflow",
      visibility: "PUBLIC",
      url: "https://github.com/octo/overflow",
      canAdminister: true,
    });

    expect(capturedRequest?.url).toBe("https://api.github.com/repos/octo/overflow");
    expect(capturedRequest?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(capturedRequest?.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(capturedRequest?.headers.get("authorization")).toBe("Bearer test-access-token");
  });

  it.each([
    ["Organization", "ORGANIZATION"],
    ["User", "USER"],
    ["Unknown", "USER"],
    [undefined, "USER"],
  ])("maps REST owner type %s to %s", async (type, ownerType) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => Response.json({
        id: 42,
        name: "overflow",
        full_name: "real-owner/overflow",
        private: false,
        html_url: "https://github.com/real-owner/overflow",
        owner: { login: "real-owner", type },
        permissions: { admin: true },
      }),
    });

    await expect(gateway.getRepository({ owner: "old-owner", name: "overflow" })).resolves.toMatchObject({
      owner: "real-owner",
      ownerType,
    });
  });

  it.each([403, 404, 502])("carries HTTP status %s in a GitHubApiError", async (status) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => new Response("private response test-access-token", { status }),
    });

    const error = await gateway.getRepository({ owner: "octo", name: "overflow" }).catch((error: unknown) => error);
    expect(error).toMatchObject({ status, message: `GitHub API request failed with status ${status}.` });
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toBeInstanceOf(Error);
  });

  it("sanitizes a transport error even when its text resembles an HTTP error", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => { throw new Error("GitHub API request failed with status 403."); },
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).rejects.toThrow("GitHub request failed.");
  });

  it("aborts a stalled GitHub request and exposes only a sanitized timeout error", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      timeoutMs: 1,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("upstream body contained test-access-token")),
            { once: true },
          );
        }),
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).rejects.toThrow(
      "GitHub request timed out.",
    );
  });

  it("does not leak an upstream response body or access token in an HTTP error", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () =>
        new Response('{"message":"test-access-token and private upstream details"}', {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).rejects.toThrow(
      "GitHub API request failed with status 502.",
    );
  });

  it("creates only configured labels that are absent and never enumerates accessible repositories", async () => {
    const createdLabels: string[] = [];
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        requestedUrls.push(String(input));
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as { name: string };
          createdLabels.push(payload.name);
          return Response.json({ name: payload.name }, { status: 201 });
        }

        return Response.json([{ name: "size/S" }, { name: "bug" }]);
      },
    });

    await gateway.ensureDifficultyLabels(
      { owner: "octo", name: "overflow" },
      ["size/S", "size/M"],
    );

    expect(createdLabels).toEqual(["size/M"]);
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/octo/overflow/labels?per_page=100&page=1",
      "https://api.github.com/repos/octo/overflow/labels",
    ]);
    expect(requestedUrls.some((url) => url.includes("/user/repos"))).toBe(false);
  });

  it("creates and removes a repository webhook with the configured callback secret", async () => {
    const requests: Request[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "POST") {
          return Response.json({ id: 81 }, { status: 201 });
        }
        return new Response(null, { status: 204 });
      },
    });
    const repository = { owner: "octo", name: "overflow" };

    await expect(
      gateway.createWebhook(repository, {
        callbackUrl: "https://overflow.example/api/github/webhooks",
        secret: "webhook-secret-for-test",
      }),
    ).resolves.toEqual({ id: 81 });
    await expect(gateway.deleteWebhook(repository, 81)).resolves.toBeUndefined();

    expect(await requests[0]?.json()).toEqual({
      active: true,
      config: {
        content_type: "json",
        secret: "webhook-secret-for-test",
        url: "https://overflow.example/api/github/webhooks",
      },
      events: ["issues", "pull_request", "pull_request_review"],
      name: "web",
    });
    expect(requests[1]?.method).toBe("DELETE");
    expect(requests[1]?.url).toBe("https://api.github.com/repos/octo/overflow/hooks/81");
  });

  it("requests a pull request diff through the GitHub diff media type", async () => {
    let request: Request | undefined;
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response("diff --git a/a.ts b/a.ts", { status: 200 });
      },
    });

    await expect(
      gateway.getPullRequestDiff({ owner: "octo", name: "overflow" }, 4),
    ).resolves.toBe("diff --git a/a.ts b/a.ts");
    expect(request?.headers.get("accept")).toBe("application/vnd.github.v3.diff");
  });
});
