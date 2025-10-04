import { WebSocketServer } from 'ws';
import {
  getLatestAnchorImageId,
  advancedAnalyticsBundle,
  allStatsBundle,
  windowsSummary,
  gapStats,
  gapStatsExtended,
  ratios,
  numberPatterns,
  recentColorRuns,
  fetchRecentSpins,
  timeBucketsSnapshot,
  rangeSystemsTags,
  buildFourteenSystems,
} from '../analytics/analytics.handlers.js';

const CLIENTS = new Set();
let wss;

async function getTopicData(topic, params = {}) {
  const p = (k, def) => (Number.isFinite(Number(params[k])) ? Number(params[k]) : def);

  switch (topic) {
    case 'core': {
      const anchor = await getLatestAnchorImageId();
      const lookback = p('lookback', Number(process.env.PRED_LOOKBACK || 200));
      const topk = p('topk', Number(process.env.PRED_TOPK || 5));
      const coreStats = await allStatsBundle(anchor, lookback, topk);
      return { coreStats };
    }
    case 'windows': {
      const limitSeq = p('limitSeq', 200);
      const windows = await windowsSummary(limitSeq);
      return { windows };
    }
    case 'gaps': {
      const lookback = p('lookback', 500);
      const gaps = await gapStats(lookback);
      return { gaps };
    }
    case 'gapsExt': {
      const lookback = p('lookback', 500);
      const gaps_extended = await gapStatsExtended(lookback);
      return { gaps_extended };
    }
    case 'ratios': {
      const lookback = p('lookback', 50);
      const r = await ratios(lookback);
      return { ratios: r };
    }
    case 'patterns': {
      const lookback = p('lookback', 200);
      const patterns = await numberPatterns(lookback);
      return { patterns };
    }
    case 'colorRuns': {
      const limit = p('limit', 50);
      const color_runs = await recentColorRuns(limit);
      return { color_runs };
    }
    case 'recentSpins': {
      const limit = p('limit', 30);
      const recent_spins = await fetchRecentSpins(limit);
      return { recent_spins };
    }
    case 'timeBuckets': {
      const time_buckets = await timeBucketsSnapshot();
      return { time_buckets };
    }
    case 'rangeSystems': {
      const range_systems = await rangeSystemsTags();
      return { range_systems };
    }
    case 'fourteen': {
      const data = await buildFourteenSystems();
      return data; // { number_rules, range_systems, color_behaviour, time_buckets }
    }
    case 'bundle': {
      const anchor = await getLatestAnchorImageId();
      const lookback = p('lookback', Number(process.env.PRED_LOOKBACK || 200));
      const topk = p('topk', Number(process.env.PRED_TOPK || 5));
      const payload = await advancedAnalyticsBundle(anchor, { lookback, topk });
      return payload;
    }
    default:
      throw new Error(`unknown topic: ${topic}`);
  }
}

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

/** Mount a WS endpoint for analytics only (e.g., /ws/analytics) */
export function setupAnalyticsWS(httpServer, { path = '/ws/analytics' } = {}) {
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
    safeSend(ws, { type: 'analytics/hello', ts: Date.now() });

    // (optional) still push an initial bundle so UI has something immediately
    try {
      const anchor = await getLatestAnchorImageId();
      const bundle = await advancedAnalyticsBundle(anchor, {});
      safeSend(ws, { type: 'analytics/bundle', payload: bundle, ts: Date.now() });
    } catch (e) {
      safeSend(ws, { type: 'analytics/error', error: e?.message || String(e) });
    }

    // NEW: handle client requests for specific topics
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'analytics/get' && msg.topic) {
        try {
          const payload = await getTopicData(msg.topic, msg.params || {});
          safeSend(ws, { type: `analytics/${msg.topic}`, payload, reqId: msg.reqId });
        } catch (e) {
          safeSend(ws, { type: 'analytics/error', error: e?.message || String(e), reqId: msg.reqId });
        }
      }

      if (msg.type === 'analytics/getMany' && Array.isArray(msg.topics)) {
        for (const t of msg.topics) {
          try {
            const payload = await getTopicData(t, (msg.params || {})[t] || {});
            safeSend(ws, { type: `analytics/${t}`, payload, reqId: msg.reqId });
          } catch (e) {
            safeSend(ws, { type: 'analytics/error', error: e?.message || String(e), topic: t, reqId: msg.reqId });
          }
        }
      }
    });
  });

  // heartbeat (optional)
  const iv = setInterval(() => {
    for (const ws of CLIENTS) {
      if (ws.readyState === 1) safeSend(ws, { type: 'ping', ts: Date.now() });
    }
  }, 30_000);
  wss.on('close', () => clearInterval(iv));

  console.log(`[WS] analytics socket mounted at ${path}`);
  return wss;
}

export function pushAnalytics(eventType, payload) {
  for (const ws of CLIENTS) if (ws.readyState === 1) safeSend(ws, { type: eventType, payload, ts: Date.now() });
}

export async function pushFreshBundle() {
  try {
    const anchor = await getLatestAnchorImageId();
    const bundle = await advancedAnalyticsBundle(anchor, {});
    pushAnalytics('analytics/bundle', bundle);
  } catch (e) {
    pushAnalytics('analytics/error', { message: e?.message || String(e) });
  }
}
