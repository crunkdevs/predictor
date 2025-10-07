// src/services/analyzer.service.js
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

// ---------- helpers: safe number ops ----------
const nFix = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const iFix = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? (n < 0 ? 0 : Math.trunc(n)) : def;
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const tiny = 1e-12;

// ---------- map ----------
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
  n = iFix(n, null);
  for (const [c, arr] of Object.entries(COLOR_MAP)) if (arr.includes(n)) return c;
  return null;
};
const parityOf = (n) => (iFix(n, 0) % 2 === 0 ? 'even' : 'odd');
const sizeOf = (n) => (iFix(n, 0) <= 13 ? 'small' : 'big');

// ---------- argmax ----------
function argmaxKeyed(dist) {
  let bestK = '0';
  let bestP = -1;
  for (let i = 0; i <= 27; i++) {
    const k = String(i);
    const p = nFix(dist?.[k], 0);
    if (p > bestP) {
      bestP = p;
      bestK = k;
    }
  }
  return { result: iFix(bestK, 0), prob: nFix(bestP, 0) };
}

async function latestPredictionTime() {
  const { rows } = await pool.query(
    `SELECT created_at FROM predictions ORDER BY created_at DESC LIMIT 1`
  );
  return rows?.[0]?.created_at ? new Date(rows[0].created_at) : null;
}

// ---------- distribution sanitizers ----------
function sanitizeDistObject(obj, N = 28) {
  const out = {};
  let Z = 0;
  for (let i = 0; i < N; i++) {
    const k = String(i);
    const v = nFix(obj?.[k], 0);
    out[k] = v > 0 ? v : 0;
    Z += out[k];
  }
  if (Z <= 0) {
    const u = 1 / N;
    for (let i = 0; i < N; i++) out[String(i)] = u;
    return out;
  }
  for (let i = 0; i < N; i++) {
    const k = String(i);
    out[k] = out[k] / Z;
  }
  return out;
}

function entropy(dist, N = 28) {
  let H = 0;
  for (let i = 0; i < N; i++) {
    const p = clamp(nFix(dist?.[String(i)], 0), tiny, 1);
    H += -p * Math.log(p);
  }
  return nFix(H, 0);
}

// ---------- baseline prior ----------
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
  const W = bundle?.windows || {};
  const WM = W?.windows_multi || {};
  const f = (map, i) => nFix(map?.[String(i)], 0);

  const freq20 = WM['20'] || W.last_20 || {};
  const freq100 = WM['100'] || W.last_100 || {};
  const freq200 = WM['200'] || W.last_200 || {};
  const freq1000 = WM['1000'] || {};
  const totals = W.totals || {};

  const score = Array.from({ length: N }, (_, i) =>
    nFix(
      w20 * f(freq20, i) +
        w100 * f(freq100, i) +
        w200 * f(freq200, i) +
        w1000 * f(freq1000, i) +
        wtot * f(totals, i),
      0
    )
  );

  const maxF = Math.max(...score, 1);
  let s = score.map((x) => nFix(x / maxF, 0));

  const sinceMap = bundle?.gaps_extended?.numbers?.since || bundle?.gaps?.numbers || {};
  const lookback = nFix(bundle?.gaps_extended?.lookback || bundle?.gaps?.lookback, 500);

  for (let i = 0; i < N; i++) {
    const k = String(i);
    const since = nFix(sinceMap?.[k], 0);
    const r = clamp(since / Math.max(lookback, 1), 0, 1);
    s[i] = nFix(s[i] * (1 + gapBoost * r), 0);
  }

  const breakHint = bundle?.color_behaviour?.break_hint || '';
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
      const ok =
        (target === 'Cool' && isCool) ||
        (target === 'Warm' && isWarm) ||
        (target === 'Neutral' && isNeutral);
      if (ok) s[i] = nFix(s[i] * (1 + streakBoost), 0);
    }
  }

  const desiredColor = bundle?.ratios?.color || null;
  if (desiredColor) {
    const cur = {};
    for (let i = 0; i < N; i++) {
      const c = numToColor(i);
      cur[c] = nFix(cur[c], 0) + nFix(s[i], 0);
    }
    const totalS = Math.max(
      s.reduce((a, b) => a + nFix(b, 0), 0),
      tiny
    );
    for (let i = 0; i < N; i++) {
      const c = numToColor(i);
      if (!c) continue;
      const target = clamp(nFix(desiredColor[c], 0), 0, 1);
      const have = clamp(nFix(cur[c], 0) / totalS, 0, 1);
      const delta = colorReweight * (target - have);
      s[i] = nFix(s[i] * Math.max(1e-9, 1 + delta), 0);
    }
  }

  // to probs
  const Z = Math.max(
    s.reduce((a, b) => a + nFix(b, 0), 0),
    tiny
  );
  const prior = {};
  for (let i = 0; i < N; i++) prior[String(i)] = nFix(s[i], 0) / Z;

  return sanitizeDistObject(prior, N);
}

