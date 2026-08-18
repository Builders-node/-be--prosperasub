import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { AnalyticsService } from "./analytics.service";

/**
 * Read surface for the event-sourced analytics projection.
 *
 * Admin-only. It shipped with no guard at all: `GET /analytics/revenue`
 * answered 200 to anyone on the internet with the platform's revenue by
 * method and by day. It reads zeros today only because nothing consumes the
 * projection yet — that is a coincidence of timing, not a protection.
 */
@ApiTags("Analytics")
@UseGuards(AdminAuthGuard)
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @ApiOperation({ summary: "Domain-event counts by type (event-sourced projection)" })
  @Get("summary")
  summary() {
    return this.analytics.summary();
  }

  @ApiOperation({ summary: "Revenue by method and day (event-sourced from billing.PaymentCaptured)" })
  @Get("revenue")
  revenue() {
    return this.analytics.revenue();
  }
}
