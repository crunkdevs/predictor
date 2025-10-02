import { Router } from 'express';
import { listImages, getImage } from '../controllers/image.controller.js';
import { analyzeLatestUnprocessed } from '../services/analyzer.service.js';

const router = Router();

router.get('/images', listImages);
router.get('/images/:id', getImage);

router.post('/images/upload_b64', async (req, res) => {
  try {
    const hdr = req.header('x-upload-token');
    if (hdr !== process.env.UPLOAD_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { filename, mime_type, content_b64 } = req.body || {};
    if (!filename || !content_b64) {
      return res.status(400).json({ ok: false, error: 'filename & content_b64 required' });
    }

    const buffer = Buffer.from(content_b64, 'base64');
    const saved = await saveImage(buffer, filename);
    res.json({ ok: true, image: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
});

router.post('/analyze/run', async (_req, res) => {
  try {
    const out = await analyzeLatestUnprocessed();
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
});

export default router;
