import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { writeSync } from "node:fs";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { foldRepository, type RepositoryFoldIssue } from "@/lib/fold/repository-fold";
import { moderationInstantToIso } from "@/lib/fold/moderation-history";

vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const lowId = "00000000-0000-4000-8000-000000000001";
const highId = "00000000-0000-4000-8000-000000000002";
const sponsorId = "00000000-0000-4000-8000-000000000101";
const contributorId = "00000000-0000-4000-8000-000000000102";
const moderatorId = "00000000-0000-4000-8000-000000000103";
const forgeRepositoryId = "00000000-0000-4000-8000-000000000202";
const repositoryId = "00000000-0000-4000-8000-000000000201";
const decisionAt = "2026-10-12T00:00:00.123100Z";
const liftAt = "2026-10-12T00:00:00.123900Z";
const queryAt = "2026-10-12T00:00:01.000Z";
const registeredAt = "2026-01-01T00:00:00.000Z";
const scheme = {
  openingName: "Size",
  actualName: "Delivered",
  openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
  actualLabels: Array.from({ length: 10 }, (_, index) => ({
    label: `delivered/${index + 1}`, points: index + 1,
  })),
};

let sql: Sql;
let container: StartedTestContainer | undefined;
let store: PostgresFoldStore;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_1186_fold_ordering",
    user: "overflow_1186_fold_ordering",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  await runMigrations();
  sql = postgres(started.databaseUrl, { connection: { TimeZone: "Europe/Prague" } });
  await sql`
    insert into users (id, github_user_id, github_login, role, enforcement_state)
    values
      (${sponsorId}, 1001, 'sponsor', 'MEMBER', 'ACTIVE'),
      (${contributorId}, 2001, 'contributor', 'MEMBER', 'ACTIVE'),
      (${moderatorId}, 3001, 'moderator', 'MODERATOR', 'ACTIVE')
  `;
  await sql`
    insert into registered_repositories (
      id, github_repository_id, owner_name, sponsor_id, visibility,
      github_webhook_id, difficulty_scheme, created_at
    )
    values (
      ${repositoryId}, 5001, 'octo/example', ${sponsorId}, 'PUBLIC',
      5002, ${sql.json(scheme)}::jsonb, ${registeredAt}::timestamptz
    )
  `;
  await sql`
    insert into registered_repositories (
      id, github_repository_id, owner_name, sponsor_id, visibility,
      github_webhook_id, difficulty_scheme, created_at, provider, instance_url, forge_project_id
    ) values (
      ${forgeRepositoryId}, 5003, 'octo/gitlab-example', ${sponsorId}, 'PUBLIC',
      5004, ${sql.json(scheme)}::jsonb, ${registeredAt}::timestamptz, 'gitlab', 'https://gitlab.com', 501
    )
  `;
  await sql`
    insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token)
    values (${contributorId}, 'gitlab', 'https://gitlab.com', 2001, 'contributor', ${Buffer.from("unused")})
  `;
  store = new PostgresFoldStore(sql);
});

beforeEach(async () => {
  // The entire database is disposable. TRUNCATE permits reusing the same ids
  // for the swapped case without rewriting the immutable events.
  await sql`truncate moderation_events cascade`;
});

