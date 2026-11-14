-- Contract step for 077: the per-sponsor table replaced this singleton, and
-- no release still serving reads or writes it.
drop table if exists reconciliation_sweep_round;
