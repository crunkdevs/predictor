import OpenAI from 'openai';
import crypto from 'crypto';
import { pool } from '../config/db.config.js';
import {
  latestUnprocessedImages,
  hasStatsForImage,
  insertImageStats,
} from '../models/stats.model.js';
import { windowsSummary, allStatsBundle } from './stats.service.js';
import { parseGameScreenshot } from './image-info-extract.service.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LOOKBACK = Number(process.env.PRED_LOOKBACK || 200);
const HOTCOLD_K = Number(process.env.PRED_TOPK || 5);
const MODEL = process.env.PRED_MODEL || 'gpt-4.1-mini';
const IS_GPT5 = (MODEL || '').startsWith('gpt-5');
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

function md5Json(obj) {
  return crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex');
}

async function getLiveLast20() {
  const q = `
    WITH last AS (
      SELECT result
      FROM image_stats
      WHERE screen_shot_time IS NOT NULL
      ORDER BY screen_shot_time DESC
      LIMIT 20
    )
    SELECT jsonb_object_agg(result::text, cnt) AS live_last20
    FROM (
      SELECT result, COUNT(*) AS cnt
      FROM last
      GROUP BY 1
      ORDER BY 1
    ) x;
  `;
  const { rows } = await pool.query(q);
  return rows[0]?.live_last20 || {};
}

async function getLatestSavedLast20() {
  const { rows } = await pool.query(`
    SELECT summary->'windows'->'last_20' AS saved_last20
    FROM predictions
    ORDER BY created_at DESC
    LIMIT 1;
  `);
  return rows[0]?.saved_last20 || null;
}

async function latestPredictionTime() {
  const { rows } = await pool.query(`
    SELECT created_at
    FROM predictions
    ORDER BY created_at DESC
    LIMIT 1;
  `);
  return rows[0]?.created_at ? new Date(rows[0].created_at) : null;
}

async function buildSummaryFull(imageId) {
  const [windows, stats] = await Promise.all([
    windowsSummary(LOOKBACK),
    allStatsBundle(imageId, LOOKBACK, HOTCOLD_K),
  ]);
  return { windows, stats };
}

