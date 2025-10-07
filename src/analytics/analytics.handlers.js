import { pool } from '../config/db.config.js';
import { applyAdvancedAnalyticsSchema } from './analytics.migrations.js';

const nn = (j) => j ?? {};
const isPosInt = (n) => Number.isFinite(n) && n > 0 && Math.floor(n) === n;
const sanitizeLookback = (n, def = 200) => (isPosInt(n) ? n : def);
const sanitizeK = (k, def = 5) => (Number.isFinite(k) && k >= 1 && k <= 27 ? Math.floor(k) : def);

export async function getLatestAnchorImageId() {
  const { rows } = await pool.query(
    `SELECT image_id
       FROM v_spins
      ORDER BY screen_shot_time DESC
      LIMIT 1`
  );
  return rows[0]?.image_id ?? null;
}

export async function ensureAnchorExists(anchorId) {
  if (!Number.isFinite(anchorId)) return null;
  const { rows } = await pool.query(`SELECT 1 FROM v_spins WHERE image_id = $1 LIMIT 1`, [
    anchorId,
  ]);
  return rows.length ? anchorId : null;
}

export async function colorFreq(anchorId, lookback) {
  lookback = sanitizeLookback(lookback);
  const { rows } = await pool.query(`SELECT fn_color_freq_json($1,$2) AS stats`, [
    anchorId,
    lookback,
  ]);
  return nn(rows[0]?.stats);
}

export async function parityFreq(anchorId, lookback) {
  lookback = sanitizeLookback(lookback);
  const { rows } = await pool.query(`SELECT fn_parity_freq_json($1,$2) AS stats`, [
    anchorId,
    lookback,
  ]);
  return nn(rows[0]?.stats);
}

export async function sizeParityFreq(anchorId, lookback) {
  lookback = sanitizeLookback(lookback);
  const { rows } = await pool.query(`SELECT fn_size_parity_freq_json($1,$2) AS stats`, [
    anchorId,
    lookback,
  ]);
  return nn(rows[0]?.stats);
}

export async function lastDigitFreq(anchorId, lookback) {
  lookback = sanitizeLookback(lookback);
  const { rows } = await pool.query(`SELECT fn_last_digit_freq_json($1,$2) AS stats`, [
    anchorId,
    lookback,
  ]);
  return nn(rows[0]?.stats);
}

export async function hotCold(anchorId, lookback, k = 5) {
  lookback = sanitizeLookback(lookback);
  k = sanitizeK(k);
  const { rows } = await pool.query(`SELECT fn_hot_cold_numbers_json($1,$2,$3) AS stats`, [
    anchorId,
    lookback,
    k,
  ]);
  return nn(rows[0]?.stats);
}

export async function allStatsBundle(anchorId, lookback, k = 5) {
  lookback = sanitizeLookback(lookback);
  k = sanitizeK(k);

  const verifiedAnchor = await ensureAnchorExists(anchorId);
  if (verifiedAnchor == null) {
    return {
      anchor_image_id: null,
      lookback,
      color: {},
      parity: {},
      size_parity: {},
      last_digit: {},
      hot_cold: {},
    };
  }

  const [color, parity, sizeParity, lastDigit, hotcold] = await Promise.all([
    colorFreq(verifiedAnchor, lookback),
    parityFreq(verifiedAnchor, lookback),
    sizeParityFreq(verifiedAnchor, lookback),
    lastDigitFreq(verifiedAnchor, lookback),
    hotCold(verifiedAnchor, lookback, k),
  ]);

  return {
    anchor_image_id: verifiedAnchor,
    lookback,
    color,
    parity,
    size_parity: sizeParity,
    last_digit: lastDigit,
    hot_cold: hotcold,
  };
}

export async function allStatsForLatestAnchor(lookback, k = 5) {
  const anchorId = await getLatestAnchorImageId();
  if (anchorId == null) {
    return {
      anchor_image_id: null,
      lookback: sanitizeLookback(lookback),
      color: {},
      parity: {},
      size_parity: {},
      last_digit: {},
      hot_cold: {},
    };
  }
  return allStatsBundle(anchorId, lookback, k);
}

