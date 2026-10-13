import { assertSurfaceVersion, requiredVersion } from "./surface-version.ts";
import type { HttpChangeKind } from "./surface-change.ts";

type UpdateDecision = "in-sync" | "drift-refuse" | "repair" | "surface-refuse" | "record-current" | "record";

/** Validate before any write; only a format upgrade classified none can record without a flag. */
export function decideSnapshotUpdate(input: {
  surfaceChanged: boolean;
  changeKind: HttpChangeKind;
  snapshotVersion?: string;
  requestedVersion?: string;
  protocolVersion?: string;
}): UpdateDecision {
  if (input.snapshotVersion !== undefined) requiredVersion(input.snapshotVersion, "none");
  if (input.protocolVersion !== undefined) requiredVersion(input.protocolVersion, "none");
  if (input.requestedVersion !== undefined) {
    requiredVersion(input.requestedVersion, "none");
    if (input.snapshotVersion !== undefined) {
      assertSurfaceVersion(input.snapshotVersion, input.requestedVersion,
        { kind: input.changeKind, reasons: [] }, "scripts/update-http-surface-snapshot.ts or scripts/update-mcp-surface-snapshot.ts --version <new>");
    }
  }
  if (input.surfaceChanged) {
    if (input.requestedVersion !== undefined) return "record";
    if (input.snapshotVersion === undefined || input.changeKind !== "none") return "surface-refuse";
    return input.snapshotVersion === input.protocolVersion ? "record-current" : "drift-refuse";
  }
  if (input.requestedVersion !== undefined) {
    return input.snapshotVersion === input.requestedVersion && input.protocolVersion === input.requestedVersion
      ? "in-sync" : "repair";
  }
  return input.snapshotVersion === input.protocolVersion ? "in-sync" : "drift-refuse";
}
