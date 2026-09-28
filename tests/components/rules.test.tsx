/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth }));

const currentRole = vi.hoisted(() => vi.fn());

vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: currentRole }));

import { PublicRulesContent, RulesContent } from "@/app/rules/page";

async function renderRulesPage(): Promise<void> {
  const { default: RulesPage } = await import("@/app/rules/page");
  render(await RulesPage());
}

describe("rules page", () => {
  afterEach(() => {
    auth.mockReset();
    currentRole.mockReset();
  });

  it.each([false, true])("renders the Rules heading with isModerator=%s", (isModerator) => {
    render(<RulesContent memberName="Ada" isModerator={isModerator} />);

    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
  });

  it("renders the member name passed to the shell", () => {
    render(<RulesContent memberName="Grace Hopper" isModerator={false} />);

    expect(screen.getByText("Grace Hopper")).toBeVisible();
  });

  it("points maintainers at a claim system they can install", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    // A reader depends on this link resolving, not on the sentence around it.
    const claim = screen.getByRole("link", { name: /claim/i });
    expect(claim).toHaveAttribute("href", "https://github.com/Nitjsefnie-Actions/claim");
  });

  it("exposes six named section landmarks", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(6);
    for (const region of regions) {
      expect(region).toHaveAccessibleName();
    }
  });

  it("renders the rules for a signed-out visitor inside the public shell, with no session", async () => {
    auth.mockResolvedValue(null);
    await renderRulesPage();

    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(6);
    for (const region of regions) {
      expect(region).toHaveAccessibleName();
    }
    // No member chrome: no session stamp, no sign-out control, and no main
    // supplied by the member shell — the public view brings its own.
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    const main = document.querySelector("main.page-content");
    expect(main, "the public rules view supplies its own main.page-content").not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");
  });

  it("renders the same public view with no session read at all", () => {
    render(<PublicRulesContent />);

    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
    expect(screen.getAllByRole("region")).toHaveLength(6);
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
  });

  it("keeps the member view for a member session", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada Lovelace", role: "MEMBER" } });
    currentRole.mockResolvedValue("MEMBER");
    await renderRulesPage();

    expect(screen.getByText("Ada Lovelace")).toBeVisible();
  });

  it("keeps the moderator flag for a moderator session", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MODERATOR" } });
    currentRole.mockResolvedValue("MODERATOR");
    await renderRulesPage();

    expect(screen.getByRole("link", { name: "Moderation" })).toBeVisible();
  });

  it("renders the member view with no Moderation link when the ledger demotes a JWT moderator", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MODERATOR" } });
    currentRole.mockResolvedValue("MEMBER");
    await renderRulesPage();

    expect(screen.queryByRole("link", { name: "Moderation" })).not.toBeInTheDocument();
    expect(screen.getByText(/Signed in as/)).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
  });

  it("renders the Moderation link when the ledger promotes a JWT member", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MEMBER" } });
    currentRole.mockResolvedValue("MODERATOR");
    await renderRulesPage();

    expect(screen.getByRole("link", { name: "Moderation" })).toBeVisible();
  });

  it("falls back to the public view when the ledger has no record for the session's id", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MODERATOR" } });
    currentRole.mockResolvedValue(null);
    await renderRulesPage();

    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    const main = document.querySelector("main.page-content");
    expect(main, "the public rules view supplies its own main.page-content").not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");
  });

  it("falls back to the public view when the ledger lookup fails", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MODERATOR" } });
    currentRole.mockRejectedValue(new Error("the ledger is unreachable"));
    await renderRulesPage();

    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    const main = document.querySelector("main.page-content");
    expect(main, "the public rules view supplies its own main.page-content").not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");
  });
});
