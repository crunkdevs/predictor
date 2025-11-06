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
import { identifyActivePattern, numToColor, parityOf, sizeOf } from './prediction.engine.js';
import { fetchRecentSpins } from '../analytics/analytics.handlers.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.PRED_MODEL || 'gpt-5-mini';
const TEMP = Number(process.env.PRED_TEMPERATURE || 0.3);

export async function analyzeLatestUnprocessed(logger = console) {
  logger.log?.('[AIAnalyzer] 🧩 Triggered via window/pattern deviation');

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
          logger.log?.(`[AIAnalyzer] Ingested image=${id} into image_stats`, parsed);

          try {
            await processOutcomeForImage(id);
          } catch (e) {
            logger.warn?.('[AIAnalyzer] processOutcomeForImage failed:', e?.message || e);
          }

          try {
            const { analyzeV2 } = await import('./analyzer.v2.service.js');
            logger.log?.('[AIAnalyzer] Triggering analyzeV2 due to new image stats');
            await analyzeV2(logger);
          } catch (e) {
            logger.warn?.('[AIAnalyzer] analyzeV2 trigger failed:', e?.message || e);
          }
        } else {
          logger.warn?.(`[AIAnalyzer] parsed but missing "result" for image=${id}`, parsed);
        }
      } else {
        logger.log?.(`[AIAnalyzer] image=${id} already has stats – skipping`);
      }
    }
  } catch (e) {
    logger.warn?.('[AIAnalyzer] pre-ingest skipped:', e?.message || e);
  }

  const anchor = await getLatestAnchorImageId();
  if (!anchor) {
    logger.warn?.('[AIAnalyzer] No anchor image found.');
    return null;
  }

  const _lb = process.env.PRED_LOOKBACK ?? 200;
  const lookback = String(_lb).toLowerCase() === 'all' ? 'all' : Number(_lb) || 200;
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
  "predicted_numbers": [top5],
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

  let resp;
  try {
    logger.log?.('[AIAnalyzer] Calling OpenAI API with model:', MODEL);
    resp = await client.responses.create(payload);
    logger.log?.('[AIAnalyzer] OpenAI API response received');
  } catch (e) {
    logger.error?.('[AIAnalyzer] OpenAI API call failed:', e?.message || e);
    throw new Error(`OpenAI API error: ${e?.message || 'Unknown error'}`);
  }

  const raw =
    resp.output_text?.trim() ??
    resp.output?.[0]?.content?.find?.((c) => typeof c.text === 'string')?.text?.trim();

  if (!raw) {
    logger.error?.('[AIAnalyzer] Empty model output. Response:', JSON.stringify(resp, null, 2));
    throw new Error('Empty model output');
  }

  let out;
  try {
    out = JSON.parse(raw);
    logger.log?.('[AIAnalyzer] Parsed AI response:', out);
  } catch (e) {
    logger.warn?.('[AIAnalyzer] Failed to parse JSON, trying regex extraction. Raw:', raw);
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        out = JSON.parse(m[0]);
        logger.log?.('[AIAnalyzer] Successfully extracted JSON from response');
      } catch (e2) {
        logger.error?.('[AIAnalyzer] Failed to parse extracted JSON:', e2?.message || e2);
        throw new Error(`Invalid JSON from model: ${e2?.message || 'Parse error'}`);
      }
    } else {
      logger.error?.('[AIAnalyzer] No JSON found in response. Raw:', raw);
      throw new Error('Invalid JSON from model: No JSON object found');
    }
  }

  const nums = (out.predicted_numbers || [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 27);

  const conf = Number(out.confidence || 0.5);
  const len = Math.max(1, nums.length);

  let pattern_code = 'A';
  let pattern_scores = { A: 0, B: 0, C: 0 };
  let last = null;
  try {
    const rows = await fetchRecentSpins(30);
    const seq = rows
      .slice()
      .reverse()
      .map((r) => Number(r.result))
      .filter(Number.isFinite);
    last = seq.at(-1);
    const patternInfo = await identifyActivePattern({});
    pattern_code = patternInfo.pattern_code || 'A';
    pattern_scores = patternInfo.scores || { A: 0, B: 0, C: 0 };
  } catch (e) {
    logger.warn?.('[AIAnalyzer] Failed to get pattern info:', e?.message || e);
  }

  const top_candidates = nums.map((n) => ({
    result: n,
    color: numToColor(n),
    prob: conf / len,
    parity: parityOf(n),
    size: sizeOf(n),
  }));

  const top5 = nums.slice(0, 5);

  return {
    allowed: true,
    pattern_code,
    pattern_scores,
    last,
    top5,
    top_candidates,
    confidence: conf,
    pool: nums, // AI pool is the predicted numbers
    ranked: top_candidates.map((c, idx) => ({
      n: c.result,
      score: conf / len - idx * 0.01, // Simple ranking
      color: c.color,
      parity: c.parity,
      size: c.size,
    })),
  };
}
