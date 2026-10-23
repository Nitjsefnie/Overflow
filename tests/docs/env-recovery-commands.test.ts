import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import MarkdownIt from "markdown-it";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const fixtures = createOwnedTempDirectoryRegistry(join(tmpdir(), "overflow-recovery-env-"));
const guide = readFileSync("deploy/README.md", "utf8");
const runbook = readFileSync("deploy/backup-restore.md", "utf8");
const blocks = (text: string): string[] => new MarkdownIt().parse(text, {})
  .filter((token: { type: string; info: string }) => token.type === "fence" && token.info === "bash")
  .map((token: { content: string }) => token.content);
const loading = blocks(guide.split("### Loading configuration for administrative commands")[1]?.split("### ")[0] ?? "")[0] ?? "";
const legacyUrl = "postgresql://legacy.invalid/overflow";
const canonicalUrl = "postgresql://canonical.invalid/overflow";

afterEach(() => fixtures.dispose());

function runCommands(body: string, configuration: string) {
  const directory = fixtures.create();
  writeFileSync(join(directory, "overflow.env"), configuration);
  const env = { ...process.env };
  for (const name of ["DATABASE_URL", "TOKEN_ENCRYPTION_KEY", "TOKEN_ENCRYPTION_KEY_PREVIOUS"]) {
    delete env[name];
    delete env[`OVERFLOW_${name}`];
  }
  const result = spawnSync("bash", ["-eu", "-c", body.replaceAll("overflow-<stamp>.dump", "overflow-fixture.dump").replaceAll("/etc/overflow", directory).replaceAll("/srv/overflow", directory)], {
    env, encoding: "utf8", cwd: directory,
  });
  return { ...result, directory };
}

describe("recovery commands read either environment spelling", () => {
  it("preserves an empty canonical URL and refuses backup despite a valid legacy URL", () => {
    const result = runCommands(`${loading}\nprintf '<%s>' "$OVERFLOW_DATABASE_URL"\nOVERFLOW_PG_DUMP=false bash "${process.cwd()}/scripts/db-backup.sh" --output-dir "$PWD/backups"`,
      `DATABASE_URL=${legacyUrl}\nOVERFLOW_DATABASE_URL=\n`);
    expect(result.stdout).toBe("<>");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set; refusing to guess which database to dump");
  });

  it.each([
    ["legacy", `DATABASE_URL=${legacyUrl}\n`, legacyUrl],
    ["canonical", `OVERFLOW_DATABASE_URL=${canonicalUrl}\n`, canonicalUrl],
    ["both", `DATABASE_URL=${legacyUrl}\nOVERFLOW_DATABASE_URL=${canonicalUrl}\n`, canonicalUrl],
  ])("uses the %s URL for restored copies and direct psql calls", (_name, configuration, expectedUrl) => {
    const restoreBlocks = blocks(runbook);
    const drill = restoreBlocks.find((block) => block.includes('scratch="overflow_drill_'))!;
    const restore = restoreBlocks.find((block) => block.includes("createdb -O overflow_app overflow_replacement"))!;
    const migration = restoreBlocks.find((block) => block.includes('replacement_url='))!;
    const listing = restoreBlocks.find((block) => block.includes('scratch_url='))!;
    expect(drill).toBeDefined();
    expect(restore).toBeDefined();
    expect(migration).toBeDefined();
    expect(listing).toBeDefined();
    const psqlBlocks = blocks(guide).filter((block) => block.includes('psql "$OVERFLOW_DATABASE_URL"') && block.includes("unregistered_at is not null"));
    expect(psqlBlocks).toHaveLength(2);
    const shims = 'sudo() { :; }; bash() { :; }; pnpm() { printf "%s\\n" "$OVERFLOW_DATABASE_URL"; }; psql() { printf "%s\\n" "$1"; }; node() { printf "%s\\n" "$OVERFLOW_DATABASE_URL"; };\n';
    const drillPreamble = drill.slice(0, drill.indexOf('scratch="overflow_drill_'));
    const result = runCommands(`${shims}${loading}\n${drillPreamble}\nscratch=overflow_drill_test\n${listing}\n${restore}\n${migration}\n${psqlBlocks.join("\n")}`, configuration);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${expectedUrl.replace(/\/overflow$/, "/overflow_drill_test")}\n`);
    const urls = result.stdout.trim().split("\n").filter((line) => line.startsWith("postgresql:"));
    expect(urls).toEqual([
      expectedUrl.replace(/\/overflow$/, "/overflow_drill_test"),
      expectedUrl.replace(/\/overflow$/, "/overflow_replacement"),
      expectedUrl, expectedUrl,
    ]);
  });

  it.each(["legacy", "canonical", "both"])("rotates the selected %s key line into canonical names", (spelling) => {
    const oldKey = randomBytes(32).toString("base64url");
    const otherKey = randomBytes(32).toString("base64url");
    const newKey = randomBytes(32).toString("base64url");
    const configuration = spelling === "legacy" ? `TOKEN_ENCRYPTION_KEY=${oldKey}\n`
      : `${spelling === "both" ? `TOKEN_ENCRYPTION_KEY=${otherKey}\n` : ""}OVERFLOW_TOKEN_ENCRYPTION_KEY=${oldKey}\n`;
    const rotation = blocks(guide).find((block) => block.includes("token-encryption-key.new does not hold"));
    expect(rotation).toBeDefined();
    const result = runCommands(`printf '%s' '${newKey}' > /etc/overflow/token-encryption-key.new\n${rotation}`, configuration);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(result.directory, "token-encryption-key.old"), "utf8").trim()).toBe(oldKey);
    const loaded = runCommands(`set -a; . /etc/overflow/overflow.env; set +a\nprintf '%s\\n' "$OVERFLOW_TOKEN_ENCRYPTION_KEY" "$OVERFLOW_TOKEN_ENCRYPTION_KEY_PREVIOUS"`, readFileSync(join(result.directory, "overflow.env"), "utf8"));
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout.trim().split("\n")).toEqual([newKey, oldKey]);
  });
});