export async function windowsSummary(limitSeq = 200) {
  const totalsQ = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
      FROM v_spins
     GROUP BY result
     ORDER BY result
  `);

  const last200Q = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
      FROM (SELECT result FROM v_spins ORDER BY screen_shot_time DESC LIMIT 200) x
     GROUP BY result
  `);

  const last100Q = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
      FROM (SELECT result FROM v_spins ORDER BY screen_shot_time DESC LIMIT 100) x
     GROUP BY result
  `);

  const last20Q = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
      FROM (SELECT result FROM v_spins ORDER BY screen_shot_time DESC LIMIT 20) x
     GROUP BY result
  `);

  const seqQ = await pool.query(
    `
    SELECT result
      FROM v_spins
     ORDER BY screen_shot_time DESC
     LIMIT $1
    `,
    [isPosInt(limitSeq) ? limitSeq : 200]
  );

  const mapify = (rows) => Object.fromEntries(rows.map((r) => [String(r.result), Number(r.freq)]));

  return {
    totals: mapify(totalsQ.rows),
    last_200: mapify(last200Q.rows),
    last_100: mapify(last100Q.rows),
    last_20: mapify(last20Q.rows),
    last_200_seq: seqQ.rows.map((r) => Number(r.result)).reverse(),
  };
}

export async function gapStats(lookback = 500) {
  const { rows } = await pool.query('SELECT fn_gap_stats_json($1) AS j', [lookback]);
  const j = rows[0]?.j || { lookback, numbers: {}, colors: {} };
  const unseen = (v) => (v == null ? null : v > lookback ? null : v);
  if (j?.numbers) {
    for (const k of Object.keys(j.numbers)) j.numbers[k] = unseen(Number(j.numbers[k]));
  }
  if (j?.colors) {
    for (const k of Object.keys(j.colors)) j.colors[k] = unseen(Number(j.colors[k]));
  }
  j.unseen_policy = 'null_means_unseen';
  return j;
}

export async function ratios(lookback = 50) {
  const { rows } = await pool.query('SELECT fn_ratios_json($1) AS j', [lookback]);
  return rows[0]?.j || { lookback };
}

export async function numberPatterns(lookback = 200) {
  const { rows } = await pool.query('SELECT fn_number_patterns_json($1) AS j', [lookback]);
  return rows[0]?.j || { lookback };
}

export async function recentColorRuns(limit = 50) {
  try {
    const { rows } = await pool.query(
      `SELECT run_id::text, start_time, end_time, run_length, color, cluster
         FROM mv_color_runs
        ORDER BY start_time DESC
        LIMIT $1`,
      [limit]
    );
    return rows || [];
  } catch {
    return [];
  }
}

export async function fetchRecentSpins(limit = 30) {
  const { rows } = await pool.query(
    `SELECT result, result_color, result_parity, result_size, screen_shot_time
       FROM v_spins
      ORDER BY screen_shot_time DESC
      LIMIT $1`,
    [limit]
  );
  return rows || [];
}

