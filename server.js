import 'dotenv/config';
import express from 'express';
import http from 'http';
import { initSchema } from './src/config/db.config.js';
import imageRoutes from './src/routes/image.route.js';
import analyticsRoutes from './src/routes/analytics.route.js';
import { startScheduler } from './src/services/scheduler.service.js';
import {
  applyAdvancedAnalyticsSchema,
  applyStatsSchema,
} from './src/analytics/analytics.migrations.js';
import { setupAnalyticsWS } from './src/analytics/analytics.ws.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.use('/api', imageRoutes);
app.use('/api/analytics', analyticsRoutes);

app.use((err, _req, res) => {
  console.error('Error:', err);
  res.status(500).json({ message: err?.message || 'Internal error' });
});

await initSchema();
await applyStatsSchema();
await applyAdvancedAnalyticsSchema();
console.log('📦 DB schema ready');

startScheduler(console);

const server = http.createServer(app);

setupAnalyticsWS(server, { path: '/ws/analytics' });

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
