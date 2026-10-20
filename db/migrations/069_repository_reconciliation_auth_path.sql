-- Record which GitHub authentication path a repository's latest fold resolved.
alter table registered_repositories
  add column reconciliation_auth_path text
    check (reconciliation_auth_path in
      ('github-app-installation', 'registration-app-installation', 'sponsor-oauth-fallback')),
  add column reconciliation_auth_path_at timestamptz;
