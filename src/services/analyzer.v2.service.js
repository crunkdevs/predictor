import { pool } from '../config/db.config.js';
import {
  maintainAndGetCurrentWindow,
  canPredict,
  markPredictedNow,
  updateStreak,
  attachPredictionWindow,
} from './window.service.js';
import { detectAndSetPattern } from './pattern.detector.js';
import { localPredict, shouldTriggerAI } from './prediction.engine.js';
import { pushAnalytics } from '../analytics/analytics.ws.js';
import { analyzeLatestUnprocessed } from './analyzer.ai.service.js';

export async function analyzeV2(logger = console) {
  const now = new Date();
  logger.log?.(`\n🧠 [AnalyzerV2] Tick at ${now.toISOString()}`);

  const window = await maintainAndGetCurrentWindow();
  if (!window) {
    logger.log?.('[AnalyzerV2] ❌ No active window found.');
    return null;
  }

  const { id: windowId } = window;
  const can = await canPredict(windowId);
  if (!can.can) {
    logger.log?.(`[AnalyzerV2] ⏸️ Prediction blocked (${can.reason}) until ${can.until}`);
    return null;
  }

  const { pattern, metrics } = await detectAndSetPattern(windowId);
  logger.log?.(`[AnalyzerV2] Active Pattern = ${pattern}`, metrics);

  const windowState = await pool.query(
    `SELECT * FROM window_pattern_state WHERE window_id=$1 LIMIT 1`,
    [windowId]
  );
  const state = windowState.rows[0] || {};

  const aiTrigger = await shouldTriggerAI({
    windowState: state,
    pattern,
    confidence: null,
    cooldown: state?.paused_until,
  });

  let prediction = null;
  let source = 'local';

  try {
    if (aiTrigger) {
      logger.log?.('[AnalyzerV2] 🤖 AI Trigger activated.');
      prediction = await analyzeLatestUnprocessed(logger);
      source = 'ai';
    } else {
      prediction = await localPredict({ windowState: state, pattern_code: pattern });
    }
  } catch (e) {
    logger.error?.('[AnalyzerV2] Prediction generation failed', e);
    return null;
  }

  if (!prediction) {
    logger.log?.('[AnalyzerV2] No prediction produced.');
    return null;
  }

  const { rows } = await pool.query(
    `INSERT INTO predictions (based_on_image_id, summary, prediction)
     VALUES (NULL, $1::jsonb, $2::jsonb)
     RETURNING id`,
    [
      JSON.stringify({
        window_id: windowId,
        pattern,
        metrics,
        source,
      }),
      JSON.stringify(prediction),
    ]
  );

  const predId = rows?.[0]?.id;
  if (predId) {
    await attachPredictionWindow(predId, windowId, source);
    await markPredictedNow(windowId);
  }

  pushAnalytics('analytics/prediction', {
    window_id: windowId,
    pattern,
    source,
    prediction,
    ts: new Date().toISOString(),
  });

  logger.log?.(`[AnalyzerV2] ✅ Prediction generated via ${source}:`, {
    pattern,
    source,
    top: prediction.top_candidates?.slice(0, 3),
  });

  return { window, pattern, prediction, source };
}

export async function handleOutcome(actualResult, prevResult, correct) {
  const w = await maintainAndGetCurrentWindow();
  if (!w) return;
  await updateStreak(w.id, { correct });
  if (Number.isFinite(prevResult) && Number.isFinite(actualResult)) {
    await pool.query(
      `INSERT INTO number_transitions (from_n, to_n, count, last_seen)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (from_n, to_n)
       DO UPDATE SET count = number_transitions.count + 1,
                     last_seen = now()`,
      [prevResult, actualResult]
    );
  }
}
