import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventSubscriberRegistry } from "../events/event-subscriber-registry";
import type { DomainEventEnvelope, DomainEventHandler } from "../events/domain-event";
import { OrderService } from "./order.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The process manager. Drives an order through its lifecycle in response to
 * Billing events (for order-scoped payments, `subjectRef` = "order:<id>"):
 * captured → confirm, failed → cancel (compensation), refunded → refunded.
 * OrderConfirmed then fans out to Booking/Membership via their own handlers.
 */
@Injectable()
export class OrderSaga implements DomainEventHandler, OnModuleInit {
  readonly name = "order-saga";
  private static readonly PREFIX = "order:";

  private readonly logger = new Logger(OrderSaga.name);

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly orders: OrderService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handles(type: string): boolean {
    return type === "billing.PaymentCaptured" || type === "billing.PaymentFailed" || type === "billing.PaymentRefunded";
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    const subjectRef = event.subjectRef ?? "";
    if (!subjectRef.startsWith(OrderSaga.PREFIX)) return; // only order-scoped payments
    const orderId = subjectRef.slice(OrderSaga.PREFIX.length);
    // Defensive: a malformed subjectRef must not throw and wedge the outbox.
    if (!UUID_RE.test(orderId)) {
      this.logger.warn(`Ignoring ${event.type} with non-uuid order ref "${orderId}"`);
      return;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    try {
      if (event.type === "billing.PaymentCaptured") {
        await this.orders.confirm(orderId, typeof payload.providerRef === "string" ? payload.providerRef : undefined);
      } else if (event.type === "billing.PaymentFailed") {
        await this.orders.cancel(orderId, "payment_failed");
      } else if (event.type === "billing.PaymentRefunded") {
        await this.orders.markRefunded(orderId);
      }
    } catch (err) {
      // Log and swallow — an order that can't be transitioned shouldn't block the
      // event for every other consumer. (A real dead-letter/max-retry is a later
      // hardening of the dispatcher itself.)
      this.logger.error(`Order saga ${event.type} for ${orderId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
