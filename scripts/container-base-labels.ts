import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Derive OCI base provenance from the identical, digest-pinned node stages. */
export function containerBaseLabels(dockerfile: string): { baseName: string; baseDigest: string } {
  const references = [...dockerfile.matchAll(/^\s*FROM\s+(node:\S+)/gim)]
    .map((match) => match[1]);
  if (references.length === 0) {
    throw new Error("Dockerfile must contain a digest-pinned node FROM reference");
  }
  if (new Set(references).size !== 1) {
    throw new Error("All node FROM references must use the same tag and digest");
  }
  const base = /^(node:\d+\.\d+\.\d+-bookworm-slim)@(sha256:[a-fA-F0-9]{64})$/.exec(references[0]);
  if (!base) {
    throw new Error("Node FROM references must pin a node bookworm-slim tag and sha256 digest");
  }
  return { baseName: `docker.io/library/${base[1]}`, baseDigest: base[2] };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  process.stdout.write(`${JSON.stringify(containerBaseLabels(dockerfile))}\n`);
}
