import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EventSubscriberRegistry } from "./event-subscriber-registry";
import type { DomainEventEnvelope } from "./domain-event";

/**
 * Drains the outbox: unpublished events oldest-first, delivered to every
 * subscribing handler. Per (event, consumer) delivery is tracked with a status:
 *   - delivered → success (terminal)
 *   - failed    → transient error, retried next drain (blocks publish)
 *   - dead      → gave up after MAX_ATTEMPTS (terminal, DEAD-LETTER — no longer
 *                 blocks publish, so one poison handler can't wedge the event)
 * An event is marked published only once no subscriber is left in `failed`.
 * Triggered by a Vercel cron; also manually callable.
 */
@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private static readonly MAX_ATTEMPTS = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscribers: EventSubscriberRegistry,
  ) {}

  async drain(limit = 200): Promise<{ processed: number; delivered: number; failed: number; deadLettered: number }> {
    if (!this.prisma.isAvailable()) {
      return { processed: 0, delivered: 0, failed: 0, deadLettered: 0 };
    }

    const rows = await this.prisma.domainEvent.findMany({
      where: { publishedAt: null },
      orderBy: { occurredAt: "asc" },
      take: limit,
    });

    let delivered = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const row of rows) {
      const envelope: DomainEventEnvelope = {
        id: row.id,
        type: row.type,
        version: row.version,
        occurredAt: row.occurredAt,
        subjectRef: row.subjectRef,
        correlationId: row.correlationId,
        causationId: row.causationId,
        payload: (row.payload ?? {}) as Record<string, unknown>,
      };

      let blocking = false; // any handler still in retryable 'failed' state
      for (const handler of this.subscribers.all()) {
        if (!handler.handles(row.type)) continue;

        const existing = await this.prisma.domainEventDelivery.findUnique({
          where: { eventId_consumer: { eventId: row.id, consumer: handler.name } },
        });
        if (existing && (existing.status === "delivered" || existing.status === "dead")) continue; // terminal

        try {
          await handler.handle(envelope);
          await this.recordDelivery(row.id, handler.name, "delivered", (existing?.attempts ?? 0) + 1, null);
          delivered++;
        } catch (err) {
          const attempts = (existing?.attempts ?? 0) + 1;
          const message = err instanceof Error ? err.message : String(err);
          const dead = attempts >= OutboxDispatcherService.MAX_ATTEMPTS;
          await this.recordDelivery(row.id, handler.name, dead ? "dead" : "failed", attempts, message);
          if (dead) {
            deadLettered++;
            this.logger.error(`DEAD-LETTER: '${handler.name}' gave up on ${row.type} (${row.id}) after ${attempts} attempts: ${message}`);
          } else {
            failed++;
            blocking = true;
            this.logger.warn(`Handler '${handler.name}' failed for ${row.type} (${row.id}) attempt ${attempts}: ${message}`);
          }
        }
      }

      if (!blocking) {
        await this.prisma.domainEvent.update({ where: { id: row.id }, data: { publishedAt: new Date() } });
      }
    }

    return { processed: rows.length, delivered, failed, deadLettered };
  }

  private recordDelivery(eventId: string, consumer: string, status: string, attempts: number, lastError: string | null) {
    return this.prisma.domainEventDelivery.upsert({
      where: { eventId_consumer: { eventId, consumer } },
      update: { status, attempts, lastError, updatedAt: new Date() },
      create: { eventId, consumer, status, attempts, lastError },
    });
  }
}
