export const migrationCompatibilityFixtures = [
  {
    name: "001_drop_column.sql",
    contents: "AlTeR TABLE items DROP\n COLUMN note;\n",
  },
  {
    name: "002_drop_table.sql",
    contents: "DROP TABLE IF EXISTS items;\n",
  },
  {
    name: "003_rename_column.sql",
    contents: "alter table items rename column note to memo;\n",
  },
  {
    name: "004_rename_table.sql",
    contents: "alter table items rename to products;\n",
  },
  {
    name: "005_alter_column_type.sql",
    contents: "alter table items alter column note type varchar(50);\n",
  },
  {
    name: "006_alter_type_without_column.sql",
    contents: "alter table items alter \"note\" type varchar(50);\n",
  },
  {
    name: "007_set_data_type.sql",
    contents: "alter table items alter column note set data type varchar(50);\n",
  },
  {
    name: "008_set_not_null.sql",
    contents: "alter table items alter column note set not null;\n",
  },
  {
    name: "009_add_not_null.sql",
    contents: "alter table items add column note text not null;\n",
  },
  {
    name: "010_create_table.sql",
    contents: "create table items (id integer not null primary key, note text not null);\n",
  },
  {
    name: "011_add_default.sql",
    contents: "alter table items add column note text not null default concat('a', 'b');\n",
  },
  {
    name: "012_add_nullable.sql",
    contents: "alter table items add column note text;\n",
  },
  {
    name: "013_create_index.sql",
    contents: "create index items_note on items (note);\n",
  },
  {
    name: "014_drop_not_null.sql",
    contents: "alter table items alter column note drop not null;\n",
  },
  {
    name: "015_safe_marker.sql",
    contents: "-- overflow: mixed-version safe: retained releases stopped using note\nalter table items drop column note;\n",
  },
  {
    name: "016_empty_safe.sql",
    contents: "-- overflow: mixed-version safe:\nalter table items drop column note;\n",
  },
  {
    name: "017_review_beats_safe.sql",
    contents: "-- overflow: mixed-version safe: retained releases stopped using note\n-- overflow: mixed-version review\nalter table items drop column note;\n",
  },
  {
    name: "018_line_comment.sql",
    contents: "-- alter table items drop column note; drop table items; rename; alter note type text; set not null; add column note text not null\nselect 1;\n",
  },
  {
    name: "019_block_comment.sql",
    contents: "/* alter table items drop column note;\n drop table items; rename; alter note type text; set not null; add column note text not null */\nselect 1;\n",
  },
  {
    name: "020_review_comment.sql",
    contents: "/* overflow: mixed-version review */\nselect 1;\n",
  },
  {
    name: "021_per_column_default.sql",
    contents: "alter table items add column a int not null default 0, add column b text not null;\n",
  },
  {
    name: "022_drop_default.sql",
    contents: "alter table items alter column note drop default;\n",
  },
  {
    name: "023_comment_between_tokens.sql",
    contents: "alter table items drop /* column documentation */ column note;\n",
  },
  {
    name: "024_multiple_shapes.sql",
    contents: "alter table items drop column note; alter table items rename to products;\n",
  },
  {
    name: "025_default_in_check.sql",
    contents: "alter table items add column note text not null check (note <> 'default');\n",
  },
  {
    name: "026_default_column_name.sql",
    contents: "alter table items add column \"default\" text not null;\n",
  },
  {
    name: "027_nested_comment.sql",
    contents: "/* outer don't /* inner */ drop table items; */\nselect 1;\n",
  },
  {
    name: "028_quoted_comment_delimiter.sql",
    contents: "select '/*'; alter table items drop column note;\n",
  },
  {
    name: "029_identifier_comment_delimiter.sql",
    contents: "alter table \"/*\" drop column note;\n",
  },
  {
    name: "030_unicode_column.sql",
    contents: "ALTER TABLE items ALTER COLUMN café TYPE bigint;\n",
  },
  {
    name: "031_dollar_default_data.sql",
    contents: "ALTER TABLE items ADD COLUMN a text NOT NULL CHECK (a <> $$default$$);\n",
  },
  {
    name: "032_safe_marker_in_notice.sql",
    contents: "DO $body$\nBEGIN\n  RAISE NOTICE '\n-- overflow: mixed-version safe: this is SQL data\n';\nEND\n$body$;\nALTER TABLE items DROP COLUMN note;\n",
  },
  {
    name: "033_escaped_e_string.sql",
    contents: "SELECT E'it\\'s /*'; ALTER TABLE items DROP COLUMN note;\n",
  },
  {
    name: "034_quoted_semicolon.sql",
    contents: "ALTER TABLE \"items;weird\" RENAME TO items_new;\n",
  },
  {
    name: "035_quoted_whitespace.sql",
    contents: "ALTER TABLE items ALTER COLUMN \"no te\" TYPE bigint;\n",
  },
  {
    name: "036_unicode_optional_column.sql",
    contents: "ALTER TABLE items ALTER café SET DATA TYPE bigint;\n",
  },
  {
    name: "037_doubled_string_quote.sql",
    contents: "SELECT 'it''s /*'; ALTER TABLE items DROP COLUMN note;\n",
  },
  {
    name: "038_safe_marker_in_dollar_data.sql",
    contents: "SELECT $data$\n-- overflow: mixed-version safe: this is SQL data\n$data$; ALTER TABLE items DROP COLUMN note;\n",
  },
  {
    name: "039_ordinary_literal_shapes.sql",
    contents: "SELECT 'ALTER TABLE items DROP COLUMN note;';\n",
  },
  {
    name: "040_dollar_literal_shapes.sql",
    contents: "SELECT $data$ALTER TABLE items DROP COLUMN note;$data$;\n",
  },
  {
    name: "041_executable_do_body.sql",
    contents: "DO $$ BEGIN ALTER TABLE items DROP COLUMN note; END $$;\n",
  },
  {
    name: "042_executable_function_body.sql",
    contents: "CREATE FUNCTION change_items() RETURNS void AS $fn$ BEGIN ALTER TABLE items DROP COLUMN note; END $fn$ LANGUAGE plpgsql;\n",
  },
  {
    name: "043_safe_comment_in_do.sql",
    contents: "DO $$\nBEGIN\n-- overflow: mixed-version safe: retained releases stopped using note\nALTER TABLE items DROP COLUMN note;\nEND $$;\n",
  },
  {
    name: "044_raw_review_literal.sql",
    contents: "SELECT 'overflow: mixed-version review';\n",
  },
  {
    name: "045_doubled_identifier_quote.sql",
    contents: "ALTER TABLE items ALTER COLUMN \"no\"\" te\" TYPE bigint;\n",
  },
  {
    name: "046_nested_do_body.sql",
    contents: "DO $outer$ BEGIN DO $inner$ BEGIN ALTER TABLE items DROP COLUMN note; END; $inner$; END; $outer$;\n",
  },
  {
    name: "047_nested_do_language.sql",
    contents: "DO $outer$ BEGIN DO LANGUAGE plpgsql $inner$ BEGIN ALTER TABLE items DROP COLUMN note; END; $inner$; END; $outer$;\n",
  },
  {
    name: "048_do_named_function_data.sql",
    contents: "SELECT public.do($data$\n-- overflow: mixed-version safe: this is SQL data\n$data$); ALTER TABLE items DROP COLUMN note;\n",
  },
  {
    name: "049_nested_quoted_language.sql",
    contents: "DO $outer$ BEGIN DO LANGUAGE 'plpgsql' $inner$ BEGIN ALTER TABLE items DROP COLUMN note; END; $inner$; END; $outer$;\n",
  },
  {
    name: "050_ordinary_do_body.sql",
    contents: "DO 'BEGIN ALTER TABLE items DROP COLUMN note; END';\n",
  },
  {
    name: "051_e_do_body.sql",
    contents: "DO E'BEGIN ALTER TABLE items DROP COLUMN note; END';\n",
  },
  {
    name: "052_ordinary_function_body.sql",
    contents: "CREATE FUNCTION change_items() RETURNS void LANGUAGE plpgsql\nAS 'BEGIN ALTER TABLE items DROP COLUMN note; END';\nSELECT change_items();\n",
  },
  {
    name: "053_fixed_execute_literal.sql",
    contents: "DO $$ BEGIN EXECUTE 'ALTER TABLE items DROP COLUMN note;'; END $$;\n",
  },
  {
    name: "054_insert_shape_data.sql",
    contents: "INSERT INTO messages (body) VALUES ('alter table x drop column y');\n",
  },
  {
    name: "055_nested_ordinary_execute.sql",
    contents: "DO 'BEGIN EXECUTE ''ALTER TABLE items DROP COLUMN note;''; END';\n",
  },
  {
    name: "056_nested_e_execute.sql",
    contents: "DO E'BEGIN EXECUTE \\'ALTER TABLE items DROP COLUMN note;\\'; END';\n",
  },
  {
    name: "057_literal_default_clause.sql",
    contents: "DO $$ BEGIN ALTER TABLE items ADD COLUMN note text NOT NULL DEFAULT 'text'; END $$;\n",
  },
  {
    name: "058_e_hex_space.sql",
    contents: "DO E'BEGIN ALTER TABLE items DROP\\x20COLUMN note; END';\n",
  },
  {
    name: "059_e_octal_space.sql",
    contents: "DO E'BEGIN ALTER TABLE items DROP\\040COLUMN note; END';\n",
  },
  {
    name: "060_e_unicode_space.sql",
    contents: "DO E'BEGIN ALTER TABLE items DROP\\u0020COLUMN note; END';\n",
  },
  {
    name: "061_e_long_unicode_space.sql",
    contents: "DO E'BEGIN ALTER TABLE items DROP\\U00000020COLUMN note; END';\n",
  },
] as const;


