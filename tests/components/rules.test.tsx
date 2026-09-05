/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RulesContent } from "@/app/rules/page";
import { AppShell } from "@/components/app-shell";

describe("rules page", () => {
  it("explains how opening difficulty and outside-work reservations are set", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    const opening = screen.getByRole("region", { name: "Before work starts" });
    expect(opening).toHaveTextContent(/repositories choose their own difficulty labels.*1–10 points/i);
    expect(opening).toHaveTextContent(/issue owner.*earliest.*before the first assignment.*opening estimate/i);
    expect(opening).toHaveTextContent(/outside contributors.*reserve points.*sponsor.*balance/i);
    expect(opening).toHaveTextContent(/available balance.*negative/i);
  });

  it("states each piece of evidence a settlement requires", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    const evidence = screen.getByRole("region", { name: "When work counts" });
    expect(evidence).toHaveTextContent(/merged pull request.*close the issue in GitHub/i);
    expect(evidence).toHaveTextContent(/link alone does not count/i);
    expect(evidence).toHaveTextContent(/issue owner.*exactly one final-difficulty label/i);
    expect(evidence).toHaveTextContent(/final commit.*merge.*exactly one final-difficulty label/i);
    expect(evidence).toHaveTextContent(/comment naming it/i);
    expect(evidence).toHaveTextContent(/pull request labels do not/i);
    expect(evidence).toHaveTextContent(/15-minute tolerance/i);
  });

  it("states how credits and self-work are handled", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    const credits = screen.getByRole("region", { name: "Credits" });
    expect(credits).toHaveTextContent(/final difficulty points.*distinct review rounds.*minimum of 0/i);
    expect(credits).toHaveTextContent(/repository you sponsor.*no credits.*difficulty ratings/i);
    expect(credits).toHaveTextContent(/calibration evidence/i);
    expect(credits).toHaveTextContent(/signing in.*claims.*GitHub identity/i);
    expect(credits).toHaveTextContent(/activity and inactivity do not affect/i);
  });

  it("states the moderation ladder and evidence requirements", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    const moderation = screen.getByRole("region", { name: "Moderation" });
    expect(moderation).toHaveTextContent("Audit → warn → recalibrate → ban");
    expect(moderation).toHaveTextContent(/audit requires examples comparing.*sponsored repositories.*outside contributors/i);
    expect(moderation).toHaveTextContent(/warnings require supporting evidence/i);
    expect(moderation).toHaveTextContent(/nonblank recalibration plan.*correct.*difficulty ratings.*reactivated/i);
    expect(moderation).toHaveTextContent(/bans require confirmed problems that continue/i);
  });

  it("does not expose internal implementation terms", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    const main = screen.getByRole("main");
    expect(main).not.toHaveTextContent(/closedByPullRequestsReferences/);
    expect(main).not.toHaveTextContent(/actual-catalog/);
    expect(main).not.toHaveTextContent(/paired samples/);
  });

  it("is reachable from the member navigation", () => {
    render(
      <AppShell memberName="Ada Lovelace" isModerator={false}>
        <p>content</p>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "Rules" })).toHaveAttribute("href", "/rules");
  });
});
