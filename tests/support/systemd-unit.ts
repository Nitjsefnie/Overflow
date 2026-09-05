import { posix } from "node:path";

/** The only sections `deploy/overflow.service` is written to carry. */
export const CANONICAL_SECTIONS = ["Unit", "Service", "Install"] as const;

export type UnitSection = (typeof CANONICAL_SECTIONS)[number];

export type UnitEntry = {
  section: UnitSection;
  key: string;
  /** Everything after the `=`, verbatim, with `%%` resolved to a literal `%`. */
  value: string;
  /** The value split on runs of spaces. */
  words: string[];
};

/**
 * A unit written outside the canonical subset this guard enforces.
 *
 * The guard reads the unit without systemd, so every shape it accepts is a
 * claim about what systemd would do with that shape — and each such claim has
 * been wrong at least once. A space inside the brackets of `[Service ]` is an
 * unknown section systemd discards whole; a no-break space appended to `User`
 * is an unknown key systemd drops while JavaScript's `trim()` eats it; a
 * backslash before trailing whitespace continues the line for one parser and
 * not the other. Each of those made the suite report the hardening as pinned
 * while systemd ran the service as root.
 *
 * So the guard stops modelling systemd's grammar. `deploy/overflow.service` is
 * a file we control completely: it needs no continuations, no quoting, no
 * specifiers, no unusual whitespace and no sections beyond three, so the guard
 * requires exactly that and refuses everything else by name. A refusal is a
 * test failure naming the rule and the line, never a silent pass and never a
 * guess about which of two parsers is right.
 */
export class NonCanonicalUnit extends Error {
  constructor(description: string) {
    super(`the unit is outside the canonical subset the guard enforces: ${description}`);
    this.name = "NonCanonicalUnit";
  }
}

/** Rule 3: a section header, written byte for byte with nothing around the name. */
const SECTION_HEADER = new RegExp(`^\\[(${CANONICAL_SECTIONS.join("|")})\\]$`);

/** Rule 4: a key of letters and digits, then `=`, then the value verbatim. */
const ASSIGNMENT = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/;

/**
 * A line that was *trying* to be an assignment, so a refusal can say which rule
 * it broke rather than only that the line is unclassifiable.
 */
const ASSIGNMENT_SHAPED = /^[A-Za-z0-9].*=/;

/**
 * Rule 1: splits the file into lines, refusing any byte that is not printable
 * ASCII or a newline.
 *
 * This is the rule that needs no imagination. JavaScript's whitespace is not
 * systemd's: `String.prototype.trim()` and `\s` strip U+00A0, U+000B, U+000C,
 * U+2002 and a dozen more, while systemd strips only space, tab, CR and LF. One
 * such character appended to a key made systemd discard `User=` while the guard
 * read the directive as pinned. Enumerating those code points is how the next
 * one gets missed, so the file is required to carry none of them — nor a tab,
 * nor a CR, nor a BOM, nor an em dash in a comment.
 *
 * A `Uint8Array` is read byte by byte, so a multi-byte UTF-8 sequence is
 * refused at its first byte rather than after a decoder has turned it into
 * something else. A string is read by code point, which refuses the same
 * characters when a caller has already decoded the file.
 */
function toCanonicalLines(source: string | Uint8Array): string[] {
  const codes =
    typeof source === "string"
      ? Array.from(source, (character) => character.codePointAt(0)!)
      : Array.from(source);
  const text: string[] = [];
  let line = 1;

  for (const code of codes) {
    if (code === 0x0a) {
      line += 1;
      text.push("\n");
      continue;
    }
    if (code < 0x20 || code > 0x7e) {
      throw new NonCanonicalUnit(
        `line ${line} carries byte 0x${code.toString(16)}, ` +
          "and the canonical subset is printable ASCII and newline only",
      );
    }

    text.push(String.fromCodePoint(code));
  }

  return text.join("").split("\n");
}

