import { pool } from '../config/db.config';

export async function detectTrendReversal({
  shortM = Number(process.env.REVERSAL_SHORT_MIN || 10),
  longM = Number(process.env.REVERSAL_LONG_MIN || 60),
  delta = Number(process.env.REVERSAL_DELTA || 0.1),
} = {}) {
  // Guardrails
  shortM = Math.max(5, shortM | 0);
  longM = Math.max(shortM + 1, longM | 0);
  delta = Math.max(0.01, Math.min(0.5, Number(delta)));

  // Helper to fetch shares for a rolling window
  async function fetchShares(intervalSql) {
    const q = `
      WITH base AS (
        SELECT result_color, result_size
        FROM v_spins
        WHERE screen_shot_time >= now() - ${intervalSql}
      ),
      color_raw AS (
        SELECT
          SUM((result_color IN ('Red','Orange','Pink'))::int)::float AS warm,
          SUM((result_color IN ('Dark Blue','Sky Blue','Green'))::int)::float AS cool,
          SUM((result_color = 'Gray')::int)::float AS neutral,
          COUNT(*)::float AS total
        FROM base
      ),
      size_raw AS (
        SELECT
          SUM((LOWER(result_size) = 'small')::int)::float AS small,
          SUM((LOWER(result_size) = 'big')::int)::float   AS big,
          COUNT(*)::float AS total
        FROM base
      )
      SELECT
        -- Color cluster shares
        CASE WHEN c.total>0 THEN c.warm/c.total ELSE 0 END AS warm,
        CASE WHEN c.total>0 THEN c.cool/c.total ELSE 0 END AS cool,
        CASE WHEN c.total>0 THEN c.neutral/c.total ELSE 0 END AS neutral,
        -- Size shares
        CASE WHEN s.total>0 THEN s.small/s.total ELSE 0 END AS small,
        CASE WHEN s.total>0 THEN s.big/s.total   ELSE 0 END AS big
      FROM color_raw c CROSS JOIN size_raw s;
    `;
    const { rows } = await pool.query(q);
    return rows[0] || { warm: 0, cool: 0, neutral: 0, small: 0, big: 0 };
  }

  const shortShares = await fetchShares(`interval '${shortM} minutes'`);
  const longShares = await fetchShares(`interval '${longM} minutes'`);

  // Compute deltas (short - long)
  const d = {
    warm: Number(shortShares.warm) - Number(longShares.warm),
    cool: Number(shortShares.cool) - Number(longShares.cool),
    neutral: Number(shortShares.neutral) - Number(longShares.neutral),
    small: Number(shortShares.small) - Number(longShares.small),
    big: Number(shortShares.big) - Number(longShares.big),
  };

  // Pick the dominant cluster in long & short
  const maxKey = (obj, keys) => keys.reduce((best, k) => (obj[k] > obj[best] ? k : best), keys[0]);
  const longColorDom = maxKey(longShares, ['warm', 'cool', 'neutral']);
  const shortColorDom = maxKey(shortShares, ['warm', 'cool', 'neutral']);
  const longSizeDom = longShares.small >= longShares.big ? 'small' : 'big';
  const shortSizeDom = shortShares.small >= shortShares.big ? 'small' : 'big';

  // Reversal checks: sign flip w/ magnitude threshold
  const colorFlip = shortColorDom !== longColorDom && Math.abs(d[shortColorDom]) >= delta; // ensure the "to" side gained ≥ delta vs long

  const sizeFlip =
    shortSizeDom !== longSizeDom && Math.abs(shortSizeDom === 'small' ? d.small : d.big) >= delta;

  const colorDetail = colorFlip
    ? { from_cluster: longColorDom, to_cluster: shortColorDom, delta: Number(d[shortColorDom]) }
    : null;

  const sizeDetail = sizeFlip
    ? {
        from: longSizeDom,
        to: shortSizeDom,
        delta: Number(shortSizeDom === 'small' ? d.small : d.big),
      }
    : null;

  return {
    reversal: Boolean(colorFlip || sizeFlip),
    color: colorDetail,
    size: sizeDetail,
    shares: {
      short: {
        warm: Number(shortShares.warm),
        cool: Number(shortShares.cool),
        neutral: Number(shortShares.neutral),
        small: Number(shortShares.small),
        big: Number(shortShares.big),
      },
      long: {
        warm: Number(longShares.warm),
        cool: Number(longShares.cool),
        neutral: Number(longShares.neutral),
        small: Number(longShares.small),
        big: Number(longShares.big),
      },
    },
    params: { shortM, longM, delta },
  };
}
