import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { GitHubGateway } from "@/lib/github/client";
import { createAppRegistration } from "@/lib/github/app-registration";
import type { GitHubRepository } from "@/lib/github/types";
import { registerGitHubAppRepository } from "@/lib/repositories/github-registration-flow";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import {
  registerRepository, unregisterRepository, RepositoryOwnerNameConflictError,
  RepositoryRegistrationEnforcementError,
  type RepositoryRegistrationDependencies, type RepositoryRegistrationInput,
} from "@/lib/repositories/register";

vi.hoisted(() => { vi.resetModules(); });
let container: StartedTestContainer | undefined;
let sql: Sql;
let store: PostgresRepositoryStore;
let externalId = 9_920_000;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "app_registration", user: "app_registration" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  store = new PostgresRepositoryStore(sql, Buffer.alloc(32, 43).toString("base64url"));
});
afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
  vi.resetModules();
});

async function harness(permissions: { admin?: boolean } | null = { admin: true }) {
  const githubRepositoryId = externalId++;
  const ownerName = `app-owner/repo-${githubRepositoryId}`;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${externalId++}, ${`sponsor-${githubRepositoryId}`}) returning id
  `;
  const input: RepositoryRegistrationInput = {
    repositoryUrl: ownerName, registrationMethod: "app", openingName: "Scope", actualName: "Delivered",
    openingLabels: [{ label: "size/S", comparisonPoints: 2, reservePoints: 2 }],
    actualLabels: Array.from({ length: 10 }, (_, i) => ({ label: `done/${i + 1}`, points: i + 1 })),
  };
  const requests: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path === `/repos/${ownerName}`) return Response.json({
      id: githubRepositoryId, name: `repo-${githubRepositoryId}`, full_name: ownerName,
      private: false, html_url: `https://github.com/${ownerName}`, owner: { login: "app-owner", type: "User" },
      ...(permissions === null ? {} : { permissions }),
    });
    if (path === `/repos/${ownerName}/labels`) return Response.json(
      [...input.openingLabels, ...input.actualLabels].map(({ label }) => ({ name: label })),
    );
    if (path === `/repos/${ownerName}/contents/.github/workflows`) return Response.json([]);
    if (path === "/repos/Nitjsefnie-Actions/claim/git/matching-refs/tags/v") return Response.json([]);
    throw new Error(`Unexpected GitHub call: ${path}`);
  };
  const lookups: string[] = [];
  const imports: string[] = [];
  const dependencies: RepositoryRegistrationDependencies = {
    actor: { id: user!.id, role: "MEMBER", enforcementState: "ACTIVE" },
    github: new GitHubGateway({ accessToken: "synthetic-sponsor-token", fetch: transport }), store,
    registrationApp: { async lookupInstallation(ownerName) { lookups.push(ownerName); return { installationId: 321 }; } },
    async scheduleInitialImport(id) { imports.push(id); },
  };
  return { input, dependencies, requests, lookups, imports, githubRepositoryId, ownerName };
}

async function row(githubRepositoryId: number) {
  const rows = await sql`
    select registration_method, github_webhook_id, webhook_credential_id, encrypted_webhook_secret, active, unregistered_at
    from registered_repositories where github_repository_id = ${githubRepositoryId}
  `;
  return rows[0] ?? null;
}

