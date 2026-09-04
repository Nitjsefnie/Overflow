alter table reconciliation_changes
drop constraint if exists reconciliation_changes_pull_request_id_fkey;

alter table reconciliation_changes
add constraint reconciliation_changes_pull_request_id_fkey
foreign key (pull_request_id) references pull_requests(id) on delete set null;
