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

const r = Router();

r.get('/bundle', bundle);
r.get('/core', core);
r.get('/windows', windows);
r.get('/gaps', gaps);
r.get('/gaps-extended', gapsExt);
r.get('/ratios', ratiosApi);
r.get('/patterns', patternsApi);
r.get('/color-runs', colorRuns);
r.get('/recent-spins', recentSpins);
r.get('/time-buckets', timeBuckets);
r.get('/range-systems', rangeSystems);
r.get('/fourteen-systems', fourteenSystems);

r.get('/accuracy/hourly', accuracyHourly);
r.get('/accuracy/breakdown', accuracyBreakdown);

r.post('/refresh', refresh);
r.post('/migrate', migrate);

r.get('/predictions/logs/summary', predictionsLogSummary);

export default r;
