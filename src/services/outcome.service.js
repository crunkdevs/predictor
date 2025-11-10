import { pool } from '../config/db.config.js';
import { handleOutcome } from './analyzer.v2.service.js';

/**
 * Calculate if a prediction is correct based on hot and cold numbers
 * @param {Object} predictionJson - The prediction JSON object
 * @param {number} actualResult - The actual result number
 * @returns {boolean} - True if actual result is in hot or cold numbers
 */
export function calculatePredictionCorrectness(predictionJson, actualResult) {
  const pj = predictionJson || {};

  // Get hot numbers (top 5)
  let hotNumbers = [];
  if (Array.isArray(pj.top5) && pj.top5.length > 0) {
    hotNumbers = pj.top5.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 27);
  } else if (Array.isArray(pj.top_candidates) && pj.top_candidates.length > 0) {
    // Fallback: extract from top_candidates (first 5)
    hotNumbers = pj.top_candidates
      .slice(0, 5)
      .map((c) => Number(c?.result ?? c))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 27);
  }

  // Get cold numbers (pool - numbers ranked 6-13)
  let coldNumbers = [];
  if (Array.isArray(pj.pool) && pj.pool.length > 0) {
    coldNumbers = pj.pool.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 27);
  } else if (Array.isArray(pj.top_candidates) && pj.top_candidates.length > 5) {
    // Fallback: extract from top_candidates (numbers after top 5)
    coldNumbers = pj.top_candidates
      .slice(5)
      .map((c) => Number(c?.result ?? c))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 27);
  }

  // Combine hot and cold numbers, remove duplicates
  const allPredictedNumbers = Array.from(new Set([...hotNumbers, ...coldNumbers]));

  // Prediction is correct if actual result is in either hot or cold numbers
  return allPredictedNumbers.length > 0 && allPredictedNumbers.includes(actualResult);
}

export async function processOutcomeForImage(imageId) {
  if (!Number.isFinite(Number(imageId))) return;

  const { rows: imgRows } = await pool.query(
    `SELECT s.result::int AS actual, s.screen_shot_time AS ts
       FROM image_stats s
      WHERE s.image_id = $1
      LIMIT 1`,
    [imageId]
  );
  const row = imgRows?.[0];
  if (!row) return; // no stats -> nothing to do
  const actual = Number(row.actual);
  const ts = new Date(row.ts);

  const { rows: prevRows } = await pool.query(
    `SELECT result::int AS prev
       FROM image_stats
      WHERE screen_shot_time < $1
      ORDER BY screen_shot_time DESC
      LIMIT 1`,
    [ts]
  );
  const prev = Number(prevRows?.[0]?.prev);

  const { rows: winRows } = await pool.query(
    `SELECT id
       FROM windows
      WHERE start_at <= $1 AND end_at > $1
      ORDER BY id DESC
      LIMIT 1`,
    [ts]
  );
  const windowId = Number(winRows?.[0]?.id);
  if (!Number.isFinite(windowId)) return;

  const { rows: predRows } = await pool.query(
    `SELECT id, prediction, summary, source
       FROM predictions
      WHERE window_id = $1
        AND created_at < $2
      ORDER BY id DESC
      LIMIT 1`,
    [windowId, ts]
  );
  const pred = predRows?.[0];
  if (!pred) return;

  const evaluatedOn = pred.summary?.evaluated_on ?? pred.summary?.evaluated_on_image_id;
  if (evaluatedOn != null) return;

  const correct = calculatePredictionCorrectness(pred.prediction, actual);

  await pool.query(
    `UPDATE predictions
        SET prediction = jsonb_set(prediction, '{correct}', to_jsonb($1::boolean), true),
            summary    = jsonb_set(summary,    '{evaluated_on}', to_jsonb($2::bigint), true),
            updated_at = now()
      WHERE id = $3`,
    [!!correct, imageId, pred.id]
  );

  await handleOutcome(actual, prev, correct, pred.source || 'local', {
    windowId,
    spinTs: ts,
  });
}

