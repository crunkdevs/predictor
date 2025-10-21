import crypto from 'node:crypto';

import { getImages, getImageById, insertOrGetImage } from '../models/image.model.js';
import { analyzeLatestUnprocessed } from '../services/analyzer.ai.service.js';

function ok(res, data) {
  return res.json({ ok: true, ...data });
}
function bad(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}

export async function listImages(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 200);
    const offset = Number(req.query.offset || 0);
    const rows = await getImages(limit, offset);
    return ok(res, { items: rows, limit, offset });
  } catch (e) {
    console.error('[listImages] error:', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function getImage(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return bad(res, 400, 'invalid id');

    const row = await getImageById(id);
    if (!row) return res.status(404).send('Not found');

    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    return res.send(row.bytes);
  } catch (e) {
    console.error('[getImage] error:', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function uploadB64(req, res) {
  try {
    const { filename, mime_type, content_b64 } = req.body || {};
    if (!filename || !content_b64) {
      return bad(res, 400, 'filename & content_b64 required');
    }

    const b64 = content_b64.startsWith('data:') ? content_b64.split(',')[1] : content_b64;
    const buf = Buffer.from(b64, 'base64');

    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    const safe = filename.replace(/[^\w.\-]/g, '_');

    const { row, inserted } = await insertOrGetImage({
      fileName: safe,
      mimeType: mime_type || 'application/octet-stream',
      fileSize: buf.length,
      sha256,
      buffer: buf,
    });

    setImmediate(() => {
      analyzeLatestUnprocessed().catch((e) =>
        console.error('[uploadB64] analyze trigger failed:', e?.message || e)
      );
    });

    return ok(res, { image: row, inserted });
  } catch (e) {
    console.error('[uploadB64] error:', e);
    return bad(res, 500, e?.message || 'failed');
  }
}

export async function analyzeRun(_req, res) {
  try {
    const out = await analyzeLatestUnprocessed();
    return ok(res, { out });
  } catch (e) {
    console.error('[analyzeRun] error:', e);
    return bad(res, 500, e?.message || 'failed');
  }
}
