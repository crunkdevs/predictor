import { pool } from '../config/db.config.js';

export async function insertOrGetImage({ fileName, mimeType, fileSize, sha256, buffer }) {
  const insertSql = `
    INSERT INTO images_store (file_name, mime_type, file_size, sha256, bytes)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (sha256) DO NOTHING
    RETURNING id, file_name, mime_type, file_size, sha256, created_at
  `;
  const params = [fileName, mimeType, fileSize, sha256, buffer];

  const ins = await pool.query(insertSql, params);
  if (ins.rows.length) {
    return { row: ins.rows[0], inserted: true };
  }

  const existing = await findByHash(sha256);
  return { row: existing, inserted: false };
}

export async function insertImage(args) {
  await pool.query(
    `INSERT INTO images_store (file_name, mime_type, file_size, sha256, bytes)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (sha256) DO NOTHING`,
    [args.fileName, args.mimeType, args.fileSize, args.sha256, args.buffer]
  );
}

export async function findByHash(sha256) {
  const { rows } = await pool.query(
    `SELECT id, file_name, mime_type, file_size, sha256, created_at
     FROM images_store
     WHERE sha256 = $1
     LIMIT 1`,
    [sha256]
  );
  return rows[0] || null;
}

export async function getImages(limit = 20, offset = 0) {
  const { rows } = await pool.query(
    `SELECT id, file_name, mime_type, file_size, sha256, created_at
     FROM images_store
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

export async function countImages() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM images_store`);
  return rows[0]?.count ?? 0;
}

export async function getImageById(id) {
  const { rows } = await pool.query(
    `SELECT id, file_name, mime_type, file_size, sha256, bytes, created_at
     FROM images_store
     WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function deleteImageById(id) {
  const { rowCount } = await pool.query(`DELETE FROM images_store WHERE id = $1`, [id]);
  return { deleted: rowCount > 0 };
}
