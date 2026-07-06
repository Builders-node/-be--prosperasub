import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EventSubscriberRegistry } from "../events/event-subscriber-registry";
import type { DomainEventEnvelope, DomainEventHandler } from "../events/domain-event";

/**
 * Analytics reads the whole event stream and builds a projection — per-type,
 * per-day event counts. Pure downstream: it never writes back to another domain,
 * and the projection is rebuildable by replaying `domain_events`. Idempotent via
 * the dispatcher's per-(event,consumer) delivery ledger, so each event counts once.
 */
@Injectable()
export class AnalyticsEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = "analytics";
  private readonly logger = new Logger(AnalyticsEventHandler.name);

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handles(): boolean {
    return true; // ingests everything
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    if (!this.prisma.isAvailable()) return;
    const day = new Date(event.occurredAt);
    day.setUTCHours(0, 0, 0, 0);
    await this.prisma.analyticsEventCount.upsert({
      where: { eventType_day: { eventType: event.type, day } },
      update: { count: { increment: 1 } },
      create: { eventType: event.type, day, count: 1 },
    });
  }
}
