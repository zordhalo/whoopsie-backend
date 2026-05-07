// User-scoped data accessors. Every D1 read/write that touches user data
// MUST go through these classes — they enforce `WHERE user_id = ?` and R2
// prefix locking automatically. Direct `c.env.DB.prepare(...)` from a
// handler is a code smell and will be caught in review.

export class UserScope {
  constructor(public db: D1Database, public userId: string) {}

  // ── Reads ─────────────────────────────────────────────────────────────
  hrInRange(fromTs: number, toTs: number) {
    return this.db
      .prepare(
        `SELECT ts, bpm, gsr FROM hr_samples
         WHERE user_id = ? AND ts BETWEEN ? AND ?
         ORDER BY ts ASC`
      )
      .bind(this.userId, fromTs, toTs)
      .all<{ ts: number; bpm: number; gsr: number | null }>();
  }

  rrInRange(fromTs: number, toTs: number) {
    return this.db
      .prepare(
        `SELECT ts, rmssd, count FROM rr_samples
         WHERE user_id = ? AND ts BETWEEN ? AND ?
         ORDER BY ts ASC`
      )
      .bind(this.userId, fromTs, toTs)
      .all<{ ts: number; rmssd: number; count: number }>();
  }

  recoveryByDate(date: string) {
    return this.db
      .prepare("SELECT * FROM recovery_summaries WHERE user_id = ? AND date = ?")
      .bind(this.userId, date)
      .first();
  }

  sleepByDate(date: string) {
    return this.db
      .prepare("SELECT * FROM sleep_summaries WHERE user_id = ? AND date = ?")
      .bind(this.userId, date)
      .first();
  }

  sleepStagesByDate(date: string) {
    const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const end = start + 86400;
    return this.db
      .prepare(
        `SELECT ts, stage FROM sleep_stages
         WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`
      )
      .bind(this.userId, start, end)
      .all<{ ts: number; stage: number }>();
  }

  recoveryTrend(fromDate: string) {
    return this.db
      .prepare(
        "SELECT date, score, hrv FROM recovery_summaries WHERE user_id = ? AND date >= ? ORDER BY date ASC"
      )
      .bind(this.userId, fromDate)
      .all();
  }

  sleepTrend(fromDate: string) {
    return this.db
      .prepare(
        `SELECT date, total_sec, deep_sec, rem_sec, efficiency
         FROM sleep_summaries WHERE user_id = ? AND date >= ? ORDER BY date ASC`
      )
      .bind(this.userId, fromDate)
      .all();
  }

  hrTrend(days: number) {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    return this.db
      .prepare(
        `SELECT
           strftime('%Y-%m-%d', ts, 'unixepoch') AS date,
           AVG(bpm) AS avg, MIN(bpm) AS min, MAX(bpm) AS max
         FROM hr_samples WHERE user_id = ? AND ts >= ? AND bpm > 0
         GROUP BY date ORDER BY date ASC`
      )
      .bind(this.userId, since)
      .all();
  }

  recentBatteryEvent() {
    return this.db
      .prepare(
        `SELECT detail FROM events
         WHERE user_id = ? AND event_id = 3 AND detail IS NOT NULL AND detail != ''
         ORDER BY ts DESC LIMIT 1`
      )
      .bind(this.userId)
      .first<{ detail: string }>();
  }

  todaySnapshot(dayStartTs: number) {
    return this.db
      .prepare(
        `SELECT AVG(bpm) AS avg, MIN(bpm) AS min, MAX(bpm) AS max, COUNT(*) AS n
         FROM hr_samples WHERE user_id = ? AND ts >= ? AND bpm > 0`
      )
      .bind(this.userId, dayStartTs)
      .first<{ avg: number | null; min: number | null; max: number | null; n: number }>();
  }

  // ── Writes (used by ingest + nightly cron) ────────────────────────────
  insertHrBatch(rows: { ts: number; bpm: number; gsr: number | null }[]) {
    if (rows.length === 0) return [];
    const ps = this.db.prepare(
      "INSERT OR REPLACE INTO hr_samples (user_id, ts, bpm, gsr) VALUES (?, ?, ?, ?)"
    );
    return rows.map((r) => ps.bind(this.userId, r.ts, r.bpm, r.gsr));
  }