export async function timeBucketsSnapshot() {
  const q = `
    WITH nowts AS (SELECT now() AS t),
    last_60 AS (
      SELECT result_color, COUNT(*) AS c
      FROM v_spins_buckets, nowts
      WHERE screen_shot_time >= (t - interval '60 minutes')
      GROUP BY result_color
    ),
    last_30 AS (
      SELECT result_color, COUNT(*) AS c
      FROM v_spins_buckets, nowts
      WHERE screen_shot_time >= (t - interval '30 minutes')
      GROUP BY result_color
    ),
    last_10 AS (
      SELECT result_color, COUNT(*) AS c
      FROM v_spins_buckets, nowts
      WHERE screen_shot_time >= (t - interval '10 minutes')
      GROUP BY result_color
    ),
    daypart AS (
      SELECT daypart, result_color, COUNT(*) AS c
      FROM v_spins_buckets
      WHERE screen_shot_time >= now() - interval '24 hours'
      GROUP BY daypart, result_color
    )
    SELECT
      COALESCE((SELECT jsonb_object_agg(result_color, c) FROM last_60), '{}'::jsonb) AS last_60m,
      COALESCE((SELECT jsonb_object_agg(result_color, c) FROM last_30), '{}'::jsonb) AS last_30m,
      COALESCE((SELECT jsonb_object_agg(result_color, c) FROM last_10), '{}'::jsonb) AS last_10m,
      COALESCE((
        SELECT jsonb_object_agg(daypart, innerj) FROM (
          SELECT daypart, jsonb_object_agg(result_color, c) AS innerj
          FROM daypart GROUP BY daypart
        ) z
      ), '{}'::jsonb) AS daypart_24h
  `;
  const { rows } = await pool.query(q);
  return rows[0] || { last_60m: {}, last_30m: {}, last_10m: {}, daypart_24h: {} };
}

export async function rangeSystemsTags() {
  const { rows } = await pool.query(
    `SELECT n, fn_number_tags_json(n)::jsonb AS tags
       FROM generate_series(0,27) AS n`
  );
  const obj = {};
  for (const r of rows) obj[String(r.n)] = r.tags;
  return obj;
}

const lastDigit = (n) => Math.abs(Number(n)) % 10;
const digitsSum = (n) =>
  String(Math.abs(Number(n)))
    .split('')
    .reduce((a, b) => a + Number(b), 0);
const norm0_27 = (x) => {
  const m = 28;
  const r = ((x % m) + m) % m;
  return r;
};

export function computeNumberRulesFromSeq(seq /* ascending time */) {
  const out = { single: {}, double: {}, multi: {}, mixing: {} };

  const latest = seq.at(-1);
  const prev = seq.at(-2);

  if (Number.isFinite(latest)) {
    const ld = lastDigit(latest);
    const ds = digitsSum(latest);
    out.single = {
      last_digit: ld,
      digits_sum: norm0_27(ds),
      num_plus_last: norm0_27(latest + ld),
      num_minus_last: norm0_27(latest - ld),
    };
  }

  if (Number.isFinite(latest) && Number.isFinite(prev)) {
    const a = prev,
      b = latest,
      lda = lastDigit(a),
      ldb = lastDigit(b);
    out.double = {
      last_digits_sum: norm0_27(lda + ldb),
      last_digits_diff: norm0_27(ldb - lda),
      last_digits_mul: norm0_27(lda * ldb),
      firstLD_plus_second: norm0_27(lda + b),
      secondLD_plus_first: norm0_27(ldb + a),
      sumLD_add_into_one: norm0_27(b + (lda + ldb)),
    };
  }

  if (seq.length >= 3) {
    const last3 = seq.slice(-3);
    const last5 = seq.slice(-5);
    const last10 = seq.slice(-10);
    const last3_ld_sum = norm0_27(last3.reduce((s, n) => s + lastDigit(n), 0));

    let last5_mix = 0;
    for (let i = 0; i < last5.length; i++) {
      const pos = i + 1;
      const v = last5[i];
      last5_mix = pos % 2 === 1 ? last5_mix + v : last5_mix - v;
    }
    const last10_dsum_norm = norm0_27(last10.reduce((s, n) => s + digitsSum(n), 0));

    out.multi = {
      last3_last_digits_sum: last3_ld_sum,
      last5_pos_mix: norm0_27(last5_mix),
      last10_digits_sum_norm: last10_dsum_norm,
      same_color_only_calc: null,
      range_filtered_calc: null,
    };
  }

  if (Number.isFinite(latest)) {
    const ld = lastDigit(latest);
    out.mixing = {
      mode: ld % 2 === 0 ? 'addition' : 'subtraction',
      same_color_repeat3_plus: null,
      same_cluster_repeat3_plus: null,
      range_mode: latest <= 13 ? 'addition' : 'subtraction',
    };
  }

  return out;
}

