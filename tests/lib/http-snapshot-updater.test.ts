import { describe, expect, it } from "vitest";
import {
  buildConstAssignment,
  decideSnapshotUpdate,
  replaceConstAssignment,
  serializedSnapshot,
  surfaceUpdateInputs,
} from "../../scripts/update-http-surface-snapshot.ts";
import type { DerivedHttpSurface } from "../../scripts/surface-change.ts";

function derived(): DerivedHttpSurface {
  return {
    snapshotFormat: 2,
    errorEnvelope: { error: { code: "string", message: "string" } },
    routes: { "GET /a": { id: "string" } },
    successStatus: { "GET /a": 200 },
    failures: { "GET /a": ["401 UNAUTHENTICATED", "403 FORBIDDEN"] },
  };
}

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

  it.each([
    { label: "a missing snapshot", snapshot: () => undefined, changed: true, kind: "breaking" },
    {
      label: "an identical recorded surface",
      snapshot: () => ({ httpServerVersion: "1.1.0", ...derived() }),
      changed: false,
      kind: "none",
    },
    {
      label: "a snapshot recorded before the envelope, statuses and failures were",
      snapshot: () => ({ httpServerVersion: "1.1.0", routes: derived().routes }),
      changed: true,
      kind: "none",
    },
    {
      label: "a recorded failure answer the derivation no longer gives",
      snapshot: () => {
        const recorded = { httpServerVersion: "1.1.0", ...derived() };
        recorded.failures["GET /a"] = [...recorded.failures["GET /a"]!, "409 CONFLICT"];
        return recorded;
      },
      changed: true,
      kind: "breaking",
    },
    {
      label: "a failure answer the recording lacks",
      snapshot: () => {
        const recorded = { httpServerVersion: "1.1.0", ...derived() };
        recorded.failures["GET /a"] = ["401 UNAUTHENTICATED"];
        return recorded;
      },
      changed: true,
      kind: "additive",
    },
    {
      label: "a recorded success status the derivation changed",
      snapshot: () => {
        const recorded = { httpServerVersion: "1.1.0", ...derived() };
        recorded.successStatus["GET /a"] = 201;
        return recorded;
      },
      changed: true,
      kind: "breaking",
    },
  ])("judges $label changed=$changed kind=$kind", ({ snapshot, changed, kind }) => {
    expect(surfaceUpdateInputs(snapshot(), derived())).toEqual({
      surfaceChanged: changed,
      changeKind: kind,
    });
  });

  it("serializes the format marker and version ahead of the recorded sections", () => {
    const text = serializedSnapshot("1.1.0", derived());
    expect(Object.keys(JSON.parse(text))).toEqual([
      "snapshotFormat",
      "httpServerVersion",
      "errorEnvelope",
      "routes",
      "successStatus",
      "failures",
    ]);
    expect(JSON.parse(text)).toEqual({ httpServerVersion: "1.1.0", ...derived() });
    expect(text.endsWith("}\n")).toBe(true);
  });
});
