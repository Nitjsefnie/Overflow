import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  baseCommit,
  git,
  repoRoot,
  shapeOf,
  shapesCompatible,
  type HttpShape,
} from "../../scripts/http-surface-derive.ts";
import { deriveHttpSurfaceRecord } from "../../scripts/http-surface-record.ts";
import {
  recordedSurface,
  type HttpSurfaceSnapshot,
} from "../../scripts/surface-change.ts";
import { SERVER_VERSION } from "@/lib/version";

import { readSurfaceSnapshotsAt } from "../../scripts/surface-snapshot-base.ts";
import { assertSnapshotVersions } from "../../scripts/surface-version.ts";
import type { McpSurfaceSnapshot } from "../../scripts/surface-change.ts";

const mcpSnapshot = JSON.parse(
  readFileSync(new URL("../../scripts/mcp-surface-snapshot.json", import.meta.url), "utf8"),
) as McpSurfaceSnapshot;
const snapshot = JSON.parse(
  readFileSync(new URL("../../scripts/http-surface-snapshot.json", import.meta.url), "utf8"),
) as HttpSurfaceSnapshot;

/** The surface the served routes derive to, computed once for every test that compares against it. */
let derivation: ReturnType<typeof deriveHttpSurfaceRecord> | undefined;
function derivedSurface(): ReturnType<typeof deriveHttpSurfaceRecord> {
  derivation ??= deriveHttpSurfaceRecord();
  return derivation;
}

const compatibilityCases: readonly {
  label: string;
  recorded: HttpShape;
  derived: HttpShape;
  compatible: boolean;
}[] = [
  { label: "the same scalar", recorded: "string", derived: "string", compatible: true },
  { label: "a changed scalar", recorded: "string", derived: "number", compatible: false },
  {
    label: "a pinned field the derived shape dropped",
    recorded: { a: "string" },
    derived: {},
    compatible: false,
  },
  {
    label: "a derived-only field as additive",
    recorded: { a: "string" },
    derived: { a: "string", b: "number" },
    compatible: true,
  },
  {
    label: "a nested type change",
    recorded: { a: { b: "string" } },
    derived: { a: { b: "number" } },
    compatible: false,
  },
  {
    label: "a nested object turned scalar",
    recorded: { a: { b: "string" } },
    derived: { a: "string" },
    compatible: false,
  },
  { label: "a pinned null held", recorded: { a: "null" }, derived: { a: "null" }, compatible: true },
  { label: "a pinned null widened", recorded: { a: "null" }, derived: { a: "number" }, compatible: false },
  {
    label: "a pinned list element type changed",
    recorded: "string",
    derived: "number",
    compatible: false,
  },
  {
    label: "an unpinned empty list revealed",
    recorded: "unknown",
    derived: "string",
    compatible: true,
  },
];

