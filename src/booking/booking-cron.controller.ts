import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { CronGuard } from "../common/cron.guard";
import { BookingService } from "./booking.service";

/**
 * Vercel-cron sweep that releases expired holds (emits `booking.HoldExpired` +
 * promotes waitlists). Hold correctness is also lazy — a stale hold is freed
 * when the slot is next requested — so this just cleans up and fires events.
 */
@ApiExcludeController()
@UseGuards(CronGuard)
@Controller("cron")
export class BookingCronController {
  constructor(private readonly booking: BookingService) {}

  @Get("expire-holds")
  expireGet() {
    return this.booking.expireHolds();
  }

  @Post("expire-holds")
  expirePost() {
    return this.booking.expireHolds();
  }
}
