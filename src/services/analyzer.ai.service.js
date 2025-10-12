import OpenAI from 'openai';
import { advancedAnalyticsBundle } from '../analytics/analytics.handlers.js';
import { getLatestAnchorImageId } from '../analytics/analytics.handlers.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.PRED_MODEL || 'gpt-5-mini';
const TEMP = Number(process.env.PRED_TEMPERATURE || 0.3);

export async function analyzeLatestUnprocessed(logger = console) {
  logger.log?.('[AIAnalyzer] 🧩 Triggered via window/pattern deviation');

  const anchor = await getLatestAnchorImageId();
  if (!anchor) {
    logger.warn?.('[AIAnalyzer] No anchor image found.');
    return null;
  }

  const bundle = await advancedAnalyticsBundle(anchor, {
    lookback: process.env.PRED_LOOKBACK || 200,
    topk: process.env.PRED_TOPK || 5,
  });

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

  return {
    top_candidates: nums.map((n) => ({
      result: n,
      color: null,
      prob: conf / nums.length,
    })),
    confidence: conf,
  };
}
