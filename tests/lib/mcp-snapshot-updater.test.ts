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
    { changed: false, kind: "none" as const, version: undefined, expected: "in-sync" },
    { changed: true, kind: "none" as const, version: undefined, expected: "record-current" },
    { changed: true, kind: "additive" as const, version: undefined, expected: "surface-refuse" },
    { changed: true, kind: "breaking" as const, version: undefined, expected: "surface-refuse" },
    { changed: true, kind: "additive" as const, version: "1.2.0", expected: "record" },
    { changed: true, kind: "breaking" as const, version: "2.0.0", expected: "record" },
    { changed: false, kind: "none" as const, version: "1.1.1", expected: "repair" },
  ])("chooses $expected for $kind at $version", ({ changed, kind, version, expected }) => {
    expect(decideSnapshotUpdate({ surfaceChanged: changed, changeKind: kind,
      snapshotVersion: "1.1.0", requestedVersion: version, protocolVersion: "1.1.0",
    })).toBe(expected);
  });

  it.each([
    { kind: "additive" as const, version: "1.1.0", minimum: "1.2.0" },
    { kind: "additive" as const, version: "1.1.1", minimum: "1.2.0" },
    { kind: "additive" as const, version: "2.0.0", minimum: "1.2.0" },
    { kind: "breaking" as const, version: "1.2.0", minimum: "2.0.0" },
    { kind: "none" as const, version: "1.0.9", minimum: "1.1.0" },
  ])("refuses $kind with insufficient version $version", ({ kind, version, minimum }) => {
    expect(() => decideSnapshotUpdate({ surfaceChanged: kind !== "none", changeKind: kind,
      snapshotVersion: "1.1.0", requestedVersion: version, protocolVersion: "1.1.0",
    })).toThrow(minimum);
  });

  it.each(["1.2.0-alpha", "1.2.0+build", "01.2.0", "1.2", "$$"])("refuses malformed version %s", (version) => {
    expect(() => decideSnapshotUpdate({ surfaceChanged: true, changeKind: "additive",
      snapshotVersion: "1.1.0", requestedVersion: version, protocolVersion: "1.1.0",
    })).toThrow(/MAJOR.MINOR.PATCH/);
  });

  it("refuses drift without a flag and repairs it explicitly", () => {
    const input = { surfaceChanged: false, changeKind: "none" as const, snapshotVersion: "1.1.0", protocolVersion: "1.0.0" };
    expect(decideSnapshotUpdate(input)).toBe("drift-refuse");
    expect(decideSnapshotUpdate({ ...input, requestedVersion: "1.1.0" })).toBe("repair");
  });

  it("requires an explicit version for the first snapshot", () => {
    const input = { surfaceChanged: true, changeKind: "none" as const, protocolVersion: "1.1.0" };
    expect(decideSnapshotUpdate(input)).toBe("surface-refuse");
    expect(decideSnapshotUpdate({ ...input, requestedVersion: "1.1.0" })).toBe("record");
  });
});
