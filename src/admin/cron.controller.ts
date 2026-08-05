import { Controller, ForbiddenException, Get, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { AdminService } from "./admin.service";

/**
 * Endpoints triggered by Vercel Cron (and callable manually) to reconcile
 * payments without any human action. Protected by CRON_SECRET when configured.
 */
@ApiExcludeController()
@Controller("cron")
export class CronController {
  constructor(private readonly admin: AdminService) {}

  @Get("reconcile-payments")
  reconcileGet(@Req() req: Request) {
    return this.run(req);
  }

  @Post("reconcile-payments")
  reconcilePost(@Req() req: Request) {
    return this.run(req);
  }

  @Get("reconcile-calendar")
  reconcileCalendarGet(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.reconcileCleaningCalendar();
  }

  @Post("reconcile-calendar")
  reconcileCalendarPost(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.reconcileCleaningCalendar();
  }

  @Get("sync-calendar")
  syncCalendarGet(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.syncPendingCleaningCalendar();
  }

  @Post("sync-calendar")
  syncCalendarPost(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.syncPendingCleaningCalendar();
  }

  @Get("restore-calendar")
  restoreCalendarGet(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.restoreCleaningCalendar();
  }

  @Post("restore-calendar")
  restoreCalendarPost(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.restoreCleaningCalendar();
  }

  @Get("seed-cleaning-slots")
  seedSlotsGet(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.seedCleaningSlots();
  }

  @Post("seed-cleaning-slots")
  seedSlotsPost(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.seedCleaningSlots();
  }

  @Get("beach-courts/pull-google")
  pullBeachCourtsGet(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.pullAllBeachCourtsFromGoogle();
  }

  @Post("beach-courts/pull-google")
  pullBeachCourtsPost(@Req() req: Request) {
    this.assertSecret(req);
    return this.admin.pullAllBeachCourtsFromGoogle();
  }

  private run(req: Request) {
    this.assertSecret(req);
    return this.admin.reconcilePendingPayments();
  }

  private assertSecret(req: Request) {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const header = req.headers.authorization || "";
      const provided = header.startsWith("Bearer ") ? header.slice(7) : (req.query.secret as string) || "";
      if (provided !== secret) {
        throw new ForbiddenException("Invalid cron secret.");
      }
    }
  }
}
