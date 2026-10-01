-- The instant an Overflow-issued API token is known to have reached its holder.
--
-- An API token is delivered in a single response body, and the store writes
-- the hash before that body is sent. If the process dies in between, the row
-- commits and the plaintext does not arrive: the client holds no value, so it
-- can neither use the credential nor revoke it, and nothing in the product
-- knows the difference between a token in a script and a token in a dead
-- process's page cache. Until this column, such a row stayed live for its full
-- ninety days.
--
-- `confirmed_at` is the first instant a request authenticated with the token's
-- plaintext, which is the only evidence in the system that the value reached
-- somebody. Until then the row is UNCONFIRMED: the holder has not been proven
-- to have it, so it carries a short delivery window instead of a lifetime, and
-- a value nobody ever presented stops authenticating long before a value in
-- use does. Confirmation is what starts the ninety days, so the lifetime the
-- copy promises is the lifetime of a credential that demonstrably exists.
--
-- The column is nullable with no default. The release still serving while a
-- deploy builds, and a rollback target, issue tokens without naming it, and
-- `not null` without a default would refuse those inserts: first token
-- generation would fail for the whole deploy window and after any rollback. A
-- default would be worse than useless, because it would stamp every such token
-- as confirmed — asserting possession of a credential that may never have left
-- the process that minted it.
--
-- The rewrite below splits the rows that exist when this migration runs in two,
-- and the split is what makes it worth running at all.
--
-- A row whose `last_used_at` is set carries proof that the value it holds has
-- been presented. `issueToken` clears `last_used_at` in the same statement that
-- rotates the hash and resets `created_at`, so on any row this release wrote, a
-- surviving stamp is a use of the CURRENT value, after the CURRENT generation:
-- the use cannot predate the value, because the generation that installed the
-- value erased the previous stamp along with it. Those rows are confirmed at
-- the instant of that use and keep the expiry they already had. Clamping them
-- would break a working credential for no security gain — and the cost of that
-- is not symmetric with the gain: a member with a live script sees a 401 on its
-- next run after every deploy, and an automated caller usually does not retry.
--
-- One caveat, recorded here rather than argued away. Migration 054 notes that
-- after a release-level rollback the previous release's upsert neither rotates
-- the id nor clears `last_used_at`. So on a row such a release regenerated,
-- `last_used_at` can describe a use of the PREVIOUS value, and this migration
-- will confirm it on that evidence. That is a rollback to a pre-054 release
-- and a narrow edge: the window is between that rollback and the next deploy,
-- and it requires the member not to regenerate in it.
--
-- A row with no stamp at all is the other population, and it is the defect's
-- own: a token nobody has used since it was minted, which may be one whose
-- response never arrived. Those rows are left unconfirmed and clamped to the
-- delivery window. They are also the only rows the clamp can reach, because it
-- runs after the backfill and tests `confirmed_at is null` — the same test of
-- "unconfirmed" the store uses when it confirms a token on first use, so the
-- two cannot drift apart.
--
-- Finally the column default moves from the lifetime to the window. The default
-- exists for one writer: the release that predates the column, whose insert
-- names no `expires_at` and would be refused by `not null` without a default.
-- Under the semantics this migration introduces, that same insert writes
-- `confirmed_at = null` beside a ninety-day expiry — an unconfirmed credential
-- carrying a full lifetime, which is the orphan this column exists to bound,
-- reintroduced on every deploy and after every rollback. The default stays,
-- because 046's reason for having one still holds; only its value changes.

alter table api_tokens add column confirmed_at timestamp with time zone;

update api_tokens set confirmed_at = last_used_at where last_used_at is not null;

update api_tokens set expires_at = now() + interval '30 minutes' where confirmed_at is null;

alter table api_tokens alter column expires_at set default now() + interval '30 minutes';