-- Issue 671: a linked forge identity's instance is https only.
--
-- Every request to a member's GitLab instance carries that member's token in
-- its Authorization header, so an http instance would receive the credential
-- in cleartext. The application gate, normalizeInstanceUrl, refuses any scheme
-- but https before a request is built; this CHECK makes the same rule a
-- property of the stored row, replacing 038's typo guard, which admitted
-- http as well. The shape it guards is otherwise unchanged: scheme and host,
-- no path, no trailing slash.
--
-- 038 declared the CHECK inline and unnamed, so it carries Postgres's
-- generated name; the replacement keeps that name. Production holds no
-- user_forge_identities rows, so validating the constraint rewrites nothing.

alter table user_forge_identities
  drop constraint user_forge_identities_instance_url_check,
  add constraint user_forge_identities_instance_url_check
    check (instance_url ~* '^https://[^/]+$');
