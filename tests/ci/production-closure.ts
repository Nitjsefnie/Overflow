/**
 * Production dependency closure of a pnpm-lock.yaml, computed from the
 * lockfile TEXT (pure: string in, sets out — no filesystem, no process, no
 * network).
 *
 * Grammar (pnpm-lock v9, derived from this repository's own lockfile):
 *
 * - `importers:` holds the workspace importers; the root project is the `.:`
 *   entry. Its `dependencies:` and `optionalDependencies:` entries are the
 *   PRODUCTION entry edges; each entry's `version:` value is the snapshot id
 *   suffix (the id is `name@value`). `devDependencies:` entries are NOT
 *   edges of this walk — a package reachable only through them is outside
 *   the closure, which is the property the braces acceptance rests on.
 * - `snapshots:` holds one entry per resolved package instance, keyed by the
 *   full id `name@version` plus the version's resolved peer suffix where the
 *   version has peers (e.g. `micromatch@4.0.8` vs a peer-suffixed
 *   `update-browserslist-db@1.3.3(browserslist@4.29.0)`). Each entry's
 *   `dependencies:` and `optionalDependencies:` are the transitive
 *   PRODUCTION edges; the edge value is again the snapshot id suffix, so
 *   `name@value` names the target snapshot exactly, peer context included.
 * - `packages:` carries metadata only (integrity, engines, peer metadata)
 *   and contributes no edge; the walk never reads it.
 * - Peer dependencies carry no version of their own — in this grammar a
 *   peer is resolved INTO the snapshot id's parenthesised suffix, not into a
 *   `dependencies:` edge — so there is no peer edge to follow: whatever the
 *   lockfile lists under `dependencies:`/`optionalDependencies:` already
 *   includes every prod-resolved peer instance the snapshot needs. Entries
 *   marked `optional: true` are platform-conditional packages reached
 *   through optional edges, which this walk counts as production edges (an
 *   over-approximation — the safe direction for an acceptance guard).
 * - Aliased dependencies (pnpm writes `alias-name: target@version` when an
 *   install renames a package) do not resolve as `name@value`; when that
 *   misses, the edge resolves by trying the value itself as a snapshot id
 *   (`string-width-cjs: string-width@4.2.3` -> `string-width@4.2.3`).
 *
 * An edge that resolves to neither form FAILS the walk. Fail-closed is the
 * deliberate choice for a guard: a silently dropped production edge could
 * hide exactly the reachability this module exists to detect, so an
 * unresolvable edge must turn red and force a human look, never read as
 * "absent".
 */

export interface ProductionClosure {
  /** Snapshot ids (with peer suffixes) reachable through production edges. */
  readonly ids: ReadonlySet<string>;
  /** Distinct package names of those snapshots. */
  readonly names: ReadonlySet<string>;
}

/** A `name: value` edge read from the lockfile. */
type LockEdge = readonly [name: string, value: string];

interface ParsedLockfile {
  /** Production entry edges of the root importer (`.`), pre-resolved. */
  rootEntries: readonly string[];
  /** Every snapshot id in the lockfile. */
  snapshotIds: ReadonlySet<string>;
  /** Raw production edges per snapshot id. */
  snapshotEdges: ReadonlyMap<string, readonly LockEdge[]>;
}

