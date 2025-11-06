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
  let top5 = Array.isArray(pj.top5) ? pj.top5.map(Number) : null;
  if (!top5 || !top5.length) {
    const cand = Array.isArray(pj.top_candidates) ? pj.top_candidates : [];
    top5 = cand.slice(0, 5).map((c) => Number(c.result));
  }

  const correct = Array.isArray(top5) && top5.includes(actual);

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
