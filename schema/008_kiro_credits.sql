-- Unknown usage is NULL, including native Kiro records without a usage_summary.
ALTER TABLE tokenlayer.session_events ADD COLUMN IF NOT EXISTS credits Nullable(Float64) DEFAULT NULL;
