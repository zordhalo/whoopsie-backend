import { Hono } from "hono";
import type { Env } from "../types";
import type { UserScope, UserStorage } from "../utils/scope";

type Vars = { Variables: { scope: UserScope; storage: UserStorage }; Bindings: Env };
export const insights = new Hono<Vars>();

// GET /insights/today  → live snapshot
insights.get("/today", async (c) => {
  const scope = c.get("scope");
  const now = Math.floor(Date.now() / 1000);
  const dayStart = Math.floor(now / 86400) * 86400;
  const today = new Date(dayStart * 1000).toISOString().slice(0, 10);

  const [hr, recovery, sleep, batt] = await Promise.all([
    scope.todaySnapshot(dayStart),
    scope.recoveryByDate(today),
    scope.sleepByDate(today),
    scope.recentBatteryEvent(),
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
  const scope = c.get("scope");
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "bad date" }, 400);
  const [summary, stages] = await Promise.all([
    scope.sleepByDate(date),
    scope.sleepStagesByDate(date),
  ]);
  return c.json({ date, summary, stages: stages.results ?? [] });
});

insights.get("/recovery/:date", async (c) => {
  const scope = c.get("scope");
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "bad date" }, 400);
  return c.json({ date, summary: await scope.recoveryByDate(date) });
});

// GET /insights/trend?metric=recovery|hrv|sleep_total|hr&days=30
insights.get("/trend", async (c) => {
  const scope = c.get("scope");
  const metric = c.req.query("metric") ?? "recovery";
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 365);
  const cutoffDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  let rows: unknown;
  switch (metric) {
    case "recovery":
    case "hrv":
      rows = (await scope.recoveryTrend(cutoffDate)).results;
      break;
    case "sleep_total":
      rows = (await scope.sleepTrend(cutoffDate)).results;
      break;
    case "hr":
      rows = (await scope.hrTrend(days)).results;
      break;
    default:
      return c.json({ error: "unknown metric" }, 400);
  }
  return c.json({ metric, days, points: rows });
});

// GET /insights/hr?from=ts&to=ts  → 1Hz HR series
insights.get("/hr", async (c) => {
  const scope = c.get("scope");
  const from = parseInt(c.req.query("from") ?? "0", 10);
  const to = parseInt(c.req.query("to") ?? "0", 10) || Math.floor(Date.now() / 1000);
  if (from <= 0) return c.json({ error: "from required" }, 400);
  // Cap span to avoid blowing up payload size.
  const start = Math.max(from, to - 86400);
  const { results } = await scope.hrInRange(start, to);
  return c.json({ from: start, to, points: results });
});
