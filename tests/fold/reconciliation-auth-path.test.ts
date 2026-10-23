import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sponsorGateway } from "@/lib/fold/reconcile-as-sponsor";
import type { ReconciliationGateway, ReconciliationRepository, ReconciliationStore } from "@/lib/fold/reconcile";
import { validDifficultyScheme } from "../support/difficulty-scheme";

const token = randomBytes(24).toString("base64url");
const repository: ReconciliationRepository = {
  disputePullRequests: [],
  id: "repository-1", githubRepositoryId: 4242, ownerName: "example/repository", active: true,
  registeredAt: "2030-01-01T00:00:00.000Z",
  sponsor: { id: "sponsor-1", githubUserId: 1, githubLogin: "sponsor", enforcementState: "ACTIVE" },
  difficultyScheme: validDifficultyScheme(), difficultySchemeVersions: [],
};
const inner: ReconciliationGateway = {
  getRepositoryById: async () => null, listIssues: async () => [], getIssue: async () => null,
  getPullRequestClosingIssues: async () => [], getPullRequestReviews: async () => [], getPullRequestDiff: async () => "",
};
function store(row = repository): ReconciliationStore {
  return { getRepository: async () => row, getGitHubAccessToken: async () => token } as unknown as ReconciliationStore;
}
afterEach(() => vi.restoreAllMocks());

describe("recording the memoized sponsor gateway authentication path", () => {
  // Omitting recording or recording per read breaks these independently specified paths.
  it.each([
    { app: "reconciliation", path: "github-app-installation" },
    { app: "registration", path: "registration-app-installation" },
    { app: null, path: "sponsor-oauth-fallback" },
  ] as const)("records $path once for concurrent and subsequent reads", async ({ app, path }) => {
    const informed = vi.spyOn(console, "info").mockImplementation(() => {});
    const record = vi.fn(async () => {});
    const resolve = vi.fn(async () => app === null ? null : { token, installationId: 42, app });
    const create = vi.fn(() => inner);
    const gateway = sponsorGateway(store(), repository.id, create, undefined, undefined, resolve, record);
    expect(record).not.toHaveBeenCalled();
    await Promise.all([gateway.getRepositoryById(4242), gateway.listIssues({ owner: "example", name: "repository" })]);
    await gateway.getRepositoryById(4242);
    expect(record).toHaveBeenCalledExactlyOnceWith("repository-1", path);
    expect(resolve).toHaveBeenCalledExactlyOnceWith("example/repository");
    expect(create).toHaveBeenCalledExactlyOnceWith(token, "sponsor-1");
    expect(informed).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      repositoryId: "repository-1", authPath: path, ...(app === null ? {} : { installationId: 42 }),
    });
  });

  // Recording before the provider/resolver branches would overwrite unrelated auth history.
  it("records nothing for GitLab", async () => {
    const record = vi.fn(async () => {});
    const resolve = vi.fn(async () => ({ token, installationId: 42 }));
    const gateway = sponsorGateway(store({ ...repository, provider: "gitlab", instanceUrl: "https://gitlab.example.com" }),
      repository.id, () => inner, async () => null, undefined, resolve, record);
    await expect(gateway.getRepositoryById(4242)).rejects.toThrow(/No verified GitLab identity/);
    expect(resolve).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("records nothing when no App resolver is wired", async () => {
    const record = vi.fn(async () => {});
    const gateway = sponsorGateway(store(), repository.id, () => inner, undefined, undefined, undefined, record);
    await expect(gateway.getRepositoryById(4242)).resolves.toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it("records nothing and fails closed when installation resolution throws", async () => {
    const record = vi.fn(async () => {});
    const failure = new Error("installation lookup unavailable");
    const create = vi.fn(() => inner);
    const gateway = sponsorGateway(store(), repository.id, create, undefined, undefined,
      async () => { throw failure; }, record);
    await expect(gateway.getRepositoryById(4242)).rejects.toBe(failure);
    expect(record).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  // Removing the catch would replace a resolved credential with a failed fold.
  it.each([true, false])("continues on the resolved credential when recording rejects (App: %s)", async (app) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("auth path store unavailable");
    const record = vi.fn(async () => { throw failure; });
    const create = vi.fn(() => inner);
    const gateway = sponsorGateway(store(), repository.id, create, undefined, undefined,
      async () => app ? { token, installationId: 42 } : null, record);
    await expect(gateway.getRepositoryById(4242)).resolves.toBeNull();
    await expect(gateway.listIssues({ owner: "example", name: "repository" })).resolves.toEqual([]);
    expect(record).toHaveBeenCalledExactlyOnceWith("repository-1", app ? "github-app-installation" : "sponsor-oauth-fallback");
    expect(create).toHaveBeenCalledExactlyOnceWith(token, "sponsor-1");
    expect(logged).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("repository-1"), failure);
  });

  // A fire-and-forget write lets the read finish before the durable record exists.
  it.each([true, false])("awaits the recorder before reading the forge (App: %s)", async (app) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let finish!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const recording = new Promise<void>((resolve) => { entered = resolve; });
    const create = vi.fn(() => inner);
    const gateway = sponsorGateway(store(), repository.id, create, undefined, undefined,
      async () => app ? { token, installationId: 42 } : null,
      async () => { entered(); await pending; });
    const read = gateway.getRepositoryById(4242);
    await recording;
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { expect(create).not.toHaveBeenCalled(); } finally { finish(); }
    await expect(read).resolves.toBeNull();
  }, 1000);
});
