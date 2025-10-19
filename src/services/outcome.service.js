// services/outcome.service.js
import { pool } from '../config/db.config.js';
import { handleOutcome } from './analyzer.v2.service.js';

// Evaluate latest prediction (of the window at time T) against actual result in image_stats
export async function processOutcomeForImage(imageId) {
  if (!Number.isFinite(Number(imageId))) return;

  // 1) fetch actual result + time of this image
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

  // 2) fetch previous actual result (for transition update)
  const { rows: prevRows } = await pool.query(
    `SELECT result::int AS prev
       FROM image_stats
      WHERE screen_shot_time < $1
      ORDER BY screen_shot_time DESC
      LIMIT 1`,
    [ts]
  );
  const prev = Number(prevRows?.[0]?.prev);

  // 3) find the window that covers this timestamp
  const { rows: winRows } = await pool.query(
    `SELECT id
       FROM windows
      WHERE start_at <= $1 AND end_at > $1
      ORDER BY id DESC
      LIMIT 1`,
    [ts]
  );
  const windowId = Number(winRows?.[0]?.id);
  if (!Number.isFinite(windowId)) return; // no window → skip

  // 4) get latest prediction for that window, made before this spin ts
  const { rows: predRows } = await pool.query(
    `SELECT id, prediction, summary
       FROM predictions
      WHERE window_id = $1
        AND created_at < $2
      ORDER BY id DESC
      LIMIT 1`,
    [windowId, ts]
  );
  const pred = predRows?.[0];
  if (!pred) return; // no prediction yet → nothing to score

  // 5) idempotency: if this prediction already evaluated, skip
  const evaluatedOn = pred.summary?.evaluated_on ?? pred.summary?.evaluated_on_image_id;
  if (evaluatedOn != null) return;

  // 6) extract predicted top candidates
  const pj = pred.prediction || {};
  // supported shapes: { top3: [..] } OR { top_candidates: [{result,prob}, ...] }
  let top3 = Array.isArray(pj.top3) ? pj.top3.map(Number) : null;
  if (!top3 || !top3.length) {
    const cand = Array.isArray(pj.top_candidates) ? pj.top_candidates : [];
    top3 = cand.slice(0, 3).map((c) => Number(c.result));
  }

  const correct = Array.isArray(top3) && top3.includes(actual);

  // 7) mark prediction JSON so we never re-process this same prediction (idempotent)
  await pool.query(
    `UPDATE predictions
        SET prediction = jsonb_set(prediction, '{correct}', to_jsonb($1::boolean), true),
            summary    = jsonb_set(summary,    '{evaluated_on}', to_jsonb($2::bigint), true),
            updated_at = now()
      WHERE id = $3`,
    [!!correct, imageId, pred.id]
  );

  // 8) propagate learning hooks (streaks, cooldowns, transitions, snapshot hit-rate EMA)
  await handleOutcome(actual, prev, correct);
}
