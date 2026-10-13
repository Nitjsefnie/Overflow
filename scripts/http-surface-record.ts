import { errorEnvelope } from "../src/lib/http/error-response.ts";
import { deriveHttpSurfaceAnswers, shapeOf } from "./http-surface-derive.ts";
import { deriveRouteFailures } from "./http-surface-derive-failures.ts";
import type { DerivedHttpSurface } from "./surface-change.ts";

type FixtureLogOwner = { users: number; original: typeof console.info };
let fixtureLogOwner: FixtureLogOwner | undefined;

/** Overlapping fixture derivations share one filter and release the original logger together. */
function acquireFixtureLogFilter(): () => void {
  if (fixtureLogOwner === undefined) {
    const original = console.info;
    fixtureLogOwner = { users: 0, original };
    console.info = (...args: Parameters<typeof console.info>) => {
      if (args[0] !== "Privileged action") original.apply(console, args);
    };
  }
  const owner = fixtureLogOwner;
  owner.users += 1;
  return () => {
    owner.users -= 1;
    if (owner.users === 0) {
      console.info = owner.original;
      fixtureLogOwner = undefined;
    }
  };
}

/** Fixture calls must not write synthetic actions to the updater's journal output. */
async function fixtureAnswers(): ReturnType<typeof deriveHttpSurfaceAnswers> {
  const release = acquireFixtureLogFilter();
  try {
    return await deriveHttpSurfaceAnswers();
  } finally {
    release();
  }
}

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
  const answers = await fixtureAnswers();
  const keys = Object.keys(answers);
  return {
    snapshotFormat: 2,
    errorEnvelope: shapeOf(errorEnvelope("SAMPLE_CODE", "A sample message.")),
    routes: Object.fromEntries(keys.map((key) => [key, answers[key]!.shape])),
    successStatus: Object.fromEntries(keys.map((key) => [key, answers[key]!.status])),
    failures: deriveRouteFailures(keys),
  };
}
