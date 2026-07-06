import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EventSubscriberRegistry } from "../events/event-subscriber-registry";
import type { DomainEventEnvelope, DomainEventHandler } from "../events/domain-event";

/**
 * Revenue read model, event-sourced from `billing.PaymentCaptured`: rolls each
 * captured amount into a day × method total. Separate consumer name from the
 * event-count handler so both process the same event (each deduped
 * independently by the delivery ledger).
 */
@Injectable()
export class AnalyticsRevenueHandler implements DomainEventHandler, OnModuleInit {
  readonly name = "analytics-revenue";

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handles(type: string): boolean {
    return type === "billing.PaymentCaptured";
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    if (!this.prisma.isAvailable()) return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const amount = Number(payload.amountCents);
    if (!Number.isFinite(amount) || amount <= 0) return; // captures without an amount don't move revenue
    const method = typeof payload.method === "string" ? payload.method : "unknown";
    const day = new Date(event.occurredAt);
    day.setUTCHours(0, 0, 0, 0);
    await this.prisma.analyticsRevenueDaily.upsert({
      where: { day_method: { day, method } },
      update: { revenueCents: { increment: amount } },
      create: { day, method, revenueCents: amount },
    });
  }
}
