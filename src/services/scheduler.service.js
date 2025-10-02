// src/services/scheduler.service.js
import cron from 'node-cron';
import { pool } from '../config/db.config.js';
import { analyzeLatestUnprocessed } from './analyzer.service.js';

const TZ = process.env.SCHEDULER_TZ || 'Asia/Karachi';
// Run every 10 seconds by default (avoid noisy per-second ticks)
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/10 * * * * *';

// Simple PG advisory lock to prevent overlapping runs across processes
async function withPgLock(lockKey, fn, logger = console) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [lockKey]);
    if (!rows?.[0]?.got) {
      logger.log?.('[Scheduler] skipped (lock held)');
      return;
    }
    await fn();
  } catch (e) {
    logger.error?.('[Scheduler] withPgLock error ❌', e);
  } finally {
    // Best-effort unlock
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    } catch {}
    client.release();
  }
}

export function startScheduler(logger = console) {
  logger.info?.(`[Scheduler] Starting… CRON="${CRON_SCHEDULE}" TZ=${TZ}`);

  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      const tickIso = new Date().toISOString();
      logger.log?.(`\n⏰ Cron tick at ${tickIso} (server clock UTC)`);

      await withPgLock(
        42842,
        async () => {
          // Lightweight diag (helps confirm DB time & image count)
          const { rows } = await pool.query(
            `SELECT now() AS db_now_utc, COUNT(*) AS total_images FROM images_store;`
          );
          logger.log?.('[Scheduler][Diag]', rows?.[0]);

          // Only analyze; no ingest, no mat-view refresh here
          await analyzeLatestUnprocessed(logger);
          logger.log?.('[Scheduler] analyze ✅');
        },
        logger
      );
    },
    { timezone: TZ }
  );
}
