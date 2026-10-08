/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

const signIn = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ signIn }));

import { PROCESSING_ACTIVITIES } from "@/lib/processing-activities";

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

  it("renders every purpose label", async () => {
    await renderAccountDataPage();

    for (const activity of PROCESSING_ACTIVITIES) {
      expect(screen.getByText(activity.noticeLabel)).toBeInTheDocument();
    }
  });
});
