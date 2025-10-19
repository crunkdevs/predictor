// services/window.service.js
import { pool } from '../config/db.config.js';

const TZ = process.env.SCHEDULER_TZ || 'Asia/Shanghai';
const FIRST_PREDICT_DELAY_MIN = Number(process.env.FIRST_PREDICT_DELAY_MIN || 20);
const PAUSE_AFTER_WRONGS = Number(process.env.PRED_PAUSE_AFTER_WRONGS || 3);
const WRONG_PAUSE_MIN = Number(process.env.PRED_PAUSE_MIN || 10);

// --- Stabilization thresholds (can be tuned via env if you like)
const OBSERVE_LOOKBACK = Number(process.env.OBSERVE_LOOKBACK || 30);
const OBSERVE_MAX_RUN = Number(process.env.OBSERVE_MAX_RUN || 3);
const OBSERVE_MIN_COLORS = Number(process.env.OBSERVE_MIN_COLORS || 5);

export async function deactivatePattern(windowId) {
  if (!Number.isFinite(Number(windowId))) return;
  // flip is_active off and reset to 'A' (normal)
  await pool.query(
    `UPDATE window_pattern_state
       SET is_active = FALSE,
           updated_at = now()
     WHERE window_id = $1`,
    [windowId]
  );
  await setActivePattern(windowId, 'A');
}

export async function ensureWindowsForDay(dayDate) {
  const { rows } = await pool.query(
    `SELECT * FROM fn_ensure_windows_for_day($1::date, $2::text, $3::int)`,
    [dayDate, TZ, FIRST_PREDICT_DELAY_MIN]
  );
  return rows;
}

export async function ensureTodayWindows() {
  const { rows } = await pool.query(`SELECT (now() AT TIME ZONE $1)::date AS d`, [TZ]);
  const day = rows[0].d;
  return ensureWindowsForDay(day);
}

export async function getCurrentWindow() {
  const { rows: r1 } = await pool.query(`SELECT * FROM fn_current_window(now(), $1)`, [TZ]);
  if (!r1.length) return null;

  const day_date = r1[0].day_date;
  const window_idx = r1[0].window_idx;

  const { rows: r2 } = await pool.query(
    `SELECT * FROM windows WHERE day_date=$1 AND window_idx=$2 LIMIT 1`,
    [day_date, window_idx]
  );
  if (!r2.length) {
    await ensureWindowsForDay(day_date);
    const { rows: r3 } = await pool.query(
      `SELECT * FROM windows WHERE day_date=$1 AND window_idx=$2 LIMIT 1`,
      [day_date, window_idx]
    );
    return r3[0] || null;
  }
  return r2[0];
}

export async function getWindowById(windowId) {
  const { rows } = await pool.query(`SELECT * FROM windows WHERE id=$1`, [windowId]);
  return rows[0] || null;
}

export async function getOrCreatePatternState(windowId) {
  if (!Number.isFinite(Number(windowId))) return null;

  const { rows: got } = await pool.query(
    `SELECT * FROM window_pattern_state WHERE window_id=$1 LIMIT 1`,
    [windowId]
  );
  if (got.length) return got[0];

  const { rows: ins } = await pool.query(
    `INSERT INTO window_pattern_state (window_id, pattern_code, is_active)
     VALUES ($1, 'A', TRUE)
     RETURNING *`,
    [windowId]
  );
  return ins[0];
}