/**
 * Check if backfill is needed (predictions exist that were evaluated with old logic)
 * @param {number} days - Number of days to check
 * @returns {Promise<boolean>} - True if backfill is needed
 */
export async function needsAccuracyBackfill(days = 30) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM predictions p
     WHERE p.prediction ? 'correct'
       AND (p.summary ? 'evaluated_on' OR p.summary ? 'evaluated_on_image_id')
       AND p.created_at >= now() - ($1 || ' days')::interval
     LIMIT 1`,
    [days]
  );
  return (rows[0]?.count || 0) > 0;
}

/**
 * Re-evaluate all existing predictions with the new correctness logic (including cold numbers)
 * @param {number} days - Number of days to look back (default: 30)
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} - Statistics about the re-evaluation
 */
export async function backfillPredictionCorrectness(days = 30, logger = console) {
  logger.log?.('[Backfill] Starting prediction correctness re-evaluation...');

  // Get all predictions that have been evaluated (have correct field and evaluated_on)
  const { rows: preds } = await pool.query(
    `SELECT 
      p.id,
      p.prediction,
      p.summary,
      p.source,
      p.window_id,
      COALESCE(
        (p.summary->>'evaluated_on')::bigint,
        (p.summary->>'evaluated_on_image_id')::bigint
      ) AS evaluated_on_image_id
    FROM predictions p
    WHERE p.prediction ? 'correct'
      AND (p.summary ? 'evaluated_on' OR p.summary ? 'evaluated_on_image_id')
      AND p.created_at >= now() - ($1 || ' days')::interval
    ORDER BY p.id`,
    [days]
  );

  logger.log?.(`[Backfill] Found ${preds.length} predictions to re-evaluate`);

  let updated = 0;
  let unchanged = 0;
  let errors = 0;
  let correctCount = 0;
  let wrongCount = 0;

  for (const pred of preds) {
    try {
      const imageId = pred.evaluated_on_image_id || pred.summary?.evaluated_on_image_id;
      if (!Number.isFinite(Number(imageId))) {
        logger.warn?.(
          `[Backfill] Prediction ${pred.id} has no valid evaluated_on_image_id, skipping`
        );
        errors++;
        continue;
      }

      // Get the actual result from the image
      const { rows: imgRows } = await pool.query(
        `SELECT result::int AS actual FROM image_stats WHERE image_id = $1 LIMIT 1`,
        [imageId]
      );

      if (!imgRows || !imgRows.length) {
        logger.warn?.(
          `[Backfill] Prediction ${pred.id} references image ${imageId} that doesn't exist, skipping`
        );
        errors++;
        continue;
      }

      const actual = Number(imgRows[0].actual);
      if (!Number.isFinite(actual)) {
        logger.warn?.(`[Backfill] Prediction ${pred.id} has invalid actual result, skipping`);
        errors++;
        continue;
      }

      // Get current correctness
      const oldCorrect = pred.prediction?.correct === true;

      // Re-calculate correctness with new logic (including cold numbers)
      const newCorrect = calculatePredictionCorrectness(pred.prediction, actual);

      // Only update if correctness changed
      if (oldCorrect !== newCorrect) {
        await pool.query(
          `UPDATE predictions
           SET prediction = jsonb_set(prediction, '{correct}', to_jsonb($1::boolean), true),
               updated_at = now()
           WHERE id = $2`,
          [newCorrect, pred.id]
        );
        updated++;
        if (newCorrect) correctCount++;
        else wrongCount++;
      } else {
        unchanged++;
        if (oldCorrect) correctCount++;
        else wrongCount++;
      }
    } catch (e) {
      logger.error?.(`[Backfill] Error processing prediction ${pred.id}:`, e?.message || e);
      errors++;
    }
  }

  const stats = {
    total: preds.length,
    updated,
    unchanged,
    errors,
    correct: correctCount,
    wrong: wrongCount,
    accuracy_pct: preds.length > 0 ? ((correctCount / preds.length) * 100).toFixed(2) : '0.00',
  };

  logger.log?.(`[Backfill] Re-evaluation complete:`, stats);
  return stats;
}
