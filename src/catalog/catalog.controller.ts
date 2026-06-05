import { Controller, Get, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CatalogService } from "./catalog.service";

@ApiTags("Catalog")
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @ApiOperation({ summary: "List active cleaning packages" })
  @ApiResponse({ status: 200, description: "Active cleaning packages." })
  @Get("cleaning/packages")
  listCleaningPackages() {
    return this.catalog.listCleaningPackages();
  }

  @ApiOperation({ summary: "Seed cleaning available slots for the next 110 days (idempotent)" })
  @ApiResponse({ status: 201, description: "Slots seeded or already exist." })
  @Post("admin/cleaning/seed-slots")
  seedCleaningSlots() {
    return this.catalog.seedCleaningSlots();
  }
}
