/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

const signIn = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ signIn }));

import { PROCESSING_ACTIVITIES } from "@/lib/processing-activities";

const SENTINEL_ACTIVITIES = [
  {
    identifier: "sentinel_activity_alpha",
    name: "Sentinel activity alpha",
    basis: "contract",
    noticeLabel: "Shared-module sentinel purpose alpha",
  },
  {
    identifier: "sentinel_activity_beta",
    name: "Sentinel activity beta",
    basis: "legitimate interests",
    noticeLabel: "Shared-module sentinel purpose beta",
  },
] as const;

async function renderAccountDataPage(): Promise<void> {
  const { default: AccountDataPage } = await import("@/app/account-data/page");
  render(createElement(AccountDataPage));
}

describe("processing record step-keeper", () => {
  it("keeps the record's machine-keyed activities aligned with the notice", async () => {
    await renderAccountDataPage();

    const recordPath = resolve(process.cwd(), "deploy/processing-record.md");
    const record = existsSync(recordPath) ? readFileSync(recordPath, "utf8") : "";
    const recordIds = [...record.matchAll(/^## Activity: ([a-z][a-z0-9_]*)$/gm)].map(
      ([, identifier]) => identifier,
    );

    const sharedIds = PROCESSING_ACTIVITIES.map(({ identifier }) => identifier);
    expect(new Set(recordIds).size, "record activity identifiers must be unique").toBe(recordIds.length);
    expect(new Set(recordIds)).toEqual(new Set(sharedIds));
  });

  it("renders purpose labels from the shared module inside the purposes list", async () => {
    vi.resetModules();
    vi.doMock("@/lib/processing-activities", () => ({
      PROCESSING_ACTIVITIES: SENTINEL_ACTIVITIES,
    }));

    try {
      await renderAccountDataPage();

      const section = screen
        .getByRole("heading", { name: "Purposes and legal bases" })
        .closest("section.surface");
      if (!(section instanceof HTMLElement)) {
        throw new Error("the purposes heading must label an HTML section");
      }
      const purposesList = within(section).getByRole("list");

      for (const activity of SENTINEL_ACTIVITIES) {
        expect(within(purposesList).getByText(activity.noticeLabel)).toBeInTheDocument();
      }
    } finally {
      vi.doUnmock("@/lib/processing-activities");
      vi.resetModules();
    }
  });
});
