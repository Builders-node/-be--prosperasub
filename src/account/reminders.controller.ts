import { Controller, Get, Headers, Logger, UnauthorizedException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CleaningReminderService } from "./cleaning-reminder.service";

/**
 * Unguarded endpoint — protected by CRON_SECRET header instead of JWT.
 * Called by Vercel Cron every 15 minutes.
 */
@ApiTags("Reminders")
@Controller("reminders")
export class RemindersController {
  private readonly logger = new Logger(RemindersController.name);

  constructor(private readonly reminders: CleaningReminderService) {}

  @ApiOperation({ summary: "Process due cleaning access reminders (Vercel Cron)" })
  @Get("process")
  async process(@Headers("authorization") auth?: string) {
    const expected = process.env.CRON_SECRET;
    if (expected) {
      // Accept both "Bearer <secret>" and raw secret
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
      if (token !== expected) {
        throw new UnauthorizedException("Invalid cron secret");
      }
    }
    const result = await this.reminders.processDueReminders();
    this.logger.log(`Reminder cron: ${JSON.stringify(result)}`);
    return result;
  }
}
