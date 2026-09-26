-- The instant an Overflow-issued API token stops authenticating.
--
-- A token authenticates as its owner with every action the owner's role
-- permits, moderation and override decisions included for a moderator, so a
-- credential minted to register repositories from a script must not keep that
-- authority indefinitely. Every token now carries a bounded lifetime: ninety
-- days from generation, restarted by every regeneration. The store writes the
-- expiry when it issues a token and refuses a token whose expiry has passed,
-- by the database clock, exactly as it refuses a token it never issued.
--
-- Tokens that exist when this migration runs expire ninety days from the
-- migration, not ninety days from their `created_at`. Measured from
-- generation, a token already older than ninety days would stop working the
-- moment the deploy lands, and every other token would lose part of a lifetime
-- its owner was never told about, breaking the scripts that hold them without
-- warning. Measuring from now gives each owner a full lifetime to regenerate.
--
-- The column defaults to the same ninety days. The store states the expiry
-- itself on every write; the default covers the previous release's first
-- issue of a token. The deploy migrates before it builds and restarts, so the
-- previous release keeps serving through the build, and a release-level
-- rollback runs that same build against this schema. Its insert names no
-- `expires_at`, and without a default `not null` would refuse it: every first
-- token generation would fail for the whole deploy window and after any
-- rollback. A default applies only on insert, so that release's regeneration
-- (an upsert that sets `token_hash` and `created_at` alone) keeps the replaced
-- token's `expires_at`. The regenerated token then expires no later than its
-- predecessor would have, which is harmless inside a normal deploy window.

alter table api_tokens add column expires_at timestamp with time zone;

update api_tokens set expires_at = now() + interval '90 days';

alter table api_tokens alter column expires_at set default now() + interval '90 days';

alter table api_tokens alter column expires_at set not null;
