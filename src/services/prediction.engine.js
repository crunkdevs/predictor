// services/prediction.engine.js
import { pool } from '../config/db.config.js';
import {
  canPredict,
  getOrCreatePatternState,
  pausePattern,
  updateStreak,
} from './window.service.js';
import {
  timeBucketsSnapshot,
  gapStatsExtended,
  ratios,
  numberPatterns,
  recentColorRuns,
  fetchRecentSpins,
} from '../analytics/analytics.handlers.js';

// ---------- Config ----------

const TZ = process.env.SCHEDULER_TZ || 'Asia/Shanghai';
const POOL_SIZE = 8;
const WRONG_PAUSE_MIN = Number(process.env.PRED_PAUSE_MIN || 10);
const PAUSE_AFTER_WRONGS = Number(process.env.PRED_PAUSE_AFTER_WRONGS || 3);
const AI_MAX_PER_DAY = Number(process.env.AI_MAX_PER_DAY || 3);
const AI_MIN_GAP_HOURS = Number(process.env.AI_MIN_GAP_HOURS || 6);
const AI_MAX_PER_WINDOW = Number(process.env.AI_MAX_PER_WINDOW || 1);

// ---------- Small utils ----------

const COLOR_MAP = {
  Red: [0, 1, 26, 27],
  Orange: [2, 3, 24, 25],
  Pink: [4, 5, 22, 23],
  'Dark Blue': [6, 7, 20, 21],
  'Sky Blue': [8, 9, 18, 19],
  Green: [10, 11, 16, 17],
  Gray: [12, 13, 14, 15],
};
export function numToColor(n) {
  n = Number(n);
  for (const [c, arr] of Object.entries(COLOR_MAP)) if (arr.includes(n)) return c;
  return null;
}
export const parityOf = (n) => (Number(n) % 2 === 0 ? 'even' : 'odd');
export const sizeOf = (n) => (Number(n) <= 13 ? 'small' : 'big');

function normalizeWeights(arr, key = 'score') {
  if (!arr.length) return arr;
  let min = Infinity,
    max = -Infinity;
  for (const r of arr) {
    const v = Number(r[key] || 0);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  for (const r of arr) r[key] = (Number(r[key] || 0) - min) / span;
  return arr;
}

function clamp01(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const quadKey = (n) => `${parityOf(n)}_${sizeOf(n)}`; // "even_small" | "odd_small" | "even_big" | "odd_big"

async function getFourClassShares(limit = 200) {
  // Pull recent spins via existing helper to stay consistent
  const rows = await fetchRecentSpins(Math.max(50, Math.min(500, Number(limit) || 200)));
  if (!rows?.length) {
    // neutral shares if nothing to go on
    return {
      even_small: 0.25,
      odd_small: 0.25,
      even_big: 0.25,
      odd_big: 0.25,
    };
  }
  const counts = { even_small: 0, odd_small: 0, even_big: 0, odd_big: 0 };
  for (const r of rows) {
    const k = `${String(r.result_parity || '').toLowerCase()}_${String(r.result_size || '').toLowerCase()}`;
    if (counts[k] != null) counts[k] += 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / total]));
}

// ---------- Data access helpers ----------

async function getLastResults(limit = 30) {
  const rows = await fetchRecentSpins(limit);
  return rows
    .slice()
    .reverse()
    .map((r) => Number(r.result))
    .filter(Number.isFinite);
}

async function getTransitionsFromDB(fromN, topK = 12) {
  const { rows } = await pool.query(
    `SELECT to_n, count FROM number_transitions WHERE from_n = $1 ORDER BY count DESC, to_n ASC LIMIT $2`,
    [fromN, topK]
  );
  return rows.map((r) => ({ to: Number(r.to_n), c: Number(r.count) }));
}

async function getTransitionsWindowed(fromN, windowIdx, topK = 12) {
  const { rows } = await pool.query(
    `SELECT to_n, count
       FROM number_transitions_windowed
      WHERE from_n = $1 AND window_idx = $2
      ORDER BY count DESC, to_n ASC
      LIMIT $3`,
    [fromN, windowIdx, topK]
  );
  return rows.map((r) => ({ to: Number(r.to_n), c: Number(r.count) }));
}

// ---------- Pattern identification ----------

