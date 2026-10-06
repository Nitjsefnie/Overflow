/**
 * The page-geometry gate's database fixtures, split out of
 * scripts/check-page-geometry.mjs because that file sits on its module-size
 * baseline: its recorded line count may not grow, so fixture code the gate
 * gains is fixture code the gate relocates into this sibling module — the
 * repository's documented remedy for a file over its family ceiling.
 *
 * Two fixtures live here:
 *
 *   - the session fixture (issue 453): the two fixed-ID users the signed-in
 *     contracts sign in as, and
 *   - the board fixture (issue 1067): one visible /issues card — a registered
 *     repository, its active sponsor, and one OPEN issue titled with 256 'a'
 *     characters, the audit's long unbroken title that overflows the board at
 *     narrow viewports.
 *
 * Both seeders are idempotent (fixed row ids, upsert), open and close their
 * own client, and never delete or demote anything else; should a real row
 * ever own a fixture's namespaced github ids or login, the insert fails
 * loudly on the unique constraint rather than silently reusing that row.
 */

import postgres from "postgres";

/**
 * The session fixture's users, by fixed IDs so repeated seeding is an upsert
 * and later runs find the same rows. The github ids/logins are namespaced to
 * this fixture; should a real user ever own them, the insert fails loudly on
 * the unique constraint rather than silently reusing that account.
 */
const FIXTURE_USERS = [
  { id: "00000000-0000-4000-8000-00000000453a", githubUserId: 945300453, login: "geometry-fixture-member", role: "MEMBER" },
  { id: "00000000-0000-4000-8000-00000000453b", githubUserId: 945300454, login: "geometry-fixture-moderator", role: "MODERATOR" },
];

/**
 * Idempotently create the session fixture's users in whatever database
 * `databaseUrl` names — the gate's DATABASE_URL, a scratch container in CI or
 * --base-url mode alike. Never deletes or demotes anything else; the only
 * columns the conflict path rewrites are `role` (back to the fixture
 * contract) and `updated_at`. Every other NOT NULL column of `users` has a
 * default (db/migrations/001_initial.sql). Opens its own client and closes it.
 */
