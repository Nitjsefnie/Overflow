import { pathToFileURL } from "node:url";
import { closeSql, getSql } from "../src/lib/db/client.ts";
import { deleteAccount } from "../src/lib/accounts/deletion.ts";
import { exportAccount, formatAccountExport } from "../src/lib/accounts/export.ts";
import type { SqlClient } from "../src/lib/db/types.ts";

export type AccountCliDependencies = { sql: SqlClient; write(line: string): void };

const usageLine = "Usage: account.ts export --github-user-id <id> | delete --github-user-id <id> [--confirm]";

type ParsedCommand =
  | { command: "export"; githubUserId: number }
  | { command: "delete"; githubUserId: number; confirm: boolean };

/**
 * The argument grammar, parsed whole before anything touches the database:
 * `export|delete --github-user-id <positive safe integer>`, plus `--confirm`
 * on `delete` alone. Anything else — a missing or unknown subcommand, a
 * missing, duplicated or malformed id, `--confirm` on `export`, any extra
 * argument — is a usage failure.
 */
function parseAccountCommand(argumentsList: readonly string[]): ParsedCommand | null {
  const [command, ...rest] = argumentsList;
  if (command !== "export" && command !== "delete") {
    return null;
  }
  let githubUserId: number | undefined;
  let confirm = false;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!;
    if (argument === "--github-user-id") {
      if (githubUserId !== undefined) {
        return null;
      }
      const value = rest[++index];
      if (value === undefined || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        return null;
      }
      githubUserId = Number(value);
    } else if (argument === "--confirm") {
      if (command !== "delete" || confirm) {
        return null;
      }
      confirm = true;
    } else {
      return null;
    }
  }
  if (githubUserId === undefined) {
    return null;
  }
  return { command, githubUserId, confirm };
}

/**
 * The operator's account-deletion and account-export entry point. Grammar
 * violations are answered with the usage line and exit 2 before any
 * dependency, pooled client or database access; every command failure is
 * reported sanitized as ACCOUNT_COMMAND_FAILED, never with a connection
 * string.
 */
export async function runAccountCli(
  argumentsList: readonly string[] = process.argv.slice(2),
  dependencies?: AccountCliDependencies,
): Promise<number> {
  const write = dependencies?.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const parsed = parseAccountCommand(argumentsList);
  if (parsed === null) {
    write(usageLine);
    return 2;
  }
  try {
    const sql = dependencies?.sql ?? getSql();
    if (parsed.command === "export") {
      const document = await exportAccount(sql, parsed.githubUserId);
      if (document === null) {
        write(JSON.stringify({ failure: "UNKNOWN_ACCOUNT", githubUserId: parsed.githubUserId }));
        return 1;
      }
      write(formatAccountExport(document));
      return 0;
    }
    const outcome = await deleteAccount(sql, parsed.githubUserId, { confirm: parsed.confirm });
    write(JSON.stringify(outcome));
    switch (outcome.kind) {
      case "UNKNOWN_ACCOUNT":
      case "SPONSOR_BLOCKED":
        return 1;
      case "PLANNED":
        return 3;
      case "DELETED":
        return 0;
    }
  } catch {
    write(JSON.stringify({ failure: "ACCOUNT_COMMAND_FAILED" }));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runAccountCli();
  } finally {
    try {
      await closeSql();
    } catch {
      process.stdout.write(`${JSON.stringify({ failure: "CLOSE_FAILED" })}\n`);
      process.exitCode = 1;
    }
  }
}
