import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const reconciliationSection = readme.split(/^## Reconciliation\r?$/m)[1]?.split(/^## /m)[0] ?? "";
const documentedCommands = [...reconciliationSection.matchAll(/^```bash\r?\n([\s\S]*?)^```\s*$/gm)]
  .flatMap((block) => block[1]!.split(/\r?\n/))
  .filter((line) => /^pnpm reconcile(?:\s|$)/.test(line));
const databaseError = "DATABASE_URL must be configured before using the database.";

function runCommand(command: string) {
  // Replace the README's owner/name placeholder with a syntactically valid repository.
  const [executable, ...argumentsList] = command.replaceAll("<owner>/<name>", "octocat/hello-world").split(/\s+/);
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  const result = spawnSync(executable!, argumentsList, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
  });
  // A missing pnpm executable or a timed-out child is a failure, never a skip.
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();
  expect(result.status).not.toBe(0);
  return result;
}

describe("documented reconciliation CLI commands", () => {
  it("extracts at least two commands from the Reconciliation bash block", () => {
    expect(documentedCommands.length).toBeGreaterThanOrEqual(2);
  });

  it.each(documentedCommands)("loads and parses %s before requiring a database", (command) => {
    const { stderr } = runCommand(command);
    for (const loadingError of [
      "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
      "ERR_MODULE_NOT_FOUND",
      "Cannot find package",
      "SyntaxError",
    ]) {
      expect(stderr).not.toContain(loadingError);
    }
    expect(stderr).toContain(databaseError);
  }, 120_000);

  it("reports invalid arguments before requiring a database", () => {
    const { stderr } = runCommand("pnpm reconcile --not-a-flag");
    expect(stderr).toContain("Usage: pnpm reconcile [--repository owner/name]");
    expect(stderr).not.toContain(databaseError);
  }, 120_000);
});
