-- predictions: add columns used by V2 services (idempotent, safe on all PG versions)
DO $$
BEGIN
  -- updated_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='predictions' AND column_name='updated_at'
  ) THEN
    ALTER TABLE predictions ADD COLUMN updated_at TIMESTAMPTZ;
    UPDATE predictions SET updated_at = created_at WHERE updated_at IS NULL;
    ALTER TABLE predictions ALTER COLUMN updated_at SET NOT NULL;
    ALTER TABLE predictions ALTER COLUMN updated_at SET DEFAULT now();
  END IF;

  -- source
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='predictions' AND column_name='source'
  ) THEN
    ALTER TABLE predictions ADD COLUMN source TEXT;
  END IF;

  -- window_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='predictions' AND column_name='window_id'
  ) THEN
    ALTER TABLE predictions ADD COLUMN window_id BIGINT;
  END IF;

  -- FK to windows if table exists (ignore if already added)
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name='windows'
  ) THEN
    BEGIN
      ALTER TABLE predictions
        ADD CONSTRAINT predictions_window_fk
        FOREIGN KEY (window_id) REFERENCES windows(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN
      -- constraint already exists; ignore
      NULL;
    END;
  END IF;
END$$;

-- Helpful indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_predictions_source_created
  ON predictions(source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_predictions_window_created
  ON predictions(window_id, created_at DESC);