export async function identifyActivePattern(context = {}) {
  const lookback = Number(process.env.PRED_LOOKBACK || 200);

  const ratio = context.ratios ?? (await ratios(Math.min(lookback, 200)));
  const gapsExt = context.gapsExt ?? (await gapStatsExtended(Math.max(lookback, 500)));
  const patterns = context.numberPatterns ?? (await numberPatterns(Math.min(lookback, 200)));

  let scoreA = 0,
    scoreB = 0,
    scoreC = 0;

  const pairs = Number(patterns?.pairs || 0);
  const seqPairs = Number(patterns?.sequence_pairs || 0);
  if (pairs > 0) {
    const seqRate = seqPairs / pairs;
    if (seqRate >= 0.25) scoreA += 1.0;
  }

  const oddPct = Number(ratio?.odd_even?.odd_pct ?? NaN);
  const smallPct = Number(ratio?.small_big?.small_pct ?? NaN);
  if (Number.isFinite(oddPct) && Math.abs(oddPct - 50) <= 8) scoreB += 0.6;
  if (Number.isFinite(smallPct) && Math.abs(smallPct - 50) <= 8) scoreB += 0.6;

  const gapNums = gapsExt?.numbers?.gaps || {};
  const unseenCount = Object.values(gapsExt?.numbers?.since || {}).filter((v) => v == null).length;
  const highMedianCount = Object.values(gapNums).filter((o) => Number(o?.median || 0) >= 12).length;
  if (unseenCount >= 3 || highMedianCount >= 10) scoreC += 1.2;

  const scored = [
    { code: 'A', s: scoreA },
    { code: 'B', s: scoreB },
    { code: 'C', s: scoreC },
  ].sort((x, y) => y.s - x.s);

  return {
    pattern_code: scored[0].code,
    scores: { A: scoreA, B: scoreB, C: scoreC },
  };
}

// ---------- Pool selection (7–8 numbers) ----------

export async function buildNumberPool({ last, pattern_code, context = {} }) {
  const poolSet = new Set();
  const TRANSITIONS_MIN_COUNT = Number(process.env.TRANSITIONS_MIN_COUNT || 2);

  let trans = [];

  if (Number.isFinite(context.window_idx)) {
    trans = await getTransitionsWindowed(last, Number(context.window_idx), 12);
  }

  if (!trans || trans.length < TRANSITIONS_MIN_COUNT) {
    trans = await getTransitionsFromDB(last, 12);
  }

  for (const t of trans) {
    if (poolSet.size >= POOL_SIZE) break;
    poolSet.add(t.to);
  }

  // Reactivation bias (from 48h snapshot) — if present, seed pool with those numbers first
  const react = context.reactivation || null;
  const reactOk = react && Number(react.similarity) >= 0.75;
  const reactPool = Array.isArray(react?.snapshot_top_pool)
    ? react.snapshot_top_pool
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 27)
    : [];

  if (reactOk && reactPool.length) {
    for (const n of reactPool) {
      if (poolSet.size >= POOL_SIZE) break;
      poolSet.add(n);
    }
  }

  const gapsExt = context.gapsExt ?? (await gapStatsExtended(500));
  const sinceMap = gapsExt?.numbers?.since || {};

  if (poolSet.size < POOL_SIZE && Number.isFinite(last)) {
    // Try window-aware first (if we know window_idx in context)
    let trans = [];
    const winIdx = Number.isFinite(context.window_idx) ? Number(context.window_idx) : undefined;
    if (Number.isFinite(winIdx)) {
      trans = await getTransitionsWindowed(last, winIdx, 12);
    }
    // Fallback to global if sparse
    if (!trans || trans.length < TRANSITIONS_MIN_COUNT) {
      trans = await getTransitionsFromDB(last, 12);
    }
    for (const t of trans) {
      if (poolSet.size >= POOL_SIZE) break;
      poolSet.add(t.to);
    }
  }

  if (poolSet.size < POOL_SIZE && Number.isFinite(last) && pattern_code === 'B') {
    const wantParity = parityOf(last) === 'even' ? 'odd' : 'even';
    const wantSize = sizeOf(last) === 'small' ? 'big' : 'small';
    for (let n = 0; n <= 27 && poolSet.size < POOL_SIZE; n++) {
      if (poolSet.has(n)) continue;
      if (parityOf(n) === wantParity || sizeOf(n) === wantSize) poolSet.add(n);
    }
  }

  if (poolSet.size < POOL_SIZE && pattern_code === 'C') {
    const candidates = Object.keys(sinceMap)
      .map((k) => ({ n: Number(k), since: sinceMap[k] == null ? Infinity : Number(sinceMap[k]) }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => (b.since === a.since ? a.n - b.n : b.since - a.since));
    for (const c of candidates) {
      if (poolSet.size >= POOL_SIZE) break;
      if (!poolSet.has(c.n)) poolSet.add(c.n);
    }
  }

  if (poolSet.size < POOL_SIZE) {
    for (let n = 0; n <= 27 && poolSet.size < POOL_SIZE; n++) {
      if (!poolSet.has(n)) poolSet.add(n);
    }
  }

  return Array.from(poolSet).slice(0, POOL_SIZE);
}