// These execute against a real PostgreSQL table as well as the status reader.
export const finalFixMigrationFixtures = [
  { name: "098_generated_column_name.sql", shape: "add column not null without default", writerCode: "23502",
    contents: "ALTER TABLE items ADD generated text NOT NULL;" },
  { name: "096_unicode_type_keyword.sql", shape: "alter type", writerCode: "22P02",
    contents: String.raw`DO U&'BEGIN ALTER TABLE items ALTER note TY\0050E bigint USING 1; END';` },
  { name: "097_continued_not_null.sql", shape: "set not null", writerCode: "23502",
    contents: "DO 'BEGIN ALTER TABLE items ALTER note SET NOT'\n' NULL; END';" },
  { name: "064_block_safe.sql", shape: "drop column", writerCode: "42703",
    contents: "/*\n-- overflow: mixed-version safe: example only\n*/ ALTER TABLE items DROP COLUMN note;" },
  { name: "065_unicode_identifier.sql", shape: "alter type", writerCode: "22P02",
    contents: String.raw`ALTER TABLE items ALTER COLUMN U&"note" TYPE bigint USING 1;` },
  { name: "066_unicode_literal.sql", shape: "drop column", writerCode: "42703",
    contents: String.raw`DO U&'BEGIN ALTER TABLE items DROP\0020COLUMN note; END';` },
  { name: "067_continued_literal.sql", shape: "drop column", writerCode: "42703",
    contents: "DO 'BEGIN ALTER TABLE items DROP'\n' COLUMN note; END';" },
  { name: "068_optional_drop.sql", shape: "drop column", writerCode: "42703",
    contents: "ALTER TABLE items DROP note;" },
  { name: "069_optional_add.sql", shape: "add column not null without default", writerCode: "23502",
    contents: "ALTER TABLE items ADD required text NOT NULL;" },
  { name: "070_optional_drop_if_exists.sql", shape: "drop column", writerCode: "42703",
    contents: "ALTER TABLE items DROP IF EXISTS note;" },
  { name: "071_optional_set_not_null.sql", shape: "set not null", writerCode: "23502",
    contents: "ALTER TABLE items ALTER note SET NOT NULL;" },
  { name: "072_unicode_custom_identifier.sql", shape: "alter type", writerCode: "22P02",
    contents: String.raw`ALTER TABLE items ALTER U&"n!006fte" UESCAPE '!' TYPE bigint USING 1;` },
  { name: "073_unicode_custom_literal.sql", shape: "drop column", writerCode: "42703",
    contents: String.raw`DO U&'BEGIN ALTER TABLE items DROP!+000020COLUMN note; END' UESCAPE '!';` },
  { name: "074_unicode_continuation.sql", shape: "drop column", writerCode: "42703",
    contents: "DO U&'BEGIN ALTER TABLE items DROP'\n'!0020COLUMN note; END' UESCAPE '!';" },
  { name: "075_e_continuation.sql", shape: "drop column", writerCode: "42703",
    contents: "DO E'BEGIN ALTER TABLE items DROP'\n'\\x20COLUMN note; END';" },
  { name: "076_optional_add_if_not_exists.sql", shape: "add column not null without default", writerCode: "23502",
    contents: "ALTER TABLE items ADD IF NOT EXISTS required text NOT NULL;" },
] as const;

