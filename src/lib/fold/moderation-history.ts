import { isParticipationEligible, type EnforcementState } from "@/lib/db/types";
import type { FoldModerationEvent, FoldUser } from "@/lib/fold/repository-fold";

export function moderationInstantToIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Timestamp was invalid.");
  }
  // Date normalizes the offset and retains the first three fractional digits.
  // Keep the remaining PostgreSQL microseconds outside Date's millisecond clock.
  const fraction = typeof value === "string"
    ? /\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i.exec(value)?.[1]
    : undefined;
  const remainder = fraction?.padEnd(6, "0").slice(3, 6) ?? "000";
  return date.toISOString().replace(/Z$/, `${remainder}Z`);
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
    const instant = moderationInstantToIso(value);
    return BigInt(Date.parse(instant)) * 1000n + BigInt(instant.slice(-4, -1));
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
