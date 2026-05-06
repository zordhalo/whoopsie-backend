import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { Env, User } from "../types";
import { signToken } from "./jwt";
import { sendOtpEmail } from "../email/resend";
import { hashCode, randomDigits } from "../utils/crypto";

export const auth = new Hono<{ Bindings: Env }>();

const requestSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

const verifySchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  code: z.string().regex(/^\d{6}$/),
  display_name: z.string().min(1).max(64).optional(),
});

// Step 1: client requests an OTP. We always respond 200 to avoid email enumeration.
auth.post("/request-otp", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid email" }, 400);

  const { email } = parsed.data;
  const ttlMin = parseInt(c.env.OTP_TTL_MINUTES, 10) || 10;
  const now = Math.floor(Date.now() / 1000);
  const code = randomDigits(6);
  const codeHash = await hashCode(code, email);

  // Invalidate older unused codes for this email.
  await c.env.DB.prepare("DELETE FROM otp_codes WHERE email = ?").bind(email).run();
  await c.env.DB.prepare(
    "INSERT INTO otp_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)"
  )
    .bind(email, codeHash, now + ttlMin * 60, now)
    .run();

  // Fire-and-forget email — even if Resend is slow we want a snappy response.
  c.executionCtx.waitUntil(
    sendOtpEmail(c.env, email, code).catch((e) => console.error("resend error:", e))
  );

  return c.json({ ok: true, ttl_seconds: ttlMin * 60 });
});

// Step 2: client submits email + code. We verify, create user if new, return JWT.
auth.post("/verify-otp", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid input" }, 400);

  const { email, code, display_name } = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  const expectedHash = await hashCode(code, email);

  const row = await c.env.DB.prepare(
    "SELECT email, code_hash, expires_at, attempts FROM otp_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(email)
    .first<{ email: string; code_hash: string; expires_at: number; attempts: number }>();

  if (!row) return c.json({ error: "no code requested" }, 400);
  if (row.expires_at < now) return c.json({ error: "code expired" }, 400);
  if (row.attempts >= 3) return c.json({ error: "too many attempts" }, 429);

  if (row.code_hash !== expectedHash) {
    await c.env.DB.prepare(
      "UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ?"
    )
      .bind(email)
      .run();
    return c.json({ error: "wrong code" }, 401);
  }

  // Code valid — burn it.
  await c.env.DB.prepare("DELETE FROM otp_codes WHERE email = ?").bind(email).run();

  // Find or create the user.
  let user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first<User>();
  if (!user) {
    const id = ulid();
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(id, email, display_name ?? null, now, now)
      .run();
    user = { id, email, display_name: display_name ?? null, created_at: now, last_login_at: now };
  } else {
    await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
      .bind(now, user.id)
      .run();
    user.last_login_at = now;
    if (display_name && !user.display_name) {
      await c.env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?")
        .bind(display_name, user.id)
        .run();
      user.display_name = display_name;
    }
  }

  const token = await signToken(c.env, user);
  return c.json({ token, user });
});

auth.get("/me", async (c) => {
  const userId = c.get("userId" as never) as string | undefined;
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<User>();
  if (!user) return c.json({ error: "user not found" }, 404);
  return c.json({ user });
});
