import { pool } from '../config/db.config.js';

export async function hasStatsForImage(imageId) {
  if (!Number.isFinite(imageId)) return false;
  const { rows } = await pool.query(`SELECT 1 FROM image_stats WHERE image_id = $1 LIMIT 1`, [
    imageId,
  ]);
  return rows.length > 0;
}

export async function insertImageStats({ imageId, numbers, result }) {
  if (!Number.isFinite(imageId)) {
    throw new Error(`insertImageStats: invalid imageId=${imageId}`);
  }
  if (!Array.isArray(numbers) || numbers.length !== 3 || numbers.some((n) => !Number.isFinite(n))) {
    throw new Error(`insertImageStats: invalid numbers=${JSON.stringify(numbers)}`);
  }
  if (!Number.isFinite(result)) {
    throw new Error(`insertImageStats: invalid result=${result}`);
  }

  await pool.query(
    `INSERT INTO image_stats (image_id, numbers, result)
     VALUES ($1,$2,$3)
     ON CONFLICT (image_id) DO NOTHING`,
    [imageId, numbers, result]
  );
}

export async function latestUnprocessedImages(limit = 5) {
  if (!Number.isFinite(limit) || limit <= 0) limit = 5;

  const { rows } = await pool.query(
    `
    SELECT i.id
    FROM images_store i
    LEFT JOIN image_stats s ON s.image_id = i.id
    WHERE s.image_id IS NULL
    ORDER BY i.created_at DESC
    LIMIT $1
    `,
    [limit]
  );

  if (!rows?.length) return [];
  return rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
}
