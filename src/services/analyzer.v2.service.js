// services/analyzer.v2.service.js
import { pool } from '../config/db.config.js';
import {
  maintainAndGetCurrentWindow,
  canPredict,
  markPredictedNow,
  updateStreak,
  attachPredictionWindow,
  fetchWindowState,
  setReactivationState,
  clearReactivationState,
} from './window.service.js';
import { detectAndSetPattern } from './pattern.detector.js';
import { localPredict, shouldTriggerAI } from './prediction.engine.js';
import { pushAnalytics } from '../analytics/analytics.ws.js';
import { analyzeLatestUnprocessed } from './analyzer.ai.service.js';
import { detectFrequencyDeviation } from './deviation.service.js';
import { detectTrendReversal } from './trend.service.js';

export async function analyzeV2(logger = console) {
  const now = new Date();
  logger.log?.(`\n🧠 [AnalyzerV2] Tick at ${now.toISOString()}`);

  const window = await maintainAndGetCurrentWindow();
  if (!window) {
    logger.log?.('[AnalyzerV2] ❌ No active window found.');
    return null;
  }

  const { id: windowId } = window;
  const can = await canPredict(windowId, { channel: 'local' });
  if (!can.can) {
    logger.log?.(`[AnalyzerV2] ⏸️ Prediction blocked (${can.reason}) until ${can.until}`);
    return null;
  }

  const { pattern, metrics } = await detectAndSetPattern(windowId);
  logger.log?.(`[AnalyzerV2] Active Pattern = ${pattern}`, metrics);

  // ---- 48h pattern reactivation: compute signature, match & load top_pool ----
  // ---- 48h pattern reactivation: compute signature, match & load top_pool ----
  let reactivation = null;
  try {
    const { rows: sigRows } = await pool.query(`SELECT fn_snapshot_signature_48h(now()) AS sig`);
    const sig = sigRows?.[0]?.sig || null;

    if (sig) {
      const { rows: matchRows } = await pool.query(
        `SELECT m.snapshot_id, m.similarity
     FROM fn_match_pattern_snapshots($1::jsonb, 1)
          AS m(snapshot_id bigint, similarity numeric)`,
        [sig]
      );
      const best = matchRows?.[0] || null;

      if (best && Number(best.similarity) >= 0.75) {
        const { rows: snapRows } = await pool.query(
          `SELECT id, top_pool FROM pattern_snapshots WHERE id = $1 LIMIT 1`,
          [best.snapshot_id]
        );
        const snap = snapRows?.[0] || null;

        reactivation = {
          snapshot_id: Number(best.snapshot_id),
          similarity: Number(best.similarity),
          snapshot_top_pool: Array.isArray(snap?.top_pool)
            ? snap.top_pool.map((n) => Number(n)).filter((n) => n >= 0 && n <= 27)
            : [],
        };
        logger.log?.('[AnalyzerV2] 🔁 Reactivation candidate:', reactivation);
      }
    }

    // persist / clear reactivation state
    if (reactivation && Number(reactivation.similarity) >= 0.75) {
      await setReactivationState(windowId, {
        snapshotId: reactivation.snapshot_id,
        similarity: reactivation.similarity,
      });
    } else {
      await clearReactivationState(windowId);
    }
  } catch (e) {
    logger.warn?.('[AnalyzerV2] snapshot match skipped:', e?.message || e);
  }

  // Deviation (spikes/drops)
  let deviationSignal = false;
  try {
    const dev = await detectFrequencyDeviation();
    deviationSignal = Boolean(
      dev?.is_spike_or_drop || dev?.spike || dev?.drop || dev?.reversal || dev?.deviation
    );
    if (deviationSignal) logger.log?.('[AnalyzerV2] ⚠️ Frequency deviation detected.');
  } catch (e) {
    logger.warn?.('[AnalyzerV2] deviation detection failed:', e?.message || e);
  }

  // Trend reversal (Warm↔Cool, size small↔big)
  let reversalSignal = false;
  let trendDetail = null;
  try {
    const rev = await detectTrendReversal();
    reversalSignal = !!rev?.reversal;
    trendDetail = rev || null;
    if (reversalSignal) logger.log?.('[AnalyzerV2] 🔄 Trend reversal detected.', rev);
  } catch (e) {
    logger.warn?.('[AnalyzerV2] trend reversal detect failed:', e?.message || e);
  }

  // AI trigger decision
  const s = await fetchWindowState(windowId);
  const aiGate = await shouldTriggerAI({
    windowState: {
      id: s?.id,
      status: s?.status,
      first_predict_after: s?.first_predict_after,
    },
    patternState: {
      wrong_streak: s?.wrong_streak,
      pattern_code: s?.pattern_code,
    },
    deviationSignal,
    reversalSignal,
  });

  let prediction = null;
  let source = 'local';
  const baseContext = {
    window_idx: Number(window.window_idx),
    ...(trendDetail ? { trend: trendDetail } : {}),
    ...(reactivation
      ? {
          reactivation: {
            similarity: reactivation.similarity,
            snapshot_top_pool: reactivation.snapshot_top_pool,
          },
        }
      : {}),
  };

  try {
    if (aiGate?.trigger) {
      // AI requested → check AI channel gate
      const aiCan = await canPredict(windowId, { channel: 'ai' });
      if (aiCan.can) {
        logger.log?.('[AnalyzerV2] 🤖 AI Trigger activated.');
        prediction = await analyzeLatestUnprocessed(logger);
        source = 'ai';
      } else {
        logger.log?.('[AnalyzerV2] AI gated:', aiCan.reason, aiCan.until || '');
        // 🔁 FALL BACK TO LOCAL
        const lp = await localPredict({ windowId, context: baseContext });
        if (lp?.allowed) {
          prediction = lp;
          source = 'local';
        } else {
          logger.log?.('[AnalyzerV2] Local gated:', lp?.reason, lp?.until || '');
          return null; // nothing to do this tick
        }
      }
    } else {
      // No AI trigger → go local
      const lp = await localPredict({ windowId, context: baseContext });
      if (lp?.allowed) {
        prediction = lp;
        source = 'local';
      } else {
        logger.log?.('[AnalyzerV2] Local gated:', lp?.reason, lp?.until || '');
        return null;
      }
    }
  } catch (e) {
    logger.error?.('[AnalyzerV2] Prediction generation failed', e);
    return null;
  }

  if (!prediction) {
    logger.log?.('[AnalyzerV2] No prediction produced.');
    return null;
  }

  // Persist prediction
  const { rows } = await pool.query(
    `INSERT INTO predictions (based_on_image_id, summary, prediction)
     VALUES (NULL, $1::jsonb, $2::jsonb)
     RETURNING id`,
    [
      JSON.stringify({
        window_id: windowId,
        pattern,
        metrics,
        source,
        reactivation,
        deviationSignal,
        reversalSignal,
        trendDetail,
      }),
      JSON.stringify(prediction),
    ]
  );

  const predId = rows?.[0]?.id;
  if (predId) {
    await attachPredictionWindow(predId, windowId, source);
    await markPredictedNow(windowId);
  }

  // WS broadcast
  try {
    pushAnalytics('analytics/prediction', {
      window_id: windowId,
      pattern,
      source,
      prediction,
      reactivation,
      deviationSignal,
      reversalSignal,
      trendDetail,
      ts: new Date().toISOString(),
    });
  } catch {}

  logger.log?.(`[AnalyzerV2] ✅ Prediction via ${source}:`, {
    pattern,
    source,
    top: prediction.top5 || prediction.top_candidates?.slice?.(0, 5),
    reactivation,
    deviationSignal,
    reversalSignal,
  });

  return {
    window,
    pattern,
    prediction,
    source,
    reactivation,
    deviationSignal,
    reversalSignal,
    trendDetail,
  };
}