/**
 * Rule 4: splits a value on spaces, refusing the two characters whose meaning
 * depends on which directive is reading them.
 *
 * systemd unquotes per-directive — `Environment="PATH=/x"` loses its quotes and
 * `ProtectSystem="strict"` fails to parse and leaves the property unset — and
 * it unescapes backslashes in some values and not others. Neither is a
 * distinction the unit needs, so neither character appears in it.
 */
export function toWords(key: string, value: string): string[] {
  if (value.includes("\\")) {
    throw new NonCanonicalUnit(`a backslash inside the value of ${key}=`);
  }
  if (/["']/.test(value)) {
    throw new NonCanonicalUnit(`a quote in ${key}=, which the canonical subset does not allow`);
  }

  return value.split(" ").filter((word) => word !== "");
}

/**
 * Rule 4: replaces systemd's `%%` escape with the literal percent it stands
 * for, and refuses every other specifier.
 *
 * systemd expands specifiers while it reads a unit file, and several of them
 * resolve to a filesystem path: verified against systemd 257.13, `%h` is `/root`
 * in a system unit *regardless of `User=`*, `%t` is `/run` and `%S` is
 * `/var/lib`. So `EnvironmentFile=%h/overflow.env` is a live reference to
 * `/root` that a scan of the written text cannot see, and it is as easily an
 * honest misreading of `%h` as "the service account's home" as it is an attack.
 *
 * Expansion is not modelled here — every value the parser hands back is scanned
 * for paths, so an unexpanded specifier anywhere means the guard is reading a
 * different string than systemd does. `%%` is the one case with no expansion
 * context at all, so it is resolved rather than refused.
 */
function withoutSpecifiers(key: string, value: string): string {
  let resolved = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;

    if (character !== "%") {
      resolved += character;
      continue;
    }
    if (value[index + 1] !== "%") {
      throw new NonCanonicalUnit(`the specifier %${value[index + 1] ?? ""} in ${key}=`);
    }

    resolved += "%";
    index += 1;
  }

  return resolved;
}

/**
 * Parses a unit written in the canonical subset into its assignments, refusing
 * anything outside it.
 *
 * Every assignment of a repeated key is kept in file order, so a directive
 * reset and then widened further down does not read as the hardened one, and
 * every value is split at parse time, so a value the subset forbids fails the
 * whole file rather than one assertion.
 */
export function parseUnitFile(source: string | Uint8Array): UnitEntry[] {
  const entries: UnitEntry[] = [];
  const opened = new Set<UnitSection>();
  let section: UnitSection | null = null;

  const lines = toCanonicalLines(source);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const number = index + 1;

    if (line.endsWith("\\")) {
      throw new NonCanonicalUnit(
        `line ${number} ends in a backslash, and the canonical subset has no line continuations`,
      );
    }
    if (line.startsWith(" ")) {
      throw new NonCanonicalUnit(
        `line ${number} begins with a space, and the canonical subset allows no leading whitespace`,
      );
    }
    if (line.endsWith(" ")) {
      throw new NonCanonicalUnit(
        `line ${number} ends in a space, and the canonical subset allows no trailing whitespace`,
      );
    }
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("[")) {
      const header = SECTION_HEADER.exec(line);

      if (!header) {
        throw new NonCanonicalUnit(
          `line ${number} is not [Unit], [Service] or [Install] written exactly: "${line}"`,
        );
      }

      const name = header[1] as UnitSection;

      if (opened.has(name)) {
        throw new NonCanonicalUnit(`line ${number} repeats the [${name}] section header`);
      }

      opened.add(name);
      section = name;
      continue;
    }

    const assignment = ASSIGNMENT.exec(line);

    if (!assignment) {
      throw new NonCanonicalUnit(
        ASSIGNMENT_SHAPED.test(line)
          ? `line ${number} is not an exact assignment; a canonical key is a letter followed by` +
            ` letters and digits, then "=" with no space before it: "${line}"`
          : `line ${number} is neither a section header, an assignment, a "#" comment nor` +
            ` empty: "${line}"`,
      );
    }

    const key = assignment[1]!;

    if (section === null) {
      throw new NonCanonicalUnit(`line ${number} assigns ${key}= before any section header`);
    }

    const value = withoutSpecifiers(key, assignment[2]!);

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
