-- The reserved forge label marking an issue that asks for actions outside its repository, as last folded.
alter table issues add column asks_outside_repository boolean not null default false;
