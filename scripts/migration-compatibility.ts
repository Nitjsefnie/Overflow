export interface MigrationCompatibility {
  verdict: "review" | "-";
  shapes: string[];
  note?: string;
}

interface SqlToken {
  kind: "word" | "identifier" | "literal" | "symbol";
  value: string;
}

const reviewMarker = "overflow: mixed-version review";
const safeMarker = /^[\t ]*--[\t ]*overflow: mixed-version safe:[\t ]*(\S[^\r\n]*)$/m;
const identifier = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/;
const dollarDelimiter = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

/** Shape-based deploy review; only real comments can declare a migration safe. */
export function classifyMigrationCompatibility(contents: string): MigrationCompatibility {
  const { tokens, comments } = lexSql(contents);
  const statements = splitTokens(tokens, ";");
  const matches: [string, boolean][] = [
    ["drop column", hasWords(tokens, ["drop", "column"])],
    ["drop table", hasWords(tokens, ["drop", "table"])],
    ["rename", statements.some((statement) => {
      const alter = statement.findIndex((token) => wordIs(token, "alter"));
      return alter >= 0 && statement.slice(alter + 1).some((token) => wordIs(token, "rename"));
    })],
    ["alter type", tokens.some((token, at) => {
      if (!wordIs(token, "alter") || wordIs(tokens[at + 1], "table")) return false;
      let column = at + 1;
      if (wordIs(tokens[column], "column")) column += 1;
      if (tokens[column]?.kind !== "identifier" && tokens[column]?.kind !== "word") return false;
      let type = column + 1;
      if (wordsAt(tokens, type, ["set", "data"])) type += 2;
      return wordIs(tokens[type], "type");
    })],
    ["set not null", hasWords(tokens, ["set", "not", "null"])],
    ["add column not null without default", statements.some((statement) =>
      splitTokens(statement, ",").some((definition) => {
        const clauses = topLevelTokens(definition);
        return hasWords(clauses, ["add", "column"]) && hasWords(clauses, ["not", "null"]) &&
          !hasWords(clauses, ["default"]);
      }),
    )],
  ];
  const shapes = matches.filter(([, matched]) => matched).map(([shape]) => shape);

  if (contents.includes(reviewMarker)) return { verdict: "review", shapes };
  const reason = comments.map((comment) => safeMarker.exec(comment)?.[1].trim()).find(Boolean);
  if (shapes.length > 0 && reason) {
    return { verdict: "-", shapes, note: "overflow: mixed-version safe: " + reason.replace(/\s+/g, " ") };
  }
  return { verdict: shapes.length > 0 ? "review" : "-", shapes };
}

function wordIs(token: SqlToken | undefined, word: string): boolean {
  return token?.kind === "word" && token.value === word;
}

function wordsAt(tokens: readonly SqlToken[], at: number, words: readonly string[]): boolean {
  return words.every((word, offset) => wordIs(tokens[at + offset], word));
}

function hasWords(tokens: readonly SqlToken[], words: readonly string[]): boolean {
  return tokens.some((_, at) => wordsAt(tokens, at, words));
}

/** Lexical boundaries survive masking: identifiers and literals each occupy one token. */
function lexSql(sql: string): { tokens: SqlToken[]; comments: string[] } {
  const tokens: SqlToken[] = [];
  const comments: string[] = [];
  let at = 0;
  let statementStart = 0;
  while (at < sql.length) {
    const pair = sql.slice(at, at + 2);
    if (/[ \t\r\n\f\v]/.test(sql[at])) {
      at += 1;
    } else if (pair === "--") {
      let end = at + 2;
      while (end < sql.length && !/[\r\n]/.test(sql[end])) end += 1;
      comments.push(sql.slice(at, end));
      at = end;
    } else if (pair === "/*") {
      const end = blockCommentEnd(sql, at);
      comments.push(sql.slice(at, end));
      at = end;
    } else if (sql[at] === "'" || /^[eE]'/.test(pair)) {
      const escaped = sql[at] !== "'";
      at = quotedEnd(sql, at + (escaped ? 1 : 0), escaped);
      tokens.push({ kind: "literal", value: "" });
    } else if (sql[at] === '"') {
      const end = quotedEnd(sql, at, false);
      tokens.push({ kind: "identifier", value: sql.slice(at, end) });
      at = end;
    } else {
      const delimiter = dollarDelimiter.exec(sql.slice(at))?.[0];
      if (delimiter) {
        const start = at + delimiter.length;
        const closing = sql.indexOf(delimiter, start);
        const end = closing < 0 ? sql.length : closing;
        if (isExecutableBody(tokens.slice(statementStart))) {
          const body = lexSql(sql.slice(start, end));
          tokens.push({ kind: "symbol", value: ";" }, ...body.tokens, { kind: "symbol", value: ";" });
          comments.push(...body.comments);
          statementStart = tokens.length;
        } else {
          tokens.push({ kind: "literal", value: "" });
        }
        at = closing < 0 ? sql.length : closing + delimiter.length;
      } else {
        const name = identifier.exec(sql.slice(at))?.[0];
        if (name) {
          tokens.push({ kind: "word", value: name.toLowerCase() });
          at += name.length;
        } else {
          tokens.push({ kind: "symbol", value: sql[at] });
          if (sql[at] === ";") statementStart = tokens.length;
          at += 1;
        }
      }
    }
  }
  return { tokens, comments };
}

function isExecutableBody(statement: readonly SqlToken[]): boolean {
  return wordIs(statement[0], "do") ||
    (statement.some((token) => wordIs(token, "create")) &&
      statement.some((token) => wordIs(token, "function") || wordIs(token, "procedure")) &&
      wordIs(statement.at(-1), "as"));
}

function quotedEnd(sql: string, start: number, escaped: boolean): number {
  const quote = sql[start];
  let at = start + 1;
  while (at < sql.length) {
    if (escaped && sql[at] === "\\") {
      at += 2;
    } else if (sql[at] === quote) {
      if (sql[at + 1] === quote) at += 2;
      else return at + 1;
    } else {
      at += 1;
    }
  }
  return sql.length;
}

function blockCommentEnd(sql: string, start: number): number {
  let depth = 1;
  let at = start + 2;
  while (at < sql.length && depth > 0) {
    const pair = sql.slice(at, at + 2);
    if (pair === "/*") { depth += 1; at += 2; }
    else if (pair === "*/") { depth -= 1; at += 2; }
    else at += 1;
  }
  return at;
}

function splitTokens(tokens: readonly SqlToken[], separator: string): SqlToken[][] {
  const parts: SqlToken[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "symbol" && (token.value === "(" || token.value === "[")) depth += 1;
    if (token.kind === "symbol" && (token.value === ")" || token.value === "]")) depth -= 1;
    if (token.kind === "symbol" && token.value === separator && (separator === ";" || depth === 0)) {
      parts.push([]);
    } else {
      parts[parts.length - 1].push(token);
    }
  }
  return parts;
}

/** Column DEFAULT and NOT NULL clauses are outside nested type/expression arguments. */
function topLevelTokens(tokens: readonly SqlToken[]): SqlToken[] {
  const visible: SqlToken[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "symbol" && (token.value === ")" || token.value === "]")) depth -= 1;
    if (depth === 0) visible.push(token);
    if (token.kind === "symbol" && (token.value === "(" || token.value === "[")) depth += 1;
  }
  return visible;
}
