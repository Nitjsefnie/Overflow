import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../../scripts/container-build.sh", import.meta.url));
const script = readFileSync(scriptPath, "utf8");

/**
 * Issue 461: the committed mechanical build path for the container route.
 * The script turns the Dockerfile's provenance machinery (mandatory
 * SOURCE_SHA, revision label, label verification) into one command an
 * operator can run and trust, so the pins below hold its contract textually,
 * the way tests/deploy/unit-file.test.ts pins the unit file: what the script
 * must refuse, what it must build with, what it must verify, and what it
 * must print for rollback to select.
 */
describe("scripts/container-build.sh", () => {
  it("is executable, parses as bash, and runs under strict mode", () => {
    expect(statSync(scriptPath).mode & 0o111, "the executable bit").not.toBe(0);
    expect(spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" }).status).toBe(0);
    expect(script).toContain("set -euo pipefail");
  });

  it("builds from the repository root resolved from the script's own location", () => {
    expect(script).toContain('cd "$(dirname "$0")/.."');
  });

  it("refuses a dirty tree before building, so the revision label names committed source", () => {
    expect(script).toContain("git status --porcelain");
    expect(script).toContain("the revision label must name reviewed committed source");
  });

  it("builds with the full source SHA from git rev-parse HEAD, defaulting the tag to overflow-app", () => {
    expect(script).toContain('source_sha="$(git rev-parse HEAD)"');
    expect(script).toContain('docker build --build-arg SOURCE_SHA="$source_sha"');
    expect(script).toContain('image="${1:-overflow-app}"');
  });

  it("verifies the revision label landed, comparing against git rev-parse HEAD, and refuses an unlabelled image", () => {
    expect(script).toContain('index .Config.Labels "org.opencontainers.image.revision"');
    expect(script).toContain('if [ "$landed" != "$source_sha" ]');
    expect(script).toContain("do not deploy it");
  });

  it("prints the immutable provenance record rollback selects", () => {
    expect(script).toContain("Provenance record");
    expect(script).toContain("rollback");
    expect(script).toContain("revision:");
    expect(script).toContain("image ID:");
    expect(script).toContain("RepoDigests:");
    expect(script).toContain("created:");
  });
});
