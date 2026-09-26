import { pathToFileURL } from "node:url";
import { closeSql, getSql } from "../src/lib/db/client.ts";
import type { SqlClient } from "../src/lib/db/types.ts";
import {
  credentialBinding,
  decryptToken,
  encryptToken,
  isEnvelopeCurrent,
  loadTokenKeySet,
  type CredentialBinding,
  type TokenKeySet,
} from "../src/lib/security/token-cipher.ts";

/**
 * Rewrites every stored credential that is not yet a v2 envelope under the
 * current key: it is opened with {current, previous} and sealed again under
 * the current key with its row binding. Once `--check` passes, the previous
 * key can be retired.
 *
 * Output is JSON lines naming tables, columns, row ids and counts only; no
 * plaintext, key or ciphertext is ever written.
 */

type KeyRow = Record<string, string | number>;

/** A ciphertext column, the natural-key columns its binding is built from, and that binding. */
export type CredentialColumn = {
  readonly table: string;
  readonly column: string;
  readonly keyColumns: readonly string[];
  bind(row: KeyRow): CredentialBinding;
};

export const credentialColumns: readonly CredentialColumn[] = [
  {
    table: "users",
    column: "encrypted_oauth_token",
    keyColumns: ["github_user_id"],
    bind: (row) => credentialBinding.userOAuthToken(row.github_user_id!),
  },
  {
    table: "user_forge_identities",
    column: "encrypted_token",
    keyColumns: ["provider", "instance_url", "forge_user_id"],
    bind: (row) => credentialBinding.forgeToken({
      provider: String(row.provider), instanceUrl: String(row.instance_url), forgeUserId: row.forge_user_id!,
    }),
  },
  {
    table: "registered_repositories",
    column: "encrypted_webhook_secret",
    keyColumns: ["webhook_credential_id"],
    bind: (row) => credentialBinding.webhookSecret(String(row.webhook_credential_id)),
  },
];

/** A stored ciphertext, the natural-key values its binding was built from as read, and that binding. */
export type StoredCredential = {
  id: string;
  envelope: Buffer;
  naturalKey: Readonly<KeyRow>;
  binding: CredentialBinding;
};

export type CredentialStore = {
  /** Rows with a non-NULL ciphertext and an id after `afterId`, in id order. */
  readBatch(column: CredentialColumn, afterId: string | null, limit: number): Promise<StoredCredential[]>;
  /**
   * Replaces the ciphertext only if the row still holds the ciphertext and natural key it was read with;
   * false when a concurrent write got there first.
   */
  replaceIfUnchanged(column: CredentialColumn, credential: StoredCredential, next: Buffer): Promise<boolean>;
};

export function postgresCredentialStore(sql: SqlClient): CredentialStore {
  return {
    async readBatch(column, afterId, limit) {
      const rows = await sql<(KeyRow & { id: string; envelope: Buffer })[]>`
        select id, ${sql(column.column)} as envelope, ${sql(column.keyColumns as string[])}
        from ${sql(column.table)}
        where ${sql(column.column)} is not null and (${afterId}::uuid is null or id > ${afterId}::uuid)
        order by id
        limit ${limit}
      `;
      return rows.map((row) => {
        const naturalKey = Object.fromEntries(column.keyColumns.map((name) => [name, row[name]!]));
        return { id: row.id, envelope: Buffer.from(row.envelope), naturalKey, binding: column.bind(naturalKey) };
      });
    },
    async replaceIfUnchanged(column, credential, next) {
      // The new envelope is bound to the natural key as read, so a row whose key moved since is left alone.
      const sameNaturalKey = column.keyColumns.reduce(
        (fragment, name) => sql`${fragment} and ${sql(name)} = ${credential.naturalKey[name]!}`,
        sql``,
      );
      const result = await sql`
        update ${sql(column.table)} set ${sql(column.column)} = ${next}
        where id = ${credential.id} and ${sql(column.column)} = ${credential.envelope} ${sameNaturalKey}
      `;
      return result.count === 1;
    },
  };
}

