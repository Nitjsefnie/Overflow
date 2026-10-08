-- Nothing stores the GitHub avatar URL anymore (issue 1075): the sign-in
-- upsert stopped writing the column, the session cookie dropped the picture
-- claim, and the export no longer carries it. The column stays so old rows
-- need no drop; this nulls what the write path already stopped collecting, so
-- every row reads the same and the `users_deleted_account_scrubbed_check`
-- keeps reading a null avatar as scrubbed. The deletion scrub (045) still
-- clears it for any row that could otherwise carry a stale value.
--
-- avatar_url has been nullable since 001, so there is no NOT NULL to drop.

update users set avatar_url = null;
