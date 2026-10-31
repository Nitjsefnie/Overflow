import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { productionClosure, productionClosureContains } from "./production-closure";

/**
 * Scoped acceptance records for braces, minimatch and glob advisories.
 * The dev-only Next lint chain reaches braces without a patched release.
 * ESLint requires minimatch ^10; eslint-plugin-import, eslint-plugin-jsx-a11y
 * and eslint-plugin-react require ^3 and break on 11's exports. Testcontainers
 * reaches glob ^10 via archiver 7 and archiver-utils 5. No compatible patched
 * parent releases are available for these paths; none is shipped in production.
 * Changes to the ignored IDs, audited versions or production closure require
 * re-disposition; the closure walk lives in ./production-closure.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));

const ACCEPTED_GHSAS = ["GHSA-vfj7-8cjw-p6xm", "GHSA-g3hv-75wg-m249", "GHSA-3g3m-2fjr-6pw4"];
const ACCEPTED_BRACES_VERSION = "3.0.3";

describe("dev-only advisory acceptance", () => {
  it("records exactly the accepted advisory ids in pnpm's audit config", async () => {
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    expect(pkg.pnpm?.auditConfig?.ignoreGhsas).toStrictEqual(ACCEPTED_GHSAS);
  });

  it("keeps the acceptance scoped to the lockfile's audited braces version", async () => {
    const lock = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
    const versions = [...lock.matchAll(/braces@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version).toBe(ACCEPTED_BRACES_VERSION);
    }
  });

  it.each([
    ["minimatch", ["3.1.5", "5.1.9", "9.0.9", "10.2.6"]],
    ["glob", ["10.5.0"]],
  ])("keeps the acceptance scoped to the lockfile's audited %s versions", async (name, expected) => {
    const lock = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
    const sections = lock.split(/^snapshots:$/m);
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      const versions = new Set([...section.matchAll(new RegExp(`^  ${name}@([^:()\\s]+)`, "gm"))].map((match) => match[1]));
      expect(versions.size).toBeGreaterThan(0);
      expect(versions).toEqual(new Set(expected));
    }
  });

  it.each(["braces", "minimatch", "glob"])("keeps %s out of the production dependency closure", async (name) => {
    const lock = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const rootProdDeps = Object.keys(pkg.dependencies ?? {});
    expect(rootProdDeps.length).toBeGreaterThan(0);
    const { names: closureNames } = productionClosure(lock);
    for (const name of rootProdDeps) {
      expect(closureNames.has(name)).toBe(true);
    }
    expect(closureNames.has(name)).toBe(false);
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

  it("fails closed when a production edge resolves to no snapshot (synthetic fixture)", () => {
    // The fail-closed contract: an edge resolving to neither `name@value`
    // nor an aliased snapshot id must THROW — a swallow-and-skip would read
    // an unresolvable production edge as "absent", exactly the false green
    // this guard exists to prevent.
    expect(() =>
      productionClosureContains(LOCK_FIXTURE_UNRESOLVABLE_EDGE, "braces")
    ).toThrow(/unresolved production edge "ghost: 9\.9\.9"/);
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

  it.each([
    ["minimatch", "3.1.5"],
    ["glob", "10.5.0"],
  ])("reports %s present when the real lockfile gains a fabricated production edge", async (name, version) => {
    const lock = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
    const anchor = "    dependencies:\n      next:\n";
    expect(lock.includes(anchor)).toBe(true);
    const planted = lock.replace(
      anchor,
      `    dependencies:\n      ${name}:\n        specifier: ${version}\n        version: ${version}\n      next:\n`,
    );
    expect(planted).not.toBe(lock);
    expect(productionClosureContains(planted, name)).toBe(true);
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

const LOCK_FIXTURE_UNRESOLVABLE_EDGE = `\
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
    dependencies:
      ghost: 9.9.9
`;
