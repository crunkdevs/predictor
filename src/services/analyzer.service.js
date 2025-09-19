import OpenAI from 'openai';
import { pool } from '../config/db.config.js';
import {
  latestUnprocessedImages,
  hasStatsForImage,
  insertImageStats,
} from '../models/stats.model.js';
import { parseGameScreenshot } from './image-info-extract.service.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function buildSummary() {
  const totals = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
    FROM image_stats
    GROUP BY result
    ORDER BY result
  `);
  const last100 = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
    FROM (SELECT result FROM image_stats ORDER BY parsed_at DESC LIMIT 100) x
    GROUP BY result
  `);
  const last20 = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
    FROM (SELECT result FROM image_stats ORDER BY parsed_at DESC LIMIT 20) x
    GROUP BY result
  `);

  const toMap = (rows) => Object.fromEntries(rows.map((r) => [String(r.result), r.freq]));

  return {
    totals: toMap(totals.rows),
    last_100: toMap(last100.rows),
    last_20: toMap(last20.rows),
  };
}

export async function analyzeLatestUnprocessed(limit = 3, logger = console) {
  const ids = await latestUnprocessedImages(limit);
  if (!ids.length) {
    logger.log?.('[Analyzer] No new images to process.');
    return null;
  }

  let lastResult = null;

  for (const imageId of ids) {
    try {
      if (await hasStatsForImage(imageId)) continue;

      const parsed = await parseGameScreenshot(imageId);

      await insertImageStats({ imageId, ...parsed });

      const summary = await buildSummary();

      const resp = await client.responses.create({
        model: 'gpt-4.1-mini',
        temperature: 0,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `You are analyzing the **Chamet Spin** game (casino-style spinning wheel of numbers).
Your goal: predict the NEXT spin outcome.

Analyze history with these rules:
- Detect **streaks** (same result repeating).
- Detect **clusters** (results concentrated in a narrow band).
- Detect **cycles** (sequences repeating in order).
- Track **hot numbers** (frequent in recent spins).
- Track **cold numbers** (missing for many rounds).
- Check for **mean reversion** (long-absent numbers likely to appear).
- Weigh **last_20 spins** most heavily, then last_100, then totals.

If a strong deterministic pattern (like a cycle or streak) is found:
- Mark "pattern_detected": true
- Describe it in "pattern_description"
- Predict the **exact next number** in "predicted_next"

If no deterministic pattern:
- Mark "pattern_detected": false
- Provide a **probability distribution** across likely numbers.

Return ONLY valid JSON:
{
  "pattern_detected": true/false,
  "pattern_description": "<short text>",
  "predicted_next": <number>,
  "predicted_distribution": { "<result>": <probability 0..1>, ... },
  "top_result": <number>,
  "top_probability": <number 0..1>,
  "rationale": "<why you chose this>"
}

Historical summary:
${JSON.stringify(summary, null, 2)}

Latest observed (past round, do NOT predict this — predict the NEXT):
${JSON.stringify(parsed, null, 2)}`,
              },
            ],
          },
        ],
      });

      const text = resp.output[0]?.content[0]?.text?.trim() || '{}';
      let prediction;
      try {
        prediction = JSON.parse(text);
      } catch {
        throw new Error(`GPT JSON parse failed: ${text}`);
      }

      await pool.query(
        `INSERT INTO predictions (based_on_image_id, summary, prediction)
         VALUES ($1, $2::jsonb, $3::jsonb)`,
        [imageId, JSON.stringify(summary), JSON.stringify(prediction)]
      );

      logger.log?.(
        `[Predict] after image=${imageId} → forecast top=${prediction.top_result} p=${prediction.top_probability}`
      );

      lastResult = { imageId, parsed, prediction };
    } catch (err) {
      logger.error?.(`[Analyzer] image=${imageId} failed:`, err.message || err);
    }
  }

  return lastResult;
}
