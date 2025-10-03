import { WebSocketServer } from 'ws';
import { pool } from '../config/db.config.js';
import {
  getLatestAnchorImageId,
  advancedAnalyticsBundle,
  refreshAnalyticsMaterializedViews,
  predictionLogsSummary,
  recentPredictionLogsRaw,
} from './analytics.handlers.js';

let wss;
const CLIENTS = new Set();

async function fetchAccuracyHourly(limit = 168) {
  const chk = await pool.query(
    `SELECT 1 FROM pg_matviews WHERE schemaname='public' AND matviewname='mv_accuracy_hourly'`
  );
  if (!chk.rowCount) return [];
  const { rows } = await pool.query(
    `SELECT hour_bucket, total, correct, accuracy_pct
       FROM mv_accuracy_hourly
      ORDER BY hour_bucket DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function fetchAccuracyBreakdown(limit = 168) {
  const chk = await pool.query(
    `SELECT 1 FROM pg_matviews WHERE schemaname='public' AND matviewname='mv_accuracy_breakdown'`
  );
  if (!chk.rowCount) return [];
  const { rows } = await pool.query(
    `SELECT hour_bucket, total, correct, universal_accuracy_pct, category_accuracy
       FROM mv_accuracy_breakdown
      ORDER BY hour_bucket DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function buildEnrichedBundle(anchorImageId) {
  const base = await advancedAnalyticsBundle(anchorImageId, {});
  const [accHourly, accBreak, logsRaw, logsSum] = await Promise.all([
    fetchAccuracyHourly(168),
    fetchAccuracyBreakdown(168),
    recentPredictionLogsRaw({ limit: 50 }).catch(() => []),
    predictionLogsSummary({ limit: 200 }).catch(() => null),
  ]);
  return {
    ...base,
    accuracy_hourly: accHourly,
    accuracy_breakdown: accBreak,
    prediction_logs: logsRaw,
    prediction_summary: logsSum,
  };
}

export function setupAnalyticsWS(httpServer, { path = '/ws/analytics' } = {}) {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    // tolerate trailing slash & queries
    const u = new URL(req.url, 'http://localhost');
    if (!u.pathname.startsWith(path)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    CLIENTS.add(ws);
    ws.on('close', () => CLIENTS.delete(ws));

    console.log('[WS] connected', req.socket.remoteAddress);
    safeSend(ws, { type: 'analytics/hello', ts: Date.now() });

    try {
      const anchor = await getLatestAnchorImageId();
      const bundle = await buildEnrichedBundle(anchor);
      safeSend(ws, { type: 'analytics/bundle', payload: bundle, ts: Date.now() });
    } catch (e) {
      safeSend(ws, { type: 'analytics/error', error: e?.message || String(e) });
    }
  });

  // heartbeat: terminate dead connections & keep proxies happy
  const iv = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(iv));

  console.log(`[WS] analytics socket mounted at ${path}`);
  return wss;
}

export function pushAnalytics(eventType, payload) {
  for (const ws of CLIENTS) {
    if (ws.readyState === 1) safeSend(ws, { type: eventType, payload, ts: Date.now() });
  }
}

export async function pushFreshBundle() {
  try {
    const anchor = await getLatestAnchorImageId();
    const bundle = await buildEnrichedBundle(anchor);
    pushAnalytics('analytics/bundle', bundle);
  } catch (e) {
    pushAnalytics('analytics/error', { message: e?.message || String(e) });
  }
}

export async function refreshAndPush() {
  try {
    await refreshAnalyticsMaterializedViews();
  } catch {}
  await pushFreshBundle();
}

function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}
