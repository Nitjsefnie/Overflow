import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHttpChange, type RecordedHttpSurface } from "../../scripts/surface-change.ts";

const fixture = vi.hoisted(() => ({ body: {} as Record<string, unknown> }));
vi.mock("../../src/app/api/readiness/route.ts", () => ({
  createReadinessGetHandler: () => async function getReadiness() {
    return Response.json(fixture.body, { status: 503 });
  },
}));
import { deriveNonEnvelopeFailures } from "../../scripts/http-surface-non-envelope.ts";

async function surface(): Promise<RecordedHttpSurface> {
  const [observation] = await deriveNonEnvelopeFailures();
  return { snapshotFormat: 2, routes: {}, successStatus: {}, failures: {},
    errorEnvelope: { error: { code: "string", message: "string" } },
    nonEnvelopeFailures: { [observation!.route]: { [observation!.entry]: observation!.answer } } };
}

describe("documented non-envelope body projection", () => {
  beforeEach(() => { fixture.body = { status: "unavailable", reason: "fixture detail" }; });

  it("records only readiness's declared documented fields", async () => {
    expect((await surface()).nonEnvelopeFailures).toEqual({
      "GET /api/readiness": { unavailable: { status: 503, shape: { status: "string" } } },
    });
  });

  it("classifies removal of an undocumented reason as none", async () => {
    const base = await surface();
    delete fixture.body.reason;
    expect(classifyHttpChange(base, await surface()).kind).toBe("none");
  });

  it("refuses a documented status renamed to state", async () => {
    fixture.body = { state: "unavailable", reason: "fixture detail" };
    await expect(surface()).rejects.toThrow(/status/);
  });

  it("refuses a missing declared field", async () => {
    fixture.body = { reason: "fixture detail" };
    await expect(surface()).rejects.toThrow(/status/);
  });

  it("classifies a documented status retype as breaking", async () => {
    const base = await surface();
    fixture.body.status = 7;
    expect(classifyHttpChange(base, await surface()).kind).toBe("breaking");
  });
});
