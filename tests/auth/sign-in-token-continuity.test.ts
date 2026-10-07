import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { shouldKeepStoredGitHubToken, upsertGitHubAccount } from "@/lib/auth/account-store";
import { upsertGitHubIdentity } from "@/auth";
import { requireWebhookAdministration } from "@/lib/auth/github-granted-scopes";
import { credentialBinding, decryptToken, encryptToken } from "@/lib/security/token-cipher";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";
import type { GitHubIdentity } from "@/lib/auth/sign-in-decision";

// src/auth.ts builds its NextAuth instance at import; the instance is stubbed
// so the storage path under test — upsertGitHubIdentity — stays real.
vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));
vi.mock("next-auth/providers/github", () => ({
  default: vi.fn(() => ({ id: "github" })),
}));

let sql: Sql;
let container: StartedTestContainer | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalTokenKey = process.env.TOKEN_ENCRYPTION_KEY;
// 43 base64url characters decode to exactly 32 bytes.
const TOKEN_KEY = "A".repeat(43);

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "signin_token_continuity_test",
    user: "signin_token_continuity_test",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  process.env.TOKEN_ENCRYPTION_KEY = TOKEN_KEY;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalTokenKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = originalTokenKey;
  // The "@/auth" graph keeps this file's NextAuth stub until cleared.
  vi.resetModules();
});

let externalId = 9_950_000;
function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

const wideToken = "stored-wide-token-admin-repo-hook";
const narrowToken = "fresh-contributor-token";

function identityFor(githubUserId: number): GitHubIdentity {
  return {
    githubUserId,
    login: `user-${githubUserId}`,
    avatarUrl: `https://avatars.example/${githubUserId}.png`,
  };
}

function encryptFor(githubUserId: number, plaintext: string): Buffer {
  return Buffer.from(encryptToken(plaintext, TOKEN_KEY, credentialBinding.userOAuthToken(githubUserId)), "utf8");
}

async function seedAccount(githubUserId: number, token: string): Promise<{ sponsorId: string; seededBytes: Buffer }> {
  const seededBytes = encryptFor(githubUserId, token);
  const user = await upsertGitHubAccount({
    githubUserId,
    login: `stale-${githubUserId}`,
    avatarUrl: "https://avatars.example/stale.png",
    role: "MEMBER",
    encryptedAccessToken: seededBytes,
  }, sql);
  return { sponsorId: user.id, seededBytes };
}

async function storedTokenRow(githubUserId: number): Promise<{
  bytes: Buffer | null;
  token: string | null;
  login: string;
  avatarUrl: string | null;
}> {
  const [row] = await sql<{ encrypted_oauth_token: Buffer | null; github_login: string; avatar_url: string | null }[]>`
    select encrypted_oauth_token, github_login, avatar_url
    from users
    where github_user_id = ${githubUserId}
  `;
  expect(row).toBeDefined();
  const bytes = row!.encrypted_oauth_token;
  return {
    bytes,
    token: bytes === null
      ? null
      : decryptToken(bytes.toString("utf8"), { current: TOKEN_KEY }, credentialBinding.userOAuthToken(githubUserId)),
    login: row!.github_login,
    avatarUrl: row!.avatar_url,
  };
}

/** One active registration sponsored by this user row: the ruling's condition. */
async function sponsorRepository(sponsorId: string): Promise<void> {
  const repositoryGithubId = nextExternalId();
  await sql`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values (
      ${repositoryGithubId}, ${`owner-${repositoryGithubId}/repo`}, ${sponsorId}, 'PUBLIC',
      ${repositoryGithubId + 900_000}, ${sql.json(validDifficultyScheme())}
    )
  `;
}

// The GitHub double: a GET /user whose X-OAuth-Scopes header is exactly the
// one GitHub sends for that sign-in kind.
const userResponse = (scopes: string | null, status = 200): Response =>
  new Response(JSON.stringify({ id: 1, login: "octocat" }), {
    status,
    headers: scopes === null
      ? { "content-type": "application/json" }
      : { "content-type": "application/json", "x-oauth-scopes": scopes },
  });

/** The contributor sign-in: GitHub grants no scopes, so the header is empty. */
const contributorSignIn: typeof fetch = async () => userResponse("");
/** The repository-registration sign-in: GitHub grants webhook administration. */
const registrationSignIn: typeof fetch = async () => userResponse("admin:repo_hook, repo");
/** GitHub answers the probe with a server error. */
const probe500: typeof fetch = async () => userResponse(null, 500);
/** The transport itself fails under the probe. */
const probeTransportDown: typeof fetch = async () => {
  throw new Error("transport refused the connection");
};

