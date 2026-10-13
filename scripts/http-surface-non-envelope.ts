import { createReadinessGetHandler } from "../src/app/api/readiness/route.ts";
import { shapeOf } from "./http-surface-derive.ts";
import type { NonEnvelopeObservation } from "./http-response-constructions.ts";

type FailureFixture = {
  route: string;
  entry: string;
  documentedFields: readonly string[];
  createHandler: () => () => Promise<Response>;
};

const fixtures: readonly FailureFixture[] = [{
  route: "GET /api/readiness",
  entry: "unavailable",
  documentedFields: ["status"],
  createHandler: () => createReadinessGetHandler({
    probe: async () => ({ status: "unavailable", reason: "database: fixture unavailable" }), now: () => 0,
  }),
}];

/** Invoke real failure handlers, then pin only each fixture's declared documented body fields. */
export async function deriveNonEnvelopeFailures(): Promise<NonEnvelopeObservation[]> {
  return Promise.all(fixtures.map(async (fixture) => {
    const handler = fixture.createHandler();
    const response = await handler();
    if (response.status >= 200 && response.status < 300) throw new Error(`${fixture.route}: failure fixture returned success.`);
    const body: unknown = await response.json();
    const projected: Record<string, unknown> = {};
    for (const field of fixture.documentedFields) {
      if (body === null || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, field)) {
        throw new Error(`${fixture.route} ${fixture.entry}: documented field ${JSON.stringify(field)} is absent from the failure body.`);
      }
      projected[field] = (body as Record<string, unknown>)[field];
    }
    return { route: fixture.route, entry: fixture.entry, handler: handler.name,
      answer: { status: response.status, shape: shapeOf(projected) } };
  }));
}
