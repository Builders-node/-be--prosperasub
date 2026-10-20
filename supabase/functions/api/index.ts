import { Hono } from "hono";
import { cors } from "npm:hono@4.6.14/cors";
import { isAllowedOrigin } from "./lib/cors.ts";
import { HttpError, STATUS_NAME } from "./lib/http.ts";
import { db } from "./lib/db.ts";
import { analytics } from "./routes/analytics.ts";
import { support } from "./routes/support.ts";
import { verify } from "./routes/verify.ts";
import { locations } from "./routes/locations.ts";

/**
 * The Supabase home of what used to be the NestJS API (api.prosperasub.com).
 *
 * One function, many routes, under the same paths the Nest controllers used, so
 * the frontend moves an endpoint by adding its path to EDGE_ROUTES in
 * frontend/src/integrations/supabase/config.ts — nothing else changes. Deployed
 * with verify_jwt = false: these routes check our own access tokens
 * (lib/auth.ts), not Supabase Auth ones.
 */
const app = new Hono().basePath("/api");

app.use("*", cors({
  origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
  credentials: true,
  allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
}));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    const details = (err as HttpError & { details?: string[] }).details;
    return c.json({ message: details ?? err.message, error: STATUS_NAME[err.status] ?? "Error", statusCode: err.status }, err.status as 400);
  }
  console.error("[api] unhandled", err);
  return c.json({ statusCode: 500, message: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ statusCode: 404, message: `Cannot ${c.req.method} ${c.req.path}` }, 404));

// Health: no error text leaks out (the Nest one returned dbError to anyone).
app.get("/health", async (c) => {
  const { error } = await db().from("global_settings").select("key").limit(1);
  return c.json({ status: error ? "degraded" : "ok", service: "everysub-edge-api", database: error ? "error" : "connected" });
});

app.route("/", analytics);
app.route("/", support);
app.route("/", verify);
app.route("/", locations);

Deno.serve(app.fetch);
