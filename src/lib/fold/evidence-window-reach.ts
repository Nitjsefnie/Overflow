/**
 * The evidence-window reachability rules the fold records with: whether a
 * refused settlement or an unwritable closure is still actionable, or whether
 * its window shut before Overflow could have been asked to produce anything.
 */

export type RejectionReach =
  | { kind: "UNBOUNDED" }
  | { kind: "WINDOW"; refusedEvidenceAt: string | null };

/** The instant as a moment, or null when GitHub reported none we can read. */
export function parsedInstant(value: string | null): number | null {
  return validTimestamp(value) ? Date.parse(value) : null;
}

export function validTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

/**
 * An unwritable closure is a work item for a moderator, so it is worth
 * recording only while the evidence it asks for could still be produced. A
 * settlement evidence window shuts fifteen minutes after the merge, and an
 * issue no pull request closed has only its own close; a window that shut
 * before Overflow was registered on the repository shut before anyone here
 * could have been asked to fill it, and no label applied today reopens it.
 *
 * Reachability is decided against the registration instant only. When that
 * instant is unreadable, or the closing instant is absent or unreadable,
 * nothing has been shown about the window, so the closure is recorded: leaving
 * a real work item visible is the recoverable mistake, and silently dropping
 * one is not.
 */
export function evidenceWindowReachable(windowClosedAt: number | null, registeredAtTime: number): boolean {
  if (windowClosedAt === null || !Number.isFinite(registeredAtTime)) {
    return true;
  }
  return windowClosedAt >= registeredAtTime;
}

/**
 * A refused settlement outlives its own window when the evidence it refused
 * arrived after the repository was registered: the settled label is there, it
 * merely landed late, and pricing it is exactly what the settlement-override
 * path does. Recording it is the only way a moderator ever sees it, so the
 * late evidence is checked even once the window itself is out of reach.
 */
export function rejectionReachable(
  reach: RejectionReach,
  windowClosedAt: number | null,
  registeredAtTime: number,
): boolean {
  if (reach.kind === "UNBOUNDED") {
    return true;
  }
  if (evidenceWindowReachable(windowClosedAt, registeredAtTime)) {
    return true;
  }
  const refusedEvidenceAt = parsedInstant(reach.refusedEvidenceAt);
  return refusedEvidenceAt !== null && refusedEvidenceAt >= registeredAtTime;
}
