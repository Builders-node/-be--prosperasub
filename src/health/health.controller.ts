import { Controller, Get, Optional } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { PrismaService } from "../prisma/prisma.service";

@ApiTags("Health")
@Controller("health")
export class HealthController {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  @ApiOperation({ summary: "Check API health" })
  @ApiResponse({ status: 200, description: "API is running." })
  @Get()
  getHealth() {
    return {
      status: "ok",
      service: "prospera-sub-api",
      database: this.prisma?.isAvailable() ? "connected" : "unavailable",
      dbError: this.prisma?.getConnectError() ?? null,
    };
  }
}
