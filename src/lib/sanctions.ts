/**
 * What a sanction does, in one place.
 *
 * Three legal pages state the sanction effects — the terms page's "How
 * sanctions work" section, the rules page's "Moderation" section and the
 * /account-data notice's "Scoring and sanctions" section — and stating them
 * three times by hand is the drift this repository has already been through
 * once: the terms page promised a sanction could be contested while the rules
 * it pointed at carried no such case (see src/lib/disputes.ts for that
 * history). One exported source removes the same gap here. Each page renders
 * this list, and no page can state a sanction effect the others do not: an
 * edit to a fact is one edit, and a fact that stops being true stops being
 * claimed on all three pages at once.
 *
 * The wording is the text a reader is held to, so it moves the way a legal
 * document moves: through src/lib/legal-revisions.ts, never as a quiet copy
 * edit. The three pages are three views of one disclosure, not three
 * disclosures, so none carries its own stamp for this list. The module is
 * listed in SHARED_TEXT_MODULES in scripts/check-legal-revisions.ts, so a
 * commit that edits it must bump the revision records in the same commit.
 *
 * The facts are behavioural only, as the pages state current behaviour:
 * neither a promise nor a denial of a contest route belongs here. Each line
 * carries its basis in the code:
 *
 *   - deactivation on RECALIBRATING or BANNED only — WARNED never deactivates:
 *     the substantiate path in src/lib/moderation/postgres-store.ts stamps
 *     `sanction_deactivated_at` on the sponsor's active repositories exactly
 *     when the new state is RECALIBRATING or BANNED (migration 060).
 *   - folds as no-ops and webhooks without effect while a repository is
 *     inactive: the reconciliation short-circuit in src/lib/fold/reconcile.ts
 *     completes an inactive repository with no reads, and the webhook
 *     processor in src/lib/webhooks/processor.ts marks a delivery for an
 *     inactive repository PROCESSED while applying and enqueueing nothing.
 *   - no settlement for work merged under the sanction, and no retroactive
 *     settlement after a reversal: a settlement requires participation
 *     eligibility at the merge time (isParticipationEligibleAt in
 *     src/lib/fold/repository-fold.ts reads the moderation event history at
 *     the pull request's merged time), and a reversal does not re-run the
 *     merges that fell inside the sanction.
 *   - reversal by a moderator inside the product, recorded as a moderation
 *     event: closeRecalibration and reverseBan in
 *     src/lib/moderation/postgres-store.ts return the account to ACTIVE and
 *     write the moderation event, behind moderator routes
 *     (src/app/api/moderation/reversal/route.ts for the ban).
 */
export const SANCTION_EFFECT_RULES = [
  "A recalibrating or banned sanction deactivates the repositories the account sponsors.",
  "While a repository is inactive, its folds become no-ops and its webhooks are received and processed without effect.",
  "Work merged while a repository is inactive is not settled, and no retroactive settlement follows a reversal.",
  "A recalibration or a ban can be reversed by a moderator inside the product; the reversal is recorded as a moderation event.",
] as const;
