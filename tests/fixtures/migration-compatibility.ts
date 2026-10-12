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
] as const;
