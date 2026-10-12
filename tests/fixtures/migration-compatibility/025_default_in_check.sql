alter table items add column note text not null check (note <> 'default');
