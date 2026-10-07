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
const originalPreviousKey = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
// Two distinct 32-byte keys, encoded canonically (the same shape
// tests/security/github-oauth-scope.test.ts uses).
const TOKEN_KEY = Buffer.alloc(32, 1).toString("base64url");
const PREVIOUS_KEY = Buffer.alloc(32, 2).toString("base64url");

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "signin_token_continuity_test",
    user: "signin_token_continuity_test",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  process.env.TOKEN_ENCRYPTION_KEY = TOKEN_KEY;
  // A rotation window: the previous key still opens what it sealed.
  process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = PREVIOUS_KEY;
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
  if (originalPreviousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  else process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = originalPreviousKey;
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

function encryptFor(githubUserId: number, plaintext: string, key: string = TOKEN_KEY): Buffer {
  return Buffer.from(encryptToken(plaintext, key, credentialBinding.userOAuthToken(githubUserId)), "utf8");
}

async function seedAccount(
  githubUserId: number,
  token: string,
  key: string = TOKEN_KEY,
): Promise<{ sponsorId: string; seededBytes: Buffer }> {
  return seedAccountBytes(githubUserId, encryptFor(githubUserId, token, key));
}

/** Plants stored bytes verbatim — for an envelope no configured key can open. */
async function seedAccountBytes(githubUserId: number, encryptedAccessToken: Buffer): Promise<{ sponsorId: string; seededBytes: Buffer }> {
  const user = await upsertGitHubAccount({
    githubUserId,
    login: `stale-${githubUserId}`,
    avatarUrl: "https://avatars.example/stale.png",
    role: "MEMBER",
    encryptedAccessToken,
  }, sql);
  return { sponsorId: user.id, seededBytes: encryptedAccessToken };
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
      : decryptToken(bytes.toString("utf8"), { current: TOKEN_KEY, previous: PREVIOUS_KEY }, credentialBinding.userOAuthToken(githubUserId)),
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

/**
 * A GET /user double answering per bearer token: the continuity ruling probes
 * TWO live-seeming tokens in one sign-in (the new one, then the stored one),
 * and GitHub answers each with its own X-OAuth-Scopes header — or with its
 * own failure. Keys are the bearer tokens; a token with no entry fails the
 * call the way an unscripted transport would.
 */
function perTokenProbe(table: Record<string, () => Response>): typeof fetch {
  return async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const answer = table[authorization.slice("Bearer ".length)];
    if (answer === undefined) {
      throw new Error(`no scripted GET /user answer for this bearer token`);
    }
    return answer();
  };
}

/**
 * The incident's healthiest shape: the stored token is hook-capable, the new
 * contributor sign-in grants nothing. Continuity keeps the stored token only
 * through the stored probe answering with its administration scopes.
 */
const capableStoredNarrowNew: typeof fetch = perTokenProbe({
  [wideToken]: () => userResponse("admin:repo_hook, repo"),
  [narrowToken]: () => userResponse(""),
});

describe("sign-in token continuity in the storage path (issue 1154)", () => {
  it("keeps the sponsor's stored token when a contributor sign-in would overwrite it", async () => {
    const githubUserId = nextExternalId();
    const { sponsorId, seededBytes } = await seedAccount(githubUserId, wideToken);
    await sponsorRepository(sponsorId);

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, capableStoredNarrowNew);

    const stored = await storedTokenRow(githubUserId);
    // The stored bytes stay the injected existing token's, and the stored
    // VALUE decrypts to the kept token — not to the narrow new one. The kept
    // token itself answered its own probe with webhook administration.
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
    const probeDouble = vi.fn<typeof fetch>(registrationSignIn);

    await upsertGitHubIdentity(identityFor(githubUserId), wideToken, probeDouble);

    expect((await storedTokenRow(githubUserId)).token).toBe(wideToken);
    // The stored probe is spent only when keeping is otherwise reachable: a
    // capable new sign-in ends the question with the one probe it needed.
    expect(probeDouble).toHaveBeenCalledTimes(1);
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

  it.each([401, 404])("stores the new token when the stored token answers %i (revoked)", async (status) => {
    const githubUserId = nextExternalId();
    const { sponsorId } = await seedAccount(githubUserId, wideToken);
    await sponsorRepository(sponsorId);
    // GitHub answers the STORED token as revoked and the new contributor
    // token with no scopes: nothing is gained by keeping the dead token.
    const revokedStored: typeof fetch = perTokenProbe({
      [wideToken]: () => userResponse(null, status),
      [narrowToken]: () => userResponse(""),
    });

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, revokedStored);

    expect((await storedTokenRow(githubUserId)).token).toBe(narrowToken);
  });

  it("stores the new token when the stored token answers without webhook administration", async () => {
    const githubUserId = nextExternalId();
    const { sponsorId } = await seedAccount(githubUserId, wideToken);
    await sponsorRepository(sponsorId);
    // Both tokens answer live but narrow: the stored one cannot serve the
    // repositories either, so least privilege stores the new token.
    const bothNarrow: typeof fetch = perTokenProbe({
      [wideToken]: () => userResponse(""),
      [narrowToken]: () => userResponse(""),
    });

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, bothNarrow);

    expect((await storedTokenRow(githubUserId)).token).toBe(narrowToken);
  });

  it("keeps a previous-key-sealed stored token that still answers capable", async () => {
    const githubUserId = nextExternalId();
    // Sealed under the previous key during a rotation window: every other
    // reader of the column still opens it, and so must the probe.
    const previousSealedToken = "stored-previous-key-token";
    const { sponsorId, seededBytes } = await seedAccount(githubUserId, previousSealedToken, PREVIOUS_KEY);
    await sponsorRepository(sponsorId);
    const previousCapable: typeof fetch = perTokenProbe({
      [previousSealedToken]: () => userResponse("admin:repo_hook, repo"),
      [narrowToken]: () => userResponse(""),
    });

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, previousCapable);

    const stored = await storedTokenRow(githubUserId);
    expect(stored.bytes).toEqual(seededBytes);
    expect(stored.token).toBe(previousSealedToken);
  });

  it("stores the new token when the stored envelope cannot be decrypted at all", async () => {
    const githubUserId = nextExternalId();
    // Bytes no configured key can open: there is no usable token to protect,
    // so the probe reads the stored token as not answerable and the new one
    // is stored.
    const { sponsorId } = await seedAccountBytes(githubUserId, Buffer.from("not-an-envelope", "utf8"));
    await sponsorRepository(sponsorId);

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, contributorSignIn);

    expect((await storedTokenRow(githubUserId)).token).toBe(narrowToken);
  });

  it("keeps the stored token when its own probe transport fails (fail-safe)", async () => {
    const githubUserId = nextExternalId();
    const { sponsorId } = await seedAccount(githubUserId, wideToken);
    await sponsorRepository(sponsorId);
    // The NEW token's probe answers (narrow); the STORED token's probe never
    // settles. Unknown is keep: the unchanged fail-safe direction.
    const storedTransportDown: typeof fetch = perTokenProbe({
      [wideToken]: () => {
        throw new Error("transport refused the connection");
      },
      [narrowToken]: () => userResponse(""),
    });

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, storedTransportDown);

    expect((await storedTokenRow(githubUserId)).token).toBe(wideToken);
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

    await upsertGitHubIdentity(identityFor(githubUserId), narrowToken, capableStoredNarrowNew);

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
      label: "the incident, with the stored token provably still capable",
      existingToken: storedBytes,
      granted: [] as string[],
      probesFailed: false,
      sponsors: true,
      storedProbe: "capable" as const,
      keep: true,
    },
    {
      label: "the incident, with the stored token's probe unanswered (fail-safe)",
      existingToken: storedBytes,
      granted: [],
      probesFailed: false,
      sponsors: true,
      storedProbe: "unanswered" as const,
      keep: true,
    },
    {
      label: "the stored token answered revoked — the new token is stored instead",
      existingToken: storedBytes,
      granted: [],
      probesFailed: false,
      sponsors: true,
      storedProbe: "notCapable" as const,
      keep: false,
    },
    {
      label: "the stored token was never probed (keeping unreachable earlier)",
      existingToken: storedBytes,
      granted: [],
      probesFailed: false,
      sponsors: true,
      storedProbe: null,
      keep: false,
    },
    {
      label: "no stored token — nothing to protect",
      existingToken: null,
      granted: [],
      probesFailed: false,
      sponsors: true,
      storedProbe: "notCapable" as const,
      keep: false,
    },
    {
      label: "no active registration — least privilege applies",
      existingToken: storedBytes,
      granted: [],
      probesFailed: false,
      sponsors: false,
      storedProbe: "notCapable" as const,
      keep: false,
    },
    {
      label: "the new token itself administers webhooks (admin:repo_hook)",
      existingToken: storedBytes,
      granted: ["admin:repo_hook"],
      probesFailed: false,
      sponsors: true,
      storedProbe: "notCapable" as const,
      keep: false,
    },
    {
      label: "the new token administers webhooks through repo",
      existingToken: storedBytes,
      granted: ["repo"],
      probesFailed: false,
      sponsors: true,
      storedProbe: "notCapable" as const,
      keep: false,
    },
    {
      label: "the new token administers webhooks through public_repo",
      existingToken: storedBytes,
      granted: ["public_repo"],
      probesFailed: false,
      sponsors: true,
      storedProbe: "notCapable" as const,
      keep: false,
    },
    {
      label: "write:repo_hook cannot administer webhooks",
      existingToken: storedBytes,
      granted: ["write:repo_hook"],
      probesFailed: false,
      sponsors: true,
      storedProbe: "capable" as const,
      keep: true,
    },
    {
      label: "a failed probe keeps the token (fail-safe continuity)",
      existingToken: storedBytes,
      granted: [],
      probesFailed: true,
      sponsors: true,
      storedProbe: "capable" as const,
      keep: true,
    },
    {
      label: "a failed probe without a registration stores the new token",
      existingToken: storedBytes,
      granted: [],
      probesFailed: true,
      sponsors: false,
      storedProbe: "notCapable" as const,
      keep: false,
    },
  ])("$label", ({ existingToken, granted, probesFailed, sponsors, storedProbe, keep }) => {
    expect(shouldKeepStoredGitHubToken({
      existingToken,
      newTokenGrantedScopes: granted,
      probesFailed,
      sponsorsRegisteredRepository: sponsors,
      storedTokenProbe: storedProbe,
    })).toBe(keep);
  });
});
