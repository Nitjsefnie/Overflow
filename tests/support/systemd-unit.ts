import { posix } from "node:path";

export type UnitEntry = {
  section: string;
  key: string;
  /** The assignment as written, after continuation joining and trimming. */
  value: string;
  /** The value split into words, with quotes removed where systemd removes them. */
  words: string[];
};

/**
 * A shape of systemd's configuration grammar this parser does not model.
 *
 * The parser reads a unit without systemd, so it can only defend the shapes it
 * models. Guessing at the rest is how a directive hides: a backslash-terminated
 * comment reads as "commented out" to a naive parser while systemd applies the
 * line beneath it. Anything unmodelled is refused instead, so an unrecognised
 * shape fails the suite rather than passing it silently.
 */
export class UnmodelledUnitShape extends Error {
  constructor(description: string) {
    super(`the guard does not model ${description}; systemd may read it differently`);
    this.name = "UnmodelledUnitShape";
  }
}

/**
 * Drops comments and joins backslash continuations, in that order.
 *
 * systemd.syntax(7): comment lines are ignored, and "lines ending in a
 * backslash are concatenated with the following line while reading and the
 * backslash is replaced by a space character". systemd reads that "ending in a
 * backslash" off the raw physical line, and it reads it the same way for the
 * first line of a continuation and for every line after it, so the decision
 * here is taken from `physicalLine` and never from a trimmed copy of it.
 *
 * A backslash followed by trailing whitespace therefore does *not* continue the
 * line, which cuts both ways and is refused rather than modelled: joining one
 * line too many hides the directive underneath from the guard while systemd
 * applies it, and joining one too few reports a restriction as pinned that
 * systemd discarded. Both are an ordinary editing accident away.
 *
 * Comment lines are dropped here as well, and both of their interactions with a
 * continuation are refused: a comment that ends in a backslash (systemd joins
 * the directive under it into the comment), and a comment inside a continuation
 * (systemd ignores it and carries the join on past it).
 */
function toLogicalLines(source: string): string[] {
  const logicalLines: string[] = [];
  let carried: string | null = null;

  for (const physicalLine of source.split(/\r?\n/)) {
    const trimmed = physicalLine.trim();
    const isComment = trimmed.startsWith("#") || trimmed.startsWith(";");

    if (isComment) {
      if (trimmed.endsWith("\\")) {
        throw new UnmodelledUnitShape("a comment line that ends in a backslash");
      }
      if (carried !== null) {
        throw new UnmodelledUnitShape("a comment line inside a continuation");
      }
      continue;
    }

    if (carried !== null) {
      if (/^\[.*\]$/.test(trimmed)) {
        throw new UnmodelledUnitShape("a continuation that runs into a section header");
      }
      if (trimmed === "") {
        throw new UnmodelledUnitShape("a continuation broken by a blank line");
      }
    }

    if (/\\[^\S\n]+$/.test(physicalLine)) {
      throw new UnmodelledUnitShape(
        "a line continuation with trailing whitespace after the backslash",
      );
    }

    const continued = physicalLine.endsWith("\\");
    const body = continued ? physicalLine.slice(0, -1) : physicalLine;
    const line: string = carried === null ? body : `${carried} ${body.trim()}`;

    if (continued) {
      carried = line.trimEnd();
      continue;
    }

    carried = null;
    logicalLines.push(line);
  }

  if (carried !== null) {
    throw new UnmodelledUnitShape("a continuation that runs off the end of the file");
  }

  return logicalLines;
}

/**
 * The `[Service]` directives whose values systemd unquotes, verified against
 * systemd 257.13 with `systemd-analyze verify`: quoting is per-directive, not
 * global. `ExecStart=`, `Environment=`, `ReadWritePaths=`,
 * `RestrictAddressFamilies=`, `CapabilityBoundingSet=` and
 * `AmbientCapabilities=` all accept a quoted value and strip the quotes, while
 * `ProtectSystem="strict"`, `NoNewPrivileges="yes"`, `ProcSubset="pid"`,
 * `UMask="0077"`, `SystemCallFilter="@system-service"`, `WorkingDirectory=` and
 * `EnvironmentFile=` all fail to parse and are *ignored* — leaving the property
 * unset. A quote anywhere else is therefore refused rather than stripped.
 */
