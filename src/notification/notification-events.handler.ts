import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { EventSubscriberRegistry } from "../events/event-subscriber-registry";
import type { DomainEventEnvelope, DomainEventHandler } from "../events/domain-event";

/**
 * Notification as a pure event subscriber. Turns notification-worthy domain
 * events into intents (a `notification_log` row + a `notification.Queued` event).
 * It only listens to NEW domain events that have no existing direct-send path,
 * so it can't double-notify — and it records intents rather than sending, so a
 * replay never spams real users. Real channel delivery (email/SMS/push) + dedup
 * against the legacy direct path is a later step.
 */
const NOTIFY_ON = new Set<string>([
  "booking.BookingConfirmed",
  "booking.BookingCancelled",
  "booking.WaitlistPromoted",
  "booking.HoldExpired",
  "membership.SubscriptionActivated",
  "membership.TrialExpiring",
  "order.OrderCancelled",
  "billing.PaymentFailed",
  "billing.PaymentRefunded",
]);

@Injectable()
export class NotificationEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = "notification";
  private readonly logger = new Logger(NotificationEventHandler.name);

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handles(type: string): boolean {
    return NOTIFY_ON.has(type);
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    if (!this.prisma.isAvailable()) return;
    const log = await this.prisma.notificationLog.create({
      data: { eventType: event.type, subjectRef: event.subjectRef ?? null, channel: "inapp", status: "queued" },
    });
    await this.eventBus.publish({
      type: "notification.Queued",
      subjectRef: event.subjectRef ?? `notification:${log.id}`,
      causationId: event.id,
      payload: { logId: log.id, eventType: event.type },
    });
  }
}
