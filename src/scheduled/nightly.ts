import type { Env } from "../types";
import { UserScope } from "../utils/scope";

// Cron entrypoint — runs daily at 06:00 UTC.
// For every user with HR data in the last 24 h, computes:
//   - sleep window (when did they actually sleep?)
//   - 30-second epoch sleep stages (wake / light / deep / rem)
//   - sleep summary (total / efficiency / awakenings / latency)
//   - recovery score (HRV + RHR + sleep efficiency blend)

const STAGE_WAKE = 0;
const STAGE_LIGHT = 1;
const STAGE_DEEP = 2;
const STAGE_REM = 3;

export async function nightly(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const dayEnd = Math.floor(now / 86400) * 86400;
  const dayStart = dayEnd - 86400;
  const dateStr = new Date(dayStart * 1000).toISOString().slice(0, 10);

  const { results: users } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM hr_samples WHERE ts >= ? AND ts < ?`
  )
    .bind(dayStart, dayEnd)
    .all<{ user_id: string }>();

  for (const { user_id } of users ?? []) {
    const scope = new UserScope(env.DB, user_id);
    try {
      await processUser(scope, dayStart, dayEnd, dateStr);
    } catch (e) {
      console.error(`nightly user=${user_id}:`, e);
    }
  }
}

async function processUser(
  scope: UserScope,
  windowStart: number,
  windowEnd: number,
  date: string
): Promise<void> {
  const { results: hrRows } = await scope.hrInRange(windowStart, windowEnd);
  if (!hrRows || hrRows.length < 600) return; // need at least 10 minutes

  // Find longest contiguous low-activity run (proxy for "in bed").
  const sleepWindow = detectSleepWindow(hrRows);
  if (!sleepWindow || sleepWindow.end - sleepWindow.start < 1800) return; // <30min, skip

  // Establish baselines from the sleep window.
  const sortedHr = hrRows
    .filter((r) => r.ts >= sleepWindow.start && r.ts <= sleepWindow.end && r.bpm > 0)
    .map((r) => r.bpm)
    .sort((a, b) => a - b);
  const rhr = sortedHr[Math.floor(sortedHr.length * 0.1)] ?? 50;

  const { results: rrRows } = await scope.rrInRange(sleepWindow.start, sleepWindow.end);
  const rmssdValues = (rrRows ?? []).map((r) => r.rmssd).filter((v) => v > 0);
  const hrvBaseline =
    rmssdValues.length > 0
      ? rmssdValues.reduce((a, b) => a + b, 0) / rmssdValues.length
      : 30;

  // Classify 30-second epochs.
  const stages: { ts: number; stage: number }[] = classifyEpochs(
    hrRows,
    rrRows ?? [],
    sleepWindow,
    rhr,
    hrvBaseline
  );

  // Smooth: 3-epoch median filter.
  const smoothed = medianFilter(stages, 3);

  // Aggregate.
  const summary = aggregate(smoothed, sleepWindow);
  if (summary.totalSec < 600) return; // <10min real sleep, skip

  await scope.upsertSleepSummary(date, summary);
  if (smoothed.length > 0) {
    const stmts = scope.insertSleepStages(smoothed);
    for (let i = 0; i < stmts.length; i += 50) {
      await scope.db.batch(stmts.slice(i, i + 50));
    }
  }

  // Recovery score: don't overwrite if strap-provided R24 exists.
  const existing = await scope.recoveryByDate(date);
  if (existing && (existing as any).score !== null) return;

  const recoveryScore = computeRecovery(summary, hrvBaseline, rhr);
  await scope.upsertRecovery(date, {
    score: recoveryScore,
    hrv: hrvBaseline,
    resp: null,
    skinTempDelta: null,
  });
}

// ─── Detection ────────────────────────────────────────────────────────────
type Window = { start: number; end: number };

function detectSleepWindow(
  hrRows: { ts: number; bpm: number; gsr: number | null }[]
): Window | null {
  if (hrRows.length === 0) return null;

  // Day-baseline: median HR across the whole window. Sleep HR will be ≥10 below.
  const sortedAll = hrRows.map((r) => r.bpm).filter((b) => b > 0).sort((a, b) => a - b);
  if (sortedAll.length === 0) return null;
  const dayMedian = sortedAll[Math.floor(sortedAll.length / 2)];
  const sleepHrCutoff = dayMedian - 10;

  // Walk through 5-minute windows; classify each as "sleep candidate" if HR < cutoff.
  let bestStart = 0;
  let bestEnd = 0;
  let bestLen = 0;
  let runStart = 0;
  let inRun = false;

  for (let i = 0; i < hrRows.length; i += 60) {
    const slice = hrRows.slice(i, i + 60); // ~1 minute
    if (slice.length === 0) continue;
    const avgHr = slice.reduce((a, b) => a + b.bpm, 0) / slice.length;
    const isSleep = avgHr > 0 && avgHr < sleepHrCutoff;

    if (isSleep) {
      if (!inRun) {
        runStart = slice[0].ts;
        inRun = true;
      }
      const runEnd = slice[slice.length - 1].ts;
      if (runEnd - runStart > bestLen) {
        bestStart = runStart;
        bestEnd = runEnd;
        bestLen = runEnd - runStart;
      }
    } else {
      // Allow short awakenings (<10 min) without breaking the run.
      if (inRun) {
        const gap = slice[0].ts - (bestEnd || runStart);
        if (gap > 600) inRun = false;
      }
    }
  }

  if (bestLen < 1800) return null;
  return { start: bestStart, end: bestEnd };
}

// ─── Classification ───────────────────────────────────────────────────────
function classifyEpochs(
  hr: { ts: number; bpm: number; gsr: number | null }[],
  rr: { ts: number; rmssd: number }[],
  win: Window,
  rhr: number,
  hrvBaseline: number
): { ts: number; stage: number }[] {
  const out: { ts: number; stage: number }[] = [];
  const epoch = 30;
  // Index helpers.
  const rrByTs = new Map<number, number>();
  for (const r of rr) rrByTs.set(Math.floor(r.ts / epoch) * epoch, r.rmssd);

  for (let t = win.start; t < win.end; t += epoch) {
    const slice = hr.filter((r) => r.ts >= t && r.ts < t + epoch);
    if (slice.length < 5) continue;
    const avgHr = slice.reduce((a, b) => a + b.bpm, 0) / slice.length;
    const hrRange = Math.max(...slice.map((s) => s.bpm)) - Math.min(...slice.map((s) => s.bpm));
    const gsrSlice = slice.map((s) => s.gsr ?? 0);
    const gsrChange = gsrSlice.length > 1
      ? Math.abs(gsrSlice[gsrSlice.length - 1] - gsrSlice[0])
      : 0;
    const rmssd = rrByTs.get(Math.floor(t / epoch) * epoch) ?? 0;

    let stage = STAGE_LIGHT;
    if (avgHr > rhr + 20 || hrRange > 25) {
      stage = STAGE_WAKE;
    } else if (avgHr <= rhr + 3 && hrRange < 8 && rmssd >= hrvBaseline * 0.9) {
      stage = STAGE_DEEP;
    } else if (avgHr > rhr + 5 && hrRange < 12 && gsrChange > 2 && rmssd > 0 && rmssd < hrvBaseline * 0.8) {
      stage = STAGE_REM;
    }
    out.push({ ts: t, stage });
  }
  return out;
}

function medianFilter(
  stages: { ts: number; stage: number }[],
  window: number
): { ts: number; stage: number }[] {
  if (stages.length < window) return stages;
  const half = Math.floor(window / 2);
  return stages.map((s, i) => {
    const slice = stages.slice(Math.max(0, i - half), i + half + 1).map((x) => x.stage);
    slice.sort((a, b) => a - b);
    return { ts: s.ts, stage: slice[Math.floor(slice.length / 2)] };
  });
}

function aggregate(
  stages: { ts: number; stage: number }[],
  win: Window
): {
  totalSec: number; deepSec: number; remSec: number; lightSec: number;
  awakenings: number; efficiency: number; startTs: number; endTs: number;
} {
  let total = 0, deep = 0, rem = 0, light = 0, awakenings = 0;
  let lastStage = -1;
  for (const s of stages) {
    if (s.stage !== STAGE_WAKE) total += 30;
    if (s.stage === STAGE_DEEP) deep += 30;
    if (s.stage === STAGE_REM) rem += 30;
    if (s.stage === STAGE_LIGHT) light += 30;
    if (lastStage > 0 && s.stage === STAGE_WAKE) awakenings++;
    lastStage = s.stage;
  }
  const inBed = win.end - win.start;
  const efficiency = inBed > 0 ? total / inBed : 0;
  return {
    totalSec: total,
    deepSec: deep,
    remSec: rem,
    lightSec: light,
    awakenings,
    efficiency,
    startTs: win.start,
    endTs: win.end,
  };
}

// ─── Recovery scoring ─────────────────────────────────────────────────────
function computeRecovery(
  sleep: { totalSec: number; efficiency: number },
  hrvMs: number,
  rhr: number
): number {
  // Same shape as before but tuned. 0..1.
  const sleepFactor = Math.min(sleep.totalSec / (8 * 3600), 1) * sleep.efficiency;
  const hrvFactor = Math.min(hrvMs / 60, 1);
  const rhrFactor = rhr > 0 ? Math.max(0, 1 - (rhr - 50) / 30) : 0.5;
  return 0.5 * sleepFactor + 0.3 * hrvFactor + 0.2 * rhrFactor;
}