// ---------- Scoring / ranking ----------

export async function scoreAndRank(pool, context = {}) {
  const tb = context.timeBuckets ?? (await timeBucketsSnapshot());
  const runs = context.colorRuns ?? (await recentColorRuns(50));
  const gapsExt = context.gapsExt ?? (await gapStatsExtended(500));
  const ratio = context.ratios ?? (await ratios(200));
  const fourShares = context.fourShares ?? (await getFourClassShares(200));

  const trend = context.trend || null; // pass from analyzer if desired
  const toCluster = trend?.color?.to_cluster; // 'Warm' | 'Cool' | 'Neutral'
  const toSize = trend?.size?.to; // 'small' | 'big'

  // Reactivation context
  const react = context.reactivation || null;
  const reactOk = react && Number(react.similarity) >= 0.75;
  const reactPool = Array.isArray(react?.snapshot_top_pool)
    ? new Set(
        react.snapshot_top_pool
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n >= 0 && n <= 27)
      )
    : new Set();

  const shortColors = tb?.last_10m || {};
  const colorTotals = Object.values(shortColors).reduce((a, b) => a + Number(b || 0), 0) || 1;
  const colorPressure = {};
  for (const [c, v] of Object.entries(shortColors)) {
    const share = Number(v) / colorTotals;
    colorPressure[c] = Math.max(0, 1 - share);
  }

  const sinceMap = gapsExt?.numbers?.since || {};
  const medianMap = Object.fromEntries(
    Object.entries(gapsExt?.numbers?.gaps || {}).map(([k, v]) => [k, Number(v?.median || 0)])
  );

  const streakHead = runs?.[0] || null;
  const streakBreakHint = (() => {
    if (!streakHead) return null;
    if (streakHead.cluster === 'Warm') return 'Cool';
    if (streakHead.cluster === 'Cool') return 'Warm';
    return 'Neutral';
  })();

  const oddPct = Number(ratio?.odd_even?.odd_pct ?? NaN);
  const smallPct = Number(ratio?.small_big?.small_pct ?? NaN);

  // Rebalanced weights to accommodate reactivation boost
  const W = {
    gapPressure: Number(process.env.W_GAP_PRESSURE ?? 0.22),
    streakBreak: Number(process.env.W_STREAK_BREAK ?? 0.18),
    colorBalance: Number(process.env.W_COLOR_BALANCE ?? 0.14),
    parityRotation: Number(process.env.W_PARITY_ROTATION ?? 0.18),
    sizeRegime: Number(process.env.W_SIZE_REGIME ?? 0.18),
    reactivationBoost: Number(process.env.W_REACTIVATION ?? 0.1),
    quadParity: Number(process.env.W_QUAD_PARITY ?? 0.08),
    trendReversal: Number(process.env.W_TREND_REVERSAL ?? 0.06),
  };

  const reactivationGain =
    reactOk && Number.isFinite(Number(react.similarity))
      ? clamp01((Number(react.similarity) - 0.7) / 0.3) // 0 at 0.70, 1 at 1.00
      : 0;

  const scored = pool.map((n) => {
    const k = String(n);
    const col = numToColor(n);
    const qk = quadKey(n); // e.g., "even_small"

    const gapP =
      (sinceMap[k] == null ? 1.0 : Math.min(1, Number(sinceMap[k] || 0) / 30)) +
      Math.min(1, (medianMap[k] || 0) / 15);

    const streakScore = streakBreakHint
      ? (streakBreakHint === 'Cool' &&
          (col === 'Dark Blue' || col === 'Sky Blue' || col === 'Green')) ||
        (streakBreakHint === 'Warm' && (col === 'Red' || col === 'Orange' || col === 'Pink')) ||
        (streakBreakHint === 'Neutral' && col === 'Gray')
        ? 1
        : 0
      : 0;

    const colorBal = Number(colorPressure[col] || 0);
    const parityScore = Number.isFinite(oddPct) ? 1 - Math.abs(oddPct - 50) / 50 : 0.5;
    const sizeScore = Number.isFinite(smallPct) ? 1 - Math.abs(smallPct - 50) / 50 : 0.5;

    const reactScore = reactPool.has(n) ? reactivationGain : 0;

    const target = 0.25;
    const currentShare = clamp01(fourShares?.[qk]);
    const quadScore = Math.max(0, target - currentShare) / target;

    const colorTrendScore = toCluster
      ? (toCluster === 'Warm' && (col === 'Red' || col === 'Orange' || col === 'Pink')) ||
        (toCluster === 'Cool' && (col === 'Dark Blue' || col === 'Sky Blue' || col === 'Green')) ||
        (toCluster === 'Neutral' && col === 'Gray')
        ? 1
        : 0
      : 0;
    const sizeTrendScore = toSize ? (sizeOf(n) === toSize ? 1 : 0) : 0;

    const score =
      W.gapPressure * gapP +
      W.streakBreak * streakScore +
      W.colorBalance * colorBal +
      W.parityRotation * parityScore +
      W.sizeRegime * sizeScore +
      W.reactivationBoost * reactScore +
      W.quadParity * quadScore +
      W.trendReversal * (0.6 * colorTrendScore + 0.4 * sizeTrendScore);

    return { n, score, color: col, parity: parityOf(n), size: sizeOf(n) };
  });

  normalizeWeights(scored, 'score');
  scored.sort((a, b) => b.score - a.score);

  return scored;
}
// ---------- AI Trigger rules ----------

