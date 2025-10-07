import OpenAI from 'openai';
import { pool } from '../config/db.config.js';

import {
  latestUnprocessedImages,
  hasStatsForImage,
  insertImageStats,
} from '../models/stats.model.js';

import { parseGameScreenshot } from './image-info-extract.service.js';

import {
  advancedAnalyticsBundle,
  predictionLogsSummary,
  recentPredictionLogsRaw,
} from '../analytics/analytics.handlers.js';

import {
  insertPredictionLog,
  completeLatestPendingWithActual,
} from '../models/prediction-logs.model.js';
import { pushAnalytics } from '../analytics/analytics.ws.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LOOKBACK = Number(process.env.PRED_LOOKBACK || 200);
const HOTCOLD_K = Number(process.env.PRED_TOPK || 5);
const MODEL = process.env.PRED_MODEL || 'gpt-4.1-mini';
const IS_GPT5 = (MODEL || '').toLowerCase().startsWith('gpt-5');
const TEMP = IS_GPT5
  ? 0
  : Number.isFinite(Number(process.env.PRED_TEMPERATURE))
    ? Number(process.env.PRED_TEMPERATURE)
    : 0.7;

const PRED_MIN_SECONDS = Number(process.env.PRED_MIN_SECONDS || 40);

const COLOR_MAP = {
  Red: [0, 1, 26, 27],
  Orange: [2, 3, 24, 25],
  Pink: [4, 5, 22, 23],
  'Dark Blue': [6, 7, 20, 21],
  'Sky Blue': [8, 9, 18, 19],
  Green: [10, 11, 16, 17],
  Gray: [12, 13, 14, 15],
};
const numToColor = (n) => {
  n = Number(n);
  for (const [c, arr] of Object.entries(COLOR_MAP)) if (arr.includes(n)) return c;
  return null;
};
const parityOf = (n) => (Number(n) % 2 === 0 ? 'even' : 'odd');
const sizeOf = (n) => (Number(n) >= 0 && Number(n) <= 13 ? 'small' : 'big');

function argmaxKeyed(dist) {
  let bestK = '0';
  let bestP = -1;
  for (let i = 0; i <= 27; i++) {
    const k = String(i);
    const p = Number(dist[k] || 0);
    if (p > bestP) {
      bestP = p;
      bestK = k;
    }
  }
  return { result: Number(bestK), prob: bestP };
}
async function latestPredictionTime() {
  const { rows } = await pool.query(`
    SELECT created_at
      FROM predictions
  ORDER BY created_at DESC
     LIMIT 1
  `);
  return rows[0]?.created_at ? new Date(rows[0].created_at) : null;
}

/** ==== NEW: BASELINE PRIOR (100% tumhara data use) ==== */
/**
 * windows/gaps/gaps_ext/ratios/color_runs/time_buckets ko mila ke 0..27 prior banao
 * Tunables: weights, boosts
 */
// UPDATE your buildBaselinePrior to read windows.windows_multi when present
function buildBaselinePrior(bundle, cfg = {}) {
  const {
    w20 = 0.5,
    w100 = 0.25,
    w200 = 0.1,
    w1000 = 0.05,
    wtot = 0.1,
    gapBoost = 0.2,
    streakBoost = 0.1,
    colorReweight = 0.1,
  } = cfg;

  const N = 28;
  const W = bundle.windows || {};
  const WM = W.windows_multi || {};
  const f = (map, i) => Number(map?.[String(i)] || 0);

  const freq20 = WM['20'] || W.last_20 || {};
  const freq100 = WM['100'] || W.last_100 || {};
  const freq200 = WM['200'] || W.last_200 || {};
  const freq1000 = WM['1000'] || {};
  const totals = W.totals || {};

  const freq = Array.from(
    { length: N },
    (_, i) =>
      w20 * f(freq20, i) +
      w100 * f(freq100, i) +
      w200 * f(freq200, i) +
      w1000 * f(freq1000, i) +
      wtot * f(totals, i)
  );

  const maxF = Math.max(...freq, 1);
  let s = freq.map((x) => x / maxF);

  const sinceMap = bundle.gaps_extended?.numbers?.since || bundle.gaps?.numbers || {};
  const lookback = Number(bundle.gaps_extended?.lookback || bundle.gaps?.lookback || 500);
  for (let i = 0; i < N; i++) {
    const k = String(i);
    const since = Number(sinceMap[k] ?? 0);
    const r = Math.max(0, Math.min(1, since / lookback));
    s[i] *= 1 + gapBoost * r;
  }

  const breakHint = bundle.color_behaviour?.break_hint;
  if (breakHint) {
    const target = breakHint.includes('cool')
      ? 'Cool'
      : breakHint.includes('warm')
        ? 'Warm'
        : 'Neutral';
    for (let i = 0; i < N; i++) {
      const c = numToColor(i);
      if (!c) continue;
      const isCool = c === 'Dark Blue' || c === 'Sky Blue' || c === 'Green';
      const isWarm = c === 'Red' || c === 'Orange' || c === 'Pink';
      const isNeutral = c === 'Gray';
      if (
        (target === 'Cool' && isCool) ||
        (target === 'Warm' && isWarm) ||
        (target === 'Neutral' && isNeutral)
      ) {
        s[i] *= 1 + streakBoost;
      }
    }
  }

  // optional: color marginals reweight (if available)
  const desiredColor = bundle.ratios?.color || null;
  if (desiredColor) {
    const cur = {};
    for (let i = 0; i < N; i++) {
      const c = numToColor(i);
      cur[c] = (cur[c] || 0) + s[i];
    }
    const totalS = s.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < N; i++) {
      const c = numToColor(i);
      if (!c) continue;
      const target = Number(desiredColor[c] || 0);
      const have = (cur[c] || 0) / totalS;
      const delta = colorReweight * (target - have);
      s[i] *= Math.max(1e-9, 1 + delta);
    }
  }

  // normalize to prob
  const Z = s.reduce((a, b) => a + b, 0) || 1;
  const prior = {};
  for (let i = 0; i < N; i++) prior[String(i)] = s[i] / Z;
  return prior;
}

