create table repository_reconciliation_usage (
  sponsor_id uuid not null references users(id),
  repository_id uuid not null references registered_repositories(id),
  debt double precision not null check (debt >= 0 and debt < 'Infinity'::double precision),
  measured_at timestamp with time zone not null check (isfinite(measured_at)),
  rate_per_second double precision not null check (rate_per_second >= 0 and rate_per_second < 'Infinity'::double precision),
  primary key (sponsor_id, repository_id)
);

alter table reconciliation_runs
  add column graphql_cost bigint check (graphql_cost between 0 and 9007199254740991),
  add column graphql_cost_sponsor_id uuid references users(id),
  add column graphql_observed_responses integer check (graphql_observed_responses >= 0),
  add column graphql_unmeasured_responses integer check (graphql_unmeasured_responses >= 0),
  add constraint reconciliation_cost_observation_shape check (
    (graphql_cost_sponsor_id is null and graphql_cost is null and graphql_observed_responses is null and graphql_unmeasured_responses is null)
    or (graphql_cost_sponsor_id is not null
      and graphql_observed_responses is not null and graphql_unmeasured_responses is not null
      and ((graphql_observed_responses = 0 and graphql_cost is null)
        or (graphql_observed_responses > 0 and graphql_cost is not null)))
  );
