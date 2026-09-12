import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "@/lib/github/errors";
import type { GitHubRepository } from "@/lib/github/types";
import type {
  RepositoryRegistrationDependencies,
  RepositoryRegistrationInput,
} from "@/lib/repositories/register";
import {
  RepositoryOwnerNameConflictError,
  RepositoryRegistrationError,
  RepositoryWebhookIdConflictError,
  registerRepository,
} from "@/lib/repositories/register";

const claimedOwnerName = "octo/overflow";

// The abandonment path logs a bounded diagnostic when the webhook cannot be proven
// deleted, which is server-side state no catalog reader consumes; keep the run output clean.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// The section publishing what POST /api/repositories answers. Scoping to it is half of what makes
// this a control: a string the token-minting catalog publishes documents a different endpoint.
const registrationCatalogHeading = "### Registration responses";

// The subsection publishing the answers the GitLab registration path adds. Its table is a separate
// catalog under a separate heading, so it needs its own reader and its own corpus.
const gitlabCatalogHeading = "#### Submitting a GitLab project";

// src/app/api/repositories/route.ts answers an error coded NOT_FOUND with this status.
const notFoundStatus = "404";

// src/app/api/repositories/route.ts answers a registration error coded CONFLICT with this status.
const conflictStatus = "409";

// src/app/api/repositories/route.ts answers an error coded GITHUB_CREDENTIALS with this status.
const githubCredentialsStatus = "401";

// src/app/api/repositories/route.ts answers an error coded GITHUB_ACCESS with this status.
const githubAccessStatus = "403";

// src/app/api/repositories/route.ts answers an error coded GITHUB_RATE_LIMITED with this status.
const githubRateLimitedStatus = "429";

// src/app/api/repositories/route.ts answers an error coded FORBIDDEN with this status.
const forbiddenStatus = "403";

// src/app/api/repositories/route.ts answers an error coded INVALID_INPUT with this status.
const invalidInputStatus = "400";

// src/app/api/repositories/route.ts answers an error coded UPSTREAM_FAILURE with this status.
const upstreamFailureStatus = "502";

// src/app/api/repositories/route.ts answers an error coded ROLLBACK_INCOMPLETE with this status.
const rollbackIncompleteStatus = "503";

// The gateway calls a GitHub failure can interrupt before the store is touched, and the step text
// each surfaced message names — the value the published row carries as <step>.
const gatewaySteps = [
  { step: "getRepository", named: "retrieve the submitted GitHub repository" },
  { step: "listRepositoryLabels", named: "read the repository difficulty labels" },
  { step: "createWebhook", named: "create the repository webhook" },
] as const;