const UNQUOTING_KEYS: ReadonlySet<string> = new Set([
  "Environment",
  "ReadWritePaths",
  "RestrictAddressFamilies",
  "CapabilityBoundingSet",
  "AmbientCapabilities",
]);

function unquotesItsValue(key: string): boolean {
  return key.startsWith("Exec") || UNQUOTING_KEYS.has(key);
}

/** Splits a value into words the way the directive's own parser would. */
export function toWords(key: string, value: string): string[] {
  if (value.includes("\\")) {
    throw new UnmodelledUnitShape(`a backslash inside the value of ${key}=`);
  }

  if (!unquotesItsValue(key)) {
    if (/["']/.test(value)) {
      throw new UnmodelledUnitShape(`a quote in ${key}=, which systemd does not unquote`);
    }
    return value.split(/\s+/).filter((word) => word !== "");
  }

  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;

  for (const character of value) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += character;
    started = true;
  }

  if (quote !== null) {
    throw new UnmodelledUnitShape(`an unterminated ${quote} quote in ${key}=`);
  }
  if (started) {
    words.push(current);
  }

  return words;
}

/**
 * Parses a systemd unit into its assignments. Comments are dropped, keys are
 * scoped to their section, and every assignment of a repeated key is kept in
 * file order, so a directive reset and then widened further down does not read
 * as the hardened one. Every value is split at parse time, so a shape the parser
 * cannot classify fails the whole file rather than one assertion.
 */
export function parseUnitFile(source: string): UnitEntry[] {
  const entries: UnitEntry[] = [];
  let section = "";

  for (const logicalLine of toLogicalLines(source)) {
    const line = logicalLine.trim();

    if (line === "") {
      continue;
    }

    const sectionHeader = /^\[(.+)\]$/.exec(line);
    if (sectionHeader) {
      section = sectionHeader[1]!.trim();
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      throw new UnmodelledUnitShape(`a line that is neither a section header nor an assignment: ${line}`);
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    entries.push({ section, key, value, words: toWords(key, value) });
  }

  return entries;
}

/**
 * Whether a path names `/root` or something inside it, once the path is
 * resolved the way the kernel resolves it: repeated separators collapse and
 * `..` segments are removed, and the comparison lands on a segment boundary so
 * `/rootless` is not a match.
 *
 * systemd's own prefixes come off first. A `-` in front of a path makes it
 * optional (`EnvironmentFile=-/root/overflow.env` is a live reference to
 * `/root`, accepted by `systemd-analyze verify`), and a command line may carry
 * `-@+!:`. A raw prefix test reads all of those as "not a path at all".
 */
export function isUnderRoot(candidate: string): boolean {
  const unprefixed = candidate.replace(/^[-@+!:]+/, "");

  if (!unprefixed.startsWith("/")) {
    return false;
  }

  const normalized = posix.normalize(unprefixed.replace(/^\/+/, "/"));
  const path = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;

  return path === "/root" || path.startsWith("/root/");
}

/** The path-shaped pieces of a value: words, split again on PATH colons and `NAME=value`. */
export function pathCandidates(entry: UnitEntry): string[] {
  return entry.words
    .flatMap((word) => word.split(/[:=]+/))
    .filter((candidate) => candidate !== "");
}

/**
 * systemd's boolean spellings, verified against systemd 257.13: `PrivateTmp=YES`,
 * `RestrictSUIDSGID=t` and `ProtectHome=y` all parse, so the match is
 * case-insensitive and covers the short forms too.
 */
export const TRUE_SPELLINGS: ReadonlySet<string> = new Set(["1", "y", "yes", "t", "true", "on"]);
export const FALSE_SPELLINGS: ReadonlySet<string> = new Set(["0", "n", "no", "f", "false", "off"]);
