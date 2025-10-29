-- 1) raw events
CREATE TABLE IF NOT EXISTS trend_reversal_events (
  id BIGSERIAL PRIMARY KEY,
  window_id     BIGINT NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
  window_idx    SMALLINT NOT NULL CHECK (window_idx BETWEEN 0 AND 11),
  event_time    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- color cluster reversal (nullable if none)
  color_from    TEXT,
  color_to      TEXT,
  color_delta   NUMERIC(6,4),

  -- size reversal (nullable if none)
  size_from     TEXT,
  size_to       TEXT,
  size_delta    NUMERIC(6,4)
);

CREATE INDEX IF NOT EXISTS idx_tre_time         ON trend_reversal_events(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_tre_window_idx   ON trend_reversal_events(window_idx);

-- 2) 60-day window rollup by window_idx
DROP MATERIALIZED VIEW IF EXISTS mv_reversal_stats_by_window;
CREATE MATERIALIZED VIEW mv_reversal_stats_by_window AS
WITH base AS (
  SELECT *
  FROM trend_reversal_events
  WHERE event_time >= now() - interval '60 days'
),
color_stats AS (
  SELECT
    window_idx,
    COUNT(*) FILTER (WHERE color_from IS NOT NULL AND color_to IS NOT NULL)         AS color_events,
    COUNT(*) FILTER (WHERE color_from <> color_to)                                   AS color_flips,
    jsonb_object_agg(
      concat(COALESCE(color_from,'?'),'→',COALESCE(color_to,'?')),
      cnt
    ) AS color_pairs
  FROM (
    SELECT window_idx, color_from, color_to, COUNT(*) AS cnt
    FROM base
    WHERE color_from IS NOT NULL AND color_to IS NOT NULL
    GROUP BY window_idx, color_from, color_to
  ) t
  GROUP BY window_idx
),
size_stats AS (
  SELECT
    window_idx,
    COUNT(*) FILTER (WHERE size_from IS NOT NULL AND size_to IS NOT NULL)            AS size_events,
    COUNT(*) FILTER (WHERE size_from <> size_to)                                     AS size_flips,
    jsonb_object_agg(
      concat(COALESCE(size_from,'?'),'→',COALESCE(size_to,'?')),
      cnt
    ) AS size_pairs
  FROM (
    SELECT window_idx, size_from, size_to, COUNT(*) AS cnt
    FROM base
    WHERE size_from IS NOT NULL AND size_to IS NOT NULL
    GROUP BY window_idx, size_from, size_to
  ) t
  GROUP BY window_idx
)
SELECT
  COALESCE(c.window_idx, s.window_idx) AS window_idx,
  COALESCE(c.color_events, 0) AS color_events,
  COALESCE(c.color_flips,  0) AS color_flips,
  CASE WHEN COALESCE(c.color_events,0) > 0
       THEN ROUND(100.0*c.color_flips/NULLIF(c.color_events,0),2) END AS color_flip_rate_pct,
  COALESCE(c.color_pairs, '{}'::jsonb) AS color_pairs,

  COALESCE(s.size_events, 0) AS size_events,
  COALESCE(s.size_flips,  0) AS size_flips,
  CASE WHEN COALESCE(s.size_events,0) > 0
       THEN ROUND(100.0*s.size_flips/NULLIF(s.size_events,0),2) END AS size_flip_rate_pct,
  COALESCE(s.size_pairs, '{}'::jsonb) AS size_pairs
FROM color_stats c
FULL JOIN size_stats s USING (window_idx);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_rev_by_win ON mv_reversal_stats_by_window(window_idx);

-- helper to refresh
CREATE OR REPLACE FUNCTION refresh_mv_reversal_stats()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_reversal_stats_by_window;
END$$;
