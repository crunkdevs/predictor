import { WebSocketServer } from 'ws';
import { pool } from '../config/db.config.js';

import {
  maintainAndGetCurrentWindow,
  fetchWindowState,
  canPredict,
} from '../services/window.service.js';

import { detectAndSetPattern } from '../services/pattern.detector.js';
import {
  localPredict,
  identifyActivePattern,
  buildNumberPool,
  scoreAndRank,
  shouldTriggerAI,
} from '../services/prediction.engine.js';

import { analyzeV2 } from '../services/analyzer.v2.service.js';

import {
  allStatsForLatestAnchor,
  windowsSummary,
  gapStatsExtended,
  ratios,
  recentColorRuns,
  fetchRecentSpins,
  timeBucketsSnapshot,
} from './analytics.handlers.js';
import { detectTrendReversal } from '../services/trend.service.js';

const CLIENTS = new Set();
let wss;

const pnum = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

async function topicV2(topic, params = {}) {
  switch (topic) {
    case 'v2/window': {
      const w = await maintainAndGetCurrentWindow();
      if (!w) return { window: null, state: null, gate: { can: false, reason: 'no_window' } };
      const [state, gate] = await Promise.all([fetchWindowState(w.id), canPredict(w.id)]);
      return { window: w, state, gate };
    }
    case 'v2/pattern': {
      const w = await maintainAndGetCurrentWindow();
      if (!w) return { error: 'no_window' };
      const lookback = pnum(params.lookback, 120);
      const out = await detectAndSetPattern(w.id, lookback);
      return { window_id: w.id, ...out };
    }
    case 'v2/localPredict': {
      const w = await maintainAndGetCurrentWindow();
      if (!w) return { error: 'no_window' };
      const result = await localPredict({ windowId: w.id, context: {} });
      return { window_id: w.id, result };
    }
    case 'v2/aiTrigger': {
      const w = await maintainAndGetCurrentWindow();
      if (!w) return { error: 'no_window' };
      const s = await fetchWindowState(w.id);

      let deviationSignal = false;
      let reversalSignal = false;
      try {
        const { detectTrendReversal } = await import('../services/trend.service.js');
        const rev = await detectTrendReversal();
        reversalSignal = !!rev?.reversal;
      } catch {}

      const trig = await shouldTriggerAI({
        windowState: { id: s.id, status: s.status, first_predict_after: s.first_predict_after },
        patternState: { wrong_streak: s.wrong_streak, pattern_code: s.pattern_code },
        deviationSignal,
        reversalSignal,
      });

      try {
        pushAnalyticsV2('analytics-v2/ai-trigger', {
          window_id: w.id,
          trigger: trig, // { trigger: boolean, reason: string }
          deviationSignal,
          reversalSignal,
          ts: new Date().toISOString(),
        });
      } catch {}

      return { window_id: w.id, trigger: trig };
    }

    case 'v2/deviation': {
      try {
        const { detectFrequencyDeviation } = await import('../services/deviation.service.js');
        const deviation = await detectFrequencyDeviation();
        return { deviation };
      } catch (e) {
        return { error: e?.message || 'failed to detect deviation' };
      }
    }
    case 'v2/trend': {
      try {
        const shortM = pnum(params.shortM, undefined);
        const longM = pnum(params.longM, undefined);
        const delta = typeof params.delta === 'number' ? params.delta : undefined;
        const trend = await detectTrendReversal({ shortM, longM, delta });
        return { trend };
      } catch (e) {
        return { error: e?.message || 'failed to detect trend reversal' };
      }
    }
    case 'v2/observation': {
      const w = await maintainAndGetCurrentWindow();
      if (!w) return { error: 'no_window' };
      const s = await fetchWindowState(w.id);
      const observing =
        s.mode === 'observe' || (s.paused_until && new Date(s.paused_until) > new Date());
      return { window_id: w.id, mode: s.mode || 'normal', observing, paused_until: s.paused_until };
    }
    case 'v2/scoringPreview': {
      const w = await maintainAndGetCurrentWindow();
      if (!w) return { error: 'no_window' };

      const { pattern_code } = await identifyActivePattern({});

      const { rows } = await fetchRecentSpins(30).then((r) => ({
        rows: r.map((x) => ({ result: x.result })),
      }));
      const seqAsc = rows.map((r) => Number(r.result)).reverse();
      const last = seqAsc.at(-1);
      const candidatePool = await buildNumberPool({ last, pattern_code, context: {} });
      const ranked = await scoreAndRank(candidatePool, {});
      const top5 = ranked.slice(0, 5).map((r) => r.n);
      const pool = ranked.slice(5, 13).map((r) => r.n);
      return {
        window_id: w.id,
        last,
        pool,
        ranked,
        top5,
      };
    }
    case 'v2/runAnalyzeTick': {
      const out = await analyzeV2(console);
      return { out };
    }
    case 'v2/transitions': {
      const from = pnum(params.from, undefined);
      const win = pnum(params.window, undefined);
      if (!Number.isFinite(from)) return { error: 'from required' };

      if (Number.isFinite(win)) {
        const { rows } = await pool.query(
          `SELECT from_n, to_n, window_idx, count, last_seen
         FROM number_transitions_windowed
        WHERE from_n=$1 AND window_idx=$2
        ORDER BY count DESC, to_n ASC
        LIMIT 50`,
          [from, win]
        );
        return { rows };
      } else {
        const { rows } = await pool.query(
          `SELECT from_n, to_n, count, last_seen
         FROM number_transitions
        WHERE from_n=$1
        ORDER BY count DESC, to_n ASC
        LIMIT 50`,
          [from]
        );
        return { rows };
      }
    }

    case 'v2/reactivation': {
      const { rows: sigRows } = await pool.query(`SELECT fn_snapshot_signature_48h(now()) AS sig`);
      const sig = sigRows?.[0]?.sig || null;
      if (!sig) return { match: null };

      const { rows: matchRows } = await pool.query(
        `SELECT snapshot_id, similarity
   FROM fn_match_pattern_snapshots($1::jsonb, 1)`,
        [sig]
      );
      const best = matchRows?.[0] || null;
      if (!best) return { match: null };

      const { rows: snapRows } = await pool.query(
        `SELECT id, start_at, end_at, sample_size, top_pool, hit_rate, created_at
       FROM pattern_snapshots
      WHERE id = $1
      LIMIT 1`,
        [best.snapshot_id]
      );

      try {
        pushAnalyticsV2('analytics-v2/reactivation-probe', {
          snapshot_id: Number(best.snapshot_id),
          similarity: Number(best.similarity),
          top_pool: Array.isArray(snapRows?.[0]?.top_pool) ? snapRows[0].top_pool : [],
          ts: new Date().toISOString(),
        });
      } catch {}

      return {
        match: {
          snapshot: snapRows?.[0] || null,
          similarity: Number(best.similarity),
        },
      };
    }

    case 'v2/status': {
      const w = await maintainAndGetCurrentWindow();
      if (!w) return { window: null, gate: { can: false, reason: 'no_window' } };

      const state = await fetchWindowState(w.id);

      let deviation = null;
      try {
        const { detectFrequencyDeviation } = await import('../services/deviation.service.js');
        deviation = await detectFrequencyDeviation();
      } catch {}

      let trend = null;
      try {
        const { detectTrendReversal } = await import('../services/trend.service.js');
        trend = await detectTrendReversal();
      } catch {}

      let react = null;
      try {
        const { rows: sigRows } = await pool.query(
          `SELECT fn_snapshot_signature_48h(now()) AS sig`
        );
        const sig = sigRows?.[0]?.sig || null;
        if (sig) {
          const { rows: matchRows } = await pool.query(
            `SELECT snapshot_id, similarity
    FROM fn_match_pattern_snapshots($1::jsonb, 1)`,
            [sig]
          );
          const best = matchRows?.[0] || null;
          if (best)
            react = { snapshot_id: Number(best.snapshot_id), similarity: Number(best.similarity) };
        }
      } catch {}

      const gate = await canPredict(w.id);

      try {
        pushAnalyticsV2('analytics-v2/status', {
          window: { id: w.id, idx: w.window_idx, start_at: w.start_at, end_at: w.end_at },
          mode: state.mode || 'normal',
          gate,
          deviation: deviation || {},
          reversal: trend || {},
          reactivation: react,
          ts: new Date().toISOString(),
        });
      } catch {}

      return {
        window: { id: w.id, window_idx: w.window_idx, start_at: w.start_at, end_at: w.end_at },
        mode: state.mode || 'normal',
        gate,
        deviation: deviation || {},
        reversal: trend || {},
        reactivation: react,
      };
    }

    case 'v2/coreBundle': {
      const lookback = pnum(params.lookback, 200);
      const [coreStats, gaps_extended, r, color_runs, recent_spins, time_buckets, windows] =
        await Promise.all([
          allStatsForLatestAnchor(lookback, pnum(params.topk, 8)),
          gapStatsExtended(Math.max(lookback, 500)),
          ratios(Math.min(lookback, 200)),
          recentColorRuns(pnum(params.crLimit, 50)),
          fetchRecentSpins(pnum(params.rsLimit, 30)),
          timeBucketsSnapshot(),
          windowsSummary(pnum(params.wsLimit, 200)),
        ]);
      return {
        coreStats,
        gaps_extended,
        ratios: r,
        color_runs,
        recent_spins,
        time_buckets,
        windows,
      };
    }

    default:
      throw new Error(`unknown v2 topic: ${topic}`);
  }
}

