alter table registered_repositories
  add column webhook_credential_id uuid,
  add column encrypted_webhook_secret bytea,
  add column webhook_configured_at timestamptz,
  add constraint repository_webhook_credential_pair check (
    (webhook_credential_id is null) = (encrypted_webhook_secret is null)
  ),
  add constraint repository_webhook_configuration_material check (
    webhook_configured_at is null or webhook_credential_id is not null
  ),
  add constraint repository_webhook_material_hook check (
    webhook_credential_id is null or github_webhook_id is not null
  );

create unique index repository_webhook_credential_selector
  on registered_repositories (webhook_credential_id)
  where webhook_credential_id is not null;
