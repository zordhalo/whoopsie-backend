# whoopsie-backend

[![MCP servers live](https://whobuildsagents.com/badge/advancelabs.dev.svg)](https://whobuildsagents.com/advancelabs.dev)

Part of [project-whoopsie](https://github.com/project-whoopsie) — see the [main repository](https://github.com/project-whoopsie/whoopsie) for context on what this project is and why it exists.

- [whoopsie-protocol](https://github.com/project-whoopsie/whoopsie-protocol) ← Start here if you're new. The BLE protocol documentation.
- [whoopsie](https://github.com/project-whoopsie/whoopsie) ← The Flutter companion app that sends data here.

---

## What this is

A minimal server that receives WHOOP metrics from the companion app, stores them locally, and surfaces basic computed insights. HR, HRV, SpO2, temperature, battery, and IMU data — stored in SQLite, queryable over HTTP, streamable over WebSocket.

---

## What this isn't

WHOOP's actual platform. Their recovery model is built on years of research, sleep staging, and validated algorithms. This backend applies a weighted average to two metrics and calls it recovery. It is a skeleton — something to build on, not something to trust with health decisions.

---

## Status

This is not a product. This is not beta software. This is not even alpha.

This is one piece of a research project, built primarily to validate that the data coming off the device was real and meaningful. The insight calculations are approximations. The architecture is intentionally minimal. Many things are hardcoded. There is no authentication.

With enough community support and collaboration, something worthy could eventually be built here. But that is a long road and this is barely the first step.

---

## Architecture

Two files.

`database.py` sets up the tables and hands out connections. `main.py` is everything else — ingest routes, insight calculations, WebSocket hub. It was written to be easy to read and easy to replace. If you want to swap SQLite for Postgres or rewrite the recovery logic with something real, the surface area is small.

---

## Running it

```bash
python -m venv venv
source venv/bin/activate
pip install fastapi aiosqlite uvicorn

uvicorn main:app --host 0.0.0.0 --port 5677
```

The companion app expects it at `http://<your-local-ip>:5677`. Update `lib/core/services/api_client.dart` accordingly — it defaults to `localhost` which won't work on a real device.

---

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/ingest` | Ingest bulk metrics |
| `GET` | `/api/metrics/hr?hours=N` | HR history |
| `GET` | `/api/metrics/hrv?hours=N` | HRV history |
| `GET` | `/api/metrics/spo2?hours=N` | SpO2 history |
| `GET` | `/api/insights/today` | Today's recovery, strain, HRV trend |
| `GET` | `/api/insights/recovery` | Current recovery score |
| `GET` | `/api/insights/history?days=N` | Historical insights |
| `WS` | `/ws/stream` | Live metric stream |

---

## Legal & Ethics

This research was conducted on a device personally owned by the author. No WHOOP systems, servers, or accounts were accessed, modified, or interfered with. Shared for educational and research purposes only.

**If WHOOP, Inc. believes any part of this violates their intellectual property rights:** abdulsaheel81@gmail.com

---

## Contributing

Open an issue or send a PR. The protocol is solved. The data pipeline works. Better insight algorithms, proper sleep staging, anything that makes this more useful — all welcome.

---

## Disclaimer

Provided as-is, with no warranty. Use it on your own device at your own risk. Do not make health decisions based on the numbers this server produces.
