create unique index closed_pr_dispute_requests_one_grant_per_pull_request
  on closed_pr_dispute_requests (pull_request_id)
  where decision = 'GRANTED';
