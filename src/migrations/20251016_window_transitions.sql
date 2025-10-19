-- ================================================
-- Window-aware number transitions
-- ================================================

CREATE TABLE IF NOT EXISTS number_transitions_windowed (
  from_n SMALLINT NOT NULL CHECK (from_n BETWEEN 0 AND 27),
  to_n   SMALLINT NOT NULL CHECK (to_n   BETWEEN 0 AND 27),
  window_idx SMALLINT NOT NULL CHECK (window_idx BETWEEN 0 AND 11),
  count  INT NOT NULL DEFAULT 0,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_n, to_n, window_idx)
);

CREATE INDEX IF NOT EXISTS idx_ntw_window_seen
  ON number_transitions_windowed(window_idx, last_seen DESC);
