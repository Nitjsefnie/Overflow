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
 * do not exist yet. A schema EQUAL to the build is ready, and a schema AHEAD
 * of it — extra rows from a newer migration set, the state a rollback to an
 * older release runs against — is ready too: an older build never needs a
 * migration it does not bundle, so refusing ahead schemas would fail every
 * rollback at its moment of use.
 */

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
];

/**
 * True iff every migration this build bundles is recorded applied. Extra
 * applied names are ignored: the probe refuses a schema behind the build and
 * accepts one equal to it or ahead of it.
 */
export function isSchemaUpToDate(applied: readonly string[]): boolean {
  const appliedNames = new Set(applied);
  return bundledMigrationNames.every((name) => appliedNames.has(name));
}
