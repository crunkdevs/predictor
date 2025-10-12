import { pool } from '../config/db.config.js';
import { setActivePattern } from './window.service.js';

async function computePatternMetrics(lookback = 120) {
  const { rows } = await pool.query(
    `
    WITH recent AS (
      SELECT
        screen_shot_time,             -- keep timestamp for ordering
        result,
        result_color,
        result_parity,
        result_size
      FROM v_spins
      ORDER BY screen_shot_time DESC
      LIMIT $1
    ),
    base AS (                         -- 1) first-level window only
      SELECT
        screen_shot_time,
        result,
        result_color,
        result_parity,
        result_size,
        CASE
          WHEN result_color = LAG(result_color)
               OVER (ORDER BY screen_shot_time DESC) THEN 0
          ELSE 1
        END AS is_break               -- 1 when color changes (DESC stream)
      FROM recent
    ),
    w1 AS (                           -- 2) second-level window on the flag
      SELECT
        screen_shot_time,
        result,
        result_color,
        result_parity,
        result_size,
        SUM(is_break) OVER (
          ORDER BY screen_shot_time DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS grp                      -- stable group id per same-color run
      FROM base
    ),
    w2 AS (                           -- 3) run length per group (window in outer SELECT)
      SELECT
        screen_shot_time,
        result,
        result_color,
        result_parity,
        result_size,
        grp,
        COUNT(*) OVER (PARTITION BY grp) AS run_length
      FROM w1
    )
    SELECT
      COUNT(*)                                                       AS total,
      COUNT(DISTINCT result_color)                                   AS colors_used,
      AVG( (result_parity = 'even')::int )::float                    AS even_ratio,
      AVG( (result_size  = 'small')::int )::float                    AS small_ratio,
      MAX(run_length)                                                AS max_run
    FROM w2;
    `,
    [lookback]
  );

  const r = rows[0] || {};
  return {
    even_ratio: Number(r.even_ratio || 0),
    small_ratio: Number(r.small_ratio || 0),
    colors_used: Number(r.colors_used || 0),
    max_run: Number(r.max_run || 0),
  };
}

function classifyPattern(metrics) {
  const { even_ratio, small_ratio, colors_used, max_run } = metrics;

  if (max_run >= 6 || colors_used <= 3) return 'C';
  if (even_ratio > 0.6 || small_ratio > 0.6) return 'B';
  return 'A';
}

export async function detectAndSetPattern(windowId, lookback = 120) {
  const metrics = await computePatternMetrics(lookback);
  const pattern = classifyPattern(metrics);
  await setActivePattern(windowId, pattern);
  return { pattern, metrics };
}
