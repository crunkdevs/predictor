import cron from 'node-cron';
import { pool } from '../config/db.config.js';
import { ingestBatch } from '../utils/ingest.js';
import { analyzeLatestUnprocessed } from './analyzer.service.js';

const TZ = process.env.SCHEDULER_TZ || 'Asia/Karachi';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '* * * * * *';

export function startScheduler(logger = console) {
  logger.info?.(`[Scheduler] Starting… CRON="${CRON_SCHEDULE}" TZ=${TZ}`);

  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      const tickIso = new Date().toISOString();
      logger.log?.(`\n⏰ Cron tick at ${tickIso} (server clock UTC)`);

      try {
        const { rows } = await pool.query(`
          SELECT now() AS db_now_utc, COUNT(*) AS total_images FROM images_store;
        `);
        logger.log?.('[Scheduler][Diag]', rows[0]);

        await ingestBatch();
        logger.log?.('[Scheduler] ingestBatch ✅');

        await analyzeLatestUnprocessed(logger);
        logger.log?.('[Scheduler] analyze ✅');
      } catch (err) {
        logger.error?.('[Scheduler] Top-level error ❌', err);
      }
    },
    { timezone: TZ }
  );
}
