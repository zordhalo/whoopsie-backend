# whoopsie-backend

Part of [project-whoopsie](https://github.com/project-whoopsie). See the [main repository](https://github.com/project-whoopsie/whoopsie) for context.

- [whoopsie-protocol](https://github.com/project-whoopsie/whoopsie-protocol) — BLE protocol documentation + Dart package.
- [whoopsie](https://github.com/project-whoopsie/whoopsie) — Flutter companion app.

---

## What this is

A Cloudflare Worker that receives WHOOP metrics from the companion app, stores them in D1 + R2, and surfaces computed insights over HTTP.

- **Auth:** email + 6-digit OTP (no passwords). Tokens are JWTs.
- **Ingest:** signed `POST /ingest/batch` accepts JSON (gzipped optional). Raw payload archived to R2; queryable rows projected into D1.
- **Insights:** `GET /insights/today | /sleep/:date | /recovery/:date | /trend | /hr` — JSON only, no streaming.
- **Nightly worker:** Cron-triggered at 06:00 UTC, computes simple sleep stages + recovery score per user from the last 24 h of data.

The "recovery" algorithm is intentionally simple. v1 ships a weighted blend of sleep efficiency, rMSSD, and resting HR. Replace `src/scheduled/nightly.ts` when you bring a real model.

---

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | — | service info |
| `GET` | `/health` | — | health check |
| `POST` | `/auth/request-otp` | — | `{ email }` → emails 6-digit code |
| `POST` | `/auth/verify-otp` | — | `{ email, code, display_name? }` → `{ token, user }` |
| `GET` | `/auth/me` | bearer | current user |
| `POST` | `/devices/pair` | bearer | `{ strap_serial, ble_id, name? }` → `{ device }` |
| `GET` | `/devices` | bearer | list paired devices |
| `DELETE` | `/devices/:id` | bearer | unpair |
| `POST` | `/ingest/batch` | bearer | `{ events?, hr?, ppg?, r24?, r25?, device_id? }` |
| `GET` | `/insights/today` | bearer | live snapshot |
| `GET` | `/insights/sleep/:date` | bearer | sleep summary + stages |
| `GET` | `/insights/recovery/:date` | bearer | recovery summary |
| `GET` | `/insights/trend?metric=&days=` | bearer | time series |
| `GET` | `/insights/hr?from=&to=` | bearer | 1Hz HR series |

---

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars   # then edit secrets
npm run db:migrate:local
npm run dev
```

`.dev.vars`:

```
JWT_SECRET=any-long-random-string
RESEND_API_KEY=re_xxxxxxxxxxxxxxx
```

## Deploying to Cloudflare

```bash
# 1. Create the D1 database (one time).
npm run db:create
# copy the printed database_id into wrangler.toml [[d1_databases]]

# 2. Create the R2 bucket.
npm run r2:create

# 3. Push schema to remote D1.
npm run db:migrate:remote

# 4. Set production secrets.
npx wrangler secret put JWT_SECRET
npx wrangler secret put RESEND_API_KEY

# 5. Deploy.
npm run deploy
```

Tail logs with `npm run tail`.

## Email

Default sender is `onboarding@resend.dev` via [Resend](https://resend.com) (free tier: 3000 emails/month). Once you add a verified domain to Resend, change `EMAIL_FROM` in `wrangler.toml`.

To swap to MailChannels (free for Cloudflare Workers, requires DKIM/SPF on a domain in Cloudflare): replace `src/email/resend.ts` — keep the `sendOtpEmail(env, email, code)` signature and rewrite the body.

## Architecture

```
Phone ─POST /ingest/batch (gzip JSON)─▶ Worker
                                         │
                                         ├─▶ R2: raw/<userId>/<date>/<batchId>.json
                                         └─▶ D1: hr_samples, ppg_samples, events,
                                                 recovery_summaries, rr_samples

Cron (06:00 UTC) ─▶ Worker.scheduled ─▶ nightly() ─▶ sleep_summaries, sleep_stages,
                                                     recovery_summaries

Phone ─GET /insights/* (bearer JWT)─▶ Worker ─▶ D1 reads
```

## Status

Pre-alpha. Schema is stable enough for iteration; auth surface is the same shape it'll keep; insights endpoints return real data when the cron has run. Don't make health decisions from this.

## Legal

The author owns and operates the WHOOP device data flowing through this backend. No WHOOP systems, servers, or accounts are accessed. Shared for research and educational purposes.

If WHOOP, Inc. has concerns: abdulsaheel81@gmail.com

## License

AGPL-3.0 — forks and hosted services must also be open-source.
