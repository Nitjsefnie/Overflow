import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationDependencies } from "@/lib/fold/reconcile";
import type { ReconciliationWorkerDependencies, ReconciliationWorkerSchedule } from "@/lib/fold/reconciliation-worker";
import { validDifficultyScheme } from "../support/difficulty-scheme";

const { startWorker, startSweep, lookup, oauth, row } = vi.hoisted(() => ({
  startWorker: vi.fn(), startSweep: vi.fn(), lookup: vi.fn(), oauth: vi.fn(),
  row: { method: "app" as "app" | "oauth_hook" | null },
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
  startReconciliationSweep: startSweep,
  sweepReconciliations: vi.fn(),
}));
vi.mock("@/lib/fold/abandoned-runs", () => ({ finalizeAbandonedRuns: async () => {} }));
vi.mock("@/lib/db/client", () => ({ getSql: vi.fn(), getCoordinationSql: vi.fn(), closeSql: vi.fn() }));
// Only traversal is replaced: environment parsing, JWT signing, installation
// lookup/mint, method routing, sponsor authentication and its journal are real.
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

const directory = mkdtempSync(join(tmpdir(), "reconciliation-app-keys-"));
const keyPath = join(directory, "app.pem");
writeFileSync(keyPath, generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" }));
const registrationToken = randomBytes(24).toString("base64url");
const reconciliationToken = randomBytes(24).toString("base64url");
const sponsorToken = randomBytes(24).toString("base64url");
let lookupStatus: number;
let requests: { method: string; path: string; issuer: string | null; authorization: string | null }[];

beforeEach(() => {
  vi.resetModules();
  startWorker.mockReset();
  startSweep.mockReset();
  row.method = "app";
  lookup.mockReset().mockImplementation(async () => row.method === null
    ? null : { id: "repository-1", registrationMethod: row.method });
  oauth.mockReset().mockResolvedValue(sponsorToken);
  vi.stubEnv("GITHUB_APP_ID", "101");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY_PATH", keyPath);
  vi.stubEnv("GITHUB_REGISTRATION_APP_ID", "202");
  vi.stubEnv("GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH", keyPath);
  lookupStatus = 200;
  requests = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const authorization = request.headers.get("authorization");
    const issuer = path.endsWith("/installation") || request.method === "POST"
      ? JSON.parse(Buffer.from(authorization!.split(".")[1]!, "base64url").toString()).iss as string
      : null;
    requests.push({ method: request.method, path, issuer, authorization });
    if (path.endsWith("/installation")) {
      return lookupStatus === 200
        ? Response.json({ id: issuer === "202" ? 22 : 11 })
        : new Response(null, { status: lookupStatus });
    }
    if (request.method === "POST") return Response.json({
      token: issuer === "202" ? registrationToken : reconciliationToken,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }, { status: 201 });
    return new Response(null, { status: 404 });
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { vi.resetModules(); rmSync(directory, { recursive: true }); });

it("routes the composite through a distinct injected registration-method lookup", async () => {
  row.method = "oauth_hook";
  const { createReconciliationAppTokenResolver } = await import("@/lib/github/reconciliation-app-auth");
  const injectedLookup = vi.fn(async () => "app" as const);
  const resolve = createReconciliationAppTokenResolver({
    lookupRegistrationMethod: injectedLookup,
    reconciliationResolver: async () => ({ token: reconciliationToken, installationId: 11 }),
    registrationResolver: async () => ({ token: registrationToken, installationId: 22 }),
  });

  await expect(resolve!("example/repository")).resolves.toEqual({
    token: registrationToken, installationId: 22, app: "registration",
  });
  expect(injectedLookup).toHaveBeenCalledExactlyOnceWith("example/repository");
  expect(lookup).not.toHaveBeenCalled();
});

it.each(["oauth_hook", null] as const)("names the reconciliation App in the composite result for method %s", async (method) => {
  const { createReconciliationAppTokenResolver } = await import("@/lib/github/reconciliation-app-auth");
  const resolve = createReconciliationAppTokenResolver({
    lookupRegistrationMethod: async () => method,
    reconciliationResolver: async () => ({ token: reconciliationToken, installationId: 11 }),
    registrationResolver: async () => ({ token: registrationToken, installationId: 22 }),
  });

  await expect(resolve!("example/repository")).resolves.toEqual({
    token: reconciliationToken, installationId: 11, app: "reconciliation",
  });
});

for (const wiring of ["worker", "cli"] as const) {
  describe(`${wiring} reconciliation App routing`, () => {
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

    function authPaths() {
      return vi.mocked(console.info).mock.calls.flatMap(([, payload]) =>
        payload && typeof payload === "object" && "authPath" in payload ? [payload] : []);
    }

    function appRequests() { return requests.filter(({ issuer }) => issuer !== null); }
    function readAuthorization() { return requests.find(({ path }) => path === "/repositories/4242")?.authorization; }

    it("uses only the registration App for an app row and journals its installation", async () => {
      await reconcile();
      expect(appRequests().map(({ issuer }) => issuer)).toEqual(["202", "202"]);
      expect(readAuthorization()).toBe(`Bearer ${registrationToken}`);
      expect(oauth).not.toHaveBeenCalled();
      expect(lookup).toHaveBeenCalledExactlyOnceWith("example/repository");
      expect(authPaths()).toEqual([{
        repositoryId: "repository-1", authPath: "registration-app-installation", installationId: 22,
      }]);
    });

    it.each(["oauth_hook", null] as const)("keeps the reconciliation App path for method %s", async (method) => {
      row.method = method;
      await reconcile();
      expect(appRequests().map(({ issuer }) => issuer)).toEqual(["101", "101"]);
      expect(readAuthorization()).toBe(`Bearer ${reconciliationToken}`);
      expect(oauth).not.toHaveBeenCalled();
      expect(authPaths()).toEqual([{
        repositoryId: "repository-1", authPath: "github-app-installation", installationId: 11,
      }]);
    });

    it.each(["oauth_hook", null] as const)("keeps the OAuth fallback after a reconciliation App 404 for method %s", async (method) => {
      row.method = method;
      lookupStatus = 404;
      await reconcile();
      expect(appRequests().map(({ issuer }) => issuer)).toEqual(["101"]);
      expect(readAuthorization()).toBe(`Bearer ${sponsorToken}`);
      expect(oauth).toHaveBeenCalledExactlyOnceWith("sponsor-1");
      expect(authPaths()).toEqual([{ repositoryId: "repository-1", authPath: "sponsor-oauth-fallback" }]);
    });

    it("falls back to OAuth when the registration App is unconfigured without trying the reconciliation App", async () => {
      vi.stubEnv("GITHUB_REGISTRATION_APP_ID", "");
      await reconcile();
      expect(appRequests()).toEqual([]);
      expect(readAuthorization()).toBe(`Bearer ${sponsorToken}`);
      expect(oauth).toHaveBeenCalledExactlyOnceWith("sponsor-1");
      expect(authPaths()).toEqual([{ repositoryId: "repository-1", authPath: "sponsor-oauth-fallback" }]);
    });

    it("leaves authentication unjournaled and skips lookup when both Apps are unconfigured", async () => {
      vi.stubEnv("GITHUB_APP_ID", "");
      vi.stubEnv("GITHUB_REGISTRATION_APP_ID", "");
      await reconcile();
      expect(appRequests()).toEqual([]);
      expect(readAuthorization()).toBe(`Bearer ${sponsorToken}`);
      expect(lookup).not.toHaveBeenCalled();
      expect(authPaths()).toEqual([]);
    });
  });
}
