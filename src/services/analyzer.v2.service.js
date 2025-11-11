import { pool } from '../config/db.config.js';
import {
  maintainAndGetCurrentWindow,
  canPredict,
  markPredictedNow,
  updateStreak,
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
import { getHistoricalReversalBias } from './trend.bias.service.js';

const ANALYZE_LOCK_KEY = Number(process.env.ANALYZE_LOCK_KEY || 972115);

async function withAnalyzeLock(fn, logger = console) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [
      ANALYZE_LOCK_KEY,
    ]);
    if (!rows?.[0]?.got) {
      logger.log?.('[AnalyzerV2] skipped (lock held)');
      return null;
    }
    return await fn(client);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ANALYZE_LOCK_KEY]);
    } catch {}
    client.release();
  }
}

/**
 * Get images that have stats but no predictions yet
 * This ensures we only create predictions for images that don't have one yet
 */
async function getImagesNeedingPrediction(windowId, limit = 1) {
  const { rows } = await pool.query(
    `SELECT s.image_id, s.result, s.screen_shot_time
     FROM image_stats s
     LEFT JOIN predictions p ON p.based_on_image_id = s.image_id
     JOIN windows w ON w.start_at <= s.screen_shot_time AND w.end_at > s.screen_shot_time
     WHERE w.id = $1
       AND p.id IS NULL
     ORDER BY s.screen_shot_time ASC
     LIMIT $2`,
    [windowId, limit]
  );
  return rows;
}

/**
 * Check if AI is currently active for this window
 * AI is active if there's an AI prediction that hasn't been evaluated yet (no 'correct' field)
 * This blocks local predictions until the AI prediction is evaluated
 */
