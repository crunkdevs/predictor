import { pool } from '../config/db.config.js';

export async function hasStatsForImage(imageId) {
  if (!Number.isFinite(imageId)) return false;
  const { rows } = await pool.query(`SELECT 1 FROM image_stats WHERE image_id = $1 LIMIT 1`, [
    imageId,
  ]);
  return rows.length > 0;
}

export async function insertImageStats({ imageId, numbers, result }) {
  if (!Number.isFinite(imageId)) {
    throw new Error(`insertImageStats: invalid imageId=${imageId}`);
  }
  if (!Array.isArray(numbers) || numbers.length !== 3 || numbers.some((n) => !Number.isFinite(n))) {
    throw new Error(`insertImageStats: invalid numbers=${JSON.stringify(numbers)}`);
  }
  if (!Number.isFinite(result)) {
    throw new Error(`insertImageStats: invalid result=${result}`);
  }

  await pool.query(
    `INSERT INTO image_stats (image_id, numbers, result)
     VALUES ($1,$2,$3)
     ON CONFLICT (image_id) DO NOTHING`,
    [imageId, numbers, result]
  );
}

export async function latestUnprocessedImages(limit = 5) {
  if (!Number.isFinite(limit) || limit <= 0) limit = 5;

  const { rows } = await pool.query(
    `
    SELECT i.id
    FROM images_store i
    LEFT JOIN image_stats s ON s.image_id = i.id
    WHERE s.image_id IS NULL
    ORDER BY i.created_at DESC
    LIMIT $1
    `,
    [limit]
  );

  if (!rows?.length) return [];
  return rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
}