export async function handleOutcome(actualResult, prevResult, correct, source = 'local') {
  const w = await maintainAndGetCurrentWindow();
  if (!w) return;

  await updateStreak(w.id, { correct, source });

  if (Number.isFinite(prevResult) && Number.isFinite(actualResult)) {
    // Global transitions
    await pool.query(
      `INSERT INTO number_transitions (from_n, to_n, count, last_seen)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (from_n, to_n)
       DO UPDATE SET count = number_transitions.count + 1,
                     last_seen = now()`,
      [prevResult, actualResult]
    );

    // Window-aware transitions
    await pool.query(
      `INSERT INTO number_transitions_windowed (from_n, to_n, window_idx, count, last_seen)
       VALUES ($1, $2, $3, 1, now())
       ON CONFLICT (from_n, to_n, window_idx)
       DO UPDATE SET count = number_transitions_windowed.count + 1,
                     last_seen = now()`,
      [prevResult, actualResult, Number(w.window_idx)]
    );
  }

  try {
    const { rows: pr } = await pool.query(
      `SELECT (summary->'reactivation'->>'snapshot_id') AS snapshot_id_txt
       FROM predictions
      WHERE window_id = $1
      ORDER BY id DESC
      LIMIT 1`,
      [w.id]
    );

    const raw = pr?.[0]?.snapshot_id_txt;
    if (raw == null) return;

    const snapId = Number(raw);
    if (!Number.isFinite(snapId) || snapId <= 0) return;

    await pool.query(
      `INSERT INTO pattern_snapshot_outcomes (snapshot_id, predicted_at, correct)
     VALUES ($1, now(), $2)`,
      [snapId, !!correct]
    );

    await pool.query(`SELECT fn_update_snapshot_hit_rate($1, $2, $3)`, [snapId, !!correct, 0.2]);
  } catch (e) {
    console.log('error', e);
  }
}
