-- ================================================
-- Overdue Events Table for Smart Overdue Logic
-- ================================================
-- Tracks when overdue numbers (gap >= 40) actually hit
-- Used for context-aware overdue selection in pool building

CREATE TABLE IF NOT EXISTS overdue_events (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  number INT NOT NULL CHECK (number BETWEEN 0 AND 27),
  gap_spins INT NOT NULL CHECK (gap_spins >= 0),
  prev_number INT CHECK (prev_number IS NULL OR (prev_number BETWEEN 0 AND 27)),
  prev_color TEXT,
  prev_parity TEXT,
  window_index INT CHECK (window_index IS NULL OR (window_index BETWEEN 0 AND 11))
);

CREATE INDEX IF NOT EXISTS idx_overdue_events_number ON overdue_events(number);
CREATE INDEX IF NOT EXISTS idx_overdue_events_occurred_at ON overdue_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_overdue_events_prev_color ON overdue_events(prev_color) WHERE prev_color IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_overdue_events_number_prev_color ON overdue_events(number, prev_color) WHERE prev_color IS NOT NULL;