function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}

export function setupAnalyticsV2WS(httpServer, { path = '/ws/analytics-v2' } = {}) {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith(path)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws) => {
    CLIENTS.add(ws);
    ws.on('close', () => CLIENTS.delete(ws));
    safeSend(ws, { type: 'analytics-v2/hello', ts: Date.now() });

    try {
      const first = await topicV2('v2/window', {});
      safeSend(ws, { type: 'analytics-v2/window', payload: first, ts: Date.now() });
    } catch (e) {
      safeSend(ws, { type: 'analytics-v2/error', error: e?.message || String(e) });
    }

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'analytics-v2/get' && msg.topic) {
        try {
          const payload = await topicV2(msg.topic, msg.params || {});
          safeSend(ws, { type: `analytics-v2/${msg.topic}`, payload, reqId: msg.reqId });
        } catch (e) {
          safeSend(ws, {
            type: 'analytics-v2/error',
            error: e?.message || String(e),
            reqId: msg.reqId,
          });
        }
      }

      if (msg.type === 'analytics-v2/getMany' && Array.isArray(msg.topics)) {
        for (const t of msg.topics) {
          try {
            const payload = await topicV2(t, (msg.params || {})[t] || {});
            safeSend(ws, { type: `analytics-v2/${t}`, payload, reqId: msg.reqId });
          } catch (e) {
            safeSend(ws, {
              type: 'analytics-v2/error',
              error: e?.message || String(e),
              topic: t,
              reqId: msg.reqId,
            });
          }
        }
      }
    });
  });

  const iv = setInterval(() => {
    for (const ws of CLIENTS) {
      if (ws.readyState === 1) safeSend(ws, { type: 'ping', ts: Date.now() });
    }
  }, 30_000);
  wss.on('close', () => clearInterval(iv));

  console.log(`[WS] analytics-v2 socket mounted at ${path}`);
  return wss;
}

export function pushAnalyticsV2(eventType, payload) {
  for (const ws of CLIENTS)
    if (ws.readyState === 1) safeSend(ws, { type: eventType, payload, ts: Date.now() });
}
