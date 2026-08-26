import { Module } from "@nestjs/common";
import { MailModule } from "../mail/mail.module";
import { NotificationEventHandler } from "./notification-events.handler";
import { CourtBookingEmailHandler } from "./court-booking-email.handler";

/**
 * Notification-as-subscriber domain (Phase 7b). Distinct from the legacy
 * `NotificationsModule` (direct email/telegram on payment success) — this one
 * only reacts to the event bus. Handlers self-register; no controller.
 * NotificationEventHandler records intents; CourtBookingEmailHandler actually
 * emails the team when a court is booked.
 */
@Module({
  imports: [MailModule],
  providers: [NotificationEventHandler, CourtBookingEmailHandler],
})
export class NotificationEventsModule {}
