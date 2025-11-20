import { pool } from '../config/db.config.js';

export async function detectFrequencyDeviation({ shortM = 30, longH = 6 } = {}) {
  const shortWindow = `${Math.max(5, shortM)} minutes`;
  const longWindow = `${Math.max(1, longH)} hours`;

  const TTL = Math.max(5, Number(process.env.DEVIATION_TTL_SEC || 60)) * 1000;
  if (!global.__DEV_CACHE) global.__DEV_CACHE = { ts: 0, out: null, key: '' };
  const key = `${shortM}|${longH}`;
  const now = Date.now();
  if (global.__DEV_CACHE.key === key && now - global.__DEV_CACHE.ts < TTL) {
    return global.__DEV_CACHE.out;
  }

  const q = `
    WITH short AS (
      SELECT result_color, COUNT(*) AS c
      FROM v_spins
      WHERE screen_shot_time >= now() - INTERVAL '${shortWindow}'
        AND result_color NOT IN ('Red', 'Orange')
      GROUP BY result_color
    ),
    long AS (
      SELECT result_color, COUNT(*) AS c
      FROM v_spins
      WHERE screen_shot_time >= now() - INTERVAL '${longWindow}'
        AND result_color NOT IN ('Red', 'Orange')
      GROUP BY result_color
    ),
    joined AS (
      SELECT
        COALESCE(s.result_color, l.result_color) AS color,
        COALESCE(s.c, 0)::float AS short_c,
        COALESCE(l.c, 0)::float AS long_c
      FROM short s
      FULL OUTER JOIN long l USING (result_color)
    )
    SELECT
      color,
      short_c,
      long_c,
      CASE
        WHEN long_c <= 0 THEN NULL
        ELSE (short_c / long_c)
      END AS ratio
    FROM joined
    WHERE long_c > 0;
  `;

  const { rows } = await pool.query(q);
  if (!rows.length) {
    const out = {
      deviation: false,
      details: [],
      shortWindow: `${shortM} minutes`,
      longWindow: `${longH} hours`,
    };
    global.__DEV_CACHE = { ts: now, out, key };
    return out;
  }

  const ratios = rows.map((r) => Number(r.ratio || 0));
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const maxDev = Math.max(...ratios);
  const minDev = Math.min(...ratios);
  const spread = maxDev - minDev;

  const deviation = spread >= 0.35 || mean <= 0.6 || mean >= 1.4;

  const reversalColors = rows.filter((r) => r.ratio >= 1.3).map((r) => r.color);

  return {
    deviation,
    reversal: reversalColors.length > 0,
    details: rows,
    stats: { mean, spread, maxDev, minDev },
    shortWindow,
    longWindow,
  };
}
