import { describe, expect, it } from "vitest";
import type { ReconciliationGateway } from "@/lib/fold/reconcile";
import { withTransientRequestRetry } from "@/lib/fold/reconciliation-retry";
import { GitHubGraphqlRequestError, isTransientGitHubRequestError } from "@/lib/github/errors";
import { GitHubGraphqlClient } from "@/lib/github/graphql";

const accessToken = ["test", "token", "body-stream"].join("-");
const query = "query { value }";

describe("GraphQL successful-response body failures", () => {
  it("classifies a mid-body stream error as transient without a payload status", async () => {
    const client = new GitHubGraphqlClient({ accessToken, fetch: async () => brokenBodyResponse() });

    const error = await client.query(query, {}).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(GitHubGraphqlRequestError);
    expect({ status: (error as GitHubGraphqlRequestError).status, transient: isTransientGitHubRequestError(error) })
      .toEqual({ status: null, transient: true });
  });

  it("classifies a cleanly closed truncated JSON body as transient without a payload status", async () => {
    const client = new GitHubGraphqlClient({
      accessToken,
      fetch: async () => new Response('{"data":{"value":', { status: 200 }),
    });

    const error = await client.query(query, {}).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(GitHubGraphqlRequestError);
    expect({ status: (error as GitHubGraphqlRequestError).status, transient: isTransientGitHubRequestError(error) })
      .toEqual({ status: null, transient: true });
  });

  it("keeps a valid GraphQL error payload definitive with status 200", async () => {
    const client = new GitHubGraphqlClient({
      accessToken,
      fetch: async () => Response.json({
        data: { repository: null },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Issue with the number of 1." }],
      }),
    });

    const error = await client.query(query, {}).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(GitHubGraphqlRequestError);
    expect({ status: (error as GitHubGraphqlRequestError).status, transient: isTransientGitHubRequestError(error) })
      .toEqual({ status: 200, transient: false });
  });

  it("recovers a gateway read after the real client's first response breaks mid-body", async () => {
    let requests = 0;
    const client = new GitHubGraphqlClient({
      accessToken,
      fetch: async () => {
        requests += 1;
        return requests === 1 ? brokenBodyResponse() : Response.json({ data: { value: "recovered diff" } });
      },
    });
    const gateway: ReconciliationGateway = {
      getRepositoryById: async () => null,
      listIssues: async () => [],
      getIssue: async () => null,
      getPullRequestClosingIssues: async () => [],
      getPullRequestReviews: async () => [],
      getPullRequestDiff: async () => (await client.query<{ value: string }>(query, {})).value,
    };
    const wrapped = withTransientRequestRetry(gateway, { delay: async () => {} });

    const result = await wrapped.getPullRequestDiff({ owner: "octo", name: "example" }, 11)
      .catch((error: unknown) => error);

    expect({ result, requests }).toEqual({ result: "recovered diff", requests: 2 });
  });
});

function brokenBodyResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":{"value":'));
    },
    pull(controller) {
      controller.error(new TypeError("connection reset mid-body"));
    },
  }), { status: 200 });
}
