import { createHash } from "node:crypto";

const BLOB_ID_PREFIX_LENGTH = 4; // git's abbreviation floor
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)((?: [0-7]+)?)$/;

export function diffFingerprint(rawDiff: string): string {
  // Per line, not /m: its ^ also matches after \r, U+2028, U+2029.
  const canonical = rawDiff.split("\n").map((line) => line.replace(INDEX_LINE, (_line, before: string, after: string, mode: string) =>
    `index ${before.slice(0, BLOB_ID_PREFIX_LENGTH)}..${after.slice(0, BLOB_ID_PREFIX_LENGTH)}${mode}`)).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
