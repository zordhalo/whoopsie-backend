import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { Device, Env } from "../types";

export const devices = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

const pairSchema = z.object({
  strap_serial: z.string().min(1).max(64),
  ble_id: z.string().min(1).max(128),
  name: z.string().max(64).optional(),
});

devices.post("/pair", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const parsed = pairSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid input" }, 400);

  const { strap_serial, ble_id, name } = parsed.data;
  const now = Math.floor(Date.now() / 1000);

  const existing = await c.env.DB.prepare(
    "SELECT * FROM devices WHERE user_id = ? AND strap_serial = ?"
  )
    .bind(userId, strap_serial)
    .first<Device>();

  if (existing) {
    await c.env.DB.prepare(
      "UPDATE devices SET ble_id = ?, name = COALESCE(?, name), last_seen_at = ? WHERE id = ?"
    )
      .bind(ble_id, name ?? null, now, existing.id)
      .run();
    return c.json({ device: { ...existing, ble_id, name: name ?? existing.name, last_seen_at: now } });
  }

  const id = ulid();
  const device: Device = {
    id,
    user_id: userId,
    strap_serial,
    ble_id,
    name: name ?? null,
    paired_at: now,
    last_seen_at: now,
  };
  await c.env.DB.prepare(
    "INSERT INTO devices (id, user_id, strap_serial, ble_id, name, paired_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, userId, strap_serial, ble_id, name ?? null, now, now)
    .run();

  return c.json({ device });
});

devices.get("/", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM devices WHERE user_id = ? ORDER BY paired_at DESC"
  )
    .bind(userId)
    .all<Device>();
  return c.json({ devices: results ?? [] });
});

devices.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return c.json({ ok: true });
});
