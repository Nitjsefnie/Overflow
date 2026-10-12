export interface MigrationCompatibility {
  verdict: "review" | "-";
  shapes: string[];
  note?: string;
}

const reviewMarker = "overflow: mixed-version review";
const safeMarker = /^[\t ]*--[\t ]*overflow: mixed-version safe:[\t ]*(\S[^\r\n]*)$/m;
const dangerousShapes: readonly [string, RegExp][] = [
  ["drop column", /\bdrop column\b/i],
  ["drop table", /\bdrop table\b/i],
  ["rename", /\balter\b[^;]*\brename\b/i],
  ["alter type", /\balter (?:column )?(?:"(?:[^"]|"")*"|[\w$]+) (?:set data )?type\b/i],
  ["set not null", /\bset not null\b/i],
];

/** Shape-based deploy review; explicit review always wins over a reasoned safe comment. */
export function classifyMigrationCompatibility(contents: string): MigrationCompatibility {
  const sql = sqlWithoutComments(contents).replace(/\s+/g, " ");
  const shapes = dangerousShapes.filter(([, pattern]) => pattern.test(sql)).map(([shape]) => shape);
  if (columnDefinitions(sql).some((definition) =>
    /\badd column\b/i.test(definition) && /\bnot null\b/i.test(definition) &&
    !/\bdefault\b/i.test(definition.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "")),
  )) {
    shapes.push("add column not null without default");
  }

  if (contents.includes(reviewMarker)) return { verdict: "review", shapes };
  const reason = safeMarker.exec(contents)?.[1].trim();
  if (shapes.length > 0 && reason) {
    return { verdict: "-", shapes, note: `overflow: mixed-version safe: ${reason.replace(/\s+/g, " ")}` };
  }
  return { verdict: shapes.length > 0 ? "review" : "-", shapes };
}

/** PostgreSQL block comments nest; quoted delimiters are SQL text, not comments. */
function sqlWithoutComments(contents: string): string {
  const quotedSql = /'(?:[^']|'')*'|"(?:[^"]|"")*"/y;
  let sql = "";
  let blockDepth = 0;
  for (let at = 0; at < contents.length; at += 1) {
    const pair = contents.slice(at, at + 2);
    if (blockDepth > 0) {
      if (pair === "/*") {
        blockDepth += 1;
        at += 1;
      } else if (pair === "*/") {
        blockDepth -= 1;
        at += 1;
      }
    } else if (pair === "/*") {
      blockDepth = 1;
      sql += " ";
      at += 1;
    } else if (pair === "--") {
      while (at + 1 < contents.length && !/[\r\n]/.test(contents[at + 1])) at += 1;
      sql += " ";
    } else if (contents[at] === "'" || contents[at] === '"') {
      quotedSql.lastIndex = at;
      const quoted = quotedSql.exec(contents)?.[0];
      sql += quoted ?? contents[at];
      at += (quoted?.length ?? 1) - 1;
    } else {
      sql += contents[at];
    }
  }
  return sql;
}

/** Split ALTER actions without mistaking commas in defaults or type arguments for actions. */
function columnDefinitions(sql: string): string[] {
  const definitions: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let at = 0; at < sql.length; at += 1) {
    const character = sql[at];
    if (quote) {
      if (character === quote) {
        if (sql[at + 1] === quote) at += 1;
        else quote = "";
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (depth === 0 && (character === "," || character === ";")) {
      definitions.push(sql.slice(start, at));
      start = at + 1;
    }
  }
  definitions.push(sql.slice(start));
  return definitions;
}
