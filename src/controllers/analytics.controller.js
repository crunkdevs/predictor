import { pool } from '../config/db.config.js';
import {
  getLatestAnchorImageId,
  ensureAnchorExists,
  allStatsBundle,
  windowsSummary,
  gapStats,
  gapStatsExtended,
  ratios,
  numberPatterns,
  recentColorRuns,
  fetchRecentSpins,
  timeBucketsSnapshot,
  rangeSystemsTags,
  buildFourteenSystems,
  advancedAnalyticsBundle,
  runAnalyticsMigrations,
} from '../analytics/analytics.handlers.js';

import { refreshAndPush, pushFreshBundle } from '../analytics/analytics.ws.js';

const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

async function resolveAnchor(anchorParam) {
  if (!anchorParam || anchorParam === 'latest') return await getLatestAnchorImageId();
  const id = Number(anchorParam);
  if (!Number.isFinite(id)) return null;
  return await ensureAnchorExists(id);
}

export async function bundle(req, res) {
  try {
    const lookback = num(req.query.lookback, num(process.env.PRED_LOOKBACK, 200));
    const topk = Math.max(1, Math.min(27, num(req.query.topk, num(process.env.PRED_TOPK, 5))));
    const anchor = await resolveAnchor(req.query.anchor);
    const data = await advancedAnalyticsBundle(anchor, { lookback, topk });
    return ok(res, data);
  } catch (e) {
    console.error('[analytics.bundle]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function core(req, res) {
  try {
    const lookback = num(req.query.lookback, 200);
    const topk = Math.max(1, Math.min(27, num(req.query.topk, 5)));
    const anchor = await resolveAnchor(req.query.anchor);
    const data = await allStatsBundle(anchor, lookback, topk);
    return ok(res, { coreStats: data });
  } catch (e) {
    console.error('[analytics.core]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function windows(req, res) {
  try {
    const limitSeq = Math.max(20, Math.min(2000, num(req.query.limitSeq, 200)));
    const data = await windowsSummary(limitSeq);
    return ok(res, { windows: data });
  } catch (e) {
    console.error('[analytics.windows]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function gaps(req, res) {
  try {
    const lookback = Math.max(50, Math.min(5000, num(req.query.lookback, 500)));
    const data = await gapStats(lookback);
    return ok(res, { gaps: data });
  } catch (e) {
    console.error('[analytics.gaps]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function gapsExt(req, res) {
  try {
    const lookback = Math.max(50, Math.min(5000, num(req.query.lookback, 500)));
    const data = await gapStatsExtended(lookback);
    return ok(res, { gaps_extended: data });
  } catch (e) {
    console.error('[analytics.gapsExtended]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function ratiosApi(req, res) {
  try {
    const lookback = Math.max(10, Math.min(1000, num(req.query.lookback, 50)));
    const data = await ratios(lookback);
    return ok(res, { ratios: data });
  } catch (e) {
    console.error('[analytics.ratios]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function patternsApi(req, res) {
  try {
    const lookback = Math.max(20, Math.min(2000, num(req.query.lookback, 200)));
    const data = await numberPatterns(lookback);
    return ok(res, { patterns: data });
  } catch (e) {
    console.error('[analytics.patterns]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function colorRuns(req, res) {
  try {
    const limit = Math.max(5, Math.min(500, num(req.query.limit, 50)));
    const data = await recentColorRuns(limit);
    return ok(res, { color_runs: data });
  } catch (e) {
    console.error('[analytics.colorRuns]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function recentSpins(req, res) {
  try {
    const limit = Math.max(5, Math.min(200, num(req.query.limit, 30)));
    const data = await fetchRecentSpins(limit);
    return ok(res, { recent_spins: data });
  } catch (e) {
    console.error('[analytics.recentSpins]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function timeBuckets(req, res) {
  try {
    const data = await timeBucketsSnapshot();
    return ok(res, { time_buckets: data });
  } catch (e) {
    console.error('[analytics.timeBuckets]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function rangeSystems(req, res) {
  try {
    const data = await rangeSystemsTags();
    return ok(res, { range_systems: data });
  } catch (e) {
    console.error('[analytics.rangeSystems]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function fourteenSystems(req, res) {
  try {
    const data = await buildFourteenSystems();
    return ok(res, data);
  } catch (e) {
    console.error('[analytics.fourteenSystems]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function refresh(req, res) {
  try {
    // refresh MVs AND push to sockets
    await refreshAndPush();
    return ok(res, { refreshed: true });
  } catch (e) {
    console.error('[analytics.refresh]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function migrate(req, res) {
  try {
    await runAnalyticsMigrations();
    await pushFreshBundle();
    return ok(res, { migrated: true });
  } catch (e) {
    console.error('[analytics.migrate]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function accuracyHourly(req, res) {
  try {
    const limit = Math.max(1, Math.min(2000, num(req.query.limit, 168)));
    const check = await pool.query(
      `SELECT 1 FROM pg_matviews WHERE schemaname='public' AND matviewname='mv_accuracy_hourly'`
    );
    if (!check.rowCount) return ok(res, { rows: [] });
    const { rows } = await pool.query(
      `SELECT hour_bucket, total, correct, accuracy_pct
         FROM mv_accuracy_hourly
        ORDER BY hour_bucket DESC
        LIMIT $1`,
      [limit]
    );
    return ok(res, { rows });
  } catch (e) {
    console.error('[analytics.accuracyHourly]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function accuracyBreakdown(req, res) {
  try {
    const limit = Math.max(1, Math.min(1000, num(req.query.limit, 168)));
    const chk = await pool.query(
      `SELECT 1 FROM pg_matviews WHERE schemaname='public' AND matviewname='mv_accuracy_breakdown'`
    );
    if (!chk.rowCount) return ok(res, { rows: [] });

    const { rows } = await pool.query(
      `SELECT hour_bucket, total, correct, universal_accuracy_pct, category_accuracy
         FROM mv_accuracy_breakdown
        ORDER BY hour_bucket DESC
        LIMIT $1`,
      [limit]
    );
    return ok(res, { rows });
  } catch (e) {
    console.error('[analytics.accuracyBreakdown]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}
