// src/analytics/analytics.v2.ws.js
import { WebSocketServer } from 'ws';

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
      const trig = await shouldTriggerAI({
        windowState: { id: s.id, status: s.status, first_predict_after: s.first_predict_after },
        patternState: { wrong_streak: s.wrong_streak, pattern_code: s.pattern_code },
        deviationSignal: false,
      });
      return { window_id: w.id, trigger: trig };
    }
    case 'v2/scoringPreview': {
      const w = await maintainAndGetCurrentWindow();
      if (!w) return { error: 'no_window' };
      const { pattern_code, scores } = await identifyActivePattern({});
      const { rows } = await fetchRecentSpins(30).then((r) => ({
        rows: r.map((x) => ({ result: x.result })),
      }));
      const seqAsc = rows.map((r) => Number(r.result)).reverse();
      const last = seqAsc.at(-1);
      const poolNums = await buildNumberPool({ last, pattern_code, context: {} });
      const ranked = await scoreAndRank(poolNums, {});
      return {
        window_id: w.id,
        pattern_code,
        pattern_scores: scores,
        last,
        pool: poolNums,
        ranked,
        top3: ranked.slice(0, 3).map((r) => r.n),
      };
    }
    case 'v2/runAnalyzeTick': {
      const out = await analyzeV2(console);
      return { out };
    }

    // optional: bundle fragments reused by dashboards
    case 'v2/coreBundle': {
      const lookback = pnum(params.lookback, 200);
      const [coreStats, gaps_extended, r, color_runs, recent_spins, time_buckets, windows] =
        await Promise.all([
          allStatsForLatestAnchor(lookback, pnum(params.topk, 5)),
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

    // send immediate snapshot
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

// helper: let services push live prediction events to v2 clients as well
export function pushAnalyticsV2(eventType, payload) {
  for (const ws of CLIENTS)
    if (ws.readyState === 1) safeSend(ws, { type: eventType, payload, ts: Date.now() });
}
