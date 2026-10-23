import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { getAppInstallOfferRepositoryIds } from "@/lib/dashboard/app-install-offers";
import { recordReconciliationAuthPath } from "@/lib/fold/reconciliation-auth-path";
import type { ReconciliationAuthPath } from "@/lib/fold/reconciliation-auth-path";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let sponsorId: string;
let otherSponsorId: string;
let externalId = 42_000;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "app_install_offers", user: "app_install_offers" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  const sponsors = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (41001, 'offer-sponsor'), (41002, 'other-sponsor') returning id
  `;
  [sponsorId, otherSponsorId] = sponsors.map((row) => row.id);
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
});

async function repository(overrides: {
  sponsor?: string;
  path?: ReconciliationAuthPath | null;
  method?: "oauth_hook" | "app";
  provider?: "github" | "gitlab";
  active?: boolean;
  unavailable?: boolean;
} = {}): Promise<string> {
  const id = externalId++;
  const provider = overrides.provider ?? "github";
  const [row] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, difficulty_scheme,
      registration_method, provider, instance_url, forge_project_id, active,
      unavailable_reason, unavailable_since, reconciliation_auth_path
    ) values (
      ${id}, ${`co-op/repo-${id}`}, ${overrides.sponsor ?? sponsorId}, 'PUBLIC', ${sql.json(validDifficultyScheme())},
      ${overrides.method ?? "oauth_hook"}, ${provider}, ${provider === "gitlab" ? "https://gitlab.com" : null},
      ${provider === "gitlab" ? id : null}, ${overrides.active ?? true},
      ${overrides.unavailable ? "NOT_FOUND" : null}, ${overrides.unavailable ? new Date() : null},
      ${overrides.path === undefined ? "sponsor-oauth-fallback" : overrides.path}
    ) returning id
  `;
  return row.id;
}

describe("dashboard App installation offers", () => {
  // Removing any predicate leaks offers across sponsors, auth paths, methods or forges.
  it("offers only the sponsor's GitHub OAuth fallback registrations, including inactive and unavailable listed rows", async () => {
    const offered = await repository();
    const inactive = await repository({ active: false });
    const unavailable = await repository({ unavailable: true });
    await repository({ path: "github-app-installation" });
    await repository({ path: "registration-app-installation" });
    await repository({ path: null });
    await repository({ method: "app" });
    await repository({ sponsor: otherSponsorId });
    await repository({ provider: "gitlab" });

    expect(await getAppInstallOfferRepositoryIds(sql, sponsorId)).toEqual(new Set([offered, inactive, unavailable]));
    expect(await getAppInstallOfferRepositoryIds(sql, otherSponsorId)).toHaveProperty("size", 1);
  });

  // Reading registration metadata instead of the latest fold would leave this offer visible.
  it("withdraws the offer after the next fold records installation authentication", async () => {
    const id = await repository();
    expect((await getAppInstallOfferRepositoryIds(sql, sponsorId)).has(id)).toBe(true);
    await recordReconciliationAuthPath(sql, id, "github-app-installation", new Date());
    expect((await getAppInstallOfferRepositoryIds(sql, sponsorId)).has(id)).toBe(false);
  });
});
