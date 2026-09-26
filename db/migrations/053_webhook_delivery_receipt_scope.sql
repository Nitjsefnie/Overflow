-- Legacy rows keep the global key the previous release still writes.
-- Scoped rows leave it null and are unique per provider, registration and delivery key.

alter table webhook_deliveries
  alter column github_delivery_id drop not null,
  add column provider text,
  add column registration_id uuid,
  add column delivery_key text,
  add column execution_id text;

alter table webhook_deliveries
  add constraint webhook_deliveries_receipt_shape_check check (
    (
      github_delivery_id is not null
      and provider is null and registration_id is null
      and delivery_key is null and execution_id is null
    )
    or (
      github_delivery_id is null
      and provider in ('github', 'gitlab')
      and registration_id is not null
      and delivery_key is not null and length(trim(delivery_key)) > 0
      and execution_id is not null and length(trim(execution_id)) > 0
    )
  );

create unique index webhook_deliveries_scoped_receipt
  on webhook_deliveries (provider, registration_id, delivery_key)
  where registration_id is not null;