export function computeColorBehaviour(colorRuns) {
  const classify = (len) =>
    len >= 10 ? 'super' : len >= 4 ? 'long' : len >= 2 ? 'short' : 'single';
  const runs = (colorRuns || []).map((r) => ({
    color: r.color,
    cluster: r.cluster,
    run_length: Number(r.run_length),
    class: classify(Number(r.run_length)),
    start_time: r.start_time,
    end_time: r.end_time,
  }));
  const head = runs[0];
  let break_hint = null;
  if (head) {
    if (head.cluster === 'Warm') break_hint = 'shift_to_cool_or_neutral';
    else if (head.cluster === 'Cool') break_hint = 'shift_to_warm_or_neutral';
    else break_hint = 'neutral_break_possible';
  }
  return { runs, break_hint };
}

function computeMultiRuleExtras(recentAsc) {
  if (!Array.isArray(recentAsc) || !recentAsc.length) {
    return { same_color_only_calc: null, range_filtered_calc: { low: null, high: null } };
  }

  const headColor = recentAsc.at(-1)?.result_color || null;
  const sameColorSeq = headColor
    ? recentAsc.filter((r) => r.result_color === headColor).map((r) => Number(r.result))
    : [];
  let sameColorCalc = null;
  if (sameColorSeq.length >= 3) {
    const tail3 = sameColorSeq.slice(-3);
    sameColorCalc = norm0_27(tail3.reduce((s, n) => s + lastDigit(n), 0));
  }

  const lowSeq = recentAsc.filter((r) => Number(r.result) <= 13).map((r) => Number(r.result));
  const highSeq = recentAsc.filter((r) => Number(r.result) >= 14).map((r) => Number(r.result));

  const posMix = (arr) => {
    const last5 = arr.slice(-5);
    let mix = 0;
    for (let i = 0; i < last5.length; i++) {
      const pos = i + 1;
      mix = pos % 2 === 1 ? mix + last5[i] : mix - last5[i];
    }
    return last5.length ? norm0_27(mix) : null;
  };

  return {
    same_color_only_calc: sameColorCalc,
    range_filtered_calc: {
      low: posMix(lowSeq),
      high: posMix(highSeq),
    },
  };
}

export async function buildFourteenSystems() {
  const recentDesc = await fetchRecentSpins(30);
  const recentAsc = [...recentDesc].reverse();
  const seq = recentAsc.map((r) => Number(r.result));

  const number_rules = computeNumberRulesFromSeq(seq);

  const multiExtras = computeMultiRuleExtras(recentAsc);
  number_rules.multi.same_color_only_calc = multiExtras.same_color_only_calc;
  number_rules.multi.range_filtered_calc = multiExtras.range_filtered_calc;

  const range_systems = await rangeSystemsTags();
  const runs = await recentColorRuns(50);
  const color_behaviour = computeColorBehaviour(runs);
  const time_buckets = await timeBucketsSnapshot();

  return { number_rules, range_systems, color_behaviour, time_buckets };
}

export async function refreshAnalyticsMaterializedViews() {
  try {
    await pool.query('SELECT refresh_mv_color_runs()');
  } catch {}
  try {
    await pool.query('SELECT refresh_mv_accuracy_hourly()');
  } catch {}
  try {
    await pool.query('SELECT refresh_mv_accuracy_breakdown()');
  } catch {}
}

