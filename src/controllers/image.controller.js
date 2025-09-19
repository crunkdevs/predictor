import { getImages, getImageById } from '../models/image.model.js';

export async function listImages(req, res) {
  const limit = Math.min(Number(req.query.limit || 20), 200);
  const offset = Number(req.query.offset || 0);
  const rows = await getImages(limit, offset);
  res.json({ items: rows, limit, offset });
}

export async function getImage(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  const row = await getImageById(id);
  if (!row) return res.status(404).send('Not found');

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.send(row.bytes);
}
