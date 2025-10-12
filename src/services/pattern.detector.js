import { pool } from '../config/db.config.js';
import { setActivePattern } from './window.service.js';

async function computePatternMetrics(lookback = 120) {
  const { rows } = await pool.query(
    `
    WITH recent AS (
      SELECT result, result_color, result_parity, result_size
        FROM v_spins
       ORDER BY screen_shot_time DESC
       LIMIT $1
    )
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT result_color) AS colors_used,
      SUM(CASE WHEN result_parity='even' THEN 1 ELSE 0 END)::float / COUNT(*) AS even_ratio,
      SUM(CASE WHEN result_size='small' THEN 1 ELSE 0 END)::float / COUNT(*) AS small_ratio,
      MAX(run_length) FILTER (WHERE run_length IS NOT NULL) AS max_run
    FROM (
      SELECT
        result_color,
        COUNT(*) OVER (PARTITION BY grp) AS run_length,
        ROW_NUMBER() OVER () AS rn
      FROM (
        SELECT
          result_color,
          SUM(CASE WHEN result_color = LAG(result_color) OVER () THEN 0 ELSE 1 END)
          OVER (ORDER BY (SELECT NULL)) AS grp
        FROM recent
      ) g
    ) r;
    `,
    [lookback]
  );

  const r = rows[0];
  return {
    even_ratio: Number(r?.even_ratio || 0),
    small_ratio: Number(r?.small_ratio || 0),
    colors_used: Number(r?.colors_used || 0),
    max_run: Number(r?.max_run || 0),
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
