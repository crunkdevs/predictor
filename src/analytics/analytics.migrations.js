import { pool } from '../config/db.config.js';

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

export async function applyAdvancedAnalyticsSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    -- Even/Odd text (pure arithmetic → IMMUTABLE)
    CREATE OR REPLACE FUNCTION fn_parity_text(p_val int)
    RETURNS text
    LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN (p_val % 2 = 0) THEN 'even' ELSE 'odd' END
    $$;

    -- Size text (0..13 small, 14..27 big)
    CREATE OR REPLACE FUNCTION fn_size_text(p_val int)
    RETURNS text
    LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN p_val BETWEEN 0 AND 13 THEN 'small'
                  WHEN p_val BETWEEN 14 AND 27 THEN 'big'
                  ELSE NULL END
    $$;

    -- Color from result (must match image_stats.result_color mapping)
    CREATE OR REPLACE FUNCTION fn_color_from_result(p_result int)
    RETURNS text
    LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE
        WHEN p_result IN (0,1,26,27)   THEN 'Red'
        WHEN p_result IN (2,3,24,25)   THEN 'Orange'
        WHEN p_result IN (4,5,22,23)   THEN 'Pink'
        WHEN p_result IN (6,7,20,21)   THEN 'Dark Blue'
        WHEN p_result IN (8,9,18,19)   THEN 'Sky Blue'
        WHEN p_result IN (10,11,16,17) THEN 'Green'
        WHEN p_result IN (12,13,14,15) THEN 'Gray'
        ELSE NULL END
    $$;

    -- Cluster from color
    CREATE OR REPLACE FUNCTION fn_color_cluster(p_color text)
    RETURNS text
    LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE
        WHEN p_color IN ('Red','Orange','Pink') THEN 'Warm'
        WHEN p_color IN ('Dark Blue','Sky Blue','Green') THEN 'Cool'
        WHEN p_color = 'Gray' THEN 'Neutral'
        ELSE NULL END
    $$;

    -- Quarter index (0:0-6, 1:7-13, 2:14-20, 3:21-27)
    CREATE OR REPLACE FUNCTION fn_quarter_idx(p_val int)
    RETURNS int
    LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE
        WHEN p_val BETWEEN 0 AND 6  THEN 0
        WHEN p_val BETWEEN 7 AND 13 THEN 1
        WHEN p_val BETWEEN 14 AND 20 THEN 2
        WHEN p_val BETWEEN 21 AND 27 THEN 3
        ELSE NULL END
    $$;

    -- Micro band start (4-wide: 0-3,4-7,...,24-27)
    CREATE OR REPLACE FUNCTION fn_micro_band_start(p_val int)
    RETURNS int
    LANGUAGE sql IMMUTABLE AS $$
      SELECT GREATEST(0, LEAST(24, (p_val/4)*4))
    $$;

    -- Mini band start (3-wide: 0-2,3-5,...,24-27)
    CREATE OR REPLACE FUNCTION fn_mini_band_start(p_val int)
    RETURNS int
    LANGUAGE sql IMMUTABLE AS $$
      SELECT GREATEST(0, LEAST(24, (p_val/3)*3))
    $$;

    -- Sliding bands (overlapping width=4) that contain p_val
    CREATE OR REPLACE FUNCTION fn_sliding_bands_json(p_val int)
    RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE s int; outj jsonb := '[]'::jsonb; e int;
    BEGIN
      FOR s IN 0..24 LOOP
        e := LEAST(s+3, 27);
        IF p_val BETWEEN s AND e THEN
          outj := outj || jsonb_build_array(jsonb_build_array(s, e));
        END IF;
      END LOOP;
      RETURN outj;
    END;$$;

    -- Even boolean
    CREATE OR REPLACE FUNCTION fn_even_bool(p_val int)
    RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$ SELECT (p_val % 2 = 0) $$;

    -- All tags as JSON for a given result
    CREATE OR REPLACE FUNCTION fn_number_tags_json(p_val int)
    RETURNS jsonb
    LANGUAGE sql IMMUTABLE AS $$
      SELECT jsonb_build_object(
        'half', CASE WHEN p_val BETWEEN 0 AND 13 THEN 'low' WHEN p_val BETWEEN 14 AND 27 THEN 'high' END,
        'quarter_idx', fn_quarter_idx(p_val),
        'micro_band', jsonb_build_array(fn_micro_band_start(p_val), LEAST(fn_micro_band_start(p_val)+3,27)),
        'mini_band',  jsonb_build_array(fn_mini_band_start(p_val),  LEAST(fn_mini_band_start(p_val)+2,27)),
        'sliding', fn_sliding_bands_json(p_val),
        'even', fn_even_bool(p_val),
        'parity', fn_parity_text(p_val),
        'size', fn_size_text(p_val)
      )
    $$;

    -- Daypart helper
    CREATE OR REPLACE FUNCTION fn_daypart(ts timestamptz)
    RETURNS text
    LANGUAGE sql STABLE AS $$
      SELECT CASE
        WHEN EXTRACT(HOUR FROM ts) BETWEEN 6  AND 11 THEN 'Morning'
        WHEN EXTRACT(HOUR FROM ts) BETWEEN 12 AND 16 THEN 'Noon'
        WHEN EXTRACT(HOUR FROM ts) BETWEEN 17 AND 20 THEN 'Evening'
        ELSE 'Night' END
    $$;

    -- Bucketed spins view
    CREATE OR REPLACE VIEW v_spins_buckets AS
    SELECT
      s.image_id,
      s.screen_shot_time,
      date_trunc('hour', s.screen_shot_time) AS hour_bucket,
      date_trunc('minute', s.screen_shot_time) - ((EXTRACT(MINUTE FROM s.screen_shot_time)::int % 30) || ' minutes')::interval AS half_hour_bucket,
      date_trunc('minute', s.screen_shot_time) - ((EXTRACT(MINUTE FROM s.screen_shot_time)::int % 10) || ' minutes')::interval AS ten_min_bucket,
      fn_daypart(s.screen_shot_time) AS daypart,
      s.result,
      s.result_color,
      s.result_parity,
      s.result_size
    FROM image_stats s;

    -- Color sequence with change points
    CREATE OR REPLACE VIEW v_color_seq AS
    SELECT
      s.image_id,
      s.screen_shot_time,
      s.result_color AS color,
      fn_color_cluster(s.result_color) AS cluster,
      CASE
        WHEN lag(s.result_color) OVER (ORDER BY s.screen_shot_time) = s.result_color THEN 0
        ELSE 1
      END AS color_change
    FROM image_stats s
    WHERE s.result_color IS NOT NULL;

    -- Create/refresh pattern without dropping every start