/** ==== NEW: LLM combination helpers ==== */
function combinePrior(prior, mults, { tau = 1.05, eps = 0.01 } = {}) {
  // multiplier bounds: 0.6..1.6 (hard guardrails)
  const out = {};
  let Z = 0;
  for (let i = 0; i <= 27; i++) {
    const k = String(i);
    const p = Math.max(1e-12, Number(prior[k] || 0));
    let m = Number(mults?.[k]);
    if (!Number.isFinite(m)) m = 1.0;
    m = Math.max(0.6, Math.min(1.6, m));
    out[k] = Math.pow(p * m, 1 / tau);
    Z += out[k];
  }
  // epsilon exploration → avoid collapse
  const u = 1 / 28;
  for (let i = 0; i <= 27; i++) {
    const k = String(i);
    out[k] = (1 - eps) * (out[k] / Z) + eps * u;
  }
  return out;
}

function entropy(dist) {
  let H = 0;
  for (let i = 0; i <= 27; i++) {
    const p = Math.max(1e-12, Number(dist[String(i)] || 0));
    H += -p * Math.log(p);
  }
  return H;
}

// anti-repeat: recent top results ko halka penalize
function penalizeRecent(dist, recentTop = [], alpha = 0.1) {
  const tmp = {};
  let Z = 0;
  const penalties = new Map();
  recentTop.forEach((n, idx) => {
    const w = (alpha * (recentTop.length - idx)) / Math.max(1, recentTop.length);
    penalties.set(String(n), (penalties.get(String(n)) || 0) + w);
  });
  for (let i = 0; i <= 27; i++) {
    const k = String(i);
    const p = Math.max(0, Number(dist[k] || 0));
    const f = Math.max(1e-9, 1 - (penalties.get(k) || 0));
    tmp[k] = p * f;
    Z += tmp[k];
  }
  const out = {};
  for (let i = 0; i <= 27; i++) out[String(i)] = tmp[String(i)] / (Z || 1);
  return out;
}

/** ==== DIGIT SHUFFLE (as-is from your version) ==== */
function digitShuffleSummary(latest) {
  const out = { category: null, sum_0_27: null, color: null, digits: [] };
  const d = (Array.isArray(latest?.numbers) ? latest.numbers : []).map((n) => Number(n));
  if (d.length !== 3 || d.some((x) => !Number.isFinite(x))) return out;

  const [a, b, c] = d.map((x) => Math.abs(x) % 10);
  out.digits = [a, b, c];

  const sum = a + b + c;
  out.sum_0_27 = sum;

  if (a === b && b === c) out.category = 'all_same';
  else if (a === c && a !== b) out.category = 'palindrome';
  else if ((a === b && b !== c) || (a === c && b !== c) || (b === c && a !== b))
    out.category = 'two_same_one_diff';
  else if ((a + 1) % 10 === b % 10 && (b + 1) % 10 === c % 10) out.category = 'sequence';
  else if ((a === 8 && b === 9 && c === 0) || (a === 9 && b === 0 && c === 1))
    out.category = 'wrap_around';
  else out.category = 'all_diff';

  out.color = numToColor(out.sum_0_27);
  return out;
}