export async function applyStatsSchema() {
  await pool.query(`
    -- =============== VIEW: v_spins (pass-through; table has generated cols) ===============
    CREATE OR REPLACE VIEW v_spins AS
    SELECT
      s.image_id,
      s.screen_shot_time,
      s.numbers,
      s.result,
      s.result_parity,
      s.result_size,
      s.result_color
    FROM image_stats s;

    -- =============== helpful indexes (idempotent) ===============
    CREATE INDEX IF NOT EXISTS idx_image_stats_shot_time ON image_stats (screen_shot_time DESC);
    CREATE INDEX IF NOT EXISTS idx_image_stats_result    ON image_stats (result);
    CREATE INDEX IF NOT EXISTS idx_image_stats_color     ON image_stats (result_color);
    CREATE INDEX IF NOT EXISTS idx_image_stats_parity    ON image_stats (result_parity);
    CREATE INDEX IF NOT EXISTS idx_image_stats_size      ON image_stats (result_size);

    -- =============== helper: anchor time (screen_shot_time guaranteed NOT NULL) ===============
    CREATE OR REPLACE FUNCTION fn_anchor_time(p_image_id BIGINT)
    RETURNS timestamptz
    LANGUAGE sql STABLE AS $$
      SELECT screen_shot_time
      FROM image_stats
      WHERE image_id = p_image_id
    $$;

    -- =============== COLOR frequency (last N BEFORE anchor) ===============
    CREATE OR REPLACE FUNCTION fn_color_freq_json(p_anchor_image_id BIGINT, p_lookback INT)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE AS $$
    DECLARE
      t_anchor timestamptz;
      agg JSONB;
    BEGIN
      t_anchor := fn_anchor_time(p_anchor_image_id);
      IF t_anchor IS NULL THEN
        RAISE EXCEPTION 'anchor image_id % not found', p_anchor_image_id;
      END IF;

      WITH lastn AS (
        SELECT result_color
        FROM v_spins
        WHERE screen_shot_time < t_anchor
        ORDER BY screen_shot_time DESC
        LIMIT p_lookback
      ),
      counts AS (
        SELECT result_color, COUNT(*) AS c
        FROM lastn
        GROUP BY result_color
      ),
      total AS ( SELECT COALESCE(SUM(c),0) AS t FROM counts )
      SELECT jsonb_build_object(
        'anchor_image_id', p_anchor_image_id,
        'lookback', p_lookback,
        'total', (SELECT t FROM total),
        'colors', COALESCE((SELECT jsonb_object_agg(result_color, c) FROM counts), '{}'::jsonb),
        'colors_pct', COALESCE(
          (SELECT jsonb_object_agg(
            result_color,
            ROUND((c::numeric / NULLIF((SELECT t FROM total),0)) * 100, 2)
          ) FROM counts),
          '{}'::jsonb
        )
      ) INTO agg;

      RETURN COALESCE(agg,
        jsonb_build_object(
          'anchor_image_id', p_anchor_image_id,
          'lookback', p_lookback,
          'total', 0,
          'colors', '{}',
          'colors_pct', '{}'
        )::jsonb
      );
    END;
    $$;

    -- =============== PARITY (odd/even) frequency ===============
    CREATE OR REPLACE FUNCTION fn_parity_freq_json(p_anchor_image_id BIGINT, p_lookback INT)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE AS $$
    DECLARE
      t_anchor timestamptz;
      res JSONB;
    BEGIN
      t_anchor := fn_anchor_time(p_anchor_image_id);
      IF t_anchor IS NULL THEN
        RAISE EXCEPTION 'anchor image_id % not found', p_anchor_image_id;
      END IF;

      WITH lastn AS (
        SELECT result_parity
        FROM v_spins
        WHERE screen_shot_time < t_anchor
        ORDER BY screen_shot_time DESC
        LIMIT p_lookback
      ),
      counts AS (
        SELECT result_parity, COUNT(*) AS c
        FROM lastn
        GROUP BY result_parity
      ),
      total AS ( SELECT COALESCE(SUM(c),0) AS t FROM counts )
      SELECT jsonb_build_object(
        'anchor_image_id', p_anchor_image_id,
        'lookback', p_lookback,
        'total', (SELECT t FROM total),
        'counts', COALESCE((SELECT jsonb_object_agg(result_parity, c) FROM counts), '{}'::jsonb),
        'pct', COALESCE(
          (SELECT jsonb_object_agg(
            result_parity,
            ROUND((c::numeric / NULLIF((SELECT t FROM total),0)) * 100, 2)
          ) FROM counts),
          '{}'::jsonb
        )
      ) INTO res;

      RETURN COALESCE(res,
        jsonb_build_object(
          'anchor_image_id', p_anchor_image_id,
          'lookback', p_lookback,
          'total', 0,
          'counts', '{}',
          'pct', '{}'
        )::jsonb
      );
    END;
    $$;

    -- =============== SIZE+PARITY 4-way breakdown ===============
    CREATE OR REPLACE FUNCTION fn_size_parity_freq_json(p_anchor_image_id BIGINT, p_lookback INT)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE AS $$
    DECLARE
      t_anchor timestamptz;
      outj JSONB;
    BEGIN
      t_anchor := fn_anchor_time(p_anchor_image_id);
      IF t_anchor IS NULL THEN
        RAISE EXCEPTION 'anchor image_id % not found', p_anchor_image_id;
      END IF;

      WITH lastn AS (
        SELECT
          CASE
            WHEN result_size = 'small' AND result_parity = 'odd'  THEN 'small_odd'
            WHEN result_size = 'small' AND result_parity = 'even' THEN 'small_even'
            WHEN result_size = 'big'   AND result_parity = 'odd'  THEN 'big_odd'
            WHEN result_size = 'big'   AND result_parity = 'even' THEN 'big_even'
            ELSE NULL
          END AS bucket
        FROM v_spins
        WHERE screen_shot_time < t_anchor
        ORDER BY screen_shot_time DESC
        LIMIT p_lookback
      ),
      counts AS ( SELECT bucket, COUNT(*) AS c FROM lastn GROUP BY bucket ),
      total  AS ( SELECT COALESCE(SUM(c),0) AS t FROM counts )
      SELECT jsonb_build_object(
        'anchor_image_id', p_anchor_image_id,
        'lookback', p_lookback,
        'total', (SELECT t FROM total),
        'counts', COALESCE((SELECT jsonb_object_agg(bucket, c) FROM counts), '{}'::jsonb),
        'pct', COALESCE(
          (SELECT jsonb_object_agg(
            bucket,
            ROUND((c::numeric / NULLIF((SELECT t FROM total),0)) * 100, 2)
          ) FROM counts),
          '{}'::jsonb
        )
      ) INTO outj;

      RETURN COALESCE(outj,
        jsonb_build_object(
          'anchor_image_id', p_anchor_image_id,
          'lookback', p_lookback,
          'total', 0,
          'counts', '{}',
          'pct', '{}'
        )::jsonb
      );
    END;
    $$;

    -- =============== LAST-DIGIT histogram (result % 10) ===============
    CREATE OR REPLACE FUNCTION fn_last_digit_freq_json(p_anchor_image_id BIGINT, p_lookback INT)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE AS $$
    DECLARE
      t_anchor timestamptz;
      outj JSONB;
    BEGIN
      t_anchor := fn_anchor_time(p_anchor_image_id);
      IF t_anchor IS NULL THEN
        RAISE EXCEPTION 'anchor image_id % not found', p_anchor_image_id;
      END IF;

      WITH lastn AS (
        SELECT (result % 10) AS d
        FROM v_spins
        WHERE screen_shot_time < t_anchor
        ORDER BY screen_shot_time DESC
        LIMIT p_lookback
      ),
      counts AS ( SELECT d, COUNT(*) AS c FROM lastn GROUP BY d ),
      total  AS ( SELECT COALESCE(SUM(c),0) AS t FROM counts )
      SELECT jsonb_build_object(
        'anchor_image_id', p_anchor_image_id,
        'lookback', p_lookback,
        'total', (SELECT t FROM total),
        'digits', COALESCE((SELECT jsonb_object_agg(d::text, c) FROM counts), '{}'::jsonb),
        'digits_pct', COALESCE(
          (SELECT jsonb_object_agg(
            d::text,
            ROUND((c::numeric / NULLIF((SELECT t FROM total),0)) * 100, 2)
          ) FROM counts),
          '{}'::jsonb
        )
      ) INTO outj;

      RETURN COALESCE(outj,
        jsonb_build_object(
          'anchor_image_id', p_anchor_image_id,
          'lookback', p_lookback,
          'total', 0,
          'digits', '{}',
          'digits_pct', '{}'
        )::jsonb
      );
    END;
    $$;

    -- =============== HOT/COLD numbers (0..27) ===============
    CREATE OR REPLACE FUNCTION fn_hot_cold_numbers_json(p_anchor_image_id BIGINT, p_lookback INT, p_k INT DEFAULT 3)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE AS $$
    DECLARE
      t_anchor timestamptz;
      outj JSONB;
    BEGIN
      t_anchor := fn_anchor_time(p_anchor_image_id);
      IF t_anchor IS NULL THEN
        RAISE EXCEPTION 'anchor image_id % not found', p_anchor_image_id;
      END IF;

      WITH lastn AS (
        SELECT result
        FROM v_spins
        WHERE screen_shot_time < t_anchor
        ORDER BY screen_shot_time DESC
        LIMIT p_lookback
      ),
      counts AS (
        SELECT gs.n AS result, COALESCE(c.c, 0) AS cnt
        FROM (SELECT generate_series(0,27) AS n) gs
        LEFT JOIN (
          SELECT result, COUNT(*) AS c
          FROM lastn
          GROUP BY result
        ) c
          ON c.result = gs.n
      ),
      hot AS (
        SELECT result, cnt
        FROM counts
        ORDER BY cnt DESC, result ASC
        LIMIT p_k
      ),
      cold AS (
        SELECT result, cnt
        FROM counts
        ORDER BY cnt ASC, result ASC
        LIMIT p_k
      )
      SELECT jsonb_build_object(
        'anchor_image_id', p_anchor_image_id,
        'lookback', p_lookback,
        'k', p_k,
        'hot',  COALESCE((SELECT jsonb_agg(jsonb_build_object('result', result, 'count', cnt)) FROM hot),  '[]'::jsonb),
        'cold', COALESCE((SELECT jsonb_agg(jsonb_build_object('result', result, 'count', cnt)) FROM cold), '[]'::jsonb)
      ) INTO outj;

      RETURN COALESCE(outj,
        jsonb_build_object(
          'anchor_image_id', p_anchor_image_id,
          'lookback', p_lookback,
          'k', p_k,
          'hot', '[]',
          'cold', '[]'
        )::jsonb
      );
    END;
    $$;
  `);
}
