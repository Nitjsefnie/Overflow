import type { JSONValue } from "postgres";
import type { TransactionClient } from "@/lib/db/types";
import type { CalibrationCohortSnapshot } from "@/lib/moderation/service";
import { credentialKind, credentialTokenId } from "@/lib/moderation/writer-credential";
import type { RouteCredentialReference } from "@/lib/security/route-credential";

/**
 * The reversal core behind every sanctioned-to-active lift: the account state
 * flips to ACTIVE, the repositories the sanction took down come back within
 * the scope the prior state owns, and one moderation event records the lift.
 *
 * Extracted from reverseBan (the 1072 ban reversal) so the grant path of a
 * sanction contest (issue 1134) can run the same three writes inside its own
 * decision transaction instead of duplicating the SQL — a second copy of the
 * reactivation scope would drift from this one the way a second copy of any
 * invariant does. The caller owns the preconditions: the account row is
 * already locked FOR UPDATE in the caller's transaction, and the caller has
 * checked that the account's enforcement state is the sanction being lifted.
 * What this function adds is the transaction, so both paths compose it into
 * larger transactions — the reversal into its own, the grant into the
 * decision's.
 *
 * The reactivation scope is the prior state's, not one shared scope:
 *
 *   - BANNED reactivates exactly the rows the sanction flagged
 *     (sanction_deactivated_at is not null) — a row inactive for any other
 *     reason, and a row the sponsor left after the sanction, stay as they
 *     were.
 *   - RECALIBRATING reactivates every inactive row the sponsor has not
 *     unregistered — closeRecalibration's scope, which the recalibration
 *     closure always applied and a granted contest over a live recalibration
 *     now applies identically.
 *
 * Both scopes clear the flag on what they reactivate, keeping the migration
 * 060 invariant — the flag is non-null exactly while the row is
 * sanction-deactivated — true in every committed state.
 *
 * The event is stamped with clock_timestamp(), not the transaction's now():
 * the grant path writes TWO events in one transaction (the decision's
 * same-state record, then this lift), and the fold's timeline orders
 * same-instant events by id — random uuids — so a now() stamp would make the
 * read of the account's enforcement state depend on uuid order. The lift is
 * the later write, and clock_timestamp() is the later instant, so eligibility
 * resumes at the lift deterministically. reverseBan's single-event
 * transaction gets the same stamp for free, a few microseconds into its own
 * transaction, where nothing reads the difference.
 */
export type SanctionLiftInput = {
  /** The account whose sanction lifts; locked FOR UPDATE by the caller. */
  targetAccountId: string;
  /** The sanction being lifted; selects the reactivation scope. */
  priorState: "BANNED" | "RECALIBRATING";
  /** The reversal event's stated reason. */
  reason: string;
  /** The actor the reversal event names. */
  actorId: string;
  /** The audit the event anchors on, where the caller has one to give. */
  auditId: string | null;
  /** The cohort snapshot the event carries, where the caller has one. */
  cohort: CalibrationCohortSnapshot | null;
  credential: RouteCredentialReference | null;
  /**
   * The contest request the lift answers, cited on the event's
   * contest_request_id column; null for a plain reversal.
   */
  contestRequestId: string | null;
};

/**
 * Runs the three lift writes on the caller's transaction and returns the ids
 * of the repositories the lift reactivated.
 */
export async function liftSanctionInTransaction(
  transaction: TransactionClient,
  input: SanctionLiftInput,
): Promise<string[]> {
  await transaction`
    update users
    set enforcement_state = ${"ACTIVE"}, updated_at = now()
    where id = ${input.targetAccountId}
  `;

  // The scope is the prior state's own. BANNED takes only the rows the
  // sanction flagged and flipped; RECALIBRATING takes every inactive row the
  // sponsor has not unregistered. active = true is the flip guard on both:
  // only rows actually deactivated are stamped, and the flag clears on
  // exactly the rows that come back.
  const reactivatedRepositories =
    input.priorState === "BANNED"
      ? await transaction<{ id: string }[]>`
          update registered_repositories
          set active = true, sanction_deactivated_at = null, updated_at = now()
          where sponsor_id = ${input.targetAccountId}
            and sanction_deactivated_at is not null
            and active = false
            and unregistered_at is null
          returning id
        `
      : await transaction<{ id: string }[]>`
          update registered_repositories
          set active = true, sanction_deactivated_at = null, updated_at = now()
          where sponsor_id = ${input.targetAccountId}
            and active = false
            and unregistered_at is null
          returning id
        `;

  await transaction`
    insert into moderation_events (
      target_user_id,
      actor_id,
      audit_id,
      prior_state,
      new_state,
      reason,
      created_at,
      cohort_definition,
      cohort_statistics,
      recalibration_plan,
      credential_kind,
      credential_token_id,
      contest_request_id
    )
    values (
      ${input.targetAccountId},
      ${input.actorId},
      ${input.auditId},
      ${input.priorState},
      ${"ACTIVE"},
      ${input.reason},
      ${transaction`clock_timestamp()`},
      ${input.cohort === null ? transaction`default` : transaction.json(input.cohort as unknown as JSONValue)},
      ${input.cohort === null ? transaction`default` : transaction.json(input.cohort.comparison as unknown as JSONValue)},
      ${null},
      ${credentialKind(input.credential)},
      ${credentialTokenId(input.credential)},
      ${input.contestRequestId}
    )
  `;

  return reactivatedRepositories.map((row) => row.id);
}
