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
  const { tokens, comments, unsupported } = lexSql(contents);
  const matches = new Map(matchShapes(tokens, true));
  if (unsupported) matches.set("unsupported lexical form", true);
  // Every literal may contain executable SQL. Its tokens remain separate so
  // neither DEFAULT clauses nor safe comments can authorize the outer file.
  const literals = tokens.filter((token) => token.kind === "literal");
  for (let at = 0; at < literals.length; at += 1) {
    const body = lexSql(literals[at].value, false);
    if (body.unsupported) matches.set("unsupported lexical form", true);
    for (const [shape, matched] of matchShapes(body.tokens, false)) {
      if (matched) matches.set(shape, true);
    }
    for (const token of body.tokens) {
      if (token.kind === "literal") literals.push(token);
    }
  }
  const shapes = [...matches].filter(([, matched]) => matched).map(([shape]) => shape);

  if (matches.get("unsupported lexical form") || contents.includes(reviewMarker)) return { verdict: "review", shapes };
  const reason = comments.map((comment) => safeMarker.exec(comment)?.[1].trim()).find(Boolean);
  if (shapes.length > 0 && reason) {
    return { verdict: "-", shapes, note: "overflow: mixed-version safe: " + reason.replace(/\s+/g, " ") };
  }
  return { verdict: shapes.length > 0 ? "review" : "-", shapes };
}

// PostgreSQL ALTER TABLE action grammar, including nested column actions.
// Quoted names are never action keywords, even if their text matches one.
const nonColumnDrop = new Set(["constraint", "default", "not", "expression", "identity"]);
// GENERATED is a nested ALTER-column action and also a valid column name.
const nonColumnAdd = new Set(["constraint", "primary", "unique", "check", "foreign", "exclude", "not"]);

