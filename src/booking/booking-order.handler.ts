import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventSubscriberRegistry } from "../events/event-subscriber-registry";
import type { DomainEventEnvelope, DomainEventHandler } from "../events/domain-event";
import { BookingService } from "./booking.service";

/**
 * Booking reacts to Order: when an order confirms, its booking lines' held slots
 * are confirmed. Closes the Booking ← Order loop over the bus (payment →
 * OrderConfirmed → BookingConfirmed). Idempotent: confirm() only acts on a held
 * booking, and a failed line never blocks the others.
 */
@Injectable()
export class BookingOrderHandler implements DomainEventHandler, OnModuleInit {
  readonly name = "booking-order";
  private readonly logger = new Logger(BookingOrderHandler.name);

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly booking: BookingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handles(type: string): boolean {
    return type === "order.OrderConfirmed";
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    const payload = (event.payload ?? {}) as { orderId?: string; lines?: Array<{ kind?: string; ref?: string }> };
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    for (const line of lines) {
      if (line?.kind === "booking" && line.ref) {
        await this.booking.confirm(line.ref, payload.orderId).catch((e) =>
          this.logger.warn(`confirm booking ${line.ref} failed: ${(e as Error).message}`),
        );
      }
    }
  }
}
