// Shared types and Cloudflare bindings.

export type Env = {
  DB: D1Database;
  RAW: R2Bucket;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  JWT_ISSUER: string;
  JWT_TTL_DAYS: string;
  OTP_TTL_MINUTES: string;
};

export type User = {
  id: string;
  email: string;
  display_name: string | null;
  created_at: number;
  last_login_at: number | null;
};

export type Device = {
  id: string;
  user_id: string;
  strap_serial: string;
  ble_id: string;
  name: string | null;
  paired_at: number;
  last_seen_at: number | null;
};

export type AuthClaims = {
  sub: string; // user id
  email: string;
  iat: number;
  exp: number;
  iss: string;
};

// ─── Ingest payload (matches Flutter app) ───────────────────────────────────

export type IngestEvent = { ts: number; event_id: number; detail?: string };
export type IngestHr = { ts: number; bpm: number; gsr?: number };
export type IngestPpg = {
  ts: number;
  led_drive?: number;
  ir?: number;
  red?: number;
  spo2?: number;
  // raw 6-channel waveforms — uploaded to R2 if present (large)
  raw?: { a: number[]; b: number[]; c: number[]; d?: number[]; e?: number[]; f?: number[] };
};
export type IngestR24 = {
  ts: number;
  score: number;
  hrv_ms: number;
  resp_rate_per_min: number;
  skin_temp_delta_c: number;
};
export type IngestR25 = { ts: number; rmssd_ms: number; count: number; rr_ms?: number[] };

export type IngestBatch = {
  device_id?: string;
  events?: IngestEvent[];
  hr?: IngestHr[];
  ppg?: IngestPpg[];
  r24?: IngestR24[];
  r25?: IngestR25[];
};
