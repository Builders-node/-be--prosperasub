import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ResourceService } from "./resource.service";

/**
 * Public read surface for the Resource domain. The type registry drives the
 * "add an industry by config" story and the frontend / Booking engine reads it.
 */
@ApiTags("Resources")
@Controller("resources")
export class ResourceController {
  constructor(private readonly resources: ResourceService) {}

  @ApiOperation({ summary: "List active resource types (the booking-model registry)" })
  @Get("types")
  listTypes() {
    return this.resources.listTypes();
  }

  @ApiOperation({ summary: "List resources, optionally filtered by provider and/or type" })
  @Get()
  listResources(@Query("providerId") providerId?: string, @Query("type") type?: string) {
    return this.resources.listResources({ providerId, typeKey: type });
  }
}
