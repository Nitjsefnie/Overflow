import { createReadinessGetHandler } from "../src/app/api/readiness/route.ts";
import { derivedAnswer } from "./http-surface-derive.ts";
import type { NonEnvelopeObservation } from "./http-response-constructions.ts";

/** Force the real readiness handler's existing legacy failure, without changing its wire answer. */
export async function deriveNonEnvelopeFailures(): Promise<NonEnvelopeObservation[]> {
  const handler = createReadinessGetHandler({
    probe: async () => ({ status: "unavailable", reason: "database: fixture unavailable" }),
    now: () => 0,
  });
  const answer = await derivedAnswer(await handler());
  if (answer.status >= 200 && answer.status < 300) throw new Error("Readiness failure fixture returned a success.");
  return [{ route: "GET /api/readiness", entry: "unavailable", handler: handler.name, answer }];
}
