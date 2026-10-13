import { describe, expect, it } from "vitest";
import {
  buildConstAssignment,
  decideSnapshotUpdate,
  replaceConstAssignment,
  serializedSnapshot,
  surfaceUpdateInputs,
} from "../../scripts/update-http-surface-snapshot.ts";
import type { RecordedHttpSurface } from "../../scripts/surface-change.ts";

function derived(): RecordedHttpSurface & { snapshotFormat: 2 } {
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

  it.each([
    { label: "a missing snapshot", snapshot: () => undefined, changed: true, compatible: false },
    {
      label: "an identical recorded surface",
      snapshot: () => ({ httpServerVersion: "1.1.0", ...derived() }),
      changed: false,
      compatible: true,
    },
    {
      label: "a snapshot recorded before the envelope, statuses and failures were",
      snapshot: () => ({ httpServerVersion: "1.1.0", routes: derived().routes }),
      changed: true,
      compatible: true,
    },
    {
      label: "a recorded failure answer the derivation no longer gives",
      snapshot: () => {
        const recorded = { httpServerVersion: "1.1.0", ...derived() };
        recorded.failures["GET /a"] = [...recorded.failures["GET /a"]!, "409 CONFLICT"];
        return recorded;
      },
      changed: true,
      compatible: false,
    },
    {
      label: "a failure answer the recording lacks",
      snapshot: () => {
        const recorded = { httpServerVersion: "1.1.0", ...derived() };
        recorded.failures["GET /a"] = ["401 UNAUTHENTICATED"];
        return recorded;
      },
      changed: true,
      compatible: true,
    },
    {
      label: "a recorded success status the derivation changed",
      snapshot: () => {
        const recorded = { httpServerVersion: "1.1.0", ...derived() };
        recorded.successStatus["GET /a"] = 201;
        return recorded;
      },
      changed: true,
      compatible: false,
    },
  ])("judges $label changed=$changed compatible=$compatible", ({ snapshot, changed, compatible }) => {
    expect(surfaceUpdateInputs(snapshot(), derived())).toEqual({
      surfaceChanged: changed,
      surfaceCompatible: compatible,
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
