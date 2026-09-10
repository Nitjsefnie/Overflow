import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const project = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The Edge Instrumentation bundle is the one bundle the server never runs: the
 * deployment serves from `next start` on the Node.js runtime alone. A
 * node:crypto module reaching it is dead code the bundler carries anyway, and
 * the build reports it as a warning that reads like a defect (issue 88).
 *
 * What is pinned here is a bundler fact, not a unit: that the production build
 * compiles the real project without loading a Node.js module into the Edge
 * Runtime at all. No source-shape assertion can stand in for it — whether an
 * import is pruned is decided by Turbopack's folding of the
 * `process.env.NEXT_RUNTIME` literal in src/instrumentation.ts, and only the
 * build itself observes that folding.
 *
 * The build runs against this real tree rather than a fixture because
 * Turbopack does not follow the symlinked node_modules a disposable fixture
 * needs, the way the webpack builds in release-build.test.ts do. It writes the
 * ordinary `.next`, which nothing else in the suite reads, and the build step
 * of the full chain runs after the suite, so the two never overlap. The env is
 * inherited as-is: CI provides the same placeholders at job level that the
 * chain does locally.
 */
it("builds without loading a Node.js module into the Edge Runtime", () => {
  const build = spawnSync(process.execPath, [path.join(project, "node_modules/next/dist/bin/next"), "build"], {
    cwd: project,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  // Exit 0 and a real compile, so a build that never ran cannot read as a pass
  // on the warning check below.
  expect(build.status, build.stdout + build.stderr).toBe(0);
  const output = build.stdout + build.stderr;
  expect(output).toContain("Compiled successfully");
  expect(output).not.toContain("not supported in the Edge Runtime");
}, 300_000);
