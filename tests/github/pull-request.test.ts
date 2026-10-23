import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";

describe("GitHub pull request by number", () => {
  it("maps the PR's state, immutable author and repository using the existing transport", async () => {
    const gateway = new GitHubGateway({ accessToken: "test-token", fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://api.github.com/graphql');
      const body = await request.json();
      expect(body.variables).toEqual({ owner: 'octo', name: 'repo', pullRequestNumber: 41 });
      expect(body.query).toContain('pullRequest(number: $pullRequestNumber)');
      return Response.json({ data: { repository: { pullRequest: {
        databaseId: 71, number: 41, title: 'Change', body: 'Contribution', url: 'https://github.com/octo/repo/pull/41',
        state: 'CLOSED', mergedAt: null, mergeCommit: null, commits: { nodes: [] },
        author: { login: 'renamed', databaseId: 99 }, repository: { databaseId: 45, nameWithOwner: 'octo/repo' },
      } } } });
    } });
    expect(await gateway.getPullRequest({ owner: 'octo', name: 'repo' }, 41)).toEqual({
      id: 71, number: 41, title: 'Change', body: 'Contribution', url: 'https://github.com/octo/repo/pull/41',
      state: 'CLOSED', mergedAt: null, mergeCommitOid: null, finalCommitAt: null, authorLogin: 'renamed',
      authorGitHubUserId: 99, repositoryGitHubId: 45, repositoryNameWithOwner: 'octo/repo',
    });
  });
  it.each([null, { pullRequest: null }])("returns null for a missing repository or PR (%j)", async (repository) => {
    const gateway = new GitHubGateway({ accessToken: 'test-token', fetch: async () => Response.json({ data: { repository } }) });
    expect(await gateway.getPullRequest({ owner: 'octo', name: 'repo' }, 41)).toBeNull();
  });
});
