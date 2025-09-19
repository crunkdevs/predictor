import { pool } from '../config/db.config.js';

export async function getImageBase64(id) {
  const { rows } = await pool.query(`SELECT mime_type, bytes FROM images_store WHERE id = $1`, [
    id,
  ]);

  if (!rows.length) {
    throw new Error(`Image with id=${id} not found`);
  }

  const { mime_type, bytes } = rows[0];
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${mime_type};base64,${b64}`;
}