export async function advancedAnalyticsBundle(anchorImageId, opts = {}) {
  const lookback = Number(opts.lookback || process.env.PRED_LOOKBACK || 200);
  const k = Number(opts.topk || process.env.PRED_TOPK || 5);

  try {
    await refreshAnalyticsMaterializedViews();
  } catch (e) {
    console.error(e);
  }

  const lookbacks = Array.isArray(opts.lookback) ? opts.lookback : [opts.lookback];
  const winset = [
    ...new Set(
      lookbacks
        .map((x) => (typeof x === 'number' ? x : null))
        .filter((x) => Number.isFinite(x))
        .concat([20, 100, 200]) // ensure legacy windows exist
    ),
  ].filter(Boolean);

  const [winMulti, coreStats, gaps, gapsExt, ratio, patterns, runs, fourteen] = await Promise.all([
    windowsSummaryMulti(winset),
    allStatsBundle(anchorImageId, lookback, k),
    gapStats(Math.max(lookback, 500)),
    gapStatsExtended(Math.max(lookback, 500)),
    ratios(Math.min(lookback, 200)),
    numberPatterns(lookback),
    recentColorRuns(50),
    buildFourteenSystems(),
  ]);

  const windows = {
    totals: winMulti.totals,
    last_20: winMulti.windows_multi['20'] || {},
    last_100: winMulti.windows_multi['100'] || {},
    last_200: winMulti.windows_multi['200'] || {},
    last_200_seq: (winMulti.last_seq_window === 200 ? winMulti.last_seq : undefined) || [],
    windows_multi: winMulti.windows_multi,
    last_seq_window: winMulti.last_seq_window,
    last_seq: winMulti.last_seq,
  };

  const weights = { last_20: 0.5, last_100: 0.3, last_200: 0.15, totals: 0.05 };

  return {
    lookback,
    topk: k,
    weights,
    windows,
    coreStats,
    gaps,
    gaps_extended: gapsExt,
    ratios: ratio,
    patterns,
    color_runs: runs,
    number_rules: fourteen.number_rules,
    range_systems: fourteen.range_systems,
    color_behaviour: fourteen.color_behaviour,
    time_buckets: fourteen.time_buckets,
  };
}

export async function runAnalyticsMigrations() {
  await applyAdvancedAnalyticsSchema();
}

export async function predictionLogsSummary({ limit = 200, k = 10 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT id, created_at, predicted_numbers, confidence, correct
      FROM prediction_logs
     ORDER BY created_at DESC
     LIMIT $1
    `,
    [Math.max(10, Math.min(1000, Number(limit) || 200))]
  );

  const out = {
    total: 0,
    correct: 0,
    incorrect: 0,
    accuracy_pct: null,
    avg_confidence: null,
    current_streak: { type: null, length: 0 },
    top_predicted_hist: {},
    last_k_preview: [],
  };

  if (!rows.length) return out;

  out.total = rows.length;
  for (const r of rows) {
    if (r.correct === true) out.correct++;
    else if (r.correct === false) out.incorrect++;

    if (Array.isArray(r.predicted_numbers)) {
      for (const n of r.predicted_numbers) {
        const k = String(Number(n));
        out.top_predicted_hist[k] = (out.top_predicted_hist[k] || 0) + 1;
      }
    }
  }

  if (out.total > 0) {
    out.accuracy_pct = Number(((out.correct / out.total) * 100).toFixed(2));
  }

  const confs = rows
    .map((r) => (Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null))
    .filter((x) => x != null);
  if (confs.length) {
    out.avg_confidence = Number((confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(4));
  }

  let streakType = null;
  let streakLen = 0;
  for (const r of rows) {
    if (r.correct === true) {
      if (streakType == null || streakType === 'correct') {
        streakType = 'correct';
        streakLen++;
      } else break;
    } else if (r.correct === false) {
      if (streakType == null || streakType === 'wrong') {
        streakType = 'wrong';
        streakLen++;
      } else break;
    } else {
      break;
    }
  }
  out.current_streak = { type: streakType, length: streakLen };

  out.last_k_preview = rows.slice(0, Math.max(1, k)).map((r) => ({
    id: r.id,
    ts: r.created_at,
    preds: r.predicted_numbers,
    conf: r.confidence,
    correct: r.correct,
  }));

  return out;
}

async function _detectPredictionLogCols(pool) {
  const { rows } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'prediction_logs'
  `);
  const cols = new Set(rows.map((r) => r.column_name));

  const pick = (...names) => names.find((n) => cols.has(n)) || null;

  const colImage = pick('based_on_image_id', 'image_id');
  const colPred = pick('predicted_next', 'predicted', 'prediction', 'predicted_num');
  const colTop = pick('top_result', 'actual_result', 'result');
  const colProb = pick('top_probability', 'probability', 'confidence');
  const colTs = pick('created_at', 'inserted_at', 'createdon');

  const missing = [];
  if (!colImage) missing.push('based_on_image_id');
  if (!colPred) missing.push('predicted_next');
  if (!colTop) missing.push('top_result');
  if (!colProb) missing.push('top_probability');
  if (!colTs) missing.push('created_at');
  if (missing.length) {
    const have = [...cols].sort().join(', ');
    throw new Error(
      `prediction_logs incompatible: missing ${missing.join(', ')}; existing: ${have}`
    );
  }
  return { colImage, colPred, colTop, colProb, colTs };
}