// How a registration conflict can arise, and which published row each conflict claims.
const registrationConflicts: RegistrationFailure[] = [
  {
    what: "a GitHub repository another registration already holds",
    status: conflictStatus,
    raise(dependencies) {
      dependencies.store.createRepository = async () => null;
    },
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitHub path another registration claims",
    status: conflictStatus,
    raise(dependencies) {
      dependencies.store.createRepository = async (): Promise<never> => {
        throw new RepositoryOwnerNameConflictError(claimedOwnerName);
      };
    },
    // The path is substituted into this message at runtime, so only the text on either side of it
    // can be compared with the catalog; the published cell carries <owner/name> in its place.
    publishes: (surfaced) => {
      const parts = surfaced.split(claimedOwnerName);
      expect(parts, `The surfaced message names ${claimedOwnerName} other than once: ${surfaced}`).toHaveLength(2);
      const [before, after] = parts as [string, string];
      return (cell) => cell.startsWith(before) && cell.endsWith(after);
    },
  },
  {
    what: "a GitHub webhook id another registration records",
    status: conflictStatus,
    raise(dependencies) {
      dependencies.store.createRepository = async (): Promise<never> => {
        throw new RepositoryWebhookIdConflictError(501);
      };
    },
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
];

// A GitHub 401 rejects the stored authorization itself and can interrupt any of the gateway calls
// registration makes before the store is touched. The catalog publishes one row for all of them,
// its message carrying <step> where each emission names the step it died on.
const githubCredentialRejections: RegistrationFailure[] = gatewaySteps.map(({ step, named }) => ({
  what: `a GitHub credential rejection while trying to ${named}`,
  status: githubCredentialsStatus,
  raise: (dependencies) => {
    dependencies.github[step] = async () => {
      throw new GitHubApiError(401);
    };
  },
  // The step is substituted into this message at runtime, so only the text on either side of it
  // can be compared with the catalog; the published cell carries <step> in its place.
  publishes: (surfaced) => {
    const parts = surfaced.split(named);
    expect(parts, `The surfaced message names the step ${named} other than once: ${surfaced}`).toHaveLength(2);
    const [before, after] = parts as [string, string];
    return (cell) => cell.startsWith(before) && cell.endsWith(after);
  },
}));

// Builds a predicate holding when the cell begins with the first segment, carries every later
// segment after it in order, and ends with the last one. The text between segments is what the
// cell's angle-bracket placeholders stand for, so only the fixed skeleton is comparable.
function matchesSegmentsInOrder(segments: string[]): (cell: string) => boolean {
  const [first] = segments;
  const last = segments[segments.length - 1];
  return (cell) => {
    if (!cell.startsWith(first)) {
      return false;
    }
    let position = first.length;
    for (const segment of segments.slice(1)) {
      const found = cell.indexOf(segment, position);
      if (found === -1) {
        return false;
      }
      position = found + segment.length;
    }
    return cell.endsWith(last);
  };
}

// The 403 and 404 access messages trail an authorization note whose wording varies with the
// repository's owner type (and, at the first gateway step, with the repository not having been
// looked up at all), so the published cell stands for it with the <cause> placeholder. The
// matcher pins the fixed text around the variable note instead of the note itself: every fixed
// segment is first verified against the surfaced message, then required of the cell in order.
function accessRefusalMatcher(surfaced: string, stepText: string, afterStep: string, tail: string): (cell: string) => boolean {
  const segments = surfaced.split(stepText);
  expect(segments, `The surfaced message names the step ${stepText} other than once: ${surfaced}`).toHaveLength(2);
  const [before] = segments as [string, string];
  expect(surfaced, `The surfaced message lost its post-step text: ${surfaced}`).toContain(afterStep);
  expect(surfaced.endsWith(tail), `The surfaced message does not end in the review remedy: ${surfaced}`).toBe(true);
  return matchesSegmentsInOrder([before, afterStep, tail]);
}

const githubAccessReviewTail = " Review Overflow's authorization at https://github.com/settings/applications, then retry registration.";

// The rate-limit message substitutes the step and the HTTP status, and appends a retry-after
// sentence only when GitHub supplied a delay. The published row carries <step> and <status>, so
// compare the fixed skeleton: drop the delay sentence, then hold the text on either side of the
// step against the cell, resolving the status placeholder before comparing the tail.
function rateLimitMatcher(surfaced: string, stepText: string, status: number): (cell: string) => boolean {
  const withoutDelay = surfaced.replace(/ Retry after \d+ seconds?\./, "");
  const segments = withoutDelay.split(stepText);
  expect(segments, `The surfaced message names the step ${stepText} other than once: ${surfaced}`).toHaveLength(2);
  const [before, after] = segments as [string, string];
  expect(
    after.startsWith(` (HTTP ${status}).`),
    `The surfaced message does not state the raised status after the step: ${surfaced}`,
  ).toBe(true);
  return (cell) => cell.startsWith(before) && cell.replace("<status>", String(status)).endsWith(after);
}

// A GitHub 403 carrying no rate-limit evidence refuses a gateway step ambiguously — it cannot
// separate a missing authorization from a secondary limit — so the message leads with the
// transient remedy and trails the authorization note the <cause> placeholder stands for.
const githubAccessRefusals: RegistrationFailure[] = gatewaySteps.map(({ step, named }) => ({
  what: `a GitHub 403 refusal while trying to ${named}`,
  status: githubAccessStatus,
  raise: (dependencies) => {
    dependencies.github[step] = async () => {
      throw new GitHubApiError(403);
    };
  },
  publishes: (surfaced) => accessRefusalMatcher(
    surfaced,
    named,
    " (HTTP 403). GitHub answers 403 both when the Overflow OAuth application is not yet authorized "
      + "and when it is temporarily limiting requests, and this response carries nothing that "
      + "separates the two causes. Wait a minute and retry registration before changing anything.",
    githubAccessReviewTail,
  ),
}));

// A GitHub 404 hides the resource rather than refusing it, and says so: the message observes what
// the 404 can mean before the same trailing authorization note. At the first gateway step the
// repository was never looked up, so the observation loses its "since it was looked up" clause —
// the published cell stands for that clause with its own placeholder.
const githubAccessHidings: RegistrationFailure[] = gatewaySteps.map(({ step, named }) => ({
  what: `a GitHub 404 hiding while trying to ${named}`,
  status: githubAccessStatus,
  raise: (dependencies) => {
    dependencies.github[step] = async () => {
      throw new GitHubApiError(404);
    };
  },
  publishes: (surfaced) => accessRefusalMatcher(
    surfaced,
    named,
    ". GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate "
      + "missing authorization. The repository may also have been renamed, moved or deleted",
    githubAccessReviewTail,
  ),
}));

// GitHub rate-limits with a 429 and with a 403 carrying rate-limit evidence, and appends a
// retry-after sentence only when GitHub supplied a delay. One published row answers both
// statuses, its <status> placeholder standing for whichever arrived; one case carries a delay so
// the row covers the appended sentence too.
const githubRateLimits: RegistrationFailure[] = [
  ...gatewaySteps.map(({ step, named }, index) => ({
    what: `a GitHub rate limit while trying to ${named}`,
    status: githubRateLimitedStatus,
    raise: (dependencies: RepositoryRegistrationDependencies) => {
      dependencies.github[step] = async () => {
        throw new GitHubApiError(429, false, index === gatewaySteps.length - 1 ? 60 : null);
      };
    },
    publishes: (surfaced: string) => rateLimitMatcher(surfaced, named, 429),
  })),
  {
    what: "a GitHub rate limit on the submitted-repository lookup signalled by a 403 carrying rate-limit evidence",
    status: githubRateLimitedStatus,
    raise: (dependencies: RepositoryRegistrationDependencies) => {
      dependencies.github.getRepository = async () => {
        throw new GitHubApiError(403, true, 30);
      };
    },
    publishes: (surfaced: string) => rateLimitMatcher(surfaced, "retrieve the submitted GitHub repository", 403),
  },
];

// Any other GitHubApiError is an upstream failure, and the fallback message names the step that
// died: the repository lookup keeps its own sentence, the two setup steps share the other shape.
const githubOutages: RegistrationFailure[] = gatewaySteps.map(({ step, named }) => ({
  what: `a GitHub outage while trying to ${named}`,
  status: upstreamFailureStatus,
  raise: (dependencies: RepositoryRegistrationDependencies) => {
    dependencies.github[step] = async () => {
      throw new GitHubApiError(500);
    };
  },
  publishes: (surfaced: string) => (cell: string) => cell === surfaced,
}));

// Label verification refuses a repository whose existing labels do not cover the submitted
// catalog, substituting the backticked list of missing labels into the refusal.
const missingLabelRefusals: RegistrationFailure[] = [
  {
    what: "a repository missing a submitted difficulty label",
    status: invalidInputStatus,
    raise: (dependencies) => {
      // Every submitted label present except one, so the published message substitutes exactly
      // that label — a list of one — into the otherwise fixed refusal.
      dependencies.github.listRepositoryLabels = async () => {
        const labels = new Set([
          ...registrationInput().openingLabels.map(({ label }) => label),
          ...registrationInput().actualLabels.map(({ label }) => label),
        ]);
        labels.delete("delivered/10");
        return labels;
      };
    },
    // The missing label list is substituted into this message, so only the text on either side of
    // it can be compared with the catalog; the published cell carries <labels> in its place.
    publishes: (surfaced) => {
      const parts = surfaced.split("`delivered/10`");
      expect(parts, `The surfaced message names delivered/10 other than once: ${surfaced}`).toHaveLength(2);
      const [before, after] = parts as [string, string];
      return (cell) => cell.startsWith(before) && cell.endsWith(after);
    },
  },
];

// Failures the registration itself raises about the submission, the account, or the store — no
// gateway call involved, so each pins its published row by exact message.
const registrationRefusals: RegistrationFailure[] = [
  {
    what: "a submission that names no GitHub repository",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({ ...input, repositoryUrl: "not-a-github-reference" }),
    publishes: (surfaced: string) => (cell: string) => cell === surfaced,
  },
  {
    what: "an account barred from registering",
    status: forbiddenStatus,
    raise: (dependencies) => {
      dependencies.actor.enforcementState = "BANNED";
    },
    publishes: (surfaced: string) => (cell: string) => cell === surfaced,
  },
  {
    what: "a private repository",
    status: forbiddenStatus,
    raise: (dependencies) => {
      dependencies.github.getRepository = async () => ({ ...githubRepositoryFixture(), visibility: "PRIVATE" });
    },
    publishes: (surfaced: string) => (cell: string) => cell === surfaced,
  },
  {
    what: "a repository the actor cannot administer",
    status: forbiddenStatus,
    raise: (dependencies) => {
      dependencies.github.getRepository = async () => ({ ...githubRepositoryFixture(), canAdminister: false });
    },
    publishes: (surfaced: string) => (cell: string) => cell === surfaced,
  },
  {
    what: "a store that cannot save the registration",
    status: upstreamFailureStatus,
    raise: (dependencies) => {
      dependencies.store.createRepository = async () => {
        throw new Error("the store is unreachable");
      };
    },
    publishes: (surfaced: string) => (cell: string) => cell === surfaced,
  },
  {
    // Issue 451: the save failure triggers a compensating webhook deletion, and the
    // surfaced answer names the incomplete rollback, not the save failure that started it.
    what: "a store that cannot save the registration and a GitHub that will not delete the abandoned webhook",
    status: rollbackIncompleteStatus,
    raise: (dependencies) => {
      dependencies.store.createRepository = async () => {
        throw new Error("the store is unreachable");
      };
      dependencies.github.deleteWebhook = async () => {
        throw new GitHubApiError(500);
      };
    },
    publishes: (surfaced: string) => (cell: string) => cell === surfaced,
  },
];

const registrationFailures = [
  ...registrationConflicts,
  ...githubCredentialRejections,
  ...githubAccessRefusals,
  ...githubAccessHidings,
  ...githubRateLimits,
  ...githubOutages,
  ...missingLabelRefusals,
  ...registrationRefusals,
];

// Exact-message rows the corpus deliberately does not raise, each explained by the
// route-level answer that produces it in src/app/api/repositories/route.ts. A row absent from
// the catalog corpus and from this list is what the reverse-direction check exists to catch.
const routeLevelAnswers: Record<string, string> = {
  "Invalid repository registration request.": "the route's body-schema check answers before registerRepository runs",
  "The supplied API token was not accepted.": "the route's bearer-credential lookup answers before registerRepository runs",
  "Sign in is required.": "the route's session/bearer gate answers before registerRepository runs",
  "The request origin is not allowed.": "the route's origin check answers before registerRepository runs",
  "The request must use the application/json content type.": "the route's content-type gate answers before the token is read",
  "The server is not configured to accept this request.": "answered by src/lib/security/request-origin.ts when APP_URL is missing or malformed, before registerRepository runs; pinned by tests/security/request-origin.test.ts",
  "Unable to initialize repository registration.": "the route's catch-all answers when registration itself fails unexpectedly",
  "The GitHub authorization Overflow holds for your account cannot administer repository webhooks: registration needs the admin:repo_hook scope. Use \"Sign in to register a repository\" to authorize webhook administration with the same GitHub account, then register again.":
    "the route's granted-scope check (issue 599, src/lib/auth/github-granted-scopes.ts) answers before registerRepository runs; pinned by tests/api/repositories.test.ts",
};

// One submission per catalog-validation message, each crafted so validating it fails on exactly
// that message; the shapes follow tests/repositories/register.test.ts. These are raised through
// the same registerRepository as the corpus above but judged by set equality against the bullet
// list the table defers to, so they stay out of the row-matching corpus.
const catalogValidationRefusals: RegistrationFailure[] = [
  {
    what: "an empty display name",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({ ...input, openingName: " " }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a submission with no opening label",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({ ...input, openingLabels: [] }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "an opening label with no text",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({ ...input, openingLabels: [{ label: " ", comparisonPoints: 5, reservePoints: 5 }] }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a duplicated opening label",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({
      ...input,
      openingLabels: [
        { label: "size/M", comparisonPoints: 5, reservePoints: 5 },
        { label: "size/M", comparisonPoints: 5, reservePoints: 5 },
      ],
    }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "an opening mapping outside one through ten",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({ ...input, openingLabels: [{ label: "size/M", comparisonPoints: 0, reservePoints: 5 }] }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "an actual label with no text",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({ ...input, actualLabels: [{ label: " ", points: 1 }, ...actualLabelsFrom(2)] }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "an actual label duplicating an opening label",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({ ...input, actualLabels: [{ label: "size/M", points: 1 }, ...actualLabelsFrom(2)] }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "an actual mapping outside one through ten",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({ ...input, actualLabels: [{ label: "delivered/1", points: 0 }, ...actualLabelsFrom(2)] }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a duplicated actual mapping",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({
      ...input,
      actualLabels: [{ label: "delivered/1", points: 1 }, { label: "delivered/2", points: 1 }, ...actualLabelsFrom(3)],
    }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "an actual catalog that does not cover every point",
    status: invalidInputStatus,
    raise() {},
    submit: (input) => ({ ...input, actualLabels: actualLabelsFrom(1, 9) }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
];

// API.md documents the status, code and exact message of every registration failure, and a
// reader matches on all three. Nothing else notices when a message is reworded and the catalog is
// not, so these cases raise each failure for real and look the surfaced string up in the row the
// registration catalog publishes for it. Membership in the corpus is not enough: a string the
// catalog publishes under a different status, a different code, or for a different failure is a
// row about something else, and answering with it misdescribes what happened.
describe("the registration error catalog API.md publishes", () => {
  for (const failure of registrationFailures) {
    it(`publishes the status, code and message ${failure.what} surfaces`, async () => {
      await publishedRow(failure);
    });
  }

  it("publishes a row per conflict, so no conflict is answered with another's message", async () => {
    const claimed: string[] = [];
    for (const conflict of registrationConflicts) {
      claimed.push((await publishedRow(conflict)).message);
    }

    expect(
      new Set(claimed).size,
      `Two registration conflicts surface the same published message: ${claimed.join(" / ")}`,
    ).toBe(registrationConflicts.length);
  });

  // The other direction, which is what catches a row no code path emits: every exact-message row
  // the catalog publishes must be answered by a failure the corpus raises, or be listed in
  // routeLevelAnswers as answered by src/app/api/repositories/route.ts before or around
  // registerRepository. A row that is neither claimed nor listed fails this check, so a future
  // row cannot slip in without either a raised failure or a stated reason.
  it("publishes no exact-message row that no raised failure answers and no allowlist entry explains", async () => {
    const raised = await Promise.all(registrationFailures.map(async (failure) => ({
      failure,
      surfaced: await surfacedFailure(failure),
    })));

    const unclaimed = registrationCatalogRows().filter((row) => {
      const claimants = raised.filter(({ failure, surfaced }) =>
        row.status === failure.status
        && row.code === surfaced.code
        && failure.publishes(surfaced.message)(row.message));

      if (routeLevelAnswers[row.message] !== undefined) {
        expect(
          claimants,
          `The row "${row.message}" is allowlisted as route-level (${routeLevelAnswers[row.message]}), but a raised failure answers it`,
        ).toHaveLength(0);
        return false;
      }
      return claimants.length === 0;
    });

    expect(
      unclaimed.map((row) => `${row.status} ${row.code} ${row.message}`),
      "The catalog publishes exact-message rows that no raised failure answers and no route-level allowlist entry explains",
    ).toEqual([]);
  });

  // Catalog validation's refusals are enumerated by the bullet list below the table, whose rows
  // the table itself defers to, so the set equality here is what pins them: every message a
  // crafted submission raises must be published, and every published message must be raiseable.
  it("publishes exactly the catalog-validation messages crafted submissions raise", async () => {
    const emitted: string[] = [];
    for (const refusal of catalogValidationRefusals) {
      const surfaced = await surfacedFailure(refusal);
      expect(
        surfaced.code,
        `Raising ${refusal.what} produced a different code than the catalog-validation row's`,
      ).toBe("INVALID_INPUT");
      emitted.push(surfaced.message);
    }

    const published = publishedValidationMessages();
    expect(new Set(published).size, "The published catalog-validation list repeats a message").toBe(published.length);
    expect(
      emitted.slice().sort(),
      "The published catalog-validation list and the messages validation raises differ",
    ).toEqual(published.slice().sort());
  });
});

// The GitLab registration path, raised through the same registerRepository: the submission
// carries provider "gitlab", a linked identity on gitlab.com, and a transport that answers for one
// project. Each case varies exactly the input or dependency its refusal is about.
const gitlabProjectId = 278964;
const gitlabProjectPath = "gitlab-org/gitlab";
const gitlabProject = {
  id: gitlabProjectId,
  name: "gitlab",
  path: "gitlab",
  path_with_namespace: gitlabProjectPath,
  visibility: "public",
  web_url: `https://gitlab.com/${gitlabProjectPath}`,
  namespace: { id: 1, name: "GitLab.org", path: "gitlab-org", kind: "group" },
  permissions: { project_access: { access_level: 40 } },
};

function gitlabSubmission(input: RepositoryRegistrationInput): RepositoryRegistrationInput {
  return { ...input, provider: "gitlab", instanceUrl: "https://gitlab.com", project: gitlabProjectPath };
}

// A transport answering the project by path and by id, the hook endpoints the
// registration now drives, and the catalog labels the submission names unless
// told to answer none; anything else is 404, as the real instance would
// answer. A case varying exactly the project fields its refusal is about
// merges them over the served payload.
function gitlabTransport(options: {
  labels?: "all" | "none";
  project?: "found" | "missing";
  projectOverrides?: Record<string, unknown>;
  /** The status the instance answers the hook POST with; absent means a created hook (id 4001). */
  hookCreationStatus?: number;
  /** The status the instance answers the hook DELETE with; absent means proven gone. */
  hookDeletionStatus?: number;
} = {}): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (request.url.includes("/hooks")) {
      if (request.method === "POST") {
        if (options.hookCreationStatus !== undefined) {
          return new Response("hook refused", { status: options.hookCreationStatus });
        }
        return json({ id: 4001 });
      }
      return new Response(null, { status: options.hookDeletionStatus ?? 204 });
    }
    if (request.url.includes("/labels")) {
      const labels = options.labels === "none"
        ? []
        : [...registrationInput().openingLabels, ...registrationInput().actualLabels].map(({ label }) => ({ name: label }));
      return json(labels);
    }
    if (options.project !== "missing" && request.url.includes(`/projects/${encodeURIComponent(gitlabProjectPath)}`)) {
      return json({ ...gitlabProject, ...options.projectOverrides });
    }
    if (options.project !== "missing" && request.url.includes(`/projects/${gitlabProjectId}`)) {
      return json({ ...gitlabProject, ...options.projectOverrides });
    }
    return new Response("no route", { status: 404 });
  };
}

function linkGitLab(dependencies: RepositoryRegistrationDependencies, transport: typeof fetch = gitlabTransport()): void {
  dependencies.forgeIdentity = { instanceUrl: "https://gitlab.com", token: "glpat-test" };
  dependencies.forgeFetch = transport;
}

const gitlabFailures: RegistrationFailure[] = [
  {
    what: "a GitLab submission whose instance URL does not parse",
    status: invalidInputStatus,
    raise: linkGitLab,
    submit: (input) => ({ ...gitlabSubmission(input), instanceUrl: "not-a-url" }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab submission whose instance URL is not http or https",
    status: invalidInputStatus,
    raise: linkGitLab,
    submit: (input) => ({ ...gitlabSubmission(input), instanceUrl: "ftp://gitlab.example" }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab submission without a project",
    status: invalidInputStatus,
    raise: linkGitLab,
    submit: (input) => ({ ...gitlabSubmission(input), project: "" }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab submission whose numeric project id is zero",
    status: invalidInputStatus,
    raise: linkGitLab,
    submit: (input) => ({ ...gitlabSubmission(input), project: "0" }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab submission whose project is neither an id nor a path",
    status: invalidInputStatus,
    raise: linkGitLab,
    submit: (input) => ({ ...gitlabSubmission(input), project: "gitlab" }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab submission with no identity linked on the instance",
    status: forbiddenStatus,
    raise(dependencies) {
      linkGitLab(dependencies);
      dependencies.forgeIdentity = null;
    },
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab project that is not public",
    status: forbiddenStatus,
    raise: (dependencies) => linkGitLab(dependencies, gitlabTransport({ projectOverrides: { visibility: "private" } })),
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab project the linked identity cannot maintain",
    status: forbiddenStatus,
    raise: (dependencies) =>
      linkGitLab(dependencies, gitlabTransport({
        projectOverrides: { permissions: { project_access: { access_level: 30 } } },
      })),
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab submission whose linked identity is on another instance",
    status: forbiddenStatus,
    raise(dependencies) {
      linkGitLab(dependencies);
      dependencies.forgeIdentity = { instanceUrl: "https://gitlab.example", token: "glpat-elsewhere" };
    },
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab project id the instance does not answer",
    status: notFoundStatus,
    raise: (dependencies) => linkGitLab(dependencies, gitlabTransport({ project: "missing" })),
    submit: (input) => ({ ...gitlabSubmission(input), project: String(gitlabProjectId) }),
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab project another registration already holds",
    status: conflictStatus,
    raise(dependencies) {
      linkGitLab(dependencies);
      dependencies.store.createRepository = async () => null;
    },
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab project whose numeric id a GitHub registration holds",
    status: conflictStatus,
    raise(dependencies) {
      linkGitLab(dependencies);
      dependencies.store.findRepositoryProviderById = async () => "github";
    },
    submit: gitlabSubmission,
    // The id and the holding provider are substituted at runtime; the published cell carries <id>
    // and <provider> in their places, so only the fixed skeleton around them is comparable.
    publishes: (surfaced) => {
      const skeleton = [
        "GitLab project ",
        " collides with forge id ",
        " already registered as provider '",
        "'. An id's forge history never migrates between forges; registration refused.",
      ];
      expect(matchesSegmentsInOrder(skeleton)(surfaced), `The surfaced message lost its skeleton: ${surfaced}`).toBe(true);
      return matchesSegmentsInOrder(skeleton);
    },
  },
  {
    what: "a GitLab project missing the catalog labels",
    status: invalidInputStatus,
    raise: (dependencies) => linkGitLab(dependencies, gitlabTransport({ labels: "none" })),
    submit: gitlabSubmission,
    // The missing labels are substituted at runtime; the published cell carries <labels>.
    publishes: (surfaced) => {
      const skeleton = ["The GitLab project does not carry these labels: ", ". Create them, then register again."];
      expect(matchesSegmentsInOrder(skeleton)(surfaced), `The surfaced message lost its skeleton: ${surfaced}`).toBe(true);
      return matchesSegmentsInOrder(skeleton);
    },
  },
  {
    what: "a GitLab path another registration claims",
    status: conflictStatus,
    raise(dependencies) {
      linkGitLab(dependencies);
      dependencies.store.createRepository = async (): Promise<never> => {
        throw new RepositoryOwnerNameConflictError(claimedOwnerName);
      };
    },
    submit: gitlabSubmission,
    // The path is substituted into this message at runtime, so only the text
    // on either side of it can be compared with the catalog; the published
    // cell carries <owner/name> in its place.
    publishes: (surfaced) => {
      const parts = surfaced.split(claimedOwnerName);
      expect(parts, `The surfaced message names ${claimedOwnerName} other than once: ${surfaced}`).toHaveLength(2);
      const [before, after] = parts as [string, string];
      return (cell) => cell.startsWith(before) && cell.endsWith(after);
    },
  },
  {
    what: "a GitLab project whose hook id another registration records",
    status: conflictStatus,
    raise(dependencies) {
      linkGitLab(dependencies);
      dependencies.store.createRepository = async (): Promise<never> => {
        throw new RepositoryWebhookIdConflictError(4001);
      };
    },
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab registration the store cannot save",
    status: upstreamFailureStatus,
    raise(dependencies) {
      linkGitLab(dependencies);
      dependencies.store.createRepository = async (): Promise<never> => {
        throw new Error("save failed");
      };
    },
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab credential rejection while creating the project hook",
    status: githubCredentialsStatus,
    raise: (dependencies) => linkGitLab(dependencies, gitlabTransport({ hookCreationStatus: 401 })),
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab refusal while creating the project hook",
    status: githubAccessStatus,
    raise: (dependencies) => linkGitLab(dependencies, gitlabTransport({ hookCreationStatus: 403 })),
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab 404 hiding while creating the project hook",
    status: githubAccessStatus,
    raise: (dependencies) => linkGitLab(dependencies, gitlabTransport({ hookCreationStatus: 404 })),
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab rate limit while creating the project hook",
    status: githubRateLimitedStatus,
    raise: (dependencies) => linkGitLab(dependencies, gitlabTransport({ hookCreationStatus: 429 })),
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab outage while creating the project hook",
    status: upstreamFailureStatus,
    raise: (dependencies) => linkGitLab(dependencies, gitlabTransport({ hookCreationStatus: 500 })),
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitLab registration whose save fails and whose compensating hook deletion the instance refuses",
    status: rollbackIncompleteStatus,
    raise(dependencies) {
      linkGitLab(dependencies, gitlabTransport({ hookDeletionStatus: 500 }));
      dependencies.store.createRepository = async (): Promise<never> => {
        throw new Error("save failed");
      };
    },
    submit: gitlabSubmission,
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
];

// GitLab rows the corpus deliberately does not raise, answered at the route rather than by
// registerRepository — the same allowlist discipline as routeLevelAnswers.
const gitlabRouteLevelAnswers: Record<string, string> = {
  "Unable to initialize repository registration.": "the route's catch-all answers a GitLab read the gateway could not complete, and an unavailable GitHub credential",
};

describe("the GitLab registration answers API.md publishes", () => {
  const catalog = { heading: gitlabCatalogHeading, rows: gitlabCatalogRows };

  for (const failure of gitlabFailures) {
    it(`publishes the status, code and message ${failure.what} surfaces`, async () => {
      await publishedRow(failure, catalog);
    });
  }

  it("publishes no GitLab exact-message row that no raised failure answers and no allowlist entry explains", async () => {
    const raised = await Promise.all(gitlabFailures.map(async (failure) => ({
      failure,
      surfaced: await surfacedFailure(failure),
    })));

    const unclaimed = gitlabCatalogRows().filter((row) => {
      const claimants = raised.filter(({ failure, surfaced }) =>
        row.status === failure.status
        && row.code === surfaced.code
        && failure.publishes(surfaced.message)(row.message));

      if (gitlabRouteLevelAnswers[row.message] !== undefined) {
        expect(
          claimants,
          `The GitLab row "${row.message}" is allowlisted as route-level (${gitlabRouteLevelAnswers[row.message]}), but a raised failure answers it`,
        ).toHaveLength(0);
        return false;
      }
      return claimants.length === 0;
    });

    expect(
      unclaimed.map((row) => `${row.status} ${row.code} ${row.message}`),
      "The GitLab subsection publishes exact-message rows that no raised failure answers and no allowlist entry explains",
    ).toEqual([]);
  });
});

type RegistrationFailure = {
  readonly what: string;
  // The status src/app/api/repositories/route.ts answers this failure's error code with.
  readonly status: string;
  // Swaps in the dependency whose failure produces this registration outcome.
  readonly raise: (dependencies: RepositoryRegistrationDependencies) => void;
  // Reshapes the submission when the failure is about the submitted input itself.
  readonly submit?: (input: RepositoryRegistrationInput) => RepositoryRegistrationInput;
  readonly publishes: (surfacedMessage: string) => (publishedCell: string) => boolean;
};

type CatalogRow = {
  readonly status: string;
  readonly code: string;
  readonly message: string;
};

// Raises the failure through the real registerRepository and returns the single catalog row that
// publishes what it surfaced, having checked that row carries the status and code the reader is
// told to match first.
async function publishedRow(
  failure: RegistrationFailure,
  catalog: { heading: string; rows: () => CatalogRow[] } = { heading: registrationCatalogHeading, rows: registrationCatalogRows },
): Promise<CatalogRow> {
  const surfaced = await surfacedFailure(failure);
  const publishes = failure.publishes(surfaced.message);
  const matched = catalog.rows().filter((row) => publishes(row.message));

  expect(
    matched,
    `The ${catalog.heading} catalog publishes no single row for ${failure.what}: ${surfaced.message}`,
  ).toHaveLength(1);
  const [row] = matched as [CatalogRow];

  expect(
    { status: row.status, code: row.code },
    `The row published for ${failure.what} carries a different status or code: ${surfaced.message}`,
  ).toEqual({ status: failure.status, code: surfaced.code });

  return row;
}

// The rows of the table under the registration catalog's heading whose message column is headed
// `Exact message`, read back as the API emits them: each cell without its surrounding code span.
function registrationCatalogRows(): CatalogRow[] {
  return catalogRowsUnder(registrationCatalogHeading);
}

// The rows of the GitLab subsection's table, scoped the same way: the subsection ends at the
// next heading, which is the registration catalog's own.
function gitlabCatalogRows(): CatalogRow[] {
  return catalogRowsUnder(gitlabCatalogHeading);
}

function catalogRowsUnder(catalogHeading: string): CatalogRow[] {
  const lines = readFileSync(fileURLToPath(new URL("../../API.md", import.meta.url)), "utf8").split("\n");
  const heading = lines.indexOf(catalogHeading);
  if (heading === -1) {
    throw new Error(`API.md has no ${catalogHeading} section, so nothing was compared.`);
  }

  const rows: CatalogRow[] = [];
  let inCatalog = false;
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith("#")) {
      break;
    }
    if (!line.startsWith("|")) {
      inCatalog = false;
      continue;
    }
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    if (columns[2] === "Exact message") {
      inCatalog = true;
      continue;
    }
    const [status, code, message] = columns;
    if (!inCatalog || status === undefined || code === undefined || message === undefined) {
      continue;
    }
    // A row deferring to a list of messages published elsewhere carries prose here, not a message.
    if (!message.startsWith("`") || !message.endsWith("`")) {
      continue;
    }
    rows.push({ status, code: withoutCodeSpan(code), message: withoutCodeSpan(message) });
  }

  if (rows.length === 0) {
    throw new Error(
      `The ${catalogHeading} section published no exact message rows, so nothing was compared.`,
    );
  }
  return rows;
}

function withoutCodeSpan(cell: string): string {
  return cell.startsWith("`") && cell.endsWith("`") ? cell.slice(1, -1) : cell;
}

async function surfacedFailure(failure: RegistrationFailure): Promise<{ code: string; message: string }> {
  const dependencies: RepositoryRegistrationDependencies = {
    actor: { id: "sponsor-id", role: "MODERATOR" },
    github: {
      async getRepository() {
        return githubRepositoryFixture();
      },
      async getRepositoryById() {
        return githubRepositoryFixture();
      },
      async listRepositoryLabels() {
        return new Set([
          ...registrationInput().openingLabels.map(({ label }) => label),
          ...registrationInput().actualLabels.map(({ label }) => label),
        ]);
      },
      async listWorkflowFiles() { return []; },
      async createWebhook() {
        return { id: 501 };
      },
      async deleteWebhook() {},
    },
    store: {
      async findRepositoryByGitHubId() {
        return null;
      },
      async findRepositoryProviderById() {
        return null;
      },
      async findRepositoryRegistrationStateByOwnerName() {
        return null;
      },
      async findRepositoryRegistrationStateByForgeIdentity() {
        return null;
      },
      async findRepositoryRegistrationState() {
        return null;
      },
      async unregisterRepository(): Promise<never> {
        throw new Error("The registration reached the store without an injected failure.");
      },
      async findGitLabWebhookTargetByOwnerName() {
        return null;
      },
      // Loud so a failure case that reaches the store without having raised its own failure is a
      // failed case, not a silently different registration outcome.
      async createRepository(): Promise<never> {
        throw new Error("The registration reached the store without an injected failure.");
      },
      async appendDifficultySchemeVersion() {
        return null;
      },
      async saveAbandonedWebhookCleanup() {},
      async listAbandonedWebhookCleanups() {
        return [];
      },
      async clearAbandonedWebhookCleanup() {},
    },
    webhook: {
      callbackUrl: "https://overflow.example/api/github/webhooks",
    },
  };
  failure.raise(dependencies);

  try {
    await registerRepository(dependencies, failure.submit?.(registrationInput()) ?? registrationInput());
  } catch (error) {
    if (error instanceof RepositoryRegistrationError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("Registration resolved instead of surfacing a registration failure.");
}

// The GitHub repository a successful lookup surfaces, in the shape the access checks read:
// public, user-owned, administered by the actor. An access case replaces this lookup to vary
// exactly the field its refusal is about.
function githubRepositoryFixture(): GitHubRepository {
  return {
    id: 42,
    owner: "octo",
    ownerType: "USER",
    name: "overflow",
    fullName: claimedOwnerName,
    visibility: "PUBLIC",
    url: `https://github.com/${claimedOwnerName}`,
    canAdminister: true,
  };
}

// Actual labels carrying each point from `from` through `to` (ten unless told otherwise), the
// shape the crafted catalog-validation submissions reshape from.
function actualLabelsFrom(from: number, to: number = 10): RepositoryRegistrationInput["actualLabels"] {
  return Array.from({ length: to - from + 1 }, (_, index) => ({
    label: `delivered/${from + index}`,
    points: from + index,
  }));
}

// The bullet list below the registration catalog enumerating the exact INVALID_INPUT messages
// catalog validation returns, read back as the API emits them.
function publishedValidationMessages(): string[] {
  const lines = readFileSync(fileURLToPath(new URL("../../API.md", import.meta.url)), "utf8").split("\n");
  const intro = lines.findIndex((line) => line.startsWith("Catalog validation returns one of these exact"));
  if (intro === -1) {
    throw new Error("API.md no longer enumerates the catalog-validation INVALID_INPUT messages.");
  }

  const messages: string[] = [];
  for (const line of lines.slice(intro + 1)) {
    const bullet = line.match(/^- `(.+)`$/);
    if (bullet === null) {
      if (messages.length > 0 || line.trim().length > 0) {
        break;
      }
      continue;
    }
    messages.push(bullet[1]);
  }

  if (messages.length === 0) {
    throw new Error("API.md enumerates no catalog-validation INVALID_INPUT messages.");
  }
  return messages;
}

function registrationInput(): RepositoryRegistrationInput {
  return {
    repositoryUrl: claimedOwnerName,
    openingName: "Size",
    actualName: "Delivered",
    openingLabels: [{ label: "size/M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}
