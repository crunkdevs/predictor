-- ================================================
-- Pattern Snapshots (48h) – accumulation & reuse
-- ================================================

-- 1) Snapshot table
CREATE TABLE IF NOT EXISTS pattern_snapshots (
  id BIGSERIAL PRIMARY KEY,
  start_at TIMESTAMPTZ NOT NULL,
  end_at   TIMESTAMPTZ NOT NULL,
  sample_size INT NOT NULL,
  signature JSONB NOT NULL,          -- compact "state vector" of the regime
  top_pool SMALLINT[] NOT NULL,      -- top 7–8 frequent numbers in the window
  hit_rate NUMERIC(6,4),             -- optional: attach later when outcomes measured
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (start_at, end_at)
);

CREATE INDEX IF NOT EXISTS idx_pattern_snapshots_end ON pattern_snapshots(end_at DESC);

-- 2) Helper: compute color shares / parity/size ratios / max_run / top numbers
CREATE OR REPLACE FUNCTION fn_snapshot_signature_48h(p_end TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  p_start TIMESTAMPTZ := p_end - INTERVAL '48 hours';
  total INT;
  color_j JSONB;
  parity_j JSONB;
  size_j JSONB;
  max_run INT;
  top_nums SMALLINT[];
BEGIN
  -- total rows
  SELECT COUNT(*) INTO total
  FROM v_spins
  WHERE screen_shot_time >= p_start AND screen_shot_time < p_end;

  IF COALESCE(total,0) = 0 THEN
    RETURN jsonb_build_object(
      'window', jsonb_build_object('start', p_start, 'end', p_end, 'total', 0),
      'color_share', '{}'::jsonb,
      'parity_pct',  '{}'::jsonb,
      'size_pct',    '{}'::jsonb,
      'max_run', 0,
      'top_numbers', '[]'::jsonb
    );
  END IF;

  -- color shares
  SELECT COALESCE(jsonb_object_agg(result_color, (cnt::float)/total), '{}'::jsonb)
    INTO color_j
  FROM (
    SELECT result_color, COUNT(*) AS cnt
    FROM v_spins
    WHERE screen_shot_time >= p_start AND screen_shot_time < p_end
    GROUP BY result_color
  ) c;

  -- parity percentage
  SELECT jsonb_build_object(
    'odd_pct',  COALESCE(AVG((result_parity='odd')::int),0.0)*100.0,
    'even_pct', COALESCE(AVG((result_parity='even')::int),0.0)*100.0
  )
  INTO parity_j
  FROM v_spins
  WHERE screen_shot_time >= p_start AND screen_shot_time < p_end;

  -- size percentage
  SELECT jsonb_build_object(
    'small_pct', COALESCE(AVG((result_size='small')::int),0.0)*100.0,
    'big_pct',   COALESCE(AVG((result_size='big')::int),0.0)*100.0
  )
  INTO size_j
  FROM v_spins
  WHERE screen_shot_time >= p_start AND screen_shot_time < p_end;

  -- max same-color run within the window (like your detector does)
  WITH recent AS (
    SELECT screen_shot_time, result_color
    FROM v_spins
    WHERE screen_shot_time >= p_start AND screen_shot_time < p_end
    ORDER BY screen_shot_time DESC
  ),
  base AS (
    SELECT
      screen_shot_time,
      result_color,
      CASE WHEN result_color = LAG(result_color) OVER (ORDER BY screen_shot_time DESC)
           THEN 0 ELSE 1 END AS is_break
    FROM recent
  ),
  w1 AS (
    SELECT
      screen_shot_time,
      result_color,
      SUM(is_break) OVER (ORDER BY screen_shot_time DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
    FROM base
  ),
  w2 AS (
    SELECT
      result_color,
      COUNT(*) OVER (PARTITION BY grp) AS run_length
    FROM w1
  )
  SELECT COALESCE(MAX(run_length),0) INTO max_run FROM w2;

  -- top frequent numbers in the 48h window
  SELECT ARRAY(
    SELECT result::smallint
    FROM (
      SELECT result, COUNT(*) AS c
      FROM v_spins
      WHERE screen_shot_time >= p_start AND screen_shot_time < p_end
      GROUP BY result
      ORDER BY c DESC, result ASC
      LIMIT 8
    ) t
  )
  INTO top_nums;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('start', p_start, 'end', p_end, 'total', total),
    'color_share', color_j,
    'parity_pct',  parity_j,
    'size_pct',    size_j,
    'max_run', max_run,
    'top_numbers', to_jsonb(top_nums)
  );
END;
$$;

-- 3) Take & store a 48h snapshot ending at p_end (default now)
CREATE OR REPLACE FUNCTION fn_store_pattern_snapshot_48h(p_end TIMESTAMPTZ DEFAULT now())
RETURNS pattern_snapshots
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  sig JSONB;
  p_start TIMESTAMPTZ := p_end - INTERVAL '48 hours';
  total INT;
  pool SMALLINT[];
  rec pattern_snapshots%ROWTYPE;
