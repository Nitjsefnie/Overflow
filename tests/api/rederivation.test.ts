import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  expectNoDependencyCall,
  guardedRequests,
  unusedDependencies,
  useTrustedOrigin,
} from "../support/trusted-origin";
import {
  createRederivationGetHandler,
  createRederivationPostHandler,
  type RederivationRouteDependencies,
  type RederivationRouteService,
} from "@/app/api/moderation/rederivation/route";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import { ModerationServiceError } from "@/lib/moderation/service";
import {
  RepositoryRederivationService,
  type RederivationStore,
} from "@/lib/moderation/rederivation-service";

const moderatorSession = { user: { id: "00000000-0000-4000-8000-000000000001", role: "MODERATOR" as const } };
const memberSession = { user: { id: "00000000-0000-4000-8000-000000000002", role: "MEMBER" as const } };
const repositoryId = "00000000-0000-4000-8000-000000000010";
const otherRepositoryId = "00000000-0000-4000-8000-000000000011";
const requestedAt = new Date("2026-09-07T09:00:00.000Z");

useTrustedOrigin();

const { json: jsonRequest, foreignJson: foreignJsonRequest, trustedText: trustedTextRequest } =
  guardedRequests("/api/moderation/rederivation");

describe("fold re-derivation status API", () => {
  // The service these two build would answer 200, so an ungated route reads as a
  // successful status page rather than as a confusing failure inside a stub.
  it("refuses a caller whose database role is no longer MODERATOR, before any service work", async () => {
    const getCurrentRole = vi.fn().mockResolvedValue("MEMBER");
    const listRederivationStatus = vi.fn().mockResolvedValue(emptyOverview);
    const response = await createRederivationGetHandler({
      ...moderatorDependencies({ listRederivationStatus }),
      getSession: async () => memberSession,
      getCurrentRole,
    })();

    await expectRejection(response, 403, "FORBIDDEN", "Moderator authorization is required.");
    expect(getCurrentRole).toHaveBeenCalledWith(memberSession.user.id);
    expect(listRederivationStatus).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated status read", async () => {
    const listRederivationStatus = vi.fn().mockResolvedValue(emptyOverview);
    const response = await createRederivationGetHandler({
      ...moderatorDependencies({ listRederivationStatus }),
      getSession: async () => null,
    })();

    await expectRejection(response, 401, "UNAUTHENTICATED", "Sign in is required.");
    expect(listRederivationStatus).not.toHaveBeenCalled();
  });

  it("reports every repository's stamped row counts alongside the current fold revision", async () => {
    const overview = {
      foldRevision: FOLD_REVISION,
      repositories: [
        {
          repositoryId,
          ownerName: "owner/stale",
          rowsAtCurrentRevision: 1,
          rowsBelowCurrentRevision: 2,
          rederivationRequestedAt: requestedAt.toISOString(),
        },
        {
          repositoryId: otherRepositoryId,
          ownerName: "owner/current",
          rowsAtCurrentRevision: 3,
          rowsBelowCurrentRevision: 0,
          rederivationRequestedAt: null,
        },
      ],
    };
    const listRederivationStatus = vi.fn().mockResolvedValue(overview);
    const response = await createRederivationGetHandler(
      moderatorDependencies({ listRederivationStatus }),
    )();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rederivation: overview });
    expect(listRederivationStatus).toHaveBeenCalledWith({
      id: moderatorSession.user.id,
      role: "MODERATOR",
    });
  });

  it("refuses a foreign-origin re-derivation request before any session or database work", async () => {
    const dependencies = unusedDependencies();

    const response = await createRederivationPostHandler(dependencies)(
      foreignJsonRequest({ repositoryId }),
    );

    await expectRejection(response, 403, "FORBIDDEN", "The request origin is not allowed.");
    expectNoDependencyCall(dependencies);
  });

  it("refuses a trusted-origin re-derivation request that is not JSON", async () => {
    const dependencies = unusedDependencies();

    const response = await createRederivationPostHandler(dependencies)(
      trustedTextRequest({ repositoryId }),
    );

    await expectRejection(
      response,
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request must use the application/json content type.",
    );
    expectNoDependencyCall(dependencies);
  });

  it.each([
    ["an unknown field", { repositoryId, rederive: true }],
    ["a repository id that is not a uuid", { repositoryId: "owner/repo" }],
    ["a missing repository id", {}],
  ])("refuses a request body carrying %s", async (_description, body) => {
    const requestRederivation = vi.fn();
    const response = await createRederivationPostHandler(
      moderatorDependencies({ requestRederivation }),
    )(jsonRequest(body));

    await expectRejection(response, 422, "INVALID_REQUEST", "Invalid re-derivation request.");
    expect(requestRederivation).not.toHaveBeenCalled();
  });

  // The gate belongs on the mutating verb every bit as much as on the read, and a
  // status assertion alone would pass a route that refused the caller after
  // queueing the work. Each of these hands the route a service that would have
  // succeeded, so an ungated POST answers 200 rather than failing inside a stub.
  it("refuses a re-derivation request whose caller is no longer MODERATOR, without queueing it", async () => {
    const getCurrentRole = vi.fn().mockResolvedValue("MEMBER");
    const requestRederivation = vi.fn().mockResolvedValue(outstandingRequest);
    const response = await createRederivationPostHandler({
      ...moderatorDependencies({ requestRederivation }),
      getSession: async () => memberSession,
      getCurrentRole,
    })(jsonRequest({ repositoryId }));

    await expectRejection(response, 403, "FORBIDDEN", "Moderator authorization is required.");
    expect(getCurrentRole).toHaveBeenCalledWith(memberSession.user.id);
    expect(requestRederivation).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated re-derivation request, without queueing it", async () => {
    const requestRederivation = vi.fn().mockResolvedValue(outstandingRequest);
    const response = await createRederivationPostHandler({
      ...moderatorDependencies({ requestRederivation }),
      getSession: async () => null,
    })(jsonRequest({ repositoryId }));

    await expectRejection(response, 401, "UNAUTHENTICATED", "Sign in is required.");
    expect(requestRederivation).not.toHaveBeenCalled();
  });

  it("records the request and answers with the resulting outstanding state", async () => {
    const requestRederivation = vi.fn().mockResolvedValue(outstandingRequest);
    const response = await createRederivationPostHandler(
      moderatorDependencies({ requestRederivation }),
    )(jsonRequest({ repositoryId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ request: outstandingRequest });
    expect(requestRederivation).toHaveBeenCalledWith(
      { id: moderatorSession.user.id, role: "MODERATOR" },
      repositoryId,
    );
  });

  it.each([
    ["NOT_FOUND", 404],
    ["FORBIDDEN", 403],
    ["CONFLICT", 409],
  ] as const)("maps a %s service outcome to structured HTTP %s", async (code, status) => {
    const requestRederivation = vi.fn().mockRejectedValue(new ModerationServiceError(code, "Refused."));
    const response = await createRederivationPostHandler(
      moderatorDependencies({ requestRederivation }),
    )(jsonRequest({ repositoryId }));

    await expectRejection(response, status, code, "Unable to process moderation request.");
  });
});

