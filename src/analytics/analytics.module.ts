import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { AnalyticsEventHandler } from "./analytics-events.handler";
import { AnalyticsRevenueHandler } from "./analytics-revenue.handler";

/**
 * Analytics domain (Phase 7) — a pure downstream consumer. Its handler
 * self-registers on the bus and ingests every event into a projection; the
 * service/controller only read it. Never writes back to another domain.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsEventHandler, AnalyticsRevenueHandler],
})
export class AnalyticsModule {}
