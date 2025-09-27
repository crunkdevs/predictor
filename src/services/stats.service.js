import { pool } from '../config/db.config.js';

const nn = (j) => j ?? {};
const isPosInt = (n) => Number.isFinite(n) && n > 0 && Math.floor(n) === n;

const sanitizeLookback = (n, def = 200) => (isPosInt(n) ? n : def);
const sanitizeK = (k, def = 5) => (Number.isFinite(k) && k >= 1 && k <= 27 ? Math.floor(k) : def);

export async function getLatestAnchorImageId() {
  const { rows } = await pool.query(
    `SELECT image_id
       FROM v_spins
      ORDER BY screen_shot_time DESC
      LIMIT 1`
  );
  return rows[0]?.image_id ?? null;
}

export async function ensureAnchorExists(anchorId) {
  if (!Number.isFinite(anchorId)) return null;
  const { rows } = await pool.query(`SELECT 1 FROM v_spins WHERE image_id = $1 LIMIT 1`, [
    anchorId,
  ]);
  return rows.length ? anchorId : null;
}

export async function colorFreq(anchorId, lookback) {
  lookback = sanitizeLookback(lookback);
  const { rows } = await pool.query(`SELECT fn_color_freq_json($1,$2) AS stats`, [
    anchorId,
    lookback,
  ]);
  return nn(rows[0]?.stats);
}

export async function parityFreq(anchorId, lookback) {
  lookback = sanitizeLookback(lookback);
  const { rows } = await pool.query(`SELECT fn_parity_freq_json($1,$2) AS stats`, [
    anchorId,
    lookback,
  ]);
  return nn(rows[0]?.stats);
}

export async function sizeParityFreq(anchorId, lookback) {
  lookback = sanitizeLookback(lookback);
  const { rows } = await pool.query(`SELECT fn_size_parity_freq_json($1,$2) AS stats`, [
    anchorId,
    lookback,
  ]);
  return nn(rows[0]?.stats);
}

export async function lastDigitFreq(anchorId, lookback) {
  lookback = sanitizeLookback(lookback);
  const { rows } = await pool.query(`SELECT fn_last_digit_freq_json($1,$2) AS stats`, [
    anchorId,
    lookback,
  ]);
  return nn(rows[0]?.stats);
}

export async function hotCold(anchorId, lookback, k = 5) {
  lookback = sanitizeLookback(lookback);
  k = sanitizeK(k);
  const { rows } = await pool.query(`SELECT fn_hot_cold_numbers_json($1,$2,$3) AS stats`, [
    anchorId,
    lookback,
    k,
  ]);
  return nn(rows[0]?.stats);
}

export async function allStatsBundle(anchorId, lookback, k = 5) {
  lookback = sanitizeLookback(lookback);
  k = sanitizeK(k);

  const verifiedAnchor = await ensureAnchorExists(anchorId);
  if (verifiedAnchor == null) {
    return {
      anchor_image_id: null,
      lookback,
      color: {},
      parity: {},
      size_parity: {},
      last_digit: {},
      hot_cold: {},
    };
  }

  const [color, parity, sizeParity, lastDigit, hotcold] = await Promise.all([
    colorFreq(verifiedAnchor, lookback),
    parityFreq(verifiedAnchor, lookback),
    sizeParityFreq(verifiedAnchor, lookback),
    lastDigitFreq(verifiedAnchor, lookback),
    hotCold(verifiedAnchor, lookback, k),
  ]);

  return {
    anchor_image_id: verifiedAnchor,
    lookback,
    color,
    parity,
    size_parity: sizeParity,
    last_digit: lastDigit,
    hot_cold: hotcold,
  };
}

export async function allStatsForLatestAnchor(lookback, k = 5) {
  const anchorId = await getLatestAnchorImageId();
  if (anchorId == null) {
    return {
      anchor_image_id: null,
      lookback: sanitizeLookback(lookback),
      color: {},
      parity: {},
      size_parity: {},
      last_digit: {},
      hot_cold: {},
    };
  }
  return allStatsBundle(anchorId, lookback, k);
}

export async function windowsSummary(limitSeq = 200) {
  const totalsQ = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
      FROM v_spins
     GROUP BY result
     ORDER BY result
  `);

  const last200Q = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
      FROM (SELECT result FROM v_spins ORDER BY screen_shot_time DESC LIMIT 200) x
     GROUP BY result
  `);

  const last100Q = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
      FROM (SELECT result FROM v_spins ORDER BY screen_shot_time DESC LIMIT 100) x
     GROUP BY result
  `);

  const last20Q = await pool.query(`
    SELECT result, COUNT(*)::int AS freq
      FROM (SELECT result FROM v_spins ORDER BY screen_shot_time DESC LIMIT 20) x
     GROUP BY result
  `);

  const seqQ = await pool.query(
    `
    SELECT result
      FROM v_spins
     ORDER BY screen_shot_time DESC
     LIMIT $1
    `,
    [isPosInt(limitSeq) ? limitSeq : 200]
  );

  const mapify = (rows) => Object.fromEntries(rows.map((r) => [String(r.result), Number(r.freq)]));

  return {
    totals: mapify(totalsQ.rows),
    last_200: mapify(last200Q.rows),
    last_100: mapify(last100Q.rows),
    last_20: mapify(last20Q.rows),
    last_200_seq: seqQ.rows.map((r) => Number(r.result)).reverse(),
  };
}
