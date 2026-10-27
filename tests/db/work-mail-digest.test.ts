import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresWorkMailStore } from "@/lib/accounts/work-mail-store";
import { verifyUnsubscribeToken } from "@/lib/accounts/work-mail-unsubscribe";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { recordingTransport } from "../support/work-mail-recording-transport";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });

const { counts } = vi.hoisted(() => ({ counts: [] as { to: string; count: number }[] }));
vi.mock("@/lib/accounts/work-mail-transport", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounts/work-mail-transport")>();
  return {
    ...actual,
    buildDigestMessage: (input: Parameters<typeof actual.buildDigestMessage>[0]) => {
      counts.push({ to: input.to, count: input.count });
      return actual.buildDigestMessage(input);
    },
  };
});

const { runWorkMailDigestCycle } = await import("@/lib/accounts/work-mail-digest");

let sql: Sql;
let container: StartedTestContainer;
let store: PostgresWorkMailStore;
const original = process.env.OVERFLOW_DATABASE_URL;
const tokenKey = randomBytes(32).toString("base64url");
let seed = 0;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "work_mail_digest", user: "work_mail_digest" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  store = new PostgresWorkMailStore(sql, tokenKey);
});
beforeEach(async () => {
  counts.length = 0;
  await sql`delete from contributor_work_mail_subscriptions`;
  await sql`delete from contributor_work_mail_daily`;
  await sql`delete from issues`;
});
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
});

async function insertUser(): Promise<string> {
  seed += 1;
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${8_600_000 + seed}, ${`digest-${seed}`}) returning id`;
  return row!.id;
}

/** A confirmed subscription, its times given as SQL interval offsets from now(). */
async function subscriber(confirmedAgo: string, lastNotifiedAgo: string | null = null) {
  const userId = await insertUser();
  const address = `digest-${seed}-${randomUUID().slice(0, 8)}@example.test`;
  const [row] = await sql<{ id: string }[]>`
    insert into contributor_work_mail_subscriptions (user_id, address, confirmed_at, last_notified_at)
    values (${userId}, ${address}, now() - ${confirmedAgo}::interval,
            ${lastNotifiedAgo === null ? null : sql`now() - ${lastNotifiedAgo}::interval`})
    returning id`;
  return { userId, address, id: row!.id };
}

let repositoryId: string | null = null;

/** An open, unclaimed issue on another sponsor's repository: it is on every subscriber's board. */
async function openIssue(createdAgo: string, claimedBy: string | null = null): Promise<void> {
  if (repositoryId === null) {
    const sponsor = await insertUser();
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
      values (8600900, 'digest-owner/repo', ${sponsor}, 'PUBLIC', 8600901, ${sql.json(validDifficultyScheme())})
      returning id`;
    repositoryId = repository!.id;
  }
  seed += 1;
  await sql`
    insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
                        opening_label, opening_comparison_points, opening_reserve_points, created_at, claim_assignee_github_login)
    values (${8_610_000 + seed}, ${repositoryId}, ${seed}, 'Digest fixture', '', 'https://example.test/issue', 'OPEN', 'M', 5, 5,
            now() - ${createdAgo}::interval, ${claimedBy})`;
}

async function lastNotifiedAt(id: string): Promise<Date | null> {
  const [row] = await sql<{ last_notified_at: Date | null }[]>`select last_notified_at from contributor_work_mail_subscriptions where id = ${id}`;
  return row!.last_notified_at;
}

/** The real store, recording each cycle's start. */
function recordingStore() {
  const starts: Date[] = [];
  return {
    starts,
    store: Object.assign(Object.create(store) as PostgresWorkMailStore, {
      dbNow: async () => {
        const now = await store.dbNow();
        starts.push(now);
        return now;
      },
    }),
  };
}

function cycle(digestStore: PostgresWorkMailStore, transport: ReturnType<typeof recordingTransport>, dailyLimit = 100) {
  return runWorkMailDigestCycle({
    store: digestStore, transport, from: "work@mail.example.org", dailyLimit,
    readOrigin: () => "https://overflow.example", mintToken: (id) => `token-${id}`,
  });
}

