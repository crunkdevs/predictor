import { pool } from '../config/db.config.js';

export async function insertPredictionLog({
  basedOnImageId,
  predictedNumbers = [],
  predictedColor = null,
  predictedParity = null,
  predictedSize = null,
  confidence = null,
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO prediction_logs
      (based_on_image_id, predicted_numbers, predicted_color, predicted_parity, predicted_size, confidence)
    VALUES ($1, $2::smallint[], $3, $4, $5, $6)
    RETURNING id
    `,
    [
      basedOnImageId ?? null,
      Array.isArray(predictedNumbers) ? predictedNumbers.map((n) => Number(n)) : [],
      predictedColor,
      predictedParity,
      predictedSize,
      Number.isFinite(Number(confidence)) ? Number(confidence) : null,
    ]
  );
  return rows[0]?.id ?? null;
}

export async function updatePredictionLogActual({
  logId,
  actualNumber,
  actualColor,
  actualParity,
  actualSize,
}) {
  await pool.query(
    `
    UPDATE prediction_logs
       SET actual_result = $2::smallint,
           actual_color  = $3,
           actual_parity = $4,
           actual_size   = $5,
           correct = CASE
             WHEN $2 IS NULL THEN NULL
             ELSE COALESCE($2 = ANY(predicted_numbers), false)
           END
     WHERE id = $1
    `,
    [logId, Number(actualNumber), actualColor, actualParity, actualSize]
  );

  await pool.query('SELECT fn_feedback_apply($1)', [logId]);
}

export async function completeLatestPendingWithActual({
  actualNumber,
  actualColor,
  actualParity,
  actualSize,
  currentImageId,
}) {
  const sel = await pool.query(
    `
    SELECT id
    FROM prediction_logs
    WHERE actual_result IS NULL
      AND based_on_image_id IS NOT NULL
      AND based_on_image_id < $1
    ORDER BY based_on_image_id DESC, id DESC
    LIMIT 1
    `,
    [Number(currentImageId)]
  );
  const id = sel.rows?.[0]?.id ?? null;
  if (!id) return null;

  await updatePredictionLogActual({
    logId: id,
    actualNumber,
    actualColor,
    actualParity,
    actualSize,
  });

  return id;
}