export async function recentPredictionLogsRaw({ limit = 25 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT id, created_at, based_on_image_id, predicted_numbers,
           predicted_color, predicted_parity, predicted_size,
           confidence, actual_result, correct
      FROM prediction_logs
     ORDER BY created_at DESC
     LIMIT $1
    `,
    [Math.max(5, Math.min(100, Number(limit) || 25))]
  );
  return rows || [];
}

// ADD THIS NEW HELPER (below windowsSummary or anywhere in handlers)
export async function windowsSummaryMulti(winset = [20, 100, 200, 1000]) {
  // sanitize + sort + unique
  const wins = [
    ...new Set(
      (Array.isArray(winset) ? winset : [20, 100, 200])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 20 && n <= 5000)
    ),
  ].sort((a, b) => a - b);

  const totalsQ = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
      FROM v_spins
     GROUP BY result
     ORDER BY result
  `);

  // run all windows in parallel
  const perWindow = await Promise.all(
    wins.map(async (W) => {
      const q = await pool.query(
        `
        SELECT result, COUNT(*)::int AS freq
          FROM (SELECT result FROM v_spins ORDER BY screen_shot_time DESC LIMIT $1) x
         GROUP BY result
         ORDER BY result
      `,
        [W]
      );
      return [W, q.rows];
    })
  );

  const maxW = wins[wins.length - 1] || 200;
  const seqQ = await pool.query(
    `
    SELECT result
      FROM v_spins
     ORDER BY screen_shot_time DESC
     LIMIT $1
  `,
    [maxW]
  );

  const mapify = (rows) => Object.fromEntries(rows.map((r) => [String(r.result), Number(r.freq)]));

  const windows_multi = {};
  for (const [W, rows] of perWindow) windows_multi[String(W)] = mapify(rows);

  return {
    totals: mapify(totalsQ.rows),
    windows_multi,
    last_seq_window: maxW,
    last_seq: seqQ.rows.map((r) => Number(r.result)).reverse(),
  };
}

export async function gapStatsExtended(lookback = 500) {
  const { rows } = await pool.query('SELECT fn_gap_stats_ext_json($1) AS j', [lookback]);
  const j = rows[0]?.j || { lookback, numbers: {}, colors: {} };

  const unseen = (v) => (v == null ? null : v > lookback ? null : v);
  if (j?.numbers?.since) {
    for (const k of Object.keys(j.numbers.since)) {
      j.numbers.since[k] = unseen(Number(j.numbers.since[k]));
    }
  }
  if (j?.colors?.since) {
    for (const k of Object.keys(j.colors.since)) {
      j.colors.since[k] = unseen(Number(j.colors.since[k]));
    }
  }
  j.unseen_policy = 'null_means_unseen';
  return j;
}

export default {
  getLatestAnchorImageId,
  ensureAnchorExists,
  colorFreq,
  parityFreq,
  sizeParityFreq,
  lastDigitFreq,
  hotCold,
  allStatsBundle,
  allStatsForLatestAnchor,
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
  refreshAnalyticsMaterializedViews,
  runAnalyticsMigrations,
  predictionLogsSummary,
  _detectPredictionLogCols,
  recentPredictionLogsRaw,
};
