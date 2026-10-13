import { isDeepStrictEqual } from "node:util";
import { shapesCompatible, type HttpShape } from "./http-surface-derive.ts";

/**
 * The recorded HTTP surface (issue 1056) and how a change to it is classified
 * for the version-move rule in API.md "Stability and versioning".
 *
 * A snapshot recorded with `snapshotFormat: 2` pins, beside each documented
 * route's success body shape, the error envelope's shape, each route's
 * success status and each route's failure answers ("<status> <CODE>", with
 * " +<key>" per extra envelope field), plus non-envelope status/body shapes
 * derived by failure-handler fixtures. A snapshot without the marker (format
 * 1, what main recorded before issue 1056) pinned routes only, so it has
 * nothing recorded for the additional sections and their first recording
 * is not a change.
 */
export type RecordedHttpSurface = {
  snapshotFormat?: 2;
  errorEnvelope?: HttpShape;
  routes: Record<string, HttpShape>;
  successStatus?: Record<string, number>;
  failures?: Record<string, string[]>;
  nonEnvelopeFailures?: Record<string, Record<string, { status: number; shape: HttpShape }>>;
};

/** Existing sections are required; legacy callers may omit the newly introduced raw-answer section. */
export type DerivedHttpSurface = Required<Omit<RecordedHttpSurface, "nonEnvelopeFailures">> &
  Pick<RecordedHttpSurface, "nonEnvelopeFailures">;

/** A recorded HTTP surface together with the version it was recorded at. */
export type HttpSurfaceSnapshot = RecordedHttpSurface & { httpServerVersion: string };

/** The recorded sections of a snapshot, without the version they were recorded at. */
export function recordedSurface(snapshot: HttpSurfaceSnapshot): RecordedHttpSurface {
  const surface: Partial<HttpSurfaceSnapshot> = { ...snapshot };
  delete surface.httpServerVersion;
  return surface as RecordedHttpSurface;
}

export type HttpChangeKind = "none" | "additive" | "breaking";

export type HttpChange = { kind: HttpChangeKind; reasons: string[] };

/** MCP entries are opaque: even an extended existing schema is breaking. */
export type RecordedMcpSurface = { tools: ({ name: string } & Record<string, unknown>)[] };
export type McpSurfaceSnapshot = RecordedMcpSurface & { mcpServerVersion: string };

export function classifyMcpChange(base: RecordedMcpSurface, current: RecordedMcpSurface): HttpChange {
  const before = new Map(base.tools.map((tool) => [tool.name, tool]));
  const now = new Map(current.tools.map((tool) => [tool.name, tool]));
  const breaking: string[] = [];
  const additive: string[] = [];
  for (const [name, entry] of before) {
    if (!now.has(name)) breaking.push(`tool removed: ${name}`);
    else if (!isDeepStrictEqual(entry, now.get(name))) breaking.push(`tool changed: ${name}`);
  }
  for (const name of now.keys()) {
    if (!before.has(name)) additive.push(`tool added: ${name}`);
  }
  if (breaking.length) return { kind: "breaking", reasons: breaking };
  if (additive.length) return { kind: "additive", reasons: additive };
  return { kind: "none", reasons: [] };
}

/** Whether a surface records the envelope, statuses and failures; refuses a marker it does not know. */
function recordsAnswers(surface: RecordedHttpSurface): boolean {
  const format: unknown = surface.snapshotFormat;
  if (format === undefined) return false;
  if (format === 2) return true;
  throw new Error(`Unknown HTTP surface snapshotFormat ${JSON.stringify(format)}; expected 2 or none.`);
}

/**
 * Classifies the change from `base` to `current`. Breaking: a recorded route
 * removed, a recorded field removed or retyped (shapesCompatible), any
 * difference in the error envelope, a recorded success status changed or no
 * longer recorded, a recorded failure answer no longer recorded. Additive:
 * nothing breaking, and a new route, a new field, a revealed list element
 * shape, a new success status or a new failure answer. None: nothing recorded
 * differs. The envelope, statuses and failures are compared only when the
 * base records them. `reasons` lists the changes of the returned kind, each
 * naming the route or section it concerns.
 */
export function classifyHttpChange(base: RecordedHttpSurface, current: RecordedHttpSurface): HttpChange {
  const breaking: string[] = [];
  const additive: string[] = [];

  for (const [key, shape] of Object.entries(base.routes)) {
    const now = current.routes[key];
    if (now === undefined) {
      breaking.push(`route removed: ${key}`);
    } else if (!shapesCompatible(shape, now)) {
      breaking.push(`route shape changed: ${key}`);
    } else if (!isDeepStrictEqual(shape, now)) {
      additive.push(`route shape extended: ${key}`);
    }
  }
  for (const key of Object.keys(current.routes)) {
    if (!Object.hasOwn(base.routes, key)) additive.push(`route added: ${key}`);
  }

  const currentRecordsAnswers = recordsAnswers(current);
  if (recordsAnswers(base)) {
    const currentStatus = currentRecordsAnswers ? (current.successStatus ?? {}) : {};
    const currentFailures = currentRecordsAnswers ? (current.failures ?? {}) : {};
    if (!currentRecordsAnswers || !isDeepStrictEqual(base.errorEnvelope, current.errorEnvelope)) {
      breaking.push("errorEnvelope changed");
    }

    const baseStatus = base.successStatus ?? {};
    for (const [key, status] of Object.entries(baseStatus)) {
      const now = currentStatus[key];
      if (now === undefined) {
        breaking.push(`success status no longer recorded: ${key}`);
      } else if (now !== status) {
        breaking.push(`success status changed: ${key} ${status} -> ${now}`);
      }
    }
    for (const key of Object.keys(currentStatus)) {
      if (!Object.hasOwn(baseStatus, key)) additive.push(`success status added: ${key}`);
    }

    const beforeRaw = base.nonEnvelopeFailures ?? {};
    const currentRaw = currentRecordsAnswers ? current.nonEnvelopeFailures ?? {} : {};
    for (const [key, entries] of Object.entries(beforeRaw)) {
      for (const [entry, answer] of Object.entries(entries)) {
        const now = currentRaw[key]?.[entry];
        if (!now || now.status !== answer.status || !shapesCompatible(answer.shape, now.shape)) {
          breaking.push(`non-envelope failure changed or removed: ${key} ${entry}`);
        } else if (!isDeepStrictEqual(answer.shape, now.shape)) {
          additive.push(`non-envelope failure shape extended: ${key} ${entry}`);
        }
      }
    }
    for (const [key, entries] of Object.entries(currentRaw)) {
      for (const entry of Object.keys(entries)) {
        if (!Object.hasOwn(beforeRaw[key] ?? {}, entry)) additive.push(`non-envelope failure added: ${key} ${entry}`);
      }
    }

    const baseFailures = base.failures ?? {};
    for (const [key, answers] of Object.entries(baseFailures)) {
      const now = new Set(currentFailures[key] ?? []);
      for (const answer of answers) {
        if (!now.has(answer)) breaking.push(`failure answer removed: ${key} ${answer}`);
      }
    }
    for (const [key, answers] of Object.entries(currentFailures)) {
      const before = new Set(baseFailures[key] ?? []);
      for (const answer of answers) {
        if (!before.has(answer)) additive.push(`failure answer added: ${key} ${answer}`);
      }
    }
  }

  if (breaking.length > 0) return { kind: "breaking", reasons: breaking };
  if (additive.length > 0) return { kind: "additive", reasons: additive };
  return { kind: "none", reasons: [] };
}
