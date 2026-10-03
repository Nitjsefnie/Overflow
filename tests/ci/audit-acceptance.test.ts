import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Acceptance record — GHSA-vfj7-8cjw-p6xm (braces <= 3.0.3, no patched
 * release exists). Disposition: scoped, recorded acceptance.
 *
 * Basis: the only vulnerable path is the dev-only lint chain
 * eslint-config-next -> @next/eslint-plugin-next -> fast-glob -> micromatch ->
 * braces. It never reaches the production dependency tree and is never
 * shipped. `pnpm.auditConfig.ignoreGhsas` in package.json records the
 * acceptance for pnpm's audit — the engine the dependency-audit workflow
 * runs — and this suite holds that record to its scope:
 *
 * - exactly one ignored advisory id, so widening to a blanket ignore fails
 *   here;
 * - every `braces@<semver>` token in the lockfile still 3.0.3, and at least
 *   one token present. Either a braces version change in the lockfile (e.g.
 *   a patched release gets adopted) or braces leaving the tree voids the
 *   acceptance and forces re-disposition — that is the review trigger.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));

const ACCEPTED_GHSA = "GHSA-vfj7-8cjw-p6xm";
const ACCEPTED_BRACES_VERSION = "3.0.3";

describe("braces advisory acceptance (GHSA-vfj7-8cjw-p6xm)", () => {
  it("records exactly the accepted advisory id in pnpm's audit config", async () => {
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    expect(pkg.pnpm?.auditConfig?.ignoreGhsas).toStrictEqual([ACCEPTED_GHSA]);
  });

  it("keeps the acceptance scoped to the lockfile's audited braces version", async () => {
    const lock = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
    const versions = [...lock.matchAll(/braces@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version).toBe(ACCEPTED_BRACES_VERSION);
    }
  });
});
