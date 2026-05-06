-- whoopsie D1 schema. All timestamps are UNIX seconds (INTEGER).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS otp_codes (
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, created_at)
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  strap_serial TEXT NOT NULL,
  ble_id TEXT NOT NULL,
  name TEXT,
  paired_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  UNIQUE (user_id, strap_serial),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingest_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  received_at INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  sample_counts TEXT,
  size_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_batches_user_received ON ingest_batches(user_id, received_at);

-- 1Hz HR + GSR. Indexed for date-range queries.
CREATE TABLE IF NOT EXISTS hr_samples (
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  bpm INTEGER NOT NULL,
  gsr INTEGER,
  PRIMARY KEY (user_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_hr_user_ts ON hr_samples(user_id, ts);

-- Per-R21 packet summary. Raw 6-channel waveforms live in R2.
CREATE TABLE IF NOT EXISTS ppg_samples (
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  led_drive INTEGER,
  ir INTEGER,
  red INTEGER,
  spo2 INTEGER,
  PRIMARY KEY (user_id, ts)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts);

-- R25 RR-interval summary. Raw RR arrays live in R2.
CREATE TABLE IF NOT EXISTS rr_samples (
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  rmssd REAL,
  count INTEGER,
  PRIMARY KEY (user_id, ts)
);

-- Recovery summaries (R24 + nightly worker).
CREATE TABLE IF NOT EXISTS recovery_summaries (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  score REAL,
  hrv REAL,
  resp_rate REAL,
  skin_temp_delta REAL,
  PRIMARY KEY (user_id, date)
);

-- Sleep summaries (computed by nightly worker).
CREATE TABLE IF NOT EXISTS sleep_summaries (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  total_sec INTEGER,
  deep_sec INTEGER,
  rem_sec INTEGER,
  light_sec INTEGER,
  awakenings INTEGER,
  efficiency REAL,
  start_ts INTEGER,
  end_ts INTEGER,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS sleep_stages (
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  stage INTEGER NOT NULL,
  PRIMARY KEY (user_id, ts)
);
