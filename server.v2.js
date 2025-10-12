import 'dotenv/config';
import express from 'express';
import http from 'http';

import { initSchema } from './src/config/db.config.js';
import imageRoutes from './src/routes/image.route.js';
import analyticsRoutes from './src/routes/analytics.route.js';

import {
  applyAdvancedAnalyticsSchema,
  applyStatsSchema,
} from './src/analytics/analytics.migrations.js';

import { setupAnalyticsWS } from './src/analytics/analytics.ws.js';

import { startSchedulerV2 } from './src/services/scheduler.v2.service.js';
import { ensureTodayWindows, closeExpiredWindows } from './src/services/window.service.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.use('/api', imageRoutes);
app.use('/api/analytics', analyticsRoutes);

await initSchema();
await applyStatsSchema();
await applyAdvancedAnalyticsSchema();
console.log('📦 DB base schema ready');

try {
  await ensureTodayWindows();
  await closeExpiredWindows();
  console.log('🗓️  Window system initialized for today');
} catch (e) {
  console.warn('⚠️  Window init warning:', e?.message || e);
}

const server = http.createServer(app);

setupAnalyticsWS(server, { path: '/ws/analytics' });

app.use(function (err, req, res, next) {
  console.error('Error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: err?.message || 'Internal error' });
});

startSchedulerV2(console);

server.listen(PORT, () => {
  console.log(`🚀 Server + WS running on http://localhost:${PORT}`);
});
