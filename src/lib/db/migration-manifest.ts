/**
 * The migrations THIS BUILD was shipped with, and the one-sided schema check
 * the readiness probe runs against them.
 *
 * `bundledMigrationNames` is a build-time snapshot of `db/migrations/*.sql`,
 * committed as source and compiled into the server bundle. The probe must not
 * read the working directory at runtime — a deployed bundle has no checkout
 * beside it — so this list is the build's own record of the migrations it
 * carries. The pin test (`tests/db/migration-manifest.test.ts`) asserts the
 * snapshot equals `listMigrationNames(readdir(db/migrations))`, so adding a
 * migration without regenerating the snapshot fails that test: regeneration
 * is forced, not remembered.
 *
 * `isSchemaUpToDate` is deliberately ONE-SIDED. The readiness probe refuses a
 * schema BEHIND the build — a bundled migration missing from
 * `schema_migrations` means the running code may meet tables and columns that
 * do not exist yet. A schema EQUAL to the build passes this names-only check;
 * extra rows also pass it. Readiness separately refuses an ahead schema when
 * an extra migration carries a recorded mixed-version review flag, because it
 * may break an older release's reads or writes during rollback.
 */

/**
 * What a migration file is, for the runner and for the numbering guards alike.
 *
 * One expression rather than one per caller, because a runner and a guard that disagree about
 * this is the failure they exist to prevent: a `013_reconciliation_cooldown.sql.orig` left behind
 * by a conflicted merge would otherwise be a second migration numbered 013 to the guard and no
 * migration at all to the runner.
 */
export const migrationFilename = /^(\d+)_.+\.sql$/;

export const bundledMigrationNames: readonly string[] = [
  "001_initial.sql",
  "002_repository_difficulty_scheme.sql",
  "003_multi_issue_settlements_and_claims.sql",
  "004_preserve_reconciliation_provenance.sql",
  "005_harden_materialization_invariants.sql",
  "006_account_moderation_snapshots.sql",
  "007_authoritative_history_and_merge_proof.sql",
  "008_moderator_role_changes.sql",
  "009_settlement_override_requests.sql",
  "010_settled_evidence_ordering_grace.sql",
  "011_api_tokens.sql",
  "012_unwritable_closure_kinds.sql",
  "013_immutable_github_identity.sql",
  "013_reconciliation_cooldown.sql",
  "014_opening_authority_precondition.sql",
  "015_normalize_settlement_status_check.sql",
  "016_repository_identity_verification.sql",
  "017_cross_repository_closures.sql",
  "018_refreshable_display_logins.sql",
  "019_recorded_materialization_removals.sql",
  "020_repository_reconciliation_jobs.sql",
  "021_reconciliation_lease_duration.sql",
  "022_fold_revision_stamps.sql",
  "023_rederivation_requests.sql",
  "024_reconciliation_run_rederivation.sql",
  "025_rederivation_generation.sql",
  "026_incremental_reconciliation.sql",
  "027_issue_github_updated_at.sql",
  "028_repository_reconciliation_cost.sql",
  "029_reconciliation_changes_recorded_seq.sql",
  "030_repository_difficulty_scheme_versions.sql",
  "031_tighten_issue_evidence_completeness.sql",
  "032_immutable_claim_assignee_identity.sql",
  "033_self_work_calibrations_issue_unique.sql",
  "034_repository_unregistration.sql",
  "035_moderation_credit_adjustments.sql",
  "036_override_reconciliation_reason.sql",
  "037_abandoned_webhook_cleanups.sql",
  "038_forge_identities_and_provider_columns.sql",
  "039_forge_identity_user_fk.sql",
  "040_forge_repository_columns.sql",
  "041_forge_identity_token_failed_at.sql",
  "042_gitlab_webhook_orphan_cleanup.sql",
  "043_repository_webhook_credentials.sql",
  "044_completed_work_credit_limits.sql",
  "045_account_pseudonymisation.sql",
  "046_api_token_expiry.sql",
  "048_unregistered_webhook_credentials.sql",
  "049_reason_length_limits.sql",
  "051_forge_identity_https_instance.sql",
  "052_repository_policy_violations.sql",
  "053_webhook_delivery_receipt_scope.sql",
  "054_privileged_action_credentials.sql",
  "055_allow_nullable_issue_and_pr_bodies.sql",
  "056_board_read_indexes.sql",
  "057_fold_evidence_facts.sql",
  "058_api_token_delivery_window.sql",
  "059_session_epoch.sql",
  "060_sanction_deactivation_flag.sql",
  "061_sanction_contest_requests.sql",
  "062_webhook_delivery_body_digest.sql",
  "063_null_avatar_urls.sql",
  "064_data_subject_suppressions.sql",
  "065_retention_foreign_key_indexes.sql",
  "066_repository_registration_method.sql",
  "067_reconciliation_sweep_round.sql",
  "068_reconciliation_sweep_authority.sql",
  "069_repository_reconciliation_auth_path.sql",
  "070_reconciliation_held_status.sql",
  "071_closed_pr_disputes.sql",
  "072_closed_pr_dispute_grant_uniqueness.sql",
  "073_dispute_credit_limit_replay.sql",
  "074_closed_pr_dispute_grant_issue_uniqueness.sql",
  "075_closed_pr_dispute_commit_author.sql",
  "076_repository_reconciliation_sizes.sql",
  "077_reconciliation_sweep_rounds.sql",
  "078_reconciliation_sweep_catchups.sql",
];

/**
 * True iff every migration this build bundles is recorded applied. Extra
 * applied names are ignored here; readiness also checks their compatibility
 * flags before accepting an ahead schema.
 */
export function isSchemaUpToDate(applied: readonly string[]): boolean {
  const appliedNames = new Set(applied);
  return bundledMigrationNames.every((name) => appliedNames.has(name));
}
