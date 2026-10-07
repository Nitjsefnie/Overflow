import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { productionClosureContains } from "./production-closure";

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
 *   acceptance and forces re-disposition — that is the review trigger;
 * - braces stays ABSENT from the lockfile's production dependency closure —
 *   the property the acceptance rests on. A production dependency that pulls
 *   braces in leaves every pnpm audit green while shipping it; this check
 *   goes red the day that happens and forces re-disposition. The closure
 *   walk over pnpm-lock.yaml lives in ./production-closure.
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

  it("keeps braces out of the production dependency closure", async () => {
    const lock = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
    // The pinned property itself: the walk reports no braces snapshot
    // reachable from the root importer through production edges.
    expect(productionClosureContains(lock, "braces")).toBe(false);
    // Non-vacuity: the walk must also find every root production dependency
    // package.json declares, so a broken or empty closure cannot read as a
    // green "absent".
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const rootProdDeps = Object.keys(pkg.dependencies ?? {});
    expect(rootProdDeps.length).toBeGreaterThan(0);
    for (const name of rootProdDeps) {
      expect(productionClosureContains(lock, name)).toBe(true);
    }
  });

  it("reports braces present when a production edge pulls it in (synthetic fixture)", () => {
    // The walk must see through a production dependency chain: root
    // `prod-root` -> optional dependency `braces` -> `fill-range`. Optional
    // edges are production edges (pnpm installs them with the production
    // tree when their platform predicate holds), so they are followed.
    expect(productionClosureContains(LOCK_FIXTURE_PROD_BRACES, "braces")).toBe(true);
    expect(productionClosureContains(LOCK_FIXTURE_PROD_BRACES, "prod-root")).toBe(true);
    expect(productionClosureContains(LOCK_FIXTURE_PROD_BRACES, "fill-range")).toBe(true);
  });

  it("reports a dev-only braces chain outside the production closure (synthetic fixture)", () => {
    // The mirror property: braces reachable only through devDependencies
    // edges is outside the closure — that is exactly what licenses the real
    // repo's acceptance.
    expect(productionClosureContains(LOCK_FIXTURE_DEV_ONLY_BRACES, "braces")).toBe(false);
    expect(productionClosureContains(LOCK_FIXTURE_DEV_ONLY_BRACES, "prod-root")).toBe(true);
    expect(productionClosureContains(LOCK_FIXTURE_DEV_ONLY_BRACES, "dev-root")).toBe(false);
  });

  it("reports braces present when the real lockfile gains a fabricated production edge", async () => {
    // Watch-it-fail on the real tree: a string transformation of the actual
    // pnpm-lock.yaml that plants braces as a root production dependency must
    // flip the pinned property to "present". No file in the repository is
    // modified — the planted lockfile lives only in this test.
    const lock = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
    const anchor = "    dependencies:\n      next:\n";
    expect(lock.includes(anchor)).toBe(true);
    const planted = lock.replace(
      anchor,
      "    dependencies:\n"
      + "      braces:\n"
      + "        specifier: 3.0.3\n"
      + "        version: 3.0.3\n"
      + "      next:\n",
    );
    expect(planted).not.toBe(lock);
    expect(productionClosureContains(planted, "braces")).toBe(true);
  });
});

/**
 * Minimal pnpm-lock v9 fixtures shaped exactly like the real lockfile's
 * grammar: `importers:` root entry edges carrying nested `specifier:`/
 * `version:` pairs, `snapshots:` transitive edges whose values are the
 * target snapshot id suffixes, optional-dependency edges, and `{}`-empty
 * snapshots. The `packages:` section carries metadata only and is kept
 * minimal here — the closure walk reads no edge from it.
 */
const LOCK_FIXTURE_PROD_BRACES = `\
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      prod-root:
        specifier: 1.0.0
        version: 1.0.0

packages:
  prod-root@1.0.0:
    resolution: {integrity: sha512-fixture}

snapshots:
  prod-root@1.0.0:
    optionalDependencies:
      braces: 3.0.3
  braces@3.0.3:
    dependencies:
      fill-range: 7.1.1
  fill-range@7.1.1: {}
`;

const LOCK_FIXTURE_DEV_ONLY_BRACES = `\
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      prod-root:
        specifier: 1.0.0
        version: 1.0.0
    devDependencies:
      dev-root:
        specifier: 2.0.0
        version: 2.0.0

packages:
  prod-root@1.0.0:
    resolution: {integrity: sha512-fixture}
  dev-root@2.0.0:
    resolution: {integrity: sha512-fixture}

snapshots:
  prod-root@1.0.0: {}
  dev-root@2.0.0:
    dependencies:
      micromatch: 4.0.8
  micromatch@4.0.8:
    dependencies:
      braces: 3.0.3
  braces@3.0.3: {}
`;
