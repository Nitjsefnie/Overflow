import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const deployScript = readFileSync(
  new URL("../../scripts/deploy-revision.sh", import.meta.url),
  "utf8",
);
const dockerfile = readFileSync(
  new URL("../../Dockerfile", import.meta.url),
  "utf8",
);

// Issue 688: Next.js phones home and prints its telemetry notice on every
// production build unless NEXT_TELEMETRY_DISABLED is set; this branch makes
// both the Dockerfile's build stage and its runtime stage set it, and these
// pins hold every build path to the same opt-out. This file pins both
// Dockerfile env lines (build stage and runtime stage) plus the CI and host
// deploy paths; the build-stage line's placement before `RUN pnpm build` is
// additionally pinned in tests/deploy/container-image.test.ts.

/** The full text of the workflow step whose `- name:` line names `name`. */
function workflowStep(workflowText: string, name: string): string {
  const lines = workflowText.split("\n");
  const stepAt = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (stepAt === -1) return "";
  const nextStepAt = lines.findIndex(
    (line, index) => index > stepAt && line.trim().startsWith("- name:"),
  );
  return lines.slice(stepAt, nextStepAt === -1 ? undefined : nextStepAt).join("\n");
}

describe("build telemetry opt-out (issue 688)", () => {
  it("disables Next.js telemetry on the CI production build step", () => {
    const step = workflowStep(workflow, "Production build");
    expect(step, "the Production build step").not.toBe("");
    expect(step).toContain("run: pnpm build");
    expect(step).toContain('NEXT_TELEMETRY_DISABLED: "1"');
  });

  it("disables Next.js telemetry on the host deploy build as an env prefix on the pnpm build line", () => {
    const buildLine = deployScript
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .find((line) => line.includes("pnpm build"));
    expect(buildLine, "the pnpm build invocation").toBeDefined();
    // The env-PREFIX shape is load-bearing: another seat's test parses env
    // prefixes off this line, so the opt-out rides the same line rather than
    // an export above it.
    expect(buildLine).toMatch(/^NEXT_TELEMETRY_DISABLED=1\b/);
    expect(buildLine).toContain('NEXT_DIST_DIR="$release"');
    expect(buildLine).toContain("pnpm build");
  });

  it("disables Next.js telemetry in the Dockerfile's build stage", () => {
    const buildStage = dockerfile.split("FROM deps AS build")[1]?.split("\nFROM ")[0] ?? "";
    expect(buildStage, "the build stage's NEXT_TELEMETRY_DISABLED env line")
      .toContain("ENV NEXT_TELEMETRY_DISABLED=1");
  });

  it("disables Next.js telemetry in the Dockerfile's runtime stage", () => {
    const lines = dockerfile.split("\n");
    const runtimeAt = lines.findIndex((line) => line.includes("AS runtime"));
    const envAt = lines.findIndex(
      (line, index) => index > runtimeAt && line === "ENV NEXT_TELEMETRY_DISABLED=1",
    );
    expect(envAt, "the runtime stage's NEXT_TELEMETRY_DISABLED env line").toBeGreaterThan(runtimeAt);
  });
});
