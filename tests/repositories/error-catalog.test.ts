import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

// The section publishing what POST /api/repositories answers. Scoping to it is half of what makes
// this a control: a string the token-minting catalog publishes documents a different endpoint.
const registrationCatalogHeading = "### Registration responses";

// src/app/api/repositories/route.ts answers a registration error coded CONFLICT with this status.
const conflictStatus = "409";

// How the registration store can fail an insert, and which published row each failure claims.
const registrationConflicts: RegistrationConflict[] = [
  {
    what: "a GitHub repository another registration already holds",
    async createRepository() {
      return null;
    },
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
  {
    what: "a GitHub path another registration claims",
    async createRepository(): Promise<never> {
      throw new RepositoryOwnerNameConflictError(claimedOwnerName);
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
    async createRepository(): Promise<never> {
      throw new RepositoryWebhookIdConflictError(501);
    },
    publishes: (surfaced) => (cell) => cell === surfaced,
  },
];

// README.md documents the status, code and exact message of every registration failure, and a
// reader matches on all three. Nothing else notices when a message is reworded and the catalog is
// not, so these cases raise each conflict for real and look the surfaced string up in the row the
// registration catalog publishes for it. Membership in the corpus is not enough: a string the
// catalog publishes under a different status, a different code, or for a different conflict is a
// row about something else, and answering with it misdescribes what happened.
describe("the registration error catalog README.md publishes", () => {
  for (const conflict of registrationConflicts) {
    it(`publishes the status, code and message ${conflict.what} surfaces`, async () => {
      await publishedRow(conflict);
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
});

type RegistrationConflict = {
  readonly what: string;
  readonly createRepository: () => Promise<null>;
  readonly publishes: (surfacedMessage: string) => (publishedCell: string) => boolean;
};

type CatalogRow = {
  readonly status: string;
  readonly code: string;
  readonly message: string;
};

// Raises the conflict through the real registerRepository and returns the single catalog row that
// publishes what it surfaced, having checked that row carries the status and code the reader is
// told to match first.
async function publishedRow(conflict: RegistrationConflict): Promise<CatalogRow> {
  const surfaced = await surfacedFailure(conflict.createRepository);
  const publishes = conflict.publishes(surfaced.message);
  const matched = registrationCatalogRows().filter((row) => publishes(row.message));

  expect(
    matched,
    `The ${registrationCatalogHeading} catalog publishes no single row for ${conflict.what}: ${surfaced.message}`,
  ).toHaveLength(1);
  const [row] = matched as [CatalogRow];

  expect(
    { status: row.status, code: row.code },
    `The row published for ${conflict.what} carries a different status or code: ${surfaced.message}`,
  ).toEqual({ status: conflictStatus, code: surfaced.code });

  return row;
}

// The rows of the table under the registration catalog's heading whose message column is headed
// `Exact message`, read back as the API emits them: each cell without its surrounding code span.
function registrationCatalogRows(): CatalogRow[] {
  const lines = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8").split("\n");
  const heading = lines.indexOf(registrationCatalogHeading);
  if (heading === -1) {
    throw new Error(`README.md has no ${registrationCatalogHeading} section, so nothing was compared.`);
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
      `The ${registrationCatalogHeading} section published no exact message rows, so nothing was compared.`,
    );
  }
  return rows;
}

function withoutCodeSpan(cell: string): string {
  return cell.startsWith("`") && cell.endsWith("`") ? cell.slice(1, -1) : cell;
}

async function surfacedFailure(
  createRepository: () => Promise<null>,
): Promise<{ code: string; message: string }> {
  const dependencies: RepositoryRegistrationDependencies = {
    actor: { id: "sponsor-id", role: "MODERATOR" },
    github: {
      async getRepository() {
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
      },
      async ensureDifficultyLabels() {},
      async createWebhook() {
        return { id: 501 };
      },
      async deleteWebhook() {},
    },
    store: {
      async findRepositoryByGitHubId() {
        return null;
      },
      createRepository,
    },
    webhook: {
      callbackUrl: "https://overflow.example/api/github/webhooks",
      secret: "webhook-secret-for-test",
    },
  };

  try {
    await registerRepository(dependencies, registrationInput());
  } catch (error) {
    if (error instanceof RepositoryRegistrationError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("Registration resolved instead of surfacing a registration conflict.");
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