// ---------- combine prior + multipliers ----------
function combinePrior(prior, mults, { tau = 1.05, eps = 0.01 } = {}) {
  const N = 28;
  const out = {};
  let Z = 0;
  const p0 = sanitizeDistObject(prior, N);
  for (let i = 0; i < N; i++) {
    const k = String(i);
    const p = clamp(nFix(p0[k], 0), tiny, 1);
    let m = nFix(mults?.[k], 1.0);
    m = clamp(m, 0.6, 1.6);
    const val = Math.pow(p * m, 1 / clamp(nFix(tau, 1.0), 0.6, 10));
    out[k] = nFix(val, 0);
    Z += out[k];
  }
  if (Z <= 0) return sanitizeDistObject({}, N);

  // normalize + epsilon
  const u = 1 / N;
  const o2 = {};
  for (let i = 0; i < N; i++) {
    const k = String(i);
    const q = out[k] / Z;
    o2[k] = nFix((1 - eps) * q + eps * u, 0);
  }
  return sanitizeDistObject(o2, N);
}

// ---------- anti-repeat ----------
function penalizeRecent(dist, recentTop = [], alpha = 0.1) {
  const N = 28;
  const d0 = sanitizeDistObject(dist, N);
  const tmp = {};
  let Z = 0;

  const penalties = new Map();
  recentTop
    .filter((x) => Number.isFinite(Number(x)))
    .forEach((n, idx, arr) => {
      const w = (nFix(alpha, 0) * (arr.length - idx)) / Math.max(arr.length, 1);
      const key = String(iFix(n, 0));
      penalties.set(key, nFix(penalties.get(key), 0) + w);
    });

  for (let i = 0; i < N; i++) {
    const k = String(i);
    const p = clamp(nFix(d0[k], 0), 0, 1);
    const f = clamp(1 - nFix(penalties.get(k), 0), 1e-6, 1);
    tmp[k] = nFix(p * f, 0);
    Z += tmp[k];
  }
  if (Z <= 0) return d0;

  const out = {};
  for (let i = 0; i < N; i++) out[String(i)] = nFix(tmp[String(i)] / Z, 0);
  return sanitizeDistObject(out, N);
}

