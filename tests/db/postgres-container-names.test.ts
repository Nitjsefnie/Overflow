import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface Source {
  path: string;
  stripped: string;
}

/**
 * One Docker daemon serves every suite on this box, so a container started
 * under a fixed name collides with any concurrent run of its own suite — the
 * loser dies in `beforeAll` with HTTP 409 "container name already in use"
 * before a single case executes (issue 372). Containers must keep
 * testcontainers' random names, and this guard reads the test sources and
 * refuses both halves of the footgun rather than racing two real containers to
 * prove the defect: the second fixed-name container is exactly the collision
 * it exists to prevent.
 */
describe("no suite pins a fixed testcontainer name", () => {
  let sources: Source[] = [];

  beforeAll(async () => {
    sources = await strippedTestSources(resolve("tests"));
  });

  it("chains withName nowhere under tests/", () => {
    const offenders = sources
      .filter(({ stripped }) => /\bwithName\s*\(/.test(stripped))
      .map(({ path }) => path);

    expect(
      offenders,
      "withName fixes the container's name, and a fixed name collides with any concurrent run of the same suite on the shared Docker daemon; keep testcontainers' random name",
    ).toEqual([]);
  });

  it("passes no name option to startPostgresContainer at any call site", () => {
    const offenders = sources.flatMap(({ path, stripped }) =>
      optionObjectKeys(stripped, "startPostgresContainer").some((keys) => keys.has("name")) ? [path] : [],
    );

    expect(
      offenders,
      "startPostgresContainer takes no name: the option was removed for issue 372, and a fixed name collides with any concurrent run of the same suite on the shared Docker daemon",
    ).toEqual([]);
  });
});

/** Every .ts and .tsx file under root, recursively, with strings and comments stripped. */
async function strippedTestSources(root: string): Promise<Source[]> {
  const sources: Source[] = [];

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);

    if (entry.isDirectory()) {
      sources.push(...(await strippedTestSources(full)));
    } else if (/\.[jt]sx?$/.test(entry.name)) {
      sources.push({
        path: relative(root, full),
        stripped: stripStringsAndComments(await readFile(full, "utf8")),
      });
    }
  }

  return sources;
}

/**
 * The source with every string literal, template literal and comment replaced
 * by a single space, so key and identifier scans see code structure only. Not
 * a parser: regex literals stay in place, and a literal holding a quote or a
 * comment opener desyncs the strip the way any source-shape guard can be
 * desynced — visibly, in a failure naming the file.
 */
function stripStringsAndComments(source: string): string {
  let stripped = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;

    if (char === "'" || char === '"' || char === "`") {
      index = pastStringLiteral(source, index, char);
      stripped += " ";
    } else if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = source[index + 1] === "/" ? pastLineComment(source, index) : pastBlockComment(source, index);
      stripped += " ";
    } else {
      stripped += char;
      index += 1;
    }
  }

  return stripped;
}

/** The index just past the '...', "..." or `...` literal opening at start. */
function pastStringLiteral(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }

    if (source[index] === quote) {
      return index + 1;
    }
  }

  return source.length;
}

/** The index just past the // comment opening at start. */
function pastLineComment(source: string, start: number): number {
  const end = source.indexOf("\n", start);

  return end === -1 ? source.length : end + 1;
}

/** The index just past the block comment opening at start. */
function pastBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);

  return end === -1 ? source.length : end + 2;
}

/**
 * The top-level property keys of every object literal handed to `callee(` in
 * already-stripped source — a call whose argument is not an object literal has
 * no keys to scan. Nested objects (the helper's initScripts entries, each
 * legitimately carrying a script name) stay invisible: only keys at the
 * argument's own level are read.
 */
function optionObjectKeys(stripped: string, callee: string): ReadonlySet<string>[] {
  const keysPerCall: Array<Set<string>> = [];
  const callPattern = new RegExp(`\\b${callee}\\s*\\(`, "g");
  let call: RegExpExecArray | null;

  while ((call = callPattern.exec(stripped)) !== null) {
    let cursor = call.index + call[0].length;

    while (/\s/.test(stripped[cursor] ?? "")) {
      cursor += 1;
    }

    if (stripped[cursor] !== "{") {
      continue;
    }

    const keys = new Set<string>();
    let depth = 0;
    let previous = "";

    for (let index = cursor; index < stripped.length; index += 1) {
      const char = stripped[index]!;

      if (depth === 1 && (previous === "{" || previous === ",") && /[A-Za-z_$]/.test(char)) {
        const word = /^[A-Za-z_$][\w$]*/.exec(stripped.slice(index))![0]!;
        let lookahead = index + word.length;

        while (/\s/.test(stripped[lookahead] ?? "")) {
          lookahead += 1;
        }

        if (stripped[lookahead] === ":") {
          keys.add(word);
        }

        index += word.length - 1;
        previous = word[word.length - 1]!;
        continue;
      }

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;

        if (depth === 0) {
          break;
        }
      }

      if (!/\s/.test(char)) {
        previous = char;
      }
    }

    keysPerCall.push(keys);
  }

  return keysPerCall;
}
