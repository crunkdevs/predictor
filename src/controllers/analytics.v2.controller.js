// src/controllers/analytics.v2.controller.js
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

const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* -------------------------------------------------------
 * WINDOWS / STATE
 * ----------------------------------------------------- */

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

/* -------------------------------------------------------
 * PATTERN & PREDICTION (DRY RUNS)
 * ----------------------------------------------------- */

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

// Pure local (no OpenAI) — dry run, does not write to DB.
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

// Full analyze tick using V2 (will write predictions & attach window if allowed).
export async function runAnalyzeTick(req, res) {
  try {
    const out = await analyzeV2(console);
    return ok(res, { out });
  } catch (e) {
    console.error('[v2.runAnalyzeTick]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

// Low-level building blocks (useful for UI debugs)
export async function scoringPreview(req, res) {
  try {
    const w = await maintainAndGetCurrentWindow();
    if (!w) return bad(res, 409, 'no current window');

    const { pattern_code, scores } = await identifyActivePattern({});
    // quick last sequence for context
    const { rows: seqRows } = await pool.query(
      `SELECT result FROM v_spins ORDER BY screen_shot_time DESC LIMIT 30`
    );
    const seqAsc = seqRows.map((r) => Number(r.result)).reverse();
    const last = seqAsc.at(-1);

    const poolNums = await buildNumberPool({ last, pattern_code, context: {} });
    const ranked = await scoreAndRank(poolNums, {});

    return ok(res, {
      window_id: w.id,
      pattern_code,
      pattern_scores: scores,
      last,
      pool: poolNums,
      ranked,
      top3: ranked.slice(0, 3).map((r) => r.n),
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

    // synthesize a minimal "windowState" expected by shouldTriggerAI
    const state = await fetchWindowState(w.id);
    const out = await shouldTriggerAI({
      windowState: {
        id: state.id,
        status: state.status,
        first_predict_after: state.first_predict_after,
      },
      patternState: { wrong_streak: state.wrong_streak, pattern_code: state.pattern_code },
      deviationSignal: false,
    });

    return ok(res, { window_id: w.id, trigger: out });
  } catch (e) {
    console.error('[v2.aiTriggerStatus]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

/* -------------------------------------------------------
 * RECENT DATA / AGGREGATES (V2-friendly)
 * ----------------------------------------------------- */

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
    let q = `SELECT from_n, to_n, count, last_seen FROM number_transitions`;
    const args = [];
    if (Number.isFinite(from)) {
      q += ` WHERE from_n = $1 ORDER BY count DESC, to_n ASC`;
      args.push(from);
    } else {
      q += ` ORDER BY last_seen DESC LIMIT 200`;
    }
    const { rows } = await pool.query(q, args);
    return ok(res, { rows });
  } catch (e) {
    console.error('[v2.numberTransitions]', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

/* -------------------------------------------------------
 * OPTIONAL: re-expose core analytics tuned for V2 dashboards
 * ----------------------------------------------------- */

export async function coreBundleForLatest(req, res) {
  try {
    const lookback = Math.max(20, Math.min(1200, num(req.query.lookback, 200)));
    const [coreStats, gaps_extended, r, color_runs, recent_spins, time_buckets, windows] =
      await Promise.all([
        allStatsForLatestAnchor(lookback, Math.max(1, Math.min(27, num(req.query.topk, 5)))),
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
