import { describe, expect, it } from "vitest";
import {
  buildConstAssignment,
  decideSnapshotUpdate,
  replaceConstAssignment,
} from "../../scripts/update-http-surface-snapshot.ts";

describe("HTTP snapshot updater", () => {
  it.each(["$$", "$&"])("writes the literal version %s into a const assignment", (version) => {
    const source = 'export const SERVER_VERSION = "0.3.0";\n';
    const expected = `export const SERVER_VERSION = ${JSON.stringify(version)};`;

    expect(buildConstAssignment("SERVER_VERSION", version)).toBe(expected);
    expect(replaceConstAssignment(source, "SERVER_VERSION", version)).toBe(`${expected}\n`);
  });

  it("requires exactly one assignment to replace", () => {
    const doubled =
      'export const SERVER_VERSION = "0.3.0";\nexport const SERVER_VERSION = "0.4.0";\n';
    expect(() => replaceConstAssignment(doubled, "SERVER_VERSION", "0.4.0")).toThrow(
      /exactly one SERVER_VERSION assignment/,
    );
    expect(() => replaceConstAssignment("no assignment here\n", "SERVER_VERSION", "0.4.0")).toThrow(
      /exactly one SERVER_VERSION assignment/,
    );
  });

  it.each([
    {
      label: "an unchanged, aligned surface without a flag",
      input: {
        surfaceChanged: false,
        surfaceCompatible: true,
        snapshotVersion: "0.3.0",
        requestedVersion: undefined,
        protocolVersion: "0.3.0",
      },
      expected: "in-sync",
    },
    {
      label: "an unchanged surface with protocol drift and no flag",
      input: {
        surfaceChanged: false,
        surfaceCompatible: true,
        snapshotVersion: "0.3.0",
        requestedVersion: undefined,
        protocolVersion: "0.2.0",
      },
      expected: "drift-refuse",
    },
    {
      label: "an unchanged surface with protocol drift and the recorded version requested",
      input: {
        surfaceChanged: false,
        surfaceCompatible: true,
        snapshotVersion: "0.3.0",
        requestedVersion: "0.3.0",
        protocolVersion: "0.2.0",
      },
      expected: "repair",
    },
    {
      label: "an unchanged surface with a new version requested",
      input: {
        surfaceChanged: false,
        surfaceCompatible: true,
        snapshotVersion: "0.1.0",
        requestedVersion: "0.4.0",
        protocolVersion: "0.3.0",
      },
      expected: "repair",
    },
    {
      label: "an additively changed surface without a flag",
      input: {
        surfaceChanged: true,
        surfaceCompatible: true,
        snapshotVersion: "0.3.0",
        requestedVersion: undefined,
        protocolVersion: "0.3.0",
      },
      expected: "record-additive",
    },
    {
      label: "an additively changed surface without a flag while the versions drift",
      input: {
        surfaceChanged: true,
        surfaceCompatible: true,
        snapshotVersion: "0.3.0",
        requestedVersion: undefined,
        protocolVersion: "0.2.0",
      },
      expected: "drift-refuse",
    },
    {
      label: "an additively changed surface with a version flag",
      input: {
        surfaceChanged: true,
        surfaceCompatible: true,
        snapshotVersion: "0.3.0",
        requestedVersion: "0.4.0",
        protocolVersion: "0.3.0",
      },
      expected: "record",
    },
    {
      label: "an incompatibly changed surface without a version flag",
      input: {
        surfaceChanged: true,
        surfaceCompatible: false,
        snapshotVersion: "0.3.0",
        requestedVersion: undefined,
        protocolVersion: "0.3.0",
      },
      expected: "surface-refuse",
    },
    {
      label: "an incompatibly changed surface with the recorded version requested",
      input: {
        surfaceChanged: true,
        surfaceCompatible: false,
        snapshotVersion: "0.3.0",
        requestedVersion: "0.3.0",
        protocolVersion: "0.3.0",
      },
      expected: "same-version-refuse",
    },
    {
      label: "an incompatibly changed surface with a new version requested",
      input: {
        surfaceChanged: true,
        surfaceCompatible: false,
        snapshotVersion: "0.3.0",
        requestedVersion: "0.4.0",
        protocolVersion: "0.3.0",
      },
      expected: "record",
    },
    {
      label: "a new snapshot with a requested version",
      input: {
        surfaceChanged: true,
        surfaceCompatible: false,
        snapshotVersion: undefined,
        requestedVersion: "0.1.0",
        protocolVersion: "0.0.0",
      },
      expected: "record",
    },
  ])("chooses $expected for $label", ({ input, expected }) => {
    expect(decideSnapshotUpdate(input)).toBe(expected);
  });
});