  insertPpgBatch(rows: {
    ts: number;
    led_drive: number | null;
    ir: number | null;
    red: number | null;
    spo2: number | null;
  }[]) {
    if (rows.length === 0) return [];
    const ps = this.db.prepare(
      "INSERT OR REPLACE INTO ppg_samples (user_id, ts, led_drive, ir, red, spo2) VALUES (?, ?, ?, ?, ?, ?)"
    );
    return rows.map((r) => ps.bind(this.userId, r.ts, r.led_drive, r.ir, r.red, r.spo2));
  }

  insertEventBatch(rows: { ts: number; event_id: number; detail: string | null }[]) {
    if (rows.length === 0) return [];
    const ps = this.db.prepare(
      "INSERT INTO events (user_id, ts, event_id, detail) VALUES (?, ?, ?, ?)"
    );
    return rows.map((r) => ps.bind(this.userId, r.ts, r.event_id, r.detail));
  }

  insertRrBatch(rows: { ts: number; rmssd: number; count: number }[]) {
    if (rows.length === 0) return [];
    const ps = this.db.prepare(
      "INSERT OR REPLACE INTO rr_samples (user_id, ts, rmssd, count) VALUES (?, ?, ?, ?)"
    );
    return rows.map((r) => ps.bind(this.userId, r.ts, r.rmssd, r.count));
  }

  upsertRecovery(date: string, r: {
    score: number | null;
    hrv: number | null;
    resp: number | null;
    skinTempDelta: number | null;
  }) {
    return this.db
      .prepare(
        `INSERT OR REPLACE INTO recovery_summaries
         (user_id, date, score, hrv, resp_rate, skin_temp_delta) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(this.userId, date, r.score, r.hrv, r.resp, r.skinTempDelta)
      .run();
  }

  upsertSleepSummary(date: string, s: {
    totalSec: number;
    deepSec: number;
    remSec: number;
    lightSec: number;
    awakenings: number;
    efficiency: number;
    startTs: number;
    endTs: number;
  }) {
    return this.db
      .prepare(
        `INSERT OR REPLACE INTO sleep_summaries
         (user_id, date, total_sec, deep_sec, rem_sec, light_sec, awakenings,
          efficiency, start_ts, end_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        this.userId, date, s.totalSec, s.deepSec, s.remSec, s.lightSec,
        s.awakenings, s.efficiency, s.startTs, s.endTs
      )
      .run();
  }

  insertSleepStages(stages: { ts: number; stage: number }[]) {
    if (stages.length === 0) return [];
    const ps = this.db.prepare(
      "INSERT OR REPLACE INTO sleep_stages (user_id, ts, stage) VALUES (?, ?, ?)"
    );
    return stages.map((s) => ps.bind(this.userId, s.ts, s.stage));
  }

  touchDevice(deviceId: string, ts: number) {
    return this.db
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?")
      .bind(ts, deviceId, this.userId)
      .run();
  }

  insertBatch(b: {
    id: string;
    deviceId: string | null;
    receivedAt: number;
    r2Key: string;
    sampleCounts: string;
    sizeBytes: number;
  }) {
    return this.db
      .prepare(
        `INSERT INTO ingest_batches
         (id, user_id, device_id, received_at, r2_key, sample_counts, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(b.id, this.userId, b.deviceId, b.receivedAt, b.r2Key, b.sampleCounts, b.sizeBytes)
      .run();
  }
}

/// Prefix-locked R2 wrapper. Every key is forced under `raw/<userId>/`.
export class UserStorage {
  constructor(public bucket: R2Bucket, public userId: string) {}
  put(subKey: string, value: ArrayBuffer | string, opts?: R2PutOptions) {
    return this.bucket.put(`raw/${this.userId}/${subKey}`, value, opts);
  }
  get(subKey: string) {
    return this.bucket.get(`raw/${this.userId}/${subKey}`);
  }
  list(subPrefix = "") {
    return this.bucket.list({ prefix: `raw/${this.userId}/${subPrefix}` });
  }
}
