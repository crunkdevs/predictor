import { Router } from 'express';
import { listImages, getImage } from '../controllers/image.controller.js';
import { analyzeLatestUnprocessed } from '../services/analyzer.service.js';

const router = Router();

router.get('/images', listImages);
router.get('/images/:id', getImage);

router.post('/analyze/run', async (_req, res) => {
  try {
    const out = await analyzeLatestUnprocessed();
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
});

export default router;
