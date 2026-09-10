import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

/**
 * The parsed shape of a verify-job step this suite reads. Steps this suite does
 * not reason about (checkout, setup-node) carry only `uses`, which is why every
 * field is optional.
 */
type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
};

/**
 * jsdom does no layout, so the component suite stays green while a stylesheet
 * edit pushes the landing page's sign-in button below the fold (issue 111). The
 * behavioral cover for that is a real-browser check in CI, `node
 * scripts/check-page-geometry.mjs`, and this suite pins the wiring so the check
 * cannot silently drop out of the release gate: the step must exist in the
 * verify job, and it must run after the production build it measures — the
 * script starts its own server against the build, so it has nothing to measure
 * without that step ahead of it.
 *
 * Assertions are made on the parsed YAML data (step.name / step.run), never on
 * the raw bytes, so reformatting or reordering unrelated steps does not disturb
 * them and a renamed or removed step fails loudly here instead of quietly
 * narrowing what CI gates on.
 */
describe("the verify workflow's page-geometry step", () => {
  let steps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };

    steps = workflow.jobs?.verify?.steps ?? [];
  });

  it("keeps the production build step", () => {
    const builds = steps.filter((step) => step.name === "Production build");

    expect(builds, "the verify job must keep its Production build step").toHaveLength(1);
  });

  it("runs the page geometry check as a step of the verify job", () => {
    const geometry = steps.filter((step) =>
      step.run?.includes("scripts/check-page-geometry.mjs"),
    );

    expect(
      geometry,
      "the verify job must run node scripts/check-page-geometry.mjs",
    ).toHaveLength(1);
  });

  it("orders the page geometry check after the production build it measures", () => {
    const buildIndex = steps.findIndex((step) => step.name === "Production build");
    const geometryIndex = steps.findIndex((step) =>
      step.run?.includes("scripts/check-page-geometry.mjs"),
    );

    expect(buildIndex).toBeGreaterThan(-1);
    expect(geometryIndex).toBeGreaterThan(-1);
    expect(geometryIndex).toBeGreaterThan(buildIndex);
  });
});
