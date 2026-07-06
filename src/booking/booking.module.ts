import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ResourceModule } from "../resource/resource.module";
import { AccountAuthGuard } from "../account/account-auth.guard";
import { BookingController } from "./booking.controller";
import { BookingCronController } from "./booking-cron.controller";
import { BookingService } from "./booking.service";
import { BookingOrderHandler } from "./booking-order.handler";

/**
 * Booking domain (Phase 4). The one engine for every industry — availability
 * (dispatch on booking_model) + the hold/confirm/cancel/waitlist write side.
 * Imports ResourceModule (resolve resource + type) and AuthModule (guard the
 * mutations). Prisma + EventBus are global.
 */
@Module({
  imports: [ResourceModule, AuthModule],
  controllers: [BookingController, BookingCronController],
  providers: [BookingService, BookingOrderHandler, AccountAuthGuard],
  exports: [BookingService],
})
export class BookingModule {}
