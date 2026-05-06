import { Hono } from "hono";
import { ulid } from "ulid";
import type { Env, IngestBatch } from "../types";

export const ingest = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

// POST /ingest/batch
// Body: gzipped JSON or plain JSON (Content-Encoding decides).
// We persist raw to R2 (audit trail / re-processing) and project rows into D1.
ingest.post("/batch", async (c) => {
  const userId = c.get("userId");
  const now = Math.floor(Date.now() / 1000);

  // Read body. Workers handles gzip transparently when Content-Encoding is set.
  let body: IngestBatch;
  try {
    body = await c.req.json<IngestBatch>();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  // Stash the raw payload in R2 for re-processing.
  const batchId = ulid();
  const dateKey = new Date(now * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
  const r2Key = `raw/${userId}/${dateKey}/${batchId}.json`;
  const rawJson = JSON.stringify(body);
  await c.env.RAW.put(r2Key, rawJson, {
    httpMetadata: { contentType: "application/json" },
  });

  const counts = {
    events: body.events?.length ?? 0,
    hr: body.hr?.length ?? 0,
    ppg: body.ppg?.length ?? 0,
    r24: body.r24?.length ?? 0,
    r25: body.r25?.length ?? 0,
  };

  await c.env.DB.prepare(
    "INSERT INTO ingest_batches (id, user_id, device_id, received_at, r2_key, sample_counts, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      batchId,
      userId,
      body.device_id ?? null,
      now,
      r2Key,
      JSON.stringify(counts),
      rawJson.length
    )
    .run();

  // Project rows into queryable tables. D1 batch is faster than N round-trips.
  const stmts: D1PreparedStatement[] = [];

  if (body.hr) {
    const ps = c.env.DB.prepare(
      "INSERT OR REPLACE INTO hr_samples (user_id, ts, bpm, gsr) VALUES (?, ?, ?, ?)"
    );
    for (const s of body.hr) stmts.push(ps.bind(userId, s.ts, s.bpm, s.gsr ?? null));
  }
  if (body.ppg) {
    const ps = c.env.DB.prepare(
      "INSERT OR REPLACE INTO ppg_samples (user_id, ts, led_drive, ir, red, spo2) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const s of body.ppg) {
      stmts.push(
        ps.bind(userId, s.ts, s.led_drive ?? null, s.ir ?? null, s.red ?? null, s.spo2 ?? null)
      );
    }
  }
  if (body.events) {
    const ps = c.env.DB.prepare(
      "INSERT INTO events (user_id, ts, event_id, detail) VALUES (?, ?, ?, ?)"
    );
    for (const e of body.events) {
      stmts.push(ps.bind(userId, e.ts, e.event_id, e.detail ?? null));
    }
  }
  if (body.r24) {
    const ps = c.env.DB.prepare(
      `INSERT OR REPLACE INTO recovery_summaries
       (user_id, date, score, hrv, resp_rate, skin_temp_delta) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const r of body.r24) {
      const date = new Date(r.ts * 1000).toISOString().slice(0, 10);
      stmts.push(
        ps.bind(userId, date, r.score, r.hrv_ms, r.resp_rate_per_min, r.skin_temp_delta_c)
      );
    }
  }
  if (body.r25) {
    const ps = c.env.DB.prepare(
      "INSERT OR REPLACE INTO rr_samples (user_id, ts, rmssd, count) VALUES (?, ?, ?, ?)"
    );
    for (const r of body.r25) stmts.push(ps.bind(userId, r.ts, r.rmssd_ms, r.count));
  }

  if (stmts.length > 0) {
    // D1 caps batch around ~100 statements; chunk if larger.
    for (let i = 0; i < stmts.length; i += 50) {
      await c.env.DB.batch(stmts.slice(i, i + 50));
    }
  }

  // Touch device last_seen_at if device_id provided.
  if (body.device_id) {
    await c.env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?")
      .bind(now, body.device_id, userId)
      .run();
  }

  return c.json({ accepted: true, batch_id: batchId, counts });
});