BEGIN
  sig := fn_snapshot_signature_48h(p_end);
  total := COALESCE( (sig->'window'->>'total')::int, 0 );
  pool := COALESCE( (SELECT ARRAY(SELECT jsonb_array_elements_text(sig->'top_numbers')::smallint)), ARRAY[]::smallint[] );

  INSERT INTO pattern_snapshots (start_at, end_at, sample_size, signature, top_pool, hit_rate)
  VALUES (p_start, p_end, total, sig, pool, NULL)
  ON CONFLICT (start_at, end_at) DO UPDATE
    SET sample_size = EXCLUDED.sample_size,
        signature   = EXCLUDED.signature,
        top_pool    = EXCLUDED.top_pool
  RETURNING * INTO rec;

  RETURN rec;
END;
$$;

-- 4) Find similar snapshots by signature (simple similarity: color L1 + parity/size diffs + Jaccard on top_numbers)
-- Returns: snapshot id, similarity (0..1, higher is better)
CREATE OR REPLACE FUNCTION fn_match_pattern_snapshots(p_sig JSONB, p_limit INT DEFAULT 3)
RETURNS TABLE(snapshot_id BIGINT, similarity NUMERIC)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH cand AS (
    SELECT id, signature, top_pool
    FROM pattern_snapshots
    ORDER BY end_at DESC
    LIMIT 200  -- search recent first; adjust as needed
  ),
  scored AS (
    SELECT
      id,
      -- color L1 distance over known palette
      (
        COALESCE(ABS( (signature->'color_share'->>'Red')::float
                    - (p_sig->'color_share'->>'Red')::float ), 0) +
        COALESCE(ABS( (signature->'color_share'->>'Orange')::float
                    - (p_sig->'color_share'->>'Orange')::float ), 0) +
        COALESCE(ABS( (signature->'color_share'->>'Pink')::float
                    - (p_sig->'color_share'->>'Pink')::float ), 0) +
        COALESCE(ABS( (signature->'color_share'->>'Dark Blue')::float
                    - (p_sig->'color_share'->>'Dark Blue')::float ), 0) +
        COALESCE(ABS( (signature->'color_share'->>'Sky Blue')::float
                    - (p_sig->'color_share'->>'Sky Blue')::float ), 0) +
        COALESCE(ABS( (signature->'color_share'->>'Green')::float
                    - (p_sig->'color_share'->>'Green')::float ), 0) +
        COALESCE(ABS( (signature->'color_share'->>'Gray')::float
                    - (p_sig->'color_share'->>'Gray')::float ), 0)
      ) AS color_l1,
      -- parity/size absolute diffs (percent space 0-100)
      COALESCE(ABS( (signature->'parity_pct'->>'odd_pct')::float
                  - (p_sig->'parity_pct'->>'odd_pct')::float ), 0) AS odd_diff,
      COALESCE(ABS( (signature->'size_pct'->>'small_pct')::float
                  - (p_sig->'size_pct'->>'small_pct')::float ), 0) AS small_diff,
      -- Jaccard on top numbers
      (
        SELECT
          CASE
            WHEN (cardinality(s1)=0 AND cardinality(s2)=0) THEN 1.0
            ELSE (cardinality( (SELECT ARRAY(SELECT UNNEST(s1) INTERSECT SELECT UNNEST(s2))) )::float)
               / (cardinality( (SELECT ARRAY(SELECT UNNEST(s1) UNION    SELECT UNNEST(s2))) )::float)
          END
        FROM (
          SELECT top_pool AS s1,
                 COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_sig->'top_numbers')::smallint), ARRAY[]::smallint[]) AS s2
        ) z
      ) AS jaccard_top
    FROM cand
  ),
  norm AS (
    SELECT
      id,
      -- normalize each component into [0..1] similarity; weights can be tuned
      GREATEST(0, 1 - (color_l1/2.0))                         AS sim_color,
      GREATEST(0, 1 - (odd_diff/100.0))                       AS sim_parity,
      GREATEST(0, 1 - (small_diff/100.0))                     AS sim_size,
      COALESCE(jaccard_top, 0)                                AS sim_top
    FROM scored
  ),
  combined AS (
    SELECT
      id AS snapshot_id,
      (0.4*sim_color + 0.2*sim_parity + 0.2*sim_size + 0.2*sim_top) AS similarity
    FROM norm
  )
  SELECT snapshot_id, similarity
  FROM combined
  ORDER BY similarity DESC, snapshot_id DESC
  LIMIT GREATEST(1, p_limit);
END;
$$;
