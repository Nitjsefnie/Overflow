import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../scripts/http-surface-derive.ts";

function probe(extra = "") {
  const root = mkdtempSync(join(repoRoot, ".next-release-non-envelope-fixture-"));
  for (const path of ["src", "scripts", "package.json"]) cpSync(join(repoRoot, path), join(root, path), { recursive: true });
  const route = join(root, "src/app/api/account/route.ts");
  const source = readFileSync(route, "utf8");
  writeFileSync(route, `${source}\n${extra}\n`);
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return spawnSync(process.execPath, ["--experimental-transform-types", "--import",
    join(root, "scripts/register-path-aliases.ts"), "--input-type=module"], {
    cwd: root, env, encoding: "utf8", timeout: 90_000,
    input: `import { deriveHttpSurfaceRecord } from "./scripts/http-surface-record.ts";
console.log(JSON.stringify(await deriveHttpSurfaceRecord()));`,
  });
}

describe("recorded non-envelope HTTP failure answers", () => {
  it("restores the error logger and emits only the real post-derivation error after concurrent calls", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(process.execPath, ["--experimental-transform-types", "--import",
      join(repoRoot, "scripts/register-path-aliases.ts"), "--input-type=module"], {
      cwd: repoRoot, env, encoding: "utf8", timeout: 90_000,
      input: `import { deriveHttpSurfaceRecord } from "./scripts/http-surface-record.ts";
const errors = [];
const sink = (...args) => errors.push(args);
console.error = sink;
await Promise.all([deriveHttpSurfaceRecord(), deriveHttpSurfaceRecord()]);
const restored = console.error === sink;
console.error("AFTER");
console.log(JSON.stringify({restored, errors}));`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({restored: true, errors: [["AFTER"]]});
  });

  it("invokes readiness's failure branch and derives its actual status and body shape", () => {
    const result = probe();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).nonEnvelopeFailures).toEqual({
      "GET /api/readiness": { unavailable: { status: 503, shape: { reason: "string", status: "string" } } },
    });
  });

  it.each([
    'Response.json({ bad: true }, { status: 400 })',
    'new Response("bad", { status: 402 })',
    'Response.json({ bad: true }, { status: Date.now() ? 200 : 403 })',
    'Response.json({ bad: true }, { status: Number(400) })',
    'Response.redirect("https://overflow.example")',
    'NextResponse.json({ bad: true }, { status: 404 })',
    'NextResponse.next({ status: 406 })',
  ])("refuses an unrecorded construction %s", (expression) => {
    const result = probe(`const NextResponse = Response;\nexport function hiddenFailure() { return ${expression}; }`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/src\/app\/api\/account\/route.ts:\d+:.*non-envelope/);
  });
});
