export function registrationAppConfigured(env: Partial<Record<string, string>>): boolean {
  return Boolean(env.GITHUB_REGISTRATION_APP_ID?.length && env.GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH?.length);
}

export function registrationAppInstallUrl(slug: string | undefined): string | null {
  return slug !== undefined && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.exec(slug)?.[0] === slug
    ? `https://github.com/apps/${slug}/installations/new` : null;
}
