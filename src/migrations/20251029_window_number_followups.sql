-- Cross-window number follow-ups
CREATE TABLE IF NOT EXISTS window_number_followups (
  from_window  SMALLINT NOT NULL CHECK (from_window BETWEEN 0 AND 11),
  from_n       SMALLINT NOT NULL CHECK (from_n BETWEEN 0 AND 27),
  to_window    SMALLINT NOT NULL CHECK (to_window   BETWEEN 0 AND 11),
  to_n         SMALLINT NOT NULL CHECK (to_n        BETWEEN 0 AND 27),
  count        INT NOT NULL DEFAULT 0,
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_window, from_n, to_window, to_n)
);

CREATE INDEX IF NOT EXISTS idx_wnf_from ON window_number_followups(from_window, from_n);
CREATE INDEX IF NOT EXISTS idx_wnf_to   ON window_number_followups(to_window, to_n);
CREATE INDEX IF NOT EXISTS idx_wnf_seen ON window_number_followups(last_seen DESC);