// --- NEW: stabilization check (simple & cheap)
async function isStabilized(lookback = OBSERVE_LOOKBACK) {
  const { rows } = await pool.query(
    `
    WITH recent AS (
      SELECT screen_shot_time, result_color
      FROM v_spins
      ORDER BY screen_shot_time DESC
      LIMIT $1
    ),
    base AS (
      SELECT
        screen_shot_time,
        result_color,
        CASE
          WHEN result_color = LAG(result_color) OVER (ORDER BY screen_shot_time DESC) THEN 0
          ELSE 1
        END AS is_break
      FROM recent
    ),
    w1 AS (
      SELECT
        screen_shot_time,
        result_color,
        SUM(is_break) OVER (ORDER BY screen_shot_time DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
      FROM base
    ),
    w2 AS (
      SELECT
        result_color,
        COUNT(*) OVER (PARTITION BY grp) AS run_length
      FROM w1
    )
    SELECT
      COALESCE(MAX(run_length),0)   AS max_run,
      COALESCE(COUNT(DISTINCT result_color),0) AS colors_used
    FROM w2;
  `,
    [Math.max(10, Number(lookback) || OBSERVE_LOOKBACK)]
  );
  const r = rows[0] || { max_run: 0, colors_used: 0 };
  const max_run = Number(r.max_run || 0);
  const colors_used = Number(r.colors_used || 0);
  return max_run <= OBSERVE_MAX_RUN && colors_used >= OBSERVE_MIN_COLORS;
}

export async function fetchWindowState(windowId) {
  const row = await getWindowById(windowId);
  if (!row) return null;

  const ps = await getOrCreatePatternState(windowId);

  return {
    id: row.id,
    status: row.status,
    start_at: row.start_at,
    end_at: row.end_at,
    first_predict_after: row.first_predict_after,
    active_pattern: row.active_pattern,
    pattern_code: ps?.pattern_code || row.active_pattern || 'A',
    wrong_streak: Number(ps?.wrong_streak || 0),
    correct_streak: Number(ps?.correct_streak || 0),
    paused_until: ps?.paused_until || null,
    last_predicted_at: ps?.last_predicted_at || null,
    // --- NEW: expose mode
    mode: ps?.mode || 'normal',
  };
}

// --- NEW: helpers to flip modes
export async function setMode(windowId, mode) {
  await pool.query(`UPDATE window_pattern_state SET mode=$2, updated_at=now() WHERE window_id=$1`, [
    windowId,
    String(mode),
  ]);
}

export async function enterObserveMode(windowId) {
  await setMode(windowId, 'observe');
  return 'observe';
}

export async function tryExitObserveIfStabilized(windowId) {
  const ok = await isStabilized();
  if (ok) {
    await setMode(windowId, 'normal');
    await pool.query(
      `UPDATE window_pattern_state
        SET is_active = TRUE,
            updated_at = now()
      WHERE window_id = $1`,
      [windowId]
    );
  }
  return ok;
}

export async function canPredict(windowId) {
  const ws = await fetchWindowState(windowId);
  if (!ws) return { can: false, reason: 'no_window' };

  const now = new Date();

  if (ws.status !== 'open') {
    return { can: false, reason: 'window_closed', until: ws.end_at };
  }
  if (now < new Date(ws.first_predict_after)) {
    return { can: false, reason: 'before_first_predict_after', until: ws.first_predict_after };
  }

  // --- NEW: mode transitions & gating
  // If paused_until has expired and mode is still 'paused' -> move to 'observe'
  if (ws.paused_until && now >= new Date(ws.paused_until) && ws.mode === 'paused') {
    await setMode(windowId, 'observe');
    // refresh local state
    ws.mode = 'observe';
  }

  // Block predictions in 'paused'
  if (ws.paused_until && now < new Date(ws.paused_until)) {
    return { can: false, reason: 'paused', until: ws.paused_until };
  }

  // In observe: only allow predictions once stabilized
  if (ws.mode === 'observe') {
    const ok = await tryExitObserveIfStabilized(windowId);
    if (!ok) return { can: false, reason: 'observe' };
    // if stabilized, fall-through with mode='normal'
  }

  return { can: true };
}

export async function pausePattern(windowId, minutes = WRONG_PAUSE_MIN) {
  const ms = Math.max(1, Number(minutes)) * 60 * 1000;
  const until = new Date(Date.now() + ms).toISOString();
  await pool.query(
    `UPDATE window_pattern_state
       SET paused_until = $2, mode='paused', updated_at = now()
     WHERE window_id = $1`,
    [windowId, until]
  );
  return until;
}