describe("registration through the GitHub App", () => {
  it("stores a hookless App registration and retains label checks, initial import and claim-path assessment", async () => {
    const h = await harness();
    const result = await registerRepository(h.dependencies, h.input);
    expect(result).toMatchObject({ registrationMethod: "app", githubWebhookId: null, initialImportScheduled: true, claimPath: "NO_EVIDENCE_FOUND" });
    expect(await row(h.githubRepositoryId)).toMatchObject({ registration_method: "app", github_webhook_id: null,
      webhook_credential_id: null, encrypted_webhook_secret: null, active: true });
    expect(h.lookups).toEqual([h.ownerName]);
    expect(h.imports).toEqual([result.id]);
    expect(h.requests).toEqual([`GET /repos/${h.ownerName}`, `GET /repos/${h.ownerName}/labels`,
      `GET /repos/${h.ownerName}/contents/.github/workflows`,
      "GET /repos/Nitjsefnie-Actions/claim/git/matching-refs/tags/v"]);
  });

  it("refuses a repository without an installation before writing anything", async () => {
    const h = await harness();
    h.dependencies.registrationApp = { async lookupInstallation() { return null; } };
    await expect(registerRepository(h.dependencies, h.input)).rejects.toMatchObject({ code: "INVALID_INPUT",
      message: "Install the registration App on this repository first, then retry registration." });
    expect(await row(h.githubRepositoryId)).toBeNull();
    expect(h.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("refuses an unconfigured App as instance posture", async () => {
    const h = await harness();
    h.dependencies.registrationApp = null;
    await expect(registerRepository(h.dependencies, h.input)).rejects.toMatchObject({ code: "INVALID_INPUT",
      message: "Registration through the App is not available on this instance." });
    expect(await row(h.githubRepositoryId)).toBeNull();
  });

  it.each([
    { name: "absent permissions object", permissions: null },
    { name: "admin false", permissions: { admin: false } },
    { name: "absent admin flag", permissions: {} },
  ])("fails closed when GitHub reports $name", async ({ permissions }) => {
    const h = await harness(permissions);
    await expect(registerRepository(h.dependencies, h.input)).rejects.toMatchObject({ code: "FORBIDDEN",
      message: "GitHub did not report you as an administrator of this repository. Install the registration App on this repository and ensure you hold administrator permission, then retry registration." });
    expect(h.lookups).toEqual([]);
    expect(await row(h.githubRepositoryId)).toBeNull();
    expect(h.requests).toEqual([`GET /repos/${h.ownerName}`]);
  });

  it("rejects App registration for GitLab before resolving its identity", async () => {
    const h = await harness();
    await expect(registerRepository(h.dependencies, { ...h.input, provider: "gitlab" })).rejects.toMatchObject({
      code: "INVALID_INPUT", message: "Registration through the App is only available for GitHub repositories.",
    });
    expect(h.requests).toEqual([]);
    expect(await row(h.githubRepositoryId)).toBeNull();
  });

  it.each<{ status: number; headers: Record<string, string>; code: string; message: string }>([
    { status: 401, headers: {}, code: "GITHUB_CREDENTIALS",
      message: "GitHub rejected this instance's registration App credential (HTTP 401) while trying to check the registration App installation. Contact the instance operator to verify the registration App ID and private key, then retry registration." },
    { status: 403, headers: {}, code: "GITHUB_ACCESS",
      message: "GitHub refused to check the registration App installation (HTTP 403). GitHub answers 403 both when the registration App installation lookup is refused and when it is temporarily limiting requests, and this response carries nothing that separates the two causes. Wait a minute and retry registration before changing anything. If the refusal persists, contact the instance operator to check the registration App configuration and its installation on this repository." },
    { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "17" }, code: "GITHUB_RATE_LIMITED",
      message: "GitHub rate-limited the request to check the registration App installation (HTTP 403). Retry after 17 seconds. Please retry registration later." },
    { status: 429, headers: { "retry-after": "1" }, code: "GITHUB_RATE_LIMITED",
      message: "GitHub rate-limited the request to check the registration App installation (HTTP 429). Retry after 1 second. Please retry registration later." },
    { status: 429, headers: {}, code: "GITHUB_RATE_LIMITED",
      message: "GitHub rate-limited the request to check the registration App installation (HTTP 429). Please retry registration later." },
    { status: 404, headers: {}, code: "INVALID_INPUT",
      message: "Install the registration App on this repository first, then retry registration." },
    { status: 503, headers: {}, code: "UPSTREAM_FAILURE",
      message: "Unable to check the registration App installation on GitHub." },
  ])("gives the registration App remedy for installation HTTP $status with $headers before any write", async ({ status, headers, code, message }) => {
    const h = await harness();
    const requests: Request[] = [];
    h.dependencies.registrationApp = createAppRegistration({ config: { appId: "202", privateKey },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ message: "Installation lookup failed" }, { status, headers });
      },
    });
    const submitted = { owner: "app-owner", name: `repo-${h.githubRepositoryId}` };
    const repository: GitHubRepository = { ...submitted, id: h.githubRepositoryId, fullName: h.ownerName,
      ownerType: "ORGANIZATION", visibility: "PUBLIC", url: `https://github.com/${h.ownerName}`, canAdminister: true };
    const write = vi.spyOn(h.dependencies.store, "createRepository");
    try {
      const error = await registerGitHubAppRepository(h.dependencies, submitted, repository, h.input)
        .catch((error: unknown) => error);
      expect(write).not.toHaveBeenCalled();
      expect(await row(h.githubRepositoryId)).toBeNull();
      expect(h.requests).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(`https://api.github.com/repos/${h.ownerName}/installation`);
      expect(requests[0]!.method).toBe("GET");
      expect(requests[0]!.headers.get("authorization")).toMatch(/^Bearer ey/);
      expect(error).toMatchObject({ code, message });
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    { name: "owner-name arbiter", failure: new RepositoryOwnerNameConflictError("claimed/repo"), code: "CONFLICT" },
    { name: "enforcement recheck", failure: new RepositoryRegistrationEnforcementError(), code: "FORBIDDEN" },
    { name: "store outage", failure: new Error("synthetic store outage"), code: "UPSTREAM_FAILURE" },
    { name: "numeric-id arbiter", failure: null, code: "CONFLICT" },
  ])("retains the $name refusal without webhook rollback", async ({ failure, code }) => {
    const h = await harness();
    const localStore = new PostgresRepositoryStore(sql, Buffer.alloc(32, 43).toString("base64url"));
    localStore.createRepository = async () => { if (failure !== null) throw failure; return null; };
    h.dependencies.store = localStore;
    await expect(registerRepository(h.dependencies, h.input)).rejects.toMatchObject({ code,
      ...(code === "UPSTREAM_FAILURE" ? { message: "Unable to save the repository registration." } : {}),
    });
    expect(await row(h.githubRepositoryId)).toBeNull();
    expect(h.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("retains the conflict guard and reactivation path", async () => {
    const h = await harness();
    const created = await registerRepository(h.dependencies, h.input);
    await expect(registerRepository(h.dependencies, h.input)).rejects.toMatchObject({ code: "CONFLICT" });
    await unregisterRepository(h.dependencies, { repositoryUrl: h.ownerName });
    await expect(registerRepository(h.dependencies, h.input)).resolves.toMatchObject({ id: created.id, registrationMethod: "app" });
  });

  it("deactivates and scrubs an App row with no GitHub calls and returns installation-management guidance", async () => {
    const h = await harness();
    const created = (await store.createRepository({ githubRepositoryId: h.githubRepositoryId, ownerName: h.ownerName,
      sponsorId: h.dependencies.actor.id, visibility: "PUBLIC", registrationMethod: "app", githubWebhookId: null,
      webhookCredential: null, difficultyScheme: h.input }))!;
    await sql`insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state, opening_label, opening_comparison_points, opening_reserve_points)
      values (${externalId++}, ${created.id}, 1, 'A title', 'cached issue text', ${`https://github.com/${h.ownerName}/issues/1`}, 'OPEN', 'size/S', 2, 2)`;
    // Even a retained old hook must not cause a GitHub call during App unregistration.
    await store.saveAbandonedWebhookCleanup({ githubRepositoryId: h.githubRepositoryId, ownerName: h.ownerName,
      webhookId: externalId++, provider: "github", instanceUrl: null, createdAt: new Date().toISOString() });
    h.requests.length = 0;
    for (const alreadyUnregistered of [false, true]) {
      const result = await unregisterRepository(h.dependencies, { repositoryUrl: h.ownerName });
      expect(result).toMatchObject({ webhookDeleted: false, alreadyUnregistered,
        appAccessRemains: { message: "The GitHub App still has access to this repository. Manage its access in your GitHub installation settings.",
          url: "https://github.com/settings/installations" } });
    }
    expect(h.requests).toEqual([]);
    expect(await row(h.githubRepositoryId)).toMatchObject({ active: false, unregistered_at: expect.any(Date) });
    expect(await sql`select body from issues where repository_id = ${created.id}`).toEqual([{ body: null }]);
    expect(await store.listAbandonedWebhookCleanups()).toEqual([expect.objectContaining({ githubRepositoryId: h.githubRepositoryId })]);
  });
});
