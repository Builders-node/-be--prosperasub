import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventBusService } from "../events/event-bus.service";
import { EventSubscriberRegistry } from "../events/event-subscriber-registry";
import type { DomainEventEnvelope, DomainEventHandler } from "../events/domain-event";

/**
 * Membership reacts to Billing: a captured payment for a subscription is
 * recognized as a membership activation. Emits `membership.SubscriptionActivated`
 * so downstream domains (Notification, Analytics) can react — closing the
 * Billing → Membership loop over the event bus. Idempotent: the dispatcher
 * delivers each billing event to this consumer once.
 */
@Injectable()
export class MembershipEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = "membership";
  private readonly logger = new Logger(MembershipEventHandler.name);
  private static readonly SUBSCRIPTION_PREFIX = "subscription:";

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly eventBus: EventBusService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handles(type: string): boolean {
    return type === "billing.PaymentCaptured";
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    const subjectRef = event.subjectRef ?? "";
    // Only subscription-scoped payments activate membership. Booking/one-off
    // payments (subjectRef "booking:…" / "payment:…") are not our concern.
    if (!subjectRef.startsWith(MembershipEventHandler.SUBSCRIPTION_PREFIX)) return;

    const subscriptionId = subjectRef.slice(MembershipEventHandler.SUBSCRIPTION_PREFIX.length);
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    await this.eventBus.publish({
      type: "membership.SubscriptionActivated",
      subjectRef,
      causationId: event.id,
      correlationId: event.correlationId ?? event.id,
      payload: {
        subscriptionId,
        method: payload.method ?? null,
        provider: payload.provider ?? null,
      },
    });
    this.logger.log(`Subscription ${subscriptionId} activated from ${event.type}`);
  }
}
