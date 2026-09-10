import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { GitLabGateway } from "@/lib/gitlab/client";
import { ForgeGatewayResolutionError, resolveGateway, type ForgeGateway } from "@/lib/forge/gateway";

/**
 * The seam is a compile-time contract: both gateways are assignable to
 * ForgeGateway (typecheck proves it), the resolver wires the right class, and
 * a GitLab selection without a verified identity is refused loudly.
 */
describe("forge gateway seam", () => {
  it("admits both gateways as ForgeGateway implementations", () => {
    const gateways: ForgeGateway[] = [
      new GitHubGateway({ accessToken: "gho-test" }),
      new GitLabGateway({ instanceUrl: "https://gitlab.com", token: "glpat-test" }),
    ];
    expect(gateways).toHaveLength(2);
  });

  it("resolves github to the existing wiring and gitlab to the PAT gateway", () => {
    const github = resolveGateway({
      provider: "github",
      instanceUrl: null,
      github: { accessToken: "gho-test", owner: "user-1" },
      gitlab: null,
    });
    expect(github).toBeInstanceOf(GitHubGateway);

    const gitlab = resolveGateway({
      provider: "gitlab",
      instanceUrl: "https://gitlab.example.com",
      github: { accessToken: "github-token" },
      gitlab: { instanceUrl: "https://gitlab.example.com", token: "glpat-test" },
    });
    expect(gitlab).toBeInstanceOf(GitLabGateway);
  });

  it("refuses a gitlab selection without a verified identity and an unknown provider", () => {
    expect(() =>
      resolveGateway({
        provider: "gitlab",
        instanceUrl: "https://gitlab.example.com",
        github: { accessToken: "github-token" },
        gitlab: null,
      }),
    ).toThrow(ForgeGatewayResolutionError);
    expect(() =>
      resolveGateway({
        provider: "classical",
        instanceUrl: null,
        github: { accessToken: "github-token" },
        gitlab: null,
      }),
    ).toThrow(/Unknown forge provider/);
  });
});
