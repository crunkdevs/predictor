import 'dotenv/config';
import express from 'express';
import { initSchema } from './src/config/db.config.js';
import imageRoutes from './src/routes/image.route.js';
import { ingestBatch } from './src/utils/ingest.js';
import { startScheduler } from './src/services/scheduler.service.js';
import {
  applyAdvancedAnalyticsSchema,
  applyStatsSchema,
} from './src/analytics/analytics.migrations.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const WATCH_DIR = process.env.WATCH_DIR || './images';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.use('/api', imageRoutes);

app.use((err, _req, res, _next) => {
  console.error('Error:', err);
  res.status(500).json({ message: err?.message || 'Internal error' });
});

await initSchema();
await applyStatsSchema();
await applyAdvancedAnalyticsSchema();
console.log('📦 DB schema ready');
console.log(`📂 Watching: ${WATCH_DIR}`);

// try {
//   await ingestBatch();
//   console.log('✅ Initial ingest sweep done');
// } catch (e) {
//   console.error('❌ Initial ingest failed:', e);
// }

startScheduler(console);

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
