import { WebSocketServer } from 'ws';
import {
  getLatestAnchorImageId,
  advancedAnalyticsBundle,
  refreshAnalyticsMaterializedViews,
} from '../analytics/analytics.handlers.js';

const CLIENTS = new Set();
let wss;

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

    // initial snapshot (latest anchor)
    try {
      const anchor = await getLatestAnchorImageId();
      const bundle = await advancedAnalyticsBundle(anchor, {});
      safeSend(ws, { type: 'analytics/bundle', payload: bundle, ts: Date.now() });
    } catch (e) {
      safeSend(ws, { type: 'analytics/error', error: e?.message || String(e) });
    }
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
  for (const ws of CLIENTS) {
    if (ws.readyState === 1) safeSend(ws, { type: eventType, payload, ts: Date.now() });
  }
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
