create table registration_attempt_counts (
  utc_day date not null,
  kind text not null check (kind in (
    'REGISTRATION_START', 'MISSING_CATALOG_LABELS', 'WEBHOOK_SCOPE_MISSING',
    'NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED', 'NOT_PUBLIC', 'ALREADY_REGISTERED', 'OTHER'
  )),
  attempts integer not null check (attempts > 0),
  primary key (utc_day, kind)
);
