import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { CronGuard } from "../common/cron.guard";
import { AdminService } from "./admin.service";

/**
 * Endpoints triggered by Vercel Cron (and callable manually) to reconcile
 * payments without any human action. Protected by CronGuard (CRON_SECRET).
 */
@ApiExcludeController()
@UseGuards(CronGuard)
@Controller("cron")
export class CronController {
  constructor(private readonly admin: AdminService) {}

  @Get("reconcile-payments")
  reconcileGet() {
    return this.run();
  }

  @Post("reconcile-payments")
  reconcilePost() {
    return this.run();
  }

  @Get("reconcile-calendar")
  reconcileCalendarGet() {
    return this.admin.reconcileCleaningCalendar();
  }

  @Post("reconcile-calendar")
  reconcileCalendarPost() {
    return this.admin.reconcileCleaningCalendar();
  }

  @Get("sync-calendar")
  syncCalendarGet() {
    return this.admin.syncPendingCleaningCalendar();
  }

  @Post("sync-calendar")
  syncCalendarPost() {
    return this.admin.syncPendingCleaningCalendar();
  }

  @Get("restore-calendar")
  restoreCalendarGet() {
    return this.admin.restoreCleaningCalendar();
  }

  @Post("restore-calendar")
  restoreCalendarPost() {
    return this.admin.restoreCleaningCalendar();
  }

  @Get("seed-cleaning-slots")
  seedSlotsGet() {
    return this.admin.seedCleaningSlots();
  }

  @Post("seed-cleaning-slots")
  seedSlotsPost() {
    return this.admin.seedCleaningSlots();
  }

  @Get("beach-courts/pull-google")
  pullBeachCourtsGet() {
    return this.admin.pullAllBeachCourtsFromGoogle();
  }

  @Post("beach-courts/pull-google")
  pullBeachCourtsPost() {
    return this.admin.pullAllBeachCourtsFromGoogle();
  }

  private run() {
    return this.admin.reconcilePendingPayments();
  }
}
