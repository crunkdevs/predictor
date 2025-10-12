-- ================================================
-- Windowed Prediction Engine – Core Schema
-- ================================================

-- 1) WINDOWS (12 x 2-hour blocks per local day)
CREATE TABLE IF NOT EXISTS windows (
  id BIGSERIAL PRIMARY KEY,
  day_date DATE NOT NULL,                   -- local day in TZ (see helper fn)
  window_idx SMALLINT NOT NULL CHECK (window_idx BETWEEN 0 AND 11),
  start_at TIMESTAMPTZ NOT NULL,           -- stored UTC
  end_at   TIMESTAMPTZ NOT NULL,           -- stored UTC

  -- first prediction allowed after this time (20 min default; app sets)
  first_predict_after TIMESTAMPTZ NOT NULL,

  -- window typing
  type TEXT NOT NULL DEFAULT 'Normal' CHECK (type IN ('Normal','Random','Start')),

  -- lifecycle state
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),

  -- current active pattern label (A/B/C/...)
  active_pattern TEXT NOT NULL DEFAULT 'A',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (day_date, window_idx)
);

CREATE INDEX IF NOT EXISTS idx_windows_day_idx   ON windows(day_date, window_idx);
CREATE INDEX IF NOT EXISTS idx_windows_start_end ON windows(start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_windows_status    ON windows(status);

CREATE OR REPLACE FUNCTION trg_windows_set_updated()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_windows_set_updated ON windows;
CREATE TRIGGER trg_windows_set_updated
BEFORE UPDATE ON windows
FOR EACH ROW EXECUTE FUNCTION trg_windows_set_updated();


-- 2) PATTERN STATE (per-window, track streaks & pauses)
CREATE TABLE IF NOT EXISTS window_pattern_state (
  id BIGSERIAL PRIMARY KEY,
  window_id BIGINT NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
  pattern_code TEXT NOT NULL DEFAULT 'A',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  wrong_streak   INT NOT NULL DEFAULT 0,
  correct_streak INT NOT NULL DEFAULT 0,

  last_predicted_at TIMESTAMPTZ,
  paused_until      TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wps_window        ON window_pattern_state(window_id);
CREATE INDEX IF NOT EXISTS idx_wps_active        ON window_pattern_state(window_id, is_active);
CREATE INDEX IF NOT EXISTS idx_wps_paused_until  ON window_pattern_state(paused_until);

DROP TRIGGER IF EXISTS trg_wps_set_updated ON window_pattern_state;
CREATE TRIGGER trg_wps_set_updated
BEFORE UPDATE ON window_pattern_state
FOR EACH ROW EXECUTE FUNCTION trg_windows_set_updated();


-- 3) NUMBER TRANSITIONS (learned P(next | last))
CREATE TABLE IF NOT EXISTS number_transitions (
  from_n SMALLINT NOT NULL CHECK (from_n BETWEEN 0 AND 27),
  to_n   SMALLINT NOT NULL CHECK (to_n   BETWEEN 0 AND 27),
  count  INT NOT NULL DEFAULT 0,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_n, to_n)
);

CREATE INDEX IF NOT EXISTS idx_transitions_last_seen ON number_transitions(last_seen DESC);


-- 4) HELPERS

-- 4.1) Current window calculator in a given TZ
-- Returns (day_date, window_idx) for a timestamp and IANA TZ string.
CREATE OR REPLACE FUNCTION fn_current_window(p_now timestamptz, p_tz text)
RETURNS TABLE(day_date date, window_idx int) LANGUAGE plpgsql STABLE AS $$
DECLARE
  local_ts timestamp;
  local_hour int;
BEGIN
  -- convert to local wall clock
  local_ts := (p_now AT TIME ZONE p_tz);
  day_date := local_ts::date;
  local_hour := EXTRACT(HOUR FROM local_ts)::int;
  -- each bucket is 2 hours, so idx = floor(h / 2)
  window_idx := GREATEST(0, LEAST(11, local_hour / 2));
  RETURN NEXT;
END$$;

-- 4.2) Build/ensure one day’s 12 windows using a TZ (used by service but useful for SQL-only ops)
-- NOTE: services construct windows; this helper is optional for SQL-only environments.
CREATE OR REPLACE FUNCTION fn_ensure_windows_for_day(p_day date, p_tz text, p_first_delay_min int DEFAULT 20)
RETURNS SETOF windows LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  i int;
  start_local timestamp;
  end_local timestamp;
  s_utc timestamptz;
  e_utc timestamptz;
  first_after timestamptz;
  rec windows%ROWTYPE;
BEGIN
  FOR i IN 0..11 LOOP
    start_local := (p_day::timestamp) + make_interval(hours => i*2);
    end_local   := (p_day::timestamp) + make_interval(hours => (i+1)*2);

    -- shift local -> tz -> utc
    s_utc := (start_local AT TIME ZONE p_tz) AT TIME ZONE 'UTC';
    e_utc := (end_local   AT TIME ZONE p_tz) AT TIME ZONE 'UTC';
    first_after := s_utc + make_interval(mins => p_first_delay_min);

    INSERT INTO windows (day_date, window_idx, start_at, end_at, first_predict_after, type, status, active_pattern)
    VALUES (p_day, i, s_utc, e_utc, first_after, CASE WHEN i=0 THEN 'Start' ELSE 'Normal' END, 'open', 'A')
    ON CONFLICT (day_date, window_idx) DO NOTHING;
  END LOOP;

  RETURN QUERY
  SELECT * FROM windows WHERE day_date = p_day ORDER BY window_idx ASC;
END$$;


-- 5) PREDICTIONS TABLE UPDATES (attach predictions to windows & mark source)
-- Adds columns if they are missing in existing deployments.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='predictions' AND column_name='window_id'
  ) THEN
    EXECUTE 'ALTER TABLE predictions ADD COLUMN window_id BIGINT REFERENCES windows(id) ON DELETE SET NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='predictions' AND column_name='source'
  ) THEN
    EXECUTE 'ALTER TABLE predictions ADD COLUMN source TEXT NOT NULL DEFAULT ''local''';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_predictions_source_day
  ON predictions ((created_at AT TIME ZONE 'Asia/Shanghai')::date, source);

CREATE INDEX IF NOT EXISTS idx_predictions_window ON predictions(window_id);


-- 6) SAFETY: some conveniences for analytics (optional, no-op if views already exist)
-- You may already have these in your prior migrations.
-- (No changes here to existing v_spins etc.)
