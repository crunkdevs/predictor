-- ================================================
-- Snapshot hit-rate tracking (EMA)
-- ================================================

-- Outcomes per snapshot (audit)
CREATE TABLE IF NOT EXISTS pattern_snapshot_outcomes (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES pattern_snapshots(id) ON DELETE CASCADE,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correct BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pso_snapshot ON pattern_snapshot_outcomes(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_pso_time     ON pattern_snapshot_outcomes(predicted_at DESC);

-- Exponential moving average update
-- alpha in (0,1]; default = 0.2
CREATE OR REPLACE FUNCTION fn_update_snapshot_hit_rate(p_snapshot_id BIGINT, p_correct BOOLEAN, p_alpha NUMERIC DEFAULT 0.2)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  cur NUMERIC;
  obs NUMERIC := CASE WHEN p_correct THEN 1.0 ELSE 0.0 END;
  alpha NUMERIC := GREATEST(LEAST(COALESCE(p_alpha, 0.2), 1.0), 0.01);
BEGIN
  SELECT hit_rate INTO cur FROM pattern_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF cur IS NULL THEN
    -- initialize on first observation
    UPDATE pattern_snapshots
       SET hit_rate = obs, updated_at = now()
     WHERE id = p_snapshot_id;
  ELSE
    UPDATE pattern_snapshots
       SET hit_rate = alpha * obs + (1.0 - alpha) * cur,
           updated_at = now()
     WHERE id = p_snapshot_id;
  END IF;
END;
$$;
