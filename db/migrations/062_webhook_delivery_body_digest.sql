-- The replay key rides the receipt: a digest of the signed body, scoped per
-- registration. Nullable because the previous release keeps writing
-- digest-less receipts during the switch; the dedup rule falls back to the
-- delivery-id-only rule whenever the digest is null on either side.

alter table webhook_deliveries add column body_digest text;

create index webhook_deliveries_processed_body_digest
  on webhook_deliveries (provider, registration_id, body_digest)
  where registration_id is not null and processing_state = 'PROCESSED' and body_digest is not null;
