import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baseCommit,
  deriveHttpSurfaceShapes,
  git,
  shapeOf,
  shapesCompatible,
  type HttpShape,
} from "../../scripts/http-surface-derive.ts";
import { SERVER_VERSION } from "@/lib/version";

const snapshotPath = "scripts/http-surface-snapshot.json";
const snapshot = JSON.parse(
  readFileSync(new URL("../../scripts/http-surface-snapshot.json", import.meta.url), "utf8"),
) as { httpServerVersion: string; routes: Record<string, HttpShape> };

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

  it("records shapes compatible with the served routes", async () => {
    const derived = await deriveHttpSurfaceShapes();
    const recordedKeys = Object.keys(snapshot.routes).sort();
    const derivedKeys = Object.keys(derived).sort();
    expect(
      derivedKeys,
      "The derived HTTP surface changed. Acknowledge it in the same change: " +
        "node --experimental-transform-types --import ./scripts/register-path-aliases.ts " +
        "scripts/update-http-surface-snapshot.ts --version <new> — it rewrites " +
        "scripts/http-surface-snapshot.json and moves SERVER_VERSION in src/lib/version.ts, " +
        "MCP_SERVER_VERSION in src/lib/mcp/protocol.ts, and the MCP snapshot's mcpServerVersion " +
        "together, so one version keeps covering the HTTP API and the MCP endpoint.",
    ).toEqual(recordedKeys);
    const incompatible = derivedKeys.filter((key) =>
      !shapesCompatible(snapshot.routes[key]!, derived[key]!),
    );
    expect(
      incompatible,
      "These documented routes' derived shapes are incompatible with scripts/http-surface-snapshot.json. " +
        "Removing or retyping a documented shape is breaking (policy in API.md): run the update script " +
        "with --version <new> to record the shape and move the server version in the same change.",
    ).toEqual([]);
  });

  it("records the same version as the HTTP server", () => {
    expect(
      snapshot.httpServerVersion,
      `scripts/http-surface-snapshot.json records ${snapshot.httpServerVersion} but SERVER_VERSION is ${SERVER_VERSION}. ` +
        "The snapshot and the server version move together: run the update script — it moves the HTTP snapshot, " +
        "SERVER_VERSION, MCP_SERVER_VERSION, and the MCP snapshot's version in the same change.",
    ).toBe(SERVER_VERSION);
  });

  it("never changes a recorded shape without moving the server version", () => {
    const base = baseCommit(process.env.HTTP_SNAPSHOT_BASE_COMMIT, "HTTP");
    const listing = git(["--literal-pathspecs", "ls-tree", "-z", base, "--", snapshotPath])
      .split("\0")[0]!;
    if (listing === "") {
      // This branch introduces the snapshot, so the base has no surface to compare.
      return;
    }
    const [entry, path] = listing.split("\t", 2);
    if (path !== snapshotPath || !entry?.startsWith("100644 blob ")) {
      throw new Error(`${snapshotPath} at ${base} is not a regular file`);
    }

    let previous: { httpServerVersion: string; routes: Record<string, HttpShape> };
    try {
      previous = JSON.parse(git(["show", `${base}:${snapshotPath}`])) as typeof previous;
    } catch (error) {
      throw new Error(`${snapshotPath} at ${base} could not be parsed: ${error}`);
    }

    const breaking = Object.entries(previous.routes)
      .filter(([key, previousShape]) =>
        !(key in snapshot.routes) || !shapesCompatible(previousShape, snapshot.routes[key]!),
      )
      .map(([key]) => key);
    if (breaking.length === 0) return;

    expect(
      snapshot.httpServerVersion,
      `The recorded HTTP surface changed incompatibly relative to ${base.slice(0, 8)} ` +
        `(${breaking.join(", ")}) but the version did not move (${previous.httpServerVersion}). ` +
        "Removing or retyping a documented shape is breaking (policy in API.md): move SERVER_VERSION " +
        "in src/lib/version.ts and record it in scripts/http-surface-snapshot.json in the same change.",
    ).not.toBe(previous.httpServerVersion);
  });
});