describe("sign-in token continuity in the storage path (issue 1154)", () => {
  it("keeps the sponsor's stored token when a contributor sign-in would overwrite it", async () => {
    const githubUserId = nextExternalId();
    const { sponsorId, seededBytes } = await seedAccount(githubUserId, wideToken);
    await sponsorRepository(sponsorId);

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, contributorSignIn);

    const stored = await storedTokenRow(githubUserId);
    // The stored bytes stay the injected existing token's, and the stored
    // VALUE decrypts to the kept token — not to the narrow new one.
    expect(stored.bytes).toEqual(seededBytes);
    expect(stored.token).toBe(wideToken);
    // The login and avatar still update while the token bytes stay.
    expect(stored.login).toBe(identityFor(githubUserId).login);
    expect(stored.avatarUrl).toBe(identityFor(githubUserId).avatarUrl);
  });

  it("stores the narrow token when the account sponsors no registered repository", async () => {
    const githubUserId = nextExternalId();
    await seedAccount(githubUserId, wideToken);

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, contributorSignIn);

    expect((await storedTokenRow(githubUserId)).token).toBe(narrowToken);
  });

  it("stores the new token when the sign-in itself carries webhook administration", async () => {
    const githubUserId = nextExternalId();
    const { sponsorId } = await seedAccount(githubUserId, narrowToken);
    await sponsorRepository(sponsorId);

    await upsertGitHubIdentity(identityFor(githubUserId), wideToken, registrationSignIn);

    expect((await storedTokenRow(githubUserId)).token).toBe(wideToken);
  });

  it("keeps the stored token when the scope probe fails (fail-safe)", async () => {
    for (const failingProbe of [probe500, probeTransportDown]) {
      const githubUserId = nextExternalId();
      const { sponsorId } = await seedAccount(githubUserId, wideToken);
      await sponsorRepository(sponsorId);

      await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, failingProbe);

      expect((await storedTokenRow(githubUserId)).token).toBe(wideToken);
    }
  });

  it("stores a first token for an account with nothing stored yet and never probes", async () => {
    const githubUserId = nextExternalId();
    const probeDouble = vi.fn<typeof fetch>(async () => userResponse(""));

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, probeDouble);

    expect(probeDouble).not.toHaveBeenCalled();
    expect((await storedTokenRow(githubUserId)).token).toBe(narrowToken);
  });

  it("leaves the webhook-repair precondition holding against the kept token", async () => {
    const githubUserId = nextExternalId();
    const { sponsorId } = await seedAccount(githubUserId, wideToken);
    await sponsorRepository(sponsorId);

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, contributorSignIn);

    const kept = (await storedTokenRow(githubUserId)).token;
    expect(kept).toBe(wideToken);
    // The precondition the registration route spends before a webhook repair
    // holds against the token continuity kept: it still administers webhooks.
    await expect(requireWebhookAdministration(kept!, registrationSignIn)).resolves.toEqual([
      "admin:repo_hook",
      "repo",
    ]);
  });
});

describe("shouldKeepStoredGitHubToken", () => {
  const storedBytes = Buffer.from("stored-envelope", "utf8");

  it.each([
    {
      label: "the incident: a scope-less new token for a sponsoring account with a stored token",
      existingToken: storedBytes,
      granted: [] as string[],
      probesFailed: false,
      sponsors: true,
      keep: true,
    },
    {
      label: "no stored token — nothing to protect",
      existingToken: null,
      granted: [],
      probesFailed: false,
      sponsors: true,
      keep: false,
    },
    {
      label: "no active registration — least privilege applies",
      existingToken: storedBytes,
      granted: [],
      probesFailed: false,
      sponsors: false,
      keep: false,
    },
    {
      label: "the new token itself administers webhooks (admin:repo_hook)",
      existingToken: storedBytes,
      granted: ["admin:repo_hook"],
      probesFailed: false,
      sponsors: true,
      keep: false,
    },
    {
      label: "the new token administers webhooks through repo",
      existingToken: storedBytes,
      granted: ["repo"],
      probesFailed: false,
      sponsors: true,
      keep: false,
    },
    {
      label: "the new token administers webhooks through public_repo",
      existingToken: storedBytes,
      granted: ["public_repo"],
      probesFailed: false,
      sponsors: true,
      keep: false,
    },
    {
      label: "write:repo_hook cannot administer webhooks",
      existingToken: storedBytes,
      granted: ["write:repo_hook"],
      probesFailed: false,
      sponsors: true,
      keep: true,
    },
    {
      label: "a failed probe keeps the token (fail-safe continuity)",
      existingToken: storedBytes,
      granted: [],
      probesFailed: true,
      sponsors: true,
      keep: true,
    },
    {
      label: "a failed probe without a registration stores the new token",
      existingToken: storedBytes,
      granted: [],
      probesFailed: true,
      sponsors: false,
      keep: false,
    },
  ])("$label", ({ existingToken, granted, probesFailed, sponsors, keep }) => {
    expect(shouldKeepStoredGitHubToken({
      existingToken,
      newTokenGrantedScopes: granted,
      probesFailed,
      sponsorsRegisteredRepository: sponsors,
    })).toBe(keep);
  });
});
