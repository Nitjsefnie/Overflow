export function hasNextLink(linkHeader: string | null): boolean {
  return linkHeader?.split(",").some((link) => /rel="?next"?/.test(link)) ?? false;
}

// Missing last-page metadata leaves the collection size unknown.
export function lastLinkPage(linkHeader: string | null): number | null {
  const last = linkHeader?.split(",").find((link) => /rel="?last"?/.test(link));
  if (last === undefined) return null;
  const target = /<([^>]+)>/.exec(last)?.[1];
  if (target === undefined) return null;
  const page = Number(new URL(target, "https://api.github.com").searchParams.get("page"));
  return Number.isSafeInteger(page) && page >= 1 ? page : null;
}
