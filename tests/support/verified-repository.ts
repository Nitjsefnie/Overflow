import type { GitHubRepository } from "@/lib/github/types";

/**
 * Identity verification for suites whose subject is something else: the registered
 * numeric id resolves to the public path that registration already holds, so the
 * crawl aims where those suites expect it to.
 */
export function verifiedRepositoryAt(ownerName: string): (githubRepositoryId: number) => Promise<GitHubRepository> {
  const [owner, name] = splitOwnerName(ownerName);
  return async (githubRepositoryId) => ({
    id: githubRepositoryId,
    owner,
    name,
    ownerType: "USER",
    fullName: ownerName,
    visibility: "PUBLIC",
    url: `https://github.com/${ownerName}`,
    canAdminister: true,
  });
}

/** The same answer as the REST body of `GET /repositories/{id}`, for suites driving a real gateway. */
export function verifiedRepositoryPayload(githubRepositoryId: number, ownerName: string) {
  const [owner, name] = splitOwnerName(ownerName);
  return {
    id: githubRepositoryId,
    name,
    full_name: ownerName,
    private: false,
    html_url: `https://github.com/${ownerName}`,
    owner: { login: owner, type: "User" },
  };
}

function splitOwnerName(ownerName: string): [string, string] {
  const [owner = "", name = ""] = ownerName.split("/");
  return [owner, name];
}
