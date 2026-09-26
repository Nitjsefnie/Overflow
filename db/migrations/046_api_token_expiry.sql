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
-- The column has no default. The lifetime is decided in one place, the code
-- that issues a token, and a writer that forgets to state an expiry is refused
-- by `not null` instead of silently receiving one.

alter table api_tokens add column expires_at timestamp with time zone;

update api_tokens set expires_at = now() + interval '90 days';

alter table api_tokens alter column expires_at set not null;
