import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "../../scripts/http-surface-derive.ts";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const fixtures = createOwnedTempDirectoryRegistry(join(repoRoot, ".next-release-type-edge-fixture-"));
afterAll(() => fixtures.dispose());

/** The real route graph and tooling, evaluated by the updater's native Node loader. */
function edgeFixture(declaration: string): string {
  const root = fixtures.create();
  for (const path of ["src", "scripts", "package.json"]) cpSync(join(repoRoot, path), join(root, path), { recursive: true });
  writeFileSync(join(root, "src/lib/http/type-edge.ts"), `import { errorResponse } from "./error-response.ts";
export type ReviewMarker = string;
(globalThis as typeof globalThis & { typeEdgeReached?: boolean }).typeEdgeReached = true;
export function latentFailure() { return errorResponse(418, "REVIEW_TYPE_EDGE", "probe"); }
`);
  const route = join(root, "src/app/api/account/route.ts");
  const source = readFileSync(route, "utf8");
  writeFileSync(route, `${source}\n${declaration} "../../../lib/http/type-edge.ts";\n`);
  return root;
}

describe("HTTP failure walk and native Node module edges", () => {
  it.each([
    { declaration: "import { type ReviewMarker } from", reached: true, recorded: true },
    { declaration: "export { type ReviewMarker } from", reached: true, recorded: true },
    { declaration: "import {} from", reached: true, recorded: true },
    { declaration: "export {} from", reached: true, recorded: true },
    { declaration: "import type { ReviewMarker } from", reached: false, recorded: false },
    { declaration: "export type { ReviewMarker } from", reached: false, recorded: false },
  ])("records the evaluated module for $declaration", ({ declaration, reached, recorded }) => {
    const root = edgeFixture(declaration);
    const env = { ...process.env };
    delete env.OVERFLOW_DATABASE_URL;
    const result = spawnSync(process.execPath, ["--experimental-transform-types", "--import",
      join(root, "scripts/register-path-aliases.ts"), "--input-type=module"], {
      cwd: root, env, encoding: "utf8", timeout: 90_000,
      input: `import { deriveHttpSurfaceRecord } from "./scripts/http-surface-record.ts";
const surface = await deriveHttpSurfaceRecord();
console.log(JSON.stringify({ reached: globalThis.typeEdgeReached === true,
  recorded: surface.failures["DELETE /api/account"].includes("418 REVIEW_TYPE_EDGE") }));`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ reached, recorded });
  });
});
