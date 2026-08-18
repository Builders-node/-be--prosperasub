import { Controller, Get, Logger, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CronGuard } from "../common/cron.guard";
import { CleaningReminderService } from "./cleaning-reminder.service";
import { SubscriptionExpirationService } from "./subscription-expiration.service";

/** Called by Vercel Cron. CRON_SECRET instead of a JWT — see CronGuard. */
@ApiTags("Reminders")
@UseGuards(CronGuard)
@Controller("reminders")
export class RemindersController {
  private readonly logger = new Logger(RemindersController.name);

  constructor(
    private readonly reminders: CleaningReminderService,
    private readonly subscriptionExpiration: SubscriptionExpirationService,
  ) {}

  @ApiOperation({ summary: "Process due cleaning access reminders (Vercel Cron)" })
  @Get("process")
  async process() {
    const result = await this.reminders.processDueReminders();
    this.logger.log(`Reminder cron: ${JSON.stringify(result)}`);
    return result;
  }

  @ApiOperation({ summary: "Send subscription expiration reminders (Vercel Cron, daily)" })
  @Get("subscriptions/process")
  async processSubscriptions() {
    const result = await this.subscriptionExpiration.processExpirationReminders();
    this.logger.log(`Subscription expiration cron: ${JSON.stringify(result)}`);
    return result;
  }
}
