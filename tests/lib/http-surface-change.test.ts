import { describe, expect, it } from "vitest";
import { classifyHttpChange, type RecordedHttpSurface } from "../../scripts/surface-change.ts";

/** A small recorded surface in the current format: two routes, their statuses and failures. */
function recorded(): RecordedHttpSurface {
  return {
    snapshotFormat: 2,
    errorEnvelope: { error: { code: "string", message: "string" } },
    routes: {
      "GET /a": { id: "string", tags: "unknown" },
      "POST /b": { created: "boolean" },
    },
    successStatus: { "GET /a": 200, "POST /b": 201 },
    failures: {
      "GET /a": ["401 UNAUTHENTICATED", "403 FORBIDDEN"],
      "POST /b": ["409 SPONSOR_BLOCKED +repositories", "415 UNSUPPORTED_MEDIA_TYPE"],
    },
  };
}

/** The same surface as today's main records it: routes only, no format marker. */
function formatOne(): RecordedHttpSurface {
  return { routes: recorded().routes };
}

function changed(edit: (surface: RecordedHttpSurface) => void): RecordedHttpSurface {
  const surface = recorded();
  edit(surface);
  return surface;
}

const cases: readonly {
  label: string;
  base: () => RecordedHttpSurface;
  current: () => RecordedHttpSurface;
  kind: "none" | "additive" | "breaking";
  names?: string;
}[] = [
  { label: "an identical surface", base: recorded, current: recorded, kind: "none" },
  {
    label: "a new route with its status and failures",
    base: recorded,
    current: () =>
      changed((surface) => {
        surface.routes["GET /c"] = { ok: "boolean" };
        surface.successStatus!["GET /c"] = 200;
        surface.failures!["GET /c"] = ["404 NOT_FOUND"];
      }),
    kind: "additive",
    names: "GET /c",
  },
  {
    label: "a new field on a recorded route",
    base: recorded,
    current: () => changed((surface) => {
      surface.routes["POST /b"] = { created: "boolean", id: "string" };
    }),
    kind: "additive",
    names: "POST /b",
  },
  {
    label: "a list element shape first revealed",
    base: recorded,
    current: () => changed((surface) => {
      surface.routes["GET /a"] = { id: "string", tags: "string" };
    }),
    kind: "additive",
    names: "GET /a",
  },
  {
    label: "a removed route",
    base: recorded,
    current: () => changed((surface) => {
      delete surface.routes["POST /b"];
    }),
    kind: "breaking",
    names: "POST /b",
  },
  {
    label: "a removed field",
    base: recorded,
    current: () => changed((surface) => {
      surface.routes["GET /a"] = { tags: "unknown" };
    }),
    kind: "breaking",
    names: "GET /a",
  },
  {
    label: "a retyped field",
    base: recorded,
    current: () => changed((surface) => {
      surface.routes["GET /a"] = { id: "number", tags: "unknown" };
    }),
    kind: "breaking",
    names: "GET /a",
  },
  {
    label: "a changed error envelope",
    base: recorded,
    current: () => changed((surface) => {
      surface.errorEnvelope = { code: "string", detail: "string" };
    }),
    kind: "breaking",
    names: "errorEnvelope",
  },
  {
    label: "an error envelope that only gained a field",
    base: recorded,
    current: () => changed((surface) => {
      surface.errorEnvelope = { error: { code: "string", hint: "string", message: "string" } };
    }),
    kind: "breaking",
    names: "errorEnvelope",
  },
  {
    label: "a changed success status",
    base: recorded,
    current: () => changed((surface) => {
      surface.successStatus!["POST /b"] = 200;
    }),
    kind: "breaking",
    names: "POST /b",
  },
  {
    label: "a removed success status",
    base: recorded,
    current: () => changed((surface) => {
      delete surface.successStatus!["POST /b"];
    }),
    kind: "breaking",
    names: "POST /b",
  },
  {
    label: "a removed failure answer",
    base: recorded,
    current: () => changed((surface) => {
      surface.failures!["GET /a"] = ["401 UNAUTHENTICATED"];
    }),
    kind: "breaking",
    names: "403 FORBIDDEN",
  },
  {
    label: "a failure answer that lost its extra field",
    base: recorded,
    current: () => changed((surface) => {
      surface.failures!["POST /b"] = ["409 SPONSOR_BLOCKED", "415 UNSUPPORTED_MEDIA_TYPE"];
    }),
    kind: "breaking",
    names: "409 SPONSOR_BLOCKED +repositories",
  },
  {
    label: "a route's failures no longer recorded",
    base: recorded,
    current: () => changed((surface) => {
      delete surface.failures!["GET /a"];
    }),
    kind: "breaking",
    names: "401 UNAUTHENTICATED",
  },
  {
    label: "a new failure answer",
    base: recorded,
    current: () => changed((surface) => {
      surface.failures!["GET /a"] = ["401 UNAUTHENTICATED", "403 FORBIDDEN", "429 RATE_LIMITED"];
    }),
    kind: "additive",
    names: "429 RATE_LIMITED",
  },
  {
    label: "a breaking change beside an additive one",
    base: recorded,
    current: () => changed((surface) => {
      surface.routes["GET /c"] = { ok: "boolean" };
      surface.successStatus!["GET /a"] = 202;
    }),
    kind: "breaking",
    names: "GET /a",
  },
  {
    label: "a format-1 base first recording the envelope, statuses and failures",
    base: formatOne,
    current: recorded,
    kind: "none",
  },
  {
    label: "a format-1 base against a current surface whose envelope differs from today's",
    base: formatOne,
    current: () => changed((surface) => {
      surface.errorEnvelope = { code: "string", detail: "string" };
    }),
    kind: "none",
  },
  {
    label: "a format-1 base whose recorded route is removed",
    base: formatOne,
    current: () => changed((surface) => {
      delete surface.routes["GET /a"];
    }),
    kind: "breaking",
    names: "GET /a",
  },
  {
    label: "a format-1 base whose recorded route gained a field",
    base: formatOne,
    current: () => changed((surface) => {
      surface.routes["GET /a"] = { extra: "number", id: "string", tags: "unknown" };
    }),
    kind: "additive",
    names: "GET /a",
  },
  {
    label: "a format-2 base against a current surface that recorded no failures",
    base: recorded,
    current: formatOne,
    kind: "breaking",
    names: "errorEnvelope",
  },
];

