import { describe, expect, it } from "vitest";
import {
  credentialColumns,
  runCredentialReencryptionCli,
  type CredentialStore,
  type StoredCredential,
} from "../../scripts/reencrypt-credentials";
import { encryptToken, type TokenKeySet } from "@/lib/security/token-cipher";
import { legacyV1Envelope, legacyV1Key } from "../support/legacy-token-envelope";

const keys: TokenKeySet = {
  current: Buffer.alloc(32, 61).toString("base64url"),
  previous: Buffer.alloc(32, 62).toString("base64url"),
};
const connectionString = "postgres://reencrypt:hunter2@database.internal:5432/overflow";
const leakedEnvelope = "v2.bGVha2VkLWtpZA.bGVha2VkLWl2.bGVha2VkLXRhZw.bGVha2VkLWNpcGhlcnRleHQ";
const usersColumn = credentialColumns[0]!;

function databaseFailure(): Error {
  return new Error(`connection to ${connectionString} failed while writing ${leakedEnvelope}`);
}

function untouchableStore(): CredentialStore {
  return {
    readBatch: async () => { throw new Error("must not read the database"); },
    replaceIfUnchanged: async () => { throw new Error("must not write the database"); },
  };
}

function previousKeyRow(): StoredCredential {
  const naturalKey = { github_user_id: "7001" };
  const binding = usersColumn.bind(naturalKey);
  return {
    id: "00000000-0000-4000-8000-000000000001",
    envelope: Buffer.from(encryptToken("oauth-token", keys.previous!, binding), "utf8"),
    naturalKey,
    binding,
  };
}

async function run(
  argumentsList: readonly string[],
  store: CredentialStore,
  options: { keys?: TokenKeySet; batchSize?: number } = {},
) {
  const lines: string[] = [];
  const code = await runCredentialReencryptionCli(argumentsList, {
    store, keys: options.keys ?? keys, batchSize: options.batchSize, write: (line) => { lines.push(line); },
  });
  return { code, lines };
}

function expectNoSecrets(lines: readonly string[]): void {
  const output = lines.join("\n");
  for (const secret of ["hunter2", connectionString, leakedEnvelope, "Error", "at "]) {
    expect(output).not.toContain(secret);
  }
}

describe("credential re-encryption CLI failure paths", () => {
  it.each([[[]], [["--check"]]])(
    "exits 1 with a sanitized failure when reading %j throws mid-run",
    async (argumentsList) => {
      const store: CredentialStore = {
        readBatch: async (column) => {
          if (column.table === "users") return [];
          throw databaseFailure();
        },
        replaceIfUnchanged: async () => { throw new Error("must not write"); },
      };

      const result = await run(argumentsList, store);

      expect(result.code).toBe(1);
      const firstColumn = argumentsList.length === 0
        ? { table: "users", column: "encrypted_oauth_token", reencrypted: 0, alreadyCurrent: 0, skipped: 0, failed: 0 }
        : { table: "users", column: "encrypted_oauth_token", current: 0, notCurrent: 0 };
      expect(result.lines).toEqual([JSON.stringify(firstColumn), JSON.stringify({ failure: "REENCRYPTION_FAILED" })]);
      expectNoSecrets(result.lines);
    },
  );

  it("exits 1 with a sanitized failure when a compare-and-swap write throws", async () => {
    const row = previousKeyRow();
    const store: CredentialStore = {
      readBatch: async (column, afterId) => (column.table === "users" && afterId === null ? [row] : []),
      replaceIfUnchanged: async () => { throw databaseFailure(); },
    };

    const result = await run([], store);

    expect(result.code).toBe(1);
    expect(result.lines).toEqual([JSON.stringify({ failure: "REENCRYPTION_FAILED" })]);
    expectNoSecrets(result.lines);
    expect(result.lines.join("\n")).not.toContain(row.envelope.toString("utf8"));
  });

  it("counts a v1 envelope as notCurrent under --check and reports it failed/UNDECRYPTABLE without a write", async () => {
    const naturalKey = { github_user_id: "8001" };
    const legacyRow: StoredCredential = {
      id: "00000000-0000-4000-8000-00000000000a",
      envelope: Buffer.from(legacyV1Envelope, "utf8"),
      naturalKey,
      binding: usersColumn.bind(naturalKey),
    };
    const store: CredentialStore = {
      readBatch: async (column, afterId) => (column.table === "users" && afterId === null ? [legacyRow] : []),
      replaceIfUnchanged: async () => { throw new Error("must not write an undecryptable row"); },
    };

    const checked = await run(["--check"], store, { keys: { current: legacyV1Key } });

    expect(checked.code).toBe(1);
    expect(checked.lines).toEqual([
      JSON.stringify({ table: "users", column: "encrypted_oauth_token", current: 0, notCurrent: 1 }),
      JSON.stringify({
        table: "user_forge_identities", column: "encrypted_token", current: 0, notCurrent: 0,
      }),
      JSON.stringify({ table: "registered_repositories", column: "encrypted_webhook_secret", current: 0, notCurrent: 0 }),
    ]);

    const result = await run([], store, { keys: { current: legacyV1Key } });

    expect(result.code).toBe(1);
    expect(result.lines).toEqual([
      JSON.stringify({ table: "users", id: legacyRow.id, failure: "UNDECRYPTABLE" }),
      JSON.stringify({
        table: "users", column: "encrypted_oauth_token", reencrypted: 0, alreadyCurrent: 0, skipped: 0, failed: 1,
      }),
      JSON.stringify({
        table: "user_forge_identities", column: "encrypted_token", reencrypted: 0, alreadyCurrent: 0, skipped: 0, failed: 0,
      }),
      JSON.stringify({
        table: "registered_repositories", column: "encrypted_webhook_secret",
        reencrypted: 0, alreadyCurrent: 0, skipped: 0, failed: 0,
      }),
    ]);
    expectNoSecrets(result.lines);
    expect(result.lines.join("\n")).not.toContain(legacyV1Envelope);
  });

  it.each([[["--force"], 2], [["--check", "--help"], 2], [["--unknown", "secret-token"], 2], [["--help"], 0]] as const)(
    "prints only the usage line for arguments %j, touching no database",
    async (argumentsList, code) => {
      const result = await run(argumentsList, untouchableStore());

      expect(result).toEqual({ code, lines: ["Usage: pnpm credentials:reencrypt [--check] [--help]"] });
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects batch size %d before touching the database",
    async (batchSize) => {
      await expect(run([], untouchableStore(), { batchSize }))
        .rejects.toThrow(new RangeError("Batch size must be a positive integer."));
      await expect(run(["--check"], untouchableStore(), { batchSize }))
        .rejects.toThrow(new RangeError("Batch size must be a positive integer."));
    },
  );
});
