import { describe, expect, it } from "vitest";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { GitHubGateway } from "@/lib/github/client";
import {
  RepositorySchemeChangeForbiddenError,
  RepositorySchemeChangeOrderError,
  changeRepositoryCatalog,
  type RegisteredRepository,
  type RepositoryCatalogChange,
  type RepositoryRegistrationDependencies,
  type RepositoryRegistrationInput,
  type RepositoryRegistrationStore,
} from "@/lib/repositories/register";

/**
 * The GitLab catalog-change path (issue 548): a PATCH carrying the same body a
 * GitLab registration takes must resolve through the sponsor's linked identity,
 * verify the labels on the GitLab project, and append the next catalog version
 * exactly as the GitHub path does. Every case here is end-to-end through the
 * real GitLabGateway over an injectable transport, mirroring the registration
 * suite's harness (register-gitlab.test.ts).
 */

const project = {
  id: 278964,
  name: "gitlab",
  path: "gitlab",
  path_with_namespace: "gitlab-org/gitlab",
  visibility: "public",
  web_url: "https://gitlab.com/gitlab-org/gitlab",
  namespace: { id: 1, name: "GitLab.org", path: "gitlab-org", kind: "group" },
  permissions: { project_access: { access_level: 40 } },
};

const scheme = validDifficultyScheme();
const labelsFixture = [
  ...scheme.openingLabels.map((entry) => entry.label),
  ...scheme.actualLabels.map((entry) => entry.label),
];

function input(overrides: Partial<RepositoryRegistrationInput> = {}): RepositoryRegistrationInput {
  return {
    repositoryUrl: "https://gitlab.com/gitlab-org/gitlab",
    openingName: scheme.openingName,
    actualName: scheme.actualName,
    openingLabels: scheme.openingLabels,
    actualLabels: scheme.actualLabels,
    provider: "gitlab",
    instanceUrl: "https://gitlab.com",
    project: "gitlab-org/gitlab",
    ...overrides,
  };
}

function registeredRow(): RegisteredRepository {
  return {
    id: "repo-row-1",
    githubRepositoryId: 278964,
    ownerName: "gitlab-org/gitlab",
    sponsorId: "sponsor-1",
    visibility: "PUBLIC",
    githubWebhookId: null,
  };
}

