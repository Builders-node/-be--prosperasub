import { Controller, ForbiddenException, Get, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { BookingService } from "./booking.service";

/**
 * Vercel-cron sweep that releases expired holds (emits `booking.HoldExpired` +
 * promotes waitlists). Hold correctness is also lazy (a stale hold is freed when
 * the slot is next requested); this just cleans up + fires events. CRON_SECRET.
 */
@ApiExcludeController()
@Controller("cron")
export class BookingCronController {
  constructor(private readonly booking: BookingService) {}

  @Get("expire-holds")
  expireGet(@Req() req: Request) {
    this.assertSecret(req);
    return this.booking.expireHolds();
  }

  @Post("expire-holds")
  expirePost(@Req() req: Request) {
    this.assertSecret(req);
    return this.booking.expireHolds();
  }

  private assertSecret(req: Request) {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const header = req.headers.authorization || "";
      const provided = header.startsWith("Bearer ") ? header.slice(7) : (req.query.secret as string) || "";
      if (provided !== secret) throw new ForbiddenException("Invalid cron secret.");
    }
  }
}