export async function shouldTriggerAI({ windowState, patternState, deviationSignal }) {
  if (!windowState || windowState.status !== 'open') {
    return { trigger: false, reason: 'window_closed_or_missing' };
  }
  if (new Date() < new Date(windowState.first_predict_after)) {
    return { trigger: false, reason: 'before_first_predict_after' };
  }

  if (windowState.id) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM predictions WHERE source='ai' AND window_id=$1`,
      [windowState.id]
    );
    if ((rows[0]?.c || 0) >= AI_MAX_PER_WINDOW) {
      return { trigger: false, reason: 'ai_window_cap' };
    }
  }

  const { rows: todayCount } = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM predictions
      WHERE source = 'ai'
        AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [TZ]
  );
  if ((todayCount[0]?.c || 0) >= AI_MAX_PER_DAY) return { trigger: false, reason: 'ai_daily_cap' };

  const { rows: lastAi } = await pool.query(
    `SELECT created_at
       FROM predictions
      WHERE source = 'ai'
      ORDER BY created_at DESC
      LIMIT 1`
  );
  if (lastAi.length) {
    const deltaH = (Date.now() - new Date(lastAi[0].created_at).getTime()) / 3_600_000;
    if (deltaH < AI_MIN_GAP_HOURS) return { trigger: false, reason: 'ai_gap_limit' };
  }

  if (deviationSignal === true) return { trigger: true, reason: 'sudden_deviation' };
  if (patternState?.wrong_streak >= PAUSE_AFTER_WRONGS)
    return { trigger: true, reason: 'wrong_streak_3plus' };
  if (!patternState?.pattern_code || patternState?.pattern_code === 'Unknown')
    return { trigger: true, reason: 'unknown_pattern' };

  return { trigger: false, reason: 'local_sufficient' };
}

// ---------- Main: produce local prediction (no AI) ----------

export async function localPredict({ windowId, context = {} }) {
  const gate = await canPredict(windowId);
  if (!gate.can) return { allowed: false, reason: gate.reason, until: gate.until };

  const seq = context.seq ?? (await getLastResults(30));
  const last = seq.at(-1);

  const { pattern_code, scores } = await identifyActivePattern(context);

  const pool = await buildNumberPool({ last, pattern_code, context });
  const ranked = await scoreAndRank(pool, context);

  const top3 = ranked.slice(0, 3).map((r) => r.n);

  return {
    allowed: true,
    pattern_code,
    pattern_scores: scores,
    last,
    pool,
    ranked,
    top3,
  };
}

// ---------- Feedback hooks ----------

export async function onOutcome({ windowId, predictedTop3, actual }) {
  const correct = Array.isArray(predictedTop3) && predictedTop3.includes(Number(actual));

  const ps = await getOrCreatePatternState(windowId);
  const updated = await updateStreak(windowId, { correct });

  if (updated?.wrong_streak >= PAUSE_AFTER_WRONGS) {
    await pausePattern(windowId, WRONG_PAUSE_MIN);
  }

  return { correct, state: updated || ps };
}
