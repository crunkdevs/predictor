import cron from 'node-cron';
import { pool } from '../config/db.config.js';
import { analyzeV2 } from './analyzer.v2.service.js';
import {
  maintainAndGetCurrentWindow,
  closeExpiredWindows,
  ensureTodayWindows,
} from './window.service.js';
import { refreshAnalyticsMaterializedViews } from '../analytics/analytics.handlers.js';

const TZ = process.env.SCHEDULER_TZ || 'Asia/Shanghai';

const CRON_SCHEDULE = process.env.CRON_SCHEDULE_V2 || '*/60 * * * * *';

const LOCK_KEY = Number(process.env.SCHEDULER_LOCK_KEY || 42843);

async function withPgLock(lockKey, fn, logger = console) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [lockKey]);
    if (!rows?.[0]?.got) {
      logger.log?.('[SchedulerV2] skipped (lock held)');
      return;
    }
    await fn();
  } catch (e) {
    logger.error?.('[SchedulerV2] withPgLock error ❌', e);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    } catch {}
    client.release();
  }
}

async function maintenance(logger = console) {
  await ensureTodayWindows();
  await closeExpiredWindows();

  try {
    await refreshAnalyticsMaterializedViews();
  } catch (e) {
    logger.warn?.(
      '[SchedulerV2] refreshAnalyticsMaterializedViews failed (non-fatal):',
      e?.message || e
    );
  }

  try {
    await pool.query('SELECT fn_rule_weights_maintenance(6)');
  } catch {}
}

export function startSchedulerV2(logger = console) {
  logger.info?.(`[SchedulerV2] Starting… CRON="${CRON_SCHEDULE}" TZ=${TZ}`);

  maintenance(logger)
    .then(async () => {
      const w = await maintainAndGetCurrentWindow();
      logger.info?.(
        '[SchedulerV2] Current window:',
        w ? { id: w.id, idx: w.window_idx, start_at: w.start_at, end_at: w.end_at } : 'none'
      );
    })
    .catch((e) => logger.error?.('[SchedulerV2] Initial maintenance failed:', e));

  const task = cron.schedule(
    CRON_SCHEDULE,
    async () => {
      const tickIso = new Date().toISOString();
      logger.log?.(`\n⏰ [SchedulerV2] Tick ${tickIso} (server clock UTC)`);

      await withPgLock(
        LOCK_KEY,
        async () => {
          await maintenance(logger);

          const out = await analyzeV2(logger);
          if (!out) return;

          logger.log?.('[SchedulerV2] Tick result:', {
            window_id: out.window?.id,
            pattern: out.pattern,
            source: out.source,
            top: out.prediction?.top3 || out.prediction?.top_candidates?.slice?.(0, 3),
          });
        },
        logger
      );
    },
    { timezone: TZ }
  );

  return task;
}
