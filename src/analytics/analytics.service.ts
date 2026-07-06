import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Analytics read side (OHS). Serves the event-count projection. Read-only — a
 * pure consumer, never a source of truth.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(): Promise<{ totals: Array<{ type: string; total: number }>; grandTotal: number }> {
    if (!this.prisma.isAvailable()) return { totals: [], grandTotal: 0 };
    const rows = await this.prisma.analyticsEventCount.findMany();
    const byType = new Map<string, number>();
    let grandTotal = 0;
    for (const r of rows) {
      byType.set(r.eventType, (byType.get(r.eventType) ?? 0) + r.count);
      grandTotal += r.count;
    }
    const totals = [...byType.entries()]
      .map(([type, total]) => ({ type, total }))
      .sort((a, b) => b.total - a.total);
    return { totals, grandTotal };
  }

  async revenue(): Promise<{
    totalCents: number;
    byMethod: Array<{ method: string; cents: number }>;
    byDay: Array<{ day: string; cents: number }>;
  }> {
    if (!this.prisma.isAvailable()) return { totalCents: 0, byMethod: [], byDay: [] };
    const rows = await this.prisma.analyticsRevenueDaily.findMany({ orderBy: { day: "asc" } });
    const byMethod = new Map<string, number>();
    const byDay = new Map<string, number>();
    let totalCents = 0;
    for (const r of rows) {
      byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + r.revenueCents);
      const day = r.day.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + r.revenueCents);
      totalCents += r.revenueCents;
    }
    return {
      totalCents,
      byMethod: [...byMethod.entries()].map(([method, cents]) => ({ method, cents })).sort((a, b) => b.cents - a.cents),
      byDay: [...byDay.entries()].map(([day, cents]) => ({ day, cents })),
    };
  }
}
