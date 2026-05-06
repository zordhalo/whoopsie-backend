import { Hono } from "hono";
import type { Env } from "../types";

export const insights = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

function dayBoundsUtc(date: string): [number, number] {
  const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  return [start, start + 86400];
}

// GET /insights/today  → live snapshot
insights.get("/today", async (c) => {
  const userId = c.get("userId");
  const now = Math.floor(Date.now() / 1000);
  const dayStart = Math.floor(now / 86400) * 86400;
  const today = new Date(dayStart * 1000).toISOString().slice(0, 10);

  const [hr, recovery, sleep, batt] = await Promise.all([
    c.env.DB.prepare(
      `SELECT AVG(bpm) AS avg, MIN(bpm) AS min, MAX(bpm) AS max, COUNT(*) AS n
       FROM hr_samples WHERE user_id = ? AND ts >= ? AND bpm > 0`
    )
      .bind(userId, dayStart)
      .first<{ avg: number | null; min: number | null; max: number | null; n: number }>(),
    c.env.DB.prepare(
      "SELECT * FROM recovery_summaries WHERE user_id = ? AND date = ?"
    )
      .bind(userId, today)
      .first(),
    c.env.DB.prepare(
      "SELECT * FROM sleep_summaries WHERE user_id = ? AND date = ?"
    )
      .bind(userId, today)
      .first(),
    c.env.DB.prepare(
      `SELECT detail FROM events WHERE user_id = ? AND event_id = 3
       ORDER BY ts DESC LIMIT 1`
    )
      .bind(userId)
      .first<{ detail: string | null }>(),
  ]);

  return c.json({
    date: today,
    hr,
    recovery,
    sleep,
    last_battery: batt?.detail ?? null,
  });
});

// GET /insights/sleep/:date  (date = YYYY-MM-DD)
insights.get("/sleep/:date", async (c) => {
  const userId = c.get("userId");
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "bad date" }, 400);
  const [start, end] = dayBoundsUtc(date);

  const [summary, stages] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM sleep_summaries WHERE user_id = ? AND date = ?")
      .bind(userId, date)
      .first(),
    c.env.DB.prepare(
      `SELECT ts, stage FROM sleep_stages
       WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`
    )
      .bind(userId, start, end)
      .all<{ ts: number; stage: number }>(),
  ]);

  return c.json({ date, summary, stages: stages.results ?? [] });
});

// GET /insights/recovery/:date
insights.get("/recovery/:date", async (c) => {
  const userId = c.get("userId");
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "bad date" }, 400);
  const summary = await c.env.DB.prepare(
    "SELECT * FROM recovery_summaries WHERE user_id = ? AND date = ?"
  )
    .bind(userId, date)
    .first();
  return c.json({ date, summary });
});

// GET /insights/trend?metric=recovery|hrv|sleep_total&days=30
insights.get("/trend", async (c) => {
  const userId = c.get("userId");
  const metric = c.req.query("metric") ?? "recovery";
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 365);
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const cutoffDate = new Date(cutoff * 1000).toISOString().slice(0, 10);

  let rows: unknown;
  switch (metric) {
    case "recovery":
      rows = (
        await c.env.DB.prepare(
          "SELECT date, score FROM recovery_summaries WHERE user_id = ? AND date >= ? ORDER BY date ASC"
        )
          .bind(userId, cutoffDate)
          .all()
      ).results;
      break;
    case "hrv":
      rows = (
        await c.env.DB.prepare(
          "SELECT date, hrv FROM recovery_summaries WHERE user_id = ? AND date >= ? ORDER BY date ASC"
        )
          .bind(userId, cutoffDate)
          .all()
      ).results;
      break;
    case "sleep_total":
      rows = (
        await c.env.DB.prepare(
          "SELECT date, total_sec FROM sleep_summaries WHERE user_id = ? AND date >= ? ORDER BY date ASC"
        )
          .bind(userId, cutoffDate)
          .all()
      ).results;
      break;
    default:
      return c.json({ error: "unknown metric" }, 400);
  }
  return c.json({ metric, days, points: rows });
});

// GET /insights/hr?from=ts&to=ts  → 1Hz HR series for live/history view
insights.get("/hr", async (c) => {
  const userId = c.get("userId");
  const from = parseInt(c.req.query("from") ?? "0", 10);
  const to = parseInt(c.req.query("to") ?? "0", 10) || Math.floor(Date.now() / 1000);
  if (from <= 0) return c.json({ error: "from required" }, 400);
  // Cap span at 24 h to avoid blowing up payload.
  const start = Math.max(from, to - 86400);
  const { results } = await c.env.DB.prepare(
    "SELECT ts, bpm, gsr FROM hr_samples WHERE user_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC"
  )
    .bind(userId, start, to)
    .all();
  return c.json({ from: start, to, points: results });
});
