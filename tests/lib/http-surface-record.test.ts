import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../scripts/http-surface-derive.ts";

/** Independent source tree, with normal dependency resolution from the parent checkout. */
function throwingFixture(): string {
  const root = mkdtempSync(join(repoRoot, ".next-release-record-fixture-"));
  for (const path of ["src", "scripts", "package.json"]) cpSync(join(repoRoot, path), join(root, path), { recursive: true });
  const path = join(root, "src/app/api/version/route.ts");
  const source = readFileSync(path, "utf8");
  writeFileSync(path, source.replace("export async function GET(): Promise<Response> {", `let calls = 0;
export async function GET(): Promise<Response> {
  const ordinal = ++calls;
  await Promise.resolve();
  if (ordinal === 1) throw new Error("DERIVATION_PROBE");`));
  return root;
}

function probe(root: string, count: number) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return spawnSync(process.execPath, ["--experimental-transform-types", "--import",
    join(root, "scripts/register-path-aliases.ts"), "--input-type=module"], {
    cwd: root, env, encoding: "utf8", timeout: 90_000,
    input: `import { deriveHttpSurfaceRecord } from "./scripts/http-surface-record.ts";
import { logPrivilegedAction } from "./src/lib/security/privileged-action-log.ts";
const info = console.info;
const results = await Promise.allSettled(Array.from({ length: ${count} }, () => deriveHttpSurfaceRecord()));
console.log("RESTORED", console.info === info);
console.log("OUTCOMES", JSON.stringify(results.map((result) => result.status)));
logPrivilegedAction({ action: "audit.open", actorId: "fixture-actor", credential: { kind: "session" },
  clientAddress: null, clientAddressVerified: false, subject: { auditId: "after-derivation-probe" } });`,
  });
}

describe("HTTP surface record logging lifecycle", () => {
  it.each([
    { label: "concurrent success", throws: false, count: 2, outcomes: '["fulfilled","fulfilled"]' },
    { label: "single rejection", throws: true, count: 1, outcomes: '["rejected"]' },
    { label: "overlapping rejection and success", throws: true, count: 2, outcomes: '["rejected","fulfilled"]' },
  ])("restores identity and real logging after $label", ({ throws, count, outcomes }) => {
    const result = probe(throws ? throwingFixture() : repoRoot, count);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`OUTCOMES ${outcomes}`);
    expect(result.stdout, result.stderr).toContain("RESTORED true");
    expect(result.stdout).toContain("after-derivation-probe");
    expect(result.stdout.match(/Privileged action/g)).toHaveLength(1);
  });
});
