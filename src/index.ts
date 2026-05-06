import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { auth } from "./auth/handlers";
import { devices } from "./devices/handlers";
import { ingest } from "./ingest/handlers";
import { insights } from "./insights/handlers";
import { verifyToken } from "./auth/jwt";
import { nightly } from "./scheduled/nightly";

type Vars = { Variables: { userId: string }; Bindings: Env };
const app = new Hono<Vars>();

app.use("*", logger());
app.use("*", cors({ origin: "*", maxAge: 600 }));

app.get("/", (c) =>
  c.json({ name: "whoopsie-backend", version: "0.1.0", time: new Date().toISOString() })
);
app.get("/health", (c) => c.json({ ok: true }));

// Auth middleware — guards everything except the public auth endpoints.
async function requireAuth(c: any, next: any) {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return c.json({ error: "no token" }, 401);
  const claims = await verifyToken(c.env, token);
  if (!claims) return c.json({ error: "invalid token" }, 401);
  c.set("userId", claims.sub);
  await next();
}

// Public auth routes.
app.route("/auth", auth);

// Authed /auth routes (e.g. /auth/me).
app.use("/auth/me", requireAuth);

// All non-auth feature routes require a valid token.
app.use("/devices/*", requireAuth);
app.use("/ingest/*", requireAuth);
app.use("/insights/*", requireAuth);

app.route("/devices", devices);
app.route("/ingest", ingest);
app.route("/insights", insights);

// Worker entrypoints.
export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(nightly(env));
  },
} satisfies ExportedHandler<Env>;
