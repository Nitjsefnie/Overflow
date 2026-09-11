import { describe, expect, it, vi } from "vitest";
import { ForgeCredentialRejectedError } from "@/lib/forge/gateway";
import { sponsorGateway } from "@/lib/fold/reconcile-as-sponsor";
import { GitLabApiError } from "@/lib/gitlab/client";
import type { ReconciliationGateway, ReconciliationRepository } from "@/lib/fold/reconcile";
import { validDifficultyScheme } from "../support/difficulty-scheme";

/**
 * The credential-rejection seam: a read made through the linked identity that
 * the instance refuses with 401/403 marks the identity as needing
 * re-verification and surfaces as the typed, fixed-message error — while every
 * other failure class keeps its original error and marks nothing. The inner
 * gateway is the real GitLabGateway over a stubbed transport, so the statuses
 * are the ones the wire produces.
 */
describe("sponsor gateway marks a rejected GitLab credential", () => {
  const INSTANCE = "https://gitlab.example.com";

  function repositoryRow(overrides: Partial<ReconciliationRepository> = {}): ReconciliationRepository {
    return {
      id: "repo-1",
      githubRepositoryId: 1,
      ownerName: "g/p",
      active: true,
      registeredAt: "2026-09-01T00:00:00.000Z",
      sponsor: { id: "sponsor-1", githubUserId: 1, githubLogin: "s", enforcementState: "ACTIVE" },
      difficultyScheme: validDifficultyScheme(),
      difficultySchemeVersions: [],
      provider: "gitlab",
      instanceUrl: INSTANCE,
      ...overrides,
    };
  }

  function storeFor(row: ReconciliationRepository): Parameters<typeof sponsorGateway>[0] {
    return {
      async getRepository() {
        return row;
      },
      async getGitHubAccessToken() {
        throw new Error("a GitLab fold never reads the sponsor's GitHub token");
      },
    } as unknown as Parameters<typeof sponsorGateway>[0];
  }

  /** The transport the GitLabGateway is built over: each test plants one responder. */
  function stubTransport(respond: () => Promise<Response>): void {
    vi.stubGlobal("fetch", async () => respond());
  }

  function gatewayFor(
    repository: ReconciliationRepository,
    markCredentialRejected: (userId: string, instanceUrl: string) => Promise<void>,
  ): ReconciliationGateway {
    return sponsorGateway(
      storeFor(repository),
      repository.id,
      () => {
        throw new Error("the GitHub factory must not run for a GitLab fold");
      },
      async () => "glpat-linked-identity-token",
      markCredentialRejected,
    );
  }

  const DIFF_REQUEST = [{ owner: "g", name: "p" }, 7] as const;

  it("marks the identity and rethrows the typed error on a 401 read", async () => {
    // The planted body stands in for upstream error text; the typed error's
    // fixed sentence must never carry it.
    stubTransport(async () => new Response("401_denied pat-abc123 leaked", { status: 401 }));
    const mark = vi.fn(async () => {});
    const gateway = gatewayFor(repositoryRow(), mark);

    const error = await gateway.getPullRequestDiff(...DIFF_REQUEST).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForgeCredentialRejectedError);
    expect((error as Error).message).not.toContain("pat-abc123");
    expect(mark).toHaveBeenCalledExactlyOnceWith("sponsor-1", INSTANCE);
  });

  it("marks the identity and rethrows the typed error on a 403 read", async () => {
    stubTransport(async () => new Response("403_forbidden scope reduced", { status: 403 }));
    const mark = vi.fn(async () => {});
    const gateway = gatewayFor(repositoryRow(), mark);

    const error = await gateway.getPullRequestDiff(...DIFF_REQUEST).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForgeCredentialRejectedError);
    expect((error as Error).message).not.toContain("scope reduced");
    expect(mark).toHaveBeenCalledExactlyOnceWith("sponsor-1", INSTANCE);
  });

  it.each([
    { name: "a 404 the transport reports", status: 404, statusName: 404 },
    { name: "a 500 the instance serves", status: 500, statusName: 500 },
  ])("keeps $name unmarked and original", async ({ status, statusName }) => {
    stubTransport(async () => new Response(`status-${status} body`, { status }));
    const mark = vi.fn(async () => {});
    const gateway = gatewayFor(repositoryRow(), mark);

    const error = await gateway.getPullRequestDiff(...DIFF_REQUEST).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitLabApiError);
    expect((error as GitLabApiError).status).toBe(statusName);
    expect(error).not.toBeInstanceOf(ForgeCredentialRejectedError);
    expect(mark).not.toHaveBeenCalled();
  });

  it("keeps a transport failure (status 0) unmarked and original", async () => {
    stubTransport(async () => {
      throw new Error("connection reset");
    });
    const mark = vi.fn(async () => {});
    const gateway = gatewayFor(repositoryRow(), mark);

    const error = await gateway.getPullRequestDiff(...DIFF_REQUEST).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitLabApiError);
    expect((error as GitLabApiError).status).toBe(0);
    expect(mark).not.toHaveBeenCalled();
  });

  it("marks nothing on a GitHub fold whose gateway fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("the transport must not be read for a GitHub fold");
    });
    const mark = vi.fn(async () => {});
    const githubStore = {
      async getRepository() {
        return repositoryRow({ provider: "github", instanceUrl: null });
      },
      async getGitHubAccessToken() {
        return "gho-sponsor-token";
      },
    } as unknown as Parameters<typeof sponsorGateway>[0];
    const gateway = sponsorGateway(
      githubStore,
      "repo-1",
      () => ({
        getRepositoryById: async () => null,
        listIssues: async () => [],
        getIssue: async () => null,
        getPullRequestClosingIssues: async () => [],
        getPullRequestReviews: async () => {
          throw new Error("reviews read failed");
        },
        getPullRequestDiff: async () => "",
      }),
      async () => "unused",
      mark,
    );

    const error = await gateway.getPullRequestReviews({ owner: "g", name: "p" }, 7).then(() => null, (caught: unknown) => caught);

    expect((error as Error).message).toBe("reviews read failed");
    expect(error).not.toBeInstanceOf(ForgeCredentialRejectedError);
    expect(mark).not.toHaveBeenCalled();
  });

  it("rethrows the original error when the mark itself fails, after attempting it", async () => {
    stubTransport(async () => new Response("401_denied", { status: 401 }));
    const mark = vi.fn(async () => {
      throw new Error("the marker store is down");
    });
    const gateway = gatewayFor(repositoryRow(), mark);

    const error = await gateway.getPullRequestDiff(...DIFF_REQUEST).then(() => null, (caught: unknown) => caught);

    expect(mark).toHaveBeenCalledExactlyOnceWith("sponsor-1", INSTANCE);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect((error as GitLabApiError).status).toBe(401);
    expect(error).not.toBeInstanceOf(ForgeCredentialRejectedError);
    expect((error as Error).message).not.toContain("marker store is down");
  });

  it("passes a healthy read through untouched", async () => {
    stubTransport(async () => new Response("the raw diff", { status: 200 }));
    const mark = vi.fn(async () => {});
    const gateway = gatewayFor(repositoryRow(), mark);

    await expect(gateway.getPullRequestDiff(...DIFF_REQUEST)).resolves.toBe("the raw diff");
    expect(mark).not.toHaveBeenCalled();
  });
});
