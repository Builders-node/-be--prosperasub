import { Module } from "@nestjs/common";
import { ResourceController } from "./resource.controller";
import { ResourceService } from "./resource.service";

/**
 * Resource domain (Phase 3). Owns the generic reservable-entity model:
 * `resource_types` (the booking-model registry) + `bookable_resources`. Exports
 * `ResourceService` so Booking/Order can resolve a resource's booking model
 * without touching tables directly.
 */
@Module({
  controllers: [ResourceController],
  providers: [ResourceService],
  exports: [ResourceService],
})
export class ResourceModule {}
