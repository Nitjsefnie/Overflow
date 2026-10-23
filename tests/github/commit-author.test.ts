import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";

describe("GitHub commit author lookup", () => {
  it.each([
    [{ object: { author: { user: { databaseId: 812 } } } }, 812],
    [{ object: { author: { user: null } } }, null],
    [{ object: null }, null],
    [null, null],
  ])("returns the author's account id or null (%#)", async (repository, expected) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => Response.json({ data: { repository } }),
    });
    await expect(gateway.getCommitAuthor({ owner: "octo", name: "overflow" }, "a".repeat(40)))
      .resolves.toBe(expected);
  });

  it("requests the commit author user rather than the committer", async () => {
    let payload: { query: string; variables: unknown } | undefined;
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json({ data: { repository: { object: { author: { user: { databaseId: 915 } } } } } });
      },
    });
    await expect(gateway.getCommitAuthor({ owner: "octo", name: "overflow" }, "b".repeat(40))).resolves.toBe(915);
    expect(payload?.variables).toEqual({ owner: "octo", name: "overflow", sha: "b".repeat(40) });
    expect(payload?.query).toMatch(/object\(expression: \$sha\)/);
    expect(payload?.query).toMatch(/author\s*\{\s*user\s*\{\s*databaseId/);
    expect(payload?.query).toMatch(/rateLimit\s*\{\s*cost limit remaining resetAt/);
  });

  it("propagates forge failures", async () => {
    const gateway = new GitHubGateway({ accessToken: "test-access-token",
      fetch: async () => Response.json({ errors: [{ type: "FORBIDDEN", message: "Cannot read commit" }] }),
    });
    await expect(gateway.getCommitAuthor({ owner: "octo", name: "overflow" }, "c".repeat(40)))
      .rejects.toThrow(/FORBIDDEN/);
  });
});