// ---------- digit shuffle ----------
function digitShuffleSummary(latest) {
  const out = { category: null, sum_0_27: null, color: null, digits: [] };
  const d = (Array.isArray(latest?.numbers) ? latest.numbers : [])
    .map((n) => iFix(n, NaN))
    .filter((x) => Number.isFinite(x));
  if (d.length !== 3) return out;

  const [a, b, c] = d.map((x) => Math.abs(x) % 10);
  out.digits = [a, b, c];

  const sum = iFix(a + b + c, 0);
  out.sum_0_27 = clamp(sum, 0, 27);

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

// ================== MAIN ==================
export async function analyzeLatestUnprocessed(limit = 3, logger = console) {
  logger.log?.('[PRED CFG]', { MODEL, TEMP, LOOKBACK, HOTCOLD_K, PRED_MIN_SECONDS });

  const ids = await latestUnprocessedImages(limit);
  if (!ids?.length) {
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

      // 1) parse
      let parsed;
      try {
        parsed = await parseGameScreenshot(imageId);
      } catch (e) {
        logger.error?.(`[Analyzer] image=${imageId} parse failed, skipping: ${e?.message || e}`);
        continue;
      }

      // strict result number
      const resultNum = iFix(parsed?.result, NaN);
      if (!Number.isFinite(resultNum)) {
        logger.warn?.(`[Analyzer] Skipping image=${imageId} — invalid result: ${parsed?.result}`);
        continue;
      }

      // image stats insert (uses integer only)
      await insertImageStats({
        imageId,
        numbers: Array.isArray(parsed?.numbers) ? parsed.numbers.map((x) => iFix(x, 0)) : [],
        result: resultNum,
      });

      // 2) complete last pending with actual
      try {
        await completeLatestPendingWithActual({
          actualNumber: resultNum,
          actualColor: numToColor(resultNum),
          actualParity: parityOf(resultNum),
          actualSize: sizeOf(resultNum),
        });
      } catch (e) {
        logger.error?.('[Analyzer] completeLatestPendingWithActual failed:', e?.message || e);
      }

      // 3) already predicted?
      const { rows: predCheck } = await pool.query(
        `SELECT 1 FROM predictions WHERE based_on_image_id = $1 LIMIT 1`,
        [imageId]
      );
      if (predCheck?.length) {
        logger.log?.(
          `[Analyzer] prediction already exists for image=${imageId}, skipping OpenAI call`
        );
        continue;
      }

      // 4) analytics bundle (multi lookback ok)
      const bundle = await advancedAnalyticsBundle(imageId, {
        lookback: [200, 1000, 2000],
        topk: HOTCOLD_K,
      });

      // 5) deterministic baseline
      const baseline_prior = buildBaselinePrior(bundle);

      const digit_shuffle = digitShuffleSummary(parsed);
      const logs_feedback = await predictionLogsSummary({ limit: 200 });
      const logs_tail = await recentPredictionLogsRaw({ limit: 15 });

      const recentTop = (logs_tail || [])
        .map((r) =>
          Array.isArray(r?.predicted_numbers) ? iFix(r.predicted_numbers?.[0], NaN) : NaN
        )
        .filter((n) => Number.isFinite(n))
        .slice(0, 5);

      // 6) LLM prompt
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
        (resp?.output_text && resp.output_text.trim()) ||
        resp?.output?.[0]?.content?.[0]?.text?.trim() ||
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

      // 7) combine + guards
      const mults = modelOut?.odds_multipliers || {};
      let finalDist = combinePrior(baseline_prior, mults, { tau: 1.08, eps: 0.01 });
      finalDist = penalizeRecent(finalDist, recentTop, 0.1);
      finalDist = sanitizeDistObject(finalDist);

      const H = entropy(finalDist);
      let { result: topResult, prob: topProb } = argmaxKeyed(finalDist);

      if (H < 1.9 && topProb < 0.35) {
        finalDist = combinePrior(finalDist, {}, { tau: 1.12, eps: 0.015 });
        finalDist = sanitizeDistObject(finalDist);
        ({ result: topResult, prob: topProb } = argmaxKeyed(finalDist));
      }

      // 8) prediction object (sanitized)
      const distEntries = Object.entries(finalDist).sort((a, b) => nFix(b[1], 0) - nFix(a[1], 0));

      const top3 = [];
      for (const [k] of distEntries) {
        const n = clamp(iFix(k, 0), 0, 27);
        if (!top3.includes(n)) top3.push(n);
        if (top3.length === 3) break;
      }

      topResult = clamp(iFix(topResult, 0), 0, 27);
      topProb = clamp(nFix(topProb, 0), 0, 1);

      const prediction = {
        predicted_next: topResult,
        predicted_distribution: sanitizeDistObject(finalDist),
        top_result: topResult,
        top_probability: topProb,
        top_candidates: Object.entries(finalDist)
          .sort((a, b) => nFix(b[1], 0) - nFix(a[1], 0))
          .slice(0, 8)
          .map(([k, p]) => {
            const r = clamp(iFix(k, 0), 0, 27);
            return {
              result: r,
              prob: clamp(nFix(p, 0), 0, 1),
              color: numToColor(r),
              parity: parityOf(r),
              size: sizeOf(r),
            };
          }),
        marginals: {},
        pattern_detected: Boolean(modelOut?.pattern_detected),
        pattern_type: modelOut?.pattern_type ?? null,
        pattern_description: modelOut?.pattern_description ?? null,
        confidence: { entropy: nFix(H, 0), calibrated: false },
        quality_flags: { sum_ok: true },
        rationale: modelOut?.rationale ?? null,
      };

      // 9) store prediction row
      const insPred = await pool.query(
        `INSERT INTO predictions (based_on_image_id, summary, prediction)
         VALUES ($1, $2::jsonb, $3::jsonb)
         ON CONFLICT (based_on_image_id) DO NOTHING
         RETURNING id`,
        [imageId, JSON.stringify(bundle || {}), JSON.stringify(prediction)]
      );

      if (!insPred?.rows?.length) {
        logger.log?.(`[Predict] image=${imageId} already has prediction, skipping`);
        continue;
      }

      // 10) store log (strict ints/floats)
      const safeTop3 = Array.isArray(top3) ? top3.map((n) => clamp(iFix(n, 0), 0, 27)) : [0, 1, 2];

      await insertPredictionLog({
        basedOnImageId: imageId,
        predictedNumbers: safeTop3,
        predictedColor: numToColor(topResult),
        predictedParity: parityOf(topResult),
        predictedSize: sizeOf(topResult),
        confidence: nFix(topProb, 0),
      });

      // 11) push ws (best-effort)
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
        `[Predict] image=${imageId} → next=${topResult} (p=${topProb.toFixed?.(4)}) H=${nFix(H, 0).toFixed?.(3)}`
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
