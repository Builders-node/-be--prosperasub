import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";

@ApiTags("Health")
@Controller("health")
export class HealthController {
  @ApiOperation({ summary: "Check API health" })
  @ApiResponse({ status: 200, description: "API is running." })
  @Get()
  getHealth() {
    return {
      status: "ok",
      service: "prospera-sub-api"
    };
  }
}
