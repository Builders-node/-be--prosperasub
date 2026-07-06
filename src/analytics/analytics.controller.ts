import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";

/** Read surface for the event-sourced analytics projection. */
@ApiTags("Analytics")
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