CREATE OR REPLACE VIEW v_color_runs_base AS
WITH seq AS (
  SELECT
    s.image_id,
    s.screen_shot_time,
    s.result_color AS color,
    fn_color_cluster(s.result_color) AS cluster,
    CASE WHEN lag(s.result_color) OVER (ORDER BY s.screen_shot_time) = s.result_color
         THEN 0 ELSE 1 END AS color_change
  FROM image_stats s
  WHERE s.result_color IS NOT NULL
),
runs AS (
  SELECT *,
         SUM(color_change) OVER (ORDER BY screen_shot_time
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run_id
  FROM seq
)
SELECT
  run_id,
  MIN(screen_shot_time) AS start_time,
  MAX(screen_shot_time) AS end_time,
  COUNT(*)::int         AS run_length,
  MIN(color)            AS color,
  MIN(cluster)          AS cluster
FROM runs
GROUP BY run_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_matviews
    WHERE schemaname = 'public' AND matviewname = 'mv_color_runs'
  ) THEN
    EXECUTE $sql$
      CREATE MATERIALIZED VIEW mv_color_runs AS
      SELECT * FROM v_color_runs_base
    $sql$;
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_mv_color_runs_start ON mv_color_runs(start_time)';
  END IF;
END$$;

CREATE OR REPLACE FUNCTION refresh_mv_color_runs()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW mv_color_runs;
END$$;

    CREATE OR REPLACE FUNCTION fn_gap_stats_json(p_lookback int DEFAULT 500)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE AS $$
    DECLARE outj jsonb;
    BEGIN
      WITH lastn AS (
        SELECT result, result_color, screen_shot_time
        FROM v_spins
        ORDER BY screen_shot_time DESC
        LIMIT p_lookback
      ),
      seq AS (
        SELECT result, result_color,
               ROW_NUMBER() OVER (ORDER BY screen_shot_time DESC) AS rn
        FROM lastn
      ),
      last_hit AS (
        SELECT r, MIN(rn) AS since
        FROM (
          SELECT 0 AS r UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL
          SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12 UNION ALL SELECT 13 UNION ALL
          SELECT 14 UNION ALL SELECT 15 UNION ALL SELECT 16 UNION ALL SELECT 17 UNION ALL SELECT 18 UNION ALL SELECT 19 UNION ALL SELECT 20 UNION ALL
          SELECT 21 UNION ALL SELECT 22 UNION ALL SELECT 23 UNION ALL SELECT 24 UNION ALL SELECT 25 UNION ALL SELECT 26 UNION ALL SELECT 27
        ) nums
        LEFT JOIN seq s ON s.result = nums.r
        GROUP BY r
      ),
      color_last AS (
        SELECT c, MIN(rn) AS since
        FROM (VALUES ('Red'),('Orange'),('Pink'),('Dark Blue'),('Sky Blue'),('Green'),('Gray')) AS C(c)
        LEFT JOIN seq s ON s.result_color = c
        GROUP BY c
      ),
      gaps_num AS (
        SELECT jsonb_object_agg(r::text, COALESCE(since, p_lookback+1)) AS num_gaps FROM last_hit
      ),
      gaps_color AS (
        SELECT jsonb_object_agg(c, COALESCE(since, p_lookback+1)) AS color_gaps FROM color_last
      )
      SELECT jsonb_build_object('lookback', p_lookback,
                                'numbers', (SELECT num_gaps FROM gaps_num),
                                'colors', (SELECT color_gaps FROM gaps_color))
        INTO outj;
      RETURN outj;
    END;$$;

    CREATE OR REPLACE FUNCTION fn_digits_sum_0_27(a int, b int, c int)
    RETURNS int
    LANGUAGE sql IMMUTABLE AS $$ SELECT (a + b + c) $$;

    CREATE OR REPLACE FUNCTION fn_triple_category(a int, b int, c int)
    RETURNS text
    LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE
        WHEN a = b AND b = c THEN 'all_same'
        WHEN (a = b AND b <> c) OR (a = c AND b <> c) OR (b = c AND a <> c) THEN 'two_same_one_diff'
        WHEN (a+1)%10 = b%10 AND (b+1)%10 = c%10 THEN 'sequence'
        WHEN a = c THEN 'palindrome'
        ELSE 'all_diff'
      END
    $$;

    CREATE OR REPLACE FUNCTION fn_digits_color(a int, b int, c int)
    RETURNS text
    LANGUAGE sql IMMUTABLE AS $$ SELECT fn_color_from_result((a+b+c)) $$;

    CREATE TABLE IF NOT EXISTS prediction_logs (
      id BIGSERIAL PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      based_on_image_id bigint REFERENCES image_stats(image_id) ON DELETE SET NULL,
      predicted_numbers smallint[] NOT NULL,
      predicted_color text,
      predicted_parity text,
      predicted_size text,
      confidence numeric,
      actual_result int,
      actual_color text,
      actual_parity text,
      actual_size text,
      correct boolean
    );
    CREATE INDEX IF NOT EXISTS idx_prediction_logs_created ON prediction_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS rule_weights (
      rule_name text PRIMARY KEY,
      weight numeric NOT NULL DEFAULT 1.0,
      wrong_streak int NOT NULL DEFAULT 0,
      disabled boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION fn_feedback_apply(p_log_id bigint)
    RETURNS void
    LANGUAGE plpgsql AS $$
    DECLARE rec record; new_streak int;
    BEGIN
      -- iterate existing weights and adjust globally based on correctness of the log
      FOR rec IN SELECT * FROM rule_weights LOOP
        IF (SELECT correct FROM prediction_logs WHERE id = p_log_id) IS TRUE THEN
          UPDATE rule_weights
             SET weight = LEAST(weight * 1.05, 5.0),
                 wrong_streak = 0,
                 updated_at = now()
           WHERE rule_name = rec.rule_name;
        ELSE
          new_streak := rec.wrong_streak + 1;
          UPDATE rule_weights
             SET weight = GREATEST(weight * 0.95, 0.1),
                 wrong_streak = new_streak,
                 disabled = CASE WHEN new_streak >= 3 THEN true ELSE disabled END,
                 updated_at = now()
           WHERE rule_name = rec.rule_name;
        END IF;
      END LOOP;
    END;$$;

    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_accuracy_hourly AS
    SELECT
      date_trunc('hour', created_at) AS hour_bucket,
      COUNT(*)::int AS total,
      SUM(CASE WHEN correct THEN 1 ELSE 0 END)::int AS correct,
      ROUND(
        (SUM(CASE WHEN correct THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0)) * 100, 2
      ) AS accuracy_pct
    FROM prediction_logs
    GROUP BY 1
    ORDER BY 1;

    CREATE OR REPLACE FUNCTION refresh_mv_accuracy_hourly()
    RETURNS void
    LANGUAGE plpgsql AS $$
    BEGIN
      REFRESH MATERIALIZED VIEW mv_accuracy_hourly; -- non-concurrent (no unique index)
    END$$;

    -- Ratios JSON for last N (odd/even & small/big)
    CREATE OR REPLACE FUNCTION fn_ratios_json(p_lookback int)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE AS $$
    DECLARE outj jsonb; total int; o int; e int; s int; b int;
    BEGIN
      WITH lastn AS (
        SELECT result, result_parity, result_size
        FROM v_spins
        ORDER BY screen_shot_time DESC
        LIMIT p_lookback
      )
      SELECT COUNT(*),
             SUM(CASE WHEN result_parity='odd'  THEN 1 ELSE 0 END),
             SUM(CASE WHEN result_parity='even' THEN 1 ELSE 0 END),
             SUM(CASE WHEN result_size='small' THEN 1 ELSE 0 END),
             SUM(CASE WHEN result_size='big'   THEN 1 ELSE 0 END)
      INTO total, o, e, s, b
      FROM lastn;

      outj := jsonb_build_object(
        'lookback', p_lookback,
        'odd_even', jsonb_build_object(
          'odd_pct',  ROUND((o::numeric / NULLIF(total,0))*100,2),
          'even_pct', ROUND((e::numeric / NULLIF(total,0))*100,2)
        ),
        'small_big', jsonb_build_object(
          'small_pct', ROUND((s::numeric / NULLIF(total,0))*100,2),
          'big_pct',   ROUND((b::numeric / NULLIF(total,0))*100,2)
        )
      );
      RETURN COALESCE(outj, jsonb_build_object('lookback', p_lookback));
    END;$$;

CREATE OR REPLACE FUNCTION fn_number_patterns_json(p_lookback int DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  seq_count int := 0;
  wrap_count int := 0;
  pal_count int := 0;
  total_pairs int := 0;
  prev int;
  cur int;
  first boolean := true;
  outj jsonb;
BEGIN
  -- take the latest N, then iterate in chronological order
  FOR cur IN
    SELECT result
    FROM (
      SELECT result, screen_shot_time
      FROM v_spins
      ORDER BY screen_shot_time DESC
      LIMIT p_lookback
    ) x
    ORDER BY x.screen_shot_time ASC
  LOOP
    IF first THEN
      first := false;
      prev := cur;
      CONTINUE;
    END IF;

    total_pairs := total_pairs + 1;

    IF cur = prev + 1 THEN
      seq_count := seq_count + 1;
    END IF;

    IF cur = 0 AND prev = 27 THEN
      wrap_count := wrap_count + 1;
    END IF;

    IF cur = prev THEN
      pal_count := pal_count + 1;
    END IF;

    prev := cur;
  END LOOP;

  outj := jsonb_build_object(
    'lookback', p_lookback,
    'pairs', total_pairs,
    'sequence_pairs', seq_count,
    'wrap_pairs', wrap_count,
    'pal_pairs', pal_count
  );

  RETURN outj;
END$$;


    -- Extended gap stats with avg/median/max (numbers & colors)
CREATE OR REPLACE FUNCTION fn_gap_stats_ext_json(p_lookback int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE outj jsonb;
BEGIN
  WITH lastn AS (
    SELECT result, result_color, screen_shot_time
    FROM v_spins
    ORDER BY screen_shot_time DESC
    LIMIT p_lookback
  ),
  seq AS (
    SELECT result, result_color,
           ROW_NUMBER() OVER (ORDER BY screen_shot_time DESC) AS rn
    FROM lastn
  ),
  -- per-number since-last
  last_hit AS (
    SELECT r, MIN(rn) AS since
    FROM (SELECT generate_series(0,27) r) nums
    LEFT JOIN seq s ON s.result = nums.r
    GROUP BY r
  ),
  -- per-color since-last
  color_last AS (
    SELECT c, MIN(rn) AS since
    FROM (VALUES ('Red'),('Orange'),('Pink'),('Dark Blue'),('Sky Blue'),('Green'),('Gray')) AS C(c)
    LEFT JOIN seq s ON s.result_color = c
    GROUP BY c
  ),
  -- rolling gaps between occurrences (numbers)
  num_positions AS (
    SELECT result AS n, rn
    FROM seq
  ),
  num_gaps AS (
    SELECT n, (rn - LAG(rn) OVER (PARTITION BY n ORDER BY rn)) AS gap
    FROM num_positions
  ),
  num_gaps_clean AS (
    SELECT n, gap FROM num_gaps WHERE gap IS NOT NULL
  ),
  -- rolling gaps (colors)
  color_positions AS (
    SELECT result_color AS col, rn
    FROM seq
  ),
  color_gaps AS (
    SELECT col, (rn - LAG(rn) OVER (PARTITION BY col ORDER BY rn)) AS gap
    FROM color_positions
  ),
  color_gaps_clean AS (
    SELECT col, gap FROM color_gaps WHERE gap IS NOT NULL
  ),
  num_aggs_rows AS (
    SELECT
      n,
      ROUND(AVG(gap)::numeric, 2) AS avg,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap) AS median,
      MAX(gap) AS max
    FROM num_gaps_clean
    GROUP BY n
  ),
  num_aggs AS (
    SELECT COALESCE(
      jsonb_object_agg(
        n::text,
        jsonb_build_object('avg', avg, 'median', median, 'max', max)
      ),
      '{}'::jsonb
    ) AS num_gap_aggs
    FROM num_aggs_rows
  ),
  color_aggs_rows AS (
    SELECT
      col,
      ROUND(AVG(gap)::numeric, 2) AS avg,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap) AS median,
      MAX(gap) AS max
    FROM color_gaps_clean
    GROUP BY col
  ),
  color_aggs AS (
    SELECT COALESCE(
      jsonb_object_agg(
        col,
        jsonb_build_object('avg', avg, 'median', median, 'max', max)
      ),
      '{}'::jsonb
    ) AS color_gap_aggs
    FROM color_aggs_rows
  ),
  since_num AS (
    SELECT jsonb_object_agg(r::text, COALESCE(since, p_lookback+1)) AS since_map
    FROM last_hit
  ),
  since_color AS (
    SELECT jsonb_object_agg(c, COALESCE(since, p_lookback+1)) AS since_map
    FROM color_last
  )
  SELECT jsonb_build_object(
    'lookback', p_lookback,
    'numbers', jsonb_build_object(
      'since', (SELECT since_map FROM since_num),
      'gaps',  (SELECT num_gap_aggs FROM num_aggs)
    ),
    'colors', jsonb_build_object(
      'since', (SELECT since_map FROM since_color),
      'gaps',  (SELECT color_gap_aggs FROM color_aggs)
    )
  )
  INTO outj;

  RETURN outj;
END$$;


-- base: correctness comes from prediction_logs; top_result comes from predictions JSON
CREATE OR REPLACE VIEW v_accuracy_breakdown_base AS
WITH base AS (
  SELECT
    l.created_at,
    l.correct,
    (p.prediction->>'top_result')::int AS top_result
  FROM prediction_logs l
  LEFT JOIN predictions p
    ON p.based_on_image_id = l.based_on_image_id
),
enriched AS (
  SELECT
    created_at,
    correct,
    top_result,
    CASE
      WHEN top_result IS NOT NULL THEN CASE
        WHEN top_result IN (0,1,26,27)   THEN 'Red'
        WHEN top_result IN (2,3,24,25)   THEN 'Orange'
        WHEN top_result IN (4,5,22,23)   THEN 'Pink'
        WHEN top_result IN (6,7,20,21)   THEN 'Dark Blue'
        WHEN top_result IN (8,9,18,19)   THEN 'Sky Blue'
        WHEN top_result IN (10,11,16,17) THEN 'Green'
        WHEN top_result IN (12,13,14,15) THEN 'Gray'
        ELSE NULL END
    END AS predicted_color,
    CASE
      WHEN top_result IS NOT NULL THEN
        CASE WHEN (top_result % 2 = 0) THEN 'even' ELSE 'odd' END
    END AS predicted_parity,
    CASE
      WHEN top_result IS NOT NULL THEN
        CASE WHEN top_result BETWEEN 0 AND 13 THEN 'small'
             WHEN top_result BETWEEN 14 AND 27 THEN 'big' END
    END AS predicted_size
  FROM base
),
hr AS (
  SELECT date_trunc('hour', created_at) AS hour_bucket, *
  FROM enriched
)
SELECT
  hour_bucket,
  COUNT(*)::int AS total,
  SUM(CASE WHEN correct THEN 1 ELSE 0 END)::int AS correct,
  ROUND((SUM(CASE WHEN correct THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0))*100,2) AS universal_accuracy_pct,
  jsonb_build_object(
    'by_color', COALESCE((
      SELECT jsonb_object_agg(s.predicted_color,
               jsonb_build_object(
                 'total', s.total,
                 'correct', s.correct,
                 'accuracy_pct', s.accuracy_pct
               ))
      FROM (
        SELECT
          h2.predicted_color,
          COUNT(*)::int AS total,
          SUM(CASE WHEN h2.correct THEN 1 ELSE 0 END)::int AS correct,
          ROUND((SUM(CASE WHEN h2.correct THEN 1 ELSE 0 END)::numeric
                 / NULLIF(COUNT(*),0))*100,2) AS accuracy_pct
        FROM hr h2
        WHERE h2.hour_bucket = hr.hour_bucket
          AND h2.predicted_color IS NOT NULL
        GROUP BY h2.predicted_color
      ) s
    ), '{}'::jsonb),
    'by_parity', COALESCE((
      SELECT jsonb_object_agg(s.predicted_parity,
               jsonb_build_object(
                 'total', s.total,
                 'correct', s.correct,
                 'accuracy_pct', s.accuracy_pct
               ))
      FROM (
        SELECT
          h3.predicted_parity,
          COUNT(*)::int AS total,
          SUM(CASE WHEN h3.correct THEN 1 ELSE 0 END)::int AS correct,
          ROUND((SUM(CASE WHEN h3.correct THEN 1 ELSE 0 END)::numeric
                 / NULLIF(COUNT(*),0))*100,2) AS accuracy_pct
        FROM hr h3
        WHERE h3.hour_bucket = hr.hour_bucket
          AND h3.predicted_parity IS NOT NULL
        GROUP BY h3.predicted_parity
      ) s
    ), '{}'::jsonb),
    'by_size', COALESCE((
      SELECT jsonb_object_agg(s.predicted_size,
               jsonb_build_object(
                 'total', s.total,
                 'correct', s.correct,
                 'accuracy_pct', s.accuracy_pct
               ))
      FROM (
        SELECT
          h4.predicted_size,
          COUNT(*)::int AS total,
          SUM(CASE WHEN h4.correct THEN 1 ELSE 0 END)::int AS correct,
          ROUND((SUM(CASE WHEN h4.correct THEN 1 ELSE 0 END)::numeric
                 / NULLIF(COUNT(*),0))*100,2) AS accuracy_pct
        FROM hr h4
        WHERE h4.hour_bucket = hr.hour_bucket
          AND h4.predicted_size IS NOT NULL
        GROUP BY h4.predicted_size
      ) s
    ), '{}'::jsonb)
  ) AS category_accuracy
FROM hr
GROUP BY hour_bucket;

CREATE OR REPLACE FUNCTION refresh_mv_accuracy_breakdown()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW mv_accuracy_breakdown;
END$$;

-- =======================================================================
-- 9) RULE WEIGHTS AUTO-RESET MAINTENANCE
-- =======================================================================
CREATE OR REPLACE FUNCTION fn_rule_weights_maintenance(p_hours int DEFAULT 6)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE rule_weights
     SET disabled = false,
         wrong_streak = 0,
         updated_at = now()
   WHERE disabled = true
     AND now() - updated_at > make_interval(hours => p_hours);
END$$;

  `);
}
