-- 20251019_add_updated_at_to_pattern_snapshots.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pattern_snapshots' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE pattern_snapshots
      ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END$$;

-- (Optional) tiny trigger to auto-bump updated_at on row updates
CREATE OR REPLACE FUNCTION trg_ps_set_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_ps_set_updated ON pattern_snapshots;
CREATE TRIGGER trg_ps_set_updated
BEFORE UPDATE ON pattern_snapshots
FOR EACH ROW EXECUTE FUNCTION trg_ps_set_updated();