export async function seedFixtureUsers({ databaseUrl }) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [member, moderator] = FIXTURE_USERS;
    const seeded = await sql`
      insert into users (id, github_user_id, github_login, role)
      values
        (${member.id}, ${member.githubUserId}, ${member.login}, ${member.role}),
        (${moderator.id}, ${moderator.githubUserId}, ${moderator.login}, ${moderator.role})
      on conflict (id) do update set role = excluded.role, updated_at = now()
      returning id, role
    `;

    const roleById = new Map(seeded.map((row) => [row.id, row.role]));
    for (const fixture of FIXTURE_USERS) {
      if (roleById.get(fixture.id) !== fixture.role) {
        throw new Error(
          `geometry fixture user ${fixture.id} did not seed as ${fixture.role} ` +
            `(row reads ${String(roleById.get(fixture.id))})`,
        );
      }
    }

    return { memberUserId: member.id, moderatorUserId: moderator.id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The long unbroken title the /issues overflow is measured against, exported
 * so a test pins the seeder against the audited length byte for byte.
 */
export const BOARD_FIXTURE_ISSUE_TITLE = "a".repeat(256);

/**
 * The sponsor's difficulty scheme, the one validity-checked shape the
 * repository's check constraint accepts: a named opening catalog with one
 * label in the points range, and an actual catalog covering every point 1
 * through 10 exactly once (db/migrations/002). The board read surfaces the
 * scheme's openingName, so it must be set for the card to render at all.
 */
const FIXTURE_DIFFICULTY_SCHEME = {
  openingName: "Offered",
  actualName: "Actual",
  openingLabels: [{ label: "medium", comparisonPoints: 3, reservePoints: 3 }],
  actualLabels: [
    { label: "actual one", points: 1 },
    { label: "actual two", points: 2 },
    { label: "actual three", points: 3 },
    { label: "actual four", points: 4 },
    { label: "actual five", points: 5 },
    { label: "actual six", points: 6 },
    { label: "actual seven", points: 7 },
    { label: "actual eight", points: 8 },
    { label: "actual nine", points: 9 },
    { label: "actual ten", points: 10 },
  ],
};

/**
 * The fixture rows, by fixed ids so repeated seeding is an upsert and later
 * runs find the same rows. The github ids and the owner name are namespaced
 * to this fixture (adjacent to the session fixture's 9453004xx ids); the
 * sponsor is a third account, distinct from both session-fixture users, so
 * the board's `sponsors.id <> viewer` clause does not exclude the card when
 * the member fixture views the board.
 */
const FIXTURE_SPONSOR = {
  id: "00000000-0000-4000-8000-000000001067",
  githubUserId: 945310670,
  login: "geometry-fixture-sponsor",
};

const FIXTURE_REPOSITORY = {
  id: "00000000-0000-4000-8000-000000001068",
  githubRepositoryId: 945310671,
  ownerName: "geometry-fixture-owner",
  githubWebhookId: 945310672,
};

const FIXTURE_ISSUE = {
  id: "00000000-0000-4000-8000-000000001069",
  githubIssueId: 945310673,
  issueNumber: 1,
};

/**
 * Idempotently create the board fixture's rows in whatever database
 * `databaseUrl` names — the gate's DATABASE_URL, a scratch container in CI or
 * --base-url mode alike. Every conflict-path rewrite restores the fixture
 * contract (the sponsor's ACTIVE state, the repository's active/unavailable
 * pair, the issue's title and OPEN state); every other NOT NULL column of the
 * three tables has a default or is nullable (db/migrations/001 through 059).
 * The opening rating columns are insert-only, so the opening-immutability
 * trigger's `before update of` list never fires on the upsert path. Opens its
 * own client and closes it.
 */
export async function seedBoardFixtureCard({ databaseUrl }) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [sponsor] = await sql`
      insert into users (id, github_user_id, github_login, role, enforcement_state)
      values (${FIXTURE_SPONSOR.id}, ${FIXTURE_SPONSOR.githubUserId}, ${FIXTURE_SPONSOR.login}, 'MEMBER', 'ACTIVE')
      on conflict (id) do update set enforcement_state = excluded.enforcement_state, updated_at = now()
      returning id
    `;

    const [repository] = await sql`
      insert into registered_repositories
        (id, github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
      values (
        ${FIXTURE_REPOSITORY.id}, ${FIXTURE_REPOSITORY.githubRepositoryId}, ${FIXTURE_REPOSITORY.ownerName},
        ${sponsor.id}, 'PUBLIC', ${FIXTURE_REPOSITORY.githubWebhookId}, ${sql.json(FIXTURE_DIFFICULTY_SCHEME)}
      )
      on conflict (id) do update set
        active = true,
        unavailable_reason = null,
        unavailable_since = null,
        difficulty_scheme = excluded.difficulty_scheme,
        updated_at = now()
      returning id
    `;

    const [issue] = await sql`
      insert into issues
        (id, github_issue_id, repository_id, issue_number, title, body, url, state,
         opening_label, opening_comparison_points, opening_reserve_points)
      values (
        ${FIXTURE_ISSUE.id}, ${FIXTURE_ISSUE.githubIssueId}, ${repository.id}, ${FIXTURE_ISSUE.issueNumber},
        ${BOARD_FIXTURE_ISSUE_TITLE}, 'page-geometry board fixture card (issue 1067)',
        'https://github.com/geometry-fixture-owner/geometry-fixture-repository/issues/1',
        'OPEN', 'medium', 3, 3
      )
      on conflict (id) do update set title = excluded.title, state = excluded.state, updated_at = now()
      returning id
    `;

    return { sponsorUserId: sponsor.id, repositoryId: repository.id, issueId: issue.id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
