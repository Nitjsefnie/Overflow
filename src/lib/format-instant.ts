function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * An instant rendered as "YYYY-MM-DD HH:MM UTC" — the product's one display
 * convention for instants (issue 1069): always UTC, always named.
 *
 * Timezone-independent by construction: parsing goes through
 * `new Date(...)` and rendering through the UTC getters, so the output is
 * identical whatever the runtime zone is. An ISO string without a zone
 * designator parses as the runtime's local time per the ES spec, so it
 * yields that local reading rendered in UTC; callers pass zoned strings.
 *
 * Invalid input — anything `new Date(value)` cannot turn into an instant —
 * throws `TypeError`.
 */
export function formatInstant(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Not a valid instant: ${String(value)}`);
  }
  return (
    `${String(date.getUTCFullYear()).padStart(4, "0")}-` +
    `${padTwo(date.getUTCMonth() + 1)}-${padTwo(date.getUTCDate())} ` +
    `${padTwo(date.getUTCHours())}:${padTwo(date.getUTCMinutes())} UTC`
  );
}

// A datetime-local value per the HTML grammar: a date, "T", and a time whose
// seconds and fractional part are optional. No zone designator — one of those
// is a different format and is rejected below, never silently accepted.
const dateTimeLocalPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) {
    return 29;
  }
  return monthLengths[month - 1];
}

/**
 * A `datetime-local` input value interpreted as UTC, returned as the ISO 8601
 * instant string, or `null` when the value does not parse.
 *
 * Missing precision is appended: "2026-10-05T00:00" yields
 * "2026-10-05T00:00:00.000Z". A value already carrying "Z" or an offset is
 * rejected (a datetime-local value never carries one), as is any component
 * outside its range — no rollover from loose arithmetic.
 */
export function parseDateTimeLocalAsUtc(value: string): string | null {
  const match = dateTimeLocalPattern.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));

  if (month < 1 || month > 12 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  // Built field by field rather than through Date.UTC, whose two-digit-year
  // rule would map years 0-99 onto 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.toISOString();
}
