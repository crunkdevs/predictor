-- Ensure unique constraint on based_on_image_id for predictions
-- This ensures 1 prediction per image/spin
DO $$
BEGIN
  -- Check if unique constraint or unique index exists
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'predictions'::regclass
      AND conname = 'predictions_based_on_image_id_unique'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE tablename = 'predictions'
      AND indexname = 'predictions_based_on_image_id_unique_idx'
  ) THEN
    -- Create unique index (which also creates a unique constraint)
    CREATE UNIQUE INDEX predictions_based_on_image_id_unique_idx
    ON predictions(based_on_image_id)
    WHERE based_on_image_id IS NOT NULL;
  END IF;
END$$;

