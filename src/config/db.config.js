import pkg from 'pg';
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function initSchema() {
  await pool.query(`
    -- Images table
    CREATE TABLE IF NOT EXISTS images_store (
      id BIGSERIAL PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size BIGINT NOT NULL,
      sha256 TEXT UNIQUE NOT NULL,
      bytes BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Parsed stats per image (one row per image)
    CREATE TABLE IF NOT EXISTS image_stats (
      image_id BIGINT PRIMARY KEY REFERENCES images_store(id) ON DELETE CASCADE,
      numbers SMALLINT[] NOT NULL,               -- e.g. {4,3,9}
      result  INTEGER NOT NULL,                  -- 0..27 only

      -- Even / Odd from result
      result_parity TEXT GENERATED ALWAYS AS (
        CASE WHEN (result % 2 = 0) THEN 'even' ELSE 'odd' END
      ) STORED,

      -- Small / Big from result
      result_size TEXT GENERATED ALWAYS AS (
        CASE
          WHEN result BETWEEN 0 AND 13 THEN 'small'
          WHEN result BETWEEN 14 AND 27 THEN 'big'
          ELSE NULL
        END
      ) STORED,

      -- Fixed color mapping from result
      result_color TEXT GENERATED ALWAYS AS (
        CASE
          WHEN result IN (0,1,26,27)       THEN 'Red'
          WHEN result IN (2,3,24,25)       THEN 'Orange'
          WHEN result IN (4,5,22,23)       THEN 'Pink'
          WHEN result IN (6,7,20,21)       THEN 'Dark Blue'
          WHEN result IN (8,9,18,19)       THEN 'Sky Blue'
          WHEN result IN (10,11,16,17)     THEN 'Green'
          WHEN result IN (12,13,14,15)     THEN 'Gray'
          ELSE NULL
        END
      ) STORED,

      -- Mirror from images_store.created_at via trigger
      screen_shot_time TIMESTAMPTZ NOT NULL,

      parsed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      -- Guard invalid results
      CONSTRAINT result_valid CHECK (result BETWEEN 0 AND 27)
    );

    -- Trigger function to copy created_at -> screen_shot_time
    CREATE OR REPLACE FUNCTION set_screen_shot_time()
    RETURNS trigger AS $$
    BEGIN
      SELECT i.created_at
        INTO NEW.screen_shot_time
        FROM images_store i
       WHERE i.id = NEW.image_id;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- Ensure trigger exists
    DROP TRIGGER IF EXISTS trg_set_screen_shot_time ON image_stats;
    CREATE TRIGGER trg_set_screen_shot_time
    BEFORE INSERT ON image_stats
    FOR EACH ROW
    EXECUTE FUNCTION set_screen_shot_time();

    -- Predictions table
    CREATE TABLE IF NOT EXISTS predictions (
      id BIGSERIAL PRIMARY KEY,
      based_on_image_id BIGINT REFERENCES image_stats(image_id) ON DELETE CASCADE,
      summary JSONB NOT NULL,
      prediction JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_images_store_created_at ON images_store(created_at DESC);
  `);
}
