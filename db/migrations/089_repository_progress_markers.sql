alter table registered_repositories
  add column first_listed_issue_id bigint,
  add column second_issue_listed boolean not null default false,
  add column contributor_review_received boolean not null default false;

update registered_repositories as repository
set first_listed_issue_id = (
      select min(issues.github_issue_id) from issues where issues.repository_id = repository.id
    ),
    second_issue_listed = (
      select count(distinct issues.github_issue_id) >= 2 from issues where issues.repository_id = repository.id
    ),
    contributor_review_received = exists (
      select 1 from pull_requests
      join review_rounds on review_rounds.pull_request_id = pull_requests.id
      where pull_requests.repository_id = repository.id
        and pull_requests.author_id is not null and pull_requests.author_id <> repository.sponsor_id
    );