describe("the digest cycle over the real store and board", () => {
  it("mails work created after confirmation once, then not again for 24 hours, then only what appeared since", async () => {
    const row = await subscriber("2 hours");
    await openIssue("3 hours");
    await openIssue("1 hour");
    // Claimed work is not work to take: the board's open-claim filter leaves it out.
    await openIssue("1 hour", "someone-else");
    const { store: recorded, starts } = recordingStore();
    const transport = recordingTransport();

    await expect(cycle(recorded, transport)).resolves.toMatchObject({ sent: 1 });
    expect(transport.sent.map((message) => message.to)).toEqual([row.address]);
    expect(counts).toEqual([{ to: row.address, count: 1 }]);
    expect(await lastNotifiedAt(row.id)).toEqual(starts[0]);

    await openIssue("0 seconds");
    await expect(cycle(recorded, transport)).resolves.toMatchObject({ due: 0, sent: 0 });
    expect(transport.sent).toHaveLength(1);

    // A day passes: everything moves 25 hours into the past together.
    await sql`update issues set created_at = created_at - interval '25 hours'`;
    await sql`update contributor_work_mail_subscriptions
              set last_notified_at = last_notified_at - interval '25 hours', last_digest_at = last_digest_at - interval '25 hours'`;
    await expect(cycle(recorded, transport)).resolves.toMatchObject({ sent: 1 });
    expect(counts).toEqual([{ to: row.address, count: 1 }, { to: row.address, count: 1 }]);
  });

  it("reads the watermark from the last digest, not the confirmation", async () => {
    const row = await subscriber("10 days", "25 hours");
    await openIssue("5 days");
    const transport = recordingTransport();
    await expect(cycle(store, transport)).resolves.toMatchObject({ due: 1, sent: 0 });
    await openIssue("1 hour");
    await expect(cycle(store, transport)).resolves.toMatchObject({ due: 1, sent: 1 });
    expect(counts).toEqual([{ to: row.address, count: 1 }]);
  });

  it("leaves a row with no new work unstamped while mailing one that has some", async () => {
    // The older watermark keeps the cycle past its no-new-issue prefilter.
    const busy = await subscriber("4 hours");
    const quiet = await subscriber("2 hours");
    await openIssue("3 hours");
    const transport = recordingTransport();
    await expect(cycle(store, transport)).resolves.toMatchObject({ due: 2, sent: 1 });
    expect(transport.sent.map((message) => message.to)).toEqual([busy.address]);
    expect(await lastNotifiedAt(quiet.id)).toBeNull();
  });

  it("mails once when another cycle claims the slot between this cycle's read and its claim", async () => {
    const row = await subscriber("2 hours");
    await openIssue("1 hour");
    const transport = recordingTransport();
    let interleaved = false;
    const racing = Object.assign(Object.create(store) as PostgresWorkMailStore, {
      claimDigestSlot: async (...args: Parameters<PostgresWorkMailStore["claimDigestSlot"]>) => {
        if (!interleaved) {
          interleaved = true;
          await expect(cycle(store, transport)).resolves.toMatchObject({ sent: 1 });
        }
        return store.claimDigestSlot(...args);
      },
    });
    await expect(cycle(racing, transport)).resolves.toMatchObject({ due: 1, sent: 0 });
    expect(interleaved).toBe(true);
    expect(transport.sent.map((message) => message.to)).toEqual([row.address]);
  });

  it("stops at the daily ceiling, leaving the unmailed row due", async () => {
    const first = await subscriber("3 hours");
    const second = await subscriber("2 hours");
    await openIssue("1 hour");
    const transport = recordingTransport();
    await expect(cycle(store, transport, 1)).resolves.toMatchObject({ due: 2, sent: 1, ceiling: true });
    expect(transport.sent.map((message) => message.to)).toEqual([first.address]);
    expect(await lastNotifiedAt(second.id)).toBeNull();
    const [day] = await sql<{ sent: number }[]>`select sent from contributor_work_mail_daily`;
    expect(day!.sent).toBe(1);
  });

  it("carries a one-click opt-out that verifies to the subscription", async () => {
    vi.stubEnv("OVERFLOW_TOKEN_ENCRYPTION_KEY", tokenKey);
    const row = await subscriber("2 hours");
    await openIssue("1 hour");
    const transport = recordingTransport();
    await runWorkMailDigestCycle({ store, transport, from: "work@mail.example.org", dailyLimit: 100, readOrigin: () => "https://overflow.example" });
    const header = transport.sent[0]!.content.split("\r\n").find((line) => line.startsWith("List-Unsubscribe: "))!;
    expect(verifyUnsubscribeToken(/[?&]token=([^>]+)>$/.exec(header)![1]!, tokenKey, undefined)).toBe(row.id);
    vi.unstubAllEnvs();
  });
});