function fixture(options: {
  linkedIdentity?: { instanceUrl: string; token: string } | null;
  registeredRow?: RegisteredRepository | null;
  storedProvider?: string | null;
  /** Merged over the served project payload, so a case varies exactly the fields its refusal is about. */
  projectOverrides?: Record<string, unknown>;
  /** Replaces the append's outcome: a result, null, or a thrown error. */
  appendOutcome?: () => Promise<RepositoryCatalogChange | null>;
} = {}) {
  const calls: { op: string; args: unknown }[] = [];
  const requests: string[] = [];
  const row = options.registeredRow === undefined ? registeredRow() : options.registeredRow;

  const store = {
    async findRepositoryByGitHubId() {
      return row;
    },
    async findRepositoryProviderById() {
      return options.storedProvider === undefined ? "gitlab" : options.storedProvider;
    },
    async findRepositoryRegistrationState() {
      return null;
    },
    async createRepository() {
      calls.push({ op: "createRepository", args: null });
      throw new Error("a catalog change never creates a registration row");
    },
    async appendDifficultySchemeVersion(args: {
      githubRepositoryId: number;
      sponsorId: string;
      scheme: unknown;
      effectiveFrom: Date;
    }) {
      calls.push({ op: "appendDifficultySchemeVersion", args });
      if (options.appendOutcome !== undefined) {
        return options.appendOutcome();
      }
      return { changed: true, versionNumber: 3, effectiveFrom: "2026-09-11T00:00:00.000Z" };
    },
  } as unknown as RepositoryRegistrationStore;

  const gitlabFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.url);
    // Host-sensitive by construction: a gateway built on any other instance
    // must not be able to satisfy the lookup through this transport.
    if (new URL(request.url).origin !== "https://gitlab.com") {
      return new Response("wrong instance", { status: 404 });
    }
    if (request.url.includes("/labels")) {
      return new Response(JSON.stringify(labelsFixture.map((name) => ({ name }))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (request.url.includes("/projects/gitlab-org%2Fgitlab")) {
      return new Response(JSON.stringify({ ...project, ...options.projectOverrides }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (request.url.includes("/projects/278964")) {
      return new Response(JSON.stringify({ ...project, ...options.projectOverrides }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("no route", { status: 404 });
  };

  const dependencies: RepositoryRegistrationDependencies = {
    actor: { id: "sponsor-1", role: "MEMBER" },
    github: new GitHubGateway({ accessToken: "gho-unused", fetch: async () => {
      throw new Error("the GitHub gateway must not be called on the GitLab path");
    } }),
    store,
    webhook: { callbackUrl: "https://overflow.example/api/github/webhooks", secret: "s3cret" },
    forgeFetch: gitlabFetch,
    forgeIdentity: options.linkedIdentity === undefined
      ? { instanceUrl: "https://gitlab.com", token: "glpat-live" }
      : options.linkedIdentity,
  };
  return { dependencies, calls, requests };
}

function appendCall(calls: { op: string; args: unknown }[]) {
  const call = calls.find((entry) => entry.op === "appendDifficultySchemeVersion");
  expect(call).toBeDefined();
  return call!.args as {
    githubRepositoryId: number;
    sponsorId: string;
    scheme: typeof scheme;
    effectiveFrom: Date;
  };
}

describe("changing a registered GitLab project's catalog (PATCH)", () => {
  it("appends the next catalog version through the linked identity, exactly as the GitHub path does", async () => {
    const f = fixture();
    const change = await changeRepositoryCatalog(f.dependencies, input());

    expect(change).toMatchObject({
      changed: true,
      versionNumber: 3,
      effectiveFrom: "2026-09-11T00:00:00.000Z",
      repository: {
        id: "repo-row-1",
        githubRepositoryId: 278964,
        ownerName: "gitlab-org/gitlab",
      },
    });
    const args = appendCall(f.calls);
    expect(args.githubRepositoryId).toBe(278964);
    expect(args.sponsorId).toBe("sponsor-1");
    expect(args.scheme).toEqual(scheme);
    expect(args.effectiveFrom).toBeInstanceOf(Date);
    // The change appends; nothing on the registration side is ever written.
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("resolves a numeric project id through the same linked identity", async () => {
    const f = fixture();
    const change = await changeRepositoryCatalog(f.dependencies, input({ project: "278964" }));

    expect(change).toMatchObject({
      changed: true,
      versionNumber: 3,
      repository: { githubRepositoryId: 278964 },
    });
    expect(appendCall(f.calls).githubRepositoryId).toBe(278964);
    expect(f.requests.some((url) => url.includes("/projects/278964"))).toBe(true);
    // The labels read addresses the project by its path (that URL necessarily
    // carries the path-encoded segment), but the project lookup itself went by
    // id — no path-addressed project read happened.
    expect(f.requests.filter((url) => url.includes("/projects/gitlab-org%2Fgitlab")).every((url) => url.includes("/labels"))).toBe(true);
  });

  it("answers an idempotent repeat (changed: false) carrying the registered repository", async () => {
    const f = fixture({
      appendOutcome: async () => ({ changed: false, versionNumber: null, effectiveFrom: null }),
    });
    const change = await changeRepositoryCatalog(f.dependencies, input());

    expect(change).toMatchObject({
      changed: false,
      versionNumber: null,
      effectiveFrom: null,
      repository: { id: "repo-row-1" },
    });
  });

  it("refuses a GitLab submission without the forge fields", async () => {
    const f = fixture();
    await expect(changeRepositoryCatalog(f.dependencies, input({ instanceUrl: undefined }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "A GitLab catalog change requires the instance URL and the project id or path.",
    });
    await expect(changeRepositoryCatalog(f.dependencies, input({ project: undefined }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "A GitLab catalog change requires the instance URL and the project id or path.",
    });
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
  });

  it("rejects a malformed numeric project id before any gateway call", async () => {
    const f = fixture();
    await expect(changeRepositoryCatalog(f.dependencies, input({ project: "0" }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "The GitLab project id must be a positive integer.",
    });
    await expect(changeRepositoryCatalog(f.dependencies, input({ project: "-4" }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      // "-4" is not all-digits, so it takes the path branch: the path-shaped
      // refusal, exactly as registration answers the same submission.
      message: "Submit the GitLab project as a positive numeric id or a path with namespace.",
    });
    await expect(changeRepositoryCatalog(f.dependencies, input({ project: "12abc" }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Submit the GitLab project as a positive numeric id or a path with namespace.",
    });
    expect(f.requests).toEqual([]);
  });

  it("refuses when the submitter has no verified identity on the instance", async () => {
    const f = fixture({ linkedIdentity: null });
    const error = await changeRepositoryCatalog(f.dependencies, input()).catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
    });
    expect((error as Error).message).toContain("verified GitLab identity linked to this instance");
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
    // The identity is the gateway credential: without it no project read happens either.
    expect(f.requests).toEqual([]);
  });

  it("refuses when the linked identity is for a different instance", async () => {
    const f = fixture({ linkedIdentity: { instanceUrl: "https://other.example.com", token: "glpat-x" } });
    await expect(changeRepositoryCatalog(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
    });
    expect(f.requests).toEqual([]);
  });

  it("refuses with NOT_FOUND when the project id is unreachable through the linked PAT", async () => {
    const f = fixture();
    // The fixture's transport answers 404 for any id other than 278964, so a
    // numeric id nothing vouches for refuses before any store write.
    await expect(changeRepositoryCatalog(f.dependencies, input({ project: "99999999" }))).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "NOT_FOUND",
      message: "No GitLab project with that id is visible through the linked identity.",
    });
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
  });

  it("refuses a private project as FORBIDDEN before anything is appended", async () => {
    const f = fixture({ projectOverrides: { visibility: "private" } });
    await expect(changeRepositoryCatalog(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "Only public GitLab projects can keep a registered difficulty catalog.",
    });
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
  });

  it("refuses an internal project with the same refusal — the gateway maps internal to PRIVATE", async () => {
    const f = fixture({ projectOverrides: { visibility: "internal" } });
    await expect(changeRepositoryCatalog(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "Only public GitLab projects can keep a registered difficulty catalog.",
    });
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
  });

  it("refuses a project the linked identity cannot maintain", async () => {
    const f = fixture({ projectOverrides: { permissions: { project_access: { access_level: 30 } } } });
    await expect(changeRepositoryCatalog(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "GitLab maintainer permission is required for the submitted project.",
    });
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
  });

  it("refuses a project whose forge id no registration holds", async () => {
    const f = fixture({ registeredRow: null });
    await expect(changeRepositoryCatalog(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "CONFLICT",
      message: "This GitLab project is not registered, so there is no catalog to change.",
    });
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
  });

  it("refuses a GitLab-shaped body whose forge id belongs to a GitHub registration", async () => {
    // Never let a GitLab-shaped body move a GitHub row: the stored provider is
    // the row's forge identity, and a catalog change cannot migrate it.
    const f = fixture({ storedProvider: "github" });
    const error = await changeRepositoryCatalog(f.dependencies, input()).catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: "RepositoryRegistrationError",
      code: "CONFLICT",
    });
    expect((error as Error).message).toMatch(/collides with forge id .* provider 'github'/);
    expect((error as Error).message).toContain("catalog change refused");
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
  });

  it("answers the sponsor refusal before any label request", async () => {
    const f = fixture({ registeredRow: { ...registeredRow(), sponsorId: "someone-else" } });
    const error = await changeRepositoryCatalog(f.dependencies, input()).catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "Only the repository's sponsor can change its difficulty catalog.",
    });
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
    expect(f.requests.some((url) => url.includes("/labels"))).toBe(false);
  });

  it("refuses naming every scheme label the project is missing, with the catalog-change remedy", async () => {
    const f = fixture();
    f.requests.length = 0;
    // Replace the transport so the labels route serves nothing.
    const originalFetch = f.dependencies.forgeFetch;
    f.dependencies.forgeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/labels")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return originalFetch!(input, init);
    };
    const error = await changeRepositoryCatalog(f.dependencies, input()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    const message = (error as Error).message;
    expect(message).toContain("The GitLab project does not carry these labels:");
    expect(message).toContain("S");
    expect(message).toContain("M");
    expect(message).toContain("L");
    expect(message).toContain("delivered/1");
    expect(message).toContain("delivered/10");
    expect(message).toContain("Create them, then retry the catalog change.");
    expect(f.calls.some((call) => call.op === "appendDifficultySchemeVersion")).toBe(false);
  });

  it("surfaces a store sponsor refusal as FORBIDDEN", async () => {
    const f = fixture({
      appendOutcome: async () => {
        throw new RepositorySchemeChangeForbiddenError(278964);
      },
    });
    await expect(changeRepositoryCatalog(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "Only the repository's sponsor can change its difficulty catalog.",
    });
  });

  it("surfaces a store ordering refusal as CONFLICT with the retry remedy", async () => {
    const f = fixture({
      appendOutcome: async () => {
        throw new RepositorySchemeChangeOrderError(278964);
      },
    });
    await expect(changeRepositoryCatalog(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "CONFLICT",
      message: "The catalog change could not be recorded: its effective instant precedes the version before it. Retry the change.",
    });
  });

  it("maps a store save failure to UPSTREAM_FAILURE and exposes nothing of the store error", async () => {
    const f = fixture({
      appendOutcome: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(changeRepositoryCatalog(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "UPSTREAM_FAILURE",
      message: "Unable to save the difficulty catalog change.",
    });
  });

  it("answers the not-registered conflict when the append finds no row at write time", async () => {
    const f = fixture({ appendOutcome: async () => null });
    await expect(changeRepositoryCatalog(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "CONFLICT",
      message: "This GitLab project is not registered, so there is no catalog to change.",
    });
  });
});
