import { pathToFileURL } from "node:url";
import { closeSql, getSql } from "../src/lib/db/client.ts";
import { deleteAccount } from "../src/lib/accounts/deletion.ts";
import { exportAccount, formatAccountExport } from "../src/lib/accounts/export.ts";
import { exportForgePerson, forgePersonInstance, removeForgePerson } from "../src/lib/accounts/forge-person.ts";
import type { SqlClient } from "../src/lib/db/types.ts";

export type AccountCliDependencies = { sql: SqlClient; write(line: string): void };

const usageLine = "Usage: account.ts export --github-user-id <id> | delete --github-user-id <id> [--confirm]"
  + " | export-forge --provider github|gitlab --forge-id <id> [--instance-url <https-origin>] [--login <login>]"
  + " | remove-forge --provider github|gitlab --forge-id <id> [--instance-url <https-origin>] [--login <login>] [--confirm]";

type ParsedCommand =
  | { command: "export"; githubUserId: number }
  | { command: "delete"; githubUserId: number; confirm: boolean }
  | { command: "export-forge"; provider: string; forgeId: number; instanceUrl: string; login: string | null }
  | { command: "remove-forge"; provider: string; forgeId: number; instanceUrl: string; login: string | null; confirm: boolean };

/**
 * The argument grammar, parsed whole before anything touches the database:
 * `export|delete --github-user-id <positive safe integer>`, plus `--confirm`
 * on `delete` alone; `export-forge|remove-forge --provider github|gitlab
 * --forge-id <positive safe integer>`, plus `--instance-url <https-origin>`
 * (required for GitLab), `--login <nonblank>` and, on
 * `remove-forge` alone, `--confirm`. Anything else — a missing or unknown
 * subcommand, a missing, duplicated or malformed id, provider or login,
 * `--confirm` on `export` or `export-forge`, an account flag on a forge
 * command or a forge flag on an account command, any extra argument — is a
 * usage failure.
 */
function parseAccountCommand(argumentsList: readonly string[]): ParsedCommand | null {
  const [command, ...rest] = argumentsList;
  if (command !== "export" && command !== "delete" && command !== "export-forge" && command !== "remove-forge") {
    return null;
  }
  const forgeCommand = command === "export-forge" || command === "remove-forge";
  let githubUserId: number | undefined;
  let provider: string | undefined;
  let forgeId: number | undefined;
  let instanceUrl: string | undefined;
  let login: string | null = null;
  let confirm = false;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!;
    if (argument === "--github-user-id") {
      if (forgeCommand || githubUserId !== undefined) {
        return null;
      }
      const value = rest[++index];
      if (value === undefined || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        return null;
      }
      githubUserId = Number(value);
    } else if (argument === "--provider") {
      if (!forgeCommand || provider !== undefined) {
        return null;
      }
      const value = rest[++index];
      if (value !== "github" && value !== "gitlab") {
        return null;
      }
      provider = value;
    } else if (argument === "--forge-id") {
      if (!forgeCommand || forgeId !== undefined) {
        return null;
      }
      const value = rest[++index];
      if (value === undefined || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        return null;
      }
      forgeId = Number(value);
    } else if (argument === "--instance-url") {
      if (!forgeCommand || instanceUrl !== undefined) return null;
      const value = rest[++index];
      if (value === undefined || value.trim().length === 0) return null;
      instanceUrl = value;
    } else if (argument === "--login") {
      if (!forgeCommand || login !== null) {
        return null;
      }
      const value = rest[++index];
      if (value === undefined || value.trim().length === 0) {
        return null;
      }
      login = value.trim();
    } else if (argument === "--confirm") {
      if ((command !== "delete" && command !== "remove-forge") || confirm) {
        return null;
      }
      confirm = true;
    } else {
      return null;
    }
  }
  if (forgeCommand) {
    if (provider === undefined || forgeId === undefined) {
      return null;
    }
    try {
      instanceUrl = forgePersonInstance({ provider, forgeId, instanceUrl });
    } catch {
      return null;
    }
    return command === "export-forge"
      ? { command, provider, forgeId, instanceUrl, login }
      : { command, provider, forgeId, instanceUrl, login, confirm };
  }
  if (githubUserId === undefined) {
    return null;
  }
  return { command, githubUserId, confirm };
}

/**
 * The operator's account-deletion, account-export, and forge-keyed
 * data-subject entry point (issue 1071). Grammar violations are answered with
 * the usage line and exit 2 before any dependency, pooled client or database
 * access; every command failure is reported sanitized as
 * ACCOUNT_COMMAND_FAILED, never with a connection string.
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
    if (parsed.command === "export-forge") {
      write(JSON.stringify(await exportForgePerson(sql, {
        provider: parsed.provider, instanceUrl: parsed.instanceUrl, forgeId: parsed.forgeId, login: parsed.login,
      })));
      return 0;
    }
    if (parsed.command === "remove-forge") {
      const outcome = await removeForgePerson(sql, {
        provider: parsed.provider, instanceUrl: parsed.instanceUrl, forgeId: parsed.forgeId, login: parsed.login,
      }, { confirm: parsed.confirm });
      write(JSON.stringify(outcome));
      switch (outcome.kind) {
        case "SPONSOR_BLOCKED":
          return 1;
        case "PLANNED":
          return 3;
        case "REMOVED":
          return 0;
      }
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
