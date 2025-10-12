import { pool } from '../config/db.config.js';

const TZ = process.env.SCHEDULER_TZ || 'Asia/Shanghai';
const FIRST_PREDICT_DELAY_MIN = Number(process.env.FIRST_PREDICT_DELAY_MIN || 20);
const PAUSE_AFTER_WRONGS = Number(process.env.PRED_PAUSE_AFTER_WRONGS || 3);
const WRONG_PAUSE_MIN = Number(process.env.PRED_PAUSE_MIN || 10);

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
  };
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
  if (ws.paused_until && now < new Date(ws.paused_until)) {
    return { can: false, reason: 'paused', until: ws.paused_until };
  }

  return { can: true };
}

export async function pausePattern(windowId, minutes = WRONG_PAUSE_MIN) {
  const ms = Math.max(1, Number(minutes)) * 60 * 1000;
  const until = new Date(Date.now() + ms).toISOString();
  await pool.query(
    `UPDATE window_pattern_state
       SET paused_until = $2, updated_at = now()
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
