import type { Env } from "../types";

// Cron entrypoint — runs at 06:00 UTC daily (see wrangler.toml).
// For every user with data in the last 24h, compute a sleep + recovery summary.
// v1 algorithms are deliberately simple; swap with YASA/HRV-Analysis later in a
// separate analytics worker if you need clinical-grade output.

export async function nightly(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // Yesterday in UTC. Adjust for user-local TZ in v2.
  const dayEnd = Math.floor(now / 86400) * 86400;
  const dayStart = dayEnd - 86400;
  const dateStr = new Date(dayStart * 1000).toISOString().slice(0, 10);

  const { results: users } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM hr_samples WHERE ts >= ? AND ts < ?`
  )
    .bind(dayStart, dayEnd)
    .all<{ user_id: string }>();

  for (const { user_id } of users ?? []) {
    await summariseSleep(env, user_id, dayStart, dayEnd, dateStr);
    await summariseRecovery(env, user_id, dayStart, dayEnd, dateStr);
  }
}

// ── Sleep — Cole-Kripke-style activity score from 1Hz HR + GSR ───────────────
async function summariseSleep(
  env: Env,
  userId: string,
  start: number,
  end: number,
  date: string
): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT ts, bpm, gsr FROM hr_samples WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC"
  )
    .bind(userId, start, end)
    .all<{ ts: number; bpm: number; gsr: number | null }>();
  if (!results || results.length < 600) return; // need ~10min minimum

  // Bucket into 30-second epochs.
  const stages: { ts: number; stage: number }[] = [];
  let stageRows = 0;
  let totalSec = 0;
  let deepSec = 0;
  let remSec = 0;
  let lightSec = 0;
  let awakenings = 0;
  let lastStage = -1;
  let firstSleepTs = 0;
  let lastSleepTs = 0;

  // Resting baseline = lowest 10% HR over the window.
  const sortedHr = results.map((r) => r.bpm).sort((a, b) => a - b);
  const restingHr = sortedHr[Math.floor(sortedHr.length * 0.1)] || 50;

  for (let i = 0; i < results.length; i += 30) {
    const slice = results.slice(i, i + 30);
    if (slice.length < 5) continue;
    const avgHr = slice.reduce((a, b) => a + b.bpm, 0) / slice.length;
    const hrDelta = avgHr - restingHr;
    const gsr = slice.find((s) => s.gsr != null)?.gsr ?? 0;

    // 0=wake, 1=light, 2=deep, 3=rem
    let stage = 0;
    if (hrDelta < 5) stage = 2;
    else if (hrDelta < 10) stage = 1;
    else if (hrDelta < 15 && gsr > 0) stage = 3;
    else stage = 0;

    stages.push({ ts: slice[0].ts, stage });
    stageRows++;

    if (stage > 0) {
      if (firstSleepTs === 0) firstSleepTs = slice[0].ts;
      lastSleepTs = slice[slice.length - 1].ts;
      totalSec += 30;
      if (stage === 1) lightSec += 30;
      if (stage === 2) deepSec += 30;
      if (stage === 3) remSec += 30;
    }
    if (lastStage > 0 && stage === 0) awakenings++;
    lastStage = stage;
  }

  if (totalSec < 600) return; // less than 10 min of detected sleep — skip

  const inBedSec = lastSleepTs - firstSleepTs;
  const efficiency = inBedSec > 0 ? totalSec / inBedSec : 0;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO sleep_summaries
     (user_id, date, total_sec, deep_sec, rem_sec, light_sec, awakenings, efficiency, start_ts, end_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, date, totalSec, deepSec, remSec, lightSec, awakenings, efficiency, firstSleepTs, lastSleepTs)
    .run();

  if (stages.length > 0) {
    const ps = env.DB.prepare(
      "INSERT OR REPLACE INTO sleep_stages (user_id, ts, stage) VALUES (?, ?, ?)"
    );
    const stmts = stages.map((s) => ps.bind(userId, s.ts, s.stage));
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
  }
}

// ── Recovery — combines sleep efficiency, HRV (rMSSD), and resting HR ──────
async function summariseRecovery(
  env: Env,
  userId: string,
  start: number,
  end: number,
  date: string
): Promise<void> {
  // Skip if strap already provided an R24 summary for the day.
  const existing = await env.DB.prepare(
    "SELECT score FROM recovery_summaries WHERE user_id = ? AND date = ? AND score IS NOT NULL"
  )
    .bind(userId, date)
    .first();
  if (existing) return;

  const sleep = await env.DB.prepare(
    "SELECT * FROM sleep_summaries WHERE user_id = ? AND date = ?"
  )
    .bind(userId, date)
    .first<{
      total_sec: number;
      efficiency: number;
      start_ts: number;
      end_ts: number;
    }>();
  if (!sleep) return;

  // Resting HR during sleep window.
  const rhrRow = await env.DB.prepare(
    "SELECT MIN(bpm) AS rhr FROM hr_samples WHERE user_id = ? AND ts >= ? AND ts <= ? AND bpm > 30"
  )
    .bind(userId, sleep.start_ts, sleep.end_ts)
    .first<{ rhr: number | null }>();
  const rhr = rhrRow?.rhr ?? 0;

  // Average rMSSD during sleep window.
  const hrvRow = await env.DB.prepare(
    "SELECT AVG(rmssd) AS hrv FROM rr_samples WHERE user_id = ? AND ts >= ? AND ts <= ?"
  )
    .bind(userId, sleep.start_ts, sleep.end_ts)
    .first<{ hrv: number | null }>();
  const hrv = hrvRow?.hrv ?? 0;

  // Score 0..1: 50% sleep efficiency, 30% HRV (above 30ms is "good"), 20% RHR delta.
  // This is intentionally simple. Swap when you bring real algorithms in.
  const sleepFactor = Math.min(sleep.total_sec / (8 * 3600), 1) * sleep.efficiency;
  const hrvFactor = Math.min(hrv / 60, 1);
  const rhrFactor = rhr > 0 ? Math.max(0, 1 - (rhr - 50) / 30) : 0.5;
  const score = 0.5 * sleepFactor + 0.3 * hrvFactor + 0.2 * rhrFactor;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO recovery_summaries
     (user_id, date, score, hrv, resp_rate, skin_temp_delta) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, date, score, hrv, null, null)
    .run();
}
