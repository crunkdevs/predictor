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

function clampAndNormalizeDistribution(distRaw = {}) {
  const dist = {};
  for (let i = 0; i <= 27; i++) {
    const k = String(i);
    const p = Number(distRaw[k] ?? 0);
    dist[k] = Number.isFinite(p) && p > 0 ? p : 0;
  }
  let sum = Object.values(dist).reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const u = 1 / 28;
    for (let i = 0; i <= 27; i++) dist[String(i)] = u;
    return dist;
  }
  for (let i = 0; i <= 27; i++) dist[String(i)] /= sum;
  return dist;
}

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

const colorOf = (n) => {
  n = Number(n);
  for (const [col, arr] of Object.entries(COLOR_MAP)) if (arr.includes(n)) return col;
  return null;
};
const parityOf = (n) => (Number(n) % 2 === 0 ? 'even' : 'odd');
const sizeOf = (n) => (Number(n) >= 0 && Number(n) <= 13 ? 'small' : 'big');

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

  out.color = colorOf(out.sum_0_27);
  return out;
}

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

      let parsed;
      try {
        parsed = await parseGameScreenshot(imageId);
      } catch (e) {
        logger.error?.(`[Analyzer] image=${imageId} parse failed, skipping: ${e?.message || e}`);
        continue;
      }

      await insertImageStats({ imageId, numbers: parsed?.numbers, result: parsed?.result });

      try {
        const actualNumber = Number(parsed?.result);
        if (Number.isFinite(actualNumber)) {
          await completeLatestPendingWithActual({
            actualNumber,
            actualColor: colorOf(actualNumber),
            actualParity: parityOf(actualNumber),
            actualSize: sizeOf(actualNumber),
          });
        }
      } catch (e) {
        logger.error?.('[Analyzer] completeLatestPendingWithActual failed:', e?.message || e);
      }

      const bundle = await advancedAnalyticsBundle(imageId, {
        lookback: LOOKBACK,
        topk: HOTCOLD_K,
      });

      const digit_shuffle = digitShuffleSummary(parsed);

      const instruction = `
You analyze the Chamet Spin game (results 0..27). Predict the NEXT result using ONLY the provided JSON fields.

Rules:
- Strong recency weighting: weights.last_20 > last_100 > last_200 > totals.
- Treat coreStats.* and bundle.* fields as authoritative aggregates (do not recompute).
- Consider gaps (overdue), streaks (color_runs), ratios, patterns, number_rules (A-D), range_systems, time_buckets, digit_shuffle.
- Use color_map for color membership.
- Also consider logs_feedback (recent accuracy, streak type/length, avg confidence) when calibrating risk; if current streak is "wrong", prefer safer/wider distributions.
- Output strictly the JSON schema below.

Return STRICT JSON with EXACT keys:
{
  "predicted_next": <0..27>,
  "predicted_distribution": { "0": p0, ..., "27": p27 },
  "top_result": <int>,
  "top_probability": <float>,
  "top_candidates": [
    { "result": n, "prob": p, "color": "..", "parity": "..", "size": ".." }
  ],
  "marginals": {
    "color": { "Red":x, "Orange":y, "Pink":z, "Dark Blue":a, "Sky Blue":b, "Green":c, "Gray":d },
    "parity": { "odd": x, "even": y },
    "size":   { "small": a, "big": b },
    "last_digit": { "0":d0, ..., "9":d9 }
  },
  "pattern_detected": true|false,
  "pattern_type": "<short>",
  "pattern_description": "<one line>",
  "confidence": { "entropy": <float>, "calibrated": true|false },
  "quality_flags": { "sum_ok": true|false },
  "rationale": "<one line>",
  "rng_check": { "chi_square": <float>, "p_value": <float|string>, "conclusion": "consistent"|"biased", "notes": "<short>" }
}`.trim();

      const logs_feedback = await predictionLogsSummary({ limit: 200 });
      const logs_tail = await recentPredictionLogsRaw({ limit: 15 });

      const payload = {
        color_map: COLOR_MAP,
        bundle,
        latest: parsed,
        digit_shuffle,
        logs_feedback,
        logs_tail,
        schema_hint: {
          version: 'v8',
          out_keys: [
            'predicted_next',
            'predicted_distribution',
            'top_result',
            'top_probability',
            'top_candidates',
            'marginals',
            'pattern_detected',
            'pattern_type',
            'pattern_description',
            'confidence',
            'quality_flags',
            'rationale',
            'rng_check',
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

      let prediction;
      try {
        prediction = JSON.parse(rawText);
      } catch {
        const m = rawText.match(/\{[\s\S]*\}$/);
        if (m) prediction = JSON.parse(m[0]);
        else throw new Error(`LLM JSON parse failed: ${rawText}`);
      }

      prediction.predicted_distribution = clampAndNormalizeDistribution(
        prediction.predicted_distribution || {}
      );

      const { result: fallbackTop, prob: fallbackProb } = argmaxKeyed(
        prediction.predicted_distribution
      );

      if (typeof prediction.predicted_next !== 'number') {
        prediction.predicted_next = fallbackTop;
        prediction.top_result = fallbackTop;
        prediction.top_probability = fallbackProb;
      } else {
        prediction.top_result = prediction.top_result ?? fallbackTop;
        prediction.top_probability = prediction.top_probability ?? fallbackProb;
      }

      const sum = Object.values(prediction.predicted_distribution)
        .map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0))
        .reduce((a, b) => a + b, 0);

      prediction.quality_flags = {
        ...(prediction.quality_flags || {}),
        sum_ok: sum > 0.99 && sum < 1.01,
      };

      await pool.query(
        `INSERT INTO predictions (based_on_image_id, summary, prediction)
         VALUES ($1, $2::jsonb, $3::jsonb)`,
        [imageId, JSON.stringify(payload.bundle), JSON.stringify(prediction)]
      );

      const distEntries = Object.entries(prediction.predicted_distribution || {}).sort(
        (a, b) => Number(b[1]) - Number(a[1])
      );
      const predictedNumbers = [];
      for (const [k] of distEntries) {
        const n = Math.max(0, Math.min(27, Number(k) | 0));
        if (!predictedNumbers.includes(n)) predictedNumbers.push(n);
        if (predictedNumbers.length === 3) break;
      }

      await insertPredictionLog({
        basedOnImageId: imageId,
        predictedNumbers,
        predictedColor: colorOf(prediction.top_result),
        predictedParity: parityOf(prediction.top_result),
        predictedSize: sizeOf(prediction.top_result),
        confidence: Number(prediction.top_probability),
      });

      logger.log?.(
        `[Predict] image=${imageId} → next=${prediction.predicted_next} (p=${prediction.top_probability?.toFixed?.(4)})`
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
