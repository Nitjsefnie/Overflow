import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationDependencies } from "@/lib/fold/reconcile";
import type { ReconciliationWorkerDependencies, ReconciliationWorkerSchedule } from "@/lib/fold/reconciliation-worker";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

/**
 * Issue 1362: GitHub reconciliation authenticates with the repository sponsor's
 * stored OAuth token only. Both production wirings run with every App variable
 * still set (production keeps them but reads none): a fold must reach no
 * installation or access-token endpoint and read with the sponsor's token.
 */

const fixtureDirectories = createOwnedTempDirectoryRegistry(join(tmpdir(), "reconciliation-oauth-only-"));

const { startWorker, lookup, oauth, authWrite } = vi.hoisted(() => ({
  startWorker: vi.fn(),
  lookup: vi.fn(),
  oauth: vi.fn(),
  authWrite: vi.fn(),
}));

vi.mock("@/lib/fold/reconciliation-worker", () => ({
  startReconciliationWorker: startWorker,
  drainReconciliationJobs: async (dependencies: ReconciliationWorkerDependencies) => {
    await dependencies.reconcile("repository-1", { rederive: false, reason: "SWEEP" });
    return [];
  },
}));
vi.mock("@/lib/fold/sweep", () => ({
  shouldStartReconciliationBackground: () => true,
  startReconciliationSweep: vi.fn(),
  sweepReconciliations: vi.fn(),
}));
vi.mock("@/lib/fold/abandoned-runs", () => ({ finalizeAbandonedRuns: async () => {} }));
vi.mock("@/lib/db/client", () => ({ getSql: () => authWrite, getCoordinationSql: vi.fn(), closeSql: vi.fn() }));
// Only traversal is replaced: environment parsing, credential resolution, the
// sponsor gateway and its real GitHub transport stay in the graph.
vi.mock("@/lib/fold/reconcile", () => ({
  reconcileRepository: async ({ github }: ReconciliationDependencies) => {
    await github.getRepositoryById(4242);
    return { repositoryId: "repository-1", adds: 0, changes: 0, removals: 0 };
  },
}));
vi.mock("@/lib/fold/postgres-store", () => ({
  PostgresFoldStore: class {
    findRepositoryByOwnerName = lookup;
    getGitHubAccessToken = oauth;
    async listActiveRepositoryIds() { return ["repository-1"]; }
    // The shape the sweep reads; the fake survives sweepReconciliations unmocked.
    async listActiveRepositorySponsors() {
      return [{ repositoryId: "repository-1", sponsorId: "sponsor-1" }];
    }
    async getRepository() {
      return {
        id: "repository-1", githubRepositoryId: 4242, ownerName: "example/repository", active: true,
        registeredAt: "2030-01-01T00:00:00.000Z",
        sponsor: { id: "sponsor-1", githubUserId: 1, githubLogin: "sponsor", enforcementState: "ACTIVE" },
        difficultyScheme: validDifficultyScheme(), difficultySchemeVersions: [],
      };
    }
  },
}));

let keyPath: string;
beforeAll(() => {
  const directory = fixtureDirectories.create();
  keyPath = join(directory, "app.pem");
  writeFileSync(keyPath, generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" }));
});
const sponsorToken = ["sponsor", "oauth", "credential"].join("-");
let requests: { method: string; path: string; authorization: string | null }[] = [];

beforeEach(() => {
  vi.resetModules();
  startWorker.mockReset();
  authWrite.mockReset().mockResolvedValue([]);
  oauth.mockReset().mockResolvedValue(sponsorToken);
  lookup.mockReset().mockResolvedValue({ id: "repository-1", registrationMethod: undefined });
  // Production keeps these variables set in its environment; after the change
  // nothing reads them, so a fold never reaches the App endpoints they serve.
  vi.stubEnv("GITHUB_APP_ID", "101");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY_PATH", keyPath);
  vi.stubEnv("GITHUB_REGISTRATION_APP_ID", "202");
  vi.stubEnv("GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH", keyPath);
  requests = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ method: request.method, path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
    return new Response(null, { status: 404 });
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { try { fixtureDirectories.dispose(); } finally { vi.resetModules(); } });

for (const wiring of ["worker", "cli"] as const) {
  describe(`${wiring} reconciliation folds GitHub repositories with the sponsor's OAuth token only`, () => {
    async function reconcile() {
      if (wiring === "cli") {
        const { runReconciliationCli } = await import("../../scripts/reconcile");
        await runReconciliationCli();
      } else {
        const { registerNodejs } = await import("@/instrumentation-node");
        await registerNodejs();
        await (startWorker.mock.calls[0]![0] as ReconciliationWorkerSchedule).drain();
      }
    }

    it("makes no installation or access-token request and reads with the sponsor's OAuth token", async () => {
      await reconcile();

      // The fold's one read is on the recorder, so its silence on the App
      // endpoints is a measurement and not a dead oracle.
      expect(requests.map(({ path }) => path)).toEqual(["/repositories/4242"]);
      expect(requests[0]).toMatchObject({ method: "GET", authorization: `Bearer ${sponsorToken}` });
      expect(oauth).toHaveBeenCalledExactlyOnceWith("sponsor-1");
      // Nothing journals an authentication path any more.
      expect(authWrite).not.toHaveBeenCalled();
    });
  });
}
