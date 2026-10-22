import { describe, expect, it } from "vitest";
import { deriveHttpSurfaceAnswers } from "../../scripts/http-surface-derive.ts";
import { deriveRouteFailures } from "../../scripts/http-surface-derive-failures.ts";

const routes = ["GET /api/disputes", "POST /api/disputes", "GET /api/moderation/disputes", "POST /api/moderation/disputes"];
describe("closed PR dispute HTTP recording", () => {
  it("records each success through the served handlers", async () => {
    const answers = await deriveHttpSurfaceAnswers();
    for (const route of routes) expect(answers[route]).toMatchObject({ status: 200 });
    expect(answers["GET /api/disputes"]?.shape).toMatchObject({ contributorId: "string", state: "string" });
    expect(answers["POST /api/moderation/disputes"]?.shape).toMatchObject({ request: {
      awardedPoints: "number", moderatorFigure: "number", decidedBySoleModerator: "boolean",
    } });
  });
  it("records every refusal kind through the shared route helper", () => {
    const failures = deriveRouteFailures(routes);
    for (const route of routes) expect(failures[route]).toEqual(expect.arrayContaining([
      "403 FORBIDDEN", "409 CONFLICT", "404 NOT_FOUND", "422 INVALID_INPUT", "422 INSUFFICIENT_EVIDENCE", "502 UPSTREAM_FAILURE",
    ]));
  });
});
