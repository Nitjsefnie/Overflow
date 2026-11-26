/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh }) }));
vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: vi.fn() }));

import { TeamContent } from "@/app/team/page";
import type { TeamView } from "@/lib/teams/store";

const leadId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const teamId = "00000000-0000-4000-8000-000000000003";

const team: TeamView = {
  id: teamId, name: "Quay", leadId, createdAt: "2026-10-01T10:00:00.000Z", balance: 7,
  members: [
    { userId: leadId, githubLogin: "lead", joinedAt: "2026-10-01T10:00:00.000Z" },
    { userId: memberId, githubLogin: "mira", joinedAt: "2026-10-02T10:00:00.000Z" },
  ],
  distributions: [{ id: teamId, teamId, memberId, memberLogin: "mira", points: 3, createdAt: "2026-10-03T10:00:00.000Z" }],
};

afterEach(() => { refresh.mockClear(); vi.unstubAllGlobals(); });

function renderPage(viewerId: string, view: TeamView | null | undefined) {
  return render(<TeamContent memberName="Ada" isModerator={false} viewerId={viewerId} team={view} />);
}

function mockResponse(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("team page", () => {
  it("offers a create form to an account in no team", async () => {
    const fetchMock = mockResponse({ team: {} }, 201);
    renderPage(leadId, null);

    expect(screen.queryByRole("region", { name: "Members" })).toBeNull();
    const create = screen.getByRole("button", { name: "Create the team" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: " Quay " } });
    fireEvent.click(create);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/teams", expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: "Quay" }),
    }));
  });

  it("names a failed read instead of offering to create a team", () => {
    renderPage(leadId, undefined);

    expect(screen.getByRole("alert")).toHaveTextContent("Your team could not be loaded.");
    expect(screen.queryByLabelText("Team name")).toBeNull();
  });

  it("shows the lead the team, its forms and a remove button for each non-lead member", () => {
    renderPage(leadId, team);

    expect(screen.getByRole("heading", { level: 1, name: "Quay" })).toBeVisible();
    expect(document.querySelector("[data-team-balance]")).toHaveTextContent("7");
    const members = within(screen.getByRole("list", { name: "Team members" })).getAllByRole("listitem");
    expect(members).toHaveLength(2);
    expect(members[0]).toHaveTextContent("lead (lead)");
    expect(within(members[0]!).queryByRole("button")).toBeNull();
    expect(within(members[1]!).getByRole("button", { name: "Remove mira" })).toBeVisible();
    expect(screen.getByLabelText("GitHub login")).toBeVisible();
    expect(screen.getByLabelText("Member")).toBeVisible();
    expect(screen.getByLabelText("Points (whole)")).toBeVisible();
    expect(within(screen.getByRole("list", { name: "Team distributions" })).getByRole("listitem")).toHaveTextContent("3 to mira");
  });

  it("shows a member the team without any lead control", () => {
    renderPage(memberId, team);

    expect(screen.getByRole("heading", { level: 1, name: "Quay" })).toBeVisible();
    expect(within(screen.getByRole("main")).queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("GitHub login")).toBeNull();
    expect(screen.queryByLabelText("Points (whole)")).toBeNull();
  });

  it("says so when no points were distributed", () => {
    renderPage(memberId, { ...team, distributions: [] });

    expect(screen.queryByRole("list", { name: "Team distributions" })).toBeNull();
    expect(screen.getByText("The lead has not distributed any points.")).toBeVisible();
  });

  it("adds a member by login and clears the field", async () => {
    const fetchMock = mockResponse({ member: { userId: memberId } }, 201);
    renderPage(leadId, team);

    fireEvent.change(screen.getByLabelText("GitHub login"), { target: { value: " Niko " } });
    fireEvent.click(screen.getByRole("button", { name: "Add the member" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The member is added."));
    expect(fetchMock).toHaveBeenCalledWith("/api/teams/members", expect.objectContaining({
      method: "POST", body: JSON.stringify({ githubLogin: "Niko" }),
    }));
    expect(screen.getByLabelText("GitHub login")).toHaveValue("");
    expect(refresh).toHaveBeenCalled();
  });

  it("removes a member by id", async () => {
    const fetchMock = mockResponse({ removed: true });
    renderPage(leadId, team);

    fireEvent.click(screen.getByRole("button", { name: "Remove mira" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/teams/members", expect.objectContaining({
      method: "DELETE", body: JSON.stringify({ memberId }),
    }));
  });

  it("distributes whole points to the chosen member and refuses a fraction before sending", async () => {
    const fetchMock = mockResponse({ distribution: {} }, 201);
    renderPage(leadId, team);

    const distribute = screen.getByRole("button", { name: "Distribute the points" });
    fireEvent.change(screen.getByLabelText("Points (whole)"), { target: { value: "1.5" } });
    expect(distribute).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Member"), { target: { value: memberId } });
    fireEvent.change(screen.getByLabelText("Points (whole)"), { target: { value: "4" } });
    fireEvent.click(distribute);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/teams/distributions", expect.objectContaining({
      method: "POST", body: JSON.stringify({ memberId, points: 4 }),
    }));
  });

  it("shows the route's refusal message and does not refresh", async () => {
    mockResponse({ error: { code: "CONFLICT", message: "The team's balance cannot cover that distribution." } }, 409);
    renderPage(leadId, team);

    fireEvent.change(screen.getByLabelText("Points (whole)"), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Distribute the points" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("cannot cover that distribution"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("names an unreachable server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    renderPage(leadId, team);

    fireEvent.click(screen.getByRole("button", { name: "Remove mira" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not reach Overflow"));
  });
});
