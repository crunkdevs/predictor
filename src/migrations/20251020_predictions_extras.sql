-- predictions: add columns used by V2 services
ALTER TABLE predictions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS window_id BIGINT;

-- (optional) backfill updated_at to created_at for old rows
UPDATE predictions SET updated_at = created_at WHERE updated_at IS NULL;

-- (optional) add FK if `windows` exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='windows') THEN
    ALTER TABLE predictions
      ADD CONSTRAINT IF NOT EXISTS predictions_window_fk
      FOREIGN KEY (window_id) REFERENCES windows(id) ON DELETE SET NULL;
  END IF;
END$$;

-- helpful indexes
CREATE INDEX IF NOT EXISTS idx_predictions_source_created ON predictions(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_window_created ON predictions(window_id, created_at DESC);
