import { errorEnvelope } from "../src/lib/http/error-response.ts";
import { deriveHttpSurfaceAnswers, shapeOf } from "./http-surface-derive.ts";
import { deriveRouteFailures } from "./http-surface-derive-failures.ts";
import type { DerivedHttpSurface } from "./surface-change.ts";

/**
 * The whole recorded HTTP surface as the code derives it (issue 1056), in
 * the shape scripts/http-surface-snapshot.json records it minus the version:
 * the error envelope's shape, read off the real helper; each documented
 * route's success body shape and success status, from the answers its
 * handler gives (scripts/http-surface-derive.ts); and each route's failure
 * answers, derived statically from its import graph
 * (scripts/http-surface-derive-failures.ts).
 */
export async function deriveHttpSurfaceRecord(): Promise<DerivedHttpSurface> {
  const answers = await deriveHttpSurfaceAnswers();
  const keys = Object.keys(answers);
  return {
    snapshotFormat: 2,
    errorEnvelope: shapeOf(errorEnvelope("SAMPLE_CODE", "A sample message.")),
    routes: Object.fromEntries(keys.map((key) => [key, answers[key]!.shape])),
    successStatus: Object.fromEntries(keys.map((key) => [key, answers[key]!.status])),
    failures: deriveRouteFailures(keys),
  };
}
