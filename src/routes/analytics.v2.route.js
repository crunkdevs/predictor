import { Router } from 'express';
import * as v2 from '../controllers/analytics.v2.controller.js';

const router = Router();
router.get('/v2/window', v2.currentWindow);
router.get('/v2/windows/today', v2.todayWindows);
router.get('/v2/pattern/detect', v2.detectPattern);
router.get('/v2/predict/local-dry', v2.localPredictDry);
router.post('/v2/analyze/tick', v2.runAnalyzeTick);
router.get('/v2/scoring/preview', v2.scoringPreview);
router.get('/v2/ai/trigger', v2.aiTriggerStatus);
router.get('/v2/predictions/recent', v2.recentPredictions);
router.get('/v2/transitions', v2.numberTransitions);
router.get('/v2/core-bundle', v2.coreBundleForLatest);
export default router;
