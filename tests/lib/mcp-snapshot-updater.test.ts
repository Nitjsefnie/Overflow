import { describe, expect, it } from "vitest";
import {
  buildVersionAssignment,
  decideSnapshotUpdate,
  replaceVersionAssignment,
} from "../../scripts/update-mcp-surface-snapshot.ts";

describe("MCP snapshot updater", () => {
  it.each(["$$", "$&"])("writes the literal version %s into the protocol assignment", (version) => {
    const source = 'export const MCP_SERVER_VERSION = "0.3.0";\n';
    const expected = `export const MCP_SERVER_VERSION = ${JSON.stringify(version)};`;

    expect(buildVersionAssignment(version)).toBe(expected);
    expect(replaceVersionAssignment(source, version)).toBe(`${expected}\n`);
  });

  it.each([
    {
      label: "an unchanged, aligned surface without a flag",
      input: { surfaceChanged: false, snapshotVersion: "0.3.0", requestedVersion: undefined, protocolVersion: "0.3.0" },
      expected: "in-sync",
    },
    {
      label: "an unchanged surface with protocol drift and no flag",
      input: { surfaceChanged: false, snapshotVersion: "0.3.0", requestedVersion: undefined, protocolVersion: "0.2.0" },
      expected: "drift-refuse",
    },
    {
      label: "an unchanged surface with protocol drift and the recorded version requested",
      input: { surfaceChanged: false, snapshotVersion: "0.3.0", requestedVersion: "0.3.0", protocolVersion: "0.2.0" },
      expected: "repair",
    },
    {
      label: "an unchanged surface with a new version requested",
      input: { surfaceChanged: false, snapshotVersion: "0.3.0", requestedVersion: "0.4.0", protocolVersion: "0.3.0" },
      expected: "repair",
    },
    {
      label: "a changed surface without a version flag",
      input: { surfaceChanged: true, snapshotVersion: "0.3.0", requestedVersion: undefined, protocolVersion: "0.3.0" },
      expected: "surface-refuse",
    },
    {
      label: "a changed surface with the recorded version requested",
      input: { surfaceChanged: true, snapshotVersion: "0.3.0", requestedVersion: "0.3.0", protocolVersion: "0.3.0" },
      expected: "same-version-refuse",
    },
    {
      label: "a changed surface with a new version requested",
      input: { surfaceChanged: true, snapshotVersion: "0.3.0", requestedVersion: "0.4.0", protocolVersion: "0.3.0" },
      expected: "record",
    },
    {
      label: "a new snapshot with a requested version",
      input: { surfaceChanged: true, snapshotVersion: undefined, requestedVersion: "0.1.0", protocolVersion: "0.0.0" },
      expected: "record",
    },
  ])("chooses $expected for $label", ({ input, expected }) => {
    expect(decideSnapshotUpdate(input)).toBe(expected);
  });
});
