import { assertSurfaceVersion, requiredVersion } from "./surface-version.ts";
import type { HttpChangeKind } from "./surface-change.ts";

type UpdateDecision = "in-sync" | "drift-refuse" | "repair" | "surface-refuse" | "record-current" | "record";

/** Validate before any write; only a format upgrade classified none can record without a flag. */
export function decideSnapshotUpdate(input: {
  surfaceChanged: boolean;
  changeKind: HttpChangeKind;
  snapshotVersion?: string;
  requestedVersion?: string;
  protocolVersion: string;
  peerProtocolVersion: string;
  peerSnapshotVersion: string;
}): UpdateDecision {
  // Source constants and the other recorded snapshot must exist, even during first recording.
  const currentVersions = [input.protocolVersion, input.peerProtocolVersion, input.peerSnapshotVersion];
  for (const version of currentVersions) requiredVersion(version, "none");
  if (input.snapshotVersion !== undefined) requiredVersion(input.snapshotVersion, "none");
  const aligned = currentVersions.every((version) => version === input.snapshotVersion);
  if (input.requestedVersion !== undefined) {
    requiredVersion(input.requestedVersion, "none");
    for (const version of [input.snapshotVersion, input.peerSnapshotVersion]) {
      if (version !== undefined) assertSurfaceVersion(version, input.requestedVersion,
        { kind: input.changeKind, reasons: [] }, "scripts/update-http-surface-snapshot.ts or scripts/update-mcp-surface-snapshot.ts --version <new>");
    }
  }
  if (input.surfaceChanged) {
    if (input.requestedVersion !== undefined) return "record";
    if (input.snapshotVersion === undefined || input.changeKind !== "none") return "surface-refuse";
    return aligned ? "record-current" : "drift-refuse";
  }
  if (input.requestedVersion !== undefined) {
    return aligned && input.snapshotVersion === input.requestedVersion
      ? "in-sync" : "repair";
  }
  return aligned ? "in-sync" : "drift-refuse";
}
