import { Hono } from "hono";
import { ulid } from "ulid";
import type { Env, IngestBatch } from "../types";
import type { UserScope, UserStorage } from "../utils/scope";

type Vars = { Variables: { scope: UserScope; storage: UserStorage }; Bindings: Env };
export const ingest = new Hono<Vars>();

// POST /ingest/batch
// Body: gzipped JSON or plain JSON. Workers handles gzip decode automatically
// when Content-Encoding is set.
ingest.post("/batch", async (c) => {
  const scope = c.get("scope");
  const storage = c.get("storage");
  const now = Math.floor(Date.now() / 1000);

  let body: IngestBatch;
  try {
    body = await c.req.json<IngestBatch>();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  // Stash raw payload for re-processing / audit trail.
  const batchId = ulid();
  const dateKey = new Date(now * 1000).toISOString().slice(0, 10);
  const rawJson = JSON.stringify(body);
  await storage.put(`${dateKey}/${batchId}.json`, rawJson, {
    httpMetadata: { contentType: "application/json" },
  });

  const counts = {
    events: body.events?.length ?? 0,
    hr: body.hr?.length ?? 0,
    ppg: body.ppg?.length ?? 0,
    r24: body.r24?.length ?? 0,
    r25: body.r25?.length ?? 0,
  };

  await scope.insertBatch({
    id: batchId,
    deviceId: body.device_id ?? null,
    receivedAt: now,
    r2Key: `raw/${scope.userId}/${dateKey}/${batchId}.json`,
    sampleCounts: JSON.stringify(counts),
    sizeBytes: rawJson.length,
  });

  // Build the prepared statements via scope helpers.
  const stmts: D1PreparedStatement[] = [];
  if (body.hr) {
    stmts.push(
      ...scope.insertHrBatch(
        body.hr.map((s) => ({ ts: s.ts, bpm: s.bpm, gsr: s.gsr ?? null }))
      )
    );
  }
  if (body.ppg) {
    stmts.push(
      ...scope.insertPpgBatch(
        body.ppg.map((s) => ({
          ts: s.ts,
          led_drive: s.led_drive ?? null,
          ir: s.ir ?? null,
          red: s.red ?? null,
          spo2: s.spo2 ?? null,
        }))
      )
    );
  }
  if (body.events) {
    stmts.push(
      ...scope.insertEventBatch(
        body.events.map((e) => ({ ts: e.ts, event_id: e.event_id, detail: e.detail ?? null }))
      )
    );
  }
  if (body.r24) {
    for (const r of body.r24) {
      const date = new Date(r.ts * 1000).toISOString().slice(0, 10);
      await scope.upsertRecovery(date, {
        score: r.score,
        hrv: r.hrv_ms,
        resp: r.resp_rate_per_min,
        skinTempDelta: r.skin_temp_delta_c,
      });
    }
  }
  if (body.r25) {
    stmts.push(
      ...scope.insertRrBatch(
        body.r25.map((r) => ({ ts: r.ts, rmssd: r.rmssd_ms, count: r.count }))
      )
    );
  }

  if (stmts.length > 0) {
    for (let i = 0; i < stmts.length; i += 50) {
      await c.env.DB.batch(stmts.slice(i, i + 50));
    }
  }

  if (body.device_id) {
    await scope.touchDevice(body.device_id, now);
  }

  return c.json({ accepted: true, batch_id: batchId, counts });
});
