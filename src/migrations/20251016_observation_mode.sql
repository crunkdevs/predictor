-- ================================================
-- Observation Mode support
-- Adds a lightweight mode flag to window_pattern_state
-- Modes:
--   - 'normal'  : regular prediction allowed
--   - 'paused'  : cooldown timer active (no predictions)
--   - 'observe' : post-pause observation (no predictions until stabilized)
-- ================================================

DO $$
BEGIN
  -- add column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='window_pattern_state' AND column_name='mode'
  ) THEN
    ALTER TABLE window_pattern_state
      ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal';
  END IF;

  -- add CHECK constraint if missing (idempotent)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'chk_wps_mode_valid'
  ) THEN
    ALTER TABLE window_pattern_state
      ADD CONSTRAINT chk_wps_mode_valid
      CHECK (mode IN ('normal','paused','observe'));
  END IF;
END$$;

-- helpful index for gating / scans
CREATE INDEX IF NOT EXISTS idx_wps_mode ON window_pattern_state(mode);