export const lexicalCompatibilityFixtures = [
  { name: "077_unicode_safe.sql", contents: String.raw`SELECT U&'a\0062\+000063\\';`, status: "-" },
  { name: "078_unicode_surrogates.sql", contents: String.raw`SELECT U&'\D83D\DE00';`, status: "-" },
  { name: "079_unicode_bad_escape.sql", contents: String.raw`SELECT U&'\oops';`, status: "review\tunsupported lexical form" },
  { name: "080_unicode_bad_character.sql", contents: String.raw`SELECT U&'abc' UESCAPE 'a';`, status: "review\tunsupported lexical form" },
  { name: "081_unicode_bad_surrogate.sql", contents: String.raw`SELECT U&'\D800';`, status: "review\tunsupported lexical form" },
  { name: "082_unicode_out_of_range.sql", contents: String.raw`SELECT U&'\+110000';`, status: "review\tunsupported lexical form" },
  { name: "083_unicode_missing_escape.sql", contents: "SELECT U&'abc' UESCAPE;", status: "review\tunsupported lexical form" },
  { name: "084_unsupported_beats_safe.sql", contents: String.raw`-- overflow: mixed-version safe: cannot authorize unknown lexing
SELECT U&'\oops';`, status: "review\tunsupported lexical form" },
  { name: "085_optional_add_default.sql", contents: "ALTER TABLE items ADD required text NOT NULL DEFAULT 'ready';", status: "-" },
  { name: "086_constraint_actions.sql", contents: "ALTER TABLE items DROP CONSTRAINT check_note, ADD CONSTRAINT check_note CHECK (note IS NOT NULL);", status: "-" },
  { name: "087_column_actions.sql", contents: "ALTER TABLE items ALTER note DROP DEFAULT, ALTER note DROP NOT NULL, ALTER note DROP EXPRESSION IF EXISTS, ALTER note DROP IDENTITY IF EXISTS, ALTER note ADD GENERATED ALWAYS AS IDENTITY;", status: "-" },
  { name: "088_constraint_kinds.sql", contents: "ALTER TABLE items ADD PRIMARY KEY (note), ADD UNIQUE (note), ADD CHECK (note IS NOT NULL), ADD FOREIGN KEY (note) REFERENCES other(note), ADD EXCLUDE (note WITH =), ADD NOT NULL note;", status: "-" },
  { name: "089_unclosed_unicode.sql", contents: "SELECT U&'abc", status: "review\tunsupported lexical form" },
  { name: "090_unicode_comment_escape.sql", contents: String.raw`DO U&'BEGIN ALTER TABLE items DROP!0020COLUMN note; END' /* escape */ UESCAPE '!';`, status: "review\tdrop column" },
  { name: "092_unclosed_block.sql", contents: "/* unterminated comment", status: "review\tunsupported lexical form" },
  { name: "093_unclosed_string.sql", contents: "SELECT 'unterminated", status: "review\tunsupported lexical form" },
  { name: "094_unclosed_dollar.sql", contents: "SELECT $data$unterminated", status: "review\tunsupported lexical form" },
  { name: "095_nested_bad_unicode.sql", contents: String.raw`DO $$ BEGIN SELECT U&'\oops'; END $$;`, status: "review\tunsupported lexical form" },
  { name: "091_continuation_line_comment.sql", contents: "DO 'BEGIN ALTER TABLE items DROP' -- continuation\n' COLUMN note; END';", status: "review\tdrop column" },
] as const;
