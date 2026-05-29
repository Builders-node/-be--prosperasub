import { Module } from "@nestjs/common";
import { MailModule } from "../mail/mail.module";
import { EmailNotificationService } from "./email-notification.service";
import { NotificationsService } from "./notifications.service";
import { TelegramNotificationService } from "./telegram-notification.service";

@Module({
  imports: [MailModule],
  providers: [EmailNotificationService, TelegramNotificationService, NotificationsService],
  exports: [NotificationsService]
})
export class NotificationsModule {}
