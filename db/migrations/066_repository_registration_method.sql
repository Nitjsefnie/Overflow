-- Track GitHub App and OAuth webhook registrations (issue 1236).
alter table registered_repositories
  add column registration_method text not null default 'oauth_hook'
  check (registration_method in ('oauth_hook', 'app'));
