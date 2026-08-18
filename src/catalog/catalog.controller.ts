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
  /**
   * Deliberately public, and not an admin action despite where it used to live.
   *
   * A customer opening the cleaning day-picker triggers this (`ensureSlotsSeeded`
   * in the frontend client) whenever `cleaning_available_slots` is read, so
   * putting AdminAuthGuard on it would leave a first-of-the-day visitor staring
   * at an empty calendar until the 05:00 cron runs. It only inserts future
   * empty slot rows and is idempotent.
   *
   * What was actually wrong was the name: `admin/cleaning/seed-slots` promised
   * a protection it never had. The old path stays for one deploy cycle because
   * cached frontend bundles still call it.
   */
  @Post("cleaning/ensure-slots")
  ensureCleaningSlots() {
    return this.catalog.seedCleaningSlots();
  }

  /** @deprecated Misleading name — use POST /cleaning/ensure-slots. */
  @Post("admin/cleaning/seed-slots")
  seedCleaningSlots() {
    return this.catalog.seedCleaningSlots();
  }
}
