// services/scheduler.v2.service.js
import cron from 'node-cron';
import { pool } from '../config/db.config.js';
import { analyzeV2 } from './analyzer.v2.service.js';
import {
  maintainAndGetCurrentWindow,
  closeExpiredWindows,
  ensureTodayWindows,
} from './window.service.js';
import { refreshAnalyticsMaterializedViews } from '../analytics/analytics.handlers.js';

const CRON_SCHEDULE = process.env.CRON_SCHEDULE_V2 || '0 * * * * *';
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

  // V2: Take a 48h pattern snapshot if we don't have a recent one
  // (ensures at most ~one snapshot per 48h window)
  try {
    const { rows: recent } = await pool.query(
      `SELECT 1
         FROM pattern_snapshots
        WHERE end_at >= (now() - interval '47 hours')
        LIMIT 1`
    );
    if (!recent.length) {
      const { rows } = await pool.query(`SELECT fn_store_pattern_snapshot_48h(now()) AS snap`);
      const snap = rows?.[0]?.snap;
      logger.info?.('[SchedulerV2] 📸 48h pattern snapshot stored', {
        id: snap?.id,
        start_at: snap?.start_at,
        end_at: snap?.end_at,
        sample_size: snap?.sample_size,
      });
    }
  } catch (e) {
    logger.warn?.('[SchedulerV2] snapshot store skipped:', e?.message || e);
  }

  try {
    await refreshAnalyticsMaterializedViews();
    logger.info?.('[SchedulerV2] refreshed analytics materialized views');
  } catch (e) {
    logger.warn?.('[SchedulerV2] refresh MVs skipped:', e?.message || e);
  }

  try {
    await pool.query('SELECT fn_rule_weights_maintenance(6)');
  } catch {}
}

export function startSchedulerV2(logger = console) {
  maintenance(logger)
    .then(async () => {
      const w = await maintainAndGetCurrentWindow();
      logger.info?.(
        '[SchedulerV2] Current window:',
        w ? { id: w.id, idx: w.window_idx, start_at: w.start_at, end_at: w.end_at } : 'none'
      );
    })
    .catch((e) => logger.error?.('[SchedulerV2] Initial maintenance failed:', e));

  const task = cron.schedule(CRON_SCHEDULE, async () => {
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
  });

  return task;
}
