-- Backfill number_transitions_windowed from v_spins history

-- Helper: get window_idx for a timestamp in your TZ
CREATE OR REPLACE FUNCTION fn_window_idx_for_ts(p_ts timestamptz, p_tz text)
RETURNS int
LANGUAGE plpgsql STABLE AS $$
DECLARE
  local_hour int;
BEGIN
  local_hour := EXTRACT(HOUR FROM (p_ts AT TIME ZONE p_tz))::int;
  RETURN GREATEST(0, LEAST(11, local_hour / 2));
END$$;

-- Backfill procedure (idempotent): replays v_spins in time order
CREATE OR REPLACE FUNCTION fn_backfill_window_transitions(p_tz text DEFAULT 'Asia/Shanghai')
RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  prev_result smallint := NULL;
  prev_ts timestamptz  := NULL;
  cur_result  smallint;
  cur_ts      timestamptz;
  widx        int;
BEGIN
  FOR cur_result, cur_ts IN
    SELECT result::smallint, screen_shot_time
    FROM v_spins
    WHERE result IS NOT NULL
    ORDER BY screen_shot_time ASC
  LOOP
    IF prev_result IS NOT NULL THEN
      widx := fn_window_idx_for_ts(cur_ts, p_tz);

      INSERT INTO number_transitions_windowed (from_n, to_n, window_idx, count, last_seen)
      VALUES (prev_result, cur_result, widx, 1, cur_ts)
      ON CONFLICT (from_n, to_n, window_idx)
      DO UPDATE SET
        count = number_transitions_windowed.count + 1,
        last_seen = GREATEST(number_transitions_windowed.last_seen, EXCLUDED.last_seen);
    END IF;

    prev_result := cur_result;
    prev_ts := cur_ts;
  END LOOP;
END$$;

CREATE OR REPLACE FUNCTION fn_backfill_window_number_followups()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  cur RECORD;
  next RECORD;
BEGIN
  FOR cur IN
    SELECT w.window_idx, s.result, s.screen_shot_time
    FROM image_stats s
    JOIN windows w ON s.screen_shot_time BETWEEN w.start_at AND w.end_at
    ORDER BY s.screen_shot_time
  LOOP
    SELECT w2.window_idx, s2.result
      INTO next
      FROM image_stats s2
      JOIN windows w2 ON s2.screen_shot_time BETWEEN w2.start_at AND w2.end_at
     WHERE s2.screen_shot_time > cur.screen_shot_time
     ORDER BY s2.screen_shot_time ASC
     LIMIT 1;

    IF next.result IS NOT NULL THEN
      INSERT INTO window_number_followups (from_window, from_n, to_window, to_n, count, last_seen)
      VALUES (cur.window_idx, cur.result, next.window_idx, next.result, 1, now())
      ON CONFLICT (from_window, from_n, to_window, to_n)
      DO UPDATE SET
        count = window_number_followups.count + 1,
        last_seen = now();
    END IF;
  END LOOP;
END$$;

-- Uncomment to run immediately during deploy (optional):
-- SELECT fn_backfill_window_transitions(coalesce(current_setting('predictor.tz', true),'Asia/Shanghai'));
