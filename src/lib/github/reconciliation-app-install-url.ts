export function reconciliationAppInstallUrl(env: { GITHUB_APP_SLUG?: string }): string | null {
  const slug = env.GITHUB_APP_SLUG;
  if (!slug || slug.match(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)?.[0] !== slug) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}
