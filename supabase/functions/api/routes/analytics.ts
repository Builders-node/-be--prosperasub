import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.ts";
import { db, fetchAll } from "../lib/db.ts";

/**
 * Port of backend/src/analytics (AnalyticsController + AnalyticsService).
 * Admin-only read of the event-sourced projections. The projections are still
 * written by the Nest event handlers until the outbox moves (MIGRATION.md #6).
 */
export const analytics = new Hono();

analytics.get("/analytics/summary", async (c) => {
  await requireAdmin(c);
  const rows = await fetchAll<{ event_type: string; count: number }>(() =>
    db().from("analytics_event_counts").select("event_type,count").order("event_type").order("day")
  );
  const byType = new Map<string, number>();
  let grandTotal = 0;
  for (const r of rows) {
    byType.set(r.event_type, (byType.get(r.event_type) ?? 0) + r.count);
    grandTotal += r.count;
  }
  const totals = [...byType.entries()].map(([type, total]) => ({ type, total })).sort((a, b) => b.total - a.total);
  return c.json({ totals, grandTotal });
});

analytics.get("/analytics/revenue", async (c) => {
  await requireAdmin(c);
  const rows = await fetchAll<{ day: string; method: string; revenue_cents: number }>(() =>
    db().from("analytics_revenue_daily").select("day,method,revenue_cents").order("day").order("method")
  );
  const byMethod = new Map<string, number>();
  const byDay = new Map<string, number>();
  let totalCents = 0;
  for (const r of rows) {
    byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + r.revenue_cents);
    const day = String(r.day).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + r.revenue_cents);
    totalCents += r.revenue_cents;
  }
  return c.json({
    totalCents,
    byMethod: [...byMethod.entries()].map(([method, cents]) => ({ method, cents })).sort((a, b) => b.cents - a.cents),
    byDay: [...byDay.entries()].map(([day, cents]) => ({ day, cents })),
  });
});
