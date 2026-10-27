-- Contributor work mail: opt-in address, confirmation history, daily ceiling.
create table contributor_work_mail_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users (id),
  address text not null check (length(address) <= 254),
  confirm_token_hash bytea unique,
  confirm_expires_at timestamptz,
  confirmed_at timestamptz,
  -- The digest window's watermark: the start of the cycle that last claimed this row.
  last_notified_at timestamptz,
  -- The database time of that claim; the 24-hour floor between digests reads this.
  last_digest_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (confirmed_at is not null or (confirm_token_hash is not null and confirm_expires_at is not null))
);

-- One row per confirmation mail sent; the digest is keyed, so the address itself is stored only above.
create table contributor_work_mail_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  address_digest bytea not null,
  sent_at timestamptz not null default now()
);

create index contributor_work_mail_confirmations_user_key
  on contributor_work_mail_confirmations (user_id, sent_at);
create index contributor_work_mail_confirmations_digest_key
  on contributor_work_mail_confirmations (address_digest, sent_at);

create table contributor_work_mail_daily (
  utc_day date primary key,
  sent integer not null check (sent >= 0)
);
