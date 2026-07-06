import { Module } from "@nestjs/common";
import { NotificationEventHandler } from "./notification-events.handler";

/**
 * Notification-as-subscriber domain (Phase 7b). Distinct from the legacy
 * `NotificationsModule` (direct email/telegram on payment success) — this one
 * only reacts to the event bus. The handler self-registers; no controller.
 */
@Module({
  providers: [NotificationEventHandler],
})
export class NotificationEventsModule {}
