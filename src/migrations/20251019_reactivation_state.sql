-- Reactivation state on window_pattern_state (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='window_pattern_state' AND column_name='react_active'
  ) THEN
    ALTER TABLE window_pattern_state
      ADD COLUMN react_active BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN react_snapshot_id BIGINT,
      ADD COLUMN react_similarity NUMERIC(6,4),
      ADD COLUMN react_started_at TIMESTAMPTZ;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_wps_react_active ON window_pattern_state(react_active);
