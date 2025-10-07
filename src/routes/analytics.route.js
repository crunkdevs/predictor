import { Router } from 'express';
import {
  bundle,
  core,
  windows,
  gaps,
  gapsExt,
  ratiosApi,
  patternsApi,
  colorRuns,
  recentSpins,
  timeBuckets,
  rangeSystems,
  fourteenSystems,
  refresh,
  migrate,
  accuracyHourly,
  accuracyBreakdown,
  predictionsLogSummary,
} from '../controllers/analytics.controller.js';

const router = Router();

router.get('/bundle', bundle);
router.get('/core', core);
router.get('/windows', windows);
router.get('/gaps', gaps);
router.get('/gaps-extended', gapsExt);
router.get('/ratios', ratiosApi);
router.get('/patterns', patternsApi);
router.get('/color-runs', colorRuns);
router.get('/recent-spins', recentSpins);
router.get('/time-buckets', timeBuckets);
router.get('/range-systems', rangeSystems);
router.get('/fourteen-systems', fourteenSystems);

router.get('/accuracy/hourly', accuracyHourly);
router.get('/accuracy/breakdown', accuracyBreakdown);

router.post('/refresh', refresh);
router.post('/migrate', migrate);

router.get('/predictions/logs/summary', predictionsLogSummary);

export default router;
