import { pool } from '../config/db.config.js';
import { handleOutcome } from './analyzer.v2.service.js';

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

  const pj = pred.prediction || {};
  
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
  const allPredictedNumbers = Array.from(
    new Set([...hotNumbers, ...coldNumbers])
  );

  // Prediction is correct if actual result is in either hot or cold numbers
  const correct = allPredictedNumbers.length > 0 && allPredictedNumbers.includes(actual);

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