export type CredentialReencryptionCliDependencies = {
  store: CredentialStore;
  keys: TokenKeySet;
  write(line: string): void;
  batchSize?: number;
};

const defaultBatchSize = 200;

async function* storedCredentials(store: CredentialStore, column: CredentialColumn, batchSize: number) {
  let afterId: string | null = null;
  for (;;) {
    const batch = await store.readBatch(column, afterId, batchSize);
    yield* batch;
    if (batch.length < batchSize) return;
    afterId = batch.at(-1)!.id;
  }
}

async function checkColumn(dependencies: Required<CredentialReencryptionCliDependencies>, column: CredentialColumn) {
  let current = 0;
  let notCurrent = 0;
  for await (const credential of storedCredentials(dependencies.store, column, dependencies.batchSize)) {
    if (isEnvelopeCurrent(credential.envelope.toString("utf8"), dependencies.keys.current)) current++;
    else notCurrent++;
  }
  return { table: column.table, column: column.column, current, notCurrent };
}

async function reencryptColumn(dependencies: Required<CredentialReencryptionCliDependencies>, column: CredentialColumn) {
  const { store, keys, write } = dependencies;
  const counts = { reencrypted: 0, alreadyCurrent: 0, skipped: 0, failed: 0 };
  for await (const credential of storedCredentials(store, column, dependencies.batchSize)) {
    const envelope = credential.envelope.toString("utf8");
    if (isEnvelopeCurrent(envelope, keys.current)) {
      counts.alreadyCurrent++;
      continue;
    }
    let plaintext: string;
    try {
      plaintext = decryptToken(envelope, keys, credential.binding);
    } catch {
      counts.failed++;
      write(JSON.stringify({ table: column.table, id: credential.id, failure: "UNDECRYPTABLE" }));
      continue;
    }
    const next = Buffer.from(encryptToken(plaintext, keys.current, credential.binding), "utf8");
    if (await store.replaceIfUnchanged(column, credential, next)) counts.reencrypted++;
    else counts.skipped++;
  }
  return { table: column.table, column: column.column, ...counts };
}

export async function runCredentialReencryptionCli(
  argumentsList: readonly string[] = process.argv.slice(2),
  dependencies?: CredentialReencryptionCliDependencies,
): Promise<number> {
  const batchSize = dependencies?.batchSize ?? defaultBatchSize;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    // Only an in-process caller can pass one; a non-positive size would never finish a column.
    throw new RangeError("Batch size must be a positive integer.");
  }
  const write = dependencies?.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const check = argumentsList.length === 1 && argumentsList[0] === "--check";
  if (argumentsList.length > 0 && !check) {
    write("Usage: pnpm credentials:reencrypt [--check] [--help]");
    return argumentsList.length === 1 && argumentsList[0] === "--help" ? 0 : 2;
  }
  let keys: TokenKeySet;
  try {
    keys = dependencies?.keys ?? loadTokenKeySet(process.env);
  } catch {
    write(JSON.stringify({ failure: "KEYS_INVALID" }));
    return 1;
  }
  try {
    const resolved = {
      store: dependencies?.store ?? postgresCredentialStore(getSql()),
      keys,
      batchSize,
      write,
    };
    let clean = true;
    for (const column of credentialColumns) {
      if (check) {
        const summary = await checkColumn(resolved, column);
        clean &&= summary.notCurrent === 0;
        write(JSON.stringify(summary));
      } else {
        const summary = await reencryptColumn(resolved, column);
        clean &&= summary.failed === 0;
        write(JSON.stringify(summary));
      }
    }
    return clean ? 0 : 1;
  } catch {
    write(JSON.stringify({ failure: "REENCRYPTION_FAILED" }));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runCredentialReencryptionCli();
  } finally {
    try {
      await closeSql();
    } catch {
      process.stdout.write(`${JSON.stringify({ failure: "CLOSE_FAILED" })}\n`);
      process.exitCode = 1;
    }
  }
}
