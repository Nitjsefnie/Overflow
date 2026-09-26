-- The bound on every free-text reason the settlement-override and moderation
-- APIs accept, enforced where the rows live rather than only at the routes.
--
-- The routes cap these fields at 2000 characters after trimming through the
-- shared reason schema (src/lib/validation/reason.ts), and every writer of
-- every column below takes its value from one of those routes: no fold,
-- rederivation or reconciliation path composes any of them. The CHECKs make
-- the same length bound a property of the stored row, so the database refuses
-- any reason longer than the API accepts, from a future writer or a manual
-- write alike. Only the length is enforced here: trimming and blank rejection
-- happen in the routes and services; these constraints accept blank or
-- untrimmed text.
--
-- Nullable columns keep their nullability: the guard is written so NULL
-- passes, and a missing reason stays exactly as representable as before.
-- Production data carries a longest value of 242 characters in these columns,
-- so validating the constraints at add time rewrites nothing.

alter table settlement_override_requests
add constraint settlement_override_requests_reason_length_check
check (char_length(reason) <= 2000),
add constraint settlement_override_requests_decision_reason_length_check
check (decision_reason is null or char_length(decision_reason) <= 2000);

alter table calibration_audits
add constraint calibration_audits_rationale_length_check
check (char_length(rationale) <= 2000),
add constraint calibration_audits_decision_length_check
check (decision is null or char_length(decision) <= 2000);

alter table moderation_events
add constraint moderation_events_reason_length_check
check (char_length(reason) <= 2000),
add constraint moderation_events_recalibration_plan_length_check
check (recalibration_plan is null or char_length(recalibration_plan) <= 2000);

alter table moderation_credit_adjustments
add constraint moderation_credit_adjustments_reason_length_check
check (char_length(reason) <= 2000);