// The real service is wired in here so that the route's answers are the ones a
// moderator would actually see, rather than whatever a stub chose to return.
describe("fold re-derivation service reached through its route", () => {
  it("answers NOT_FOUND for a repository the deployment does not serve", async () => {
    const store = storeHarness();
    const response = await createRederivationPostHandler(
      realServiceDependencies(store),
    )(jsonRequest({ repositoryId: otherRepositoryId }));

    await expectRejection(response, 404, "NOT_FOUND", "Unable to process moderation request.");
    expect(store.requestRepositoryRederivation).not.toHaveBeenCalled();
  });

  it("stamps the request with the service clock and returns the stored timestamp", async () => {
    const store = storeHarness();
    const response = await createRederivationPostHandler(
      realServiceDependencies(store),
    )(jsonRequest({ repositoryId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      request: {
        repositoryId,
        ownerName: "owner/stale",
        rederivationRequestedAt: requestedAt.toISOString(),
      },
    });
    expect(store.requestRepositoryRederivation).toHaveBeenCalledWith(repositoryId, requestedAt);
  });

  it("renders stored counts and timestamps as the wire shape", async () => {
    const store = storeHarness();
    const response = await createRederivationGetHandler(realServiceDependencies(store))();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rederivation: {
        foldRevision: FOLD_REVISION,
        repositories: [
          {
            repositoryId,
            ownerName: "owner/stale",
            rowsAtCurrentRevision: 1,
            rowsBelowCurrentRevision: 2,
            rederivationRequestedAt: requestedAt.toISOString(),
          },
        ],
      },
    });
    expect(store.listRepositoryFoldRevisionCounts).toHaveBeenCalledWith(FOLD_REVISION);
  });

  it("refuses a non-moderator actor at the service, not only at the route", async () => {
    const store = storeHarness();
    const service = new RepositoryRederivationService(store, () => requestedAt);

    await expect(service.requestRederivation({ id: memberSession.user.id, role: "MEMBER" }, repositoryId))
      .rejects.toThrow(ModerationServiceError);
    expect(store.requestRepositoryRederivation).not.toHaveBeenCalled();
  });

  it("refuses a non-moderator actor reading the status at the service, not only at the route", async () => {
    const store = storeHarness();
    const service = new RepositoryRederivationService(store, () => requestedAt);

    await expect(service.listRederivationStatus({ id: memberSession.user.id, role: "MEMBER" }))
      .rejects.toThrow(ModerationServiceError);
    expect(store.listRepositoryFoldRevisionCounts).not.toHaveBeenCalled();
  });
});

const emptyOverview = { foldRevision: FOLD_REVISION, repositories: [] };
const outstandingRequest = {
  repositoryId,
  ownerName: "owner/stale",
  rederivationRequestedAt: requestedAt.toISOString(),
};

// The mocks stand in for a service whose methods are typed, which vi.fn() is not.
function moderatorDependencies(service: {
  listRederivationStatus?: Mock;
  requestRederivation?: Mock;
}): RederivationRouteDependencies {
  return {
    getSession: async () => moderatorSession,
    getCurrentRole: async () => "MODERATOR",
    createService: async () =>
      ({
        listRederivationStatus: service.listRederivationStatus ?? vi.fn(),
        requestRederivation: service.requestRederivation ?? vi.fn(),
      }) as unknown as RederivationRouteService,
  };
}

function realServiceDependencies(store: RederivationStore): RederivationRouteDependencies {
  return {
    getSession: async () => moderatorSession,
    getCurrentRole: async () => "MODERATOR",
    createService: async () => new RepositoryRederivationService(store, () => requestedAt),
  };
}

function storeHarness() {
  return {
    listRepositoryFoldRevisionCounts: vi.fn(async () => [
      {
        repositoryId,
        ownerName: "owner/stale",
        rowsAtRevision: 1,
        rowsBelowRevision: 2,
        rederivationRequestedAt: requestedAt,
      },
    ]),
    findRepositoryRederivationRequest: vi.fn(async (id: string) =>
      id === repositoryId
        ? { repositoryId, ownerName: "owner/stale", rederivationRequestedAt: requestedAt }
        : null,
    ),
    requestRepositoryRederivation: vi.fn(async () => {}),
  };
}

async function expectRejection(
  response: Response,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ error: { code, message } });
}