describe("HTTP surface change classification", () => {
  it("serializes the runtime-derived non-envelope section without losing status or shape", async () => {
    const { serializedSnapshot } = await import("../../scripts/update-http-surface-snapshot.ts");
    const surface = { ...recorded(), nonEnvelopeFailures: { "GET /ready": { unavailable: {status:503,shape:{reason:"string" as const,status:"string" as const}} } } };
    expect(JSON.parse(serializedSnapshot("1.1.0", surface as import("../../scripts/surface-change.ts").DerivedHttpSurface)).nonEnvelopeFailures).toEqual(surface.nonEnvelopeFailures);
  });

  it.each([
    { label: "changed status", edit: (answer: {status:number; shape:Record<string,string>}) => { answer.status = 500; }, kind: "breaking" },
    { label: "removed field", edit: (answer: {status:number; shape:Record<string,string>}) => { delete answer.shape.status; }, kind: "breaking" },
    { label: "retyped field", edit: (answer: {status:number; shape:Record<string,string>}) => { answer.shape.reason = "number"; }, kind: "breaking" },
    { label: "added field", edit: (answer: {status:number; shape:Record<string,string>}) => { answer.shape.extra = "boolean"; }, kind: "additive" },
  ])("classifies a non-envelope $label", ({ edit, kind }) => {
    const base = { ...recorded(), nonEnvelopeFailures: { "GET /ready": { unavailable: { status: 503, shape: { status: "string" as const, reason: "string" as const } } } } };
    const current = structuredClone(base);
    edit(current.nonEnvelopeFailures["GET /ready"].unavailable);
    expect(classifyHttpChange(base, current).kind).toBe(kind);
  });

  it("classifies removed and added non-envelope entries and ignores first recording against format 1", () => {
    const current = { ...recorded(), nonEnvelopeFailures: { "GET /ready": { unavailable: { status: 503, shape: { status: "string" as const, reason: "string" as const } } } } };
    expect(classifyHttpChange(current, recorded()).kind).toBe("breaking");
    expect(classifyHttpChange(recorded(), current).kind).toBe("additive");
    expect(classifyHttpChange(formatOne(), current).kind).toBe("none");
  });

  it.each(cases)("classifies $label as $kind", ({ base, current, kind, names }) => {
    const change = classifyHttpChange(base(), current());
    expect(change.kind).toBe(kind);
    if (kind === "none") {
      expect(change.reasons).toEqual([]);
    } else {
      expect(change.reasons.some((reason) => reason.includes(names!))).toBe(true);
    }
  });

  it("does not mutate its inputs", () => {
    const base = recorded();
    const current = changed((surface) => {
      surface.failures!["GET /a"] = ["401 UNAUTHENTICATED"];
    });
    const before = JSON.stringify([base, current]);
    classifyHttpChange(base, current);
    expect(JSON.stringify([base, current])).toBe(before);
  });

  it.each([3, 1, "2"])("refuses a recorded snapshotFormat of %j", (format) => {
    const unknown = { ...recorded(), snapshotFormat: format } as unknown as RecordedHttpSurface;
    expect(() => classifyHttpChange(unknown, recorded())).toThrow(/snapshotFormat/);
    expect(() => classifyHttpChange(recorded(), unknown)).toThrow(/snapshotFormat/);
  });
});
