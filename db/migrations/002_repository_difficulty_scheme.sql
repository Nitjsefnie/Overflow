alter table registered_repositories
add column difficulty_scheme jsonb
check (difficulty_scheme is null or jsonb_typeof(difficulty_scheme) = 'object');
