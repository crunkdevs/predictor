// services/analyzer.ai.service.js
import OpenAI from 'openai';

import {
  allStatsForLatestAnchor,
  gapStatsExtended,
  ratios,
  recentColorRuns,
  timeBucketsSnapshot,
  getLatestAnchorImageId,
} from '../analytics/analytics.handlers.js';

import {
  latestUnprocessedImages,
  hasStatsForImage,
  insertImageStats,
} from '../models/stats.model.js';

import { parseGameScreenshot } from './image-info-extract.service.js';

import { processOutcomeForImage } from './outcome.service.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.PRED_MODEL || 'gpt-5-mini';
const TEMP = Number(process.env.PRED_TEMPERATURE || 0.3);

export async function analyzeLatestUnprocessed(logger = console) {
  logger.log?.('[AIAnalyzer] 🧩 Triggered via window/pattern deviation');

  // Pre-ingest any latest unprocessed image
  try {
    const ids = await latestUnprocessedImages(1);
    if (ids.length) {
      const id = ids[0];
      if (!(await hasStatsForImage(id))) {
        const parsed = await parseGameScreenshot(id);
        if (parsed?.result != null) {
          await insertImageStats({
            imageId: id,
            numbers: parsed.numbers,
            result: parsed.result,
          });
          logger.log?.(`[AIAnalyzer] Ingested image=${id} into image_stats`);
          try {
            await processOutcomeForImage(id);
          } catch (e) {
            logger.warn?.('[AIAnalyzer] processOutcomeForImage failed:', e?.message || e);
          }
        }
      }
    }
  } catch (e) {
    logger.warn?.('[AIAnalyzer] pre-ingest skipped:', e?.message || e);
  }

  // Anchor image to base analytics on
  const anchor = await getLatestAnchorImageId();
  if (!anchor) {
    logger.warn?.('[AIAnalyzer] No anchor image found.');
    return null;
  }

  // ---- Slim V2 bundle (doc-compliant) ----
  const lookback = Number(process.env.PRED_LOOKBACK || 200);
  const topk = Number(process.env.PRED_TOPK || 5);

  const [coreStats, gaps_extended, r, color_runs, time_buckets] = await Promise.all([
    allStatsForLatestAnchor(lookback, topk),
    gapStatsExtended(Math.max(lookback, 500)),
    ratios(Math.min(lookback, 200)),
    recentColorRuns(50),
    timeBucketsSnapshot(),
  ]);

  const bundle = { coreStats, gaps_extended, ratios: r, color_runs, time_buckets };

  const instruction = `
You are a roulette analytics assistant.
Predict the most probable next number (0-27) using JSON only:
{
  "predicted_numbers": [top3],
  "confidence": number(0-1)
}

Guidelines:
- Base your reasoning on color, parity, and streak stability.
- Use gaps and ratios for weighting.
- Prefer balanced candidates across clusters.
`.trim();

  const payload = {
    model: MODEL,
    temperature: TEMP,
    text: { format: { type: 'json_object' } },
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: instruction },
          { type: 'input_text', text: JSON.stringify(bundle) },
        ],
      },
    ],
  };

  const resp = await client.responses.create(payload);
  const raw = resp.output_text?.trim() || resp.output?.[0]?.content?.[0]?.text?.trim();
  if (!raw) throw new Error('Empty model output');

  let out;
  try {
    out = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}$/);
    if (m) out = JSON.parse(m[0]);
    else throw new Error('Invalid JSON from model');
  }

  const nums = (out.predicted_numbers || []).map((n) => Number(n)).filter((n) => n >= 0 && n <= 27);

  const conf = Number(out.confidence || 0.5);
  const len = Math.max(1, nums.length);

  return {
    top_candidates: nums.map((n) => ({
      result: n,
      color: null,
      prob: conf / len,
    })),
    confidence: conf,
  };
}
