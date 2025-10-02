import { Router } from 'express';
import {
  listImages,
  getImage,
  uploadB64,
  analyzeRun
} from '../controllers/image.controller.js';

const router = Router();

router.get('/images', listImages);
router.get('/images/:id', getImage);
router.post(['/images/upload_b64', '/images/upload-b64'], uploadB64);
router.post('/analyze/run', analyzeRun);

export default router;