afterAll(async () => {
  await sql?.end();
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function issue(): RepositoryFoldIssue {
  return {
    id: 101, number: 1, title: "Issue",
    url: "https://github.com/octo/example/issues/1",
    state: "CLOSED", stateReason: "COMPLETED",
    createdAt: "2026-10-11T09:00:00.000Z",
    updatedAt: queryAt, closedAt: queryAt,
    authorLogin: "sponsor", authorGitHubUserId: 1001,
    labels: ["M", "delivered/6"],
    history: [
      {
        kind: "LABELED", id: "opening-1", actorLogin: "sponsor",
        actorGitHubUserId: 1001, label: "M",
        createdAt: "2026-10-11T10:00:00.000Z",
      },
      {
        kind: "LABELED", id: "actual-1", actorLogin: "sponsor",
        actorGitHubUserId: 1001, label: "delivered/6",
        createdAt: "2026-10-12T00:00:00.500Z",
      },
    ],
    comments: [{
      id: "comment-1", databaseId: 401, authorLogin: "sponsor",
      authorGitHubUserId: 1001,
      body: "Settled as delivered/6 after reviewing the final diff.",
      createdAt: "2026-10-12T00:00:00.600Z", lastEditedAt: null,
    }],
    closingPullRequests: [{
      id: 201, number: 11, title: "Pull request",
      url: "https://github.com/octo/example/pull/11",
      state: "MERGED", mergedAt: queryAt,
      mergeCommitOid: Array.from({ length: 40 }, (_, i) => (i % 16).toString(16)).join(""),
      finalCommitAt: "2026-10-11T23:59:59.000Z",
      authorLogin: "contributor", authorGitHubUserId: 2001,
      repositoryGitHubId: 5001, repositoryNameWithOwner: "octo/example",
      reviews: [], rawDiff: "diff",
    }],
  };
}

async function insertHistory(targetId: string, decisionId: string, liftId: string): Promise<void> {
  await sql`
    insert into moderation_events (id, target_user_id, actor_id, prior_state, new_state, reason, created_at)
    values
      (${decisionId}, ${targetId}, ${moderatorId}, 'RECALIBRATING', 'RECALIBRATING',
       'Contest decision: sanction stays', timestamptz '2026-10-12T00:00:00.123100Z'),
      (${liftId}, ${targetId}, ${moderatorId}, 'RECALIBRATING', 'ACTIVE',
       'Lift after contest decision', timestamptz '2026-10-12T00:00:00.123900Z')
  `;
}

async function assertDatabaseHistory(targetId: string, decisionId: string, liftId: string): Promise<void> {
  const rows = await sql`
    select id, prior_state::text, new_state::text,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
    from moderation_events where target_user_id = ${targetId} order by created_at, id
  `;
  expect(rows).toEqual([
    { id: decisionId, prior_state: "RECALIBRATING", new_state: "RECALIBRATING", created_at: decisionAt },
    { id: liftId, prior_state: "RECALIBRATING", new_state: "ACTIVE", created_at: liftAt },
  ]);
  const [database] = await sql`
    select participation_eligible_at(${targetId}, ${queryAt}::timestamptz) as eligible,
      enforcement_state_at(${targetId}, ${queryAt}::timestamptz)::text as state
  `;
  expect(database).toEqual({ eligible: true, state: "ACTIVE" });
}

describe("real store moderation history at database precision", () => {
  it.each([
    { zone: "America/New_York", input: "1880-01-01T00:00:00.123100Z", rendered: "1879-12-31T19:03:58.1231-04:56:02", canonical: "1880-01-01T00:00:00.123100Z" },
    { zone: "Asia/Kolkata", input: "1900-01-01T00:00:00.123100Z", rendered: "1900-01-01T05:21:10.1231+05:21:10", canonical: "1900-01-01T00:00:00.123100Z" },
    { zone: "UTC", input: "10000-01-01T00:00:00.123100Z", rendered: "10000-01-01T00:00:00.1231+00:00", canonical: "+010000-01-01T00:00:00.123100Z" },
    { zone: "UTC", input: "294000-01-01T00:00:00.123100Z", rendered: "294000-01-01T00:00:00.1231+00:00", canonical: "+294000-01-01T00:00:00.123100Z" },
    { zone: "UTC", input: "0001-01-01 00:00:00.123100+00 BC", rendered: "0001-01-01T00:00:00.1231+00:00 BC", canonical: "0000-01-01T00:00:00.123100Z" },
    { zone: "America/New_York", input: "0001-01-01 00:00:00.123100+00 BC", rendered: "0002-12-31T19:03:58.1231-04:56:02 BC", canonical: "0000-01-01T00:00:00.123100Z" },
    { zone: "UTC", input: "0002-01-01 00:00:00.123100+00 BC", rendered: "0002-01-01T00:00:00.1231+00:00 BC", canonical: "-000001-01-01T00:00:00.123100Z" },
  ])("loads PostgreSQL's $input rendering in $zone", async ({ zone, input, rendered, canonical }) => {
    await sql.begin(async (transaction) => {
      await transaction`select set_config('TimeZone', ${zone}, true)`;
      if (zone === "America/New_York") {
        const [special] = await transaction`
          select jsonb_build_object(
            'bc', timestamptz '0001-01-01 00:00:00.123100+00 BC',
            'infinity', timestamptz 'infinity', 'negativeInfinity', timestamptz '-infinity'
          ) as renderings
        `;
        writeSync(1, `PostgreSQL BC/infinity probe: ${JSON.stringify(special!.renderings)}\n`);
        expect(special!.renderings.infinity).toBe("infinity");
        expect(special!.renderings.negativeInfinity).toBe("-infinity");
        for (const value of [special!.renderings.infinity, special!.renderings.negativeInfinity]) {
          expect(() => moderationInstantToIso(value)).toThrow("Timestamp was invalid.");
        }
      }
      const [row] = await transaction<{ event: { t: string } }[]>`
        select jsonb_build_object('t', ${input}::text::timestamptz) as event
      `;
      expect(row!.event.t).toBe(rendered);
      expect(moderationInstantToIso(row!.event.t)).toBe(canonical);
      await transaction`
        insert into moderation_events (id, target_user_id, actor_id, prior_state, new_state, reason, created_at)
        values
          (${lowId}, ${contributorId}, ${moderatorId}, 'RECALIBRATING', 'ACTIVE', 'Lift', ${input}::text::timestamptz),
          (${highId}, ${sponsorId}, ${moderatorId}, 'RECALIBRATING', 'ACTIVE', 'Lift', ${input}::text::timestamptz)
      `;
      const localStore = new PostgresFoldStore(transaction as unknown as Sql);
      const users = await localStore.findUsersByGitHubUserIds([2001]);
      const repository = await localStore.getRepository(repositoryId);
      const identities = await localStore.findForgeIdentitiesByForgeUserIds(forgeRepositoryId, [2001]);
      for (const user of [users[0]!, repository!.sponsor, identities[0]!.user]) {
        expect(user.moderationEvents![0]!.occurredAt).toBe(canonical);
      }
    });
  });

  it.each([
    { role: "sponsor", targetId: sponsorId },
    { role: "contributor", targetId: contributorId },
  ])("rejects participation before the $role-only later lift", async ({ targetId }) => {
    await sql`
      insert into moderation_events (id, target_user_id, actor_id, prior_state, new_state, reason, created_at)
      values (${lowId}, ${targetId}, ${moderatorId}, 'RECALIBRATING', 'ACTIVE', 'Later lift',
        timestamptz '2026-10-12T00:00:01.000009Z')
    `;
    const [authority] = await sql`
      select participation_eligible_at(${targetId}, ${queryAt}::timestamptz) as eligible
    `;
    expect(authority!.eligible).toBe(false);
    const repository = await store.getRepository(repositoryId);
    const users = await store.findUsersByGitHubUserIds([1001, 2001]);
    expect(repository!.sponsor.enforcementState).toBe("ACTIVE");
    expect(users.find((candidate) => candidate.id === contributorId)!.enforcementState).toBe("ACTIVE");
    const folded = foldRepository({ repository: repository!, users, issues: [issue()] });
    expect(folded.issues[0]!.settledPoints).toBe(6);
    expect(folded.settlements).toEqual([]);
    expect(folded.ledgerEntries).toEqual([]);
  });

  it.each([
    { role: "contributor", targetId: contributorId },
    { role: "sponsor", targetId: sponsorId },
  ])("settles six credits after the $role lift in both UUID assignments", async ({ targetId }) => {
    for (const [decisionId, liftId] of [[highId, lowId], [lowId, highId]]) {
      await sql`truncate moderation_events cascade`;
      await insertHistory(targetId, decisionId!, liftId!);
      await assertDatabaseHistory(targetId, decisionId!, liftId!);
      const repository = await store.getRepository(repositoryId);
      expect(repository).not.toBeNull();
      const users = await store.findUsersByGitHubUserIds([1001, 2001]);
      const target = targetId === sponsorId ? repository!.sponsor : users.find((user) => user.id === targetId)!;
      expect(target.enforcementState).toBe("ACTIVE");
      expect(target.moderationEvents?.map((event) => event.id)).toEqual([decisionId, liftId]);
      const folded = foldRepository({ repository: repository!, users, issues: [issue()] });
      expect(folded.issues).toHaveLength(1);
      expect(folded.pullRequests).toHaveLength(1);
      expect(folded.issues[0]!.settledPoints).toBe(6);
      expect(folded.unwritableClosures).toEqual([]);
      expect(folded.settlements).toHaveLength(1);
      expect(folded.settlements[0]!.credits).toBe(6);
      expect(folded.ledgerEntries).toHaveLength(2);
    }
  });

  it("preserves UTC microseconds through all three loaders under a non-UTC session", async () => {
    await insertHistory(contributorId, highId, lowId);
    await insertHistory(sponsorId, "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004");
    const [rendered] = await sql`
      select current_setting('TimeZone') as timezone,
        jsonb_build_object('t', timestamptz '2026-10-12T00:00:00.123100Z') as event
    `;
    expect(rendered).toEqual({ timezone: "Europe/Prague", event: { t: "2026-10-12T02:00:00.1231+02:00" } });
    const users = await store.findUsersByGitHubUserIds([2001]);
    const repository = await store.getRepository(repositoryId);
    const identities = await store.findForgeIdentitiesByForgeUserIds(forgeRepositoryId, [2001]);
    for (const user of [users[0]!, repository!.sponsor, identities[0]!.user]) {
      expect(user.moderationEvents?.map((event) => event.occurredAt)).toEqual([decisionAt, liftAt]);
    }
  });
});