async function isAIActive(windowId) {
  const { rows } = await pool.query(
    `SELECT 1
     FROM predictions
     WHERE window_id = $1
       AND source = 'ai'
       AND (prediction ? 'correct') = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [windowId]
  );
  return rows.length > 0;
}

export async function analyzeV2(logger = console) {
  return withAnalyzeLock(async () => {
    const now = new Date();
    logger.log?.(`\n🧠 [AnalyzerV2] Tick at ${now.toISOString()}`);

    const window = await maintainAndGetCurrentWindow();
    if (!window) {
      logger.log?.('[AnalyzerV2] ❌ No active window found.');
      return null;
    }

    const { id: windowId } = window;

    // Check if there are images that need predictions
    const imagesNeedingPrediction = await getImagesNeedingPrediction(windowId, 1);
    if (!imagesNeedingPrediction.length) {
      logger.log?.('[AnalyzerV2] No images needing prediction.');
      return null;
    }

    const imageData = imagesNeedingPrediction[0];
    const imageId = imageData.image_id;

    // Check if prediction already exists for this image (double-check)
    const { rows: predCheck } = await pool.query(
      `SELECT 1 FROM predictions WHERE based_on_image_id = $1 LIMIT 1`,
      [imageId]
    );
    if (predCheck.length) {
      logger.log?.(`[AnalyzerV2] Prediction already exists for image=${imageId}`);
      return null;
    }

    await pool.query(`SELECT id FROM windows WHERE id = $1 FOR UPDATE`, [windowId]);

    // Check if AI is active - if yes, block local predictions
    const aiActive = await isAIActive(windowId);
    if (aiActive) {
      logger.log?.('[AnalyzerV2] ⏸️ AI is active, blocking local predictions');
      return null;
    }

    const can = await canPredict(windowId, { channel: 'local' });
    if (!can.can) {
      logger.log?.(`[AnalyzerV2] ⏸️ Prediction blocked (${can.reason}) until ${can.until}`);
      return null;
    }

    const { pattern, metrics } = await detectAndSetPattern(windowId);
    logger.log?.(`[AnalyzerV2] Active Pattern = ${pattern}`, metrics);

    let reactivation = null;
    try {
      const { rows: sigRows } = await pool.query(`SELECT fn_snapshot_signature_48h(now()) AS sig`);
      const sig = sigRows?.[0]?.sig || null;

      if (sig) {
        const { rows: matchRows } = await pool.query(
          `SELECT snapshot_id, similarity
     FROM fn_match_pattern_snapshots($1::jsonb, 1)`,
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

    if (!reversalSignal) {
      try {
        const bias = await getHistoricalReversalBias(window.window_idx, {
          minEvents: 8,
          minRatePct: 55,
        });
        if (bias?.color || bias?.size) {
          trendDetail = {
            ...trendDetail,
            ...(bias.color
              ? {
                  color: {
                    from_cluster: null,
                    to_cluster: bias.color.to_cluster,
                    delta: null,
                    source: 'historical',
                  },
                }
              : {}),
            ...(bias.size
              ? { size: { from: null, to: bias.size.to, delta: null, source: 'historical' } }
              : {}),
          };
        }
      } catch {}
    }

    if (reversalSignal && trendDetail) {
      try {
        await pool.query(
          `INSERT INTO trend_reversal_events (
         window_id, window_idx, event_time,
         color_from, color_to, color_delta,
         size_from, size_to, size_delta
       )
       VALUES ($1,$2, now(), $3,$4,$5, $6,$7,$8)`,
          [
            window.id,
            Number(window.window_idx),
            trendDetail.color?.from_cluster || null,
            trendDetail.color?.to_cluster || null,
            trendDetail.color?.delta ?? null,
            trendDetail.size?.from || null,
            trendDetail.size?.to || null,
            trendDetail.size?.delta ?? null,
          ]
        );
      } catch (e) {
        logger.warn?.('[AnalyzerV2] failed to log trend_reversal_event:', e?.message || e);
      }
    }

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
        const aiCan = await canPredict(windowId, { channel: 'ai' });
        if (aiCan.can) {
          logger.log?.('[AnalyzerV2] 🤖 AI Trigger activated. Reason:', aiGate.reason);
          try {
            // AI creates prediction for the same image
            prediction = await analyzeLatestUnprocessed(logger);
            if (prediction) {
              source = 'ai';
              logger.log?.('[AnalyzerV2] ✅ AI prediction generated successfully');
            } else {
              // AI failed, but we still need a prediction for this image
              // Create local prediction instead
              logger.warn?.('[AnalyzerV2] AI prediction returned null, using local prediction');
              const lp = await localPredict({ windowId, context: baseContext });
              if (lp?.allowed) {
                prediction = lp;
                source = 'local';
              } else {
                logger.log?.('[AnalyzerV2] Local gated:', lp?.reason, lp?.until || '');
                return null; // nothing to do this tick
              }
            }
          } catch (aiError) {
            logger.error?.('[AnalyzerV2] AI prediction failed:', aiError?.message || aiError);
            logger.error?.('[AnalyzerV2] AI error stack:', aiError?.stack);
            // AI failed, create local prediction for this image
            logger.log?.('[AnalyzerV2] Falling back to local prediction due to AI error');
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
          // AI can't predict, use local
          logger.log?.('[AnalyzerV2] AI gated:', aiCan.reason, aiCan.until || '');
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
        // AI not triggered, use local prediction
        logger.log?.('[AnalyzerV2] AI not triggered. Reason:', aiGate?.reason || 'unknown');
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
      logger.error?.('[AnalyzerV2] Error stack:', e?.stack);
      return null;
    }

    if (!prediction) {
      logger.log?.('[AnalyzerV2] No prediction produced.');
      return null;
    }

    // Final check: make sure no prediction exists for this image (race condition protection)
    const { rows: finalCheck } = await pool.query(
      `SELECT 1 FROM predictions WHERE based_on_image_id = $1 LIMIT 1`,
      [imageId]
    );
    if (finalCheck.length) {
      logger.log?.('[AnalyzerV2] Duplicate prevented: prediction exists for image after lock.');
      return null;
    }

    // Insert prediction with based_on_image_id to ensure 1 prediction per image
    const { rows: ins } = await pool.query(
      `
  INSERT INTO predictions (based_on_image_id, summary, prediction, source, window_id)
  VALUES ($5, $2::jsonb, $3::jsonb, $4::text, $1::bigint)
  ON CONFLICT (based_on_image_id) DO NOTHING
  RETURNING id
  `,
      [
        windowId,
        JSON.stringify({
          window_id: windowId,
          image_id: imageId,
          pattern,
          metrics,
          source,
          reactivation,
          deviationSignal,
          reversalSignal,
          trendDetail,
        }),
        JSON.stringify(prediction),
        source,
        imageId,
      ]
    );

    const predId = ins?.[0]?.id;
    if (!predId) {
      logger.error?.('[AnalyzerV2] Insert failed unexpectedly - no ID returned.');
      return null;
    }

    await markPredictedNow(windowId);

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
  }, logger);
}

export async function handleOutcome(
  actualResult,
  prevResult,
  correct,
  source = 'local',
  { windowId = null, spinTs = null } = {}
) {
  let w = null;

  if (Number.isFinite(windowId)) {
    const { rows } = await pool.query(`SELECT * FROM windows WHERE id=$1`, [windowId]);
    w = rows[0] || null;
  } else if (spinTs) {
    const { rows } = await pool.query(
      `SELECT *
         FROM windows
        WHERE start_at <= $1 AND end_at > $1
        ORDER BY id DESC
        LIMIT 1`,
      [new Date(spinTs)]
    );
    w = rows[0] || null;
  } else {
    w = await maintainAndGetCurrentWindow();
  }
  if (!w) return;

  await updateStreak(w.id, { correct, source });

  if (Number.isFinite(prevResult) && Number.isFinite(actualResult)) {
    await pool.query(
      `INSERT INTO number_transitions (from_n, to_n, count, last_seen)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (from_n, to_n)
       DO UPDATE SET count = number_transitions.count + 1,
                     last_seen = now()`,
      [prevResult, actualResult]
    );

    await pool.query(
      `INSERT INTO number_transitions_windowed (from_n, to_n, window_idx, count, last_seen)
       VALUES ($1, $2, $3, 1, now())
       ON CONFLICT (from_n, to_n, window_idx)
       DO UPDATE SET count = number_transitions_windowed.count + 1,
                     last_seen = now()`,
      [prevResult, actualResult, Number(w.window_idx)]
    );

    try {
      const nextWindow = (Number(w.window_idx) + 1) % 12;
      await pool.query(
        `INSERT INTO window_number_followups (from_window, from_n, to_window, to_n, count, last_seen)
         VALUES ($1,$2,$3,$4,1, now())
         ON CONFLICT (from_window, from_n, to_window, to_n)
         DO UPDATE SET count = window_number_followups.count + 1,
                       last_seen = now()`,
        [Number(w.window_idx), Number(prevResult), nextWindow, Number(actualResult)]
      );
    } catch (e) {
      console.warn('[handleOutcome] failed to update window_number_followups:', e?.message);
    }
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
    console.log('[handleOutcome] snapshot EMA error:', e?.message || e);
  }
}