/** Strip YAML's single/double quoting from a key or value token. */
function unquote(token: string): string {
  const trimmed = token.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith("'") && trimmed.endsWith("'"))
      || (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The package name of a snapshot id: `braces@3.0.3` -> `braces`;
 * `@csstools/css-tokenizer@4.0.1` -> `@csstools/css-tokenizer`; the first
 * `@` of a peer suffix is never a separator because the name ends at the
 * `@` before the version (scoped names are split at the `@` following their
 * `/`).
 */
function snapshotIdName(id: string): string {
  if (id.startsWith("@")) {
    const slash = id.indexOf("/", 1);
    const separator = slash === -1 ? -1 : id.indexOf("@", slash + 1);
    return separator === -1 ? id : id.slice(0, separator);
  }
  return id.slice(0, id.indexOf("@"));
}

/**
 * Snapshot section entries sit at exactly two spaces of indentation, either
 * `id:` or `id: {}` for an edge-less snapshot; the `(?!\s)` keeps deeper
 * indentation (4/6-space block content) from matching. Quoted scoped keys
 * (`'@scope/name@1.0.0':`) keep their quotes here; unquote() strips them.
 */
const SNAPSHOT_KEY = /^  (?!\s)(.+?):(?: \{\})?$/;
const DEPENDENCY_BLOCK = /^    (?!\s)([A-Za-z][\w-]*):$/;
const DEPENDENCY_EDGE = /^      (?!\s)([^:\s][^:]*): (.+)$/;
const IMPORTER_ENTRY = /^      (?!\s)([^:\s][^:]*):$/;
const IMPORTER_VERSION = /^        version: (.+)$/;

/** The 4-space block headers whose edges the production walk follows. */
function isProdBlockName(name: string): boolean {
  return name === "dependencies" || name === "optionalDependencies";
}

/** Parse the lockfile text into the pieces the closure walk needs. */
function parseLockfile(lockfile: string): ParsedLockfile {
  const rootEntries: string[] = [];
  const snapshotIds = new Set<string>();
  const snapshotEdges = new Map<string, LockEdge[]>();

  let section: "other" | "importers" | "snapshots" = "other";
  let inRootImporter = false;
  let importerBlock: "prod" | null = null;
  let importerEntry: string | null = null;
  let snapshot: string | null = null;
  let snapshotBlock: "prod" | null = null;

  for (const line of lockfile.split("\n")) {
    if (line === "importers:" || line === "snapshots:" || line === "packages:") {
      section = line === "packages:" ? "other" : line === "importers:" ? "importers" : "snapshots";
      inRootImporter = false;
      importerBlock = null;
      importerEntry = null;
      snapshot = null;
      snapshotBlock = null;
      continue;
    }

    if (section === "importers") {
      if (line === "  .:") {
        inRootImporter = true;
        importerBlock = null;
        importerEntry = null;
        continue;
      }
      if (/^  \S/.test(line)) {
        inRootImporter = false;
        importerBlock = null;
        importerEntry = null;
        continue;
      }
      if (!inRootImporter) continue;
      const block = DEPENDENCY_BLOCK.exec(line);
      if (block) {
        importerBlock = isProdBlockName(block[1]) ? "prod" : null;
        importerEntry = null;
        continue;
      }
      const entry = IMPORTER_ENTRY.exec(line);
      if (entry) {
        importerEntry = unquote(entry[1]);
        continue;
      }
      const version = IMPORTER_VERSION.exec(line);
      if (version && importerBlock === "prod" && importerEntry !== null) {
        rootEntries.push(`${importerEntry}@${unquote(version[1])}`);
        continue;
      }
      if (line.trim() === "") {
        importerBlock = null;
        importerEntry = null;
      }
      continue;
    }

    if (section === "snapshots") {
      const key = SNAPSHOT_KEY.exec(line);
      if (key) {
        snapshot = unquote(key[1]);
        snapshotIds.add(snapshot);
        snapshotBlock = null;
        continue;
      }
      const block = DEPENDENCY_BLOCK.exec(line);
      if (block && snapshot !== null) {
        snapshotBlock = isProdBlockName(block[1]) ? "prod" : null;
        continue;
      }
      if (snapshotBlock === "prod" && snapshot !== null) {
        const edge = DEPENDENCY_EDGE.exec(line);
        if (edge) {
          const edges = snapshotEdges.get(snapshot) ?? [];
          edges.push([unquote(edge[1]), unquote(edge[2])]);
          snapshotEdges.set(snapshot, edges);
          continue;
        }
      }
    }
  }

  return { rootEntries, snapshotIds, snapshotEdges };
}

/** Resolve one edge to its target snapshot id; see the module doc's rules. */
function resolveEdge(edge: LockEdge, snapshotIds: ReadonlySet<string>): string {
  const [name, value] = edge;
  const direct = `${name}@${value}`;
  if (snapshotIds.has(direct)) return direct;
  if (snapshotIds.has(value)) return value; // aliased dependency
  throw new Error(
    `production-closure: unresolved production edge "${name}: ${value}" —`
    + " the lockfile grammar has moved past this walk's; the guard fails"
    + " closed and needs re-derivation, never silent absence",
  );
}

/**
 * Compute the production closure of the lockfile: every snapshot reachable
 * from the root importer through `dependencies` and `optionalDependencies`
 * edges, dev-only chains excluded by construction.
 */
export function productionClosure(lockfile: string): ProductionClosure {
  const parsed = parseLockfile(lockfile);
  const ids = new Set<string>();
  const queue = [...parsed.rootEntries];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) break;
    if (ids.has(id)) continue;
    ids.add(id);
    const edges = parsed.snapshotEdges.get(id);
    if (edges === undefined) continue;
    for (const edge of edges) queue.push(resolveEdge(edge, parsed.snapshotIds));
  }
  const names = new Set<string>();
  for (const id of ids) names.add(snapshotIdName(id));
  return { ids, names };
}

/**
 * Whether `packageName` has a snapshot inside the lockfile's production
 * closure — the negation of which is the property the braces acceptance
 * rests on.
 */
export function productionClosureContains(lockfile: string, packageName: string): boolean {
  return productionClosure(lockfile).names.has(packageName);
}
