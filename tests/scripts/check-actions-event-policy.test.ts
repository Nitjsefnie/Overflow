import { describe, expect, it } from "vitest";
import { classify } from "../../scripts/check-actions-event-policy.ts";

describe("Actions event policy classification", () => {
  it("fails visibly when the event-policy surface is absent", () => {
    const result = classify({ status: 404, body: "Not Found" });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("2026-11-02");
  });

  it("fails when pull_request_target is blocked", () => {
    const result = classify({
      status: 200,
      body: JSON.stringify({
        events: {
          pull_request_target: "blocked",
          workflow_run: "allowed",
        },
      }),
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("pull_request_target");
  });

  it("fails when workflow_run is blocked", () => {
    const result = classify({
      status: 200,
      body: JSON.stringify({
        events: {
          pull_request_target: "allowed",
          workflow_run: "blocked",
        },
      }),
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("workflow_run");
  });

  it("treats a true entry under blocked_events as a denial", () => {
    const result = classify({
      status: 200,
      body: JSON.stringify({
        allowed_events: ["pull_request_target"],
        blocked_events: { workflow_run: true },
      }),
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("blocked: workflow_run");
  });

  it("passes only when both events are explicitly allowed", () => {
    const result = classify({
      status: 200,
      body: JSON.stringify({
        events: {
          pull_request_target: "allowed",
          workflow_run: "allowed",
        },
      }),
    });

    expect(result.pass).toBe(true);
  });

  it("finds explicit allows in a nested allow-list schema", () => {
    const result = classify({
      status: 200,
      body: JSON.stringify({
        policy: {
          allowed_events: ["pull_request_target", "workflow_run"],
        },
      }),
    });

    expect(result.pass).toBe(true);
  });

  it("fails when an event has no explicit allow entry and reports the document", () => {
    const body = JSON.stringify({ events: ["pull_request_target"] });
    const result = classify({ status: 200, body });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("workflow_run");
    expect(result.reason).toContain(body);
  });

  it.each(["not JSON", "{"])("fails closed for malformed JSON: %s", (body) => {
    const result = classify({ status: 200, body });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(body);
  });

  it.each([403, 500])("fails visibly for HTTP %s", (status) => {
    const result = classify({ status, body: "" });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(String(status));
  });
});
