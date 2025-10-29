// services/trend.bias.service.js
import { pool } from '../config/db.config.js';

export async function getHistoricalReversalBias(
  windowIdx,
  {
    minEvents = 8, // need enough data
    minRatePct = 55, // >= 55% flip rate in that window
  } = {}
) {
  const { rows } = await pool.query(
    `SELECT *
       FROM mv_reversal_stats_by_window
      WHERE window_idx = $1`,
    [Number(windowIdx)]
  );
  const r = rows[0];
  if (!r) return { color: null, size: null };

  // 1) color bias
  let color = null;
  if (Number(r.color_events) >= minEvents && Number(r.color_flip_rate_pct) >= minRatePct) {
    // pick most common pair as target "to_cluster"
    const pairs = r.color_pairs || {};
    let bestPair = null,
      bestCount = -1;
    for (const [k, v] of Object.entries(pairs)) {
      const cnt = Number(v || 0);
      if (cnt > bestCount) {
        bestCount = cnt;
        bestPair = k;
      }
    }
    if (bestPair && bestPair.includes('→')) {
      color = {
        to_cluster: bestPair.split('→')[1],
        support: bestCount,
        rate_pct: Number(r.color_flip_rate_pct),
      };
    }
  }

  // 2) size bias
  let size = null;
  if (Number(r.size_events) >= minEvents && Number(r.size_flip_rate_pct) >= minRatePct) {
    const pairs = r.size_pairs || {};
    let bestPair = null,
      bestCount = -1;
    for (const [k, v] of Object.entries(pairs)) {
      const cnt = Number(v || 0);
      if (cnt > bestCount) {
        bestCount = cnt;
        bestPair = k;
      }
    }
    if (bestPair && bestPair.includes('→')) {
      size = {
        to: bestPair.split('→')[1],
        support: bestCount,
        rate_pct: Number(r.size_flip_rate_pct),
      };
    }
  }

  return { color, size };
}
