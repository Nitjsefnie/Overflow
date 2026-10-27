alter type settlement_status add value if not exists 'DONATED';

alter table settlements add column donation_comment_id text;
