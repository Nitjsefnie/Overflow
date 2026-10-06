// Issue 1069. Every instant the product displays renders through the shared
// UTC formatter (`formatInstant`), so no component may format a display
// instant itself — the ad-hoc forms this test bans are exactly the shapes the
// conversion removed: a UTC date cut off a timestamp by `.slice(0, 10)`, a raw
// `toISOString()` string, a locale-shaped `toLocale*String()`,
// `Intl.DateTimeFormat` (whose output follows the viewer's zone), a local
// `formatUtc()` helper, and a bare `{x.createdAt}`-style interpolation of an
// instant-suffixed member, which puts the raw ISO string on screen.
//
// `dateTime={...}` attributes are stripped before the scan: their values are
// machine-readable (a `<time>` element's machine form, a form input's value),
// not display text, and the product rule deliberately keeps them ISO.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatInstant } from "@/lib/format-instant";

const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));

/** Machine-readable attribute expressions are exempt; only display text is scanned. */
const DATETIME_ATTRIBUTE = /dateTime=\{[^}]*\}/g;

const BANNED: Array<{ pattern: RegExp; name: string; mustMatch: string; mustNotMatch: string }> = [
  {
    pattern: /toISOString\s*\(/,
    name: "toISOString(",
    mustMatch: "createdAt.toISOString()",
    mustNotMatch: "new Date(value).getTime()",
  },
  {
    pattern: /\.slice\(0,\s*10\)/,
    name: ".slice(0, 10)",
    mustMatch: "settledAt.slice(0, 10)",
    mustNotMatch: "labels.slice(0, 2)",
  },
  {
    pattern: /\btoLocale(Date|Time)?String\s*\(/,
    name: "toLocale*String(",
    mustMatch: "occurredAt.toLocaleTimeString()",
    mustNotMatch: "issue.toString()",
  },
  {
    pattern: /Intl\.DateTimeFormat/,
    name: "Intl.DateTimeFormat",
    mustMatch: 'new Intl.DateTimeFormat("en-GB")',
    mustNotMatch: "new Intl.NumberFormat()",
  },
  {
    pattern: /\bformatUtc\s*\(/,
    name: "formatUtc(",
    mustMatch: "formatUtc(createdAt)",
    mustNotMatch: "formatInstant(createdAt)",
  },
];

/**
 * The instant-suffixed member names the product renders. The first group is
 * rendered as display text somewhere in src today; the second is the rest of
 * the instant-suffixed set this codebase uses, so a future display site that
 * interpolates one of them bare fails the scan until it goes through
 * formatInstant. A name belongs here only when it names an instant: the
 * date-only revision strings (`effectiveDate`) and input echoes
 * (`sampleStartedAt`) are deliberately absent, and so is `tokenFailedAt`,
 * which is only ever tested against, never displayed.
 */
const INSTANT_FIELD_NAMES = [
  "createdAt", "recordedAt", "filedAt", "requestedAt", "decidedAt", "mergedAt",
  "updatedAt", "occurredAt", "resetAt", "observedAt", "openedAt", "settledAt",
  "verifiedAt", "expiresAt", "failedAt", "confirmedAt", "deletedAt",
  "resolvedAt", "appliedAt", "lastUsedAt",
];

/**
 * Bare JSX-text interpolation of an instant-suffixed member: `{x.createdAt}`
 * with no formatInstant inside the braces is a raw ISO string on screen. The
 * name must be reached through a member dot, which is how every display site
 * reads it — requiring the dot keeps type-literal annotations
 * (`{ id: string; decidedAt: string | null }`) out of the scan. A match that
 * names formatInstant is the formatter being called and is fine.
 */
const BARE_INSTANT_INTERPOLATION =
  new RegExp(`\\{[^}]*\\w\\.(${INSTANT_FIELD_NAMES.join("|")})\\b[^}]*\\}`, "g");

/**
 * The one file allowed to call these: it builds the client-component props
 * payload, so its instants are data serialization, not display text — the
 * display rule is about what a member reads, and the payload stays ISO 8601.
 */
const ALLOWLIST = new Set(["app/repositories/new/page.tsx"]);

function walkTsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkTsxFiles(path));
    } else if (entry.name.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

describe("displayed instants render through formatInstant", () => {
  it("formats no component display text outside the shared UTC formatter", () => {
    const violations: string[] = [];
    for (const file of walkTsxFiles(srcRoot)) {
      const name = relative(srcRoot, file);
      if (ALLOWLIST.has(name)) {
        continue;
      }
      const source = readFileSync(file, "utf8").replace(DATETIME_ATTRIBUTE, "");
      for (const { pattern, name: patternName } of BANNED) {
        source.split("\n").forEach((line, index) => {
          if (pattern.test(line)) {
            violations.push(
              `${name}:${index + 1} formats a display instant with ${patternName}: ${line.trim()}`,
            );
          }
        });
      }
      source.split("\n").forEach((line, index) => {
        for (const match of line.match(BARE_INSTANT_INTERPOLATION) ?? []) {
          if (!match.includes("formatInstant")) {
            violations.push(
              `${name}:${index + 1} interpolates ${match} bare — wrap it in formatInstant`,
            );
          }
        }
      });
    }

    expect(
      violations,
      "every displayed instant must render via formatInstant (issue 1069); these component " +
        "files format display text themselves:\n" +
        violations.join("\n"),
    ).toEqual([]);
  });

  it("labels the formatter's output UTC", () => {
    expect(formatInstant("2026-09-07T15:00:00.000Z")).toContain("UTC");
  });

  // The scan above reads the real (clean) tree, so a weakened rule would go
  // green silently. Each rule is pinned against fixed literals here — one
  // string it must catch and one it must spare — so loosening a pattern,
  // the attribute strip, or the interpolation ban fails this file even while
  // the source tree stays clean.
  it("catches each banned shape and spares the near misses beside it", () => {
    for (const { pattern, name, mustMatch, mustNotMatch } of BANNED) {
      expect(pattern.test(mustMatch), `${name} must catch ${mustMatch}`).toBe(true);
      expect(pattern.test(mustNotMatch), `${name} must not catch ${mustNotMatch}`).toBe(false);
    }
  });

  it("strips dateTime attributes and leaves the display text for the scan to see", () => {
    const source =
      '<time dateTime={reading.resetAt.toISOString()}>{reading.resetAt.toISOString()}</time>';
    const stripped = source.replace(DATETIME_ATTRIBUTE, "");
    expect(stripped).not.toContain("dateTime=");
    expect(stripped).toContain("{reading.resetAt.toISOString()}");
  });

  it("flags a bare instant interpolation and spares the formatter call and non-display shapes", () => {
    // A bare {x.recordedAt} is the raw ISO string on screen, and so is a
    // fallback ternary around one; the formatter call is the rule being
    // obeyed; a type literal has no member dot; an input value attribute is
    // machine-readable, not display text.
    const mustFlag = [
      "recorded {closure.recordedAt}",
      '{calibration.mergedAt ?? "Unavailable"}',
    ];
    const mustSpare = [
      "reported {formatInstant(correction.requestedAt)}",
      "type Preview = { audit: { id: string; decidedAt: string | null } };",
      "<input value={sampleStartedAt} required />",
    ];
    const violationsOf = (line: string) =>
      [...line.matchAll(BARE_INSTANT_INTERPOLATION)].filter((match) =>
        !match[0].includes("formatInstant")
      );
    for (const line of mustFlag) {
      expect(violationsOf(line), `${line} must be flagged`).not.toEqual([]);
    }
    for (const line of mustSpare) {
      expect(violationsOf(line), `${line} must not be flagged`).toEqual([]);
    }
  });
});
