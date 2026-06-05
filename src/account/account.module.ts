import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MailModule } from "../mail/mail.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PaymentsModule } from "../payments/payments.module";
import { AccountAuthGuard } from "./account-auth.guard";
import { AccountNotificationsService } from "./account-notifications.service";
import { AccountPasswordService } from "./account-password.service";
import { AccountPreferencesService } from "./account-preferences.service";
import { AccountPaymentService } from "./account-payment.service";
import { AccountController } from "./account.controller";
import { CleaningReminderService } from "./cleaning-reminder.service";
import { RemindersController } from "./reminders.controller";

@Module({
  imports: [PrismaModule, AuthModule, MailModule, PaymentsModule],
  controllers: [AccountController, RemindersController],
  providers: [
    AccountAuthGuard,
    AccountNotificationsService,
    AccountPasswordService,
    AccountPreferencesService,
    AccountPaymentService,
    CleaningReminderService,
  ],
  exports: [AccountNotificationsService, CleaningReminderService],
})
export class AccountModule {}
