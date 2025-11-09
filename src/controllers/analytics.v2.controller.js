import { pool } from '../config/db.config.js';

import {
  ensureTodayWindows,
  maintainAndGetCurrentWindow,
  fetchWindowState,
  canPredict,
} from '../services/window.service.js';

import { detectAndSetPattern } from '../services/pattern.detector.js';
import {
  localPredict,
  identifyActivePattern,
  buildNumberPool,
  scoreAndRank,
  shouldTriggerAI,
} from '../services/prediction.engine.js';

import { analyzeV2 } from '../services/analyzer.v2.service.js';

import {
  allStatsForLatestAnchor,
  windowsSummary,
  gapStatsExtended,
  ratios,
  recentColorRuns,
  fetchRecentSpins,
  timeBucketsSnapshot,
} from '../analytics/analytics.handlers.js';
import { detectFrequencyDeviation } from '../services/deviation.service.js';
import { detectTrendReversal } from '../services/trend.service.js';

const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export async function reversalBias(req, res) {
  try {
    const win = Number(req.query.window ?? req.query.w ?? -1);
    if (!(win >= 0 && win <= 11)) return res.status(400).json({ ok: false, error: 'window 0..11' });
    const { getHistoricalReversalBias } = await import('../services/trend.bias.service.js');
    const bias = await getHistoricalReversalBias(win);
    return res.json({ ok: true, window_idx: win, bias });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
}

export async function windowAccuracy(req, res) {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days || 30)));
    const q = `
      SELECT
        w.window_idx,
        COUNT(*) FILTER (WHERE (p.prediction ? 'correct')) AS evaluated,
        COUNT(*) FILTER (WHERE (p.prediction->>'correct')::boolean IS TRUE) AS correct,
        COUNT(*) FILTER (WHERE (p.prediction->>'correct')::boolean IS FALSE) AS wrong,
        ROUND(
          100.0 *
          COUNT(*) FILTER (WHERE (p.prediction->>'correct')::boolean IS TRUE)
          / NULLIF(COUNT(*) FILTER (WHERE (p.prediction ? 'correct')), 0),
          2
        ) AS accuracy_pct
      FROM predictions p
      JOIN windows w ON w.id = p.window_id
      WHERE p.created_at >= now() - ($1 || ' days')::interval
      GROUP BY w.window_idx
      ORDER BY w.window_idx;
    `;
    const { rows } = await pool.query(q, [days]);
    res.json({ ok: true, days, rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
}

export async function backfillWindowedTransitions(req, res) {
  try {
    const force = String(req.query.force || '0') === '1';
    const tz = process.env.SCHEDULER_TZ || 'Asia/Shanghai';

    const { rows: crows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM number_transitions_windowed`
    );
    const existing = Number(crows?.[0]?.c || 0);

    if (existing > 0 && !force) {
      return bad(
        res,
        409,
        `already populated (${existing} rows). Use ?force=1 to TRUNCATE and rebuild.`
      );
    }

    if (existing > 0 && force) {
      await pool.query(`TRUNCATE number_transitions_windowed`);
    }

    await pool.query(`SELECT fn_backfill_window_transitions($1)`, [tz]);

    const { rows: stats } = await pool.query(
      `SELECT COUNT(*)::int AS rows, MIN(last_seen) AS first_seen, MAX(last_seen) AS last_seen
         FROM number_transitions_windowed`
    );

    return ok(res, {
      message: 'windowed transitions backfilled',
      tz,
      details: stats?.[0] || {},
      forced: force,
    });
  } catch (e) {
    console.error('[v2.backfillWindowedTransitions]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function backfillTransitions(req, res) {
  try {
    const tz = process.env.SCHEDULER_TZ || 'Asia/Shanghai';
    await pool.query(`SELECT fn_backfill_window_transitions($1)`, [tz]);
    return ok(res, { status: 'backfill_started', tz });
  } catch (e) {
    console.error('[v2.backfillTransitions]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function statusSummary(req, res) {
  try {
    const w = await maintainAndGetCurrentWindow();
    if (!w) return ok(res, { window: null, gate: { can: false, reason: 'no_window' } });

    const state = await fetchWindowState(w.id);

    let deviation = null;
    try {
      deviation = await detectFrequencyDeviation();
    } catch {}

    let trend = null;
    try {
      const { detectTrendReversal } = await import('../services/trend.service.js');
      trend = await detectTrendReversal();
    } catch {}

    let react = null;
    try {
      const { rows: sigRows } = await pool.query(`SELECT fn_snapshot_signature_48h(now()) AS sig`);
      const sig = sigRows?.[0]?.sig || null;
      if (sig) {
        const { rows: matchRows } = await pool.query(
          `SELECT snapshot_id, similarity
   FROM fn_match_pattern_snapshots($1::jsonb, 1)`,
          [sig]
        );
        const best = matchRows?.[0] || null;
        if (best)
          react = { snapshot_id: Number(best.snapshot_id), similarity: Number(best.similarity) };
      }
    } catch {}

    const gate = await canPredict(w.id);

    return ok(res, {
      window: { id: w.id, window_idx: w.window_idx, start_at: w.start_at, end_at: w.end_at },
      mode: state.mode || 'normal',
      gate,
      deviation: deviation || {},
      reversal: trend || {},
      reactivation: react,
    });
  } catch (e) {
    console.error('[v2.statusSummary]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function trendStatus(req, res) {
  try {
    const shortM = num(req.query.shortM, undefined);
    const longM = num(req.query.longM, undefined);
    const delta = req.query.delta != null ? Number(req.query.delta) : undefined;
    const out = await detectTrendReversal({ shortM, longM, delta });
    return ok(res, { reversal: !!out.reversal, detail: out });
  } catch (e) {
    console.error('[v2.trendStatus]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function observationStatus(req, res) {
  try {
    const w = await maintainAndGetCurrentWindow();
    if (!w) return bad(res, 409, 'no current window');

    const state = await fetchWindowState(w.id);

    const observing =
      state.mode === 'observe' || (state.paused_until && new Date(state.paused_until) > new Date());

    return ok(res, {
      window_id: w.id,
      mode: state.mode || 'normal',
      paused_until: state.paused_until,
      observing,
    });
  } catch (e) {
    console.error('[v2.observationStatus]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function deviationStatus(req, res) {
  try {
    const shortM = num(req.query.shortM, undefined);
    const longH = num(req.query.longH, undefined);
    const dev = await detectFrequencyDeviation({ shortM, longH });
    const isDeviation = !!(dev?.deviation || dev?.reversal);
    return ok(res, { deviation: dev || {}, isDeviation });
  } catch (e) {
    console.error('[v2.deviationStatus]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function currentWindow(req, res) {
  try {
    await ensureTodayWindows();
    const w = await maintainAndGetCurrentWindow();
    if (!w)
      return ok(res, { window: null, state: null, gate: { can: false, reason: 'no_window' } });

    const state = await fetchWindowState(w.id);
    const gate = await canPredict(w.id);
    return ok(res, { window: w, state, gate });
  } catch (e) {
    console.error('[v2.currentWindow]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function todayWindows(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT *
         FROM windows
        WHERE day_date = (now() AT TIME ZONE $1)::date
        ORDER BY window_idx`,
      [process.env.SCHEDULER_TZ || 'Asia/Shanghai']
    );
    return ok(res, { rows });
  } catch (e) {
    console.error('[v2.todayWindows]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function detectPattern(req, res) {
  try {
    const w = await maintainAndGetCurrentWindow();
    if (!w) return bad(res, 409, 'no current window');
    const lookback = Math.max(50, Math.min(1200, num(req.query.lookback, 120)));
    const { pattern, metrics } = await detectAndSetPattern(w.id, lookback);
    return ok(res, { window_id: w.id, pattern, metrics });
  } catch (e) {
    console.error('[v2.detectPattern]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function localPredictDry(req, res) {
  try {
    const w = await maintainAndGetCurrentWindow();
    if (!w) return bad(res, 409, 'no current window');

    const result = await localPredict({ windowId: w.id, context: {} });
    return ok(res, { window_id: w.id, result });
  } catch (e) {
    console.error('[v2.localPredictDry]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function runAnalyzeTick(req, res) {
  try {
    const out = await analyzeV2(console);
    return ok(res, { out });
  } catch (e) {
    console.error('[v2.runAnalyzeTick]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function scoringPreview(req, res) {
  try {
    const w = await maintainAndGetCurrentWindow();
    if (!w) return bad(res, 409, 'no current window');

    const { pattern_code } = await identifyActivePattern({});
    const { rows: seqRows } = await pool.query(
      `SELECT result FROM v_spins ORDER BY screen_shot_time DESC LIMIT 30`
    );
    const seqAsc = seqRows.map((r) => Number(r.result)).reverse();
    const last = seqAsc.at(-1);

    const candidatePool = await buildNumberPool({ last, pattern_code, context: {} });
    const ranked = await scoreAndRank(candidatePool, {});

    const top5 = ranked.slice(0, 5).map((r) => r.n);
    const pool = ranked.slice(5, 13).map((r) => r.n);

    return ok(res, {
      window_id: w.id,
      last,
      pool,
      ranked,
      top5,
    });
  } catch (e) {
    console.error('[v2.scoringPreview]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function aiTriggerStatus(req, res) {
  try {
    const w = await maintainAndGetCurrentWindow();
    if (!w) return bad(res, 409, 'no current window');

    const state = await fetchWindowState(w.id);
    let deviationSignal = false;
    let reversalSignal = false;
    try {
      const dev = await detectFrequencyDeviation();
      deviationSignal = !!(dev?.deviation || dev?.reversal);
    } catch {}
    try {
      const { detectTrendReversal } = await import('../services/trend.service.js');
      const rev = await detectTrendReversal();
      reversalSignal = !!rev?.reversal;
    } catch {}
    const out = await shouldTriggerAI({
      windowState: {
        id: state.id,
        status: state.status,
        first_predict_after: state.first_predict_after,
      },
      patternState: { wrong_streak: state.wrong_streak, pattern_code: state.pattern_code },
      deviationSignal,
      reversalSignal,
    });

    return ok(res, { window_id: w.id, trigger: out });
  } catch (e) {
    console.error('[v2.aiTriggerStatus]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function recentPredictions(req, res) {
  try {
    const limit = Math.max(1, Math.min(200, num(req.query.limit, 50)));
    const { rows } = await pool.query(
      `SELECT id, created_at, window_id, source, based_on_image_id, summary, prediction
         FROM predictions
        ORDER BY id DESC
        LIMIT $1`,
      [limit]
    );
    return ok(res, { rows });
  } catch (e) {
    console.error('[v2.recentPredictions]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function numberTransitions(req, res) {
  try {
    const from = num(req.query.from, null);
    const win = num(req.query.window, null);

    let q,
      args = [];

    if (Number.isFinite(from) && Number.isFinite(win)) {
      q = `SELECT from_n, to_n, window_idx, count, last_seen
             FROM number_transitions_windowed
            WHERE from_n = $1 AND window_idx = $2
            ORDER BY count DESC, to_n ASC`;
      args = [from, win];
    } else if (Number.isFinite(from)) {
      q = `SELECT from_n, to_n, count, last_seen
             FROM number_transitions
            WHERE from_n = $1
            ORDER BY count DESC, to_n ASC`;
      args = [from];
    } else {
      q = `SELECT from_n, to_n, count, last_seen
             FROM number_transitions
            ORDER BY last_seen DESC
            LIMIT 200`;
    }

    const { rows } = await pool.query(q, args);
    return ok(res, { rows });
  } catch (e) {
    console.error('[v2.numberTransitions]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function patternSnapshots(req, res) {
  try {
    const limit = Math.max(1, Math.min(50, num(req.query.limit, 10)));
    const withMatch = String(req.query.withMatch || '0') === '1';

    const { rows: snaps } = await pool.query(
      `SELECT id, start_at, end_at, sample_size, top_pool, hit_rate, created_at
         FROM pattern_snapshots
        ORDER BY end_at DESC
        LIMIT $1`,
      [limit]
    );

    if (!withMatch) return ok(res, { snapshots: snaps });

    const { rows: sigRows } = await pool.query(`SELECT fn_snapshot_signature_48h(now()) AS sig`);
    const sig = sigRows?.[0]?.sig || null;

    if (!sig) return ok(res, { snapshots: snaps, match: null });

    const { rows: matchRows } = await pool.query(
      `SELECT snapshot_id, similarity
    FROM fn_match_pattern_snapshots($1::jsonb, 3)`,
      [sig]
    );

    return ok(res, { snapshots: snaps, match: matchRows || [] });
  } catch (e) {
    console.error('[v2.patternSnapshots]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function patternReactivation(req, res) {
  try {
    const { rows: sigRows } = await pool.query(`SELECT fn_snapshot_signature_48h(now()) AS sig`);
    const sig = sigRows?.[0]?.sig || null;
    if (!sig) return ok(res, { match: null });

    const { rows: matchRows } = await pool.query(
      `SELECT snapshot_id, similarity
   FROM fn_match_pattern_snapshots($1::jsonb, 1)`,
      [sig]
    );
    const best = matchRows?.[0] || null;
    if (!best) return ok(res, { match: null });

    const { rows: snapRows } = await pool.query(
      `SELECT id, start_at, end_at, sample_size, top_pool, hit_rate, created_at
         FROM pattern_snapshots
        WHERE id = $1
        LIMIT 1`,
      [best.snapshot_id]
    );
    return ok(res, {
      match: {
        snapshot: snapRows?.[0] || null,
        similarity: Number(best.similarity),
      },
    });
  } catch (e) {
    console.error('[v2.patternReactivation]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function coreBundleForLatest(req, res) {
  try {
    const lookback = Math.max(20, Math.min(1200, num(req.query.lookback, 200)));
    const [coreStats, gaps_extended, r, color_runs, recent_spins, time_buckets, windows] =
      await Promise.all([
        allStatsForLatestAnchor(lookback, Math.max(1, Math.min(27, num(req.query.topk, 8)))),
        gapStatsExtended(Math.max(lookback, 500)),
        ratios(Math.min(lookback, 200)),
        recentColorRuns(Math.max(5, Math.min(200, num(req.query.crLimit, 50)))),
        fetchRecentSpins(Math.max(5, Math.min(200, num(req.query.rsLimit, 30)))),
        timeBucketsSnapshot(),
        windowsSummary(Math.max(50, Math.min(2000, num(req.query.wsLimit, 200)))),
      ]);

    return ok(res, {
      coreStats,
      gaps_extended,
      ratios: r,
      color_runs,
      recent_spins,
      time_buckets,
      windows,
    });
  } catch (e) {
    console.error('[v2.coreBundleForLatest]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}
