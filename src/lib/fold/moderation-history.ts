import { isParticipationEligible, type EnforcementState } from "@/lib/db/types";
import type { FoldModerationEvent, FoldUser } from "@/lib/fold/repository-fold";

export function moderationInstantToIso(value: string | Date): string {
  return formatInstant(parseInstant(value));
}

const SECOND_MICROSECONDS = 1_000_000n;
const DAY_MICROSECONDS = 86_400n * SECOND_MICROSECONDS;
const EPOCH_ORDINAL = daysBeforeYear(1970n);

// PostgreSQL JSON includes historical offset seconds, unsigned extended years,
// and an explicit BC suffix. Signed years are the canonical ISO representation.
function parseInstant(value: string | Date): bigint {
  let text: string;
  try {
    text = typeof value === "string" ? value : value.toISOString();
  } catch {
    throw new Error("Timestamp was invalid.");
  }
  const parts = /^([+-]?\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2}(?::\d{2})?)( BC)?$/i.exec(text);
  if (parts === null) throw new Error("Timestamp was invalid.");
  let year = BigInt(parts[1]!);
  if (parts[9]) {
    if (year < 1n || /^[+-]/.test(parts[1]!)) throw new Error("Timestamp was invalid.");
    year = 1n - year;
  }
  const month = BigInt(parts[2]!);
  const day = BigInt(parts[3]!);
  const hour = BigInt(parts[4]!);
  const minute = BigInt(parts[5]!);
  const second = BigInt(parts[6]!);
  const fraction = BigInt((parts[7] ?? "").padEnd(6, "0"));
  if (month < 1n || month > 12n || day < 1n || day > monthLength(year, month) ||
      hour > 24n || minute > 59n || second > 59n ||
      (hour === 24n && (minute !== 0n || second !== 0n || fraction !== 0n))) {
    throw new Error("Timestamp was invalid.");
  }
  let offset = 0n;
  if (parts[8]!.toUpperCase() !== "Z") {
    const [offsetHour, offsetMinute, offsetSecond] = parts[8]!.slice(1).split(":").map(BigInt);
    if (offsetHour! > 23n || offsetMinute! > 59n || (offsetSecond ?? 0n) > 59n) {
      throw new Error("Timestamp was invalid.");
    }
    offset = (offsetHour! * 3600n + offsetMinute! * 60n + (offsetSecond ?? 0n)) *
      (parts[8]![0] === "-" ? -1n : 1n);
  }
  let ordinal = daysBeforeYear(year) + day - 1n;
  for (let preceding = 1n; preceding < month; preceding += 1n) {
    ordinal += monthLength(year, preceding);
  }
  return ((ordinal - EPOCH_ORDINAL) * 86_400n + hour * 3600n + minute * 60n + second - offset) *
    SECOND_MICROSECONDS + fraction;
}

function formatInstant(instant: bigint): string {
  const days = floorDivide(instant, DAY_MICROSECONDS);
  const ordinal = days + EPOCH_ORDINAL;
  // A Gregorian 400-year cycle has exactly 146097 days, including before AD 1.
  const cycle = floorDivide(ordinal, 146_097n);
  let year = cycle * 400n + 1n;
  let nextCycle = year + 400n;
  while (year + 1n < nextCycle) {
    const middle = year + (nextCycle - year) / 2n;
    if (daysBeforeYear(middle) <= ordinal) year = middle;
    else nextCycle = middle;
  }
  let day = ordinal - daysBeforeYear(year);
  let month = 1n;
  while (day >= monthLength(year, month)) {
    day -= monthLength(year, month);
    month += 1n;
  }
  const remainder = instant - days * DAY_MICROSECONDS;
  const seconds = remainder / SECOND_MICROSECONDS;
  const yearText = year >= 0n && year <= 9999n ? year.toString().padStart(4, "0") :
    `${year < 0n ? "-" : "+"}${(year < 0n ? -year : year).toString().padStart(6, "0")}`;
  const two = (value: bigint) => value.toString().padStart(2, "0");
  return `${yearText}-${two(month)}-${two(day + 1n)}T${two(seconds / 3600n)}:` +
    `${two(seconds / 60n % 60n)}:${two(seconds % 60n)}.${(remainder % SECOND_MICROSECONDS).toString().padStart(6, "0")}Z`;
}

function floorDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

function daysBeforeYear(year: bigint): bigint {
  const previous = year - 1n;
  return 365n * previous + floorDivide(previous, 4n) - floorDivide(previous, 100n) + floorDivide(previous, 400n);
}

function monthLength(year: bigint, month: bigint): bigint {
  if (month === 2n) return year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n) ? 29n : 28n;
  return [4n, 6n, 9n, 11n].includes(month) ? 30n : 31n;
}

export function moderationEventsFromJson(value: unknown): FoldModerationEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("Moderation history was invalid.");
  }
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("Moderation history was invalid.");
    }
    const { id, priorState, newState, occurredAt } = candidate;
    if (
      typeof id !== "string" ||
      !isEnforcementState(priorState) ||
      !isEnforcementState(newState) ||
      (typeof occurredAt !== "string" && !(occurredAt instanceof Date))
    ) {
      throw new Error("Moderation history was invalid.");
    }
    return { id, priorState, newState, occurredAt: moderationInstantToIso(occurredAt) };
  });
}

export function isParticipationEligibleAt(user: FoldUser, timestamp: string): boolean {
  const targetTime = readInstant(timestamp);
  if (targetTime === null) {
    return false;
  }
  const events = (user.moderationEvents ?? []).flatMap((event) => {
    const time = readInstant(event.occurredAt);
    return typeof event.id === "string" && event.id.length > 0 && time !== null ? [{ event, time }] : [];
  }).sort((left, right) => left.time < right.time ? -1 : left.time > right.time ? 1 : left.event.id.localeCompare(right.event.id));
  const latestAtEvent = events.filter(({ time }) => time <= targetTime).at(-1);
  if (latestAtEvent !== undefined) {
    return isParticipationEligible(latestAtEvent.event.newState);
  }
  const firstLaterEvent = events.find(({ time }) => time > targetTime);
  return isParticipationEligible(firstLaterEvent?.event.priorState ?? user.enforcementState);
}

function readInstant(value: string): bigint | null {
  if (typeof value !== "string") return null;
  try {
    return parseInstant(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnforcementState(value: unknown): value is EnforcementState {
  return value === "ACTIVE" || value === "UNDER_AUDIT" || value === "WARNED" ||
    value === "RECALIBRATING" || value === "BANNED";
}