describe("HTTP surface snapshot", () => {
  it.each([
    { label: "a string", value: "x", shape: "string" },
    { label: "a number", value: 7, shape: "number" },
    { label: "a boolean", value: false, shape: "boolean" },
    { label: "null", value: null, shape: "null" },
    { label: "a list by its first element", value: [3], shape: "number" },
    { label: "an empty list as unpinned", value: [], shape: "unknown" },
    {
      label: "an object with fields sorted",
      value: { zeta: 1, alpha: null },
      shape: { alpha: "null", zeta: "number" },
    },
    { label: "a nested object recursing", value: { a: { b: [true] } }, shape: { a: { b: "boolean" } } },
  ])("derives the shape of $label", ({ value, shape }) => {
    expect(shapeOf(value)).toEqual(shape);
  });

  it.each(compatibilityCases)("judges $label $compatible", ({ recorded, derived, compatible }) => {
    expect(shapesCompatible(recorded, derived)).toBe(compatible);
  });

  it("records exactly the derived surface: shapes, error envelope, success statuses and failure answers", async () => {
    expect(
      recordedSurface(snapshot),
      "scripts/http-surface-snapshot.json does not record the derived HTTP surface (the error envelope, a " +
        "route's success status or its failure answers changed, or a route shape changed). Record it: " +
        "node --experimental-transform-types --import ./scripts/register-path-aliases.ts " +
        "scripts/update-http-surface-snapshot.ts",
    ).toEqual(await derivedSurface());
  });

  it("records the same version as the HTTP server", () => {
    expect(
      snapshot.httpServerVersion,
      `scripts/http-surface-snapshot.json records ${snapshot.httpServerVersion} but SERVER_VERSION is ${SERVER_VERSION}. ` +
        "The snapshot and the server version move together: run the update script — it moves the HTTP snapshot, " +
        "SERVER_VERSION, MCP_SERVER_VERSION, and the MCP snapshot's version in the same change.",
    ).toBe(SERVER_VERSION);
  });

  it("enforces the combined HTTP and MCP SemVer requirement", () => {
    assertNoBreakingRecordedChange(baseCommit(process.env.HTTP_SNAPSHOT_BASE_COMMIT, "HTTP"));
  });

  it.each([
    { version: "1.1.0", passes: false },
    { version: "1.1.1", passes: false },
    { version: "1.2.0", passes: true },
  ])("requires a minor move for an additive recorded change at $version", ({ version, passes }) => {
    const routes = { ...snapshot.routes };
    delete routes["GET /api/calibration"];
    const base = commitSnapshotFixture({ httpServerVersion: "1.1.0", routes });
    const check = () => assertNoBreakingRecordedChange(base, { ...snapshot, httpServerVersion: version });
    if (passes) expect(check).not.toThrow();
    else expect(check).toThrow(/needs at least 1\.2\.0.*update-http-surface-snapshot\.ts/);
  });

  it.each([
    { version: "1.2.0", passes: false },
    { version: "2.0.0", passes: true },
  ])("requires a major move for a breaking recorded change at $version", ({ version, passes }) => {
    const routes = structuredClone(snapshot.routes);
    (routes["GET /api/version"] as { version: string }).version = "number";
    const base = commitSnapshotFixture({ httpServerVersion: "1.1.0", routes });
    const check = () => assertNoBreakingRecordedChange(base, { ...snapshot, httpServerVersion: version });
    if (passes) expect(check).not.toThrow();
    else expect(check).toThrow(/needs 2\.0\.0.*update-http-surface-snapshot\.ts/);
  });

  it.each([
    {
      label: "a recorded failure answer removed",
      edit: (base: HttpSurfaceSnapshot) => {
        base.failures!["GET /api/version"] = ["418 SYNTHETIC_REMOVED_ANSWER"];
      },
    },
    {
      label: "a recorded success status changed",
      edit: (base: HttpSurfaceSnapshot) => {
        base.successStatus!["GET /api/version"] = 202;
      },
    },
    {
      label: "the recorded error envelope changed",
      edit: (base: HttpSurfaceSnapshot) => {
        base.errorEnvelope = { code: "string", detail: "string" };
      },
    },
  ])("fails $label against a synthetic base without a version move", ({ edit }) => {
    const base = structuredClone(snapshot);
    edit(base);
    expect(() => assertNoBreakingRecordedChange(commitSnapshotFixture(base))).toThrow(/needs 2\.0\.0/);
  });

  it("tolerates a base recorded before the envelope, statuses and failures were", () => {
    const base = commitSnapshotFixture({ httpServerVersion: snapshot.httpServerVersion, routes: snapshot.routes });
    expect(() => assertNoBreakingRecordedChange(base)).not.toThrow();
  });

  it("commits the synthetic fixture with no ambient git identity (the CI-runner case)", () => {
    // Actions runners carry no global or system git config and no identity
    // env, and a fresh clone's local config names nobody: the fixture commit
    // must not depend on any of it. Empty config files and unset identity env
    // scrub the stored sources; user.useConfigOnly then forbids the
    // hostname-based auto-detection that a well-named development box falls
    // back to (the runner has no FQDN and fails it as "empty ident name"),
    // so the spawn must carry its own identity to pass anywhere.
    const scratch = mkdtempSync(join(tmpdir(), "http-snapshot-identity-"));
    const emptyConfig = join(scratch, "empty-gitconfig");
    writeFileSync(emptyConfig, "");
    const identityEnv = [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ];
    const saved = new Map(identityEnv.map((name) => [name, process.env[name]]));
    for (const name of identityEnv) {
      delete process.env[name];
    }
    process.env.GIT_CONFIG_GLOBAL = emptyConfig;
    process.env.GIT_CONFIG_SYSTEM = emptyConfig;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.useConfigOnly";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    try {
      const base = commitSnapshotFixture({ httpServerVersion: snapshot.httpServerVersion, routes: {} });
      expect(git(["cat-file", "-t", base])).toBe("commit");
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

/** Both gates compare both surfaces at the same base and enforce the stronger move. */
function assertNoBreakingRecordedChange(base: string, current?: HttpSurfaceSnapshot): void {
  assertSnapshotVersions(readSurfaceSnapshotsAt(base), {
    http: current ?? snapshot,
    mcp: current ? { ...mcpSnapshot, mcpServerVersion: current.httpServerVersion } : mcpSnapshot,
  });
}

/**
 * Commits `snapshot` as scripts/http-surface-snapshot.json in a dangling
 * (ref-free) root commit, so a test can pin HTTP_SNAPSHOT_BASE_COMMIT-style
 * comparisons at an arbitrary recorded surface without moving any ref.
 */
function commitSnapshotFixture(snapshot: HttpSurfaceSnapshot): string {
  const scratch = mkdtempSync(join(tmpdir(), "http-snapshot-fixture-"));
  const file = join(scratch, "http-surface-snapshot.json");
  writeFileSync(file, JSON.stringify(snapshot, null, 2));
  const blob = gitInput(["hash-object", "-w", file]);
  const leaf = gitInput(["mktree"], `100644 blob ${blob}\thttp-surface-snapshot.json\n`);
  const root = gitInput(["mktree"], `040000 tree ${leaf}\tscripts\n`);
  return gitInput(["commit-tree", root, "-m", "synthetic HTTP snapshot fixture"], "");
}

/**
 * Runs git with the fixture's own identity pinned on the command line: a CI
 * runner has no global/system/local config naming an author (Actions died on
 * commit-tree with "empty ident name"), and the pinned -c identity outranks
 * every config source, so the commit never depends on anything ambient. The
 * `.invalid` domain cannot deliver mail.
 */
function gitInput(args: string[], input?: string): string {
  const result = spawnSync(
    "git",
    [
      "-c", "user.name=HTTP Snapshot Fixture",
      "-c", "user.email=http-snapshot-fixture@invalid",
      ...args,
    ],
    { cwd: repoRoot, encoding: "utf8", input },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
