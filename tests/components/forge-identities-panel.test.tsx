/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { ForgeIdentitiesPanel } from "@/components/forge-identities-panel";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  spyOnConsoleOutput();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ identities: [] })));
});

afterEach(() => {
  refresh.mockClear();
  try {
    expectNoConsoleOutput();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("Forge identities panel", () => {
  it("names the read_api scope where the token is asked for", async () => {
    render(<ForgeIdentitiesPanel />);

    // The scope token is what a member copies into GitLab's scope checklist,
    // so the field's own accessible name-or-description must carry it; the
    // sentence around it is not asserted.
    const tokenField = screen.getByLabelText(/personal access token/i);
    expect(await screen.findByText(/no forge identity is linked/i)).toBeVisible();
    expect(tokenField).toHaveAccessibleDescription(/read_api/);
  });
});