/** ================== MAIN LOOP (HYBRID PRIOR + LLM MULTIPLIERS) ================== */
export async function analyzeLatestUnprocessed(limit = 3, logger = console) {
  logger.log?.('[PRED CFG]', { MODEL, TEMP, LOOKBACK, HOTCOLD_K, PRED_MIN_SECONDS });

  const ids = await latestUnprocessedImages(limit);
  if (!ids.length) {
    logger.log?.('[Analyzer] No new images to process.');
    return null;
  }

  let lastResult = null;

  for (const imageId of ids) {
    try {
      if (await hasStatsForImage(imageId)) continue;

      const lastPredAt = await latestPredictionTime();
      if (lastPredAt) {
        const elapsedSec = (Date.now() - lastPredAt.getTime()) / 1000;
        if (elapsedSec < PRED_MIN_SECONDS) {
          logger.log?.(
            `[Analyzer] Throttled (${elapsedSec.toFixed(1)}s < ${PRED_MIN_SECONDS}s) — skipping image=${imageId}`
          );
          continue;
        }
      }

      // 1) Parse image → stats row
      let parsed;
      try {
        parsed = await parseGameScreenshot(imageId);
      } catch (e) {
        logger.error?.(`[Analyzer] image=${imageId} parse failed, skipping: ${e?.message || e}`);
        continue;
      }
      const resultNum = Number(parsed?.result);
      if (!Number.isFinite(resultNum)) {
        logger.warn?.(`[Analyzer] invalid result for image=${imageId}:`, parsed?.result);
        continue;
      }
      await insertImageStats({ imageId, numbers: parsed?.numbers, result: resultNum });

      // 2) Complete last pending log with actual
      try {
        const actualNumber = Number(parsed?.result);
        if (Number.isFinite(actualNumber)) {
          await completeLatestPendingWithActual({
            actualNumber,
            actualColor: numToColor(actualNumber),
            actualParity: parityOf(actualNumber),
            actualSize: sizeOf(actualNumber),
          });
        }
      } catch (e) {
        logger.error?.('[Analyzer] completeLatestPendingWithActual failed:', e?.message || e);
      }

      // 3) Skip if prediction already exists for this image
      const { rows: predCheck } = await pool.query(
        `SELECT 1 FROM predictions WHERE based_on_image_id = $1 LIMIT 1`,
        [imageId]
      );
      if (predCheck.length) {
        logger.log?.(
          `[Analyzer] prediction already exists for image=${imageId}, skipping OpenAI call`
        );
        continue;
      }

      // 4) Build analytics bundle
      const bundle = await advancedAnalyticsBundle(imageId, {
        lookback: [200, 1000, 2000],
        topk: HOTCOLD_K,
      });

      // 5) Build deterministic baseline prior (OUR prediction first)
      const baseline_prior = buildBaselinePrior(bundle);

      const digit_shuffle = digitShuffleSummary(parsed);
      const logs_feedback = await predictionLogsSummary({ limit: 200 });
      const logs_tail = await recentPredictionLogsRaw({ limit: 15 });

      // extract recent top guesses (approx): first element from predicted_numbers
      const recentTop = (logs_tail || [])
        .map((r) => (Array.isArray(r.predicted_numbers) ? Number(r.predicted_numbers?.[0]) : null))
        .filter((n) => Number.isFinite(n))
        .slice(0, 5);

      /** 6) Prompt: ask ONLY for odds_multipliers (bounded) */
      const instruction = `
You adjust a BASELINE probability prior over results 0..27 for the Chamet Spin game.

INPUTS:
- baseline_prior: starting probabilities for each result "0".."27". Treat this as the ground truth base.
- analytics_bundle: aggregates (windows, gaps, gaps_extended, ratios, color_runs, number_rules A-D, range_systems, time_buckets).
- latest (parsed image) + digit_shuffle (A/B/C sequence info).
- logs_feedback + logs_tail (recent performance).

TASK:
1) Output odds_multipliers for each result 0..27 to modify the baseline_prior. Stay within bounds:
   0.6 ≤ multiplier ≤ 1.6
   Use strong evidence only (overdue/gaps, streak breaks, short-window frequency spikes, patterns A-D, daypart effects).
2) Keep mass reasonably distributed; avoid collapse unless evidence is overwhelming.
3) Return STRICT JSON:
{
  "odds_multipliers": { "0": m0, ..., "27": m27 },
  "pattern_detected": true|false,
  "pattern_type": "<short>",
  "pattern_description": "<one line>",
  "rationale": "<one line>"
}`.trim();

      const payload = {
        baseline_prior,
        bundle,
        latest: parsed,
        digit_shuffle,
        logs_feedback,
        logs_tail,
        schema_hint: {
          version: 'v9',
          out_keys: [
            'odds_multipliers',
            'pattern_detected',
            'pattern_type',
            'pattern_description',
            'rationale',
          ],
        },
      };

      const req = IS_GPT5
        ? {
            model: MODEL,
            text: { format: { type: 'json_object' } },
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: JSON.stringify({ instruction, ...payload }) },
                ],
              },
            ],
          }
        : {
            model: MODEL,
            temperature: TEMP,
            text: { format: { type: 'json_object' } },
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: instruction },
                  { type: 'input_text', text: JSON.stringify(payload) },
                ],
              },
            ],
          };

      const resp = await client.responses.create(req);
      const rawText =
        (resp.output_text && resp.output_text.trim()) ||
        resp.output?.[0]?.content?.[0]?.text?.trim() ||
        '';

      if (!rawText) throw new Error('Empty model output from LLM');

      let modelOut;
      try {
        modelOut = JSON.parse(rawText);
      } catch {
        const m = rawText.match(/\{[\s\S]*\}$/);
        if (m) modelOut = JSON.parse(m[0]);
        else throw new Error(`LLM JSON parse failed: ${rawText}`);
      }

      const mults = modelOut?.odds_multipliers || {};
      let finalDist = combinePrior(baseline_prior, mults, { tau: 1.08, eps: 0.01 });

      finalDist = penalizeRecent(finalDist, recentTop, 0.1);
      const H = entropy(finalDist);
      let { result: topResult, prob: topProb } = argmaxKeyed(finalDist);
      if (H < 1.9 && topProb < 0.35) {
        finalDist = combinePrior(finalDist, {}, { tau: 1.12, eps: 0.015 });
        ({ result: topResult, prob: topProb } = argmaxKeyed(finalDist));
      }

      const prediction = {
        predicted_next: topResult,
        predicted_distribution: finalDist,
        top_result: topResult,
        top_probability: topProb,
        top_candidates: Object.entries(finalDist)
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .slice(0, 8)
          .map(([k, p]) => ({
            result: Number(k),
            prob: Number(p),
            color: numToColor(k),
            parity: parityOf(k),
            size: sizeOf(k),
          })),
        marginals: {},
        pattern_detected: Boolean(modelOut?.pattern_detected),
        pattern_type: modelOut?.pattern_type ?? null,
        pattern_description: modelOut?.pattern_description ?? null,
        confidence: { entropy: H, calibrated: false },
        quality_flags: { sum_ok: true },
        rationale: modelOut?.rationale ?? null,
      };

      const insPred = await pool.query(
        `INSERT INTO predictions (based_on_image_id, summary, prediction)
          VALUES ($1, $2::jsonb, $3::jsonb)
          ON CONFLICT (based_on_image_id) DO NOTHING
          RETURNING id`,
        [imageId, JSON.stringify(bundle), JSON.stringify(prediction)]
      );

      if (!insPred.rows.length) {
        logger.log?.(`[Predict] image=${imageId} already has prediction, skipping`);
        continue;
      }

      const distEntries = Object.entries(finalDist).sort((a, b) => Number(b[1]) - Number(a[1]));
      const top3 = [];
      for (const [k] of distEntries) {
        const n = Math.max(0, Math.min(27, Number(k) | 0));
        if (!top3.includes(n)) top3.push(n);
        if (top3.length === 3) break;
      }

      await insertPredictionLog({
        basedOnImageId: imageId,
        predictedNumbers: top3,
        predictedColor: numToColor(topResult),
        predictedParity: parityOf(topResult),
        predictedSize: sizeOf(topResult),
        confidence: Number(topProb),
      });

      try {
        pushAnalytics('analytics/prediction', {
          based_on_image_id: imageId,
          top_result: topResult,
          top_probability: topProb,
          predicted_next: topResult,
          created_at: new Date().toISOString(),
        });
      } catch {}

      logger.log?.(
        `[Predict] image=${imageId} → next=${topResult} (p=${Number(topProb).toFixed?.(4)}) H=${H.toFixed?.(3)}`
      );

      lastResult = { imageId, parsed, prediction };
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[Analyzer] Error:', msg);
      logger.error?.(`[Analyzer] image=${imageId} failed: ${msg}`);
    }
  }

  return lastResult;
}