function matchShapes(tokens: readonly SqlToken[], allowDefault: boolean): [string, boolean][] {
  const statements = splitTokens(tokens, ";");
  const matches: [string, boolean][] = [
    ["drop column", hasWords(tokens, ["drop", "column"]) || statements.some((statement) =>
      hasWords(statement, ["alter", "table"]) && statement.some((token, at) =>
        wordIs(token, "drop") && !(statement[at + 1]?.kind === "word" && nonColumnDrop.has(statement[at + 1].value)) &&
        statement[at + 1]?.kind !== "literal",
      ),
    )],
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
        const addColumn = hasWords(clauses, ["add", "column"]) ||
          (hasWords(statement, ["alter", "table"]) && clauses.some((token, at) =>
            wordIs(token, "add") && !(clauses[at + 1]?.kind === "word" && nonColumnAdd.has(clauses[at + 1].value)),
          ));
        return addColumn && hasWords(clauses, ["not", "null"]) &&
          (!allowDefault || !hasWords(clauses, ["default"]));
      }),
    )],
  ];
  return matches;
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
function lexSql(sql: string, strict = true): { tokens: SqlToken[]; comments: string[]; unsupported: boolean } {
  const tokens: SqlToken[] = [];
  // Only actual -- comments may authorize; block-comment text never enters this list.
  const comments: string[] = [];
  let unsupported = false;
  let at = 0;
  while (at < sql.length) {
    const trivia = skipTrivia(sql, at, comments);
    if (trivia > at) {
      if (strict && trivia > sql.length) unsupported = true;
      at = trivia;
      continue;
    }
    const unicode = /^[uU]&['"]/.test(sql.slice(at, at + 3));
    const escaped = /^[eE]'/.test(sql.slice(at, at + 2));
    const start = at + (unicode ? 2 : escaped ? 1 : 0);
    if (sql[start] === "'" || sql[start] === '"') {
      const quote = sql[start];
      let end = quotedEnd(sql, start, escaped);
      let value = sql.slice(start + 1, end ?? sql.length).slice(0, end === undefined ? undefined : -1);
      if (end === undefined && (strict || unicode)) unsupported = true;
      at = end ?? sql.length;
      // PostgreSQL continues single-quoted strings across newline-containing trivia.
      // Decode once after concatenation: continuations inherit E/U& from the first part.
      if (quote === "'") {
        while (end !== undefined) {
          const next = skipTrivia(sql, at);
          if (!/[\r\n]/.test(sql.slice(at, next)) || sql[next] !== "'") break;
          skipTrivia(sql, at, comments);
          end = quotedEnd(sql, next, escaped);
          value += sql.slice(next + 1, end ?? sql.length).slice(0, end === undefined ? undefined : -1);
          if (end === undefined && (strict || unicode)) unsupported = true;
          at = end ?? sql.length;
        }
      }
      value = value.replace(quote === "'" ? /''/g : /""/g, quote);
      if (unicode) {
        let escape = "\\";
        const next = skipTrivia(sql, at);
        if (/^uescape\b/i.test(sql.slice(next))) {
          skipTrivia(sql, at, comments);
          const escapeStart = skipTrivia(sql, next + 7, comments);
          const escapeEnd = sql[escapeStart] === "'" ? quotedEnd(sql, escapeStart, false) : undefined;
          const character = escapeEnd === undefined ? "" : sql.slice(escapeStart + 1, escapeEnd - 1).replace(/''/g, "'");
          if ([...character].length !== 1 || /[0-9a-f+\s'"]/i.test(character)) unsupported = true;
          else escape = character;
          at = escapeEnd ?? escapeStart;
        }
        const decoded = decodeUnicode(value, escape);
        if (decoded === undefined) unsupported = true;
        else value = decoded;
      } else if (escaped) value = unescapeString(value);
      tokens.push({ kind: quote === "'" ? "literal" : "identifier", value });
    } else {
      const delimiter = dollarDelimiter.exec(sql.slice(at))?.[0];
      if (delimiter) {
        const start = at + delimiter.length;
        const closing = sql.indexOf(delimiter, start);
        if (closing < 0 && strict) unsupported = true;
        const end = closing < 0 ? sql.length : closing;
        tokens.push({ kind: "literal", value: sql.slice(start, end) });
        at = closing < 0 ? sql.length : closing + delimiter.length;
      } else {
        const name = identifier.exec(sql.slice(at))?.[0];
        if (name) {
          tokens.push({ kind: "word", value: name.toLowerCase() });
          at += name.length;
        } else {
          tokens.push({ kind: "symbol", value: sql[at] });
          at += 1;
        }
      }
    }
  }
  return { tokens, comments, unsupported };
}

/** Skip comments as whitespace while retaining line-comment authorization provenance. */
function skipTrivia(sql: string, start: number, comments?: string[]): number {
  let at = start;
  while (at < sql.length) {
    if (/\s/.test(sql[at])) at += 1;
    else if (sql.slice(at, at + 2) === "--") {
      let end = at + 2;
      while (end < sql.length && !/[\r\n]/.test(sql[end])) end += 1;
      comments?.push(sql.slice(at, end));
      at = end;
    } else if (sql.slice(at, at + 2) === "/*") at = blockCommentEnd(sql, at);
    else break;
  }
  return at;
}

/** PostgreSQL U& escapes: four hex digits, +six hex digits, doubled escape, surrogate pairs. */
function decodeUnicode(value: string, escape: string): string | undefined {
  let decoded = "";
  let high: number | undefined;
  for (let at = 0; at < value.length;) {
    let point: number;
    if (value.startsWith(escape, at)) {
      at += escape.length;
      if (value.startsWith(escape, at)) { point = escape.codePointAt(0)!; at += escape.length; }
      else {
        const long = value[at] === "+";
        if (long) at += 1;
        const digits = value.slice(at, at + (long ? 6 : 4));
        if (!(long ? /^[\da-f]{6}$/i : /^[\da-f]{4}$/i).test(digits)) return undefined;
        point = parseInt(digits, 16);
        at += digits.length;
      }
    } else { point = value.codePointAt(at)!; at += point > 0xffff ? 2 : 1; }
    if (point === 0 || point > 0x10ffff) return undefined;
    if (high !== undefined) {
      if (point < 0xdc00 || point > 0xdfff) return undefined;
      decoded += String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + point - 0xdc00);
      high = undefined;
    } else if (point >= 0xd800 && point <= 0xdbff) high = point;
    else if (point >= 0xdc00 && point <= 0xdfff) return undefined;
    else decoded += String.fromCodePoint(point);
  }
  return high === undefined ? decoded : undefined;
}

function unescapeString(value: string): string {
  const escapes: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  return value.replace(/\\([0-7]{1,3}|x[\da-fA-F]{1,2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|[\s\S])/g,
    (_, escape: string) => {
      if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8) & 0xff);
      if (escape.startsWith("x") && escape.length > 1) return String.fromCharCode(parseInt(escape.slice(1), 16));
      if (/^[uU]/.test(escape) && escape.length > 1) {
        const point = parseInt(escape.slice(1), 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
      }
      return escapes[escape] ?? escape;
    },
  );
}

function quotedEnd(sql: string, start: number, escaped: boolean): number | undefined {
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
  return undefined;
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
  return depth === 0 ? at : sql.length + 1;
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
