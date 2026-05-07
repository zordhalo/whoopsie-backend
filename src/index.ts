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
import { UserScope, UserStorage } from "./utils/scope";

type Vars = {
  Variables: { userId: string; scope: UserScope; storage: UserStorage };
  Bindings: Env;
};
const app = new Hono<Vars>();

app.use("*", logger());
app.use("*", cors({ origin: "*", maxAge: 600 }));

app.get("/", (c) =>
  c.json({ name: "whoopsie-backend", version: "0.2.0", time: new Date().toISOString() })
);
app.get("/health", (c) => c.json({ ok: true }));

// Auth middleware — extracts userId, attaches scoped helpers to context.
async function requireAuth(c: any, next: any) {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return c.json({ error: "no token" }, 401);
  const claims = await verifyToken(c.env, token);
  if (!claims) return c.json({ error: "invalid token" }, 401);
  c.set("userId", claims.sub);
  c.set("scope", new UserScope(c.env.DB, claims.sub));
  c.set("storage", new UserStorage(c.env.RAW, claims.sub));
  await next();
}

// Middleware MUST be registered before the routes it guards.
app.use("/devices/*", requireAuth);
app.use("/ingest/*", requireAuth);
app.use("/insights/*", requireAuth);

app.route("/auth", auth); // /auth/me does its own token check inline
app.route("/devices", devices);
app.route("/ingest", ingest);
app.route("/insights", insights);

export default {
  fetch: app.fetch,
  scheduled: async (_controller, env, ctx) => {
    ctx.waitUntil(nightly(env));
  },
} satisfies ExportedHandler<Env>;
