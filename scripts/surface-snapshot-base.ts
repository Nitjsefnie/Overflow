import { git } from "./http-surface-derive.ts";
import type { SurfaceSnapshots } from "./surface-version.ts";

/** Read both snapshots from the same resolved base, including format-1 HTTP. */
export function readSurfaceSnapshotsAt(base: string): SurfaceSnapshots {
  function read(path: string): unknown {
    const listing = git(["--literal-pathspecs", "ls-tree", "-z", base, "--", path]).split("\0")[0]!;
    if (listing === "") return undefined;
    const [entry, listedPath] = listing.split("\t", 2);
    if (listedPath !== path || !entry?.startsWith("100644 blob ")) {
      throw new Error(`${path} at ${base} is not a regular file`);
    }
    try {
      return JSON.parse(git(["show", `${base}:${path}`]));
    } catch (error) {
      throw new Error(`${path} at ${base} could not be parsed: ${error}`);
    }
  }
  return {
    http: read("scripts/http-surface-snapshot.json") as SurfaceSnapshots["http"],
    mcp: read("scripts/mcp-surface-snapshot.json") as SurfaceSnapshots["mcp"],
  };
}
