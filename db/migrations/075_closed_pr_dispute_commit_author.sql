-- Author id.
alter table closed_pr_dispute_requests add column landed_commit_author_id uuid references users (id);