export async function analyzeLatestUnprocessed(limit = 3, logger = console) {
  console.log('[PRED CFG]', { MODEL, TEMP, LOOKBACK, HOTCOLD_K, PRED_MIN_SECONDS });

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

      await insertImageStats({
        imageId,
        numbers: parsed?.numbers,
        result: parsed?.result,
      });

      // const live20 = await getLiveLast20();
      // const saved20 = await getLatestSavedLast20();
      // const live20Hash = md5Json(live20);
      // const saved20Hash = saved20 ? md5Json(saved20) : null;

      // if (saved20Hash && live20Hash === saved20Hash) {
      //   logger.log?.(`[Analyzer] Skipping prediction — last_20 unchanged (hash=${live20Hash}).`);
      //   continue;
      // }

//       const summary = await buildSummaryFull(imageId);

//       const instruction = `
// You are analyzing the Chamet Spin game (numbers 0..27). Predict the NEXT spin outcome using ONLY the data provided.

// HARD REQUIREMENTS:
// - Give higher weight to recency: windows.last_20 > windows.last_100 > windows.last_200 > windows.totals.
// - Treat stats.color/parity/size/last_digit percentages as authoritative global marginals; DO NOT recompute them from your own assumptions.
// - Use ONLY the provided color_map for color groupings.
// - Do not copy previous answers; base the prediction on the latest sequences.

// ADDITIONAL REQUIREMENT: RNG CHECK
// - Using windows.totals (or last_200 if provided), check if observed frequencies look consistent with uniform RNG (1/28 each).
// - Approximate a chi-square style test: compute chi-square value, report a rough p-value if possible.
// - Also check if last_200_seq shows suspicious streaks or correlations.
// - Summarize in a new "rng_check" field with keys: chi_square, p_value, conclusion ("consistent" | "biased"), notes.

// OUTPUT STRICT JSON (no markdown) with EXACT keys:
// {
//   "predicted_next": <number 0..27>,
//   "predicted_distribution": { "0": p0, ..., "27": p27 },
//   "top_result": <number>,
//   "top_probability": <float>,
//   "top_candidates": [ { "result": n, "prob": p, "color": "...", "parity": "...", "size": "..." }, ... up to 3 ],
//   "marginals": {
//     "color": { "<color>": prob_share, ... },
//     "parity": { "odd": x, "even": y },
//     "size": { "small": a, "big": b },
//     "last_digit": { "0": d0, ..., "9": d9 }
//   },
//   "pattern_detected": true|false,
//   "pattern_type": "<short_label>",
//   "pattern_description": "<one concise sentence>",
//   "confidence": { "entropy": <float>, "calibrated": true|false },
//   "quality_flags": { "sum_ok": true|false },
//   "rationale": "<short explanation>",
//   "rng_check": {
//     "chi_square": <float>,
//     "p_value": <float|string>,
//     "conclusion": "consistent" | "biased",
//     "notes": "<short text>"
//   }
// }
// `.trim();

//       const payload = {
//         instruction,
//         color_map: COLOR_MAP,
//         summary,
//         latest: parsed,
//         schema_hint: {
//           version: 'v5',
//           out_keys: [
//             'pattern_detected',
//             'pattern_type',
//             'pattern_description',
//             'predicted_next',
//             'predicted_distribution',
//             'top_result',
//             'top_probability',
//             'top_candidates',
//             'marginals',
//             'confidence',
//             'quality_flags',
//             'rationale',
//             'rng_check',
//           ],
//         },
//       };

//       const req = IS_GPT5
//         ? {
//             model: MODEL,
//             text: { format: { type: 'json_object' } },
//             input: [
//               {
//                 role: 'user',
//                 content: [{ type: 'input_text', text: JSON.stringify(payload) }],
//               },
//             ],
//           }
//         : {
//             model: MODEL,
//             temperature: TEMP,
//             text: { format: { type: 'json_object' } },
//             input: [
//               {
//                 role: 'user',
//                 content: [
//                   { type: 'input_text', text: instruction },
//                   { type: 'input_text', text: JSON.stringify(payload) },
//                 ],
//               },
//             ],
//           };

      // logger.log?.('[LLM CALL]', { model: MODEL, temperature: TEMP });
      // const resp = await client.responses.create(req);

      // const rawText =
      //   (resp.output_text && resp.output_text.trim()) ||
      //   resp.output?.[0]?.content?.[0]?.text?.trim() ||
      //   '';

      // if (!rawText) throw new Error('Empty model output from LLM');

      // let prediction;
      // try {
      //   prediction = JSON.parse(rawText);
      // } catch {
      //   const m = rawText.match(/\{[\s\S]*\}$/);
      //   if (m) prediction = JSON.parse(m[0]);
      //   else throw new Error(`LLM JSON parse failed: ${rawText}`);
      // }

      // prediction.predicted_distribution = clampAndNormalizeDistribution(
      //   prediction.predicted_distribution || {}
      // );

      // if (typeof prediction.predicted_next !== 'number') {
      //   const { result, prob } = argmaxKeyed(prediction.predicted_distribution);
      //   prediction.predicted_next = result;
      //   prediction.top_result = result;
      //   prediction.top_probability = prob;
      // } else {
      //   const { result, prob } = argmaxKeyed(prediction.predicted_distribution);
      //   prediction.top_result = prediction.top_result ?? result;
      //   prediction.top_probability = prediction.top_probability ?? prob;
      // }

      // const sum = Object.values(prediction.predicted_distribution).reduce(
      //   (a, b) => a + Number(b || 0),
      //   0
      // );
      // prediction.quality_flags = {
      //   ...(prediction.quality_flags || {}),
      //   sum_ok: sum > 0.99 && sum < 1.01,
      // };

      // await pool.query(
      //   `INSERT INTO predictions (based_on_image_id, summary, prediction)
      //    VALUES ($1, $2::jsonb, $3::jsonb)`,
      //   [imageId, JSON.stringify(summary), JSON.stringify(prediction)]
      // );

      // logger.log?.(
      //   `[Predict] image=${imageId} → next=${prediction.predicted_next} (p=${prediction.top_probability?.toFixed?.(4)}) RNG=${prediction.rng_check?.conclusion ?? 'unknown'}`
      // );

      lastResult = { imageId, parsed, prediction };
    } catch (err) {
      logger.error?.(`[Analyzer] image=${imageId} failed:`, err.message || err);
    }
  }

  return lastResult;
}