export async function updateStreak(windowId, { correct }) {
  const ps = await getOrCreatePatternState(windowId);
  let wrong = Number(ps.wrong_streak || 0);
  let corr = Number(ps.correct_streak || 0);

  if (correct === true) {
    corr += 1;
    wrong = 0;
  } else if (correct === false) {
    wrong += 1;
    corr = 0;
  }

  const { rows } = await pool.query(
    `UPDATE window_pattern_state
        SET wrong_streak=$2,
            correct_streak=$3,
            updated_at=now()
      WHERE window_id=$1
      RETURNING *`,
    [windowId, wrong, corr]
  );

  const updated = rows[0];

  if (wrong >= PAUSE_AFTER_WRONGS) {
    await pausePattern(windowId, WRONG_PAUSE_MIN);
    await deactivatePattern(windowId);
    await setActivePattern(windowId, 'Unknown');
    // Note: mode is set to 'paused' in pausePattern(); after expiry canPredict() shifts to 'observe'
  }

  return updated;
}

export async function markPredictedNow(windowId) {
  const { rows } = await pool.query(
    `UPDATE window_pattern_state
        SET last_predicted_at = now(), updated_at = now()
      WHERE window_id = $1
      RETURNING *`,
    [windowId]
  );
  return rows[0] || null;
}

export async function setActivePattern(windowId, code = 'A') {
  await pool.query(`UPDATE windows SET active_pattern=$2, updated_at=now() WHERE id=$1`, [
    windowId,
    String(code || 'A'),
  ]);
  await pool.query(
    `UPDATE window_pattern_state SET pattern_code=$2, updated_at=now() WHERE window_id=$1`,
    [windowId, String(code || 'A')]
  );
}

export async function recordTransition(fromN, toN) {
  if (!Number.isFinite(fromN) || !Number.isFinite(toN)) return;
  fromN = Math.max(0, Math.min(27, Number(fromN) | 0));
  toN = Math.max(0, Math.min(27, Number(toN) | 0));

  await pool.query(
    `INSERT INTO number_transitions (from_n, to_n, count, last_seen)
     VALUES ($1,$2,1, now())
     ON CONFLICT (from_n, to_n)
     DO UPDATE SET count = number_transitions.count + 1,
                   last_seen = EXCLUDED.last_seen`,
    [fromN, toN]
  );
}

export async function attachPredictionWindow(predictionId, windowId, source = 'local') {
  if (!Number.isFinite(Number(predictionId)) || !Number.isFinite(Number(windowId))) return;
  await pool.query(
    `UPDATE predictions
        SET window_id=$2,
            source = COALESCE($3, source),
            updated_at = now()
      WHERE id=$1`,
    [predictionId, windowId, source]
  );
}

export async function closeExpiredWindows() {
  await pool.query(
    `UPDATE windows
        SET status='closed', updated_at=now()
      WHERE status='open' AND end_at <= now()`
  );
}

export async function maintainAndGetCurrentWindow() {
  await ensureTodayWindows();
  await closeExpiredWindows();
  const w = await getCurrentWindow();
  return w;
}

export async function setReactivationState(windowId, { snapshotId, similarity }) {
  if (!Number.isFinite(windowId)) return;
  await pool.query(
    `UPDATE window_pattern_state
       SET react_active = TRUE,
           react_snapshot_id = $2,
           react_similarity = $3,
           react_started_at = COALESCE(react_started_at, now()),
           updated_at = now()
     WHERE window_id = $1`,
    [Number(windowId), Number(snapshotId) || null, Number(similarity) || null]
  );
}

export async function clearReactivationState(windowId) {
  if (!Number.isFinite(windowId)) return;
  await pool.query(
    `UPDATE window_pattern_state
       SET react_active = FALSE,
           react_snapshot_id = NULL,
           react_similarity = NULL,
           react_started_at = NULL,
           updated_at = now()
     WHERE window_id = $1`,
    [Number(windowId)]
  );
}
