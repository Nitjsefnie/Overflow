import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  RepositoryRegistrationDependencies,
  RepositoryRegistrationInput,
} from "@/lib/repositories/register";
import {
  RepositoryOwnerNameConflictError,
  RepositoryWebhookIdConflictError,
  registerRepository,
} from "@/lib/repositories/register";

const claimedOwnerName = "octo/overflow";

// README.md documents the exact message of every registration failure, and a reader matches on
// it. Nothing else notices when a message is reworded and the catalog is not, so these cases
// raise each conflict for real and look the surfaced string up in the published table.
describe("the registration error catalog README.md publishes", () => {
  it("lists the message a webhook id another registration records surfaces", async () => {
    const message = await surfacedMessage(new RepositoryWebhookIdConflictError(501));

    expect(
      exactMessageCells(),
      `README.md lists no exact message equal to: ${message}`,
    ).toContain(message);
  });

  // The path is substituted into this message at runtime, so only the text on either side of it
  // can be compared with the catalog; the published cell carries <owner/name> in its place.
  it("lists the text either side of the path a GitHub path another registration claims surfaces", async () => {
    const message = await surfacedMessage(new RepositoryOwnerNameConflictError(claimedOwnerName));
    const parts = message.split(claimedOwnerName);
    expect(parts, `The surfaced message names ${claimedOwnerName} other than once: ${message}`).toHaveLength(2);
    const [before, after] = parts as [string, string];

    expect(
      exactMessageCells().filter((cell) => cell.startsWith(before) && cell.endsWith(after)),
      `README.md lists no exact message starting "${before}" and ending "${after}"`,
    ).toHaveLength(1);
  });
});

// The catalog is every row of every README table whose message column is headed `Exact message`,
// read back as the string the API emits: the cell without its surrounding code span.
function exactMessageCells(): string[] {
  const cells: string[] = [];
  let inCatalog = false;
  for (const line of readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8").split("\n")) {
    if (!line.startsWith("|")) {
      inCatalog = false;
      continue;
    }
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    if (columns[2] === "Exact message") {
      inCatalog = true;
      continue;
    }
    const message = columns[2];
    if (inCatalog && message !== undefined && message.startsWith("`") && message.endsWith("`")) {
      cells.push(message.slice(1, -1));
    }
  }
  if (cells.length === 0) {
    throw new Error("README.md published no exact message rows, so nothing was compared.");
  }
  return cells;
}

async function surfacedMessage(storeFailure: Error): Promise<string> {
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
      async createRepository() {
        throw storeFailure;
      },
    },
    webhook: {
      callbackUrl: "https://overflow.example/api/github/webhooks",
      secret: "webhook-secret-for-test",
    },
  };

  try {
    await registerRepository(dependencies, registrationInput());
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`Registration resolved instead of surfacing ${storeFailure.name}.`);
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
